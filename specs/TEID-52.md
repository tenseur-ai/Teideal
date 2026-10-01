# TEID-52: Margin dashboard

| | |
|---|---|
| Epic | TEID-7 (E07 -- Build cost and margin analytics) |
| Phase | E07 -- Build cost and margin analytics |
| Priority | Medium |
| Points | 8 |
| Release | phase-2 |
| Order | 98 (within this phase; second story, directly after TEID-51) |
| Depends on | TEID-51 (`cost_rates` table, `resolveEventCost`, `usage_events.model`/`actual_cost` columns) -- **do not start this story until TEID-51 is independently verified and merged.** TEID-50's `periodCloseSummary.ts` (the existing revenue-aggregation pattern this story's cost/margin aggregation should match). TEID-22's customer hierarchy (`customers` self-reference, "team" = a child `customers` row -- see Scoping notes). |

## Story (verbatim from the live board)

> As a founder, I want to see revenue, cost and gross margin by customer, plan and model, so that I can make pricing and sales decisions based on profitability.
>
> *Context*

## Acceptance criteria (verbatim from the live board)

1. The dashboard shows revenue, cost, gross margin and margin percentage for any date range.
2. It can be broken down by customer, plan, model and team.
3. Figures tie to ledger revenue and the cost table.
4. Data can be exported as CSV.

## Cataloged tests (verbatim from the live board)

| ID | Type | AC | Title |
|---|---|---|---|
| TEID-52-T1 | Functional | 1 | Load the margin dashboard for Q3 2026 and confirm it displays total revenue, total cost, gross margin in dollars and gross margin percentage for that range. |
| TEID-52-T2 | Functional | 2 | Apply a breakdown by model on the margin dashboard and confirm separate revenue, cost and margin rows appear per model, then switch to a breakdown by customer and confirm the rows update accordingly. |
| TEID-52-T3 | Functional | 3 | Cross-check the margin dashboard's total revenue for September 2026 against the ledger's revenue total and the cost table's cost total for the same period and confirm they tie exactly. |
| TEID-52-T4 | Functional | 4 | Export the margin dashboard data for the last 90 days broken down by customer as CSV and confirm the file matches the figures shown on screen. |
| TEID-52-T5 | Non-functional | 1 | Load the margin dashboard for a trailing 12-month range across 500-plus customer accounts and confirm it renders within 5 seconds. |
| TEID-52-T6 | Non-functional | 2 | Toggle the margin dashboard breakdown between customer, plan, model and team without a full page reload and confirm the previously selected date range is preserved across toggles. |
| TEID-52-T7 | Adversarial | 3 | Remove the cost table entry for a model that has recorded revenue in the period and confirm the dashboard flags that model's margin as incomplete rather than silently showing it as 100 percent margin. |
| TEID-52-T8 | Adversarial | 1 | Request a margin dashboard view for a date range that spans a mid-period cost-table rate change and confirm each effective-dated rate is applied only to the portion of usage it covers rather than one rate applying to the whole range. |

## Scoping notes for this point in the build sequence

