// The in-memory store: every repository, its git objects and refs, its issues, pull requests,
// labels and comments. One process, no persistence: the trial is a single run and the state
// export holds only pass/fail bits.
//
// Ownership: the bearer token is opaque, so the token owner's login cannot be derived from it.
// The store locks onto the first owner segment any authenticated request names (the suite's git
// checks always name the viewer first); any other owner reads as missing (404 / null). Before
// any owner is observed, the fixed scenario's viewer login answers viewer/user reads.

import { nextTimestampIso, nextTimestampSec } from './clock.ts';
import {
  ZERO_OID,
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  isAncestor,
  isObjectId,
  mergeBase,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
  type GitObject,
  type TreeEntry,
} from './gitobj.ts';

/** The fixed scenario's viewer login (wire.ts SCENARIO_SEED): the fallback before any owner locks. */
export const FALLBACK_VIEWER_LOGIN = 'adaiversen';

export interface Label {
  name: string;
  color: string;
}

export interface IssueComment {
  id: number;
  body: string;
  userLogin: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  userLogin: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  comments: IssueComment[];
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  userLogin: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  /** Creation order, for stable /user/repos pagination. */
  seq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, PullRequest>;
  /** The shared issue/PR number counter (GitHub numbers issues and PRs from one sequence). */
  nextNumber: number;
  nextCommentId: number;
}

class Store {
  readonly repos = new Map<string, Repo>();
  readonly reposById = new Map<number, Repo>();
  private nextRepoId = 1;
  private nextRepoSeq = 1;
  private nextIssueId = 1;
  private nextPullId = 1;
  private lockedOwner: string | null = null;

  /** The owner this token serves: the locked one, or the scenario viewer before any lock. */
  effectiveOwner(): string {
    return this.lockedOwner ?? FALLBACK_VIEWER_LOGIN;
  }

  /**
   * Whether `owner` is this token's owner. Locks onto the first owner seen; any other owner is
   * foreign. Call for every owner segment an authenticated request names.
   */
  isOwner(owner: string): boolean {
    if (this.lockedOwner === null) {
      this.lockedOwner = owner;
      return true;
    }
    return this.lockedOwner === owner;
  }

  /** Whether an owner is already locked (a read that must not lock, e.g. a foreign probe). */
  ownerLocked(): boolean {
    return this.lockedOwner !== null;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  getRepoById(id: number): Repo | undefined {
    return this.reposById.get(id);
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  createRepo(owner: string, name: string, options: { description?: string; private?: boolean }): Repo {
    const now = nextTimestampIso();
    const repo: Repo = {
      id: this.nextRepoId++,
      owner,
      name,
      description: options.description ?? '',
      private: options.private ?? false,
      defaultBranch: 'main',
      createdAt: now,
      updatedAt: now,
      seq: this.nextRepoSeq++,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
    };
    this.repos.set(this.repoKey(owner, name), repo);
    this.reposById.set(repo.id, repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    const repo = this.repos.get(this.repoKey(owner, name));
    if (!repo) return false;
    this.repos.delete(this.repoKey(owner, name));
    this.reposById.delete(repo.id);
    return true;
  }

  nextIssueIdValue(): number {
    return this.nextIssueId++;
  }

  nextPullIdValue(): number {
    return this.nextPullId++;
  }

  /** The identity the entry's own commits carry. */
  commitIdentity(owner: string): string {
    return `${owner} <${owner}@users.noreply.github.com>`;
  }
}

export const store = new Store();

// ---------------------------------------------------------------------------------------------
// git helpers on a repo
// ---------------------------------------------------------------------------------------------

export function lookupOf(repo: Repo): (oid: string) => GitObject | undefined {
  return (oid: string) => repo.objects.get(oid);
}

export function putObject(repo: Repo, type: GitObject['type'], data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function branchRef(branch: string): string {
  return `refs/heads/${branch}`;
}

export function branchTip(repo: Repo, branch: string): string | undefined {
  return repo.refs.get(branchRef(branch));
}

export function listBranches(repo: Repo): Array<{ name: string; sha: string }> {
  const out: Array<{ name: string; sha: string }> = [];
  for (const [ref, sha] of repo.refs) {
    if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), sha });
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

/** Resolve a ref-ish (branch name, full ref, or commit oid) to a commit oid, or null. */
export function resolveRef(repo: Repo, ref: string): string | null {
  if (repo.refs.has(ref)) return repo.refs.get(ref)!;
  const headed = repo.refs.get(branchRef(ref));
  if (headed !== undefined) return headed;
  if (isObjectId(ref) && repo.objects.get(ref)?.type === 'commit') return ref;
  if (isObjectId(ref)) {
    const peeled = peelToCommit(lookupOf(repo), ref);
    return peeled;
  }
  return null;
}

/** The tree of a commit, or null when the commit is missing. */
export function commitTree(repo: Repo, commitOid: string): string | null {
  const object = repo.objects.get(commitOid);
  if (!object || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

/** A commit's parsed view, or null. */
export function commitView(repo: Repo, commitOid: string): ReturnType<typeof parseCommit> | null {
  const object = repo.objects.get(commitOid);
  if (!object || object.type !== 'commit') return null;
  try {
    return parseCommit(object.data);
  } catch {
    return null;
  }
}

/** Walk a commit's ancestors newest-first (pre-order DFS from the tip). */
export function walkCommits(repo: Repo, tip: string, limit = 1000): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length && out.length < limit) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    out.push(oid);
    const parents = parseCommit(object.data).parents;
    for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i]!);
  }
  return out;
}

