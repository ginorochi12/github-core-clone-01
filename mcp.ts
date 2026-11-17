/**
 * MCP at POST /mcp: JSON-RPC 2.0 over Streamable HTTP (plain JSON answers,
 * no SSE), speaking the modern 2026-07-28 era and the legacy handshake era.
 *
 * - `server/discover` answers supportedVersions, serverInfo (both as a loose
 *   field and under `_meta['io.modelcontextprotocol/serverInfo']`, the two
 *   places the suite's client looks) and capabilities.tools. The client
 *   settles on the modern era from this one answer; there is no session.
 * - `initialize` + `notifications/initialized` are implemented as well, so a
 *   pre-discover client still connects.
 * - `tools/list` answers the six canonical tools in a fixed order; the result
 *   is a constant, so two calls are byte-identical.
 * - `tools/call` runs on the same in-memory store as REST and GraphQL.
 * - A body that is not JSON gets HTTP 400 with JSON-RPC -32700. No bearer
 *   token gets HTTP 401. Unknown tools get -32602, never a 500.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAuthenticated, parseJsonBody, sendEmpty, sendJson, type RequestUrl } from './httputil.ts';
import {
  createIssueObject,
  createPullObject,
  issueJson,
  mergePullObject,
  pullJson,
  repoJson,
} from './rest.ts';
import { store, type Repo } from './store.ts';

const SERVER_NAME = 'makefun-forge';
const SERVER_VERSION = '1.0.0';
const MODERN_REVISION = '2026-07-28';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required: string[];
  };
}

function tool(
  name: string,
  description: string,
  properties: Record<string, { type: string; description?: string }>,
  required: string[],
): ToolDef {
  return { name, description, inputSchema: { type: 'object', properties, required } };
}

/**
 * The six canonical tools. `required` lists only properties the suite can
 * fill (it maps arguments by normalized synonym); an unfillable required
 * property fails the tool's check.
 */
