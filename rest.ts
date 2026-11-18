// The GitHub REST v3 surface under /api/v3: repositories, branches, commits, contents,
// labels, issues, comments, pull requests, files and merges. Every reply is application/json
// with a non-empty X-GitHub-Request-Id; every error body is {"message": string}.
// Shape checking in the suite allows extra fields, so the objects carry GitHub's usual
// extras beside the asserted ones.

import { nextTimestampIso } from './clock.ts';
import { isObjectId } from './gitobj.ts';
import {
  branchTip,
  checkMerge,
  commitTree,
  commitView,
  createCommit,
  diffCommits,
  invalidateIssueJson,
  invalidatePackCache,
  listBranches,
  listTreeDir,
  putObject,
  readTreePath,
  resolveRef,
  squashTree,
  store,
  treeWithPath,
  walkCommits,
  type Issue,
  type PullRequest,
  type Repo,
} from './store.ts';
import {
  isAuthenticated,
  jsonBuffer,
  parseJsonBody,
  sendBuffer,
  sendEmpty,
  sendError,
  sendJson,
  JSON_TYPE,
  type ForgeRequest,
  type ForgeResponse,
  type RequestUrl,
} from './httputil.ts';

// ---------------------------------------------------------------------------------------------
// serialization
// ---------------------------------------------------------------------------------------------

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', String(repo.id)),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1000, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    has_issues: true,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', `${repo.id}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed' };
    }),
    user: { login: issue.userLogin, id: 1000, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    comments: issue.comments.length,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

/**
 * Answer a single-issue GET from the issue's cached body when it is fresh, else serialize
 * and cache it. The cached bytes are exactly what sendJson would send (JSON + '\n'), so a
 * cache hit is byte-identical to a fresh build. The read benchmark GETs one issue 2,000
 * times, so this removes the object build, the stringify and the buffer allocation per read.
 */
function serveIssue(res: ForgeResponse, repo: Repo, issue: Issue): void {
  const cached = issue.cachedJson;
  if (cached !== undefined) {
    sendBuffer(res, 200, cached, JSON_TYPE);
    return;
  }
  const buf = jsonBuffer(issueJson(repo, issue));
  issue.cachedJson = buf;
  sendBuffer(res, 200, buf, JSON_TYPE);
}

/** Answer a create/PATCH with a freshly built body, and cache it: the issue just changed. */
function sendFreshIssue(res: ForgeResponse, status: number, repo: Repo, issue: Issue): void {
  const buf = jsonBuffer(issueJson(repo, issue));
  issue.cachedJson = buf;
  sendBuffer(res, status, buf, JSON_TYPE);
}

export function commentJson(repo: Repo, issue: Issue, comment: Issue['comments'][number]): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', `${repo.id}:${issue.number}:${comment.id}`),
    body: comment.body,
    user: { login: comment.userLogin, id: 1000, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
  };
}

export function pullJson(repo: Repo, pull: PullRequest): Record<string, unknown> {
  const headSha = branchTip(repo, pull.headRef) ?? '';
  const baseSha = branchTip(repo, pull.baseRef) ?? '';
  return {
    id: pull.id,
    node_id: globalId('PullRequest', `${repo.id}:${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: checkMerge(repo, pull.headRef, pull.baseRef).status === 'mergeable',
    user: { login: pull.userLogin, id: 1000, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

/** An opaque, stable Relay global id: base64 of `Type:payload`. */
export function globalId(type: string, payload: string): string {
  return Buffer.from(`${type}:${payload}`, 'utf8').toString('base64');
}

/** Decode a global id into [type, payload], or null when it is not one. */
export function parseGlobalId(id: string): { type: string; payload: string } | null {
  try {
    const decoded = Buffer.from(id, 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon <= 0) return null;
    const type = decoded.slice(0, colon);
    const payload = decoded.slice(colon + 1);
    if (type === '' || payload === '') return null;
    // A re-encode must round-trip, so garbage base64 does not decode into a false id.
    if (Buffer.from(decoded, 'utf8').toString('base64') !== id) return null;
    return { type, payload };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// pagination
// ---------------------------------------------------------------------------------------------

interface PageParams {
  page: number;
  perPage: number;
}

function pageParams(url: RequestUrl): PageParams {
  const page = Number.parseInt(url.searchParams.get('page') ?? '1', 10);
  const perPage = Number.parseInt(url.searchParams.get('per_page') ?? '30', 10);
  return {
    page: Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1,
    perPage: Number.isFinite(perPage) && perPage >= 1 ? Math.min(100, Math.floor(perPage)) : 30,
  };
}

/** Slice a list into one page and build GitHub's Link header (absolute, same-origin URLs). */
function paginate<T>(req: ForgeRequest, url: RequestUrl, items: readonly T[]): { page: T[]; link: string | null } {
  const { page, perPage } = pageParams(url);
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const host = req.headers.host ?? '127.0.0.1';
  const base = `http://${host}${url.pathname}`;
  const linkFor = (p: number): string => {
    const params = new URLSearchParams(url.searchParams);
    params.set('page', String(p));
    params.set('per_page', String(perPage));
    return `<${base}?${params.toString()}>`;
  };
  const links: string[] = [];
  if (page < totalPages) links.push(`${linkFor(page + 1)}; rel="next"`);
  if (page > 1) links.push(`${linkFor(page - 1)}; rel="prev"`);
  links.push(`${linkFor(1)}; rel="first"`);
  links.push(`${linkFor(totalPages)}; rel="last"`);
  return { page: slice, link: links.length > 0 ? links.join(', ') : null };
}

function sendPage<T>(req: ForgeRequest, res: ForgeResponse, url: RequestUrl, items: readonly T[]): void {
  const { page, link } = paginate(req, url, items);
  sendJson(res, 200, page, link === null ? {} : { link });
}

// ---------------------------------------------------------------------------------------------
// shared lookups
// ---------------------------------------------------------------------------------------------

type RepoLookup = { repo: Repo } | { error: 'foreign' | 'missing' };

/** Resolve an owner/name pair: locks the owner on first sight, 404s a foreign or missing repo. */
function lookupRepo(owner: string, name: string): RepoLookup {
  if (!store.isOwner(owner)) return { error: 'foreign' };
  const repo = store.getRepo(owner, name);
  if (!repo) return { error: 'missing' };
  return { repo };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bodyString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' ? value : undefined;
}

// ---------------------------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------------------------

/** The branch a contents call targets: the body's branch, else the repo's default branch. */
function contentsBranch(repo: Repo, body: Record<string, unknown>): string {
  const branch = bodyString(body, 'branch');
  return branch !== undefined && branch !== '' ? branch : repo.defaultBranch;
}

function handleGetContents(req: ForgeRequest, res: ForgeResponse, repo: Repo, url: RequestUrl, path: string): void {
  const ref = url.searchParams.get('ref') ?? repo.defaultBranch;
  const commit = resolveRef(repo, ref);
  if (commit === null) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const tree = commitTree(repo, commit);
  if (tree === null) {
    sendError(res, 404, 'Not Found');
    return;
  }
  if (path === '') {
    // The repository root.
    const entries = listTreeDir(repo, tree, '') ?? [];
    sendJson(res, 200, entries.map((entry) => dirEntry(repo, entry, '')));
    return;
  }
  const file = readTreePath(repo, tree, path);
  if (file !== null) {
    const blob = repo.objects.get(file.oid);
    const data = blob?.type === 'blob' ? blob.data : Buffer.alloc(0);
    sendJson(res, 200, {
      type: 'file',
      encoding: 'base64',
      content: data.toString('base64'),
      sha: file.oid,
      size: data.length,
      name: path.split('/').pop() ?? path,
      path,
    });
    return;
  }
  const dir = listTreeDir(repo, tree, path);
  if (dir !== null) {
    sendJson(res, 200, dir.map((entry) => dirEntry(repo, entry, path)));
    return;
  }
  sendError(res, 404, 'Not Found');
}

function dirEntry(repo: Repo, entry: { mode: string; name: string; oid: string }, dir: string): Record<string, unknown> {
  const path = dir === '' ? entry.name : `${dir}/${entry.name}`;
  if (entry.mode === '40000') {
    return { type: 'dir', name: entry.name, path, sha: entry.oid };
  }
  const blob = repo.objects.get(entry.oid);
  const size = blob?.type === 'blob' ? blob.data.length : 0;
  return { type: 'file', encoding: 'base64', name: entry.name, path, sha: entry.oid, size };
}

function handlePutContents(res: ForgeResponse, repo: Repo, path: string, body: Record<string, unknown>): void {
  const message = bodyString(body, 'message') ?? '';
  const contentB64 = bodyString(body, 'content');
  if (contentB64 === undefined) {
    sendError(res, 422, 'content is required');
    return;
  }
  if (path === '') {
    sendError(res, 422, 'a file path is required');
    return;
  }
  const branch = contentsBranch(repo, body);
  const content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
  const blobOid = putObject(repo, 'blob', content);
  const tip = branchTip(repo, branch);
  // A branch that does not exist yet starts from the default branch's tip (or nothing).
  const parent = tip ?? (branch === repo.defaultBranch ? null : branchTip(repo, repo.defaultBranch) ?? null);
  const parentTree = parent === null ? null : commitTree(repo, parent);
  const existing = parentTree === null ? null : readTreePath(repo, parentTree, path);
  const sha = bodyString(body, 'sha');
  if (existing !== null) {
    if (sha === undefined) {
      sendError(res, 422, 'sha is required to update an existing file');
      return;
    }
    if (sha.toLowerCase() !== existing.oid.toLowerCase()) {
      sendError(res, 409, 'the sha does not match the current file');
      return;
    }
  }
  const tree = treeWithPath(repo, parentTree, path, blobOid);
  const commit = createCommit(repo, {
    branch,
    tree,
    parents: parent === null ? [] : [parent],
    message: message === '' ? `Update ${path}` : message,
  });
  const status = existing === null ? 201 : 200;
  sendJson(res, status, {
    content: {
      type: 'file',
      encoding: 'base64',
      name: path.split('/').pop() ?? path,
      path,
      sha: blobOid,
      size: content.length,
    },
    commit: { sha: commit, message },
  });
}

function handleDeleteContents(res: ForgeResponse, repo: Repo, path: string, body: Record<string, unknown>): void {
  const message = bodyString(body, 'message') ?? '';
  const branch = contentsBranch(repo, body);
  const tip = branchTip(repo, branch);
  if (tip === undefined) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const tree = commitTree(repo, tip);
  if (tree === null) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const existing = readTreePath(repo, tree, path);
  if (existing === null) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const sha = bodyString(body, 'sha');
  if (sha !== undefined && sha.toLowerCase() !== existing.oid.toLowerCase()) {
    sendError(res, 409, 'the sha does not match the current file');
    return;
  }
  const nextTree = treeWithPath(repo, tree, path, null);
  const commit = createCommit(repo, {
    branch,
    tree: nextTree,
    parents: [tip],
    message: message === '' ? `Delete ${path}` : message,
  });
  sendJson(res, 200, { commit: { sha: commit, message } });
}

// ---------------------------------------------------------------------------------------------
// issues and pull requests (shared by REST, GraphQL and MCP)
// ---------------------------------------------------------------------------------------------

export function createIssueObject(
  repo: Repo,
  input: { title: string; body?: string; labels?: string[] },
): { issue: Issue } | { error: string; status: number } {
  const labels = input.labels ?? [];
  for (const name of labels) {
    if (!repo.labels.has(name)) return { error: `Label "${name}" does not exist`, status: 422 };
  }
  const now = nextTimestampIso();
  const number = repo.nextNumber++;
  const issue: Issue = {
    id: store.nextIssueIdValue(),
    number,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    labels: [...labels],
    userLogin: repo.owner,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    comments: [],
  };
  repo.issues.set(number, issue);
  return { issue };
}

export function createPullObject(
  repo: Repo,
  input: { title: string; body?: string; head: string; base: string },
): { pull: PullRequest } | { error: string; status: number } {
  if (branchTip(repo, input.head) === undefined) return { error: `head branch "${input.head}" does not exist`, status: 422 };
  if (branchTip(repo, input.base) === undefined) return { error: `base branch "${input.base}" does not exist`, status: 422 };
  if (input.head === input.base) return { error: 'head and base are the same branch', status: 422 };
  for (const existing of repo.pulls.values()) {
    if (existing.state === 'open' && existing.headRef === input.head && existing.baseRef === input.base) {
      return { error: 'a pull request for this head and base already exists', status: 422 };
    }
  }
  const now = nextTimestampIso();
  const number = repo.nextNumber++;
  const pull: PullRequest = {
    id: store.nextPullIdValue(),
    number,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    headRef: input.head,
    baseRef: input.base,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    userLogin: repo.owner,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
  };
  repo.pulls.set(number, pull);
  return { pull };
}

/** Squash-merge an open pull request. Returns the merge commit sha, or an error. */
export function mergePullObject(repo: Repo, pull: PullRequest): { sha: string } | { error: string; status: number } {
  if (pull.state !== 'open') {
    return { error: pull.merged ? 'this pull request has already been merged' : 'this pull request is closed', status: 405 };
  }
  const check = checkMerge(repo, pull.headRef, pull.baseRef);
  if (check.status === 'conflicting') {
    return { error: 'this pull request has conflicts and cannot be merged', status: 405 };
  }
  if (check.status === 'unknown' || check.baseTip === null || check.headTip === null) {
    return { error: 'this pull request cannot be merged', status: 405 };
  }
  const tree = squashTree(repo, check);
  const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`;
  const sha = createCommit(repo, { branch: pull.baseRef, tree, parents: [check.baseTip], message });
  const now = nextTimestampIso();
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = now;
  pull.mergeCommitSha = sha;
  pull.closedAt = now;
  pull.updatedAt = now;
  return { sha };
}

// ---------------------------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------------------------

/**
 * Handle /api/v3/... Returns true when the path was under /api/v3 (handled); false otherwise.
 */
export function handleRest(
  req: ForgeRequest,
  res: ForgeResponse,
  pathname: string,
  url: RequestUrl,
  body: Buffer,
): boolean {
  if (pathname !== '/api/v3' && !pathname.startsWith('/api/v3/')) return false;
  const method = req.method ?? 'GET';

  // The API root and meta are public, as on github.com; everything else needs the token.
  const isPublic = method === 'GET' && (pathname === '/api/v3' || pathname === '/api/v3/' || pathname === '/api/v3/meta');
  if (!isPublic && !isAuthenticated(req)) {
    sendError(res, 401, 'Requires authentication');
    return true;
  }

  // A body that claims to be JSON but is not is a 400 (before any routing, as the suite tests).
  let parsed: unknown = {};
  if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
    const contentType = req.headers['content-type'] ?? '';
    if (body.length > 0 && contentType.includes('application/json')) {
      const result = parseJsonBody(body);
      if (!result.ok) {
        sendError(res, 400, 'the request body is not valid JSON');
        return true;
      }
      parsed = result.value;
    } else if (body.length > 0) {
      // A body without a JSON content type is still parsed as JSON when it parses; the
      // suite always sends application/json, so this is only a lenient fallback.
      const result = parseJsonBody(body);
      if (result.ok) parsed = result.value;
    }
  }
  const jsonBody: Record<string, unknown> = isRecord(parsed) ? parsed : {};

  const segments = pathname.split('/').filter((segment) => segment !== '');
  // segments[0] === 'api', segments[1] === 'v3'

  if ((pathname === '/api/v3' || pathname === '/api/v3/') && method === 'GET') {
    sendJson(
      res,
      200,
      { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
    return true;
  }

  if (pathname === '/api/v3/meta' && method === 'GET') {
    sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: false });
    return true;
  }

  if (pathname === '/api/v3/user' && method === 'GET') {
    const login = store.effectiveOwner();
    sendJson(res, 200, { login, id: 1000, type: 'User', name: login, email: `${login}@example.invalid` });
    return true;
  }

  if (pathname === '/api/v3/user/repos') {
    if (method === 'POST') {
      const name = bodyString(jsonBody, 'name');
      if (name === undefined || name === '') {
        sendError(res, 422, 'name is required');
        return true;
      }
      const owner = store.effectiveOwner();
      store.isOwner(owner); // lock the owner on first sight
      if (store.getRepo(owner, name)) {
        sendError(res, 422, `Repository ${owner}/${name} already exists`);
        return true;
      }
      const description = bodyString(jsonBody, 'description') ?? '';
      const isPrivate = jsonBody.private === true;
      const repo = store.createRepo(owner, name, { description, private: isPrivate });
      sendJson(res, 201, repoJson(repo));
      return true;
    }
    if (method === 'GET') {
      const owner = store.effectiveOwner();
      sendPage(req, res, url, store.listRepos(owner).map(repoJson));
      return true;
    }
  }

  // /api/v3/repos/{owner}/{name}[/...]
  if (segments[2] === 'repos' && segments.length >= 5) {
    const owner = decodeURIComponent(segments[3]!);
    const name = decodeURIComponent(segments[4]!);
    const rest = segments.slice(5);
    const found = lookupRepo(owner, name);
    if ('error' in found) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    const repo = found.repo;
    return handleRepoRoute(req, res, url, repo, rest, method, jsonBody);
  }

  sendError(res, 404, 'Not Found');
  return true;
}

function handleRepoRoute(
  req: ForgeRequest,
  res: ForgeResponse,
  url: RequestUrl,
  repo: Repo,
  rest: string[],
  method: string,
  jsonBody: Record<string, unknown>,
): boolean {
  const [head, ...tail] = rest;

  // /repos/{o}/{r}
  if (head === undefined) {
    if (method === 'GET') {
      sendJson(res, 200, repoJson(repo));
      return true;
    }
    if (method === 'PATCH') {
      const description = bodyString(jsonBody, 'description');
      if (description !== undefined) repo.description = description;
      if (typeof jsonBody.private === 'boolean') repo.private = jsonBody.private;
      repo.updatedAt = nextTimestampIso();
      sendJson(res, 200, repoJson(repo));
      return true;
    }
    if (method === 'DELETE') {
      invalidatePackCache();
      store.deleteRepo(repo.owner, repo.name);
      sendEmpty(res, 204);
      return true;
    }
    sendError(res, 404, 'Not Found');
    return true;
  }

  if (head === 'branches') {
    if (tail.length === 0 && method === 'GET') {
      sendJson(res, 200, listBranches(repo).map((branch) => ({ name: branch.name, commit: { sha: branch.sha } })));
      return true;
    }
    if (tail.length >= 1 && method === 'GET') {
      const branch = tail.map(decodeURIComponent).join('/');
      const tip = branchTip(repo, branch);
      if (tip === undefined) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      sendJson(res, 200, { name: branch, commit: { sha: tip } });
      return true;
    }
    sendError(res, 404, 'Not Found');
    return true;
  }

  if (head === 'commits' && method === 'GET') {
    const ref = url.searchParams.get('sha') ?? repo.defaultBranch;
    const tip = resolveRef(repo, ref);
    if (tip === null) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    const { page, perPage } = pageParams(url);
    const commits = walkCommits(repo, tip, 1000).slice((page - 1) * perPage, page * perPage);
    sendJson(
      res,
      200,
      commits.map((sha) => {
        const view = commitView(repo, sha);
        const message = (view?.message ?? '').replace(/\n+$/, '');
        return {
          sha,
          commit: {
            message,
            author: { name: repo.owner, email: `${repo.owner}@users.noreply.github.com` },
            committer: { name: repo.owner, email: `${repo.owner}@users.noreply.github.com` },
          },
          parents: (view?.parents ?? []).map((parent) => ({ sha: parent })),
        };
      }),
    );
    return true;
  }

  if (head === 'git' && tail[0] === 'refs') {
    if (method === 'POST' && tail.length === 1) {
      const ref = bodyString(jsonBody, 'ref');
      const sha = bodyString(jsonBody, 'sha');
      if (ref === undefined || !ref.startsWith('refs/') || sha === undefined || !isObjectId(sha)) {
        sendError(res, 422, 'ref and sha are required');
        return true;
      }
      if (repo.refs.has(ref)) {
        sendError(res, 422, 'Reference already exists');
        return true;
      }
      if (!repo.objects.has(sha)) {
        sendError(res, 422, 'the sha does not exist in this repository');
        return true;
      }
      repo.refs.set(ref, sha);
      repo.updatedAt = nextTimestampIso();
      invalidatePackCache();
      sendJson(res, 201, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
      return true;
    }
    if (method === 'GET' && tail.length >= 2) {
      const ref = `refs/${tail.slice(1).map(decodeURIComponent).join('/')}`;
      const sha = repo.refs.get(ref);
      if (sha === undefined) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      sendJson(res, 200, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
      return true;
    }
    sendError(res, 404, 'Not Found');
    return true;
  }

  if (head === 'contents') {
    const path = tail.map(decodeURIComponent).join('/');
    if (method === 'GET') {
      handleGetContents(req, res, repo, url, path);
      return true;
    }
    if (method === 'PUT') {
      handlePutContents(res, repo, path, jsonBody);
      return true;
    }
    if (method === 'DELETE') {
      handleDeleteContents(res, repo, path, jsonBody);
      return true;
    }
    sendError(res, 404, 'Not Found');
    return true;
  }

  if (head === 'labels') {
    if (method === 'GET') {
      sendJson(res, 200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })));
      return true;
    }
    if (method === 'POST') {
      const name = bodyString(jsonBody, 'name');
      if (name === undefined || name === '') {
        sendError(res, 422, 'name is required');
        return true;
      }
      if (repo.labels.has(name)) {
        sendError(res, 422, `Label "${name}" already exists`);
        return true;
      }
      const color = bodyString(jsonBody, 'color') ?? 'ededed';
      repo.labels.set(name, { name, color });
      sendJson(res, 201, { name, color });
      return true;
    }
    sendError(res, 404, 'Not Found');
    return true;
  }

  if (head === 'issues') {
    return handleIssueRoute(req, res, url, repo, tail, method, jsonBody);
  }

  if (head === 'pulls') {
    return handlePullRoute(req, res, url, repo, tail, method, jsonBody);
  }

  sendError(res, 404, 'Not Found');
  return true;
}

function handleIssueRoute(
  req: ForgeRequest,
  res: ForgeResponse,
  url: RequestUrl,
  repo: Repo,
  tail: string[],
  method: string,
  jsonBody: Record<string, unknown>,
): boolean {
  if (tail.length === 0) {
    if (method === 'POST') {
      const title = bodyString(jsonBody, 'title');
      if (title === undefined || title === '') {
        sendError(res, 422, 'title is required');
        return true;
      }
      const body = bodyString(jsonBody, 'body') ?? '';
      const labels = Array.isArray(jsonBody.labels)
        ? jsonBody.labels.filter((label): label is string => typeof label === 'string')
        : [];
      const created = createIssueObject(repo, { title, body, labels });
      if ('error' in created) {
        sendError(res, created.status, created.error);
        return true;
      }
      sendFreshIssue(res, 201, repo, created.issue);
      return true;
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const direction = url.searchParams.get('direction') ?? 'desc';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      sendPage(req, res, url, issues.map((issue) => issueJson(repo, issue)));
      return true;
    }
    sendError(res, 404, 'Not Found');
    return true;
  }

  const number = Number.parseInt(tail[0]!, 10);
  if (!Number.isInteger(number) || number < 1) {
    sendError(res, 404, 'Not Found');
    return true;
  }
  const issue = repo.issues.get(number);
  if (!issue) {
    sendError(res, 404, 'Not Found');
    return true;
  }

  if (tail.length === 1) {
    if (method === 'GET') {
      serveIssue(res, repo, issue);
      return true;
    }
    if (method === 'PATCH') {
      // Clear the cached body first: the label check below can 422 after the state/title/body
      // assignments, and a stale cache must never outlive a partial mutation.
      invalidateIssueJson(issue);
      const state = bodyString(jsonBody, 'state');
      if (state === 'open' || state === 'closed') {
        issue.state = state;
        issue.closedAt = state === 'closed' ? nextTimestampIso() : null;
      }
      const title = bodyString(jsonBody, 'title');
      if (title !== undefined) issue.title = title;
      const body = bodyString(jsonBody, 'body');
      if (body !== undefined) issue.body = body;
      if (Array.isArray(jsonBody.labels)) {
        const labels = jsonBody.labels.filter((label): label is string => typeof label === 'string');
        for (const name of labels) {
          if (!repo.labels.has(name)) {
            sendError(res, 422, `Label "${name}" does not exist`);
            return true;
          }
        }
        issue.labels = labels;
      }
      issue.updatedAt = nextTimestampIso();
      sendFreshIssue(res, 200, repo, issue);
      return true;
    }
    sendError(res, 404, 'Not Found');
    return true;
  }

  if (tail[1] === 'comments') {
    if (method === 'POST') {
      const body = bodyString(jsonBody, 'body');
      if (body === undefined) {
        sendError(res, 422, 'body is required');
        return true;
      }
      const now = nextTimestampIso();
      const comment = { id: repo.nextCommentId++, body, userLogin: repo.owner, createdAt: now, updatedAt: now };
      issue.comments.push(comment);
      invalidateIssueJson(issue); // the comments count in the cached body just changed
      sendJson(res, 201, commentJson(repo, issue, comment));
      return true;
    }
    if (method === 'GET') {
      sendJson(res, 200, issue.comments.map((comment) => commentJson(repo, issue, comment)));
      return true;
    }
  }

  sendError(res, 404, 'Not Found');
  return true;
}

function handlePullRoute(
  req: ForgeRequest,
  res: ForgeResponse,
  url: RequestUrl,
  repo: Repo,
  tail: string[],
  method: string,
  jsonBody: Record<string, unknown>,
): boolean {
  if (tail.length === 0) {
    if (method === 'POST') {
      const title = bodyString(jsonBody, 'title');
      const head = bodyString(jsonBody, 'head');
      const base = bodyString(jsonBody, 'base');
      if (title === undefined || title === '' || head === undefined || head === '' || base === undefined || base === '') {
        sendError(res, 422, 'title, head and base are required');
        return true;
      }
      const body = bodyString(jsonBody, 'body') ?? '';
      const created = createPullObject(repo, { title, body, head, base });
      if ('error' in created) {
        sendError(res, created.status, created.error);
        return true;
      }
      sendJson(res, 201, pullJson(repo, created.pull));
      return true;
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
      pulls.sort((a, b) => b.number - a.number);
      sendPage(req, res, url, pulls.map((pull) => pullJson(repo, pull)));
      return true;
    }
    sendError(res, 404, 'Not Found');
    return true;
  }

  const number = Number.parseInt(tail[0]!, 10);
  if (!Number.isInteger(number) || number < 1) {
    sendError(res, 404, 'Not Found');
    return true;
  }
  const pull = repo.pulls.get(number);
  if (!pull) {
    sendError(res, 404, 'Not Found');
    return true;
  }

  if (tail.length === 1 && method === 'GET') {
    sendJson(res, 200, pullJson(repo, pull));
    return true;
  }

  if (tail[1] === 'files' && method === 'GET') {
    const baseTip = branchTip(repo, pull.baseRef) ?? null;
    const headTip = branchTip(repo, pull.headRef) ?? null;
    const files = diffCommits(repo, baseTip, headTip);
    sendJson(res, 200, files);
    return true;
  }

  if (tail[1] === 'merge' && method === 'PUT') {
    const merged = mergePullObject(repo, pull);
    if ('error' in merged) {
      sendError(res, merged.status, merged.error);
      return true;
    }
    sendJson(res, 200, { merged: true, sha: merged.sha, message: `Pull Request #${pull.number} merged` });
    return true;
  }

  sendError(res, 404, 'Not Found');
  return true;
}
