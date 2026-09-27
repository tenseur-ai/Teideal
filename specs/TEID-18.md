# TEID-18: Configure credit consumption order

| | |
|---|---|
| Epic | TEID-1 (E01 -- Implement entitlement model and pricing configuration) |
| Phase | E01 |
| Priority | Highest |
| Points | 5 |
| Release | mvp |
| Order | 31 (within E01, directly after TEID-17) |
| Depends on | `grants`/`grant_ledger_entries` (TEID-17), `plans` (TEID-16), `consoleRoute`/`ConsoleAuth` (TEID-43), `recordConfigChangeWithClient` (TEID-42), `parseAsOf`/`shapeGrantRecord` (TEID-17, `services/ts-console/src/lib/grants.ts`) |

## Story (verbatim from the live board)

> As a billing operator, I want to define the order in which a customer's grants are used up, so that customers always consume credits in the order their contract promises.
>
> *Context*
> Customers often hold several grants at once (a promo, a paid pack, a commit). The order must be predictable and explainable.

## Acceptance criteria (verbatim from the live board)

1. The default order is: soonest-expiring promotional credits, then paid credits, then commit, then overage.
2. An operator can change the order for a plan or for a single customer.
3. Given the same grants and the same usage, the system always produces the same result.
4. When one usage event draws from more than one grant, the ledger shows each grant and the amount taken from it.
5. The customer timeline shows which grant paid for each usage event.

## Cataloged tests (verbatim from the live board)

| ID | Type | AC | Title |
|---|---|---|---|
| TEID-18-T1 | Functional | 1 | Give a customer a promotional grant expiring in 5 days, another promotional grant expiring in 20 days, a paid credit pack, and an active commit, then submit a usage event and confirm consumption draws first from the 5-day promotional grant, then the 20-day one, then paid credits, then the commit. |
| TEID-18-T2 | Functional | 2 | Override the consumption order for customer ACME-042 to paid-before-promotional, submit the same set of grants as the default-order case, and confirm the ledger shows paid credits consumed first. |
| TEID-18-T3 | Functional | 3 | Replay the identical set of grants and a 10000-unit usage event five separate times and confirm the resulting per-grant consumption breakdown is byte-for-byte identical on every run. |
| TEID-18-T4 | Functional | 4 | Submit a single usage event of 150 credits where the customer has 100 credits left in Grant A and needs 50 more from Grant B, and confirm the ledger entry shows two line items: 100 from Grant A and 50 from Grant B. |
| TEID-18-T5 | Functional | 5 | After processing a mixed-grant usage event, open the customer timeline UI and confirm it lists both consumed grants with the exact amount attributed to each against that single usage event. |
| TEID-18-T6 | Non-functional | 3 | Run the consumption-order algorithm against 1000 randomly generated grant sets with identical inputs replayed 50 times each and confirm zero non-deterministic result variance. |
| TEID-18-T7 | Non-functional | 4 | Measure ledger write latency when a single usage event must be split across 5 different grants and confirm it completes within 100 milliseconds. |
| TEID-18-T8 | Adversarial | 3 | Fire 20 concurrent usage events against a customer with exactly enough combined credit across two grants to cover half of them, and confirm the resulting grant consumption is consistent with no event double-consuming credit already allocated to another concurrent event. |
| TEID-18-T9 | Adversarial | 1 | Configure a plan-level consumption order that references a grant source type not present in the customer's account and confirm the system falls back to the documented default order rather than failing the check. |

## Scoping notes for this point in the build sequence

This story is a direct continuation of TEID-17's grants system, and inherits
the same "no real usage-triggered consumption pipeline yet" gap, plus two
new gaps of its own:

