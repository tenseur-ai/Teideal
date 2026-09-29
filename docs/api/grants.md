# Grants and entitlement state

Grant amounts are exact decimal values. Eligibility uses `start_date <= as_of`
and an exclusive expiry (`as_of < expiry_date`).

## POST /grants [ts-console]

- **Auth:** Owner or Billing Admin session.
- **Request:** JSON customer/grant fields: `customer_id`, `amount`, `unit`, `source`, optional dates/metadata.
- **Response:** `201` active grant with `remaining_amount`.
- **Errors:** `400` field validation; `403` hidden customer/wrong role.

```bash
curl -X POST "$TS_CONSOLE_URL/grants" -H "authorization: Bearer $SESSION_TOKEN" -H 'content-type: application/json' -d '{"customer_id":"'$CUSTOMER_ID'","amount":1000,"unit":"credits","source":"paid"}'
```

## GET /grants [ts-console]

- **Auth:** Any console role.
- **Request:** Optional `limit` and grant UUID `cursor`.
- **Response:** `200 {data,cursor}`.
- **Errors:** `400` invalid pagination; `401` invalid session.

```bash
curl "$TS_CONSOLE_URL/grants?limit=50" -H "authorization: Bearer $SESSION_TOKEN"
```

## GET /grants/:id [ts-console]

- **Auth:** Any console role.
- **Request:** Grant UUID.
- **Response:** `200` grant including amount, remaining amount, status, dates, and source.
- **Errors:** `400` invalid UUID; `404` no visible grant.

```bash
curl "$TS_CONSOLE_URL/grants/$GRANT_ID" -H "authorization: Bearer $SESSION_TOKEN"
```

## GET /grants/:id/eligibility [ts-console]

- **Auth:** Any console role.
- **Request:** Grant UUID; optional RFC3339 `as_of` query.
- **Response:** `200 {eligible,remaining_amount,reason?}`.
- **Errors:** `400` invalid UUID/timestamp; `404` no visible grant.

```bash
curl "$TS_CONSOLE_URL/grants/$GRANT_ID/eligibility?as_of=2030-01-01T00%3A00%3A00Z" -H "authorization: Bearer $SESSION_TOKEN"
```

## POST /grants/:id/consume [ts-console]

- **Auth:** Owner or Billing Admin session.
- **Request:** Grant UUID; JSON positive `amount`, optional RFC3339 `as_of`.
- **Response:** `200` grant after atomic decrement.
- **Errors:** `400` invalid input; `409` insufficient/ineligible grant; `403` wrong role.

```bash
curl -X POST "$TS_CONSOLE_URL/grants/$GRANT_ID/consume" -H "authorization: Bearer $SESSION_TOKEN" -H 'content-type: application/json' -d '{"amount":10}'
```

## POST /grants/:id/void [ts-console]

- **Auth:** Owner or Billing Admin session.
- **Request:** Grant UUID; JSON non-empty `reason`.
- **Response:** `200` voided grant.
- **Errors:** `400` invalid UUID/reason; `404` grant missing; `409` already void/ineligible transition.

```bash
curl -X POST "$TS_CONSOLE_URL/grants/$GRANT_ID/void" -H "authorization: Bearer $SESSION_TOKEN" -H 'content-type: application/json' -d '{"reason":"contract cancelled"}'
```

## PATCH /grants/:id/amend [ts-console]

- **Auth:** Owner or Billing Admin session.
- **Request:** Grant UUID; JSON `reason` plus mutable grant fields (amount/dates/metadata).
- **Response:** `200` amended grant and audit detail.
- **Errors:** `400` invalid amendment; `404` missing grant; `409` non-amendable state.

```bash
curl -X PATCH "$TS_CONSOLE_URL/grants/$GRANT_ID/amend" -H "authorization: Bearer $SESSION_TOKEN" -H 'content-type: application/json' -d '{"reason":"approved increase","amount":1200}'
```

## POST /grant-templates [ts-console]

- **Auth:** Owner or Billing Admin session.
- **Request:** JSON recurring template fields: customer, amount/unit/source, cadence, and start/end configuration.
- **Response:** `201` recurring grant template.
- **Errors:** `400` invalid template; `403` hidden customer/wrong role.

```bash
curl -X POST "$TS_CONSOLE_URL/grant-templates" -H "authorization: Bearer $SESSION_TOKEN" -H 'content-type: application/json' -d '{"customer_id":"'$CUSTOMER_ID'","amount":100,"unit":"credits","source":"promotional","cadence":"monthly"}'
```

## GET /grant-ledger-entries [ts-console]

- **Auth:** Any console role.
- **Request:** Optional `grant_id`, `customer_id`, `limit`, and cursor filters.
- **Response:** `200 {data,cursor}` append-only grant changes.
- **Errors:** `400` invalid filters/pagination; `401` invalid session.

```bash
curl "$TS_CONSOLE_URL/grant-ledger-entries?grant_id=$GRANT_ID" -H "authorization: Bearer $SESSION_TOKEN"
```