/**
 * Flatten a tree into path -> {oid, mode}, recursing into subdirectories. `prefix` is the
 * directory path the tree sits at ('' for the root).
 */
export function flattenTree(
  repo: Repo,
  treeOid: string,
  prefix = '',
  out: Map<string, { oid: string; mode: string }> = new Map(),
): Map<string, { oid: string; mode: string }> {
  const object = repo.objects.get(treeOid);
  if (!object || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(repo, entry.oid, path, out);
    else if (entry.mode !== '160000') out.set(path, { oid: entry.oid, mode: entry.mode });
  }
  return out;
}

/** Read one path out of a tree: the blob oid and mode, or null when absent (or a directory). */
export function readTreePath(
  repo: Repo,
  treeOid: string,
  path: string,
): { oid: string; mode: string } | null {
  const segments = path.split('/').filter((segment) => segment !== '');
  let current = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const object = repo.objects.get(current);
    if (!object || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segments[i]);
    if (!entry) return null;
    if (i === segments.length - 1) {
      if (entry.mode === '40000') return null;
      return { oid: entry.oid, mode: entry.mode };
    }
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

/** List one directory of a tree: its entries, or null when the path is not a directory. */
export function listTreeDir(repo: Repo, treeOid: string, path: string): TreeEntry[] | null {
  const segments = path.split('/').filter((segment) => segment !== '');
  let current = treeOid;
  for (const segment of segments) {
    const object = repo.objects.get(current);
    if (!object || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segment);
    if (!entry || entry.mode !== '40000') return null;
    current = entry.oid;
  }
  const object = repo.objects.get(current);
  if (!object || object.type !== 'tree') return null;
  return parseTree(object.data);
}

/**
 * A tree with `path` set to `blobOid` (or removed when `blobOid` is null), every other entry
 * kept. Empty directories left behind by a removal are pruned. Returns the new root tree oid.
 */
export function treeWithPath(
  repo: Repo,
  baseTreeOid: string | null,
  path: string,
  blobOid: string | null,
  mode = '100644',
): string {
  const segments = path.split('/').filter((segment) => segment !== '');
  const build = (treeOid: string | null, depth: number): string | null => {
    const entries: TreeEntry[] = treeOid === null ? [] : parseTree(repo.objects.get(treeOid)?.data ?? Buffer.alloc(0));
    const name = segments[depth]!;
    const kept = entries.filter((entry) => entry.name !== name);
    if (depth === segments.length - 1) {
      if (blobOid !== null) kept.push({ mode, name, oid: blobOid });
    } else {
      const existing = entries.find((entry) => entry.name === name && entry.mode === '40000');
      const child = build(existing?.oid ?? null, depth + 1);
      if (child !== null) kept.push({ mode: '40000', name, oid: child });
    }
    if (kept.length === 0) return null;
    return putObject(repo, 'tree', buildTree(kept));
  };
  return build(baseTreeOid, 0) ?? putObject(repo, 'tree', buildTree([]));
}

/** Build a tree from a flattened path map. */
export function treeFromFlat(repo: Repo, flat: Map<string, { oid: string; mode: string }>): string {
  interface Node {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, value] of flat) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const name = segments[i]!;
      if (!node.dirs.has(name)) node.dirs.set(name, make());
      node = node.dirs.get(name)!;
    }
    node.files.set(segments[segments.length - 1]!, value);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, value] of node.files) entries.push({ mode: value.mode, name, oid: value.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

/**
 * Create a commit on a branch: build the commit object, store it, move the ref. The message is
 * stored with a trailing newline, git's convention. Returns the commit oid.
 */
export function createCommit(
  repo: Repo,
  options: { branch: string; tree: string; parents: string[]; message: string },
): string {
  const identity = store.commitIdentity(repo.owner);
  const message = options.message.endsWith('\n') ? options.message : `${options.message}\n`;
  const data = buildCommit({
    tree: options.tree,
    parents: options.parents,
    message,
    author: identity,
    committer: identity,
    timestamp: nextTimestampSec(),
  });
  const oid = putObject(repo, 'commit', data);
  repo.refs.set(branchRef(options.branch), oid);
  repo.updatedAt = nextTimestampIso();
  invalidatePackCache();
  return oid;
}

// ---------------------------------------------------------------------------------------------
// diff and merge
// ---------------------------------------------------------------------------------------------

export interface FileDiff {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

/** Split text into lines the way a diff counts them (a trailing newline ends the last line). */
function textLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Line counts of a change, via an LCS diff over the two files' lines. */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = textLines(oldText);
  const b = textLines(newText);
  if (a.length === 0) return { additions: b.length, deletions: 0 };
  if (b.length === 0) return { additions: 0, deletions: a.length };
  // LCS lengths, two rows.
  let prev = new Array<number>(b.length + 1).fill(0);
  let curr = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, curr[j - 1]!);
    }
    [prev, curr] = [curr, prev];
  }
  const lcs = prev[b.length]!;
  return { additions: b.length - lcs, deletions: a.length - lcs };
}

