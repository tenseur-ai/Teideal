# STATUS TEID-18

Story implemented on branch `grok/teid-18-consumption-order` against `specs/TEID-18.md`. Concerns and judgment calls are in `NOTES-TEID-18.md`.

Pull request: https://github.com/Sathyanarayan-Kiran/Teideal/pull/17 (base `claude/eager-brown-dlqfl4`, references issue #14).

## What landed

- `db/migrations/20260927153352_consumption_order.sql` — `plans.consumption_order`, `customer_consumption_overrides`, `usage_consumptions`, `usage_consumption_lines`, with the same RLS enable/force, tenant policy, and GRANT shape as the other migrations. The two usage tables are `SELECT, INSERT` only.
- `services/ts-console/src/lib/plans.ts` — optional `consumption_order` on create and patch, validated by the shared permutation helper, written through the existing draft `UPDATE`.
- `services/ts-console/src/lib/consumptionOrder.ts` — permutation validator, effective-order resolver (customer override, then plan, then default, with the missing-source fallback), deterministic sort, and the locked multi-grant draw.
- `services/ts-console/src/routes/consumptionOrder.ts` — `PUT` and `GET /customers/:id/consumption-order`, both through `consoleRoute`.
- `services/ts-console/src/routes/consumption.ts` — `POST /customers/:id/consume` and `GET /customers/:id/consumption-timeline`, both through `consoleRoute`.
- `services/ts-console/src/lib/roleGuard.ts` — `consoleRoute` accepts `put`, which the helper did not list before.
- `services/ts-console/src/server.ts` — both route modules registered next to the grant routes.
- `tests/consumption-order/` — TEID-18-T1 through TEID-18-T9, plus one extra draft-plan round-trip that is not a catalog id.
- `tests/cross-tenant/consumption-isolation.test.ts` — acct_1001 against acct_1002 for the new customer routes.
- `.github/workflows/ci.yml` — `npm ci` and `vitest run` for `tests/consumption-order`, immediately after the `tests/grants` step.

`routes/plans.ts` was not edited. It already passes the whole validated patch into `updateDraftPlan`.

## How it was run

Postgres is the existing container `teideal-postgres-grok18` on `127.0.0.1:5434`. Migrations were reapplied with:

`CI=true PGPASSWORD=postgres TEIDEAL_PG_CONTAINER=teideal-postgres-grok18 bash db/setup-local.sh`

(The shell is PowerShell, so the variables were set with `$env:` and the script was invoked as `bash db/setup-local.sh`.) The new migration applied: `ALTER TABLE` on `plans`, then `CREATE TABLE` / policies / grants for the three new tables. Re-applying older migrations printed "already exists" errors. `psql` is not invoked with `ON_ERROR_STOP`, so the script still exited 0. That behavior predates this story. The database was already seeded; the seed scripts were not rerun.

`services/ts-console`: `npm ci` (exit 0), `npm run build` (exit 0), `npx tsc --noEmit` (exit 0, no diagnostics).

Server under test:

`PORT=8081 DATABASE_URL=postgres://teideal_app:teideal_app_dev_password@127.0.0.1:5434/teideal ADMIN_SECRET=dev_admin_secret NODE_ENV=test node dist/server.js`

It logged `ts-console: listening on http://127.0.0.1:8081`. `NODE_ENV=test` matches CI, so the grant and export timers did not run. A later restart added `GOOGLE_JWKS_URL=http://127.0.0.1:8090/jwks`, `GOOGLE_ISSUER=http://127.0.0.1:8090`, `GOOGLE_AUDIENCE=teideal-console-test` so the console-auth and rbac Google cases could run. The consumption-order suite had already passed against the first process.

## Cataloged tests

`tests/consumption-order`, vitest 5.0.2, one full run with the CI defaults (`CONSUMPTION_ORDER_FUZZ_SETS` unset so 20, `CONSUMPTION_ORDER_FUZZ_REPLICAS` unset so 5, `CONSUMPTION_SPLIT_LATENCY_BUDGET_MS` unset so 100):