- **No customer-to-plan assignment exists** (the same gap TEID-16's own spec
  already documented -- no subscription/enrollment concept exists anywhere
  yet). AC2's "for a plan" half of "change the order for a plan or for a
  single customer" is therefore built as real, working configuration
  storage (an operator can set it, via `PATCH /plans/:id`), but it has no
  live customer to ever apply to today, exactly like TEID-16's own draft
  plans. The customer-level override is the one this story's tests actually
  exercise, since it's the one with a resolvable effect.
  - **T18-T9** literally says "plan-level" in its story text, but per the
    above, a plan-level order can never resolve to a specific customer yet.
    It's implemented against the **customer-level** override instead,
    exercising the identical fallback mechanism the story is actually
    testing (an override naming a source the customer holds no eligible
    grants of falls back to the default order for that call) --
    mechanically identical, just through the override path that's
    reachable today.
- **AC1's default order lists three real grant sources (promotional, paid,
  commit) plus the always-implicit final "overage" -- it does not place
  `goodwill`** (a fourth valid source from TEID-17's own `grants.source`
  enum) anywhere. Scoped as: `goodwill` consumes last among real grant
  categories, after `commit` and before overage -- the most conservative
  placement (never prioritized ahead of anything the AC does name), stated
  here explicitly rather than left as an unstated assumption.
- **"The customer timeline" (AC5, T18-T5) doesn't exist as a UI** -- no
  admin console UI exists anywhere in this repo, the same gap every prior
  story's spec this session has documented. Scoped to a new `GET
  /customers/:id/consumption-timeline` endpoint -- the API surface a
  future UI would read from.
- **"Submit a usage event" (T18-T1 through T18-T8) is scoped to a new
  synthetic endpoint**, `POST /customers/:id/consume`, the same role
  TEID-17's `POST /grants/:id/consume` plays for a single grant -- this
  story's version resolves the customer's *effective order across all
  their eligible grants* and splits one requested amount across as many
  of them as needed, which is the actual mechanism under test (AC1's
  ordering, AC3's determinism, AC4's per-grant ledger split), not a
  literal `go-usage` usage event. `POST /grants/:id/consume` (single grant,
  no ordering) is unaffected and still exists for TEID-17's own tests.

## Architecture and design

### Schema: two new columns, two new tables

New migration `db/migrations/20260927153352_consumption_order.sql`:

```sql
-- AC2's plan-level half: real config, currently unreachable by any
-- customer (see scoping notes) until a customer-to-plan link exists.
ALTER TABLE plans ADD COLUMN IF NOT EXISTS consumption_order TEXT[];

CREATE TABLE IF NOT EXISTS customer_consumption_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL UNIQUE REFERENCES customers(id) ON DELETE CASCADE,
  consumption_order TEXT[] NOT NULL,
  created_by_user_id UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE customer_consumption_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_consumption_overrides FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_customer_consumption_overrides ON customer_consumption_overrides;
CREATE POLICY tenant_isolation_customer_consumption_overrides ON customer_consumption_overrides
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON customer_consumption_overrides TO teideal_app;

CREATE TABLE IF NOT EXISTS usage_consumptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id),
  requested_amount NUMERIC NOT NULL CHECK (requested_amount > 0),
  unit TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE usage_consumptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_consumptions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_usage_consumptions ON usage_consumptions;
CREATE POLICY tenant_isolation_usage_consumptions ON usage_consumptions
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT ON usage_consumptions TO teideal_app;