function blobText(repo: Repo, oid: string): string {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'blob') return '';
  return object.data.toString('utf8');
}

/** The file diff between two trees (base -> head), sorted by filename. */
export function diffTrees(repo: Repo, baseTree: string | null, headTree: string | null): FileDiff[] {
  const base = baseTree === null ? new Map() : flattenTree(repo, baseTree);
  const head = headTree === null ? new Map() : flattenTree(repo, headTree);
  const paths = new Set([...base.keys(), ...head.keys()]);
  const out: FileDiff[] = [];
  for (const path of paths) {
    const b = base.get(path);
    const h = head.get(path);
    if (b && !h) {
      const deletions = textLines(blobText(repo, b.oid)).length;
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (!b && h) {
      const additions = textLines(blobText(repo, h.oid)).length;
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (b && h && b.oid !== h.oid) {
      const { additions, deletions } = lineDiff(blobText(repo, b.oid), blobText(repo, h.oid));
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  out.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
  return out;
}

/** The file diff between two commits' trees (base tip -> head tip). */
export function diffCommits(repo: Repo, baseCommit: string | null, headCommit: string | null): FileDiff[] {
  const baseTree = baseCommit === null ? null : commitTree(repo, baseCommit);
  const headTree = headCommit === null ? null : commitTree(repo, headCommit);
  return diffTrees(repo, baseTree, headTree);
}

export interface MergeCheck {
  /** 'mergeable' | 'conflicting' | 'unknown' (a tip is missing). */
  status: 'mergeable' | 'conflicting' | 'unknown';
  mergeBase: string | null;
  baseTip: string | null;
  headTip: string | null;
  conflictingPaths: string[];
}

/** The merge-base three-way check for a head branch into a base branch. */
export function checkMerge(repo: Repo, headRef: string, baseRef: string): MergeCheck {
  const headTip = branchTip(repo, headRef) ?? null;
  const baseTip = branchTip(repo, baseRef) ?? null;
  if (headTip === null || baseTip === null) {
    return { status: 'unknown', mergeBase: null, baseTip, headTip, conflictingPaths: [] };
  }
  if (headTip === baseTip) {
    return { status: 'mergeable', mergeBase: headTip, baseTip, headTip, conflictingPaths: [] };
  }
  // A fast-forward (the base is an ancestor of the head) always merges cleanly.
  if (isAncestor(lookupOf(repo), baseTip, headTip)) {
    return { status: 'mergeable', mergeBase: baseTip, baseTip, headTip, conflictingPaths: [] };
  }
  const base = mergeBase(lookupOf(repo), baseTip, headTip);
  if (base === null) {
    // No common history: any path both sides carry with different content conflicts.
    const baseFlat = flattenTree(repo, commitTree(repo, baseTip)!);
    const headFlat = flattenTree(repo, commitTree(repo, headTip)!);
    const conflicting: string[] = [];
    for (const [path, value] of headFlat) {
      const other = baseFlat.get(path);
      if (other && other.oid !== value.oid) conflicting.push(path);
    }
    return {
      status: conflicting.length > 0 ? 'conflicting' : 'mergeable',
      mergeBase: null,
      baseTip,
      headTip,
      conflictingPaths: conflicting,
    };
  }
  const baseFlat = flattenTree(repo, commitTree(repo, base)!);
  const baseTipFlat = flattenTree(repo, commitTree(repo, baseTip)!);
  const headFlat = flattenTree(repo, commitTree(repo, headTip)!);
  const conflicting: string[] = [];
  const paths = new Set([...baseFlat.keys(), ...baseTipFlat.keys(), ...headFlat.keys()]);
  for (const path of paths) {
    const ancestor = baseFlat.get(path)?.oid ?? null;
    const onBase = baseTipFlat.get(path)?.oid ?? null;
    const onHead = headFlat.get(path)?.oid ?? null;
    const baseChanged = onBase !== ancestor;
    const headChanged = onHead !== ancestor;
    if (baseChanged && headChanged && onBase !== onHead) conflicting.push(path);
  }
  return {
    status: conflicting.length > 0 ? 'conflicting' : 'mergeable',
    mergeBase: base,
    baseTip,
    headTip,
    conflictingPaths: conflicting,
  };
}

/**
 * The squash-merged tree: the base tip's tree with every head-side change (vs the merge-base)
 * applied. Only valid when checkMerge says mergeable.
 */
export function squashTree(repo: Repo, check: MergeCheck): string {
  const baseTipFlat = flattenTree(repo, commitTree(repo, check.baseTip!)!);
  const headFlat = flattenTree(repo, commitTree(repo, check.headTip!)!);
  const ancestorFlat =
    check.mergeBase === null ? new Map<string, { oid: string; mode: string }>() : flattenTree(repo, commitTree(repo, check.mergeBase)!);
  const result = new Map(baseTipFlat);
  const paths = new Set([...ancestorFlat.keys(), ...headFlat.keys()]);
  for (const path of paths) {
    const ancestor = ancestorFlat.get(path)?.oid ?? null;
    const onHead = headFlat.get(path);
    if ((onHead?.oid ?? null) === ancestor) continue; // unchanged on the head side
    if (onHead === undefined) result.delete(path);
    else result.set(path, { oid: onHead.oid, mode: onHead.mode });
  }
  return treeFromFlat(repo, result);
}

// ---------------------------------------------------------------------------------------------
// fetch pack cache (the clone benchmark clones one repo 50x concurrently)
// ---------------------------------------------------------------------------------------------

interface PackCacheEntry {
  /** The pack bytes, or null when the plan sends no objects. */
  pack: Buffer | null;
  /** Objects to send, sorted by oid (the cached plan's send list). */
  send: string[];
  shallow: string[];
  unshallow: string[];
  acks: string[];
  hasObjects: boolean;
}

const PACK_CACHE_MAX = 128;
const packCache = new Map<string, PackCacheEntry>();

export function packCacheGet(key: string): PackCacheEntry | undefined {
  const entry = packCache.get(key);
  if (entry) {
    // Refresh recency.
    packCache.delete(key);
    packCache.set(key, entry);
  }
  return entry;
}

export function packCacheSet(key: string, entry: PackCacheEntry): void {
  if (packCache.has(key)) packCache.delete(key);
  packCache.set(key, entry);
  while (packCache.size > PACK_CACHE_MAX) {
    const oldest = packCache.keys().next().value;
    if (oldest === undefined) break;
    packCache.delete(oldest);
  }
}

/** Any mutation of any repo's git state drops the whole pack cache (mutations are rare). */
export function invalidatePackCache(): void {
  packCache.clear();
}

export { ZERO_OID, collectReachable, isAncestor };
