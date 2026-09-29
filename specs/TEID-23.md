# TEID-23: Versioned pricing and scheduled migrations

| | |
|---|---|
| Epic | TEID-1 (E01 -- Implement entitlement model and pricing configuration) |
| Phase | E01 |
| Priority | High |
| Points | 8 |
| Release | mvp |
| Order | 35 (immediately after TEID-22) |
| Depends on | `plans`/`plan_rates`/`version` (TEID-16), `customer_billing_config` (TEID-96, read-only cross-service), `resolveEffectiveRate`/`POST /customers/:id/price-usage` (TEID-20), `recordConfigChangeWithClient` (TEID-42) |

## Story (verbatim from the live board)

> As a billing operator, I want to publish a new pricing version and choose when, or whether, each customer moves to it, so that I can reprice safely whenever model costs change.
>
> *Context*
> Prices change every few months. Old and new logic must never collide within a billing period.

## Acceptance criteria (verbatim from the live board)

1. Publishing changes to a plan creates a new version; existing subscriptions stay on their current version.
2. An operator can schedule customers to move to a new version at their next period boundary or a chosen date.
3. An operator can keep (grandfather) any customer on an old version indefinitely.
4. Every priced usage event records the plan version used, and no single event is priced by two versions.
5. Before a migration runs, the operator sees how many customers will move and when.

## Cataloged tests (verbatim from the live board)

| ID | Type | AC | Title |
|---|---|---|---|
| TEID-23-T1 | Functional | 1 | Publish a rate change to the Growth plan creating version 2, and confirm all 300 existing subscribers remain on version 1 with no pricing change to their next invoice. |
| TEID-23-T2 | Functional | 2 | Schedule customer ACME-014 to migrate to version 2 at their next period boundary of 2026-11-01, and confirm the subscription record shows a pending migration date and the customer is still priced under version 1 until that date. |
| TEID-23-T3 | Functional | 3 | Mark customer LegacyCo as grandfathered on version 1, publish versions 2 and 3 of the plan, and confirm LegacyCo remains on version 1 with no scheduled migration after both publishes. |
| TEID-23-T4 | Functional | 4 | Submit a usage event that lands exactly at the scheduled migration boundary timestamp and confirm the ledger records a single plan_version field with no event split or duplicated pricing across version 1 and version 2. |
| TEID-23-T5 | Functional | 5 | Before running a scheduled migration from version 1 to version 2, open the migration preview screen and confirm it lists the exact count of customers that will move and their scheduled move date, matching the actual customers migrated once the job runs. |
| TEID-23-T6 | Non-functional | 5 | Generate a migration preview for a plan with 25000 subscribed customers and confirm the preview count renders within 5 seconds. |
| TEID-23-T7 | Non-functional | 4 | Under a load of 10000 events per second during an active version migration window, confirm zero events are recorded with an ambiguous or missing plan_version field. |
| TEID-23-T8 | Adversarial | 1 | Attempt to publish a new plan version while a prior publish for the same plan is still processing, and confirm the system serializes the operations rather than producing two version 2 records. |
| TEID-23-T9 | Adversarial | 3 | Set a customer as grandfathered and simultaneously schedule them for migration via a race between two operator actions, and confirm the system resolves the conflict deterministically rather than leaving the customer in an inconsistent state. |

## Scoping notes for this point in the build sequence

- **No customer-to-plan assignment exists anywhere in this codebase --
  the same gap TEID-20's own spec already flagged and left unresolved.**
  This story cannot avoid it: AC1's "existing subscriptions stay on
  their current version" presupposes subscriptions exist. This story
  introduces the first one, `customer_plan_subscriptions`, and every
  test (**T1**'s "300 existing subscribers", **T2**'s ACME-014,
  **T3**'s LegacyCo) seeds it directly as fixture setup.
- **"Version" is a new `plans` row, not a mutation of the existing
  one.** `plans.version` already exists (TEID-16) but today is always
  literally `1`, set once at publish with no way to create a second
  version -- confirmed by grep, this is genuinely new functionality,
  not an extension of something partially built. Each version becomes
  its own `plans` row sharing a new `plan_family_id` (the stable
  identity of "the Growth plan" across all its versions); a fresh
  `plans` row is set to its own id as `plan_family_id` when first
  created. **This requires zero changes to `plan_rates`,
  `priced_usage_lines`, or `resolveEffectiveRate`** -- all of them
  already key off a specific `plan_id`, and a specific `plan_id` now
  simply *is* a specific version. **AC4**'s "every priced usage event
  records the plan version used" is therefore already true by
  construction: `priced_usage_lines.plan_id` (TEID-20) already records
  exactly this.
- **Migration is computed at read time, never a batch job that mutates
  state.** AC2/AC5 describe scheduling and "running" a migration in
  procedural language, but the simplest, most race-free design needs no
  batch process at all: `resolveEffectivePlanId(customerId, asOf)` is a
  pure function of the subscription row's stored fields (`current_plan_id`,
  `scheduled_plan_id`, `scheduled_migration_date`) -- once `asOf` passes
  the scheduled date, every subsequent call simply returns the new
  plan id, with nothing to run, nothing to batch, and no window where
  a "job" could be mid-flight. This is what makes **T4**'s "lands
  exactly at the boundary, no split, no duplication" and **T7**'s
  10,000/sec zero-ambiguity requirement trivial: each request resolves
  independently from one indexed row read plus a timestamp comparison,
  not from shared mutable state. **T5**'s "matching the actual
  customers migrated once the job runs" holds precisely because there
  is no separate job to diverge from the preview -- the preview and the
  real resolution are the same read, just filtered differently (see
  below).
