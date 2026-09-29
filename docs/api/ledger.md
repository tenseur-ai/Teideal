# Reservations, ledger transactions, and balance integrity

These finance/integrity routes are served by `go-usage` and require an
`admin` API key. Ledger transactions are append-only and must balance to zero.

## POST /reservations [go-usage]

- **Auth:** `admin` API key.
- **Request:** JSON UUID `customer_id`, optional UUID `usage_event_id`, and reservation fields/amounts.
- **Response:** `201` reservation placeholder record.
- **Errors:** `400` invalid JSON/UUID; `403` referenced tenant object hidden; `401` auth; `500` insert failure.

```bash
curl -X POST "$GO_USAGE_URL/reservations" -H "authorization: Bearer $API_KEY" -H 'content-type: application/json' -d '{"customer_id":"'$CUSTOMER_ID'","amount":"10","currency":"USD"}'
```

## POST /ledger/transactions [go-usage]

- **Auth:** `admin` API key.
- **Request:** JSON transaction metadata and at least two lines (`account_code`, decimal `amount`, optional customer/reference); line sum must be zero.
- **Response:** `201` immutable transaction with lines.
- **Errors:** `400` validation/unbalanced lines; `404` referenced object missing; `401/403` auth; `500` operation failure.

```bash
curl -X POST "$GO_USAGE_URL/ledger/transactions" -H "authorization: Bearer $API_KEY" -H 'content-type: application/json' -d '{"reference":"invoice-example","lines":[{"account_code":"receivable","amount":"10","customer_id":"'$CUSTOMER_ID'"},{"account_code":"revenue","amount":"-10"}]}'
```

## POST /ledger/transactions/{id}/reverse [go-usage]

- **Auth:** `admin` API key.
- **Request:** Transaction UUID; JSON non-empty `reason`.
- **Response:** `201` new inverse transaction linked to the original.
- **Errors:** `400` invalid UUID/JSON/reason/already reversed; `404` hidden transaction; `401/403` auth; `500` operation failure.

```bash
curl -X POST "$GO_USAGE_URL/ledger/transactions/$TRANSACTION_ID/reverse" -H "authorization: Bearer $API_KEY" -H 'content-type: application/json' -d '{"reason":"invoice voided"}'
```

## GET /ledger/transactions/{id} [go-usage]

- **Auth:** `admin` API key.
- **Request:** Transaction UUID.
- **Response:** `200` transaction, lines, and reversal linkage.
- **Errors:** `400` invalid UUID; `404` hidden/missing transaction; `401/403` auth; `500` operation failure.

```bash
curl "$GO_USAGE_URL/ledger/transactions/$TRANSACTION_ID" -H "authorization: Bearer $API_KEY"
```

## GET /customers/{id}/reservations [go-usage]

- **Auth:** `read-only` or `admin` API key, or a console session.
- **Request:** Customer UUID; optional `since`/`until`/`limit`/cursor.
- **Response:** `200 {data:[{id,customer_id,usage_event_id,created_at}],next_cursor}`.
- **Errors:** `400` invalid UUID/date range/cursor; `403` `customer_id` not visible to caller's tenant; `401/403` auth; `500` query failure.

```bash
curl "$GO_USAGE_URL/customers/$CUSTOMER_ID/reservations" -H "authorization: Bearer $API_KEY"
```

## GET /customers/{id}/ledger-transactions [go-usage]

- **Auth:** `read-only` or `admin` API key, or a console session.
- **Request:** Customer UUID; optional `since`/`until`/`limit`/cursor.
- **Response:** `200 {data:[{id,customer_id,usage_event_id,grant_id,reservation_id,pricing_rule_id,plan_version,description,created_at}],next_cursor}`.
- **Errors:** `400` invalid UUID/date range/cursor; `403` `customer_id` not visible to caller's tenant; `401/403` auth; `500` query failure.

```bash
curl "$GO_USAGE_URL/customers/$CUSTOMER_ID/ledger-transactions" -H "authorization: Bearer $API_KEY"
```

## GET /ledger/transactions/{id}/detail [go-usage]

- **Auth:** `read-only` or `admin` API key, or a console session. Used by the [customer timeline](timeline.md)'s charge drill-down -- no `invoices` table exists yet, so a ledger transaction stands in for an invoice line.
- **Request:** Ledger transaction UUID.
- **Response:** `200` the transaction (with its `ledger_lines`) plus `usage_event` (the originating usage event, or `null`).
- **Errors:** `400` invalid UUID; `403` transaction's customer not visible to caller's tenant (re-checked explicitly -- RLS alone cannot express `api_keys.customer_id` scoping); `404` missing transaction; `401/403` auth; `500` query failure.

```bash
curl "$GO_USAGE_URL/ledger/transactions/$TRANSACTION_ID/detail" -H "authorization: Bearer $API_KEY"
```

## POST /customers/{id}/recalculate-balance [go-usage]

- **Auth:** `admin` API key.
- **Request:** Customer UUID; empty body.
- **Response:** `200 {customer_id,balance,recalculated_at}` derived from receivable lines.
- **Errors:** `400` invalid UUID; `401/403` auth; `500` calculation failure.

```bash
curl -X POST "$GO_USAGE_URL/customers/$CUSTOMER_ID/recalculate-balance" -H "authorization: Bearer $API_KEY"
```

## GET /balance-integrity/checks [go-usage]

- **Auth:** `admin` API key.
- **Request:** No body.
- **Response:** `200 {data}` recent cached-versus-derived balance checks.
- **Errors:** `401/403` auth; `500` query failure.

```bash
curl "$GO_USAGE_URL/balance-integrity/checks" -H "authorization: Bearer $API_KEY"
```

