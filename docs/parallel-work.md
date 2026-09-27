# Working in parallel on this backlog

This backlog's rule is "build in `order` sequence, don't jump ahead" --
written for one contributor. With more than one contributor (human or
AI) working at once, that becomes: **strict order within each track,
tracks chosen so they don't touch the same files.**

## Current tracks

| Track | Owner | Epic | Files | Order range in this track |
|---|---|---|---|---|
| Security/console | Claude | E05 -- tenant isolation, access control, data ownership | `services/ts-console`, `tests/console-auth`, `tests/cross-tenant` | TEID-41 (done), TEID-91 (done), TEID-42, TEID-92, TEID-43, TEID-44 |
| Usage/ledger | Codex | E03 -- usage ingestion and exactly-once ledger | `services/go-usage`, a new `tests/ledger`-style directory | TEID-30, TEID-94, TEID-95, TEID-96, TEID-31, TEID-32, TEID-33, TEID-35, TEID-34, TEID-97, TEID-36 |

Each track still means what the backlog's rule always meant: pull the
story's exact `ac[]`/`tests[]` from the live board, build it, prove every
test, then move to the next story *in that track*, in its own order. A
track may be ahead of another in global `order` -- that's expected and
fine; it must never skip within itself.

## Shared resources and how to avoid stepping on them

- **Branches.** Each contributor works on its own branch, never pushes to
  the other's. Both merge into `main` via PRs; conflicts get resolved at
  merge time, not avoided in advance.
- **`db/migrations/`.** Filenames are timestamp-prefixed
  (`YYYYMMDDHHMMSS_description.sql`), not sequentially numbered --
  generate the prefix with `date -u +%Y%m%d%H%M%S` when adding one. This
  is what stops two tracks adding a migration at the same time from
  colliding on the same filename. `db/setup-local.sh` applies every file
  in the directory in sorted (chronological) order, so this is the only
  rule that matters for migrations: never reuse another migration's
  timestamp, and never edit a migration another track already committed
  -- add a new one instead, even to fix something.
- **`.github/workflows/ci.yml`.** Both tracks will append steps here
  occasionally (a new service to build, a new suite to run). Small file,
  expect the occasional manual merge conflict -- that's normal, not a
  sign something went wrong.
- **The live tracking board (`index.html`'s embedded `DATA`/state, and
  the published claude.ai artifact).** Claude owns syncing this for both
  tracks -- Codex has no publish access to the artifact side of it
  anyway. A track doesn't need to touch `index.html` itself; note which
  TEID keys you completed in your commit messages or PR description, and
  Claude reflects them.
- **Tables one track's migration adds that another track's code will
  later read or extend** (there aren't many today, but e.g. `usage_events`
  from TEID-41 is what TEID-30/31/32 will extend) -- if you're about to
  substantially change a table another track depends on, say so in the
  PR description rather than silently reshaping it.