- **The "next period boundary" this story computes is a scheduling
  convenience, not TEID-96's exact ingestion-grade boundary logic.**
  TEID-96's `period.Boundaries` lives in `go-usage` (Go); this story's
  own domain is `services/ts-console` (plan/subscription configuration,
  same as TEID-16 through TEID-22). Porting Go to TypeScript for one
  scheduling helper is not warranted -- a small, new TS function
  computes "the next monthly anchor-day boundary after now" in the
  customer's configured timezone (read from `customer_billing_config`,
  already an established cross-service read, same pattern
  `customer_billing_config`'s own migration comment documents), reusing
  the same anchor-day-clamped-to-month-length rule TEID-96 uses, without
  claiming DST-edge-case parity with TEID-96's own battle-tested
  ingestion-path implementation -- appropriate for scheduling a future
  migration date, not for pricing a specific instant.
- **T8's serialization is a single unique index, not a lock service.**
  `(plan_family_id, version) WHERE version IS NOT NULL` as a partial
  unique index: two concurrent "publish a new version" calls both
  compute "next version = current max + 1" and race to insert; Postgres
  guarantees only one succeeds, the loser gets a real constraint
  violation, caught and retried once (recomputing the new max, which
  now reflects the winner's insert) -- the same
  compute-then-catch-then-retry shape already used for TEID-38's
  concurrent customer-linking race, applied here to version numbers.
- **T9's determinism is two fields always changing together, under one
  row lock -- not a priority rule between two actions.**
  `setGrandfathered(true)` always clears `scheduled_plan_id`/
  `scheduled_migration_date` in the same statement;
  `scheduleMigration(...)` always clears `grandfathered` in the same
  statement. Both operations `SELECT ... FOR UPDATE` the same
  `customer_plan_subscriptions` row first, so two concurrent calls
  serialize on that lock -- whichever commits second simply overwrites
  the first's effect completely and consistently (never a partial mix
  of "grandfathered AND scheduled"), which is what "resolves the
  conflict deterministically" concretely means: the row can never hold
  a self-contradictory combination, by construction, regardless of
  which operation wins the race.

## Architecture and design

### Schema

New migration `db/migrations/20260929123000_plan_versions.sql`:

```sql
ALTER TABLE plans ADD COLUMN IF NOT EXISTS plan_family_id UUID;
UPDATE plans SET plan_family_id = id WHERE plan_family_id IS NULL;
ALTER TABLE plans ALTER COLUMN plan_family_id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS plans_family_version_uniq
  ON plans (plan_family_id, version) WHERE version IS NOT NULL;
CREATE INDEX IF NOT EXISTS plans_plan_family_id_idx ON plans (plan_family_id);

CREATE TABLE IF NOT EXISTS customer_plan_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL UNIQUE REFERENCES customers(id),
  plan_family_id UUID NOT NULL,
  current_plan_id UUID NOT NULL REFERENCES plans(id),
  grandfathered BOOLEAN NOT NULL DEFAULT false,
  scheduled_plan_id UUID REFERENCES plans(id),
  scheduled_migration_date TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((scheduled_plan_id IS NULL) = (scheduled_migration_date IS NULL)),
  CHECK (NOT (grandfathered AND scheduled_plan_id IS NOT NULL))
);
ALTER TABLE customer_plan_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_plan_subscriptions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_customer_plan_subscriptions ON customer_plan_subscriptions;
CREATE POLICY tenant_isolation_customer_plan_subscriptions ON customer_plan_subscriptions
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON customer_plan_subscriptions TO teideal_app;
```

The two `CHECK` constraints make the T9 guarantee structural: the
database itself refuses a row that is simultaneously grandfathered and
scheduled, or scheduled with only one of the pair set.

### `services/ts-console/src/lib/planVersions.ts` -- new file

