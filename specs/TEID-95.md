# TEID-95: Sub-cent unit prices and very large quantities

| | |
|---|---|
| Epic | TEID-3 (E03 -- Build usage ingestion and exactly-once ledger) |
| Phase | E03 |
| Priority | Highest |
| Points | 3 |
| Release | mvp |
| Order | 14 (within E03; directly after TEID-94) |
| Depends on | `usage_events` (TEID-41/TEID-30), `internal/money` (TEID-94 -- `Amount`, `Round`, `CurrencyMinorUnits`), `github.com/shopspring/decimal` (already a dependency as of TEID-94) |

## Story (verbatim from the live board)

> As a billing operator, I want to price usage at fractions of a cent and bill very large quantities accurately, so that per-token and per-request pricing is represented exactly.
>
> *Context*
> Example: 0.0000015 USD per token over billions of tokens.

## Acceptance criteria (verbatim from the live board)

1. Unit prices support at least 12 decimal places.
2. Quantities up to one trillion units per event and per period are handled without overflow or loss of precision.
3. A test prices 3 billion tokens at 0.0000015 USD and produces exactly 4,500.00 USD.
4. Unit prices are shown in full precision in the console and exports, and rounded only on invoices.

## Cataloged tests (verbatim from the live board)

| ID | Type | AC | Title |
|---|---|---|---|
| TEID-95-T1 | Functional | 1 | Configure a unit price of 0.000000000001 USD, 12 decimal places, and confirm it is stored and retrieved without truncation or rounding. |
| TEID-95-T2 | Functional | 2 | Submit a single usage event with a quantity of 1,000,000,000,000 units and confirm the ledger records the exact quantity with no overflow error and no precision loss. |
| TEID-95-T3 | Functional | 3 | Price 3,000,000,000 tokens at 0.0000015 USD per token and confirm the computed line amount equals exactly 4,500.00 USD. |
| TEID-95-T4 | Functional | 4 | View a SKU priced at 0.0000015 USD in the console and in a CSV export and confirm both show the full 0.0000015 value, then generate its invoice and confirm the invoice line is rounded to 2 decimal places. |
| TEID-95-T5 | Non-functional | 2 | Load a customer account with 500 usage events each carrying quantities near 1 trillion within a single billing period and confirm aggregation completes within 5 seconds with no overflow or precision loss. |
| TEID-95-T6 | Adversarial | 2 | Submit a usage event with quantity 1,000,000,000,001, one unit over the trillion cap, and confirm the API rejects it with an explicit quantity-exceeds-maximum error instead of silently overflowing or wrapping. |
| TEID-95-T7 | Adversarial | 1 | Submit a unit price with 20 decimal places, exceeding the 12-place support, and confirm the system either rejects it with a clear precision-limit error or deterministically truncates at 12 places rather than silently corrupting the stored value. |

## Scoping notes for this point in the build sequence

This story is a direct continuation of TEID-94's `internal/money` package, and it's where TEID-94's own deferred decision comes due:

- **TEID-94 explicitly did not retrofit `usage_events.quantity`'s existing
  `float64` handling in `internal/api/usage.go`** (TEID-30, already
  shipped), on the grounds that quantity isn't a monetary value and no
  cataloged AC required the change yet. **AC2/T95-T2/T95-T6 now
  explicitly require it**: a usage event's quantity must round-trip up to
  one trillion units through ingestion and storage with zero precision
  loss, which `float64` cannot generally guarantee at that scale combined
  with fractional inputs, and cannot guarantee at all once a quantity is
  later multiplied by a sub-cent price (AC1/AC3). This story is the one
  that retrofits it -- **the column itself needs no schema change**
  (`usage_events.quantity` is already Postgres `NUMERIC`, which has been
  arbitrary-precision and lossless since TEID-41; the precision loss has
  only ever happened in Go's application layer, scanning that column into
  a `float64`). Fixing the Go-side type is therefore the whole job for
  AC2, not a database migration.
- **"Unit price" and "pricing" (AC1, AC3, AC4, T95-T1, T95-T3, T95-T4)
  don't have a home yet.** No `plan_rates`/pricing-lookup concept exists
  in `services/go-usage` (that table is TEID-16's, in
  `services/ts-console`, a different phase/service -- crossing into it
  would repeat exactly the file-overlap risk TEID-44's spec already
  reasoned through and avoided). Following that same precedent, and
  TEID-94's own `POST /money/preview` pattern of a synthetic,
  clearly-labeled testing surface: this story adds `POST /money/price`,
  a stateless computation endpoint (no new table) that takes a quantity
  and a unit price and returns the full-precision line amount plus the
  currency-rounded invoice amount, reusing `internal/money`'s existing
  `Round`. It is not a product pricing feature -- it exists to prove the
  arithmetic is exact, the same way `/money/preview` does for rounding.
  A real pricing/invoicing flow (TEID-33+) calls the same underlying
  `internal/money` functions this endpoint calls.
