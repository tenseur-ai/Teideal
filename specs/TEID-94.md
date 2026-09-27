# TEID-94: Currency precision and rounding rules

| | |
|---|---|
| Epic | TEID-3 (E03 -- Build usage ingestion and exactly-once ledger) |
| Phase | E03 |
| Priority | Highest |
| Points | 5 |
| Release | mvp |
| Order | 13 (within E03; before TEID-95/96/31/32/33/35/34/97/36) |
| Depends on | `usage_events` (TEID-41/TEID-30), `Pool.WithTenant` (`services/go-usage/internal/db/db.go`), `auth.Middleware`/`Principal` (`services/go-usage/internal/auth/auth.go`), `writeJSON`/`writeErr` conventions (`services/go-usage/internal/api/usage.go`) |

## Story (verbatim from the live board)

> As a finance lead, I want clear, configurable rules for how and when amounts are rounded, so that "matched to the cent" means the same thing in Teideal as in our billing system.
>
> *Context*
> Rounding differences are the most common source of false mismatches in verification (TEID-69).

## Acceptance criteria (verbatim from the live board)

1. Each currency uses its official number of decimal places (for example 2 for USD and INR, 0 for JPY, 3 for KWD).
2. All calculations use exact decimal arithmetic; floating-point numbers are never used for money, and an automated check blocks code that does.
3. Rounding happens only at defined points: by default per invoice line, configurable to per invoice or per event.
4. The rounding method is configurable (round half up by default, or round half to even), per tenant and per imported billing system so Verify can match it.
5. The lines of an invoice always add up exactly to the invoice total, and any rounding difference is recorded as its own ledger entry.

## Cataloged tests (verbatim from the live board)

| ID | Type | AC | Title |
|---|---|---|---|
| TEID-94-T1 | Functional | 1 | Generate invoices for the same tenant in USD, JPY, and KWD and confirm amounts render with 2, 0, and 3 decimal places respectively, matching each currency's official minor-unit precision. |
| TEID-94-T2 | Functional | 2 | Run the CI static-analysis rule against a branch that introduces a float-typed monetary field and confirm the build fails; confirm existing money fields all use a fixed-point or decimal type. |
| TEID-94-T3 | Functional | 3 | Configure rounding-point to per-invoice-line for one test tenant and per-invoice-total for another, run the identical 3-line invoice with fractional cents through both, and confirm the two configurations produce the expected differing totals. |
| TEID-94-T4 | Functional | 4 | Set tenant A to round-half-up and tenant B to round-half-to-even, run the same 0.125 USD line item through both, and confirm tenant A produces 0.13 while tenant B produces 0.12. |
| TEID-94-T5 | Functional | 5 | Generate an invoice with 3 line items summing to 100.005 USD and confirm the displayed line amounts add up exactly to the displayed invoice total, with the 0.005 remainder posted as its own rounding-adjustment ledger entry. |
| TEID-94-T6 | Non-functional | 2 | Audit the money-arithmetic module's call sites and confirm 100 percent of monetary calculation paths route through the decimal type, with zero direct float casts flagged by static analysis. |
| TEID-94-T7 | Non-functional | 4 | Confirm a finance operator can change a tenant's rounding method from the tenant settings screen in 3 clicks or fewer, without engineering assistance. |
| TEID-94-T8 | Adversarial | 4 | Attempt to set a rounding method value outside the allowed enum, such as round_down_always, via a direct API call and confirm the request is rejected with a validation error rather than silently applied. |
| TEID-94-T9 | Adversarial | 2 | Configure a unit price using the classic floating-point-imprecise literal equivalent of 0.1 plus 0.2 and confirm the system stores and computes it as the exact decimal 0.30, not a value like 0.30000000000000004. |

## Scoping notes for this point in the build sequence