- `publishNewVersion(client, tenantId, planFamilyId, userId, rates)`:
  `SELECT MAX(version) FROM plans WHERE plan_family_id = $1 FOR UPDATE`
  (locks every row in the family, serializing concurrent publishes at
  the row level in addition to the unique index's own backstop),
  inserts a new `plans` row (`version = max + 1`, copying the family's
  non-versioned fields -- `name`/`currency`/`billing_interval`/caps --
  from the latest version unless overridden), inserts its `plan_rates`,
  `recordConfigChangeWithClient`. On the rare unique-index race this
  locking already prevents in practice, retries once.
- `resolveEffectivePlanId(client, tenantId, customerId, asOf)`: reads
  the subscription row; if `scheduled_migration_date IS NOT NULL AND
  asOf >= scheduled_migration_date`, returns `scheduled_plan_id`;
  otherwise returns `current_plan_id`. Pure read, no mutation.
- `scheduleMigration(client, tenantId, customerId, targetPlanId, migrationDate)`:
  `SELECT ... FOR UPDATE` the subscription row, sets `scheduled_plan_id`/
  `scheduled_migration_date`, `grandfathered = false`, in one
  `UPDATE`.
- `setGrandfathered(client, tenantId, customerId, grandfathered)`:
  `SELECT ... FOR UPDATE` the subscription row; if `true`, sets
  `grandfathered = true, scheduled_plan_id = NULL, scheduled_migration_date = NULL`
  in one `UPDATE`; if `false`, sets `grandfathered = false` only.
- `nextPeriodBoundary(timezone, anchorDay, now)`: the scheduling-only
  helper described in the scoping notes -- next anchor-day date after
  `now`, clamped to month length, in `timezone`.
- `previewMigration(client, tenantId, targetPlanId)`: `SELECT
  scheduled_migration_date, count(*) FROM customer_plan_subscriptions
  WHERE scheduled_plan_id = $1 GROUP BY scheduled_migration_date` -- one
  aggregate query, not a per-customer loop (**T6**'s 25,000-customer/
  5-second budget).

### `POST /plans/:planFamilyId/versions` (AC1, T1, T3, T8)

New file `services/ts-console/src/routes/planVersions.ts`,
`consoleRoute`, role `["Owner", "Billing Admin"]`. Body: the new
version's rates (same shape `POST /plans` already accepts for
`plan_rates`). Calls `publishNewVersion`. Returns `201` with the new
version's full plan record. Never touches
`customer_plan_subscriptions` -- no customer moves as a side effect of
a publish (**T1**, **T3**'s "no scheduled migration after both
publishes").

### `POST /customers/:id/subscription` (fixture/bootstrap surface, T1/T2/T3)

Same file, same role gate. Body `{plan_id}`. Creates or replaces the
customer's `customer_plan_subscriptions` row with
`current_plan_id = plan_id`, `plan_family_id` read from that plan. This
is the first-ever "assign a customer to a plan" surface in this
codebase -- every prior story's tests either priced against an
explicit `plan_id` per call (TEID-20) or didn't need a subscription
concept at all.

### `POST /customers/:id/subscription/schedule-migration` (AC2, T2, T9)

Same file, same role gate. Body `{target_version}` (resolved to
`scheduled_plan_id` via the subscription's own `plan_family_id`) plus
**either** `{migration_date}` **or** `{use_next_period_boundary: true}`
(resolved via `nextPeriodBoundary`, reading the customer's
`customer_billing_config`). Calls `scheduleMigration`.

### `POST /customers/:id/subscription/grandfather` (AC3, T3, T9)

Same file, same role gate. Body `{grandfathered: boolean}`. Calls
`setGrandfathered`.

### `GET /plans/:planFamilyId/versions/:version/migration-preview` (AC5, T5, T6)

Same file, same role gate. Resolves `:version`'s `plans.id` within the
family, calls `previewMigration`. Returns
`{total: N, by_date: [{date, count}, ...]}`.

### `POST /customers/:id/price-usage` -- `plan_id` becomes optional (AC4, T4, T7)

`services/ts-console/src/routes/rateOverrides.ts`'s existing handler
(TEID-20), extended: if the request body omits `plan_id`, it is
resolved via `resolveEffectivePlanId(customerId, asOf)` before the
existing RLS-visibility check and rate resolution run, completely
unchanged from there. An explicitly-provided `plan_id` keeps its
existing exact behavior -- **zero regression risk to TEID-20's own
tests**, which all pass `plan_id` explicitly today.

## Implementation guidance per test

### TEID-23-T1
Create a plan (v1) with 300 subscriptions pointing at it. `POST
/plans/:familyId/versions` with a changed rate. Assert `201`, a new
`plans` row with `version = 2`. Assert all 300
`customer_plan_subscriptions` rows still have `current_plan_id`
pointing at v1's `plans.id`, and a price-usage call for any of them
(no explicit `plan_id`) still resolves v1's rate.

### TEID-23-T2
Subscribe ACME-014 to v1. Publish v2. `POST
/customers/:acmeId/subscription/schedule-migration` with
`target_version: 2`, `migration_date: "2026-11-01T00:00:00Z"`. Assert
the subscription row shows `scheduled_plan_id`/`scheduled_migration_date`
set. Price a usage event dated before 2026-11-01: assert it resolves
v1. 

### TEID-23-T3
Subscribe LegacyCo to v1, grandfather them. Publish v2, then v3. Assert
after each publish, LegacyCo's subscription row still has
`current_plan_id` = v1, `grandfathered = true`,
`scheduled_plan_id`/`scheduled_migration_date` both `NULL`.

### TEID-23-T4
Schedule a customer's migration for an exact timestamp `T`. Price two
usage events: one at `occurred_at = T` exactly, one at `T` minus one
millisecond. Assert the first resolves to the new version's `plan_id`
and the second to the old version's -- each recorded with exactly one
`plan_id` on its `priced_usage_lines` row, never both.

### TEID-23-T5
Schedule 20 customers to migrate to v2 across 3 distinct dates. `GET
/plans/:familyId/versions/2/migration-preview`. Assert the response's
total (20) and per-date breakdown exactly match. Advance simulated time
past all 3 dates; assert every one of those 20 customers'
`resolveEffectivePlanId` now returns v2 -- the same set the preview
named.

### TEID-23-T6
Seed 25,000 `customer_plan_subscriptions` rows scheduled to migrate to
one target version. Time the migration-preview endpoint. Assert it
returns within 5 seconds.

### TEID-23-T7
Seed a customer population straddling a migration boundary. Fire
10,000 `price-usage` calls/sec for several seconds spanning that
boundary. Assert every resulting `priced_usage_lines` row has exactly
one, non-null `plan_id`.

### TEID-23-T8
Fire two concurrent `POST /plans/:familyId/versions` calls for the same
family. Assert exactly one succeeds with `version = 2` and the other
either serializes to `version = 3` (both succeed, correctly
numbered, never colliding) or the loser's request is delayed by the
lock and completes after, still landing at a correct, non-colliding
version number -- assert `plans_family_version_uniq` is never violated
and no two rows in the family ever share a version number.

### TEID-23-T9
Fire `POST .../grandfather {grandfathered: true}` and `POST
.../schedule-migration` concurrently for the same customer. Assert the
final subscription row is **either** fully grandfathered (scheduled
fields `NULL`) **or** fully scheduled (`grandfathered = false`) --
never both, never a constraint violation surfaced to the caller as an
unhandled `500`.

## File layout

- `db/migrations/20260929123000_plan_versions.sql` -- `plans.plan_family_id`,
  new `customer_plan_subscriptions` table.
- `services/ts-console/src/lib/planVersions.ts` -- new:
  `publishNewVersion`, `resolveEffectivePlanId`, `scheduleMigration`,
  `setGrandfathered`, `nextPeriodBoundary`, `previewMigration`.
- `services/ts-console/src/routes/planVersions.ts` -- new: `POST
  /plans/:planFamilyId/versions`, `POST /customers/:id/subscription`,
  `POST /customers/:id/subscription/schedule-migration`, `POST
  /customers/:id/subscription/grandfather`, `GET
  /plans/:planFamilyId/versions/:version/migration-preview`.
- `services/ts-console/src/routes/rateOverrides.ts` -- extended:
  `plan_id` optional on `POST /customers/:id/price-usage`.
- `services/ts-console/src/server.ts` -- register the new route file.
- Tests: new directory `tests/plan-versions/` implementing all 9
  cataloged tests, following `tests/rate-overrides/`'s conventions.
- `tests/cross-tenant/` -- extended with cases for the five new
  endpoints.

## Definition of done

- [ ] All 5 acceptance criteria satisfied by working code.
- [ ] All 9 cataloged tests have real automated tests that pass --
      functional, non-functional, and adversarial alike.
- [ ] `tsc --noEmit` clean in `services/ts-console`.
- [ ] `tests/plans` (TEID-16, unchanged), `tests/rate-overrides`
      (TEID-20, unchanged, including every existing test's explicit
      `plan_id` behavior), `tests/grants`, `tests/consumption-order`,
      `tests/commits`, `tests/cross-tenant`, `tests/api-keys`,
      `tests/customer-hierarchy` all still pass unchanged.
- [ ] Full suite passes against a database rebuilt from scratch via
      `db/setup-local.sh` plus the existing seed scripts.
- [ ] PR description maps each test ID to its file/line.
