# TEID-20: Per-customer rate overrides

| | |
|---|---|
| Epic | TEID-1 (E01 -- Implement entitlement model and pricing configuration) |
| Phase | E01 |
| Priority | High |
| Points | 3 |
| Release | mvp |
| Order | 33 (within E01, directly after TEID-19) |
| Depends on | `recordConfigChangeWithClient` (TEID-42), `consoleRoute` (TEID-43), `parseExplicitTimestamp`/`parseAsOf` (TEID-17, `services/ts-console/src/lib/grants.ts`), `plan_rates` (TEID-16) |

## Story (verbatim from the live board)

> As a billing operator, I want to give one customer a special rate on a specific model or metric for a set period, so that negotiated discounts are applied without code changes.
>
> *Context*
> Sales routinely agrees discounts on a single model. Today these live as if-statements in production.

## Acceptance criteria (verbatim from the live board)

1. An operator can set an override rate for a customer on any metric or model, with a start date and optional end date.
2. When an override is active it always takes precedence over the plan rate; the rules for precedence are documented in the console.
3. Every usage event priced with an override records the override's ID in the ledger.
4. When the override ends, pricing returns to the plan rate from the next event onwards with no manual step.

## Cataloged tests (verbatim from the live board)

| ID | Type | AC | Title |
|---|---|---|---|
| TEID-20-T1 | Functional | 1 | Create an override for customer ACME-007 on model gpt-4o-mini at 0.0008 USD per 1K tokens with a start date of 2026-10-01 and no end date, and confirm it saves and appears active on that date. |
| TEID-20-T2 | Functional | 2 | With both a plan rate of 0.002 USD and an active customer override of 0.0008 USD for the same model, submit a usage event and confirm it is priced at 0.0008 USD, and confirm the console's precedence documentation page states overrides win over plan rates. |
| TEID-20-T3 | Functional | 3 | Submit a usage event priced under an active override and confirm the resulting ledger entry includes the override's ID field matching the override record. |
| TEID-20-T4 | Functional | 4 | Set an override with end date 2026-10-31, submit a usage event on 2026-11-01, and confirm it is priced at the plan's standard rate with no operator action taken. |
| TEID-20-T5 | Non-functional | 2 | Measure the added latency of resolving an active override during the pricing step under 3000 events per second and confirm it adds no more than 5 milliseconds versus pricing with no override. |
| TEID-20-T6 | Non-functional | 1 | Have an operator with no prior training create a customer override using only the console's inline field labels and confirm they select the correct metric, model, start date and end date fields without consulting documentation. |
| TEID-20-T7 | Adversarial | 1 | Create two overlapping overrides for the same customer and model with conflicting rates and overlapping date ranges, and confirm the system either rejects the second override or applies a clearly documented conflict-resolution rule rather than silently picking one at random. |
| TEID-20-T8 | Adversarial | 4 | Set an override's end date to a date in the past at creation time and confirm the system rejects the request or immediately treats the override as expired rather than pricing new events against it. |

## Scoping notes for this point in the build sequence

- **No pricing/rating engine exists anywhere in the codebase -- this is the
  central gap this story has to bridge.** `plan_rates` (TEID-16) stores
  `metric`/`model`/`rate` but is never read by any pricing logic anywhere;
  `POST /money/price` (`services/go-usage`) is a pure arithmetic/rounding
  utility that takes an explicit `unit_price` from the caller, not a rate
  lookup. TEID-19's `overage_rate`/`overage_amount_due` mechanism is the
  closest existing precedent (a rate that overrides default pricing,
  recorded on the resulting line) but it is flat-rate-on-a-grant, with no
  metric/model dimension -- not directly reusable, only structurally
  instructive.
