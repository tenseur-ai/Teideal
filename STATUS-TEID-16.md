# STATUS-TEID-16

Story TEID-16 (define plans as configuration) is implemented on branch `grok/teid-16-plans-as-config`. This file records what was actually run in this working tree. A later from-scratch rebuild should not treat these results as a substitute for its own run.

## Implemented

- `db/migrations/20260927130701_plans.sql` creates `plans` and `plan_rates` with the spec's columns, checks, RLS enable/force, tenant policy, and grants. `plan_rates` is granted `DELETE` so a draft edit can replace its rate rows. Applied to the local Postgres (`teideal-postgres-grok`, port 5434) with `db/setup-local.sh`.
- `services/ts-console/src/lib/plans.ts` has `validatePlanInput`, `insertPlan`, `insertPlanRates`, `replacePlanRates`, and `shapePlanRecord`, plus the read, list, draft-update, and publish queries the routes use.
- `services/ts-console/src/routes/plans.ts` registers `POST /plans`, `GET /plans`, `GET /plans/:id`, `PATCH /plans/:id`, and `POST /plans/:id/publish`. Each one goes through `consoleRoute` inside an `app.register` block whose `preHandler` is `requireSession`. Mutations call `recordConfigChangeWithClient` on the same tenant transaction. Publish is one conditional `UPDATE ... WHERE status = 'draft'`.
- `services/ts-console/src/server.ts` registers those routes next to the other session-authenticated registrations.
- `db/seed-console-auth-fixtures.sh` adds `jane@acme.com` / `JanePass123!` as a Billing Admin on acct_1001, MFA enrolled with the existing billing-admin fixture secret `KRSXG5CTMVRXEZLU`. No fixture user had that email.
- `tests/plans/` mirrors `tests/api-keys/` and contains TEID-16-T1 through T9.
- `tests/cross-tenant/plan-isolation.test.ts` checks acct_1001 against an acct_1002 plan id for create, list, detail, patch, and publish.
- `.github/workflows/ci.yml` installs and runs `tests/plans` immediately after the TEID-43 rbac step.

## Cataloged tests

Command (after `npm ci` and `npm run build` in `services/ts-console`, server `node dist/server.js` with `PORT=8081`, `DATABASE_URL=postgres://teideal_app:teideal_app_dev_password@127.0.0.1:5434/teideal`, `ADMIN_SECRET=dev_admin_secret`, `NODE_ENV=test`):

```
cd tests/plans
DATABASE_URL=postgres://teideal_app:teideal_app_dev_password@127.0.0.1:5434/teideal TS_CONSOLE_URL=http://127.0.0.1:8081 npx vitest run --reporter=verbose
```

Result at 19:26 local time, vitest 5.0.2: **9 passed, 0 failed**.

```
 ✓ plans.test.ts > TEID-16 plans as configuration > TEID-16-T1 creates two identical Growth-Monthly plans with matching fields 79ms
 ✓ plans.test.ts > TEID-16 plans as configuration > TEID-16-T2 persists Enterprise-Annual credits, rate, and hard cap 60ms
 ✓ plans.test.ts > TEID-16 plans as configuration > TEID-16-T3 names a missing currency and a listed metric with no rate 50ms
 ✓ plans.test.ts > TEID-16 plans as configuration > TEID-16-T4 leaves GET /customers/:id unchanged after saving draft Starter-v2 39ms
 ✓ plans.test.ts > TEID-16 plans as configuration > TEID-16-T5 publishes Starter-v2 as jane@acme.com at version 1 69ms
 ✓ plans.test.ts > TEID-16 plans as configuration > TEID-16-T6 accepts a large rate catalog inside the server budget 32ms
 ✓ plans.test.ts > TEID-16 plans as configuration > TEID-16-T7 names currency, billing_interval, and the omitted metric rate 24ms
 ✓ plans.test.ts > TEID-16 plans as configuration > TEID-16-T8 rejects included_credits of -500 without saving a plan 70ms
 ✓ plans.test.ts > TEID-16 plans as configuration > TEID-16-T9 lets only one of two concurrent publishes create version 1 55ms

 Test Files  1 passed (1)
      Tests  9 passed (9)
   Duration  1.17s
```

