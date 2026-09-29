# TEID-23 implementation notes

The story is implemented as specified: a new plans row per version, lazy
`resolveEffectivePlanId`, and no changes to `plan_rates`,
`priced_usage_lines`, or `resolveEffectiveRate`. The points below are
places where the spec's SQL or function text could not be applied
literally, and the local run of T7.

## `plan_family_id` on existing inserts

The architecture SQL adds `plans.plan_family_id UUID NOT NULL` with no
default. Every existing `INSERT INTO plans` (POST /plans, plan tests,
cross-tenant fixtures) omits the column, and a column DEFAULT cannot
refer to `id`. The migration installs `BEFORE INSERT` trigger
`plans_set_plan_family_id`: if `id` is still null it assigns
`gen_random_uuid()`, then if `plan_family_id` is null it copies `id`.
An explicit family id on a later version is left alone. Checked as
superuser: an insert that omits the column returns the same uuid for
`id` and `plan_family_id`.

## Locking a family while computing the next version

`SELECT MAX(version) ... FOR UPDATE` is rejected by Postgres (FOR UPDATE
cannot combine with an aggregate). `publishNewVersion` locks the family
rows (`SELECT id, version ... FOR UPDATE`) and computes the max in
application code. The partial unique index `plans_family_version_uniq`
is still the backstop.

A unique violation aborts the whole transaction, and the function is
given the caller's client, so it cannot open a second connection to
retry. The insert runs under `SAVEPOINT plan_version_publish`. On
`23505` for `plans_family_version_uniq` it rolls back to that savepoint
and retries once in the same transaction (the TEID-38
compute-then-catch-then-retry shape).

A family whose rows are all drafts (`version` null) returns 409
"publish the plan before creating another version". `POST /plans/:id/publish`
already owns version 1; handing version 1 out here would collide with
that publish.

## Fields copied onto a new version

The spec lists name, currency, billing interval, and caps. `consumption_order`
is also a plan column (TEID-22's migration) and is copied with the rest,
overridable in the publish body the same way. Rates are required. Caps
and `consumption_order` use a presence flag so an explicit null clears
the copied value.

## Replacing a subscription

`customer_id` is globally UNIQUE and `teideal_app` has no DELETE on
`customer_plan_subscriptions`, so a second `POST /customers/:id/subscription`
is `ON CONFLICT (customer_id) DO UPDATE`. The update sets the new plan
and clears `grandfathered` and both scheduled fields, which is the row a
delete-and-insert replacement would have left. That also keeps the two
CHECK constraints satisfied.

## Billing anchor when no config row exists

`use_next_period_boundary` with no `customer_billing_config` row uses
UTC and anchor day 1, the same default TEID-96 uses. `nextPeriodBoundary`
returns the next monthly anchor strictly after `now` (an instant that
lands on the anchor schedules the following month), with the anchor day
clamped to the month length. It does not claim TEID-96's DST parity.

## Price-usage when `plan_id` is omitted

An omitted `plan_id` is resolved with `resolveEffectivePlanId` before
the existing plan visibility check. No subscription row returns 404
"no plan subscription for this customer". An explicit JSON `null` still
returns 400 "plan_id is required". A call that already passes `plan_id`
follows the previous path.

## Preview index

The spec's SQL does not index `scheduled_plan_id`. The migration adds
`customer_plan_subscriptions_scheduled_plan_id_idx` so T6's
`GROUP BY scheduled_migration_date` at 25,000 rows is one aggregate.
T6's preview returned inside the 5 second budget.

## T7 throughput on this machine

The catalog asks for 10,000 price-usage calls per second for several
seconds, with zero ambiguous or missing plan ids. The test drives the
real `POST /customers/:id/price-usage` handler (plan id omitted) for
`PLAN_VERSION_LOAD_SECONDS` (default 3) at concurrency
`min(64, max(8, floor(rate/100)))`, the same worker-until-deadline
shape as TEID-30. The pass condition it asserts is that every response
is 201, events before the boundary record version 1, events at the
boundary record version 2, and every stored `priced_usage_lines.plan_id`
matches and is non-null.

The default pool is 10. The local run stored 703 priced rows between
`2026-09-29 10:46:48.168Z` and `10:46:51.294Z` (3.126 seconds), about
225 events per second. That is the rate this process reached. It is
below 10,000/s. None of those 703 rows had an ambiguous or missing
plan id.

## How the local database was built

`db/setup-local.sh` shells out to `psql` and, outside CI, `sudo -u
postgres`. This Windows host has neither. The same migration files were
applied in filename order inside the `teideal-postgres` container
(`psql -U postgres -d teideal -v ON_ERROR_STOP=1`). The fixture and
console-auth seed scripts were applied as the equivalent SQL, and
`tests/cross-tenant/.fixtures.json` was written locally (gitignored).
Suites that call go-usage used `GO_USAGE_URL=http://127.0.0.1:8083`
because port 8082 was already taken by another worktree.