- **No customer-to-plan assignment exists**, the same gap TEID-16 through
  TEID-19's specs each independently documented. AC2's "takes precedence
  over the plan rate" and T2's "with both a plan rate... and an active
  customer override... submit a usage event" cannot be honestly tested by
  deriving "the customer's plan" from `customer_id` alone -- there is no
  such link to derive. Unlike TEID-18/19, which each built the plan-level
  side of their own AC as real-but-permanently-unreachable code (since
  their plan-level ACs weren't the one under direct test), **AC2/T2 here
  explicitly requires proving precedence over an active plan rate**, which
  an unreachable plan-side cannot demonstrate. Resolved differently from
  TEID-18/19's precedent: the pricing endpoint (below) takes an explicit
  `plan_id` in its request body, the same way `POST /money/price` already
  takes an explicit `unit_price` rather than deriving one. This makes T2
  directly, honestly testable (a real `plan_rates` row for the named plan
  competing against a real override for the named customer) without
  declaring any code permanently unreachable. Stated here explicitly as a
  deliberate departure from the prior three stories' pattern, not an
  oversight.
- **AC3's "ledger" is a new, standalone table, not an extension of
  `usage_consumption_lines`.** `usage_consumption_lines` (TEID-18) is a
  credit-consumption concept -- keyed by `grant_id`/`source_category`, no
  metric/model dimension -- and conflating "draw down a grant" with
  "price a metric at a per-unit rate" would blur two different
  mechanisms for no benefit (this story never touches grants or credit
  balances at all). A new table, `priced_usage_lines`, is used instead --
  scoped narrowly to what AC2/AC3 actually describe: pricing one
  metric-denominated usage line and recording which override (if any)
  applied.
- **This is a synthetic pricing endpoint, matching TEID-17/18/19's own
  "usage event" stand-in precedent, not a real `go-usage` hot-path
  change.** Per ADR 0001, per-unit rating on the ingestion hot path is
  conceptually `go-usage`'s eventual domain, but every prior E01 story has
  built its "usage event" stand-in as a synthetic `services/ts-console`
  endpoint (`POST /grants/:id/consume`, `POST /customers/:id/consume`)
  rather than touching `go-usage`, on the reasoning that this epic is
  about configuration and its resolution logic, not the ingestion path
  itself -- TEID-2 (real-time entitlement checks, phase-2, not started) is
  the future story that actually wires this into `go-usage`. TEID-20
  follows the same precedent: `POST /customers/:id/price-usage`, in
  `services/ts-console`.
- **AC2's "documented in the console" and T2's "console's precedence
  documentation page"** are scoped the same way TEID-18's "customer
  timeline" (AC5) was: a new, small API surface standing in for the
  future UI. Here there's no natural queryable *record* (it's static
  prose, not data), so the substitution is a static-content endpoint,
  `GET /docs/rate-override-precedence`, whose fixed response text states
  the precedence rule in words. T2 fetches it and asserts the stated rule.
- **T6 ("untrained operator... using only console inline field labels, no
  docs needed") is the weakest-fitting substitution of any E01 story's
  non-functional UI-flavored test so far -- flagged honestly rather than
  silently reused.** TEID-16-T7's precedent (assert error messages/field
  names are self-explanatory, standing in for "a human successfully
  self-serves from a UI that doesn't exist") is the best available
  substitution, but T6 is fundamentally a UI-usability claim and an API's
  field names are a weaker proxy for "inline labels" than TEID-16's own
  version of this substitution was for its own AC. Scoped to: `POST
  /customers/:id/rate-overrides`'s `400` validation responses name each
  problem field in plain language (`metric`, `model`, `rate`,
  `start_date`, `end_date` -- no jargon, no internal type names), and the
  accepted request body's field names themselves are the plain-English
  words a console form's inline labels would use verbatim. No simulated
  human study is performed.
- **T7's overlap rejection is an application-level check, not a Postgres
  `EXCLUDE` constraint.** A date-range-overlap `EXCLUDE USING gist`
  constraint would need the `btree_gist` extension, not enabled anywhere
  in this repo's migrations today -- adding it for one table would be new
  infrastructure the rest of the repo doesn't use. An application-level
  overlap check before insert (query existing overrides for the same
  `customer_id`/`metric`/`model` whose `[start_date, end_date)` intersects
  the new one; reject with `409` if found) matches this repo's existing
  conditional-write conventions (`publishDraftPlan`'s `WHERE status =
  'draft'` pattern) more closely, and is what's implemented here. Per
  AC1's own wording ("clearly documented conflict-resolution rule rather
  than silently picking one at random"), outright rejection is simpler
  and more defensible than an implicit tie-break rule, and is what's
  implemented -- not a documented precedence rule between overlapping
  overrides, since AC1 accepts either approach and rejection needs no
  further design decisions.
- **AC4 needs no background worker.** Unlike TEID-17/19's grants (which
  have a persistent `remaining_amount`/`status` that must be mutated over
  time via `processExpiredGrants`/`processCommitDrawdowns`), a rate
  override has no mutable balance -- "returns to plan rate" is purely a
  consequence of the resolver's `as_of` no longer falling inside
  `[start_date, end_date)` on the next call. AC4 is proved by exercising
  AC2's resolver at a later `as_of`, not by any separate mechanism.
- **No "amend an override" endpoint.** None of the 8 cataloged tests
  exercise editing an existing override (only create, price, and the
  overlap/past-date adversarial cases) -- per TEID-19's own "don't build
  untested surface" practice, this is out of scope.

## Architecture and design

### Schema: two new tables

New migration `db/migrations/20260928100000_rate_overrides.sql`:

```sql
-- TEID-20: a customer-scoped rate override for one metric/model, with a
-- validity window. AC1's "any metric or model" -- model is nullable
-- (a metric-wide override), matching plan_rates' own metric/model shape.
CREATE TABLE IF NOT EXISTS customer_rate_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id),
  metric TEXT NOT NULL,
  model TEXT,
  rate NUMERIC NOT NULL CHECK (rate >= 0),
  start_date TIMESTAMPTZ NOT NULL,
  end_date TIMESTAMPTZ,
  created_by_user_id UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_date IS NULL OR end_date > start_date)
);
ALTER TABLE customer_rate_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_rate_overrides FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_customer_rate_overrides ON customer_rate_overrides;
CREATE POLICY tenant_isolation_customer_rate_overrides ON customer_rate_overrides
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT ON customer_rate_overrides TO teideal_app;