| ID | Result | Where |
|---|---|---|
| TEID-16-T1 | passed | `tests/plans/plans.test.ts:60` |
| TEID-16-T2 | passed | `tests/plans/plans.test.ts:108` |
| TEID-16-T3 | passed | `tests/plans/plans.test.ts:152` |
| TEID-16-T4 | passed | `tests/plans/plans.test.ts:198` |
| TEID-16-T5 | passed | `tests/plans/plans.test.ts:225` |
| TEID-16-T6 | passed | `tests/plans/plans.test.ts:269` |
| TEID-16-T7 | passed | `tests/plans/plans.test.ts:292` |
| TEID-16-T8 | passed | `tests/plans/plans.test.ts:327` |
| TEID-16-T9 | passed | `tests/plans/plans.test.ts:362` |

T6's 32ms is the whole test, including a 500-rate `POST /plans`, and the assertion is `elapsed < PLAN_RATE_LOAD_TEST_BUDGET_MS` (default 500). It passed on this machine. That number will move on CI.

## Other checks actually run

- `npx tsc --noEmit` in `services/ts-console`: exit 0, no diagnostics. `npm run build` (`tsc -p tsconfig.json`) also succeeded.
- `tests/cross-tenant` (`npx vitest run --reporter=verbose`) against the same ts-console and a go-usage built from this tree on port 8083 (port 8082 was already taken by another worktree's binary): **32 passed, 0 failed**, including all 5 cases in `plan-isolation.test.ts` and the TEID-41 RLS audit, which now sees `plans` and `plan_rates`. Duration 5.84s on the run before the final plans re-run; the plan-isolation file was not changed after that green run except that the green run already included the `body: {}` publish fix.
- `tests/rbac` filtered to `TEID-43-T5` (route manifest has no empty role list): **passed**. The other seven rbac tests were skipped by that filter.

## Not run here

I did not re-run `tests/console-auth`, `tests/audit-log`, `tests/api-keys`, `tests/data-export`, `tests/usage-ingestion`, or the unfiltered `tests/rbac` suite. Those need the fake Google IdP and/or fake S3 that this session did not start, and the ts-console process was started with `NODE_ENV=test` and without `GOOGLE_JWKS_URL`. The spec's definition of done still expects them on a from-scratch CI run. Nothing in this change edits those suites.

## Deviations

Written up in `NOTES-TEID-16.md`. Short version:

- Missing-plan detail and patch return **404** `plan not found`. The spec's architecture section says 404, then also says the later 403 lookup style would be acceptable. Export lookups in TEID-44 use 403. I followed the explicit 404 and `GET /api-keys/:id`.
- Validation failures are **400**, and the paths are `/plans` with no `/v1` prefix. That is what the spec's implementation guidance says to do instead of the story text's 422 and `/v1/plans`.
- A duplicate non-null metric/model rate is rejected with 400. The spec does not name that error; without it the unique index would surface as 500. Two null-model rows for one metric are still allowed, as the spec describes.
- Publish also sets `updated_at = now()`. The spec's `UPDATE` does not mention that column.
- JSON responses convert `NUMERIC` columns to numbers so `0.002` and `10000` round-trip as JSON numbers.

## Migrations

`db/setup-local.sh` re-applies every file and does not use `ON_ERROR_STOP`. Re-running it printed `ERROR: column ... already exists` for older `ALTER TABLE` migrations that were already applied, then continued and created `plans` and `plan_rates`. That noise is pre-existing. The new file uses `CREATE TABLE IF NOT EXISTS` and `DROP POLICY IF EXISTS`, so a second apply is quiet.
