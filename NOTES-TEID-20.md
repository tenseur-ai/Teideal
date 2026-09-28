# NOTES-TEID-20

Gaps in the spec that had to be resolved to implement the cataloged tests. Nothing here changes the eight cataloged outcomes.

## Customer id lives in the URL

`validateOverrideInput` requires `customer_id` in the body. The create route is `POST /customers/:id/rate-overrides`, and TEID-20-T1's example body is only `metric`, `rate`, and `start_date`. TEID-20-T6 omits `metric` / `rate` / `start_date` and does not treat `customer_id` as a form field.

The route copies the path id into the body before validation, the same way `POST /customers/:id/consume` takes the customer from the URL. `validateOverrideInput` still requires a UUID `customer_id`, as the spec's function contract states.

## `plan_id` must be visible in the caller's tenant

`priced_usage_lines.plan_id` is a foreign key. `resolveEffectiveRate` can return an override without reading `plans`. Pricing against another tenant's plan id would then insert a row that points at that plan.

The pricing route checks that the plan is visible under RLS (`SELECT EXISTS` on `plans`) before resolving. A hidden plan is the same 404 as "no rate configured for this metric/model on this plan", so the body does not echo the foreign id. Cross-tenant isolation for `POST /customers/:id/price-usage` depends on this.

## `occurred_at` is the request's `as_of`

The table defaults `occurred_at` to `now()`. TEID-20-T4's "usage event on 2026-11-01" is an `as_of` value, matching `POST /customers/:id/consume`. The insert writes `occurred_at = as_of` so the ledger records the event time the caller sent.

## T5's CI latency budget is scaled

The catalog target is 5 milliseconds of added overhead at 3000 events per second. TEID-19-T6's CI convention is a lower sample count and a wider budget. Defaults here are `RATE_OVERRIDE_LATENCY_SAMPLES=40` and `RATE_OVERRIDE_LATENCY_BUDGET_MS=50`. A dedicated run sets the budget to 5.

## `listOverrides` is customer-scoped

`listGrants` is tenant-wide. `GET /customers/:id/rate-overrides` is a customer collection, so `listOverrides` filters on `customer_id` and keeps the same cursor-on-`id` page shape.

## `resolveEffectiveRate` returns null; the route maps it to 404

The spec names the 404 on the resolver. The function returns `{rate, overrideId}` or `null`. `POST /customers/:id/price-usage` turns `null` into `404` / `no rate configured for this metric/model on this plan`.
