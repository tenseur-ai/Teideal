# TEID-50: Period close summary for finance

| | |
|---|---|
| Epic | TEID-6 (E06 -- Enable operator visibility, alerts, and customer-facing usage) |
| Phase | E06 -- Enable operator visibility, alerts, and customer-facing usage |
| Priority | High |
| Points | 5 |
| Release | mvp |
| Order | 68 (within this phase) |
| Depends on | `ledger_transactions`/`ledger_lines` (TEID-32), `usage_adjustments` (TEID-34), `grants`/`grant_ledger_entries` (TEID-17/18/19), `usage_consumptions`/`usage_consumption_lines` (TEID-18), `roleGuard.ts`/`consoleRoute` (TEID-43), `exportFormats.ts`'s `csvCell` (TEID-44) -- all already built |

## Story (verbatim from the live board)

> As a finance lead, I want a summary at the end of each billing period, so that month-end close takes hours instead of a week.
>
> *Context*

## Acceptance criteria (verbatim from the live board)

1. The summary shows per customer: usage billed, credits consumed by source, commit drawn down, overage, expired credits and adjustments.
2. Totals tie exactly to the ledger and to the Stripe reconciliation report.
3. It can be exported as CSV and Excel.

## Cataloged tests (verbatim from the live board)

| ID | Type | AC | Title |
|---|---|---|---|
| TEID-50-T1 | Functional | 1 | Generate the period close summary for August 2026 and confirm the row for customer acct_7007 shows usage billed, credits consumed broken out by source, commit drawn down, overage, expired credits and adjustments as distinct columns. |
| TEID-50-T2 | Functional | 2 | Compare the period close summary's total revenue for August 2026 against the ledger's total and the Stripe reconciliation report for the same period and confirm all three tie to the cent. |
| TEID-50-T3 | Functional | 3 | Export the period close summary as both CSV and Excel and confirm both files open correctly and contain identical figures. |
| TEID-50-T4 | Non-functional | 2 | Generate the period close summary for a period covering 50,000 customers and confirm it completes and ties to the ledger within a 30-minute close window. |
| TEID-50-T5 | Non-functional | 1 | Confirm the period close summary screen supports sorting and searching by customer name so finance can quickly locate a specific account during close. |
| TEID-50-T6 | Adversarial | 2 | Introduce a late-arriving adjustment for customer acct_7007 after the period close summary has already been generated, then re-run the summary and confirm it either reflects the adjustment consistently or flags the period as needing regeneration rather than silently mismatching the ledger. |
| TEID-50-T7 | Adversarial | 1 | Request a period close summary for a customer with zero activity in the period and confirm the row renders with correct zero values rather than an error or a missing row. |

## Scoping notes for this point in the build sequence

**AC2's "Stripe reconciliation report" does not exist anywhere in this codebase -- this is a genuine scoping-note substitution, the same pattern TEID-45 used for "invoices."** Grepped `services/ts-console/src` for `reconciliation.*report`/`StripeReconciliation`: zero hits. TEID-38 (E04) syncs Stripe *customers* only (`stripe_customer_links`) -- nothing Stripe-side tracks invoices, charges, or a reconciled revenue total to tie anything to. That capability is squarely Teideal Verify/E11 territory (`TEID-98` onward), which is itself decision-gated and not built. **The substitution:** this story ties every total to Teideal's own double-entry ledger (`ledger_transactions`/`ledger_lines`, TEID-32) only -- the half of AC2 that has a real, already-authoritative source of truth to tie to. T2 is implemented and passes against the ledger tie-out alone; the Stripe-reconciliation half of AC2's wording is explicitly out of scope for this story and documented as deferred until E11/Verify exists, not silently dropped and not faked with an invented reconciliation table. When Verify is built, it becomes a second, independent number this same summary can also tie to, without changing this story's own contract.

