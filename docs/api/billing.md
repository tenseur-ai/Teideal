# Money, billing configuration, periods, and rounding

All amounts and quantities that can exceed binary floating-point precision are
decimal strings. These `go-usage` routes require an `admin` API key.

## GET /rounding-config [go-usage]

- **Auth:** `admin` API key.
- **Request:** No body.
- **Response:** `200 {rounding_method,rounding_point,updated_at}`.
- **Errors:** `401/403` invalid key/scope; `500` query failure.

```bash
curl "$GO_USAGE_URL/rounding-config" -H "authorization: Bearer $API_KEY"
```

## PUT /rounding-config [go-usage]

- **Auth:** `admin` API key.
- **Request:** JSON `rounding_method` (`round_half_up` or `round_half_to_even`) and `rounding_point` (`per_line`, `per_invoice`, or `per_event`).
- **Response:** `200` saved configuration.
- **Errors:** `400` invalid JSON/value; `401/403` auth; `500` update failure.

```bash
curl -X PUT "$GO_USAGE_URL/rounding-config" -H "authorization: Bearer $API_KEY" -H 'content-type: application/json' -d '{"rounding_method":"round_half_up","rounding_point":"per_line"}'
```

## POST /money/preview [go-usage]

- **Auth:** `admin` API key.
- **Request:** JSON `currency`, `rounding_method`, `rounding_point`, and `lines` containing decimal-string `amount` values.
- **Response:** `200` exact line/invoice totals before and after currency rounding.
- **Errors:** `400` invalid JSON/currency/method/point/decimal; `401/403` auth; `500` config failure.

```bash
curl -X POST "$GO_USAGE_URL/money/preview" -H "authorization: Bearer $API_KEY" -H 'content-type: application/json' -d '{"currency":"USD","rounding_method":"round_half_up","rounding_point":"per_line","lines":[{"amount":"1.005"}]}'
```

## POST /money/price [go-usage]

- **Auth:** `admin` API key.
- **Request:** JSON `currency`, decimal-string `quantity`, decimal-string `unit_price` (max 12 places), optional `rounding_method`.
- **Response:** `200 {line_amount,invoice_amount}`.
- **Errors:** `400` invalid currency/decimal/quantity/method; `401/403` auth.

```bash
curl -X POST "$GO_USAGE_URL/money/price" -H "authorization: Bearer $API_KEY" -H 'content-type: application/json' -d '{"currency":"USD","quantity":"2500","unit_price":"0.0008"}'
```

## GET /customers/{id}/billing-config [go-usage]

- **Auth:** `admin` API key.
- **Request:** Customer UUID.
- **Response:** `200` timezone, anchor day, and optional auto-approval threshold.
- **Errors:** `400` invalid UUID; `401/403` auth; `404` hidden customer; `500` query failure.

```bash
curl "$GO_USAGE_URL/customers/$CUSTOMER_ID/billing-config" -H "authorization: Bearer $API_KEY"
```

## PUT /customers/{id}/billing-config [go-usage]

- **Auth:** `admin` API key.
- **Request:** Customer UUID; JSON optional `billing_timezone`, `billing_anchor_day` (1–31), and decimal `auto_approve_adjustment_threshold` (0–1,000,000 or null).
- **Response:** `200` saved configuration.
- **Errors:** `400` invalid UUID/JSON/timezone/range; `404` hidden customer; `401/403` auth; `500` update failure.

```bash
curl -X PUT "$GO_USAGE_URL/customers/$CUSTOMER_ID/billing-config" -H "authorization: Bearer $API_KEY" -H 'content-type: application/json' -d '{"billing_timezone":"Asia/Kolkata","billing_anchor_day":1,"auto_approve_adjustment_threshold":"10"}'
```

## POST /period/resolve [go-usage]

- **Auth:** `admin` API key.
- **Request:** JSON UUID `customer_id` and RFC3339 `instant` with explicit offset.
- **Response:** `200 {period_start,period_end,billing_timezone,billing_anchor_day}`.
- **Errors:** `400` invalid JSON/UUID/timestamp; `404` hidden customer; `401/403` auth; `500` resolution failure.

```bash
curl -X POST "$GO_USAGE_URL/period/resolve" -H "authorization: Bearer $API_KEY" -H 'content-type: application/json' -d '{"customer_id":"'$CUSTOMER_ID'","instant":"2030-03-01T00:00:00Z"}'
```

