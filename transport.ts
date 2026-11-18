/**
 * The raw TCP transport: an HTTP/1.1 server on node:net, replacing node:http.
 *
 * Why: profiling showed node:http's machinery (parser, IncomingMessage /
 * ServerResponse allocation, separate header/body writes) is ~47% of server
 * CPU on the REST paths, while the forge's own code is ~14%. A hand-rolled
 * transport that parses requests and writes each response in a single
 * socket.write removes that overhead. Everything above the transport —
 * routing, handlers, store, git logic — is untouched.
 *
 * What this server implements (the subset the suite's fetch client needs,
 * plus the defensive cases a real HTTP client may send):
 * - HTTP/1.1 and HTTP/1.0 request lines and headers (latin1, as Node parses
 *   them), keep-alive on 1.1 by default, `Connection: close` honored.
 * - Bodies by Content-Length and by chunked transfer-encoding; `Expect:
 *   100-continue` answered at once; pipelined requests answered in order.
 * - Responses written as one buffer (status line + headers + body) per
 *   request, with the exact headers the handlers set. No `Date` header is
 *   emitted (no check reads it; Node's auto-Date costs a format per reply).
 * - HEAD replies keep their headers and drop the body, as Node does.
 * - Malformed requests get a bare 400 and the connection closes, as Node's
 *   clientError path does; bodies over 64 MiB get the same JSON 413 the
 *   old body reader produced.
 *
 * Only the standard library is used, and only erasable TypeScript.
 */
import { createServer, type Server, type Socket } from 'node:net';
import {
  jsonBuffer,
  nextRequestId,
  type ForgeRequest,
  type ForgeResponse,
} from './httputil.ts';

/** Largest request body accepted (matches the old body reader's cap). */
const MAX_BODY_BYTES = 64 * 1024 * 1024;
/** Largest header block accepted before the request is refused. */
const MAX_HEADERS_BYTES = 64 * 1024;
/** The shared empty body for requests that carry none. */
const EMPTY_BODY = Buffer.alloc(0);

/** Reason phrases for the statuses the forge sends (Node's STATUS_CODES). */
const REASONS: Readonly<Record<number, string>> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  413: 'Content Too Large',
  422: 'Unprocessable Entity',
  500: 'Internal Server Error',
};

/** A parsed request head: everything before the body. */
interface ParsedHead {
  method: string;
  target: string;
  version: string;
  headers: Record<string, string>;
  chunked: boolean;
  contentLength: number;
  keepAlive: boolean;
  expectsContinue: boolean;
}

/** The chunked-body reader's state machine. */
type ChunkState = 'size' | 'data' | 'crlf' | 'trailer';

/** One connection's parse state. */
interface ConnState {
  socket: Socket;
  pending: Buffer;
  paused: boolean;
  destroyed: boolean;
  head: ParsedHead | null;
  continueSent: boolean;
  chunkState: ChunkState;
  chunkLeft: number;
  chunkParts: Buffer[];
  chunkPartsLen: number;
}

/** Whether the connection stays open after this request's reply. */
function calcKeepAlive(version: string, headers: Record<string, string>): boolean {
  const connection = headers['connection'];
  const wantsClose = connection !== undefined && /(^|,)\s*close\s*(,|$)/i.test(connection);
  const wantsKeepAlive = connection !== undefined && /(^|,)\s*keep-alive\s*(,|$)/i.test(connection);
  if (version === 'HTTP/1.1') return !wantsClose;
  return wantsKeepAlive;
}

/**
 * Parse one request head from the front of `buf`. Returns the head and how
 * many bytes it consumed, `null` when more bytes are needed, or a status
 * code when the head is malformed (the caller answers with it and closes).
 */