**This system has two separate, independently-authoritative ledgers, and AC1's six columns split across both -- they are not six components of one sum.** `usage_billed` and `adjustments` are ledger figures (TEID-32's `ledger_lines`, `revenue` account) -- actual recognized revenue. `credits_consumed_by_source`, `commit_drawn_down`, and `overage` are credit-balance figures (TEID-18's `usage_consumption_lines`, grouped by `source_category`, which is already exactly "paid"/"promotional"/"commit"/"goodwill"/"overage" -- see Architecture) -- how much of a customer's grant/commit balance moved, independent of what was ultimately billed for it (a customer fully covered by grants can have significant credit consumption and zero additional billed revenue in a period). `expired_credits` is a third, narrower figure (`grant_ledger_entries`, `entry_type = 'expired'`). AC2's "ties exactly to the ledger" is satisfied by construction for `usage_billed`/`adjustments` (they are literal ledger sums); the other four columns tie to their own already-authoritative source tables the same way every other feature in this codebase already reports them (TEID-47's threshold content, TEID-18's own consumption tracking) -- there is no single grand total this story reconciles across all six, and the implementation must not force one.

**Period selection is a calendar month, company-wide -- deliberately not each customer's own anchored billing period.** Every other period-aware feature in this codebase (TEID-47's threshold dedup, TEID-96's boundary math) uses each customer's *own* `customer_billing_config` anchor day/timezone, because those features are about *that customer's* billing cycle. A finance month-end close is the opposite: one company-wide close date finance runs once, covering every customer's activity in that same calendar window, regardless of each customer's individual billing anchor -- T1's own wording ("the period close summary for August 2026") is a plain calendar month, not a per-customer-anchored one. This story takes `period=YYYY-MM` and resolves `period_start`/`period_end` as `[first of that UTC month, first of the next UTC month)`, uniformly for every customer -- it does **not** reuse `balanceAlertWorker.ts`'s per-customer `billingPeriodStart`, and does not need to (a genuinely separate, simpler concept, not a missing piece to build).

**This summary is always computed live, never persisted as a stored snapshot.** T6 ("a late adjustment after generation... reflects the adjustment consistently, or flags for regeneration") is satisfied trivially and safely by never caching a summary in the first place: every request recomputes directly from current `ledger_lines`/`usage_consumption_lines`/`grant_ledger_entries`/`usage_adjustments` state for the requested period. A newly-approved late adjustment is simply part of "current state" the next time anyone asks -- there is no stale snapshot to go stale, and no regeneration-flagging mechanism to build. This is a deliberate simplicity choice, not an oversight: a persisted, versioned snapshot would be real, separate scope (audit-grade "what finance actually saw and signed off on at close time") that nothing in AC1-3 or the test catalog actually asks for.

Everything else this story references already exists: `ledger_transactions`/`ledger_lines` (TEID-32), `usage_adjustments` (TEID-34), `grants`/`grant_ledger_entries` (TEID-17/18/19), `usage_consumptions`/`usage_consumption_lines` (TEID-18).

## Architecture and design

**No new tables.** This is a read-side aggregation, like TEID-45's timeline, over four existing tables split across both services -- `ledger_transactions`/`ledger_lines` and `usage_adjustments` owned by `services/go-usage`; `grants`/`grant_ledger_entries` and `usage_consumptions`/`usage_consumption_lines` owned by `services/ts-console`.

**New indexes** (migration `db/migrations/20260930100000_period_close_indexes.sql` -- checked directly, neither exists today):
```sql
CREATE INDEX IF NOT EXISTS usage_consumptions_tenant_occurred_idx
  ON usage_consumptions (tenant_id, occurred_at);
CREATE INDEX IF NOT EXISTS grant_ledger_entries_tenant_occurred_idx
  ON grant_ledger_entries (tenant_id, occurred_at) WHERE entry_type = 'expired';
```
(`ledger_lines_transaction_id_idx` and whatever index `usage_adjustments` already has on `period_start` from TEID-34 are reused as-is -- confirm both exist before assuming; add only what's genuinely missing.)

**New go-usage endpoint** `GET /period-close/ledger-summary?since=&until=` (new `services/go-usage/internal/api/periodClose.go`), auth `read-only` scope, tenant-wide (every customer under the caller's tenant in one response, not one call per customer -- required for T4's 50,000-customer scale): one `GROUP BY customer_id` query over `ledger_lines` joined to `ledger_transactions` (`account_code = 'revenue' AND direction = 'credit' AND ledger_transactions.created_at >= $1 AND < $2`) for `usage_billed`, and a second `GROUP BY customer_id` query over `ledger_lines` joined through `ledger_transactions.usage_event_id = usage_adjustments.resulting_usage_event_id` (`usage_adjustments.status = 'approved' AND usage_adjustments.period_start = $1`) for `adjustments` -- both single set-based aggregate queries, matching TEID-45's own "push the aggregate to Postgres, don't fold in application code" lesson exactly. Response: `{data: [{customer_id, usage_billed, adjustments}]}`. `adjustments` is a sub-component already included within `usage_billed`, not additive -- see Scoping notes.

**New ts-console aggregation endpoint** `GET /period-close-summary?period=YYYY-MM&sort=&search=&cursor=&limit=&format=json|csv|xlsx` (new `services/ts-console/src/routes/periodClose.ts`), role-gated `["Owner", "Billing Admin", "Finance"]` (Finance is TEID-43's own role for exactly this kind of report). Handler:
1. Resolve `period_start`/`period_end` as the calendar-month bounds described above.
2. Two local `GROUP BY customer_id` queries: `usage_consumption_lines` joined to `usage_consumptions` (`occurred_at >= period_start AND < period_end`), grouped by `(customer_id, source_category)` -- shaped into `credits_consumed_by_source: {paid, promotional, commit, goodwill, overage}` per customer, with `commit_drawn_down` read directly as that object's `commit` key and `overage` as its `overage` key (AC1 lists them as separate columns; they are simply named views into the same breakdown, not separately computed); and `grant_ledger_entries` joined to `grants` (`entry_type = 'expired' AND occurred_at >= period_start AND < period_end`), grouped by `customer_id`, summed (as a positive figure -- the ledger stores expiry as a negative entry) for `expired_credits`.
3. One call to go-usage's `GET /period-close/ledger-summary` for `usage_billed`/`adjustments`.
4. Merge by `customer_id` over the full set of the tenant's customers (a `LEFT JOIN`-shaped merge starting from `customers`, not from whichever source happened to have a row -- this is what makes T7's zero-activity customer render a correct all-zero row instead of being silently absent).
5. Apply `search` (case-insensitive substring on `customers.name`) and `sort` (`name` or `usage_billed`, matching T5), then cursor-paginate for the `json` response shape, matching every other list endpoint's existing convention.
6. For `format=csv`/`format=xlsx`: **does not paginate** -- streams every matching row (after `search`, ignoring `cursor`/`limit`) into the requested format and returns it as a file download (`Content-Disposition: attachment`), reusing `exportFormats.ts`'s existing `csvCell` for CSV (matching `auditLog.ts`'s own direct-HTTP-response CSV pattern, not TEID-44's heavier async-job export pipeline -- this is a synchronous, bounded-size, browser-triggered download, not a background job). Excel: a new `xlsxCell`-equivalent via a new dependency, `exceljs` (added to `services/ts-console/package.json` -- no existing xlsx writer anywhere in this codebase, confirmed by grep; matches TEID-44's own precedent of adding `@dsnp/parquetjs` when a real new output format was genuinely needed), writing one worksheet, one header row, one row per customer, built from the **exact same in-memory row array** the CSV branch consumes -- both formats are two renderings of one already-computed dataset, which is what guarantees T3's "identical figures" by construction rather than by two independently-computed paths that could drift.

**Response shape** (`format=json`, the default): `{data: [{customer_id, customer_name, usage_billed, credits_consumed_by_source: {paid, promotional, commit, goodwill, overage}, commit_drawn_down, overage, expired_credits, adjustments}], next_cursor}`. All monetary fields are decimal strings (matching every other money-bearing response in this codebase, e.g. `grants.amount`), not floats.

## Implementation guidance per test

### TEID-50-T1
Seed customer `acct_7007` with at least one row contributing to each of the six named figures within August 2026 (a priced usage event producing ledger revenue, consumption lines against a paid grant, a commit-sourced grant draw, an overage consumption line, an expired grant within the month, an approved late adjustment with `period_start` in August). Call `GET /period-close-summary?period=2026-08`. Assert the row for `acct_7007` has non-zero values in all six positions (`usage_billed`, `credits_consumed_by_source` with multiple non-zero source keys, `commit_drawn_down`, `overage`, `expired_credits`, `adjustments`) and that `commit_drawn_down`/`overage` equal `credits_consumed_by_source.commit`/`.overage` exactly.

### TEID-50-T2
Seed known ledger activity for August 2026 summing to an exact, independently-computed total. Call the summary endpoint, sum every row's `usage_billed`. Independently query `SUM(ledger_lines.amount) WHERE account_code = 'revenue' AND direction = 'credit' AND ledger_transactions.created_at` in range, directly against the database. Assert the two sums are identical to the cent (string-compare the decimal, not a float comparison). Document in the test file, per the scoping note, that the Stripe-reconciliation half of this AC is deferred until Verify/E11 exists -- do not fabricate a Stripe-side comparison.

### TEID-50-T3
Generate the summary for a period with several customers. Request `format=csv` and `format=xlsx`. Parse both responses back (a CSV parser for the first; `exceljs`'s own reader, or a second small library, for the second -- whichever the test's own tooling already has available) and assert every customer row's six figures are byte-for-byte/value-for-value identical between the two parsed results.

### TEID-50-T4
Bulk-insert (set-based SQL, matching TEID-32-T6/TEID-45-T4/T5's own established precedent) 50,000 customers' worth of ledger, consumption, and grant-expiry activity for one period. Time the summary endpoint's full response (all 50,000 rows, via repeated cursor pages or a single unpaginated internal call, whichever the test harness finds practical) end-to-end. Assert it completes in under 30 minutes, and independently spot-check at least 20 sampled customers' `usage_billed` against a direct ledger query to confirm the response isn't merely fast because it's wrong/empty.

### TEID-50-T5
Seed customers with distinctly different names. Call the endpoint with `sort=name`, assert ascending alphabetical order. Call with `search=<substring of one customer's name>`, assert only matching customers are returned. Call with both together, assert both apply.

### TEID-50-T6
Generate the summary for August 2026, record `acct_7007`'s `adjustments`/`usage_billed`. Insert and approve a new late-arriving adjustment for `acct_7007` with `period_start` in August (matching TEID-34's real approval path, not a direct DB write). Call the summary endpoint again for the same period. Assert the new call's `adjustments`/`usage_billed` for `acct_7007` reflects the new adjustment correctly (per the "always live" design, this is the expected, safe outcome -- not a mismatch, and not a flag) and assert this is internally consistent (the new `usage_billed` total still ties to a fresh direct ledger query, matching T2's own tie-out method).