CREATE TABLE IF NOT EXISTS usage_consumption_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  consumption_id UUID NOT NULL REFERENCES usage_consumptions(id) ON DELETE CASCADE,
  grant_id UUID REFERENCES grants(id),
  source_category TEXT NOT NULL,
  amount NUMERIC NOT NULL CHECK (amount > 0)
);
ALTER TABLE usage_consumption_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_consumption_lines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_usage_consumption_lines ON usage_consumption_lines;
CREATE POLICY tenant_isolation_usage_consumption_lines ON usage_consumption_lines
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT ON usage_consumption_lines TO teideal_app;
```

`usage_consumption_lines.grant_id` is nullable: a `NULL` line is the
overage amount (AC1's implicit final category) -- not tied to any grant,
`source_category = 'overage'`. All three new tables are append-only after
insert (matching `grant_ledger_entries`'/`audit_log`'s own precedent) --
no `UPDATE`/`DELETE` grants beyond what's listed.

### `PATCH /plans/:id` extended with `consumption_order` (AC2, plan half)

Extend `services/ts-console/src/lib/plans.ts`'s `validatePlanInput`
overload set (the same `validateX(...)` helper pattern already used for
`included_credits`/`hard_cap`/`soft_cap`) with an optional
`consumption_order: string[]` field, validated the same way the new
`PUT /customers/:id/consumption-order` endpoint validates it (see below
-- share one validator between the two call sites rather than duplicating
the rule). No change to `routes/plans.ts` beyond passing the new field
through to the existing `UPDATE plans SET ...` statement.

### `PUT /customers/:id/consumption-order` -- customer-level override (AC2, customer half)

New file `services/ts-console/src/routes/consumptionOrder.ts` (or add to
`routes/grants.ts` -- either is fine, pick one and be consistent), Owner
or Billing Admin only, session-authed via `consoleRoute`. Body:
`{consumption_order: string[]}`. Validation: must be a permutation of
exactly `["promotional", "paid", "commit", "goodwill"]` (all four
present, no duplicates, no unknown values) -- reject with `400` naming
the problem (`"consumption_order must be a permutation of promotional,
paid, commit, goodwill"`). Upsert into
`customer_consumption_overrides` (`ON CONFLICT (customer_id) DO UPDATE`),
`recordConfigChangeWithClient`. `GET /customers/:id/consumption-order`
(any role) returns the stored override, or `{consumption_order: null}`
if none exists (meaning the default applies).

### `POST /customers/:id/consume` -- the ordered, multi-grant consumption (AC1, AC3, AC4, T18-T1..T4, T18-T6..T9)

New file `services/ts-console/src/routes/consumption.ts`, Owner or
Billing Admin only, session-authed.

Body: `{amount, unit, as_of?}` (`as_of` parsed via TEID-17's existing
`parseAsOf` from `lib/grants.ts` -- reuse it directly, don't
reimplement).

**Resolving the effective order:**
1. If a `customer_consumption_overrides` row exists for this customer
   **and** the customer currently holds at least one eligible
   (active, within start/expiry window as of `as_of`) grant in **every**
   source category the override names, use the override's order.
