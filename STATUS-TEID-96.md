# TEID-96 final implementation status

Date: 2026-09-27  
Branch/worktree: `codex/teid-96-billing-periods`

## Implementation completed

- Added `services/go-usage/internal/period/period.go` with
  `Boundaries(tz, anchorDay, instant)`. It:
  - resolves named IANA locations with `time.LoadLocation`;
  - calculates the containing monthly `[start, end)` interval in customer-local
    calendar time;
  - treats an instant exactly on a boundary as part of the new period;
  - computes each target month's actual day count before constructing an
    anchor, independently clamping days 29-31 without relying on
    `time.Date`'s day rollover;
  - returns both boundaries as UTC instants.
- Added the mandatory blank import `_ "time/tzdata"` to the server binary.
- Added migration
  `db/migrations/20260927153353_customer_billing_config.sql` exactly in the
  specified RLS/policy/grant shape.
- Extended single and batch `POST /usage` ingestion with optional
  `occurred_at` support. Present values must be RFC3339/RFC3339Nano strings
  with `Z` or an explicit offset and are inserted explicitly. Omission still
  uses the existing database default. Existing `decimal.Decimal` quantity
  parsing, validation, PostgreSQL NUMERIC conversion, and response behavior
  remain intact.
- Added admin-gated `GET` and `PUT
  /customers/{id}/billing-config`. GET supplies the effective UTC/anchor-1
  default when no row exists; PUT validates the IANA zone and 1..31 anchor and
  upserts within `Pool.WithTenant`.
- Added admin-gated `POST /period/resolve`, including explicit-offset instant
  validation, stored/default customer config lookup, UTC period boundaries,
  and an explicit `in_new_period_as_of_boundary: true` declaration of the
  inclusive-start/exclusive-end rule.
- Wired all three new routes into `cmd/server/main.go`.
- Added focused Go tests for exact-boundary inclusion, independent month-end
  clamping, DST-specific offsets, invalid input, and the Go 1.25 New York
  fall-back tie-break (first repeated occurrence, EDT/UTC-4, `05:30Z`).
- Added `tests/billing-periods/` with the same package/config/helper layout as
  `tests/currency-rounding/`, a checked-in lockfile, all cataloged scenarios,
  explicit-offset rejection checks for both single and batch ingestion, and a
  CI structure assertion.
- Added billing-period dependency-install and execution steps immediately
  after the existing large-quantities steps in `.github/workflows/ci.yml`.

## Cataloged test results

The final live run used the built go-usage binary on port 8082 and PostgreSQL
at `127.0.0.1:5433`. Vitest reported `1 passed` file and `11 passed (11)` test
cases. There are 11 cases because TEID-96-T5 is deliberately four separate
named tests as required by TEID-96-T6.

| Catalog ID | Automated coverage | Final result |
|---|---|---|
| TEID-96-T1 | Explicit `2026-03-10T02:30:00-05:00` ingestion, response and GET comparison to `07:30Z`; offset-less single and batch rejection | PASS |
| TEID-96-T2 | New York November interval starts `2026-11-01T04:00Z` and ends `2026-12-01T05:00Z` | PASS |
| TEID-96-T3 | Exact April 1 New York midnight resolves with that instant as `period_start`; documented boolean is true | PASS |
| TEID-96-T4 | Anchor 31 clamps independently to Feb 28, Apr 30, and leap-year Feb 29 boundaries | PASS |
| TEID-96-T5 | Four individually named cases: spring gap, fall overlap, Dec 31/Jan 1, Feb 29 | PASS (4/4) |
| TEID-96-T6 | Static assertion verifies exactly four individually named T5 cases and CI steps after TEID-95 | PASS |
| TEID-96-T7 | The selected first repeated-hour instant resolves identically across two calls | PASS |
| TEID-96-T8 | Two 1 ms-apart batch submissions sharing a key produce `created` then `duplicate`; one first timestamp remains and resolves to one period | PASS |

Test source map for the eventual PR description:

- TEID-96-T1: `tests/billing-periods/billing-periods.test.ts:37`
- TEID-96-T2: `tests/billing-periods/billing-periods.test.ts:95`
- TEID-96-T3: `tests/billing-periods/billing-periods.test.ts:118`
- TEID-96-T4: `tests/billing-periods/billing-periods.test.ts:128`
- TEID-96-T5: `tests/billing-periods/billing-periods.test.ts:146`, `:155`,
  `:164`, and `:173`
- TEID-96-T6: `tests/billing-periods/billing-periods.test.ts:182`
- TEID-96-T7: `tests/billing-periods/billing-periods.test.ts:206`
- TEID-96-T8: `tests/billing-periods/billing-periods.test.ts:219`

Final TEID-96 output summary:

```text
Test Files  1 passed (1)
Tests       11 passed (11)
Duration    1.65s
```

## Regression and build verification

All requested unchanged suites ran against the same modified binary:

| Suite | Actual result |
|---|---|
| `tests/usage-ingestion` | 2 files passed; 7/7 tests passed; 15.81s |
| `tests/currency-rounding` | 1 file passed; 9/9 tests passed; 7.36s |
| `tests/large-quantities` | 1 file passed; 7/7 tests passed; 1.02s |

Additional final checks:

- `go test ./...`: PASS, including `internal/api`, `internal/money`, and the
  new `internal/period` tests.
- `go build ./...`: PASS with no output/errors.
- `npm exec tsc -- --noEmit` in `tests/billing-periods`: PASS with no
  output/errors.
- `git diff --check`: PASS.
- The exact requested Windows build command produced
  `.tmp-run/go-usage-codex`. Windows cannot execute a PE file without an
  `.exe` suffix, so an identical `.tmp-run/go-usage-codex.exe` build was used
  for the live server verification.

## Database setup and deviations

- The task-provided database was already migrated/seeded. The requested full
  `db/setup-local.sh` re-application was attempted, but the provided `psql`
  shim invoked Docker and the sandbox denied access to Docker's named pipe.
- The new migration was therefore applied over the supplied direct superuser
  TCP URL with pgx and verified to create `customer_billing_config`; all API
  and regression suites then passed against that database.
- The substantive specification inconsistencies and the chosen strict
  architecture interpretation are documented in `NOTES-TEID-96.md`. Most
  importantly, the implementation follows the architecture's explicit
  clamped-anchor-at-local-midnight algorithm, and it uses actual IANA data for
  New York's Nov 1 midnight (`04:00Z`) and Dec 1 midnight (`05:00Z`).
- No production behavior beyond the story scope was added.

## Commit, push, and PR status

The single required commit attempt failed exactly as the platform warning
predicted:

```text
fatal: Unable to create
'C:/Users/kiran/Teideal/.git/worktrees/codex-teid-96-billing-periods/index.lock':
Permission denied
```

No retry was made. The finished changes remain uncommitted in this working
tree. A push and PR were not possible without a commit and were not attempted;
the architect can commit, push, and open the PR separately as planned.
