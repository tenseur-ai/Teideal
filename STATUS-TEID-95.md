# TEID-95 final status

## Outcome

The TEID-95 implementation is present in the working tree. The Go service
builds and its Go tests pass. A real `go-usage` binary was run on port 8082
against the supplied PostgreSQL database, and a temporary live verification
harness exercised all seven cataloged scenarios successfully.

The requested Vitest runs and from-scratch `db/setup-local.sh` run could not be
completed because this sandbox denied npm registry access and denied the
`psql` shim's internal access to Docker. These limitations, and the distinction
between the successful live checks and the unexecuted Vitest suites, are
reported explicitly below.

## Implemented

- Added exact, float-free PostgreSQL `NUMERIC` conversions in
  `services/go-usage/internal/money/pgnumeric.go`, plus round-trip/null unit
  tests.
- Changed all usage request, response, validation, SQL bind, and SQL scan
  quantity paths from binary floating point to `decimal.Decimal` and
  `pgtype.Numeric`.
- Added the explicit one-trillion app limit and error:
  `quantity must not exceed 1000000000000 (one trillion)`.
- Preserved the existing `/usage` raw JSON-number response shape by enabling
  `decimal.MarshalJSONWithoutQuotes`; the reason is documented in
  `NOTES-TEID-95.md` because the spec's statement about the library default is
  incorrect for shopspring/decimal v1.4.0.
- Added tenant-scoped `GET /usage/summary`, with PostgreSQL `NUMERIC` `SUM` and
  a string `total_quantity` response.
- Added admin-gated `POST /money/price`, exact decimal-string multiplication,
  the 12-place unit-price limit, half-up default, and currency-minor-unit
  invoice rounding through the existing `money.Round`.
- Registered both routes in `cmd/server/main.go`.
- Added migration
  `db/migrations/20260927143257_usage_quantity_cap.sql`.
- Added the complete `tests/large-quantities` test package, lockfile, and all
  seven cataloged tests.
- Added CI install/run steps immediately after the currency-rounding suite.
- Audited the existing export code. Neither `exportSources.ts` nor
  `exportFormats.ts` contains `Number(` or `parseFloat(`, and quantity is not
  coerced before CSV/JSON output. Details are in `NOTES-TEID-95.md`.
- Added ignore rules for the repository-local Go/npm caches required by this
  sandbox.

## Cataloged test mapping

All cataloged tests are implemented in
`tests/large-quantities/large-quantities.test.ts`:

| Test ID | Test line |
|---|---:|
| TEID-95-T1 | 44 |
| TEID-95-T2 | 52 |
| TEID-95-T3 | 80 |
| TEID-95-T4 | 90 |
| TEID-95-T5 | 100 |
| TEID-95-T6 | 128 |
| TEID-95-T7 | 154 |

## Verification actually completed

### Go verification

After the prescribed shared Go cache returned access-denied errors, the single
retry used the worktree-local `.gocache-teid95` cache and the supplied
pre-warmed module cache.

The following all exited 0:

- `go test ./...`
  - `internal/api`: `ok` in 0.727s
  - `internal/money`: `ok` in 0.583s
  - all remaining packages compiled successfully and reported no test files
- `go build ./...`
- `go run ./tools/checkmoney ./internal/money`
  - exited 0 with no output, confirming zero `float32`/`float64` identifiers
    in the complete money package after adding `pgnumeric.go`
- `git diff --check`
  - clean except for Git's existing LF-to-CRLF working-copy warnings

The exact requested binary build also exited 0:

```text
go build -o .tmp-run/go-usage-codex ./cmd/server
```

Windows would not execute the suffixless PE file, so the same source was also
built as `.tmp-run/go-usage-codex.exe`. That binary started successfully with
the supplied app-role database URL on port 8082, and `/healthz` returned
`{"status":"ok"}`.

### Migration/database verification

The requested command

```text
CI=true PGPASSWORD=postgres TEIDEAL_PG_CONTAINER=teideal-postgres-codex95 bash db/setup-local.sh
```

