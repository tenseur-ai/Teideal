# Verify

Verify's billed-side mapper turns the current Stripe invoice landing records
into tenant-scoped facts keyed by Teideal customer, Stripe price, and service
period. It does not rate usage, map Stripe prices to Teideal plans, or compute
expected charges or discrepancies.

## POST /verify/map-billed-lines [ts-console]

- **Auth:** Console session with `Owner`, `Billing Admin`, or `Finance` role.
- **Request:** No parameters or request body. The mapper reads every current `invoice` record for the caller's tenant and resolves its Stripe customer through `stripe_customer_links`.
- **Response:** `200 {mapped_lines,unmapped_customers}`. `mapped_lines` is the number of invoice-line rows inserted or changed by this run. `unmapped_customers` is the number of newly recorded unresolved Stripe customers. Quantity and amount remain exact PostgreSQL numeric values derived from decimal strings; the route returns neither field.
- **Errors:** `401` expired or invalid session; `403` disallowed role; `500` a landed invoice line cannot satisfy the typed billed-line contract.

```bash
curl -X POST "$TS_CONSOLE_URL/verify/map-billed-lines" \
  -H "authorization: Bearer $SESSION_TOKEN"
```
