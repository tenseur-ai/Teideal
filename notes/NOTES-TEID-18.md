# NOTES-TEID-18

Decisions where the spec leaves a gap, plus one contradiction between the draw rule and TEID-18-T2's fixture. Nothing here blocked the story.

## T2's four grants cannot both satisfy the fallback rule and draw paid first

A stored `consumption_order` must be a permutation of `promotional`, `paid`, `commit`, and `goodwill`, so every accepted override names `goodwill`. The draw rule uses that override only when the customer currently holds an eligible grant of every named source. Otherwise it falls back to the default order. That is TEID-18-T9.

TEID-18-T2's implementation guidance says to reuse T1's four grants (two promotional, one paid, one commit) and then expect the override `["paid", "promotional", "commit", "goodwill"]` to draw paid first. Those four grants include no goodwill, so the fallback rule discards the override and paid is not first.

The test adds one goodwill grant so the override is eligible, then requests the same 400 credits. Goodwill is not drawn. The lines are paid, then the 5-day promotional grant, then the 20-day promotional grant, then commit. That is the paid-before-promotional result T2 asks for, and it is the only fixture that agrees with both the permutation rule and the fallback rule.

## Plan order is a real query that matches nothing

There is still no customer-to-plan assignment. `readPlanOrderForCustomer` selects `plans.consumption_order` for this tenant and this customer. The plan id it compares against is `NULL`, because that assignment is not stored anywhere. The query runs on every consume and returns no row. Replacing the `NULL` subquery with a future assignment column is the hook. It is not a TypeScript `return null`.

`PATCH /plans/:id` stores the array on a draft, through the existing draft-only update. Published plans stay immutable, which is TEID-16's rule. The new field is on the plan JSON as `consumption_order` (`null` when unset). `routes/plans.ts` already passes the whole validated patch through, so it did not need an edit.

When an override is ineligible, the resolver checks the plan order next and then the default. Today the plan lookup is empty, so an ineligible override becomes the default. The same "every named source must have an eligible grant" check applies to a plan order if one is ever found.

## Promotional ties, lock order, and line order

Within `promotional`, the spec sorts by `expiry_date ASC NULLS LAST`. Within every other category it also sorts by `created_at`, then `id`. Two promotional grants can share an expiry. TEID-18-T6 requires a total order, so promotional uses the same `created_at`, then `id`, tie-break after expiry. That does not change which of two different expiries wins.

The locked read is the spec's eligibility predicate plus `created_at` (the sort needs it) and `ORDER BY id` before `FOR UPDATE`. Without a stable lock order, the 20 concurrent draws in TEID-18-T8 can deadlock. The lock is still one statement over that customer's eligible grants.

`usage_consumption_lines` has no position column. Line ids are UUIDv7 values generated in draw order, and the timeline reads `ORDER BY id`. The `POST /customers/:id/consume` response is built from that same draw list, so it does not depend on the later read.

## What a consume writes

Uncovered remainder becomes one line with `grant_id: null` and `source_category: 'overage'`. TEID-18-T8 uses that path. Ten of the twenty requests are fully covered. The other ten are a single overage line of the full request. The sum drawn from the two grants is their combined starting balance.

`grant_ledger_entries.entry_type` is still only `issued`, `expired`, and `voided` (TEID-17). This story's per-grant ledger is `usage_consumption_lines`. Consume decrements `grants.remaining_amount` and does not append a grant-ledger row. It also does not write `audit_log`. The spec names `recordConfigChangeWithClient` on the customer override upsert. `PUT /customers/:id/consumption-order` writes object type `CustomerConsumptionOverride`.

The draw does not filter grants by `unit`. Eligibility is the spec's `SELECT`: active, inside the start/expiry window at `as_of`, `remaining_amount > 0`.

`PUT` returns 200 with `{consumption_order}` on insert and on update. The spec states 400 and the body, not the success status. `GET` returns the same shape, or `{consumption_order: null}` when the customer exists and has no override.

A customer id the caller cannot see returns 403 `{"error":"customer not found for this tenant"}` on the new customer routes, matching `POST /grants`. The body does not echo the id.

## `consoleRoute` accepts PUT

TEID-43's helper only listed `get`, `post`, `patch`, and `delete`. The customer override is `PUT`, and it is registered with `consoleRoute`, so the method union includes `put`.

## Scaled checks

TEID-18-T6's catalog target is 1000 grant sets and 50 identical replicas (50,000 consumes). The test defaults are `CONSUMPTION_ORDER_FUZZ_SETS=20` and `CONSUMPTION_ORDER_FUZZ_REPLICAS=5`. Set both env vars to the catalog numbers for a dedicated run.

TEID-18-T7's catalog budget is 100 milliseconds, read from `CONSUMPTION_SPLIT_LATENCY_BUDGET_MS` (default 100). The timer wraps only `POST /customers/:id/consume`, after the five grants exist.

Replay identity compares slot, `source_category`, and `amount`. Two customers cannot share grant UUIDs, so a raw `grant_id` field is not byte-identical across replicas. The slot is the grant's position in the shared starting set.
