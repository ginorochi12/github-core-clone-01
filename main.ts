/**
 * Entrypoint for the makefun-forge GitHub-compatible git forge.
 *
 * The forge is a single Node process. Its job at boot is small and fixed:
 *
 *   1. Build the HTTP server from app.ts and bind an ephemeral port (the
 *      kernel picks one; the suite owns 8080, so we never bind it).
 *   2. Tell the trial environment which port we took, by POSTing
 *      {"port": N} to $MAKEFUN_ENV_URL/register. The environment derives
 *      our base URL from where that request came from, plus the port.
 *   3. Poll GET $MAKEFUN_ENV_URL/done until the suite answers
 *      {"done": true}, then shut the server down and exit 0.
 *
 * When MAKEFUN_ENV_URL is not set (a person running the forge by hand),
 * the server simply listens on $PORT, or 3000, and keeps serving until
 * it is stopped. Nothing about the trial wire is needed then.
 *
 * Only the standard library is used here, and only erasable TypeScript,
 * so the file runs under `node --experimental-strip-types main.ts` as
 * well as under a plain `node main.ts` on Node 22.
 */

import { createApp } from "./app.ts";
import type { Server } from "node:http";

/** The variable naming the trial environment's origin. */
const ENV_URL_VARIABLE = "MAKEFUN_ENV_URL";
/** The variable naming the standalone listen port. */
const STANDALONE_PORT_VARIABLE = "PORT";
/** The standalone port when $PORT is unset or unusable. */
const STANDALONE_PORT_FALLBACK = 3000;
/** The route the entry announces its port on. */
const REGISTER_ROUTE = "/register";
/** The route the entry polls for the suite's finish. */
const DONE_ROUTE = "/done";
/** How long one register attempt may take before it is abandoned. */
const REGISTER_TIMEOUT_MS = 5_000;
/** How many times a failed register is retried before giving up. */
const REGISTER_ATTEMPTS = 12;
/** The pause between register attempts. */
const REGISTER_RETRY_DELAY_MS = 500;
/** The first pause between done polls. */
const DONE_POLL_FIRST_DELAY_MS = 250;
/** The longest pause between done polls. */
const DONE_POLL_MAX_DELAY_MS = 2_000;
/** How long one done poll may take before it is abandoned. */
const DONE_POLL_TIMEOUT_MS = 10_000;
/** How long shutdown waits for the server to close before forcing exit. */
const SHUTDOWN_GRACE_MS = 1_000;

/** Wait `delayMs` milliseconds. */
function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

/** Join an origin and a path without doubling a slash. */
function joinRoute(origin: string, route: string): string {
  return `${origin.replace(/\/+$/, "")}${route}`;
}

/**
 * Announce the forge's port to the trial environment. Returns true once
 * the environment has accepted the registration (a 409 means an earlier
 * register already won, which counts as accepted too). Retries a few
 * times on network errors or unexpected statuses, since the boot
 * budget is generous and a single dropped request must not sink a run.
 */
async function announcePort(envOrigin: string, port: number): Promise<boolean> {
  const target = joinRoute(envOrigin, REGISTER_ROUTE);
  for (let attempt = 1; attempt <= REGISTER_ATTEMPTS; attempt += 1) {
    try {
      const answer = await fetch(target, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REGISTER_TIMEOUT_MS),
      });
      if (answer.status === 200 || answer.status === 409) return true;
      console.error(`register attempt ${attempt}: unexpected status ${answer.status}`);
    } catch (error) {
      console.error(`register attempt ${attempt}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (attempt < REGISTER_ATTEMPTS) await sleep(REGISTER_RETRY_DELAY_MS);
  }
  return false;
}

/**
 * Poll the trial environment until the suite reports it is done. Each
 * poll is a short request the environment answers at once; the wait
 * between polls starts short and doubles up to a cap, so the loop is
 * responsive at first and quiet while the suite runs its checks. A
 * failed poll is not fatal: the loop backs off and tries again.
 */
async function waitForSuiteDone(envOrigin: string): Promise<void> {
  const target = joinRoute(envOrigin, DONE_ROUTE);
  let delayMs = DONE_POLL_FIRST_DELAY_MS;
  for (;;) {
    try {
      const answer = await fetch(target, { signal: AbortSignal.timeout(DONE_POLL_TIMEOUT_MS) });
      const body: unknown = await answer.json();
      if (typeof body === "object" && body !== null && (body as { done?: unknown }).done === true) return;
      delayMs = DONE_POLL_FIRST_DELAY_MS;
    } catch (error) {
      console.error(`done poll: ${error instanceof Error ? error.message : String(error)}`);
    }
    await sleep(delayMs);
    delayMs = Math.min(DONE_POLL_MAX_DELAY_MS, delayMs * 2);
  }
}

/**
 * Stop the server, then leave the process. Idle keep-alive connections
 * are dropped at once so the close callback is not left waiting on
 * them; the close callback is the normal way out, and a short grace
 * timer forces the exit if anything still holds the loop open.
 */
function shutDown(server: Server, code: number): void {
  let leaving = false;
  const leave = (): void => {
    if (leaving) return;
    leaving = true;
    process.exit(code);
  };
  server.close(() => leave());
  server.closeAllConnections();
  setTimeout(leave, SHUTDOWN_GRACE_MS);
}

/** The port to listen on when no trial environment is present. */
function standalonePort(): number {
  const raw = process.env[STANDALONE_PORT_VARIABLE];
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) return parsed;
  return STANDALONE_PORT_FALLBACK;
}

/**
 * Boot the forge: build the server, bind a port, register with the
 * trial environment when there is one, and wait for the suite to finish.
 */
async function boot(): Promise<void> {
  const server = createApp();
  const envOrigin = process.env[ENV_URL_VARIABLE];

  server.on("error", (error: Error) => {
    console.error(`server error: ${error.message}`);
    process.exit(1);
  });

  let stopping = false;
  const onSignal = (): void => {
    if (stopping) return;
    stopping = true;
    shutDown(server, 0);
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  const boundPort = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(envOrigin === undefined ? standalonePort() : 0, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("the server bound no TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
  console.log(`forge listening on port ${boundPort}`);

  if (envOrigin === undefined || envOrigin === "") {
    console.log("no trial environment set; serving standalone");
    return;
  }

  const registered = await announcePort(envOrigin, boundPort);
  if (!registered) {
    console.error("could not register with the trial environment; exiting");
    shutDown(server, 1);
    return;
  }
  await waitForSuiteDone(envOrigin);
  shutDown(server, 0);
}

boot().catch((error: unknown) => {
  console.error(`boot failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