- **AC4's "shown in full precision in the console... and exports"**: "the
  console" doesn't exist (no admin UI anywhere in this repo, the same gap
  every other story's spec this session has documented) -- scoped to the
  API response, which already returns full-precision decimal strings.
  "Exports" refers to TEID-44's already-shipped `usage_events` export
  (`services/ts-console`, a different service/phase) -- **this story does
  not modify that code**. `node-postgres` (the `pg` npm package
  `ts-console` uses) already returns Postgres `NUMERIC` columns as exact
  strings by default, not JS numbers (confirmed independently in
  TEID-16's own implementation notes), so TEID-44's export of
  `usage_events.quantity` already preserves full precision as long as it
  never explicitly casts that value to a JS number -- which a `grep` of
  `services/ts-console/src/lib/exportSources.ts`/`exportFormats.ts`
  confirms it doesn't. Treat this as a one-line verification, not new
  work; flag it in `NOTES-TEID-95.md` if that grep turns up something
  different than expected.

## Architecture and design

### `internal/money`: Postgres `NUMERIC` <-> `decimal.Decimal` (AC1, AC2)

New file `services/go-usage/internal/money/pgnumeric.go`, using
`github.com/jackc/pgx/v5/pgtype` (already available -- it ships inside
the `pgx/v5` module already imported, no new dependency):

```go
func FromPGNumeric(n pgtype.Numeric) (decimal.Decimal, error) {
    if !n.Valid {
        return decimal.Decimal{}, errors.New("numeric value is NULL")
    }
    return decimal.NewFromBigInt(n.Int, n.Exp), nil
}

func ToPGNumeric(d decimal.Decimal) (pgtype.Numeric, error) {
    return pgtype.Numeric{Int: d.Coefficient(), Exp: d.Exponent(), Valid: true}, nil
}
```

This is lossless in both directions: `pgtype.Numeric` already represents
a Postgres `NUMERIC` as an arbitrary-precision `(*big.Int, exponent)`
pair with no intermediate float, and `decimal.Decimal` is the same
representation under a different name (`NewFromBigInt`/`Coefficient`/
`Exponent` are exact, no float64 anywhere in the conversion). Use
`pgtype.Numeric` as the direct `Scan`/query-argument type for the
`quantity` column everywhere it's read or written; convert to/from
`decimal.Decimal` only at the boundary where the value needs arithmetic
(validation, the money endpoints) or JSON serialization.

### `internal/api/usage.go`: quantity becomes exact (AC2, T95-T2, T95-T5, T95-T6)

Changes, all confined to this one file plus the SQL that already touches
`quantity`:
- `usageEvent.Quantity`, `postUsageRequest.Quantity`, and
  `batchResultItem.Quantity` change from `float64`/`*float64` to
  `decimal.Decimal`/`*decimal.Decimal`. **No wire-format change**:
  `decimal.Decimal` already implements `UnmarshalJSON`/`MarshalJSON` that
  reads/writes the raw JSON number token directly (bare numeric literal
  or a quoted string, either works) without ever converting through
  `float64` -- existing clients sending a plain JSON number for
  `quantity` keep working unchanged, and TEID-30's existing tests (which
  use small, exact literals like `10.5`) are unaffected.
- The batch path's `var qty float64; json.Unmarshal(item.Quantity, &qty)`
  becomes `var qty decimal.Decimal; json.Unmarshal(item.Quantity, &qty)`
  -- same mechanism, decimal-safe.
- `validateQuantity(q float64)` becomes `validateQuantity(q
  decimal.Decimal) error`: rejects negative (`q.IsNegative()`), and adds
  the new cap from AC2 -- reject with `"quantity must not exceed
  1000000000000 (one trillion)"` when `q.GreaterThan(oneTrillion)`
  (T95-T6's exact case: `1,000,000,000,001` is one over and must be
  rejected with this specific, explicit reason, not a generic error or a
  silent wrap).
- Every `INSERT`/`SELECT`/`Scan` touching `quantity` binds/scans via
  `pgtype.Numeric` (constructed with `ToPGNumeric`/read with
  `FromPGNumeric`) instead of passing/scanning a bare `float64`.
