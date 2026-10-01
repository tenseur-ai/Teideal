# TEID-44 implementation notes

## Multi-category file framing

The spec requires exactly one local file per requested format, named
`<export_id>.<format>`, while each exported category has a different set of
columns. It does not define how those schemas are framed inside a single CSV,
JSON Lines, or Parquet file.

The implementation uses an explicit, documented framing:

- CSV contains a `# <category>` marker, that category's header, its rows, and a
  blank line before the next category.
- JSON Lines contains one envelope per row with `category` and `record` fields.
- Parquet contains one row per exported row with `category` and `record_json`
  fields. `record_json` uses exactly the documented category columns.

This preserves the mandated one-file-per-format layout, remains streamable,
and gives consumers an unambiguous category discriminator.

## Failed schedule cadence

The success path explicitly sets `last_run_at`, but the exhausted-retry path
only explicitly mentions `last_run_status` and `consecutive_failures`. Leaving
`last_run_at` null/old would make every worker tick immediately re-run the same
failed daily schedule and send another alert. The implementation records
`last_run_at` for failed runs too, treating the exhausted attempt as that day's
run and preventing an alert storm.

## `@dsnp/parquetjs`: `1.9.3` (then-current stable) is unusable -- resolved by re-pinning to `1.8.8`

At implementation time npm reported `1.9.3` as current stable. That release's
published tarball omits its `dist/` directory entirely even though
`package.json` points `main`/`types` at `dist/parquet.js`/`dist/parquet.d.ts`,
so both Node and TypeScript fail to resolve it -- a broken upstream publish,
not an environment or implementation issue. It also declares Node
`>=24.18.0`, above this repo's CI (Node 22).

Resolved by re-pinning to `1.8.8`: confirmed via `npm pack` that its tarball
ships a complete `dist/`, it declares `engines.node: >=18.18.2` (compatible
with CI's Node 22), and `npm audit` is clean at that version (`1.8.5`-`1.8.7`
carry a high-severity transitive `thrift` advisory that `1.8.8` fixes; `1.8.9`
and `1.9.3` both regress to the `>=24.18.0`/broken-dist state). The exact-pin
requirement from the spec is preserved, just against the newest version that
actually satisfies it. All 8 cataloged tests, including the two
Parquet-touching ones (T1, T7), pass against this version.

## Local environment blockers encountered while implementing, and how they were resolved

- **Git worktree + sandbox**: this checkout is a linked Git worktree whose Git
  directory (`C:/Users/kiran/Teideal/.git/worktrees/codex-teid-44-full-export`)
  sits outside the sandboxed working directory, so the coding agent driving
  this implementation (Codex CLI, run locally as a subprocess) could not
  create `index.lock` there and so could never commit its own work in this
  environment -- a structural limitation of combining `codex exec --sandbox
  workspace-write` with a manually-created `git worktree`, not specific to
  this story. Commits for this story were made by the solution architect
  (Claude) from outside that sandbox instead. See `docs/parallel-work.md`'s
  "Local CLI invocation" section for the general finding.
- **No Postgres reachable / npm cache EACCES**: also sandbox-imposed (writes
  outside the worktree, including the global npm cache and Docker's own
  config/socket access, are blocked under `workspace-write`). Resolved
  from outside the sandbox: a local npm cache redirected into the worktree
  via `.npmrc`, and a real Postgres 16 container started via Docker (outside
  the agent's sandbox) and left running on `127.0.0.1:5432` for both the
  agent's own later test runs and the architect's independent verification
  afterward. This machine has no native `psql` client either; verification
  used `docker exec -i <container> psql` instead of installing one.
- **`tests/audit-log`'s TEID-42-T4 (1.2M-row, 60s budget) intermittently
  missed its threshold** when run concurrently with other heavy local
  processes (parallel `npm install`s, a fresh Postgres container coming up)
  on this Windows machine. Re-run in isolation, post-verification, it passed
  comfortably (7/7, well under budget) -- confirmed as local resource
  contention during the implementation session, not a regression introduced
  by this story's changes.
