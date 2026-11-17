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
import { EMPTY_SEARCH_PARAMS, readBody, sendError, sendJson, type RequestUrl } from './httputil.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';

/**
 * Whether the WHATWG URL parser would leave this request target's path byte-identical:
 * no query or fragment, no backslash, no percent-encoding, no whitespace, control or
 * non-ASCII character (the parser percent-encodes those), and no dot or empty segment
 * for it to normalize. Plain suite paths qualify; anything unusual falls back to the
 * real parser, so behavior never differs.
 */
function isPlainPath(raw: string): boolean {
  if (!raw.startsWith('/')) return false;
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw.charCodeAt(i);
    if (c <= 0x20 || c >= 0x7f || c === 0x3f || c === 0x23 || c === 0x5c || c === 0x25) return false;
  }
  return (
    !raw.includes('//') &&
    !raw.includes('/./') &&
    !raw.includes('/../') &&
    !raw.endsWith('/.') &&
    !raw.endsWith('/..')
  );
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = req.url ?? '/';
  let pathname: string;
  let url: RequestUrl;
  if (isPlainPath(raw)) {
    // The common case: the path is its own pathname and there is no query to parse.
    pathname = raw;
    url = { pathname, searchParams: EMPTY_SEARCH_PARAMS };
  } else {
    let parsed: URL;
    try {
      parsed = new URL(raw, 'http://127.0.0.1');
    } catch {
      sendError(res, 400, 'Bad Request');
      return;
    }
    pathname = parsed.pathname;
    url = parsed;
  }

  if (pathname === '/healthz') {
    if (req.method === 'GET') {
      sendJson(res, 200, { ok: true });
      return;
    }
    sendError(res, 405, 'Method Not Allowed');
    return;
  }

  // Only read a body when the request declares one. GET/HEAD (and bodyless
  // DELETEs) carry none; skipping the read avoids a promise plus three stream
  // listeners per request on the hottest paths (the read benchmark's 2,000 GETs).
  const hasBody =
    (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0') ||
    req.headers['transfer-encoding'] !== undefined;
  let body: Buffer;
  if (hasBody) {
    try {
      body = await readBody(req);
    } catch {
      sendError(res, 413, 'Request Entity Too Large');
      return;
    }
  } else {
    body = Buffer.alloc(0);
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