### TEID-50-T7
Seed a customer with zero rows in every one of the six source tables/categories for the requested period (but an existing `customers` row). Call the summary endpoint. Assert that customer's row is present (not missing) with every figure exactly `0`/`"0"` (not `null`, not an error, not an absent key in `credits_consumed_by_source`).

## File layout

- `db/migrations/20260930100000_period_close_indexes.sql` -- new indexes only.
- `services/go-usage/internal/api/periodClose.go` (new) -- `GET /period-close/ledger-summary`.
- `services/go-usage/cmd/server/main.go` -- register the new route.
- `services/ts-console/src/routes/periodClose.ts` (new) -- the aggregation endpoint, CSV/XLSX export.
- `services/ts-console/src/lib/periodCloseSummary.ts` (new) -- the query/merge/shape logic, kept separate from the route file so tests can call it directly without an HTTP round trip for T4's scale case.
- `services/ts-console/src/server.ts` -- register the new route.
- `services/ts-console/package.json` -- add `exceljs`.
- Tests: new directory `tests/period-close/` implementing all 7 cataloged tests.

## Definition of done

- [ ] Every acceptance criterion above is satisfied by working code (AC2's Stripe-reconciliation half satisfied via the documented deferral, not literal Stripe data).
- [ ] Every cataloged test has a real automated test that passes -- functional, non-functional, and adversarial alike.
- [ ] `go vet`/`tsc --noEmit` (whichever applies) is clean in both `services/go-usage` and `services/ts-console`.
- [ ] `tests/cross-tenant`, `tests/console-auth`, `tests/rbac`, `tests/ledger`, `tests/late-adjustments`, `tests/grants`, `tests/consumption-order` all still pass unchanged.
- [ ] `docs/api/billing.md` (or a new `docs/api/period-close.md`, linked from `docs/api/README.md`) documents the new routes and `tests/docs/coverage.test.ts` passes.
- [ ] The suite passes against a database rebuilt from scratch using only committed migration/seed scripts.
- [ ] PR description includes a checklist mapping each test ID to the file/line that covers it.