- Add a DB-level backstop matching the same cap: new migration (below)
  adds a `CHECK` constraint on `usage_events.quantity`. App-level
  validation is what T95-T6 actually asserts against; the constraint is
  defense-in-depth, consistent with this codebase's layered-validation
  convention elsewhere (e.g. TEID-16's `plans` table checks mirror its
  own route-level validation).

### `GET /usage/summary?customer_id=<uuid>` -- aggregation (T95-T5)

New handler in `usage.go` (or a new `internal/api/usage_summary.go`,
either is fine): sums `quantity` for the caller's tenant (optionally
filtered by `customer_id`, same UUID validation as `GetUsage`) via
`SELECT COUNT(*), COALESCE(SUM(quantity), 0) FROM usage_events WHERE
...`. Postgres's own `NUMERIC` `SUM` is already arbitrary-precision and
exact regardless of row count or per-row magnitude -- no chunking or
special handling needed for 500 near-trillion rows. Scan the sum via
`pgtype.Numeric`/`FromPGNumeric` into the response: `{event_count: int,
total_quantity: string}`.

### `POST /money/price` -- exact quantity x unit-price (AC1, AC3, AC4, T95-T1, T95-T3, T95-T4, T95-T7)

New file `services/go-usage/internal/api/money_price.go` (or add to the
existing `internal/api/money.go` from TEID-94 -- either is fine, pick
one and be consistent), same conventions as TEID-94's money endpoints
(admin-gated, decimal strings at the request/response boundary, never a
bare JSON number for `unit_price` -- same T94-T9-style reasoning:
a JSON number literal for a value with 12+ decimal places risks exactly
the float64 corruption this story exists to prevent before the value
ever reaches `internal/money`).

Body: `{currency: string, quantity: string, unit_price: string}`.
- `unit_price` parsed via `decimal.NewFromString`. If it has more than
  12 decimal places (`unit_price.Exponent() < -12`), reject with `400
  {"error": "unit_price supports at most 12 decimal places"}` (T95-T7 --
  explicit rejection was chosen over silent truncation, since silently
  dropping digits from a price is exactly the kind of silent corruption
  this story's AC1 exists to prevent; truncation would satisfy the AC's
  "or ... deterministically truncates" alternative too, but explicit
  rejection is more consistent with this codebase's established
  "reject and say what's wrong" convention used everywhere else).
- `quantity` parsed and validated the same way (and against the same
  one-trillion cap) as `usage.go`'s `validateQuantity`, reusing that
  function directly rather than duplicating the limit.
- Line amount: `quantity.Mul(unitPrice)`, returned at full precision as
  `line_amount` (a decimal string) -- this is what T95-T3 asserts
  against (`3_000_000_000 x 0.0000015` must equal exactly `4500.00` when
  the multiplication itself is exact; shopspring/decimal's `Mul` never
  rounds, so this is really testing that neither operand was corrupted
  before reaching it).
- Invoice amount: `money.Round(lineAmount, currency, method)` (default
  `round_half_up` if not specified, matching TEID-94's own default) --
  this is the "rounded only on invoices" half of AC4, and directly
  reuses TEID-94's existing rounding function rather than reimplementing
  it.
- Response: `{line_amount: <full-precision string>, invoice_amount:
  <currency-rounded string>}`.

### New migration: quantity cap constraint

`db/migrations/20260927143257_usage_quantity_cap.sql`:

```sql
-- TEID-95: defense-in-depth cap matching the app-level one-trillion
-- quantity limit (AC2). App validation in usage.go is what actually
-- rejects an over-cap request; this is a database-level backstop.
ALTER TABLE usage_events
  ADD CONSTRAINT usage_events_quantity_max CHECK (quantity <= 1000000000000);
```

No RLS/GRANT changes needed -- this only adds a `CHECK` to an existing,
already-RLS'd table.

## Implementation guidance per test

### TEID-95-T1
`POST /money/price` with `unit_price: "0.000000000001"` (12 decimal
places) and any valid `quantity`/`currency`. Assert `200` and that
`line_amount` reflects that exact price with no truncation (e.g. use a
`quantity` of `"1"` so `line_amount` should be exactly
`"0.000000000001"` before rounding).

### TEID-95-T2
`POST /usage` with `quantity: 1000000000000` (bare JSON number, one
trillion exactly) and otherwise-valid fields. Assert `201` and that the
response's `quantity` field is exactly `"1000000000000"` (or the
equivalent parsed decimal), then `GET /usage?customer_id=...` and
confirm the stored/returned value round-trips exactly, with no
scientific notation or truncated digits.