function parseHead(buf: Buffer): { head: ParsedHead; consumed: number } | { needMore: true } | { error: number } {
  const headerEnd = buf.indexOf('\r\n\r\n');
  if (headerEnd === -1) {
    if (buf.length > MAX_HEADERS_BYTES) return { error: 400 };
    return { needMore: true };
  }
  const text = buf.toString('latin1', 0, headerEnd);
  const firstEol = text.indexOf('\r\n');
  const requestLine = firstEol === -1 ? text : text.slice(0, firstEol);
  const sp1 = requestLine.indexOf(' ');
  const sp2 = sp1 === -1 ? -1 : requestLine.indexOf(' ', sp1 + 1);
  if (sp1 <= 0 || sp2 === -1 || sp2 === requestLine.length - 1) return { error: 400 };
  const method = requestLine.slice(0, sp1);
  const target = requestLine.slice(sp1 + 1, sp2);
  const version = requestLine.slice(sp2 + 1);
  if (version !== 'HTTP/1.1' && version !== 'HTTP/1.0') return { error: 400 };
  if (target === '') return { error: 400 };

  const headers: Record<string, string> = {};
  if (firstEol !== -1) {
    let start = firstEol + 2;
    while (start < text.length) {
      const eol = text.indexOf('\r\n', start);
      const line = eol === -1 ? text.slice(start) : text.slice(start, eol);
      const colon = line.indexOf(':');
      if (colon > 0) {
        const name = line.slice(0, colon).toLowerCase();
        const value = line.slice(colon + 1).trim();
        const prev = headers[name];
        headers[name] = prev === undefined ? value : `${prev}, ${value}`;
      }
      if (eol === -1) break;
      start = eol + 2;
    }
  }

  const te = headers['transfer-encoding'];
  const cl = headers['content-length'];
  const chunked = te !== undefined && te.toLowerCase().includes('chunked');
  if (te !== undefined && !chunked) return { error: 400 };
  if (chunked && cl !== undefined) return { error: 400 };
  let contentLength = 0;
  if (!chunked && cl !== undefined) {
    if (!/^\d+$/.test(cl)) return { error: 400 };
    contentLength = Number(cl);
    if (contentLength > MAX_BODY_BYTES) return { error: 413 };
  }
  const expect = headers['expect'];
  return {
    head: {
      method,
      target,
      version,
      headers,
      chunked,
      contentLength,
      keepAlive: calcKeepAlive(version, headers),
      expectsContinue: expect !== undefined && expect.toLowerCase() === '100-continue',
    },
    consumed: headerEnd + 4,
  };
}

/** The response object handlers write to: buffers one writeHead + end into a single socket write. */
class RawResponse implements ForgeResponse {
  headersSent = false;
  private statusCode = 200;
  private fields: Readonly<Record<string, string | number>> | null = null;
  private socket: Socket;
  private version: string;
  private method: string;
  private keepAlive: boolean;
  private onWrite: (flushed: boolean) => void;

  constructor(
    socket: Socket,
    version: string,
    method: string,
    keepAlive: boolean,
    onWrite: (flushed: boolean) => void,
  ) {
    this.socket = socket;
    this.version = version;
    this.method = method;
    this.keepAlive = keepAlive;
    this.onWrite = onWrite;
  }

  writeHead(status: number, headers: Readonly<Record<string, string | number>>): void {
    this.statusCode = status;
    this.fields = headers;
    this.headersSent = true;
  }

  end(body?: Buffer): void {
    const fields = this.fields ?? {};
    const bodyLen = body !== undefined ? body.length : 0;
    let text = `HTTP/1.1 ${this.statusCode} ${REASONS[this.statusCode] ?? 'Unknown'}\r\n`;
    let hasContentLength = false;
    for (const name of Object.keys(fields)) {
      if (name === 'content-length') hasContentLength = true;
      text += `${name}: ${fields[name]}\r\n`;
    }
    if (!hasContentLength) {
      // 204/304 carry no body by definition; anything else needs a delimiter
      // on a keep-alive connection, so state the (zero) length explicitly.
      if (this.statusCode !== 204 && this.statusCode !== 304) text += `content-length: ${bodyLen}\r\n`;
    }
    if (!this.keepAlive) text += 'connection: close\r\n';
    else if (this.version === 'HTTP/1.0') text += 'connection: keep-alive\r\n';
    text += '\r\n';
    const headBuf = Buffer.from(text, 'latin1');
    // HEAD keeps the headers (including content-length) and drops the body.
    if (bodyLen > 0 && this.method !== 'HEAD') {
      this.onWrite(this.socket.write(Buffer.concat([headBuf, body as Buffer], headBuf.length + bodyLen)));
    } else {
      this.onWrite(this.socket.write(headBuf));
    }
  }