-- AC3's "ledger": one row per priced usage line, recording which override
-- (if any) applied. Deliberately separate from usage_consumption_lines
-- (a credit-consumption concept with no metric/model dimension) -- see
-- specs/TEID-20.md's scoping notes.
CREATE TABLE IF NOT EXISTS priced_usage_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id),
  plan_id UUID NOT NULL REFERENCES plans(id),
  metric TEXT NOT NULL,
  model TEXT,
  quantity NUMERIC NOT NULL CHECK (quantity > 0),
  rate_applied NUMERIC NOT NULL CHECK (rate_applied >= 0),
  amount NUMERIC NOT NULL CHECK (amount >= 0),
  rate_override_id UUID REFERENCES customer_rate_overrides(id),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE priced_usage_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE priced_usage_lines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_priced_usage_lines ON priced_usage_lines;
CREATE POLICY tenant_isolation_priced_usage_lines ON priced_usage_lines
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
-- Append-only, matching grant_ledger_entries'/audit_log's own precedent.
GRANT SELECT, INSERT ON priced_usage_lines TO teideal_app;
```

`rate_override_id` is nullable: a `NULL` value means the line priced against
the plan rate with no override active (AC4's steady state).

### `services/ts-console/src/lib/rateOverrides.ts` -- new file

- `validateOverrideInput(body)`: `customer_id` (UUID, required),
  `metric` (non-empty string, required), `model` (string or omitted,
  optional), `rate` (finite number `>= 0`, required), `start_date`
  (required, via `parseExplicitTimestamp` -- reused directly from
  `grants.ts`, not reimplemented), `end_date` (optional, via the same
  parser; if present, `400 "end_date must be after start_date"` if
  `<= start_date`, and **T8**: `400 "end_date must not be in the past"`
  if `<= now()` at creation time -- rejected outright, not silently
  treated as pre-expired, since AC1's wording ("with... optional end
  date") implies a forward-looking configuration action, and rejecting a
  self-evidently-useless request is more informative than accepting one
  that immediately does nothing).
- `checkOverlap(client, tenantId, customerId, metric, model, startDate,
  endDate)`: `SELECT EXISTS(SELECT 1 FROM customer_rate_overrides WHERE
  tenant_id = $1 AND customer_id = $2 AND metric = $3 AND model IS NOT
  DISTINCT FROM $4 AND start_date < COALESCE($6, 'infinity'::timestamptz)
  AND COALESCE(end_date, 'infinity'::timestamptz) > $5)` -- the standard
  half-open-interval overlap test, `IS NOT DISTINCT FROM` so two
  metric-wide (`model IS NULL`) overrides for the same metric correctly
  count as a collision. **T7**: if this returns true, the create route
  returns `409` naming the conflict, per the scoping notes' rejection-not-
  tiebreak decision.
- `insertOverride(client, tenantId, userId, input)`: plain `INSERT ...
  RETURNING id`, mirroring `insertGrant`'s shape.
- `readOverride`/`listOverrides`: mirror `readGrant`/`listGrants`'s
  existing cursor-pagination shape.
- `resolveEffectiveRate(client, tenantId, customerId, planId, metric,
  model, asOf)` -- the AC2 resolver, the one genuinely new piece of logic
  this story introduces:
  1. Query `customer_rate_overrides` for the newest (`ORDER BY created_at
     DESC LIMIT 1`) row matching `tenant_id`, `customer_id`, `metric`,
     `model IS NOT DISTINCT FROM $model`, and `asOf` within
     `[start_date, COALESCE(end_date, 'infinity'))`. If found, return
     `{rate, overrideId: row.id}`.
  2. Otherwise, query `plan_rates` for `plan_id = $planId AND metric =
     $metric AND model IS NOT DISTINCT FROM $model`. If found, return
     `{rate, overrideId: null}`.
  3. If neither resolves, `404`/`error: "no rate configured for this
     metric/model on this plan"` -- there is nothing to price against.