const TOOLS: readonly ToolDef[] = Object.freeze([
  tool(
    'create_repo',
    'Create a repository owned by the authenticated user.',
    {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    ['name'],
  ),
  tool(
    'get_repo',
    'Get a repository by owner and name.',
    {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    ['owner', 'repo'],
  ),
  tool(
    'create_issue',
    'Create an issue in a repository.',
    {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    ['owner', 'repo', 'title'],
  ),
  tool(
    'list_issues',
    'List issues in a repository.',
    {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
    },
    ['owner', 'repo'],
  ),
  tool(
    'create_pull_request',
    'Create a pull request in a repository.',
    {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
      body: { type: 'string', description: 'The pull request body.' },
    },
    ['owner', 'repo', 'title', 'head', 'base'],
  ),
  tool(
    'merge_pull_request',
    'Merge a pull request with a squash merge.',
    {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'integer', description: 'The pull request number.' },
    },
    ['owner', 'repo', 'pull_number'],
  ),
]);

type JsonRpcId = string | number | null;

function rpcResult(res: ServerResponse, id: JsonRpcId, result: unknown): void {
  sendJson(res, 200, { jsonrpc: '2.0', id, result });
}

function rpcError(res: ServerResponse, id: JsonRpcId, code: number, message: string, httpStatus = 200): void {
  sendJson(res, httpStatus, { jsonrpc: '2.0', id, error: { code, message } });
}

/** The first defined argument among a list of synonymous names. */
function pick(args: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    if (args[name] !== undefined && args[name] !== null) return args[name];
  }
  return undefined;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number.parseInt(value, 10);
  return null;
}

function toolOk(payload: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function toolErr(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Resolve a repo from tool arguments, locking the owner on first sight. */
function resolveRepo(args: Record<string, unknown>): { repo: Repo | null; error: string | null } {
  const owner = asString(pick(args, 'owner', 'ownerLogin'));
  const name = asString(pick(args, 'repo', 'repository', 'repositoryName'));
  if (owner === null || name === null) return { repo: null, error: 'owner and repo are required' };
  if (!store.isOwner(owner)) return { repo: null, error: `Repository ${owner}/${name} not found` };
  const repo = store.getRepo(owner, name);
  if (repo === undefined) return { repo: null, error: `Repository ${owner}/${name} not found` };
  return { repo, error: null };
}

type ToolCallOutcome =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; code: number; message: string };

function callTool(name: string, args: Record<string, unknown>): ToolCallOutcome {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  switch (normalized) {
    case 'createrepo':
    case 'createrepository': {
      const repoName = asString(pick(args, 'name', 'repoName', 'repository'));
      if (repoName === null || repoName === '') {
        return { ok: false, code: -32602, message: 'create_repo: name is required' };
      }
      const owner = store.effectiveOwner();
      store.isOwner(owner);
      if (store.getRepo(owner, repoName) !== undefined) {
        return { ok: true, value: toolErr(`Repository ${owner}/${repoName} already exists`) };
      }
      const description = asString(pick(args, 'description')) ?? '';
      const isPrivate = pick(args, 'private') === true;
      const repo = store.createRepo(owner, repoName, { description, private: isPrivate });
      return { ok: true, value: toolOk(repoJson(repo)) };
    }
    case 'getrepo':
    case 'getrepository': {
      const { repo, error } = resolveRepo(args);
      if (repo === null) return { ok: true, value: toolErr(error ?? 'Repository not found') };
      return { ok: true, value: toolOk(repoJson(repo)) };
    }
    case 'createissue':
    case 'issuecreate': {
      const { repo, error } = resolveRepo(args);
      if (repo === null) return { ok: true, value: toolErr(error ?? 'Repository not found') };
      const title = asString(pick(args, 'title'));
      if (title === null || title === '') {
        return { ok: false, code: -32602, message: 'create_issue: title is required' };
      }
      const body = asString(pick(args, 'body', 'description'));
      const created = createIssueObject(repo, { title, body: body ?? undefined, labels: [] });
      if ('error' in created) return { ok: true, value: toolErr(created.error) };
      return { ok: true, value: toolOk(issueJson(repo, created.issue)) };
    }
    case 'listissues':
    case 'issueslist': {
      const { repo, error } = resolveRepo(args);
      if (repo === null) return { ok: true, value: toolErr(error ?? 'Repository not found') };
      const state = asString(pick(args, 'state')) ?? 'open';
      const issues = [...repo.issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => b.number - a.number)
        .map((issue) => issueJson(repo, issue));
      return {
        ok: true,
        value: {
          content: [{ type: 'text', text: JSON.stringify(issues) }],
          structuredContent: { issues },
        },
      };
    }
    case 'createpullrequest':
    case 'createpr':
    case 'pullrequestcreate': {
      const { repo, error } = resolveRepo(args);
      if (repo === null) return { ok: true, value: toolErr(error ?? 'Repository not found') };
      const title = asString(pick(args, 'title'));
      const head = asString(pick(args, 'head', 'headRef', 'head_ref', 'headRefName', 'source', 'source_branch'));
      const base = asString(pick(args, 'base', 'baseRef', 'base_ref', 'baseRefName', 'target', 'target_branch'));
      if (title === null || title === '' || head === null || base === null) {
        return { ok: false, code: -32602, message: 'create_pull_request: title, head and base are required' };
      }
      const body = asString(pick(args, 'body', 'description'));
      const created = createPullObject(repo, { title, body: body ?? undefined, head, base });
      if ('error' in created) return { ok: true, value: toolErr(created.error) };
      return { ok: true, value: toolOk(pullJson(repo, created.pull)) };
    }
    case 'mergepullrequest':
    case 'mergepr': {
      const { repo, error } = resolveRepo(args);
      if (repo === null) return { ok: true, value: toolErr(error ?? 'Repository not found') };
      const number = asNumber(pick(args, 'pull_number', 'pullNumber', 'number', 'pull_request_number', 'pr_number'));
      if (number === null) {
        return { ok: false, code: -32602, message: 'merge_pull_request: pull_number is required' };
      }
      const pull = repo.pulls.get(number);
      if (pull === undefined) return { ok: true, value: toolErr(`Pull request #${number} not found`) };
      const merged = mergePullObject(repo, pull);
      if ('error' in merged) {
        return { ok: true, value: toolErr(`Pull request #${number} cannot be merged: ${merged.error}`) };
      }
      return { ok: true, value: toolOk({ merged: true, sha: merged.sha, message: pull.title, pull_number: number }) };
    }
    default:
      return { ok: false, code: -32602, message: `Unknown tool: ${name}` };
  }
}

/**
 * POST /mcp (and DELETE for a legacy session close). The body is read by the
 * caller (app.ts) and passed in, like the other handlers. Returns true when
 * the path was /mcp (handled).
 */
export function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  _url: RequestUrl,
  body: Buffer,
): boolean {
  if (pathname !== '/mcp') return false;

  if (req.method === 'DELETE') {
    sendEmpty(res, 204);
    return true;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32601, message: 'Method Not Allowed' } });
    return true;
  }
  if (!isAuthenticated(req)) {
    rpcError(res, null, -32000, 'Unauthorized', 401);
    return true;
  }

  const parsed = parseJsonBody(body);
  if (!parsed.ok) {
    rpcError(res, null, -32700, 'Parse error', 400);
    return true;
  }
  const value = parsed.value;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    rpcError(res, null, -32600, 'Invalid Request', 400);
    return true;
  }
  const request = value as Record<string, unknown>;
  const id: JsonRpcId =
    typeof request.id === 'string' || typeof request.id === 'number' ? request.id : null;
  const isNotification = request.id === undefined;
  const method = request.method;

  if (typeof method !== 'string') {
    if (isNotification) {
      sendEmpty(res, 202);
      return true;
    }
    rpcError(res, id, -32600, 'Invalid Request');
    return true;
  }

  // Notifications get no JSON-RPC answer, just an accepted status.
  if (isNotification) {
    sendEmpty(res, 202);
    return true;
  }

  const params =
    request.params !== null && typeof request.params === 'object' && !Array.isArray(request.params)
      ? (request.params as Record<string, unknown>)
      : {};

  switch (method) {
    case 'server/discover': {
      const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
      rpcResult(res, id, {
        supportedVersions: [MODERN_REVISION],
        serverInfo,
        capabilities: { tools: {} },
        _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
      });
      return true;
    }
    case 'initialize': {
      const offered = params.protocolVersion;
      const revision = typeof offered === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(offered) ? offered : '2025-11-25';
      rpcResult(res, id, {
        protocolVersion: revision,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
      return true;
    }
    case 'tools/list': {
      rpcResult(res, id, { tools: TOOLS });
      return true;
    }
    case 'tools/call': {
      const toolName = params.name;
      if (typeof toolName !== 'string' || toolName === '') {
        rpcError(res, id, -32602, 'tools/call: name is required');
        return true;
      }
      const args =
        params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
          ? (params.arguments as Record<string, unknown>)
          : {};
      const outcome = callTool(toolName, args);
      if (!outcome.ok) {
        rpcError(res, id, outcome.code, outcome.message);
        return true;
      }
      rpcResult(res, id, outcome.value);
      return true;
    }
    case 'ping': {
      rpcResult(res, id, {});
      return true;
    }
    default: {
      rpcError(res, id, -32601, `Method not found: ${method}`);
      return true;
    }
  }
}
