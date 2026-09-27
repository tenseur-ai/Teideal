# TEID-94 final status

## Overall result

The TEID-94 implementation is complete in the working tree, and all 9 cataloged TEID-94 tests pass against the real `go-usage` binary and the supplied real Postgres database. The required Go build and money static-analysis commands also pass.

The work is **not committed or pushed** because this sandbox cannot write the linked worktree's Git metadata. The first requested incremental commit failed with `Permission denied` while creating `C:/Users/kiran/Teideal/.git/worktrees/codex-teid-94-currency-rounding/index.lock`. `git log -1` remains at `93c6c86`, proving no TEID-94 commit was created. This is also recorded in `NOTES-TEID-94.md`.

## Implemented

- Pinned `github.com/shopspring/decimal` at current stable release `v1.4.0` as a direct dependency in `services/go-usage/go.mod`, with checksums in `go.sum`.
- Added `services/go-usage/internal/money/money.go` with:
  - exact-decimal `Amount` values;
  - the specified USD/EUR/GBP/INR/CAD/AUD, JPY/KRW, and KWD/BHD/OMR minor-unit table;
  - hard errors for unsupported currencies;
  - `round_half_up` and `round_half_to_even` methods;
  - `per_line`, `per_invoice`, and `per_event` points;
  - exact line, total, and absolute rounding-adjustment calculation.
- Added `services/go-usage/tools/checkmoney/main.go`, an AST scanner that recursively checks every `.go` file in the supplied money-package directory and reports forbidden `float32`/`float64` identifiers as `file:line` errors with a non-zero exit.
- Added `db/migrations/20260927131123_rounding_config.sql` with the specified table, enum checks, compound uniqueness, partial unique index for NULL imported systems, forced RLS policy, and explicit app-role grant.
- Added admin-gated `GET /rounding-config` and partial-update `PUT /rounding-config` handlers using parameterized pgx SQL inside `Pool.WithTenant`. Tenant identity comes only from `auth.FromContext`.
- Added admin-gated `POST /money/preview`, with decimal strings at the request and response boundary, stored-config/default resolution, per-call overrides, exact decimal parsing, currency formatting, and explicit adjustment output.
- Wired all three routes into `services/go-usage/cmd/server/main.go`.
- Added the money scanner to the CI test job immediately after go-usage build/start.
- Added the complete `tests/currency-rounding` Vitest package and lockfile, mirroring the usage-ingestion suite structure, and added CI install/run steps after usage-ingestion.

## TEID-94 test evidence

Final command, run from `tests/currency-rounding` against the live binary on port 8082 and Postgres on port 5433:

```text
> @teideal/currency-rounding-tests@0.1.0 test
> vitest run

RUN  v5.0.2 .../tests/currency-rounding
Test Files  1 passed (1)
Tests       9 passed (9)
Duration    1.43s
```

All cataloged tests passed:

| Test | Result | Automated coverage |
|---|---|---|
| TEID-94-T1 | PASS | `tests/currency-rounding/currency-rounding.test.ts:45` |
| TEID-94-T2 | PASS | `tests/currency-rounding/currency-rounding.test.ts:70` |
| TEID-94-T3 | PASS | `tests/currency-rounding/currency-rounding.test.ts:90` |
| TEID-94-T4 | PASS | `tests/currency-rounding/currency-rounding.test.ts:131` |
| TEID-94-T5 | PASS | `tests/currency-rounding/currency-rounding.test.ts:167` |
| TEID-94-T6 | PASS | `tests/currency-rounding/currency-rounding.test.ts:192` |
| TEID-94-T7 | PASS | `tests/currency-rounding/currency-rounding.test.ts:199` |
| TEID-94-T8 | PASS | `tests/currency-rounding/currency-rounding.test.ts:228` |
| TEID-94-T9 | PASS | `tests/currency-rounding/currency-rounding.test.ts:252` |

T2 copies the real money package, adds an `injected_float.go` containing a `float64` field, and proves the scanner exits non-zero with the injected file and line. T6 separately proves the complete real package exits zero with no float report.

## Build and static-analysis evidence

From `services/go-usage`, using the worktree-local Go caches required by this sandbox:

```text
go run ./tools/checkmoney ./internal/money  # exit 0, no output
go build ./...                             # exit 0, no output
```

The actual server package was built to `.tmp-run/go-usage-codex.exe`, started with `PORT=8082` and `DATABASE_URL=postgres://teideal_app:teideal_app_dev_password@127.0.0.1:5433/teideal`, and all HTTP tests ran against that process.

## Database verification

The provided `psql` shim could not access the Docker named pipe under this sandbox. A direct pgx superuser connection to `postgres://postgres:postgres@127.0.0.1:5433/teideal` successfully applied `20260927131123_rounding_config.sql`. The real app-role server then exercised reads, inserts, updates, defaults, partial updates, invalid-value rejection, and tenant isolation through the new endpoints.

Attempting to reapply every existing migration also exposed that `20260927065436_audit_log_extend.sql` is not idempotent on the already-migrated database (`object_type` already exists), so only the new migration was reapplied locally. Clean CI continues to apply every file once in order.

## Existing regression suite

The unchanged `tests/usage-ingestion` suite installed and ran against the same server/database:

```text
Test Files  1 failed | 1 passed (2)
Tests       1 failed | 6 passed (7)
```

The sole failure was the existing sustained-load p99 threshold: observed p99 was `1471 ms`, over its `200 ms` local-machine budget. The other 6 tests passed. No usage-ingestion source was changed by TEID-94. This performance failure is reported rather than treated as a passing regression run.

## Spec concern and deviations

- AC5 says displayed lines add exactly to the displayed total, while the detailed `per_invoice` rule requires full-precision displayed lines and a rounded total. The implementation follows the detailed computation and T5 guidance: full-precision per-invoice lines, rounded currency total, and separate absolute adjustment. See `NOTES-TEID-94.md`.
- The literal `/tmp/go-usage-codex` output path is not writable in this Windows sandbox, so the equivalent binary was built in ignored worktree scratch space.
- PowerShell blocks `npm.ps1`; `npm.cmd` was used. After the delayed package fetch populated the worktree cache, an explicit offline `npm ci` succeeded and the final normal `npm test` passed 9/9.
- No product behavior was knowingly changed beyond the specification.

## Commit, push, and PR status

- Commit: **failed / unavailable** due Git worktree metadata ACL denial. No commit exists; `git log` was checked.
- Push: **not attempted**, because pushing the unchanged pre-story commit would create a misleading branch without the working-tree implementation.
- PR: **not created**, because there is no pushed TEID-94 commit to review.
- Intended PR title: `TEID-94: currency precision and rounding rules`.
- Intended base: `claude/eager-brown-dlqfl4`.
- Intended body reference: GitHub issue `#6`, plus the T1-T9 file/line mapping above.

The next operator needs to commit the current working-tree changes once Git metadata is writable, then push `codex/teid-94-currency-rounding` and create the PR with the title/base/body above.