TEID-94 is deliberately sequenced *before* TEID-33 (computed ledger/balance,
order 18, not started) and before any invoicing or pricing concept exists at
all -- confirmed against the actual codebase: no `invoice`, `ledger`,
`balance`, `price`, `amount`, `rate`, or `currency` column or type exists
anywhere in `services/go-usage` or its migrations today; `usage_events.quantity`
is a raw usage count (Postgres `NUMERIC`, but read into Go as `float64`
throughout `internal/api/usage.go`), not a monetary value. Several ACs and
tests are written in the vocabulary of a system (invoices, a tenant-settings
screen) that TEID-94 is establishing the *primitives* for, not consuming an
already-built one. Decisions made here rather than left for the developer to
guess, following the same substitution discipline TEID-44's spec used for
its own "ledger doesn't exist yet" gap:

- **This story delivers a reusable decimal/money library and a per-tenant
  rounding-configuration surface, both owned entirely within
  `services/go-usage`** (this story's own service, per its epic TEID-3
  and ADR 0001's "Go owns... the exactly-once ledger" -- rounding rules
  for that ledger's future output belong here, not in `services/ts-console`,
  which would cross into a different developer agent's phase and file set
  exactly the way TEID-44's own spec explicitly avoided for `services/ts-console`
  reading `go-usage`'s tables). TEID-33 (when it lands) calls this
  library and its stored config directly instead of reimplementing
  rounding -- the exact "coverage becomes literal rather than substituted"
  outcome the template calls for.
- **"Invoice" and "invoice line" (AC1, AC3, AC5, T94-T1, T94-T3, T94-T5)
  don't exist as a concept yet.** Rather than fabricate a full invoice
  table this story doesn't own the scope to design (that's TEID-33's job),
  this story adds one new endpoint, `POST /money/preview`, whose sole
  purpose is to make the rounding library's real behavior observable and
  testable over HTTP the same black-box way every other story in this
  repo is tested (`tests/usage-ingestion`'s own pattern: real running
  binary, real Postgres, no mocks) -- explicitly a synthetic
  testing/preview surface standing in for the per-invoice-line rounding a
  real invoice-generation flow will call this same library for once
  TEID-33 exists, not a customer-facing product endpoint. It takes a
  currency and a list of line amounts and returns each line's rendered
  amount, the total, and (per AC5) the rounding remainder as its own
  distinct output entry -- the literal shape TEID-33's real ledger-entry
  write will eventually populate from.
- **"The tenant settings screen" (T94-T7) doesn't exist -- no admin
  console UI exists anywhere in this repository** (confirmed: only
  `index.html`, the unrelated backlog board tool). This is the same gap
  TEID-16's spec (E01, written alongside this one) documents for its own
  story, and the same substitution applies: T94-T7's "3 clicks" becomes
  "one API call changing one field" -- `PUT /rounding-config` with only
  `rounding_method` in the body, confirmed to update just that field
  without requiring any other field to be resupplied.
- **`usage_events.quantity`'s existing `float64` handling in
  `internal/api/usage.go` (TEID-30, already shipped and independently
  verified) is not retrofitted by this story.** Quantity is a usage
  count, not a monetary value, so AC2's float-ban doesn't apply to it
  directly, and changing already-shipped, already-tested ingestion code
  without a cataloged AC/test requiring it risks a regression this story
  isn't scoped to catch. What this story *does* require: the new
  `internal/money` package's public functions accept quantities as
  `decimal.Decimal` (converted from Postgres `NUMERIC` without a
  `float64` intermediate), so that when TEID-33 eventually multiplies a
  quantity by a rate, it is structurally forced through the exact-decimal
  path rather than able to silently pass a `float64` quantity in. Revisit
  `usage.go`'s own quantity handling only if a future story's AC requires
  it.
- **No currency field exists on `tenants` or `customers` yet.** This story
  doesn't need one: currency is supplied per-call to `POST /money/preview`
  (T94-T1 exercises USD, JPY, and KWD for the *same* tenant in the same
  test, which only makes sense if currency is a per-call input, not a
  fixed tenant attribute) and per-row on `rounding_configs` is keyed by
  tenant + optional `imported_billing_system`, not by currency at all.

## Architecture and design

### The `internal/money` package (AC1, AC2, T94-T2, T94-T6, T94-T9)

New package `services/go-usage/internal/money/money.go`. Add
`github.com/shopspring/decimal` to `go.mod` (`go get
github.com/shopspring/decimal`, pin the current stable release at
implementation time) -- this repo's `go.mod` currently has no decimal
library and no money-related dependency at all, so this is a new,
explicit addition, the same way TEID-44 added `@dsnp/parquetjs` to
`services/ts-console`'s `package.json`.

```go
type Amount struct {
    Value    decimal.Decimal
    Currency string // ISO 4217, uppercase, e.g. "USD"
}

// CurrencyMinorUnits: official decimal places per ISO 4217 currency code.
// AC1's own examples (USD/INR=2, JPY=0, KWD=3) plus enough of the common
// set to be genuinely useful; an unrecognized code is a hard error (this
// codebase's standing "reject and say exactly what's wrong" convention),
// not a silent default -- silently guessing decimal places for an unknown
// currency is exactly the kind of false mismatch AC1 exists to prevent.
var CurrencyMinorUnits = map[string]int32{
    "USD": 2, "EUR": 2, "GBP": 2, "INR": 2, "CAD": 2, "AUD": 2,
    "JPY": 0, "KRW": 0,
    "KWD": 3, "BHD": 3, "OMR": 3,
}

func MinorUnits(currency string) (int32, error) // errors on unrecognized code
func Round(v decimal.Decimal, currency string, method RoundingMethod) (decimal.Decimal, error)
```

`RoundingMethod` is a string-backed enum, `"round_half_up"` (default) or
`"round_half_to_even"` (AC4) -- `decimal.Decimal` already provides
`.RoundBank()` (half-to-even) and a plain `.Round()` (half-away-from-zero,
i.e. half-up for positive amounts, which every value here is); `Round`
just dispatches to the right one at the currency's minor-unit scale.

**AC2's "an automated check blocks code that does [use float for
money]"**: new small tool, `services/go-usage/tools/checkmoney/main.go`,
that parses (via `go/ast`, no external linter framework needed) every
`.go` file under `internal/money/` and fails with a non-zero exit and a
`file:line` report if it finds a `float32`/`float64` type used in any
field, parameter, or return type. Wire it into
`.github/workflows/ci.yml`'s `test` job as its own step (`go run
./tools/checkmoney ./internal/money`), run right after `go build`. This
is genuinely automated and genuinely blocks a real build the same way
AC2 requires, without inventing a dependency on a generic external
linter this repo doesn't already use.

### Schema: one new table (AC4, T94-T3, T94-T4, T94-T7, T94-T8)

New migration `db/migrations/20260927131123_rounding_config.sql`,
following the exact RLS/GRANT boilerplate `data_export.sql` established:

```sql
-- TEID-94: per-tenant, per-imported-billing-system rounding configuration.