failed because the `psql` shim's `docker exec` could not access
`npipe:////./pipe/docker_engine` in this sandbox. No Docker management was
attempted. The new migration SQL was instead applied to the supplied
superuser URL through a temporary repository-local `pgx` runner. PostgreSQL
then reported the real installed constraint as:

```text
usage_events_quantity_max: CHECK ((quantity <= ('1000000000000'::bigint)::numeric))
```

This verifies the migration itself against the live database, but it is not a
substitute for the requested from-scratch rebuild; that rebuild remains
unverified in this sandbox.

### Live TEID-95 scenario results

A temporary Go harness used real HTTP calls to the running binary and real
PostgreSQL fixtures. It printed:

```text
PASS TEID-95-T1
PASS TEID-95-T2
PASS TEID-95-T3
PASS TEID-95-T4
PASS TEID-95-T5 (9.4174ms)
PASS TEID-95-T6
PASS TEID-95-T7
```

Notable exact values observed:

- T1 line amount: `0.000000000001`
- T2 POST and GET raw JSON quantity: `1000000000000`, with no scientific
  notation
- T3 line/invoice amounts: `4500` and `4500.00`
- T4 line/invoice amounts: `0.0000015` and `0.00`
- T5 event count: `500`; exact total: `499999999999500`; response time:
  `9.4174ms`, below the five-second limit
- T6 status/error: 400 and
  `quantity must not exceed 1000000000000 (one trillion)`; before/after
  summary remained unchanged
- T7 status/error: 400 and
  `unit_price supports at most 12 decimal places`

The temporary harness and its disposable customer/event fixtures were removed
after the run.

### Regression spot checks against the live binary

- A two-item `/usage` batch returned one created event with raw numeric
  quantity `10.5` and one item with the unchanged rejection
  `quantity must be a non-negative number`.
- Existing `/money/preview` returned three full-precision `33.335` lines, a
  `100.01` total, and a `0.005` rounding adjustment.

## Vitest suite status

The new lockfile was validated against its package manifest with an offline
`npm install --package-lock-only`, but the machine had no installed test
dependencies. Both normal npm installation attempts reached the npm registry
and failed with `EACCES`; offline installation reported that the packages were
not cached. Therefore each requested suite launch exited 1 before collecting
tests:

```text
tests/large-quantities:  'vitest' is not recognized
tests/currency-rounding: 'vitest' is not recognized
tests/usage-ingestion:   'vitest' is not recognized
```

Consequently:

- Cataloged Vitest tests actually collected/passed: **0/7** (blocked before
  collection).
- Cataloged scenarios passed through the equivalent live HTTP/database
  harness: **7/7**.
- `tests/currency-rounding` unchanged suite: **not executed**; live rounding
  regression spot check passed.
- `tests/usage-ingestion` unchanged suite: **not executed**; live single/batch,
  exact round-trip, validation, and summary checks passed, but this does not
  replace its sustained-load suite.

This is the principal outstanding verification gap for independent rerun.

## Deviations and documented concerns

- `NOTES-TEID-95.md` records the incorrect decimal JSON-default claim, the
  export audit, the Go/npm cache behavior, and the Docker-backed migration
  shim failure.
- The implementation enables the decimal library's raw-token marshaling mode
  to meet the spec's explicit unchanged-wire-format requirement.
- The migration was applied directly via `pgx` rather than through
  `db/setup-local.sh` because of the sandbox Docker denial.
- A `.exe` copy of the requested suffixless binary was needed only to run it
  on Windows.
- No product code outside the specified service/migration/CI scope was
  modified; the TypeScript console export files were read only.

## Commit, push, and PR status

The first `git add`/`git commit` attempt failed immediately:

```text
fatal: Unable to create
'C:/Users/kiran/Teideal/.git/worktrees/codex-teid-95-large-quantities/index.lock':
Permission denied
```

Per the instruction not to retry this linked-worktree platform limitation, no
further commit attempt was made. The work is uncommitted in the working tree.
Because there is no commit, no push or `gh pr create` was attempted. The PR
title/body still need to be created externally with title
`TEID-95: sub-cent unit prices and very large quantities`, base
`claude/eager-brown-dlqfl4`, a reference to issue #11, and the test mapping
above.
