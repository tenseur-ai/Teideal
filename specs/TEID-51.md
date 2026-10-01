# TEID-51: Record inference costs

| | |
|---|---|
| Epic | TEID-7 (E07 -- Build cost and margin analytics) |
| Phase | E07 -- Build cost and margin analytics |
| Priority | Medium |
| Points | 5 |
| Release | phase-2 |
| Order | 97 (within this phase; first story in E07) |
| Depends on | go-usage's `usage_events` table (TEID-30/94/95/96) for the event stream this story attaches costs to. Nothing in E07 has been built yet -- this is the first story in a brand-new phase, with no developer agent currently assigned to it. |

## Story (verbatim from the live board)

> As a finance lead, I want to enter our cost per unit for each model, or send a cost with each event, so that margin can be calculated automatically.
>
> *Context*

## Acceptance criteria (verbatim from the live board)

1. An operator can maintain a cost table per model and metric, with effective dates.
2. Alternatively, an event can carry its own actual cost, which overrides the table.
3. Cost changes never alter the price charged to customers.

## Cataloged tests (verbatim from the live board)

| ID | Type | AC | Title |
|---|---|---|---|
| TEID-51-T1 | Functional | 1 | Add a cost table entry for model gpt-4-class at $0.02 per 1,000 tokens effective 2026-10-01 and a second entry at $0.015 effective 2026-11-01, then confirm cost calculations before and after the transition date use the correct rate. |
| TEID-51-T2 | Functional | 2 | Ingest a usage event carrying an explicit actual_cost of $0.0187 for a call that would otherwise use the standard table rate, and confirm the margin calculation uses the event's own $0.0187 cost rather than the table rate. |
| TEID-51-T3 | Functional | 3 | Update the cost table rate for model gpt-4-class from $0.02 to $0.05 per 1,000 tokens and confirm the customer-facing price on existing and new invoices for that model remains completely unchanged. |
| TEID-51-T4 | Non-functional | 1 | Load a cost table with 200 models across 5 metrics, each with multiple effective-dated entries, and confirm cost lookups at ingestion time remain under 100 milliseconds. |
| TEID-51-T5 | Non-functional | 1 | Add a new effective-dated cost entry through the operator UI or API and confirm it takes effect without requiring a deployment or code change. |
| TEID-51-T6 | Adversarial | 1 | Create two overlapping effective-dated cost entries for the same model and metric both claiming effective date 2026-10-01, and confirm the system rejects the conflicting entry or clearly resolves precedence rather than leaving ambiguous cost calculations. |
| TEID-51-T7 | Adversarial | 2 | Ingest an event with an implausible actual_cost value such as -$50 or $999,999 and confirm the system flags or rejects the value rather than silently corrupting margin calculations. |

## Scoping notes for this point in the build sequence

This is the first story in a brand-new epic (E07), building on top of a
platform whose event schema was never designed with an AI-inference
"model" concept in mind. Three real gaps, found by direct inspection of
`db/migrations/20260926120000_init.sql` and
`services/ts-console/src/lib/periodCloseSummary.ts`, needed resolving
before this spec could be written:

- **`usage_events` (owned by `go-usage`, see
  `docs/adr/0001-architecture-and-api-boundary.md`) has no `model` column
  and no per-event cost column today** -- only `event_type`, `quantity`,
  `idempotency_key`, `occurred_at`. This story adds two new **nullable**
  columns to `usage_events`: `model TEXT` and `actual_cost NUMERIC`. Both
  are optional at ingestion (a caller that never sends them sees no
  behavior change at all) and neither is read by the pricing/ledger
  engine -- enforcing AC3 structurally, not just by convention: there is
  no code path from these two columns to anything that computes a
  customer's invoice. This is a `go-usage`-owned migration and API
  change (ingestion request/response shape), since `go-usage` owns
  `usage_events` and no other service may write to it directly.
- **"Metric" is not a separate dimension anywhere in this schema today.**
  The existing per-unit billing dimension this whole platform already
  bills on is `usage_events.event_type` (e.g. `"api_call"`,
  `"tokens"` -- tenant-defined, free-form). Rather than inventing a
  second free-form dimension that would duplicate it, this story treats
  **`event_type` as "metric"** for cost-table purposes. The cost table is
  therefore keyed on `(tenant_id, model, metric)` where `metric` is
  literally the event's own `event_type` value -- a cost-table row for
  `model="gpt-4-class", metric="tokens"` applies to any `usage_events` row
  with `model='gpt-4-class' AND event_type='tokens'`. Do not add a
  separate `metric` column to `usage_events` -- `event_type` already is
  it.