  destroy(): void {
    this.socket.destroy();
  }
}

/** Send a bare 400 (Node's clientError shape) and close the connection. */
function sendBare400(socket: Socket): void {
  try {
    socket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n');
  } catch {
    socket.destroy();
  }
}

/** Send the JSON 413 the old body reader produced, then close. */
function sendTooLarge(socket: Socket): void {
  const buf = jsonBuffer({ message: 'Request Entity Too Large' });
  const text =
    'HTTP/1.1 413 Content Too Large\r\n' +
    'content-type: application/json; charset=utf-8\r\n' +
    `content-length: ${buf.length}\r\n` +
    `x-github-request-id: ${nextRequestId()}\r\n` +
    'connection: close\r\n\r\n';
  const headBuf = Buffer.from(text, 'latin1');
  try {
    socket.end(Buffer.concat([headBuf, buf], headBuf.length + buf.length));
  } catch {
    socket.destroy();
  }
}

/** Advance the chunked-body reader over `conn.pending`. Returns the body when complete. Throws 'too large' past the cap, 'malformed' on a bad frame. */
function readChunked(conn: ConnState): Buffer | null {
  for (;;) {
    if (conn.chunkState === 'size') {
      const eol = conn.pending.indexOf('\r\n');
      if (eol === -1) return null;
      const line = conn.pending.toString('latin1', 0, eol);
      const semi = line.indexOf(';');
      const size = Number.parseInt(semi === -1 ? line : line.slice(0, semi), 16);
      if (!Number.isInteger(size) || size < 0) throw new Error('malformed');
      conn.pending = conn.pending.subarray(eol + 2);
      if (size === 0) {
        conn.chunkState = 'trailer';
      } else {
        conn.chunkLeft = size;
        conn.chunkState = 'data';
      }
    } else if (conn.chunkState === 'data') {
      if (conn.pending.length < conn.chunkLeft) {
        conn.chunkParts.push(conn.pending);
        conn.chunkPartsLen += conn.pending.length;
        if (conn.chunkPartsLen > MAX_BODY_BYTES) throw new Error('too large');
        conn.chunkLeft -= conn.pending.length;
        conn.pending = EMPTY_BODY;
        return null;
      }
      conn.chunkParts.push(conn.pending.subarray(0, conn.chunkLeft));
      conn.chunkPartsLen += conn.chunkLeft;
      if (conn.chunkPartsLen > MAX_BODY_BYTES) throw new Error('too large');
      conn.pending = conn.pending.subarray(conn.chunkLeft);
      conn.chunkState = 'crlf';
    } else if (conn.chunkState === 'crlf') {
      if (conn.pending.length < 2) return null;
      if (conn.pending[0] !== 0x0d || conn.pending[1] !== 0x0a) throw new Error('malformed');
      conn.pending = conn.pending.subarray(2);
      conn.chunkState = 'size';
    } else {
      // Trailer lines until an empty line ends the body.
      const eol = conn.pending.indexOf('\r\n');
      if (eol === -1) return null;
      if (eol === 0) {
        conn.pending = conn.pending.subarray(2);
        const body = Buffer.concat(conn.chunkParts, conn.chunkPartsLen);
        conn.chunkParts = [];
        conn.chunkPartsLen = 0;
        return body;
      }
      conn.pending = conn.pending.subarray(eol + 2);
    }
  }
}

/** A request handler: synchronous, writes exactly one response. */
export type RouteFn = (req: ForgeRequest, res: ForgeResponse, body: Buffer) => void;

