// Shared HTTP plumbing: JSON answers, request ids, bearer auth. Every response
// carries a non-empty X-GitHub-Request-Id; every JSON error body carries a string `message`.
//
// The transport is a raw node:net server (transport.ts), so handlers see these
// minimal request/response shapes instead of node:http's IncomingMessage and
// ServerResponse. They cover exactly what the handlers use: the method, the
// raw target, lowercased headers, and one writeHead + end per reply.

/** The request surface handlers read: method, raw target, lowercased headers. */
export interface ForgeRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string | undefined>;
}

/** The response surface handlers write: one writeHead, then one end. */
export interface ForgeResponse {
  readonly headersSent: boolean;
  writeHead(status: number, headers: Readonly<Record<string, string | number>>): void;
  end(body?: Buffer): void;
  destroy(): void;
}

export const JSON_TYPE = 'application/json; charset=utf-8';

/**
 * The URL surface handlers read: the path plus the parsed query. A real URL satisfies this,
 * and app.ts hands handlers a cheap shim of the same shape for plain paths (no query at all),
 * so the hot paths skip the WHATWG URL constructor.
 */
export interface RequestUrl {
  readonly pathname: string;
  readonly searchParams: URLSearchParams;
}

/** One shared empty query set for plain-path requests (handlers never mutate it). */
export const EMPTY_SEARCH_PARAMS = new URLSearchParams();

/** The token the env presents (MAKEFUN_SHOP_TOKEN in a trial); '' when unset. */
const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

let requestCounter = 0;

/** A unique, non-empty request id for every response. */
export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(16).padStart(8, '0')}`;
}

function baseHeaders(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  return { 'x-github-request-id': nextRequestId(), ...extra };
}

/** Serialize a value exactly as sendJson sends it: JSON plus a trailing newline. */
export function jsonBuffer(body: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
}

/** Answer with a JSON body. The body is encoded once; its byte length is the buffer's. */
export function sendJson(res: ForgeResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const buf = jsonBuffer(body);
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': buf.length,
    ...baseHeaders(headers),
  });
  res.end(buf);
}

/** Answer with a raw buffer body and an explicit content type. */
export function sendBuffer(
  res: ForgeResponse,
  status: number,
  body: Buffer,
  contentType: string,
  headers: Readonly<Record<string, string>> = {},
): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, ...baseHeaders(headers) });
  res.end(body);
}

/** Answer with no body (204). */
export function sendEmpty(res: ForgeResponse, status: number, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, { ...baseHeaders(headers) });
  res.end();
}

/** A JSON error body: {"message": string}. */
export function sendError(res: ForgeResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

/**
 * Whether the request carries the suite's bearer token. When MAKEFUN_SHOP_TOKEN is set the
 * token must match exactly; when it is unset (local development) any non-empty Bearer token
 * is accepted, so the unauthenticated checks still fail closed on a missing header.
 */
export function isAuthenticated(req: ForgeRequest): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length).trim();
  if (token === '') return false;
  if (SHOP_TOKEN !== '') return token === SHOP_TOKEN;
  return true;
}

/** Parse a JSON body; returns `{ok:false}` on empty (treated as {}) or malformed input. */
export function parseJsonBody(body: Buffer): { ok: true; value: unknown } | { ok: false } {
  const text = body.toString('utf8').trim();
  if (text === '') return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}
