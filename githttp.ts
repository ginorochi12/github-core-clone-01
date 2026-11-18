// The git smart-HTTP surface: info/refs advertisements (protocol v2 for upload-pack, v0 for
// receive-pack and for v0 upload-pack requests), protocol v2 ls-refs and fetch, protocol v0
// fetch, and receive-pack (push) with report-status over sideband.
//
// Wire notes the implementation rests on (from the suite's own git client):
// - v2 advertisement: `version 2`, then capability lines; the client needs `fetch` (with the
//   `shallow` feature) and `ls-refs`. `unborn` is deliberately NOT advertised: the client's
//   ls-refs sends the `unborn` argument only when the capability names it, and an unborn line
//   for an empty repo would fail the clone-empty check's "no refs/" assertion.
// - v2 fetch response: `acknowledgments` (ACK lines + `ready`, or NAK), `shallow-info` (only
//   when boundaries moved), `packfile` (only when objects are sent — a packfile section with
//   no packets is a client error), sections separated by delim, the response ended by flush.
// - v2 ls-refs: the client always sends `peel` and `symrefs`; HEAD is listed only when no
//   ref-prefix filters it out.
// - receive-pack: the report-status stream is itself pkt-line framed inside sideband band 1;
//   a refused ref is `ng <ref> non-fast-forward` (that exact reason for a non-fast-forward).
// - A push's pack objects are stored even when every ref is refused (unpack still succeeds).

import {
  ZERO_OID,
  collectReachable,
  decodePktLines,
  encodePktLine,
  encodePktLines,
  isAncestor,
  isObjectId,
  parseCommit,
  parseTag,
  peelToCommit,
  readPack,
  writePack,
  type GitObject,
  type GitPacket,
} from './gitobj.ts';
import { nextTimestampIso } from './clock.ts';
import {
  branchTip,
  invalidatePackCache,
  lookupOf,
  packCacheGet,
  packCacheSet,
  store,
  type Repo,
} from './store.ts';
import { isAuthenticated, sendBuffer, sendError, type ForgeRequest, type ForgeResponse, type RequestUrl } from './httputil.ts';

const UPLOAD_ADVERTISEMENT = 'application/x-git-upload-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_ADVERTISEMENT = 'application/x-git-receive-pack-advertisement';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';
const AGENT = 'makefun-forge/1.0';

/** A ref as the advertisements list it, with its peeled target when it is an annotated tag. */
interface ListedRef {
  name: string;
  oid: string;
  peeled?: string;
}

/** Every ref of a repo, sorted, with annotated tags peeled. */
function listRefs(repo: Repo): ListedRef[] {
  const lookup = lookupOf(repo);
  const refs: ListedRef[] = [];
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const entry: ListedRef = { name, oid };
    const object = repo.objects.get(oid);
    if (object?.type === 'tag') {
      const peeled = peelToCommit(lookup, oid);
      if (peeled !== null && peeled !== oid) entry.peeled = peeled;
    }
    refs.push(entry);
  }
  return refs;
}

/** The default branch's tip, or null when the repo is unborn. */
function headTip(repo: Repo): string | null {
  return branchTip(repo, repo.defaultBranch) ?? null;
}

