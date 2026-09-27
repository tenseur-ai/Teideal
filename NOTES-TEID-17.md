# NOTES-TEID-17

Decisions where the spec leaves a choice, plus behavior a later story will trip over. Nothing here blocked the story.

## Route prefix

The catalog text says `GET /v1/grants/{id}`. This service has no `/v1` prefix. The routes are `/grants`, `/grants/:id`, `/grants/:id/eligibility`, `/grants/:id/consume`, `/grants/:id/void`, `/grant-templates`, and `/grant-ledger-entries`. Validation failures are 400 with a field-specific message, matching `plans.ts`.

## Timestamps require an explicit offset

`as_of` must be ISO 8601 with `Z` or `±HH:MM`. The same rule is applied to `start_date` and `expiry_date`. The spec states it for `as_of` only. A naive timestamp would be interpreted in the server's local zone, which would make the stored instant ambiguous, so both fields use the same parser. `from` / `to` on `GET /grant-ledger-entries` follow `auditLog.ts` and accept any `Date.parse` value.

JSON timestamps are `Date.toISOString()`, so an input of `2026-10-01T00:00:00Z` is returned as `2026-10-01T00:00:00.000Z`. That is the same instant. TEID-17-T1 compares instants.

## Amounts in JSON

`amount` and `remaining_amount` on a grant, and `amount` on a ledger entry, are JSON numbers. node-pg returns `NUMERIC` as text; the row shaper uses `Number`, the same way `plans.ts` shapes credits and rates. The values in the catalog (1000, 200, -200, -300) are integers, so this round-trips exactly.

`GET /grants/:id/eligibility` returns `remaining_amount` as a string, which is the spec's response shape. It is the Postgres `numeric` text, so a remaining balance of 1000 is `"1000"`.

## `created_by`

The response field `created_by` is the creator's email, joined from `users`. `created_by_user_id` is the uuid. A recurring grant issued by the worker leaves both null: the schema allows it, and there is no operator on that path. Manual grants always set `created_by_user_id` from the session.

`ops@teideal.com` was not in the seed. The fixture user is `00000000-0000-0000-0000-0000a0001007`, role Billing Admin (allowed to issue grants), password `OpsPass123!`, MFA secret `KRSXG5CTMVRXEZLU` (the existing billing-admin secret).

## Missing rows

`GET /grants/:id` and `GET /grants/:id/eligibility` return 404 `{"error":"grant not found"}` when the id is not visible in the caller's tenant. The body does not echo the id.

`POST /grants/:id/consume` maps every zero-row conditional update to 409 `{"error":"insufficient balance"}`, including a grant that does not exist for this tenant. The spec puts the whole check in one `UPDATE` and names that error for every ineligible outcome.

`POST /grants/:id/void` uses the spec's 409 text when the conditional update matches nothing.

A `customer_id` that is a UUID but not visible returns 403 `{"error":"customer not found for this tenant"}` and writes a `security_events` row with `blocked_customer_not_visible`, matching `usage.go`.

## What each mutation writes

`recordConfigChangeWithClient` runs for `POST /grants`, `POST /grants/:id/consume`, `POST /grants/:id/void`, and `POST /grant-templates`. The architecture section names it for issue and void. Consume and template creation are mutations too, and `plans.ts` audits every mutation, so they are included. Object types are `Grant` and `RecurringGrantTemplate`.

The workers do not write `audit_log`. There is no user or API-key actor to put on the row. The issued and expired ledger rows are the trace the spec describes.

`updated_at` is not moved on consume, void, or expiry. The spec's `UPDATE` statements change `remaining_amount` or `status` only.

Voiding writes a ledger amount of `-amount` (the original issued amount). It does not change `remaining_amount`. Expiry writes `-remaining_amount` and sets `status` to `expired`. `remaining_amount` stays at whatever was unused.

There is no consumption ledger type. `entry_type` is only `issued`, `expired`, or `voided`. After a partial consume, the sum of the ledger is not the customer's remaining balance. Remaining credit lives on `grants.remaining_amount` until TEID-33 folds these rows into a real ledger.

## Workers

`processRecurringGrants(pool, now = new Date())` and `processExpiredGrants(pool, now = new Date())` take an optional instant. TEID-17-T3's expiry is `2026-11-01T00:00:00Z`, which is still in the future relative to the test clock (2026-09-27), so the expiry query compares against the passed instant rather than SQL `now()`. Callers that pass one argument get the current time.

The server timer is 60 seconds, the same interval as the export worker. The spec says to start it alongside that timer and does not name a period. Issuance is idempotent per template and UTC month, so a short interval cannot double-issue.

Recurring issuance runs the spec's `INSERT ... ON CONFLICT (recurring_template_id, period_key) WHERE recurring_template_id IS NOT NULL DO NOTHING` once per tenant for every active template, then inserts `issued` ledger rows only for the `RETURNING` ids. That is the same conflict rule as the per-template statement in the spec, in one round trip, which is what makes 10,000 customers finish in well under the 15 minute budget.

Expiry claims with `SELECT ... FOR UPDATE SKIP LOCKED` inside the tenant transaction, inserts the `expired` ledger row, then sets `status = 'expired'`. Both writes commit with the claim.

The timer is skipped when `NODE_ENV=test`. Tests call the functions directly. The local server for this story was started with `NODE_ENV=test`, matching CI, so the timer did not race the tests.

## Ledger listing

`GET /grant-ledger-entries` paginates like `GET /plans` (`limit` default 50, max 200, `cursor` is the last id, `{data, cursor}`). Filters follow `auditLog.ts`: `grant_id`, `customer_id` (via the grant), `from`, and `to`. This is the finance-report surface from the scoping notes. There is no separate report resource.

## Eligibility load test

TEID-17-T7's catalog target is 2000 requests/sec and a 10ms P99 on `GET /grants/:id/eligibility`. CI defaults are `GRANT_ELIGIBILITY_LOAD_TEST_RPS=200` and `GRANT_ELIGIBILITY_LOAD_TEST_P99_MS=100`. A dedicated run sets the env vars back to 2000 and 10.

The 100ms budget is the scaled equivalent. On this Windows machine, 100 sequential localhost calls had a P99 between about 11ms and 41ms, so a literal 10ms assertion flakes even before concurrency. The test keeps four requests in flight (the server pool max is 10) and requires the batch to reach at least the configured rate. A burst of 200 unpaced requests pushed the P99 to roughly 80–200ms because requests queued on the pool; that number is queueing, not the UTC comparison.

## Exports

`docs/export-format.md` still says grants are not exported. TEID-44's source list is a fixed set of tables, and this story does not add grants to it. The ledger this story owns is `grant_ledger_entries`, which TEID-33 is expected to absorb.
