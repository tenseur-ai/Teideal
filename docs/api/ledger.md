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