### TEID-95-T3
`POST /money/price` with `quantity: "3000000000"`, `unit_price:
"0.0000015"`, `currency: "USD"`. Assert `line_amount` is exactly
`"4500.000000000"` (or equivalent full-precision representation of
4500) and `invoice_amount` is exactly `"4500.00"`.

### TEID-95-T4
First confirm (per the scoping note) that
`services/ts-console/src/lib/exportSources.ts`/`exportFormats.ts` never
converts `quantity` to a JS number before writing it to CSV/JSON --
grep for `Number(` / `parseFloat` near the quantity column and record
the result in `NOTES-TEID-95.md`. Then: `POST /money/price` with
`unit_price: "0.0000015"` and assert the response's `line_amount`
literally contains `0.0000015` in full (the "console" half of AC4, per
the scoping note, since no console UI exists to view). Finally assert
`invoice_amount` from the same call is rounded to 2 decimal places for
USD (the "invoice" half).

### TEID-95-T5
Bulk-insert 500 `usage_events` rows for one customer with quantities
near `999999999999` (just under the cap, so the sum is large but valid)
using the same `INSERT ... SELECT ... FROM generate_series(...)`
bulk-fixture technique TEID-92-T7/TEID-30-T7/TEID-44-T5 already use
(faster and more realistic than one HTTP call per row). Call `GET
/usage/summary?customer_id=...`, assert it responds within 5 seconds,
`event_count` is `500`, and `total_quantity` equals the exact expected
sum (computed in the test from the same quantities used to seed the
rows, not re-derived from the response).

### TEID-95-T6
`POST /usage` with `quantity: 1000000000001` (one over the cap). Assert
`400` and an error explicitly naming the trillion-unit maximum, not a
generic "invalid quantity" message, and that no row was inserted
(`GET /usage` count for that customer unchanged, or query directly).

### TEID-95-T7
`POST /money/price` with `unit_price: "0.00000000000000000001"` (20
decimal places). Assert `400` with an error naming the 12-decimal-place
limit (this spec's chosen resolution of AC1's either/or -- explicit
rejection, not silent truncation; see "Architecture and design" above
for why).

## File layout

- `services/go-usage/internal/money/pgnumeric.go` -- new:
  `FromPGNumeric`, `ToPGNumeric`.
- `services/go-usage/internal/api/usage.go` -- modified: `Quantity`
  fields become `decimal.Decimal`, `validateQuantity` takes
  `decimal.Decimal` and enforces the trillion cap, SQL bind/scan uses
  `pgtype.Numeric`. Add the `GET /usage/summary` handler here or in a
  new sibling file.
- `services/go-usage/internal/api/money.go` (or a new
  `money_price.go`) -- new: `POST /money/price`.
- `services/go-usage/cmd/server/main.go` -- register `GET
  /usage/summary` and `POST /money/price`.
- `db/migrations/20260927143257_usage_quantity_cap.sql` -- new.
- Tests: new directory `tests/large-quantities/` (mirror
  `tests/currency-rounding/`'s exact shape: `package.json`,
  `vitest.config.ts`, `env.ts`, `http.ts`, one or more `*.test.ts`
  files), implementing all 7 cataloged tests.
- `.github/workflows/ci.yml` -- add install/run steps for
  `tests/large-quantities`, positioned after the existing
  `tests/currency-rounding` step.

## Definition of done

- [ ] All 4 acceptance criteria satisfied by working code (AC4's
      "console" scoped to the API response per the scoping notes; its
      "exports" half verified against TEID-44's existing code, not
      modified).
- [ ] All 7 cataloged tests have real automated tests that pass.
- [ ] `go build ./...` clean in `services/go-usage`; `go run
      ./tools/checkmoney ./internal/money` still exits 0 (this story
      adds `pgnumeric.go` to that package -- it must not introduce any
      `float32`/`float64`).
- [ ] `tests/usage-ingestion` and `tests/currency-rounding` still pass
      unchanged -- this story changes `usage.go`'s quantity handling, so
      run the existing usage-ingestion suite for real, not just build
      it, and spot-check that its assertions still hold against the new
      `decimal.Decimal`-based JSON responses (field shape is unchanged,
      only the underlying type is more precise).
- [ ] Full suite passes against a database rebuilt from scratch via
      `db/setup-local.sh` plus the existing seed scripts.
- [ ] PR description maps each test ID to its file/line.