```
Test Files  1 passed (1)
     Tests  10 passed (10)
  Start at  21:37:28
  Duration  5.35s (tests 95%, transform 3%, import 2%)
```

That is TEID-18-T1 through TEID-18-T9, all passing, plus the extra draft-plan `consumption_order` round-trip. T6 therefore ran 20 sets × 5 replicas = 100 consume calls, not the catalog 1000 × 50 = 50,000. Those catalog numbers were not executed in this session. T7's assertion is `elapsed < 100` around the single five-grant `POST`. The test passed, so that call was under 100ms. The suite does not print the raw sample.

## Other suites run in this session

Same server and `DATABASE_URL` on port 5434. vitest 5.0.2.

`tests/cross-tenant`:

```
Test Files  11 passed (11)
     Tests  45 passed (45)
  Duration  7.63s
```

That includes `consumption-isolation.test.ts` (4 tests) and the pre-existing isolation files, including the RLS audit over every `tenant_id` table.

`tests/plans`:

```
Test Files  1 passed (1)
     Tests  9 passed (9)
  Duration  1.15s
```

`tests/grants`:

```
Test Files  1 passed (1)
     Tests  9 passed (9)
  Duration  3.33s
```

`tests/rbac`: first run was 7 passed, 1 failed. TEID-43-T4 died with `connect ECONNREFUSED 127.0.0.1:8090` because fake Google was not up yet. After `FAKE_GOOGLE_PORT=8090 npx tsx fake-google.ts` and a server restart with that issuer:

```
Test Files  1 passed (1)
     Tests  8 passed (8)
  Duration  2.52s
```

`tests/audit-log`, with `SUPERUSER_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5434/teideal`. An earlier attempt failed in `finally` cleanup because the suite's default superuser URL is port 5432, which is not this container. The rerun:

```
Test Files  1 passed (1)
     Tests  7 passed (7)
  Duration  109.91s
```

`tests/console-auth`, fake Google on 8090, server using that JWKS:

```
Test Files  9 passed (9)
     Tests  13 passed (13)
  Duration  17.27s
```

`tests/api-keys`: 7 passed, 2 failed. TEID-92-T1 and TEID-92-T4 expected `GET` through go-usage to return 200 and got 401 (`api-keys.test.ts` lines 63 and 120, `usageGet`). go-usage was not started in this session. Something already answering on port 8082 rejected the key. The ts-console key routes in those tests were not the failing assertion. I am not claiming the api-key suite passed.

Not run here: `tests/data-export`. It needs the fake S3 process and `AWS_ENDPOINT_URL_OVERRIDE` on the server, which this process did not have. The new tables are not export sources. CI will run that suite on a clean database.

## Deviations

Documented in `NOTES-TEID-18.md`. Short version:

- TEID-18-T2 adds a goodwill grant. Without it the fallback rule rejects the override, because every valid order names goodwill and T1's four grants do not include one. The 400-credit draw still starts with paid and does not touch goodwill.
- Plan lookup selects `plans.consumption_order` and compares the plan id to `NULL`. No customer-to-plan row exists, so the query matches nothing on every consume.
- Promotional grants break expiry ties with `created_at`, then `id`. The locked `SELECT` adds `created_at` and `ORDER BY id` before `FOR UPDATE`.
- Line ids are UUIDv7 so `ORDER BY id` is draw order. The table has no position column.
- Uncovered amount is an overage line. TEID-18-T8 saw 10 fully covered responses and 10 single overage lines. Drawn grant amount was 1000, equal to the two grants' starting balance.
- `PUT /customers/:id/consumption-order` returns 200. The spec states the 400 text and not the success status.
- A customer the caller cannot see gets 403 `customer not found for this tenant` on the new routes.
- Consume does not write `grant_ledger_entries` or `audit_log`. The override upsert does write `audit_log` as `CustomerConsumptionOverride`.

## Commits

- `37f77ce` TEID-18: add consumption-order tables
- `aba6412` TEID-18: draw credits in a configured consumption order
- `912d8b6` TEID-18: cover consumption-order acceptance tests and tenant isolation