- **No UI exists anywhere in this repo** (confirmed by direct search this session -- no React/Vue/Svelte, no `.tsx` files; `services/ts-console` is a pure JSON API). "Load the margin dashboard," "toggle the breakdown without a full page reload," and "renders within 5 seconds" are all satisfied by the documented JSON API a future UI would call -- do not build any UI, do not fake one. T6's "without a full page reload" requirement becomes: a single `GET` request accepts a `breakdown` query param and returns updated rows without needing to recompute the date-range-independent parts -- i.e., the API itself must be cheap to re-call with a new breakdown, not require a literal page reload to mean anything in an API-only context.
- **"Team" is not a separate entity.** Per TEID-22 (customer hierarchy), an organisation and its teams are both just `customers` rows linked via `parent_customer_id`; "break down by team" means grouping by the specific child-`customers` row a usage event's billing customer resolves to, exactly the same grouping mechanism as "by customer," just applied to a non-root node. Do not add a new `teams` table.
- **"Ties to ledger revenue" (AC3) uses the same revenue source TEID-50 already established**: `usage_consumptions`/`usage_consumption_lines` (ts-console's own consumption ledger), not `go-usage`'s separate `usage_events`/`ledger_transactions`. Reuse `periodCloseSummary.ts`'s existing aggregation query pattern for the revenue side rather than inventing a second one. The cost side joins against TEID-51's `cost_rates` via `resolveEventCost`, applied per usage event/line at its own `occurred_at` (this is exactly what T8 is testing: a cost-table rate change mid-range must only apply to the usage on its own side of the `effective_from` boundary, mirroring how `cost_rates` lookups already work event-by-event, not range-by-range).
- **T7's "flag as incomplete" requirement**: when a model/metric combination has recorded revenue but `resolveEventCost` finds no applicable `cost_rates` row (and no event carried an `actual_cost` override), that row's margin must not be computed as `revenue - 0 = 100% margin`. Return it with an explicit `margin_complete: false` (or equivalent) flag and omit or null the margin fields for that row, rather than a silently misleading number. Document the exact field name chosen in `docs/api/`.
- **T5's 500+ customer / 12-month / 5-second budget** -- follow this codebase's established pattern for scale-sensitive non-functional tests (TEID-20-T5/TEID-22-T5/TEID-50-T4 precedent): a CI-scoped budget env var (e.g. `MARGIN_DASHBOARD_SCALE_BUDGET_MS`) with a CI-sized default and the literal 5-second figure documented as the real target for a manual/production-scale run, rather than a hardcoded assertion that's marginal on shared CI runners.

## Architecture and design

**Service ownership**: entirely `services/ts-console` -- reads its own consumption ledger (TEID-50's tables) and `cost_rates`/`resolveEventCost` (TEID-51), writes nothing new. No `go-usage` changes.

**API contract**:
- `GET /margin-dashboard?period_start=...&period_end=...&breakdown=customer|plan|model|team&format=json|csv` -- role-gated the same way `/period-close-summary` is (Owner/Billing Admin/Finance). Returns per-breakdown-key rows: `{ key, label, revenue, cost, margin, margin_pct, margin_complete }`, plus a `totals` object with the same shape unbroken-down (T1). `format=csv` mirrors `/period-close-summary`'s existing CSV-rendering convention exactly (reuse that helper if it's generic enough, or follow its exact pattern if not directly reusable).
- Switching `breakdown` is just a different query param on the same endpoint -- re-calling it with a new value is what T6's "no full page reload" becomes in an API-only system; the date range persists because the caller (a future UI, or the test itself) simply keeps passing the same `period_start`/`period_end`.

## Implementation guidance per test

See the Cataloged tests table above combined with the Scoping notes -- each AC/test pair states setup/action/assertion concretely enough to implement directly against the API contract above. T3's "tie exactly" means a literal equality assertion between the dashboard's reported total and an independently-computed total from the same underlying tables within the test itself (not a tolerance/approximation check).

## File layout

- `services/ts-console/src/lib/marginDashboard.ts` (new) -- the aggregation/breakdown logic, reusing `periodCloseSummary.ts`'s revenue query pattern and TEID-51's `resolveEventCost`.
- `services/ts-console/src/routes/marginDashboard.ts` (new) -- the `GET /margin-dashboard` route.
- `services/ts-console/src/server.ts` (extend) -- register the new route.
- `tests/cost-analytics/margin-dashboard.test.ts` (new, same directory TEID-51 established) -- TEID-52-T1 through T8.
- `docs/api/margin-dashboard.md` (new) -- document the route so `tests/docs/coverage.test.ts` stays green.

## Definition of done

- [ ] Every acceptance criterion above is satisfied by working code.
- [ ] Every cataloged test has a real automated test that passes -- functional, non-functional, and adversarial alike.
- [ ] `tsc --noEmit` clean.
- [ ] The suite passes against a database rebuilt from scratch using only committed migration/seed scripts, with TEID-51's migration applied first.
- [ ] PR description includes a checklist mapping each test ID to the file/line that covers it.
