/**
 * The server: one Node process answering every surface of the forge.
 *
 * Routing (in order):
 * - GET /healthz -> 200 {"ok": true} (the env's boot check)
 * - /api/v3/*    -> REST v3 (rest.ts)
 * - /api/graphql -> GraphQL v4 (graphql.ts)
 * - /mcp         -> MCP, JSON-RPC 2.0 over Streamable HTTP (mcp.ts)
 * - /{owner}/{repo}.git/* -> git smart HTTP (githttp.ts)
 * - anything else -> 404 JSON {"message": "Not Found"}
 *
 * The request body is read once here and passed to the handlers, which are
 * synchronous. No request handler is allowed to throw out of the server: an
 * unexpected error becomes a 500 JSON reply and the process stays up (the
 * suite's repo-survives-errors check exercises exactly this).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGit } from './githttp.ts';
import { handleGraphQL } from './graphql.ts';
import { readBody, sendError, sendJson } from './httputil.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://127.0.0.1');
  } catch {
    sendError(res, 400, 'Bad Request');
    return;
  }
  const pathname = url.pathname;

  if (pathname === '/healthz') {
    if (req.method === 'GET') {
      sendJson(res, 200, { ok: true });
      return;
    }
    sendError(res, 405, 'Method Not Allowed');
    return;
  }

  let body: Buffer;
  try {
    body = await readBody(req);
  } catch {
    sendError(res, 413, 'Request Entity Too Large');
    return;
  }

  if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
    if (handleRest(req, res, pathname, url, body)) return;
  } else if (pathname === '/api/graphql') {
    if (handleGraphQL(req, res, pathname, url, body)) return;
  } else if (pathname === '/mcp') {
    if (handleMcp(req, res, pathname, url, body)) return;
  } else if (handleGit(req, res, pathname, url, body)) {
    return;
  }

  // Unknown route: a JSON 404, never HTML.
  sendError(res, 404, 'Not Found');
}

/** Build the HTTP server main.ts binds and registers. */
export function createApp(): Server {
  return createServer((req, res) => {
    route(req, res).catch((err: unknown) => {
      try {
        if (!res.headersSent) {
          sendError(res, 500, err instanceof Error ? err.message : 'Internal Server Error');
        } else {
          res.destroy();
        }
      } catch {
        // The socket is already gone; nothing left to do.
      }
    });
  });
}