/** Build the raw TCP server main.ts binds and registers. */
export function createRawServer(route: RouteFn): Server {
  // main.ts's shutdown calls server.closeAllConnections(), which net.Server
  // lacks (it is an http.Server method): track live sockets and provide it.
  const sockets = new Set<Socket>();
  const server = createServer((socket: Socket) => {
    sockets.add(socket);
    // Nagle would stall small replies up to 40 ms against delayed ACKs;
    // Node's http server disables it per socket, so do we.
    socket.setNoDelay(true);
    const conn: ConnState = {
      socket,
      pending: EMPTY_BODY,
      paused: false,
      destroyed: false,
      head: null,
      continueSent: false,
      chunkState: 'size',
      chunkLeft: 0,
      chunkParts: [],
      chunkPartsLen: 0,
    };

    const pump = (): void => {
      if (conn.destroyed || conn.paused) return;
      for (;;) {
        // Phase 1: read the request head.
        if (conn.head === null) {
          const parsed = parseHead(conn.pending);
          if ('needMore' in parsed) return;
          if ('error' in parsed) {
            if (parsed.error === 413) sendTooLarge(socket);
            else sendBare400(socket);
            conn.destroyed = true;
            return;
          }
          conn.head = parsed.head;
          conn.pending = conn.pending.subarray(parsed.consumed);
          conn.continueSent = false;
          conn.chunkState = 'size';
          conn.chunkLeft = 0;
          conn.chunkParts = [];
          conn.chunkPartsLen = 0;
        }
        const head = conn.head;
        if (head.expectsContinue && !conn.continueSent) {
          try {
            socket.write('HTTP/1.1 100 Continue\r\n\r\n');
          } catch {
            conn.destroyed = true;
            return;
          }
          conn.continueSent = true;
        }
        // Phase 2: read the body.
        let body: Buffer;
        if (head.chunked) {
          let chunked: Buffer | null;
          try {
            chunked = readChunked(conn);
          } catch (err) {
            if (err instanceof Error && err.message === 'too large') sendTooLarge(socket);
            else sendBare400(socket);
            conn.destroyed = true;
            return;
          }
          if (chunked === null) return;
          body = chunked;
        } else if (conn.pending.length < head.contentLength) {
          return;
        } else {
          body = conn.pending.subarray(0, head.contentLength);
          conn.pending = conn.pending.subarray(head.contentLength);
        }
        // Dispatch: synchronous handlers, one response, in request order.
        const req: ForgeRequest = { method: head.method, url: head.target, headers: head.headers };
        const res = new RawResponse(socket, head.version, head.method, head.keepAlive, (flushed: boolean) => {
          if (!flushed) conn.paused = true;
        });
        const keepAlive = head.keepAlive;
        conn.head = null;
        try {
          route(req, res, body);
        } catch {
          // The route wrapper answers 500s itself; anything escaping here is
          // a failure of that path, so drop the connection rather than hang.
          socket.destroy();
          conn.destroyed = true;
          return;
        }
        if (!keepAlive) {
          // end() flushes the queued reply before the FIN, even under
          // backpressure, so this is safe before the paused check.
          try {
            socket.end();
          } catch {
            // Already closed.
          }
          conn.destroyed = true;
          return;
        }
        if (conn.paused) return;
        // Loop: answer pipelined requests already in the buffer.
        if (conn.pending.length === 0) return;
      }
    };

    socket.on('data', (chunk: Buffer) => {
      conn.pending = conn.pending.length === 0 ? chunk : Buffer.concat([conn.pending, chunk]);
      pump();
    });
    socket.on('drain', () => {
      conn.paused = false;
      pump();
    });
    const onGone = (): void => {
      conn.destroyed = true;
      sockets.delete(socket);
    };
    socket.on('close', onGone);
    socket.on('error', onGone);
  });
  (server as unknown as { closeAllConnections(): void }).closeAllConnections = () => {
    for (const s of sockets) s.destroy();
  };
  return server;
}
