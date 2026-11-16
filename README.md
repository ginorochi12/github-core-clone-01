# makefun-forge — a GitHub-compatible git forge in one Node process

Entry for the make.fun **github-core-clone-01** bounty: a standalone,
GitHub-compatible git forge with no UI, no outside service, no proxy and no
`git` binary. One Node process serves all four surfaces from an in-memory
store:

| Surface | Path | Implementation |
| --- | --- | --- |
| Git smart HTTP (upload-pack v2 + v0, receive-pack v0) | `/{owner}/{repo}.git` | `githttp.ts`, `gitobj.ts` |
| REST v3 | `/api/v3` | `rest.ts` |
| GraphQL v4 | `/api/graphql` | `graphql.ts` |
| MCP (JSON-RPC 2.0, Streamable HTTP) | `/mcp` | `mcp.ts` |

## Run

```sh
node --experimental-strip-types main.ts
```

`main.ts` is the harness lifecycle (kept as supplied): it binds an ephemeral
port, registers it with the env at `$MAKEFUN_ENV_URL`, and polls `/done`
until the trial ends. The server itself is `createApp()` in `app.ts`.

Environment variables read by the server:

- `MAKEFUN_ENV_URL` — the env origin to register with (required by `main.ts`).
- `MAKEFUN_SHOP_TOKEN` — the bearer token that authenticates every request.
  When unset (local runs), any non-empty bearer token is accepted.
- `MAKEFUN_TRIAL_NOW` — the trial clock (RFC 3339 instant or epoch
  milliseconds). All timestamps in responses and commits derive from it plus
  a monotonic counter; the server never reads the wall clock per request.

## Layout

- `main.ts` — lifecycle (bind, register, wait for done). Unchanged starter.
- `app.ts` — the HTTP server and router.
- `store.ts` — the in-memory store: repos, refs, objects, issues, pull
  requests, labels, comments; tree diffs and merge-base conflict detection.
- `gitobj.ts` — git object model: commits, trees, tags, pack read/write
  (OFS/REF delta resolution), pkt-line codec.
- `githttp.ts` — smart HTTP: protocol v2 `ls-refs`/`fetch`, v0 fetch,
  receive-pack with per-ref status reporting.
- `rest.ts` — REST v3: repos, branches, commits, contents, labels, issues,
  pull requests, merges.
- `graphql.ts` — a hand-rolled GraphQL parser and executor (variables,
  aliases, inline fragments, batching, `__type` introspection).
- `mcp.ts` — MCP: `server/discover` (2026-07-28 era), the legacy
  `initialize` handshake, and six tools (`create_repo`, `get_repo`,
  `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`).
- `clock.ts` — the deterministic trial clock.
- `httputil.ts` — JSON responses, auth, body reading.

## Design notes

- **Token-owner login.** The bearer token is opaque, so the server locks onto
  the first owner login seen in any authenticated request (REST, git,
  GraphQL, MCP) and answers 404/null for any other owner. Before any request
  locks it, the scenario viewer is the fallback.
- **Packs.** The server writes plain (undelted) packs and reads packs with
  OFS and REF deltas. Fetch packs are cached per (repo, want/have/depth)
  key and invalidated on any git mutation.
- **Merges are squash-only**, with merge-base three-way conflict detection.
- **Issue and pull request numbers** share one counter per repo, starting
  at 1, as on GitHub.
- **GraphQL global IDs** are opaque base64 of the kind plus the database id;
  they never equal the plain database id or number.

## License

MIT — see `LICENSE`.