### `POST /customers/:id/rate-overrides` -- create (AC1, T1, T6, T7, T8)

New file `services/ts-console/src/routes/rateOverrides.ts`, Owner or
Billing Admin only, session-authed via `consoleRoute`, matching every
other E01 mutation's role gate. Validates via `validateOverrideInput`,
checks `customerVisible` (reused from `grants.ts`), checks
`checkOverlap` (`409` on collision), inserts, calls
`recordConfigChangeWithClient` (`objectType: "CustomerRateOverride"`).
Returns `201` with the created record.

### `GET /customers/:id/rate-overrides` -- list (supports T1's "confirm it saves and appears active")

Any role, session-authed. Paginated list, same cursor shape as
`GET /grants`.

### `GET /docs/rate-override-precedence` -- the console-docs stand-in (AC2, T2)

Any role, session-authed (or no auth at all -- it's static, non-
tenant-scoped content; session-authed for consistency with every other
route in this file). Returns a fixed `200` body:
`{"rule": "An active customer rate override always takes precedence over the plan rate for the same metric and model. When no override is active, or the override's date range has ended, pricing uses the plan's configured rate."}`.

### `POST /customers/:id/price-usage` -- the synthetic priced-usage-event endpoint (AC2, AC3, AC4, T2, T3, T4, T5)

New route in the same file, Owner or Billing Admin only. Body:
`{plan_id, metric, model?, quantity, as_of?}` (`as_of` optional, via
`parseAsOf`, defaulting to now -- same convention as
`POST /customers/:id/consume`). Inside one `withTenant` transaction:
1. `customerVisible` check (`403` pattern, matching every other route).
2. `resolveEffectiveRate(...)`. `404` if nothing resolves.
3. `amount = quantity * rate`, computed as `NUMERIC` (pass both as
   `::numeric` in the `INSERT`'s parameterized query -- Postgres does the
   multiplication server-side at full precision, not JavaScript floating
   point, matching this repo's established exact-decimal discipline from
   TEID-94/95).