2. Otherwise (no override, or the override names a source the customer
   holds zero eligible grants of right now -- T18-T9's exact case), fall
   back to the default order: `["promotional", "paid", "commit",
   "goodwill"]`.
3. The plan-level `consumption_order` column is checked for
   completeness/consistency with AC2's wording but, per the scoping
   notes, never actually resolves for any real customer today (no
   customer-to-plan link exists) -- implement the lookup so it's real
   code, not a stub, but expect it to always find nothing until a future
   story adds that link.

**Selecting and locking candidate grants:** inside one transaction,
`SELECT id, remaining_amount, source, expiry_date FROM grants WHERE
customer_id = $1 AND tenant_id = $2 AND status = 'active' AND start_date
<= $as_of AND (expiry_date IS NULL OR expiry_date > $as_of) AND
remaining_amount > 0 FOR UPDATE` -- locking every currently-eligible
grant for this customer up front, in one statement, before computing any
draw. This is what makes **T18-T8** (20 concurrent consumption calls
against overlapping grants) safe: two concurrent calls for the same
customer serialize on this lock rather than both reading a
soon-to-be-stale `remaining_amount` and double-spending it. The cost is
consumption calls for the same customer never run concurrently with each
other -- an acceptable tradeoff for a financial ledger operation
(consumption calls for *different* customers are unaffected, since the
lock is scoped to one customer's rows).

**Ordering within the locked set:** group by source category per the
resolved order (step above); within the `promotional` category, sort by
`expiry_date ASC NULLS LAST` (AC1's "soonest-expiring" -- a promotional
grant with no expiry sorts last among promotionals, since it's the
least time-pressured to use up); within every other category, sort by
`(expiry_date ASC NULLS LAST, created_at ASC, id ASC)` for a fully
deterministic tie-break (AC3, T18-T3, T18-T6 -- this exact, total,
already-known ordering is what makes replaying the identical input
always produce the identical output, since nothing is left to whatever
order Postgres happens to return unordered rows in).

**Drawing:** walk the ordered list, taking `min(remaining_needed,
grant.remaining_amount)` from each grant in turn, decrementing that
grant's `remaining_amount` and inserting one `usage_consumption_lines`
row per non-zero draw (`source_category` = that grant's `source`),
until either the requested amount is fully covered or the ordered list
is exhausted. Any amount still uncovered after exhausting every eligible
grant becomes one final line with `grant_id: NULL, source_category:
'overage'`. Insert the parent `usage_consumptions` row first (or in the
same transaction, order doesn't matter as long as it's atomic).

Response: `201` with the `usage_consumptions` record plus its `lines`
array (`{grant_id, source_category, amount}` per line, in draw order).

### `GET /customers/:id/consumption-timeline` -- the "customer timeline" surface (AC5, T18-T5)

Any role, session-authed. Paginated list of `usage_consumptions` for the
customer, each with its `lines` array (a join, or two queries -- either
is fine). This is what T18-T5's "customer timeline UI" resolves to per
the scoping notes -- the API a future UI reads from.

## Implementation guidance per test

### TEID-18-T1
Create four grants for one customer: promotional expiring in 5 days,
promotional expiring in 20 days, a paid-source grant, and a
commit-source grant (all with enough `remaining_amount` to matter).
`POST /customers/:id/consume` with an `amount` that spans all four in
sequence. Assert the response's `lines` array draws from them in exactly
that order (5-day promotional, then 20-day promotional, then paid, then
commit).

### TEID-18-T2
Same four grants as T18-T1. `PUT /customers/:id/consumption-order` with
`["paid", "promotional", "commit", "goodwill"]`. `POST
/customers/:id/consume` with the same amount. Assert the `lines` array
now draws from the paid grant first.

### TEID-18-T3
Create a fixed set of grants and a 10,000-unit consumption request (as a
reusable fixture, not re-created per iteration). Run the exact same
`POST /customers/:id/consume` request five separate times (against five
distinct customers seeded identically, since a real grant's
`remaining_amount` is mutated by consumption -- "replay" here means "five
independent customers with byte-for-byte identical starting grant sets",
not five consumptions against the same exhausted grants). Assert the five
resulting `lines` arrays are identical field-for-field.

### TEID-18-T4
One customer, Grant A with `remaining_amount: 100`, Grant B with
`remaining_amount` covering at least 50 more, both in the same default-
order category so A is drawn first (e.g. both `paid`, A created earlier
so it sorts first). `POST /customers/:id/consume` with `amount: 150`.
Assert exactly two lines: `{grant_id: A, amount: 100}` and `{grant_id: B,
amount: 50}`.

### TEID-18-T5
After T18-T4's consumption, `GET
/customers/:id/consumption-timeline` and assert it lists that
consumption with both lines and their exact amounts.

### TEID-18-T6
Generate 1000 randomized grant sets (varied sources, expiry dates,
amounts) programmatically (not by hand), each replayed as 50 independent,
identically-seeded customers per set (matching T18-T3's "identical
starting state" resolution above, scaled up) with the same consumption
request. Assert every one of the 50 replicas per set produces an
identical `lines` result -- zero variance across 1000 x 50 = 50,000
total consumption calls. Scale the `1000`/`50` down for CI via env vars
(`CONSUMPTION_ORDER_FUZZ_SETS`, `CONSUMPTION_ORDER_FUZZ_REPLICAS`,
matching this repo's established load-test-scaling convention) with the
literal numbers documented as the real target for a dedicated
perf/fuzz pipeline.

### TEID-18-T7
One customer with 5 grants each covering a slice of one consumption
request (sized so all 5 are needed). Time the `POST
/customers/:id/consume` call and assert it completes within 100ms (or a
CI-scaled equivalent, `CONSUMPTION_SPLIT_LATENCY_BUDGET_MS`, documented
the same way as every other scaled load test in this repo).

### TEID-18-T8
One customer with two grants whose combined `remaining_amount` exactly
covers 10 of 20 equal-sized consumption requests. Fire all 20
concurrently (`await Promise.all(...)`). Assert exactly 10 succeed with
full coverage (no overage line) and the other 10 either fail with an
insufficient-balance-shaped response or succeed with an overage line
covering the shortfall (pick one behavior and assert it consistently --
the spec doesn't mandate rejecting a partially-coverable request, so
falling through to overage for the uncovered remainder is the simpler,
already-designed behavior; document whichever this implementation
chooses in `NOTES-TEID-18.md` if it differs from this default), and
assert the sum of all amounts actually drawn from the two grants never
exceeds their combined starting `remaining_amount` -- the concrete
meaning of "no event double-consuming credit already allocated to
another concurrent event."

### TEID-18-T9
`PUT /customers/:id/consumption-order` (the resolvable, customer-level
mechanism -- see scoping notes for why this substitutes for the story's
literal "plan-level" wording) with an order naming `goodwill` first, for
a customer who currently holds zero `goodwill`-source grants. `POST
/customers/:id/consume`. Assert the resulting `lines` draw in the
**default** order (promotional, paid, commit, goodwill), not the
configured override -- confirming the fallback.

## File layout

- `db/migrations/20260927153352_consumption_order.sql` -- `plans.
  consumption_order`, `customer_consumption_overrides`,
  `usage_consumptions`, `usage_consumption_lines`.
- `services/ts-console/src/lib/plans.ts` -- extend `validatePlanInput`
  with `consumption_order`.
- `services/ts-console/src/lib/consumptionOrder.ts` -- new: the shared
  `consumption_order` permutation validator, the effective-order
  resolver (customer override -> plan -> default, with the T18-T9
  fallback rule), and the deterministic sort used when drawing.
- `services/ts-console/src/routes/consumptionOrder.ts` -- new: `PUT`/`GET
  /customers/:id/consumption-order`.
- `services/ts-console/src/routes/consumption.ts` -- new: `POST
  /customers/:id/consume`, `GET
  /customers/:id/consumption-timeline`.
- `services/ts-console/src/server.ts` -- register the two new route
  files.
- Tests: new directory `tests/consumption-order/` (mirror `tests/grants/`'s
  shape), implementing all 9 cataloged tests.
- `tests/cross-tenant/consumption-isolation.test.ts` -- new: cross-tenant
  case for the new endpoints, matching `grant-isolation.test.ts`'s shape.
- CI: add steps to `.github/workflows/ci.yml`'s `test` job to install and
  run `tests/consumption-order`, positioned after the existing
  `tests/grants` step.

## Definition of done

- [ ] All 5 acceptance criteria satisfied by working code (AC2's
      plan-level half scoped to real-but-unreachable config per the
      scoping notes; AC5 scoped to the API surface, no UI existing).
- [ ] All 9 cataloged tests have real automated tests that pass.
- [ ] `tsc --noEmit` clean in `services/ts-console`; every new
      session-authed route goes through `consoleRoute`.
- [ ] `tests/cross-tenant`, `tests/console-auth`, `tests/audit-log`,
      `tests/api-keys`, `tests/rbac`, `tests/data-export`,
      `tests/plans`, `tests/grants` all still pass unchanged.
- [ ] Cross-tenant isolation proven in `tests/cross-tenant` for every new
      endpoint.
- [ ] Full suite passes against a database rebuilt from scratch via
      `db/setup-local.sh` plus the existing seed scripts.
- [ ] PR description maps each test ID to its file/line.
