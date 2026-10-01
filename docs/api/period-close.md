# Period close

Period-close summaries are computed live for one company-wide UTC calendar
month. They are not customer billing-cycle snapshots and are never cached.

`usage_billed` and `adjustments` are exact sums from Teideal's double-entry
revenue ledger. Credit consumption and expiry values come from the separate
grant/credit-balance ledger; the displayed columns are not components of a
single grand total. Stripe invoice/charge reconciliation is deferred until
the E11/Verify reconciliation source exists.

## GET /period-close/ledger-summary [go-usage]

- **Auth:** `read-only` or `admin` API key, or a console session. The result is tenant-wide.
- **Request:** Required RFC3339 `since` and `until` query parameters defining a half-open range. Period-close callers pass the first instant of a UTC month and the first instant of the next month.
- **Response:** `200 {data:[{customer_id,usage_billed,adjustments}]}`. Amounts are decimal strings. Customers with no ledger activity are omitted here and supplied as zero rows by the console summary.
- **Errors:** `400` missing/invalid/reversed range; `401/403` invalid authorization or scope; `500` aggregate query failure.

```bash
curl "$GO_USAGE_URL/period-close/ledger-summary?since=2026-08-01T00%3A00%3A00.000Z&until=2026-09-01T00%3A00%3A00.000Z" \
  -H "authorization: Bearer $API_KEY"
```

## GET /period-close-summary [ts-console]

- **Auth:** Console session with `Owner`, `Billing Admin`, or `Finance` role.
- **Request:** Required `period=YYYY-MM`; optional `sort=name|usage_billed`, case-insensitive customer-name `search`, opaque `cursor`, positive `limit` (maximum 500), and `format=json|csv|xlsx` (default `json`). The period is always `[first day 00:00:00Z, first day of next month 00:00:00Z)`. CSV/XLSX ignore `cursor` and `limit` and include every matching row.
- **Response:** JSON returns `200 {data:[{customer_id,customer_name,usage_billed,credits_consumed_by_source:{paid,promotional,commit,goodwill,overage},commit_drawn_down,overage,expired_credits,adjustments}],next_cursor}`. All amounts are decimal strings and inactive customers have explicit zeroes. CSV and XLSX return attachment downloads rendered from the same complete row array.
- **Errors:** `400` invalid period/sort/search/cursor/limit/format; `401` expired or invalid session; `403` disallowed role; `502/504` usage-service failure or timeout.

JSON rows also include `last_stripe_sync_status` (`running`, `succeeded`, `failed`, or `null`) and `last_stripe_sync_error` from the latest period-close Stripe invoice sync attempt for that customer and month.

```bash
curl "$TS_CONSOLE_URL/period-close-summary?period=2026-08&sort=name&format=csv" \
  -H "authorization: Bearer $SESSION_TOKEN" \
  -o period-close-2026-08.csv
```

## POST /period-close/:customerId/stripe-sync [ts-console]

- **Auth:** Console session with `Owner`, `Billing Admin`, or `Finance` role.
- **Request:** Customer UUID and JSON `{period_start,period_end}` as RFC3339 timestamps for a half-open range. The tenant must have a connected `read_write` Stripe account and a `stripe_customer_links` row for the customer.
- **Response:** `202 {attempt_id,status,error_message}` when a new sync attempt runs (`status` is `succeeded` or `failed`). `200 {data:[{id,customer_id,period_start,period_end,category,stripe_invoice_item_id,amount,ledger_reference,created_at}]}` when that period was already synced — the existing line items are returned and Stripe is not written again. Amounts are decimal strings. A category whose total is zero is omitted.
- **Errors:** `400` invalid UUID/range, disconnected Stripe, or a customer that is not linked to Stripe; `401` expired or invalid session; `403` disallowed role or a read-only Stripe connection; `404` customer not found for this tenant.

```bash
curl -X POST "$TS_CONSOLE_URL/period-close/$CUSTOMER_ID/stripe-sync" \
  -H "authorization: Bearer $SESSION_TOKEN" \
  -H "content-type: application/json" \
  -d '{"period_start":"2026-08-01T00:00:00.000Z","period_end":"2026-09-01T00:00:00.000Z"}'
```