4. `INSERT INTO priced_usage_lines (..., rate_override_id) VALUES (...)`.
5. Response: `201` with the full `priced_usage_lines` record, including
   `rate_override_id` (**T3**'s "ledger entry includes the override's ID
   field").

## Implementation guidance per test

### TEID-20-T1
`POST /customers/:id/rate-overrides` with `metric: "gpt-4o-mini-tokens"`,
`rate: 0.0008`, `start_date: "2026-10-01T00:00:00Z"`, no `end_date`.
Assert `201` and the response fields match exactly. `GET
/customers/:id/rate-overrides` and confirm the created row is present;
call `resolveEffectiveRate`'s underlying behavior indirectly via `POST
/customers/:id/price-usage` with `as_of: "2026-10-01T00:00:00Z"` (a plan
with no rate for this metric, or any plan) and confirm the override's
rate is used -- "appears active on that date" proved by actual
resolution, not just presence in the list.

### TEID-20-T2
Seed a plan with a `plan_rates` row (`metric: "gpt-4o-mini-tokens",
model: null, rate: 0.002`). Create a customer override for the same
metric at `0.0008`, active now. `POST /customers/:id/price-usage` with
that `plan_id`/metric/a `quantity`. Assert `rate_applied: 0.0008` (not
`0.002`). `GET /docs/rate-override-precedence` and assert the response
text contains "override" and "precedence" (or equivalent) stating
overrides win.

### TEID-20-T3
Using T2's setup, assert the `POST /customers/:id/price-usage` response's
`rate_override_id` equals the override's own `id` from its creation
response. `GET /customers/:id/rate-overrides` (or a direct DB read via
the test's own pool) and confirm the ids match exactly.

### TEID-20-T4
Create an override with `end_date: "2026-10-31T23:59:59Z"`. `POST
/customers/:id/price-usage` with `as_of: "2026-11-01T00:00:00Z"`. Assert
`rate_applied` equals the plan's rate (via a `plan_rates` row for the
same metric) and `rate_override_id: null` -- "no operator action taken"
proved by nothing being called between the two `price-usage` requests
except the passage of time (`as_of`).

### TEID-20-T5
`RATE_OVERRIDE_LATENCY_BUDGET_MS`-scaled load test (matching TEID-19-T6's
established convention; default CI-scaled value, `5` documented as the
real per-request-overhead target at 3000/sec for a dedicated perf run).
Time `POST /customers/:id/price-usage` calls with an active override
present vs. an equivalent customer/plan with zero overrides, and assert
the difference in mean/p99 latency stays within budget.

### TEID-20-T6
`POST /customers/:id/rate-overrides` with each required field omitted in
turn (`metric`, `rate`, `start_date`) and assert each `400` error names
that exact field in plain language, no jargon. Assert the request body's
accepted field names (`metric`, `model`, `rate`, `start_date`,
`end_date`) are themselves the plain-English words this test's premise
requires -- documented in this test as the honest substitution for a
simulated human study, per the scoping notes.

### TEID-20-T7
Create an override for customer/metric/model X with dates `[2026-10-01,
2026-11-01)`. Attempt a second `POST /customers/:id/rate-overrides` for
the same customer/metric/model with overlapping dates (e.g. `[2026-10-15,
2026-12-01)`) and a different rate. Assert `409`, and assert only the
first override exists afterward (`GET /customers/:id/rate-overrides`
returns exactly one row for this metric/model).

### TEID-20-T8
`POST /customers/:id/rate-overrides` with `end_date` set to a timestamp
before `start_date` and also a case with `end_date` before `now()`.
Assert `400` in both cases (the `end_date > start_date` `CHECK` handles
the first; the explicit "must not be in the past" validation handles the
second, per the scoping notes' reject-outright decision). Assert no row
was created (`GET /customers/:id/rate-overrides` unchanged).

## File layout

- `db/migrations/20260928100000_rate_overrides.sql` -- `customer_rate_overrides`,
  `priced_usage_lines`.
- `services/ts-console/src/lib/rateOverrides.ts` -- new: validation,
  `checkOverlap`, `insertOverride`, `readOverride`/`listOverrides`,
  `resolveEffectiveRate`.
- `services/ts-console/src/routes/rateOverrides.ts` -- new: `POST`/`GET
  /customers/:id/rate-overrides`, `GET
  /docs/rate-override-precedence`, `POST /customers/:id/price-usage`.
- `services/ts-console/src/server.ts` -- register the new route file.
- Tests: new directory `tests/rate-overrides/` (mirror `tests/plans/`/
  `tests/commits/`'s shape), implementing all 8 cataloged tests.
- `tests/cross-tenant/rate-override-isolation.test.ts` -- new:
  cross-tenant case for every new endpoint, matching
  `commit-isolation.test.ts`'s shape.
- CI: add steps to `.github/workflows/ci.yml`'s `test` job to install and
  run `tests/rate-overrides`, positioned after the existing
  `tests/commits` step.

## Definition of done

- [ ] All 4 acceptance criteria satisfied by working code (AC2's "plan
      rate" resolved via an explicit `plan_id` in the pricing request,
      per the scoping notes' departure from TEID-18/19's precedent; AC2's
      "documented in the console" and T6's "inline field labels" scoped
      to the API-surface substitutions above).
- [ ] All 8 cataloged tests have real automated tests that pass --
      functional, non-functional, and adversarial alike.
- [ ] `tsc --noEmit` clean in `services/ts-console`; the new routes go
      through `consoleRoute`.
- [ ] `tests/cross-tenant`, `tests/console-auth`, `tests/audit-log`,
      `tests/api-keys`, `tests/rbac`, `tests/data-export`, `tests/plans`,
      `tests/grants`, `tests/consumption-order`, `tests/commits` all
      still pass unchanged.
- [ ] Cross-tenant isolation proven in `tests/cross-tenant` for every new
      endpoint.
- [ ] Full suite passes against a database rebuilt from scratch via
      `db/setup-local.sh` plus the existing seed scripts.
- [ ] PR description maps each test ID to its file/line.