CREATE TABLE IF NOT EXISTS rounding_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  imported_billing_system TEXT,
  rounding_method TEXT NOT NULL DEFAULT 'round_half_up'
    CHECK (rounding_method IN ('round_half_up', 'round_half_to_even')),
  rounding_point TEXT NOT NULL DEFAULT 'per_line'
    CHECK (rounding_point IN ('per_line', 'per_invoice', 'per_event')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, imported_billing_system)
);
-- Postgres treats NULL as distinct under a plain UNIQUE constraint, so the
-- compound UNIQUE above alone would let a tenant accumulate multiple
-- "no imported billing system" (NULL) rows; this partial index closes that.
CREATE UNIQUE INDEX IF NOT EXISTS rounding_configs_default_per_tenant
  ON rounding_configs (tenant_id) WHERE imported_billing_system IS NULL;

ALTER TABLE rounding_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE rounding_configs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_rounding_configs ON rounding_configs;
CREATE POLICY tenant_isolation_rounding_configs ON rounding_configs
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON rounding_configs TO teideal_app;
```

A tenant with no stored row for a given `imported_billing_system` (or none
at all) gets the hardcoded defaults (`round_half_up`, `per_line`) --
`rounding_configs` only needs a row once someone changes a default,
matching AC4's "configurable" framing rather than requiring a row to
exist upfront for every tenant.

### `GET /rounding-config` / `PUT /rounding-config` (AC4, T94-T3, T94-T4, T94-T7, T94-T8)

New file `services/go-usage/internal/api/rounding.go`, following
`usage.go`'s exact conventions: raw parameterized SQL inside
`Pool.WithTenant`, `writeJSON`/`writeErr` for responses, tenant ID always
from `auth.FromContext`'s `Principal`, never from the request body or
query string. Registered in `cmd/server/main.go` alongside the existing
`/usage` routes, gated by `auth.Middleware(pool, "admin")` (this service
has no per-role concept the way `services/ts-console` does post-TEID-43 --
"admin" is the existing highest scope in `internal/auth/auth.go`, and
config endpoints outside the ingest/read-only hot path already default to
it here).

`GET /rounding-config?imported_billing_system=<optional>` -- returns the
effective config for the caller's tenant and (optional) named system:
the stored row if one exists, else the hardcoded default, shape
`{rounding_method, rounding_point, imported_billing_system}`.

`PUT /rounding-config` -- body `{imported_billing_system?: string | null,
rounding_method?: "round_half_up" | "round_half_to_even",
rounding_point?: "per_line" | "per_invoice" | "per_event"}`. Only
provided fields change (T94-T7's "one field, one call" -- omitting
`rounding_point` must leave the stored `rounding_point` untouched, an
`UPDATE ... SET rounding_method = COALESCE($new, rounding_method)`-shaped
upsert, not a full-row replace). Validates `rounding_method`/`rounding_point`
against their exact enums (T94-T8): reject with `400
{"error": "rounding_method must be round_half_up or round_half_to_even"}`
for any other value, including plausible-looking ones like
`round_down_always` -- do not silently coerce or ignore an unrecognized
value.

### `POST /money/preview` (AC1, AC3, AC5, T94-T1, T94-T3, T94-T5, T94-T9)

New file `services/go-usage/internal/api/money.go`, same conventions and
auth scope as `rounding.go`.

Body: `{currency: string, lines: [{amount: string}],
imported_billing_system?: string, rounding_point?: "per_line" |
"per_invoice" | "per_event", rounding_method?: "round_half_up" |
"round_half_to_even"}`. `amount` is a **string**, not a JSON number --
this is deliberate and load-bearing for T94-T9: a JSON number literal
like `0.1` is already parsed into a float by the time a Go
`encoding/json` decoder sees it if the target field is numeric, which
would silently reintroduce the exact bug this story exists to prevent
before the value ever reaches `internal/money`. Accepting a string and
parsing it with `decimal.NewFromString` is what makes "the classic
floating-point-imprecise literal equivalent of 0.1 plus 0.2" (T94-T9)
actually exercise exact decimal arithmetic rather than already-corrupted
float64 input. `rounding_point`/`rounding_method`, if omitted, resolve
from the tenant's stored `rounding_configs` (falling back to the
hardcoded defaults), so a caller can either rely on stored config or
override per-call for comparison (T94-T3, T94-T4 need to run the *same*
line items through two different configurations, which this override
makes straightforward without needing two tenants -- though the story's
own test wording uses two tenants, either approach satisfies the AC and
the guidance below uses the two-tenant form to match the test text
exactly).

Computation:
- **`per_line`**: round each line's amount individually to the
  currency's minor units (AC1) using the resolved rounding method; total
  is the sum of the *rounded* lines (no separate remainder -- lines and
  total agree by construction).
- **`per_invoice`**: sum the *unrounded* lines first, round only the
  total; each line is still rendered at full precision in the response
  (T94-T3's "expected differing totals" between the two configurations
  is exactly this: per-line rounds three times and sums, per-invoice
  rounds once after summing, and fractional-cent inputs make these
  differ).
- **`per_event`**: reserved for the future per-`usage_events`-row
  application this story doesn't yet have a caller for (no rate/pricing
  exists to produce a per-event amount yet, per the scoping notes) --
  accept the value, validate it against the enum, store/report it
  faithfully, but its rounding behavior for this endpoint is identical to
  `per_line` (each provided line already corresponds to one caller-supplied
  amount) until a per-event caller exists to give it distinct meaning.

Response: `{lines: [{amount: <rounded, currency-formatted string>}],
total: <string>, rounding_adjustment: <string>}`. `rounding_adjustment`
is `total_before_rounding - total_after_rounding`'s absolute remainder
when `rounding_point` is `per_invoice` (else `"0"` for `per_line`, since
per-line rounding has no leftover by construction) -- reported as its
own explicit field precisely because AC5 requires it be "recorded as its
own ledger entry"; this is that value, in the shape TEID-33's real
ledger write will consume directly once it exists.

All amounts in requests and responses are decimal strings end-to-end
(never a bare JSON number) for the same T94-T9 reason given above.

## Implementation guidance per test

### TEID-94-T1
`POST /money/preview` three times for the same tenant with `currency:
"USD"`, `currency: "JPY"`, `currency: "KWD"` and one line each (e.g.
`"10.999"`). Assert the returned `amount` strings have exactly 2, 0, and
3 decimal places respectively, matching `CurrencyMinorUnits`.

### TEID-94-T2
Run `go run ./tools/checkmoney ./internal/money` against the real,
current `internal/money` package and assert exit code 0 (AC2's "existing
money fields all use a fixed-point or decimal type"). Then copy
`internal/money` to a temp directory, inject a synthetic `float64` field
into one file in the copy, rerun the checker against the copy, and assert
a non-zero exit code with a report naming that file and line -- this
proves the checker genuinely catches a float-typed money field rather
than only asserting it exists.

### TEID-94-T3
Create two tenants (or use the override fields on one -- see the
"Architecture and design" note above; the guidance here follows the
story's literal two-tenant wording). Set tenant A's `rounding_point` to
`per_line` and tenant B's to `per_invoice` via `PUT /rounding-config`.
`POST /money/preview` for each with the identical three fractional-cent
line amounts (e.g. `"33.335"`, `"33.335"`, `"33.335"`, summing to
`100.005`). Assert the two `total` values differ and each matches the
computation rule in "Architecture and design" above exactly (per-line:
three lines each rounded to `33.34` or `33.33` per the active rounding
method, summed; per-invoice: `100.005` rounded once).

### TEID-94-T4
Set tenant A to `round_half_up`, tenant B to `round_half_to_even` via
`PUT /rounding-config`. `POST /money/preview` for each with one line,
`"0.125"`, USD. Assert tenant A's line amount is `"0.13"` and tenant B's
is `"0.12"` (half-to-even rounds `0.125` down to the nearest even cent,
`0.12`; half-up rounds it up to `0.13`) -- this is the literal AC4
example, unchanged.

### TEID-94-T5
`POST /money/preview` with `rounding_point: "per_invoice"` and three
lines summing to `100.005` USD. Assert the response's `total` is
`100.01` or `100.00` (whichever this codebase's chosen half-up/half-even
default actually produces for a caller with no stored config -- assert
against the real computed value, don't hardcode an assumption) and
`rounding_adjustment` is exactly `0.005`.

### TEID-94-T6
Same AST-scan mechanism as T94-T2, run against the *entire*
`internal/money` package's exported and unexported surface (not just one
injected fixture) and assert zero `float32`/`float64` usages are found --
this is the "100 percent of monetary calculation paths" audit as a real,
automated, whole-package scan rather than a sampled check.

### TEID-94-T7
`PUT /rounding-config` with only `{rounding_method: "round_half_to_even"}`
in the body (no `rounding_point`). Assert `200`, then `GET
/rounding-config` and confirm `rounding_method` changed to
`round_half_to_even` while `rounding_point` is unchanged from whatever it
was before this call -- proving one field changes via one call, per the
scoping note's substitution for "3 clicks or fewer".

### TEID-94-T8
`PUT /rounding-config` with `{rounding_method: "round_down_always"}`.
Assert `400` and an error naming the allowed values, and that `GET
/rounding-config` afterward shows the config unchanged from before the
rejected call.

### TEID-94-T9
`POST /money/preview` with two lines, `"0.1"` and `"0.2"`, `rounding_point:
"per_invoice"` (so the unrounded sum is asserted before minor-unit
rounding is even applied). Assert the pre-rounding sum computed
internally (expose it via the response, e.g. an
`unrounded_total` debug field, or assert indirectly via `total` at a
currency with enough minor units to show it, e.g. treat the input as a
3-decimal currency in the test to observe `0.300` rather than a
rounded `0.30`) is exactly `"0.3"`/`"0.300"`, never
`"0.30000000000000004"` or any other float-artifact string.

## File layout

- `services/go-usage/go.mod` / `go.sum` -- add `github.com/shopspring/decimal`.
- `services/go-usage/internal/money/money.go` -- new: `Amount`,
  `CurrencyMinorUnits`, `MinorUnits`, `RoundingMethod`, `Round`,
  `RoundingPoint`, and the line/total/remainder computation used by
  `POST /money/preview`.
- `services/go-usage/tools/checkmoney/main.go` -- new: the AST-based
  float-in-`internal/money` scanner (AC2/T94-T2/T94-T6).
- `services/go-usage/internal/api/rounding.go` -- new: `GET`/`PUT
  /rounding-config`.
- `services/go-usage/internal/api/money.go` -- new: `POST /money/preview`.
- `services/go-usage/cmd/server/main.go` -- register the two new route
  files' handlers alongside the existing `/usage` routes.
- `db/migrations/20260927131123_rounding_config.sql` -- `rounding_configs`.
- `.github/workflows/ci.yml` -- add a `go run ./tools/checkmoney
  ./internal/money` step to the `test` job (right after `go build`), and
  install/run steps for the new `tests/currency-rounding` suite,
  positioned after the existing usage-ingestion step.
- Tests: new directory `tests/currency-rounding/` (mirror
  `tests/usage-ingestion/`'s exact shape: `package.json`,
  `vitest.config.ts`, `env.ts`, `http.ts`, one or more `*.test.ts`
  files) -- black-box HTTP tests against the real running `go-usage`
  binary and real Postgres, the same pattern every acceptance suite in
  this repo already uses; not Go unit tests, since `go test` is not part
  of this repo's CI today and the acceptance-test convention here is
  uniformly the black-box Vitest layer regardless of which service is
  under test.

## Definition of done

- [ ] All 5 acceptance criteria satisfied by working code (AC1/AC3/AC5
      scoped to the `/money/preview` synthetic surface, AC4's "tenant
      settings screen" scoped to the API, per the scoping notes above).
- [ ] All 9 cataloged tests have real automated tests that pass.
- [ ] `go build ./...` clean in `services/go-usage`; `go run
      ./tools/checkmoney ./internal/money` exits 0 against the real
      package.
- [ ] `tests/usage-ingestion` still passes unchanged (this story adds new
      files/routes; it does not modify `internal/api/usage.go`).
- [ ] Full suite passes against a database rebuilt from scratch via
      `db/setup-local.sh` plus the existing seed scripts.
- [ ] PR description maps each test ID to its file/line.
