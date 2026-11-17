// Shared HTTP plumbing: JSON answers, request ids, bearer auth, body reading. Every response
// carries a non-empty X-GitHub-Request-Id; every JSON error body carries a string `message`.

import type { IncomingMessage, ServerResponse } from 'node:http';

export const JSON_TYPE = 'application/json; charset=utf-8';

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

/** Answer with a JSON body. The body is encoded once; its byte length is the buffer's. */
export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const buf = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': buf.length,
    ...baseHeaders(headers),
  });
  res.end(buf);
}

/** Answer with a raw buffer body and an explicit content type. */
export function sendBuffer(
  res: ServerResponse,
  status: number,
  body: Buffer,
  contentType: string,
  headers: Readonly<Record<string, string>> = {},
): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, ...baseHeaders(headers) });
  res.end(body);
}

/** Answer with no body (204). */
export function sendEmpty(res: ServerResponse, status: number, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, { ...baseHeaders(headers) });
  res.end();
}

/** A JSON error body: {"message": string}. */
export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

/**
 * Whether the request carries the suite's bearer token. When MAKEFUN_SHOP_TOKEN is set the
 * token must match exactly; when it is unset (local development) any non-empty Bearer token
 * is accepted, so the unauthenticated checks still fail closed on a missing header.
 */
export function isAuthenticated(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length).trim();
  if (token === '') return false;
  if (SHOP_TOKEN !== '') return token === SHOP_TOKEN;
  return true;
}

/** Read the whole request body, up to `maxBytes` (default 64 MiB, far above any pack here). */
export function readBody(req: IncomingMessage, maxBytes = 64 * 1024 * 1024): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    const onError = (err: Error): void => {
      if (!failed) {
        failed = true;
        reject(err);
      }
    };
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > maxBytes) {
        failed = true;
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks, size));
    });
    req.on('error', onError);
  });
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