- **Per-table ownership means `go-usage` cannot call into `ts-console`
  during ingestion, and the cost table is operator-facing CRUD (naturally
  `ts-console`'s domain, matching how `plans`/`grants`/`rate_overrides`
  already work).** T4's "cost lookups at ingestion time remain under 100ms"
  is read here as "at cost/margin-calculation time" (i.e. when the E07
  dashboard, TEID-52, computes margin), **not** literally inside
  `go-usage`'s hot-path event-ingestion write. This keeps the ADR's
  latency boundary intact: `go-usage` only ever stores whatever `model`/
  `actual_cost` a caller sends it (a pure pass-through, no cost-table
  lookup on the hot path at all), and the actual cost-table lookup runs
  entirely inside `ts-console`, at report-generation time, against data
  it already has to pull from `go-usage` via that service's existing
  usage-query API for period-close/reporting purposes. If T4's 100ms
  budget is measured against anything, it should be measured against this
  report-time lookup (e.g. "resolving the effective rate for one
  model+metric+timestamp combination"), not against raw ingestion
  throughput.

## Architecture and design

**`go-usage` changes** (owns `usage_events`):
- New migration adding `model TEXT` (nullable) and `actual_cost NUMERIC`
  (nullable) to `usage_events`. A `CHECK (actual_cost IS NULL OR
  (actual_cost >= 0 AND actual_cost < 1000000))` constraint is the
  database-level backstop for T7 (mirrors the existing
  `usage_events_quantity_max` defense-in-depth pattern from
  `20260927143257_usage_quantity_cap.sql` -- app-level validation is the
  real rejection point per T7, this is the backstop).
- Extend the existing usage-ingestion request shape to accept optional
  `model`/`actual_cost` fields, stored as-is. Reject (app-level, before
  the DB constraint is ever reached) an `actual_cost` that is negative or
  implausibly large (pick a concrete ceiling and document it in code --
  the spec deliberately doesn't pin an exact number beyond "orders of
  magnitude beyond any plausible per-event cost," since that's an
  implementation judgment call, not an architectural one).

**`ts-console` changes** (new, operator-facing):
- New table `cost_rates`:
  ```sql
  CREATE TABLE cost_rates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    model TEXT NOT NULL,
    metric TEXT NOT NULL,          -- matches usage_events.event_type
    rate_per_unit NUMERIC NOT NULL CHECK (rate_per_unit >= 0),
    unit_size INT NOT NULL DEFAULT 1 CHECK (unit_size > 0), -- e.g. 1000 for "per 1,000 tokens"
    effective_from TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, model, metric, effective_from)
  );
  ```
  RLS tenant-isolated, same pattern as every other tenant-scoped table.
  The `UNIQUE` constraint is T6's actual enforcement point for the
  identical-effective-date case; a non-identical but still overlapping
  case (there isn't really such a thing with a single `effective_from`
  per row -- "effective until superseded" semantics, not a date range --
  so T6's "overlapping" scenario reduces to "same `(model, metric,
  effective_from)` twice," which the constraint rejects outright).
- Cost resolution for a given `(model, metric, timestamp)`: the
  applicable rate is the row with the latest `effective_from <=
  timestamp` for that `(tenant_id, model, metric)` -- a single indexed
  query (`ORDER BY effective_from DESC LIMIT 1` with a `WHERE
  effective_from <= $1` filter), which is what T4's 200-models/5-metrics
  scale test is actually measuring the latency of.
- `POST /cost-rates` (create a new effective-dated entry), `GET
  /cost-rates` (list, filterable by model/metric) -- role-gated the same
  way plan/rate-override admin routes are. T5 ("takes effect without a
  deployment") is satisfied automatically by this being ordinary
  operator-facing CRUD against a table the margin calculation reads live
  -- no code change is needed for a new rate to take effect, so this test
  is really just confirming there's no cache with a stale TTL sitting in
  front of the lookup.
- Margin/cost resolution function (`resolveEventCost(event, tenant)`):
  if `event.actual_cost` is non-null, use it directly (AC2/T2); otherwise
  look up the effective `cost_rates` row for `(event.model, event.event_type,
  event.occurred_at)` and compute `rate_per_unit * (event.quantity /
  unit_size)`. This function is what TEID-52 (the margin dashboard, next
  story in this epic) will call per event or per aggregate -- this story
  only needs to implement and unit-test the function itself plus the
  `cost_rates` CRUD, not a dashboard UI.

## Implementation guidance per test

### TEID-51-T1
Insert two `cost_rates` rows for the same `(model, metric)`:
`effective_from = 2026-10-01` at rate `$0.02` and `effective_from =
2026-11-01` at rate `$0.015` (both `unit_size = 1000`). Call the cost
resolution function with timestamps on either side of the transition
(e.g. `2026-10-15` and `2026-11-15`) and assert each returns the correct
rate.

### TEID-51-T2
Ingest a `usage_events` row with `actual_cost = "0.0187"` and a `model`/
`event_type` that also has a `cost_rates` entry with a different rate.
Call the cost resolution function against that event and assert it
returns exactly `0.0187`, never touching `cost_rates` for that event.

### TEID-51-T3
Create a plan/rate-override-driven customer invoice amount for a model
before and after changing that model's `cost_rates` entry from `$0.02`
to `$0.05`. Assert the customer-facing price (from the existing
pricing/plan-rate path, untouched by this story) is bit-for-bit
identical before and after -- this is a negative test: assert nothing in
the pricing/ledger code path reads from `cost_rates` at all (e.g. grep
the pricing module's imports in the test, or assert the invoice total
function's output is unchanged when `cost_rates` is mutated out from
under it mid-test).

### TEID-51-T4
Seed 200 distinct `model` values × 5 `metric` values, each with 3-4
effective-dated `cost_rates` rows (so roughly 3,000-4,000 rows total).
Run the cost resolution function 100+ times against randomly chosen
`(model, metric, timestamp)` combinations and assert each individual
lookup completes in under 100ms (measure wall-clock around the function
call, not around an HTTP round trip).

### TEID-51-T5
Via `POST /cost-rates`, add a new effective-dated entry, then
immediately call the cost resolution function (same process, no
restart/redeploy) for a timestamp after that entry's `effective_from`
and assert it returns the new rate.

### TEID-51-T6
`POST /cost-rates` twice with identical `(model, metric, effective_from)`
and different rates. Assert the second call is rejected (409 or 400,
your choice, but documented) with a clear "a rate already exists for
this model/metric/effective date" message, and that only the first
row exists afterward.

### TEID-51-T7
Attempt to ingest `usage_events` rows with `actual_cost = -50` and
`actual_cost = 999999` (or whatever ceiling the implementation settles
on, as long as it's clearly past any plausible per-event cost). Assert
both are rejected at the API level (4xx, not silently clamped or
stored), and that no row with either value exists in `usage_events`
afterward.

## File layout

- `services/go-usage/db/migrations/` (or wherever `go-usage`'s own
  migration convention lives -- follow it, not `services/ts-console`'s)
  -- the two new nullable columns plus the `CHECK` constraint on
  `usage_events`.
- `services/go-usage/internal/...` -- extend the usage-ingestion request
  type and validation to accept/validate `model`/`actual_cost`.
- `db/migrations/<timestamp>_cost_rates.sql` -- the new `ts-console`-owned
  `cost_rates` table.
- `services/ts-console/src/lib/costRates.ts` (new) -- `resolveEventCost`,
  the effective-dated lookup query.
- `services/ts-console/src/routes/costRates.ts` (new) -- `POST`/`GET
  /cost-rates`.
- `tests/cost-analytics/cost-rates.test.ts` (new directory, following
  this repo's one-directory-per-story-area convention) -- TEID-51-T1
  through T7.
- `docs/api/cost-rates.md` -- document the new routes so
  `tests/docs/coverage.test.ts` stays green.

## Definition of done

- [ ] Every acceptance criterion above is satisfied by working code.
- [ ] Every cataloged test has a real automated test that passes --
      functional, non-functional, and adversarial alike.
- [ ] `go vet` and `tsc --noEmit` are both clean.
- [ ] The suite passes against a database rebuilt from scratch using only
      committed migration/seed scripts (not just the developer's already-
      warm local state).
- [ ] PR description includes a checklist mapping each test ID to the
      file/line that covers it.
