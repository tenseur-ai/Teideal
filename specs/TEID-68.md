<!--
Scope note, read before anything else: this spec deliberately redefines
and narrows the live board's TEID-68 ("Independent re-rating of usage"
-- a from-scratch tier/proration/credit-order rating engine) AND folds
in the spirit of TEID-69 ("Three-way match") into one deliverable. Per
explicit 2026-10-01 user direction ("one discrepancy report: expected
vs billed, decimal money, classified... that is the thing you sell"),
this maps to docs/proposals/teideal-new-epics-2026-09-30.md's
unincorporated TEID-V1/V2, simplified further. The key is kept as
TEID-68 because that's what the user asked for by name; the board's
original TEID-68/69 definitions should be reconciled separately.

Real, load-bearing scoping decision made here, not hidden: TEID-67
("capture contract terms," i.e. mapping a Stripe price to a Teideal
plan/rate) was explicitly NOT built before this story, per the user's
own priority order. Without it, precise line-level matching (this
Stripe price_id = this Teideal metric+rate) isn't possible yet. This
story therefore compares PER-CUSTOMER-PER-PERIOD TOTALS (expected vs
billed), not individually price-matched lines, and classifies at that
granularity. This is a genuine v0, not a simulation of the full design
-- stated plainly so nobody mistakes it for line-level precision it
cannot yet deliver. Upgrading to line-level matching is TEID-67's job,
not a hidden gap in this story.
-->

# TEID-68: Discrepancy report -- expected vs billed

| | |
|---|---|
| Epic | TEID-11 (E11 -- Implement Teideal Verify independent revenue verification) |
| Phase | E11 -- Implement Teideal Verify independent revenue verification |
| Priority | Highest |
| Points | 8 |
| Release | mvp |
| Order | 68 (within E11, directly after TEID-66) |
| Depends on | TEID-66 (`verify_billed_lines`, the billed side). `periodCloseSummary.ts` (TEID-50, the expected side -- the existing, already-live rating/revenue computation; this story must not implement a second calculator). |

## Story

> As a finance lead, I want one report per customer per period showing what Teideal independently computed we should have billed against what Stripe actually billed, classified by the kind of discrepancy, so that I can see revenue leakage or overbilling without a spreadsheet.

Not on the live board under this description -- see the header note. Per 2026-10-01 user direction: "one discrepancy report: expected vs billed, decimal money, classified (missing line, rate drift, quantity). That is the thing you sell."

## Acceptance criteria

1. For each (customer, period) where TEID-66 has mapped billed lines, Teideal computes an expected total using the existing live rating/revenue computation (`generatePeriodCloseSummary`'s `usage_billed + overage`) -- never a second, independently-implemented calculator.
2. Teideal compares the expected total against the billed total (sum of that customer's `verify_billed_lines` for the same period) and records the delta as a decimal string, never a float.
3. Every nonzero delta is classified as exactly one of: `missing_line` (Teideal has expected revenue for a period with zero billed lines at all), `quantity` (both sides have activity but the delta correlates with a usage-quantity difference between the independent usage count and what the billed lines' quantities imply), or `rate_drift` (both sides agree on there being comparable activity but the per-unit amount implied by the billed lines differs from Teideal's own effective rate for that period).
4. The report is produced per (tenant, customer, period) as a single row with: expected total, billed total, delta, classification, and the exact `verify_billed_lines`/ledger data that produced both sides (traceability, not just a number).
5. Running the report twice against the same underlying data produces byte-identical results.
6. A customer excluded from TEID-66's mapping (unmapped Stripe customer) is listed in the report as `excluded: unmapped_customer`, not silently dropped from the denominator.
7. A period/customer whose billed-side data is known to be structurally incomplete -- because TEID-66 (a) does not map `credit`/`payment`/`refund` connector records at all, only invoices, (b) excludes any invoice line with a null `price_id` or null period bounds, and (c) has no mechanism to detect a previously-mapped line that Stripe later deleted or voided (a stale `verify_billed_lines` row can linger indefinitely) -- is never classified as `missing_line`, `quantity`, or `rate_drift` on that basis alone. It is flagged as a known coverage gap, distinct from a genuine leakage finding, per 2026-10-01 user direction: "TEID-68 has to treat those as gaps, not leakage."

## Cataloged tests

| ID | Type | AC | Title |
|---|---|---|---|
| TEID-68-T1 | Functional | 1,2 | Seed a customer whose `generatePeriodCloseSummary` total for a period is exactly $425.00 and whose `verify_billed_lines` for the same period sum to exactly $425.00. Run the report and confirm delta = "0.00" and no classification (a clean match). |
| TEID-68-T2 | Functional | 3 | Seed the same clean-match customer, then delete that period's `verify_billed_lines` entirely (simulating a Stripe invoice that was never generated). Confirm the report classifies this as `missing_line` with delta equal to the full expected total. |
| TEID-68-T3 | Functional | 3 | Seed a customer with identical usage-event quantities on both sides but a billed total 20% below expected (simulating an un-synced price decrease on the Stripe side). Confirm the report classifies this as `rate_drift`. |
| TEID-68-T4 | Functional | 3 | Seed a customer where the independent usage count for the period is itself higher than what the billed lines' quantities imply (simulating usage that was recorded in Teideal's ledger but never reported to the biller at all). Confirm the report classifies this as `quantity`. |
| TEID-68-T5 | Functional | 4 | Pull one report row with a nonzero delta and confirm it links back to both the exact `verify_billed_lines` row(s) and the exact ledger/consumption rows `generatePeriodCloseSummary` used for that customer's expected total. |
| TEID-68-T6 | Functional | 5 | Run the report twice for the same tenant/period with no data changes in between and confirm every row (delta, classification, amounts) is byte-for-byte identical. |
| TEID-68-T7 | Non-functional | 1 | Run the report across 500 customers for one period and confirm it completes within a documented CI-scoped budget (`VERIFY_DISCREPANCY_SCALE_BUDGET_MS`), following this codebase's established scale-test convention. |
| TEID-68-T8 | Adversarial | 1 | Construct a request/fixture that attempts to feed the report a pre-computed "expected" total directly (bypassing `generatePeriodCloseSummary`) and confirm the report's actual code path always recomputes from the live summary function, never trusting an externally-supplied expected value. |
| TEID-68-T9 | Adversarial | 6 | Seed an unmapped-customer case (per TEID-66-T3) and confirm that customer appears in this report's output as `excluded: unmapped_customer` rather than being silently absent, and that the tenant-level totals clearly state how many dollars were excluded for this reason. |
| TEID-68-T10 | Adversarial | 7 | Seed a customer whose only Stripe activity for the period is a credit note or refund (no invoice at all, so `verify_billed_lines` has zero rows for them) alongside a nonzero `generatePeriodCloseSummary` expected total. Confirm the report flags this period as a known coverage gap (credits/refunds not mapped), not `missing_line` -- a real leakage classification here would be a false positive caused entirely by TEID-66's own scope, not a genuine discrepancy. |

## Scoping notes

- **Total-level, not line-level, comparison** -- see the header note. `missing_line`/`quantity`/`rate_drift` are classifications of a *period-level* discrepancy, not a specific unmatched line item the way the full TEID-67-dependent design would eventually support. This is stated in the report's own output (a `granularity: "period_total"` field or equivalent), so a consumer of this report knows exactly what precision they're getting.
- **Classification heuristic, made as simple and defensible as possible given no price mapping exists yet:**
  - `missing_line`: billed total for the period is exactly zero (or no `verify_billed_lines` rows exist) while expected total is nonzero.
  - `quantity`: comparing the *independent usage event count/sum* for the period (from `usage_events`, via the same go-usage query `generatePeriodCloseSummary` already uses) against the *sum of `verify_billed_lines.quantity`* for that period shows a meaningfully different quantity (a tolerance, e.g. >1%, configurable per tenant the same way TEID-69's design calls for an operator-settable tolerance) -- the usage itself disagrees, independent of rate.
  - `rate_drift`: quantities agree within tolerance but the dollar totals still differ -- the per-unit price implied by what was billed disagrees with Teideal's own effective rate.
  - A customer can have more than one classification across different periods, never more than one per period (this is a total-level comparison, one verdict per period).
- **Money is decimal strings throughout** -- this report must not call `Number()` on any amount at any point in its computation, matching this codebase's hard-enforced convention (see TEID-51's review notes for exactly the kind of bug this guards against).
- **AC1's "must not implement a second calculator"** is the single most important constraint here -- `generatePeriodCloseSummary` already exists, is independently verified (TEID-50), and is what TEID-39 itself used to decide what to send Stripe in the first place. Calling it directly (not re-deriving its logic) is both correct architecture and the only way this report's "expected" side can be trusted as independent of bugs in a second implementation.
- **AC7's known-gap check must run *before* `missing_line` classification, not after.** `missing_line`'s own definition above ("billed total is zero while expected is nonzero") would otherwise fire on every single AC7 case -- a credit/refund-only period looks identical to a genuinely missing invoice from `verify_billed_lines`'s point of view, since neither produces a row there. Before classifying a zero-billed-total period as `missing_line`, check whether `connector_records` has any `credit`/`payment`/`refund` entity for that customer at all (a cheap existence check, not a full reconciliation of their amounts -- TEID-66 doesn't map them, so there's nothing precise to reconcile against yet). If so, classify as the known-gap case instead. This is a deliberately coarse, honest check matching this story's own period-total granularity -- it does not attempt to net credits/refunds against the expected total, only to avoid falsely calling a known blind spot "leakage."
- **Do not build any detection for TEID-66's "deleted lines linger" gap in this story** -- there is no reliable signal available yet to distinguish "Stripe deleted this line" from "TEID-65's sync hasn't run recently" without deeper connector-side work. Documenting the limitation (e.g. a `caveats` field on the report noting billed data reflects the last successful sync, not necessarily Stripe's current state) is sufficient for this story; detecting and flagging actual staleness is follow-on work, not in scope here.

## Architecture and design

**Service**: entirely `services/ts-console` -- reads `verify_billed_lines` (TEID-66) and calls `generatePeriodCloseSummary` (TEID-50) directly as a function, no new cross-service calls.

**API contract**: `GET /verify/discrepancy-report?period=YYYY-MM` -- role-gated the same way `/period-close-summary` is. Returns `{ data: [{ customer_id, customer_name, expected_total, billed_total, delta, classification, granularity, evidence: {...} }], excluded: [{customer_id, reason}], totals: {expected, billed, delta} }`.

**No new table required** for the report itself (it's computed live from `verify_billed_lines` + `generatePeriodCloseSummary`, same "no cached summary table" design TEID-50 already established) -- only a small `verify_tolerance_settings` row per tenant if a configurable tolerance (per the quantity-classification heuristic above) is wanted from day one; a hardcoded default (1%) is an acceptable first cut if time-constrained, documented as such.

## Implementation guidance per test

See the Cataloged tests table -- each row states setup/action/assertion concretely enough to implement directly against the API contract and classification heuristic above.

## File layout

- `services/ts-console/src/lib/verify/discrepancyReport.ts` (new)
- `services/ts-console/src/routes/verify.ts` (extend from TEID-66, or create if TEID-66 didn't land first)
- `tests/verify/discrepancy-report.test.ts` (new, same `tests/verify/` directory as TEID-66)
- `docs/api/verify.md` (extend)

## Definition of done

- [ ] Every acceptance criterion above is satisfied by working code.
- [ ] Every cataloged test has a real automated test that passes.
- [ ] `tsc --noEmit` clean.
- [ ] The suite passes against a database rebuilt from scratch using only committed migration/seed scripts.
- [ ] PR description includes a checklist mapping each test ID to the file/line that covers it, and states plainly that this is a period-total-granularity discrepancy report, not yet line-level (pending TEID-67).