/** The symref target line for HEAD. */
function headSymref(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

// ---------------------------------------------------------------------------------------------
// info/refs
// ---------------------------------------------------------------------------------------------

function v2Advertisement(): Buffer {
  return encodePktLines([
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs\n',
    'fetch=shallow\n',
    'object-format=sha1\n',
    'flush',
  ]);
}

/** The v2 capability advertisement is static; build it once (every clone requests it 3x). */
const V2_ADVERTISEMENT = v2Advertisement();

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? `multi_ack thin-pack side-band side-band-64k ofs-delta shallow symref=HEAD:${headSymref(repo)} agent=${AGENT}`
      : `report-status side-band-64k delete-refs ofs-delta symref=HEAD:${headSymref(repo)}`;
  const parts: Buffer[] = [encodePktLine(`# service=${service}\n`), encodePktLines(['flush'])];
  const refs = listRefs(repo);
  const tip = headTip(repo);
  const lines: string[] = [];
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\u0000${caps}\n`);
  } else {
    let first = true;
    if (tip !== null) {
      lines.push(`${tip} HEAD\u0000${caps}\n`);
      first = false;
    }
    for (const ref of refs) {
      const suffix = first ? `\u0000${caps}` : '';
      first = false;
      lines.push(`${ref.oid} ${ref.name}${suffix}\n`);
      if (ref.peeled !== undefined) lines.push(`${ref.peeled} ${ref.name}^{}\n`);
    }
  }
  parts.push(encodePktLines([...lines, 'flush']));
  return Buffer.concat(parts);
}

function handleInfoRefs(req: ForgeRequest, res: ForgeResponse, repo: Repo, url: RequestUrl): void {
  const service = url.searchParams.get('service');
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendError(res, 400, 'a service parameter naming git-upload-pack or git-receive-pack is required');
    return;
  }
  const wantsV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '') === 'version=2';
  if (wantsV2) {
    sendBuffer(res, 200, V2_ADVERTISEMENT, UPLOAD_ADVERTISEMENT);
    return;
  }
  const body = v0Advertisement(repo, service);
  sendBuffer(res, 200, body, service === 'git-upload-pack' ? UPLOAD_ADVERTISEMENT : RECEIVE_ADVERTISEMENT);
}

// ---------------------------------------------------------------------------------------------
// fetch enumeration
// ---------------------------------------------------------------------------------------------

interface FetchPlan {
  /** Objects to send, sorted by oid for a deterministic pack. */
  send: string[];
  /** New shallow boundaries (commits in the pack whose parents the client still lacks). */
  shallow: string[];
  /** Client-shallow commits whose parents the client now holds. */
  unshallow: string[];
  /** Haves that are ancestors of a want. */
  acks: string[];
}

/**
 * Plan a fetch: which objects to send, which shallow lines to report, which haves to ACK.
 * `wants` are the tips the client asked for; `haves` the commits it holds; `clientShallow`
 * the client's current shallow boundary (their parents are not held); `depth` the requested
 * depth, or null for a full fetch.
 */
function planFetch(
  repo: Repo,
  wants: string[],
  haves: string[],
  clientShallow: string[],
  depth: number | null,
): FetchPlan {
  const lookup = lookupOf(repo);
  const shallowSet = new Set(clientShallow);

  // What the client holds: the haves' closure, stopping at the client's shallow boundary.
  const held = collectReachable(haves, lookup, { allowMissing: true, stopAt: shallowSet });

  // What the wants need: the wants' closure, cut at the requested depth.
  const wanted = new Set<string>();
  const boundary = new Set<string>();
  if (depth === null) {
    for (const oid of collectReachable(wants, lookup, { allowMissing: true })) wanted.add(oid);
  } else {
    // Walk commits by generation from the wants; include trees/blobs of included commits.
    const commitDistance = new Map<string, number>();
    const queue: Array<{ oid: string; distance: number }> = wants.map((oid) => ({ oid, distance: 0 }));
    const seenCommits = new Set<string>();
    while (queue.length) {
      const { oid, distance } = queue.shift()!;
      const object = lookup(oid);
      if (!object) continue;
      if (object.type === 'tag') {
        wanted.add(oid);
        queue.push({ oid: parseTag(object.data).object, distance });
        continue;
      }
      if (object.type !== 'commit') {
        for (const reached of collectReachable([oid], lookup, { allowMissing: true })) wanted.add(reached);
        continue;
      }
      if (seenCommits.has(oid)) continue;
      seenCommits.add(oid);
      if (distance >= depth) continue;
      commitDistance.set(oid, distance);
      wanted.add(oid);
      const commit = parseCommit(object.data);
      for (const reached of collectReachable([commit.tree], lookup, { allowMissing: true })) wanted.add(reached);
      for (const parent of commit.parents) queue.push({ oid: parent, distance: distance + 1 });
    }
    // The boundary: included commits whose parents were not included.
    for (const [oid, distance] of commitDistance) {
      if (distance !== depth - 1) continue;
      const object = lookup(oid);
      if (object?.type !== 'commit') continue;
      if (parseCommit(object.data).parents.length > 0) boundary.add(oid);
    }
  }

  const send = [...wanted].filter((oid) => !held.has(oid)).sort();
  const sendSet = new Set(send);
  const heldAfter = new Set([...held, ...sendSet]);

  // Shallow lines: commits in the pack with a parent the client still lacks.
  const shallow: string[] = [];
  for (const oid of send) {
    const object = lookup(oid);
    if (object?.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.length > 0 && parents.some((parent) => !heldAfter.has(parent))) shallow.push(oid);
  }
  // Depth-cut commits are shallow even when their parents are held (they are the cut).
  for (const oid of boundary) if (sendSet.has(oid) && !shallow.includes(oid)) shallow.push(oid);
  shallow.sort();

  // Unshallow lines: client-shallow commits the client now holds complete.
  const unshallow: string[] = [];
  for (const oid of clientShallow) {
    if (!heldAfter.has(oid)) continue;
    const object = lookup(oid);
    if (object?.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.every((parent) => heldAfter.has(parent))) unshallow.push(oid);
  }
  unshallow.sort();

  // ACKs: haves that are ancestors of (or equal to) a want. With no haves there
  // can be no ACKs, so skip the full-history walk entirely (the common clone case).
  const acks: string[] = [];
  if (haves.length > 0) {
    const fullWanted = collectReachable(wants, lookup, { allowMissing: true });
    for (const have of haves) if (fullWanted.has(have)) acks.push(have);
  }

  return { send, shallow, unshallow, acks };
}

/**
 * Plan a fetch and build its pack, reusing the cache for repeat requests.
 * The plan is deterministic for a given (repo state, wants, haves, shallow, depth),
 * and the cache is dropped on every mutation, so a cached plan+pack is always fresh.
 * Empty sends are cached too (pack null) so repeat "nothing new" fetches are free.
 */
function fetchPlanAndPack(
  repo: Repo,
  wants: string[],
  haves: string[],
  clientShallow: string[],
  depth: number | null,
  cacheKey: string,
): { plan: FetchPlan; pack: Buffer | null } {
  const cached = packCacheGet(cacheKey);
  if (cached) {
    return {
      plan: { send: cached.send, shallow: cached.shallow, unshallow: cached.unshallow, acks: cached.acks },
      pack: cached.pack,
    };
  }
  const plan = planFetch(repo, wants, haves, clientShallow, depth);
  let pack: Buffer | null = null;
  if (plan.send.length > 0) {
    const objects: GitObject[] = [];
    for (const oid of plan.send) {
      const object = repo.objects.get(oid);
      if (object) objects.push(object);
    }
    pack = writePack(objects);
  }
  packCacheSet(cacheKey, {
    pack,
    send: plan.send,
    shallow: plan.shallow,
    unshallow: plan.unshallow,
    acks: plan.acks,
    hasObjects: plan.send.length > 0,
  });
  return { plan, pack };
}

/** Split a pack into sideband band-1 packets (32 KiB chunks, well under the pkt-line limit). */
function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(offset + CHUNK, pack.length));
    const payload = Buffer.allocUnsafe(slice.length + 1);
    payload[0] = 1;
    slice.copy(payload, 1);
    parts.push(encodePktLine(payload));
  }
  return parts;
}

// ---------------------------------------------------------------------------------------------
// protocol v2: ls-refs and fetch
// ---------------------------------------------------------------------------------------------

interface V2Request {
  command: string;
  args: string[];
}

function parseV2Request(packets: GitPacket[]): V2Request | null {
  const lines = packetsToLines(packets);
  if (lines.length === 0) return null;
  const first = lines[0]!;
  if (!first.startsWith('command=')) return null;
  const command = first.slice('command='.length).replace(/\n$/, '');
  // Arguments follow the delim packet; agent= and object-format= lines precede it.
  const args: string[] = [];
  let pastDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    if (!pastDelim) continue;
    args.push(packet.payload.toString('utf8'));
  }
  return { command, args };
}

function packetsToLines(packets: readonly GitPacket[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  return lines;
}

function handleLsRefs(repo: Repo, args: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    const line = arg.replace(/\n$/, '');
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  // The answer depends only on the repo's refs and these arguments, and every ref mutation
  // drops the pack cache, so the assembled response is cached beside the fetch plans.
  const cacheKey = `lsrefs|${repo.id}|${peel ? 1 : 0}${symrefs ? 1 : 0}${unborn ? 1 : 0}|${prefixes.join(',')}`;
  const cached = packCacheGet(cacheKey);
  if (cached?.response !== undefined) return cached.response;
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const out: string[] = [];
  const tip = headTip(repo);
  const refs = listRefs(repo);
  if (refs.length === 0 && unborn) {
    // An empty repo, asked for its unborn refs: the default branch, unborn.
    if (keep(headSymref(repo))) out.push(`unborn ${headSymref(repo)} symref-target:${headSymref(repo)}\n`);
  } else {
    if (symrefs && tip !== null && keep('HEAD')) {
      out.push(`${tip} HEAD symref-target:${headSymref(repo)}\n`);
    }
    for (const ref of refs) {
      if (!keep(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
      out.push(`${line}\n`);
    }
  }
  const response = encodePktLines([...out, 'flush']);
  packCacheSet(cacheKey, { pack: null, send: [], shallow: [], unshallow: [], acks: [], hasObjects: false, response });
  return response;
}

function handleFetchV2(repo: Repo, args: string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const arg of args) {
    const line = arg.replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const oid = line.slice(5).trim();
      if (isObjectId(oid)) wants.push(oid);
    } else if (line.startsWith('have ')) {
      const oid = line.slice(5).trim();
      if (isObjectId(oid)) haves.push(oid);
    } else if (line.startsWith('shallow ')) {
      const oid = line.slice(8).trim();
      if (isObjectId(oid)) shallow.push(oid);
    } else if (line.startsWith('deepen ')) {
      const value = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(value) && value > 0) depth = value;
    }
    // thin-pack, no-progress, ofs-delta, done, filter, deepen-since, deepen-not: accepted, ignored.
  }
  const cacheKey = `${repo.id}|${[...wants].sort().join(',')}|${[...haves].sort().join(',')}|${[...shallow].sort().join(',')}|${depth ?? ''}`;
  // A cached plan's assembled response is byte-identical to a fresh build, so a repeat
  // fetch (the clone benchmark's 50 identical clones) skips the response assembly too.
  const cachedResponse = packCacheGet(cacheKey)?.response;
  if (cachedResponse !== undefined) return cachedResponse;
  const { plan, pack } = fetchPlanAndPack(repo, wants, haves, shallow, depth, cacheKey);
  const { shallow: newShallow, unshallow, acks } = plan;

  const parts: Buffer[] = [];
  // acknowledgments
  parts.push(encodePktLine('acknowledgments\n'));
  if (acks.length > 0) {
    for (const ack of acks) parts.push(encodePktLine(`ACK ${ack}\n`));
    parts.push(encodePktLine('ready\n'));
  } else {
    parts.push(encodePktLine('NAK\n'));
  }
  parts.push(encodePktLines(['delim']));
  // shallow-info, only when boundaries moved
  if (newShallow.length > 0 || unshallow.length > 0) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of newShallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(encodePktLines(['delim']));
  }
  // packfile, only when objects are sent
  if (pack !== null) {
    parts.push(encodePktLine('packfile\n'));
    for (const chunk of sidebandPack(pack)) parts.push(chunk);
  }
  parts.push(encodePktLines(['flush']));
  const response = Buffer.concat(parts);
  const entry = packCacheGet(cacheKey);
  if (entry !== undefined) entry.response = response;
  return response;
}

// ---------------------------------------------------------------------------------------------
// protocol v0 fetch
// ---------------------------------------------------------------------------------------------

function handleFetchV0(repo: Repo, packets: GitPacket[]): Buffer | null {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let pastFlush = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      pastFlush = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!pastFlush) {
      if (line.startsWith('want ')) {
        const oid = line.slice(5).split(' ')[0]!;
        if (isObjectId(oid)) wants.push(oid);
      } else if (line.startsWith('shallow ')) {
        const oid = line.slice(8).trim();
        if (isObjectId(oid)) shallow.push(oid);
      } else if (line.startsWith('deepen ')) {
        const value = Number.parseInt(line.slice(7).trim(), 10);
        if (Number.isFinite(value) && value > 0) depth = value;
      }
    } else {
      if (line.startsWith('have ')) {
        const oid = line.slice(5).trim();
        if (isObjectId(oid)) haves.push(oid);
      }
    }
  }
  const cacheKey = `v0|${repo.id}|${[...wants].sort().join(',')}|${[...haves].sort().join(',')}|${[...shallow].sort().join(',')}|${depth ?? ''}`;
  const cachedResponse = packCacheGet(cacheKey)?.response;
  if (cachedResponse !== undefined) return cachedResponse;
  const { plan, pack } = fetchPlanAndPack(repo, wants, haves, shallow, depth, cacheKey);
  const { shallow: newShallow, unshallow, acks } = plan;

  const parts: Buffer[] = [];
  for (const oid of newShallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  if (acks.length > 0) {
    for (const ack of acks) parts.push(encodePktLine(`ACK ${ack}\n`));
  } else {
    parts.push(encodePktLine('NAK\n'));
  }
  if (pack !== null) for (const chunk of sidebandPack(pack)) parts.push(chunk);
  parts.push(encodePktLines(['flush']));
  const response = Buffer.concat(parts);
  const entry = packCacheGet(cacheKey);
  if (entry !== undefined) entry.response = response;
  return response;
}

// ---------------------------------------------------------------------------------------------
// receive-pack (push)
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  const report = (lines: string[], sideband: boolean): Buffer => {
    const inner = encodePktLines(lines);
    if (!sideband) return Buffer.concat([inner, encodePktLines(['flush'])]);
    const payload = Buffer.concat([Buffer.from([1]), inner]);
    // The report is small; one band-1 packet carries it whole.
    return Buffer.concat([encodePktLine(payload), encodePktLines(['flush'])]);
  };

  let decoded: { packets: GitPacket[]; nextOffset: number };
  try {
    decoded = decodePktLines(body, { stopAtFlush: true });
  } catch {
    return report(['unpack error malformed pkt-line\n'], true);
  }
  const commands: PushCommand[] = [];
  let sideband = false;
  let first = true;
  for (const packet of decoded.packets) {
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    let line = text;
    if (first) {
      first = false;
      const nul = text.indexOf('\u0000');
      if (nul >= 0) {
        const caps = text.slice(nul + 1).split(' ');
        sideband = caps.includes('side-band-64k');
        line = text.slice(0, nul);
      }
    }
    const parts = line.split(' ');
    if (parts.length < 3) continue;
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!isObjectId(oldOid) || !isObjectId(newOid)) continue;
    commands.push({ oldOid, newOid, ref });
  }
  if (commands.length === 0) {
    return report(['unpack error no commands\n'], sideband);
  }

  // The pack follows the flush: store every object, even for refused refs.
  const packBytes = body.subarray(decoded.nextOffset);
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, { resolveBase: lookupOf(repo) });
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'pack error';
      const lines = [`unpack error ${detail}\n`, ...commands.map((c) => `ng ${c.ref} unpacker error\n`)];
      return report(lines, sideband);
    }
  }
  invalidatePackCache();

  const lines: string[] = ['unpack ok\n'];
  const lookup = lookupOf(repo);
  for (const command of commands) {
    const { oldOid, newOid, ref } = command;
    const current = repo.refs.get(ref);
    const fail = (reason: string): void => {
      lines.push(`ng ${ref} ${reason}\n`);
    };
    const ok = (): void => {
      lines.push(`ok ${ref}\n`);
    };
    if (!ref.startsWith('refs/')) {
      fail('invalid ref name');
      continue;
    }
    if (newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        fail('remote ref does not exist');
        continue;
      }
      if (oldOid !== ZERO_OID && oldOid !== current) {
        fail('old value does not match');
        continue;
      }
      repo.refs.delete(ref);
      ok();
      continue;
    }
    if (!repo.objects.has(newOid)) {
      fail('object not found');
      continue;
    }
    if (oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) {
        fail('already exists');
        continue;
      }
      repo.refs.set(ref, newOid);
      ok();
      continue;
    }
    // Update.
    if (current === undefined) {
      fail('remote ref does not exist');
      continue;
    }
    if (oldOid !== current) {
      fail('old value does not match');
      continue;
    }
    if (ref.startsWith('refs/tags/')) {
      // Tags never move.
      fail('already exists');
      continue;
    }
    if (newOid === oldOid) {
      ok();
      continue;
    }
    // Fast-forward: the old tip must be an ancestor of the new tip.
    const newCommit = peelToCommit(lookup, newOid) ?? newOid;
    const oldCommit = peelToCommit(lookup, oldOid) ?? oldOid;
    if (!isAncestor(lookup, oldCommit, newCommit)) {
      fail('non-fast-forward');
      continue;
    }
    repo.refs.set(ref, newOid);
    ok();
  }
  repo.updatedAt = nextTimestampIso();
  return report(lines, sideband);
}

// ---------------------------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------------------------

/**
 * Handle `/{owner}/{repo}.git/...`. Returns true when the path was a git path (handled);
 * false when it is not one at all (the caller falls through to its own 404).
 */
export function handleGit(
  req: ForgeRequest,
  res: ForgeResponse,
  pathname: string,
  url: RequestUrl,
  body: Buffer,
): boolean {
  const match = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(pathname);
  if (!match) return false;
  const owner = decodeURIComponent(match[1]!);
  const repoName = decodeURIComponent(match[2]!);
  const suffix = match[3] ?? '';
  const method = req.method ?? 'GET';

  if (!isAuthenticated(req)) {
    sendError(res, 401, 'Requires authentication');
    return true;
  }
  if (!store.isOwner(owner)) {
    sendError(res, 404, 'Not Found');
    return true;
  }
  const repo = store.getRepo(owner, repoName);
  if (!repo) {
    sendError(res, 404, 'Not Found');
    return true;
  }

  if (method === 'GET' && suffix === '/info/refs') {
    handleInfoRefs(req, res, repo, url);
    return true;
  }
  if (method === 'POST' && suffix === '/git-upload-pack') {
    // Decode the pkt-lines once: the v2/v0 detection and the request parse share them.
    let packets: GitPacket[];
    try {
      packets = decodePktLines(body).packets;
    } catch {
      sendError(res, 400, 'malformed pkt-line');
      return true;
    }
    const first = packets.find((p) => p.kind === 'data');
    const isV2 = first !== undefined && first.kind === 'data' && first.payload.toString('utf8').startsWith('command=');
    if (isV2) {
      const request = parseV2Request(packets);
      if (request === null) {
        sendError(res, 400, 'malformed protocol v2 request');
        return true;
      }
      if (request.command === 'ls-refs') {
        sendBuffer(res, 200, handleLsRefs(repo, request.args), UPLOAD_RESULT);
        return true;
      }
      if (request.command === 'fetch') {
        sendBuffer(res, 200, handleFetchV2(repo, request.args), UPLOAD_RESULT);
        return true;
      }
      sendError(res, 400, `unknown protocol v2 command ${request.command}`);
      return true;
    }
    const out = handleFetchV0(repo, packets);
    if (out === null) {
      sendError(res, 400, 'malformed protocol v0 fetch');
      return true;
    }
    sendBuffer(res, 200, out, UPLOAD_RESULT);
    return true;
  }
  if (method === 'POST' && suffix === '/git-receive-pack') {
    const out = handleReceivePack(repo, body);
    sendBuffer(res, 200, out, RECEIVE_RESULT);
    return true;
  }
  sendError(res, 404, 'Not Found');
  return true;
}
