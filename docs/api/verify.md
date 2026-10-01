# Verify

Verify's billed-side mapper turns the current Stripe invoice landing records
into tenant-scoped facts keyed by Teideal customer, Stripe price, and service
period. The discrepancy report compares those period totals with the existing
period-close computation. Neither endpoint maps Stripe prices to Teideal plans.

## POST /verify/map-billed-lines [ts-console]

- **Auth:** Console session with `Owner`, `Billing Admin`, or `Finance` role.
- **Request:** No parameters or request body. The mapper reads every current `invoice` record for the caller's tenant and resolves its Stripe customer through `stripe_customer_links`.
- **Response:** `200 {mapped_lines,unmapped_customers}`. `mapped_lines` is the number of invoice-line rows inserted or changed by this run. `unmapped_customers` is the number of newly recorded unresolved Stripe customers. Quantity and amount remain exact PostgreSQL numeric values derived from decimal strings; the route returns neither field.
- **Errors:** `401` expired or invalid session; `403` disallowed role; `500` a landed invoice line cannot satisfy the typed billed-line contract.

```bash
curl -X POST "$TS_CONSOLE_URL/verify/map-billed-lines" \
  -H "authorization: Bearer $SESSION_TOKEN"
```

## GET /verify/discrepancy-report [ts-console]

- **Auth:** Console session with `Owner`, `Billing Admin`, or `Finance` role.
- **Request:** Required calendar-month `period` in `YYYY-MM` format. Other query
  fields are ignored; in particular, callers cannot provide an expected total.
- **Response:** `200` with `data`, `excluded`, `totals`, `granularity`,
  `quantity_tolerance`, and `caveats`.
  - Each `data` row is one Teideal customer-period total. It contains
    `expected_total`, `billed_total`, `delta` (`expected - billed`), and one of
    `missing_line`, `quantity`, `rate_drift`, `known_coverage_gap`, or `null`.
  - `evidence.expected` identifies the exact revenue-ledger lines, overage
    consumption lines, and usage events used. `evidence.billed.lines` contains
    the exact `verify_billed_lines` rows.
  - `excluded` contains landed invoice customers that TEID-66 could not map.
    `totals.excluded_billed` states the corresponding excluded invoice-line
    amount; excluded dollars are not mixed into mapped-customer totals.
  - All monetary amounts are decimal strings. `granularity` is always
    `period_total`; this v0 does not claim line-level price matching.
- **Quantity tolerance:** The initial implementation uses a documented 1%
  default (`"0.01"`). A quantity difference must be greater than 1% of the
  independent usage quantity to classify as `quantity`; otherwise a nonzero
  dollar delta with activity on both sides is `rate_drift`.
- **Coverage behavior:** Credit, payment, or refund activity and invoice lines
  excluded by TEID-66 are checked before `missing_line`. Affected rows are
  `known_coverage_gap`, not leakage findings. The response also warns that
  billed data reflects the last successful connector sync: a Stripe-side
  deletion can leave a stale mapped row until follow-on detection exists.
- **Errors:** `400` invalid/missing period; `401` invalid session; `403`
  disallowed role; `502` go-usage failure; `504` go-usage timeout.

```bash
curl "$TS_CONSOLE_URL/verify/discrepancy-report?period=2026-08" \
  -H "authorization: Bearer $SESSION_TOKEN"
```
