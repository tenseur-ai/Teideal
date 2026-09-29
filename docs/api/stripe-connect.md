# Stripe Connect and processor-neutral lookup

All routes require a console session. Stripe calls use the connected account's
stored OAuth token; tokens are never returned to callers.

## GET /stripe/connect/authorize-url [ts-console]

- **Auth:** Any console role.
- **Request:** Query `scope` (`read_only` or `read_write`), optional sandbox UUID `sandbox_id`.
- **Response:** `200 {authorize_url,state}`.
- **Errors:** `400` invalid scope/UUID; `403` hidden sandbox.

```bash
curl "$TS_CONSOLE_URL/stripe/connect/authorize-url?scope=read_only" -H "authorization: Bearer $SESSION_TOKEN"
```

## POST /stripe/connect/callback [ts-console]

- **Auth:** Any console role; state binds the initiating operator/tenant.
- **Request:** JSON Stripe OAuth `code` and signed `state`.
- **Response:** `201` public connection metadata.
- **Errors:** `400` missing/invalid/replayed state or Stripe rejection; `403` live account for sandbox.

```bash
curl -X POST "$TS_CONSOLE_URL/stripe/connect/callback" -H "authorization: Bearer $SESSION_TOKEN" -H 'content-type: application/json' -d '{"code":"'$STRIPE_CODE'","state":"'$STRIPE_STATE'"}'
```

## POST /stripe/connections/:id/request-write-access [ts-console]

- **Auth:** Any console role.
- **Request:** Connection UUID; empty body.
- **Response:** `200` authorization URL/state for scope upgrade.
- **Errors:** `400` invalid UUID; `404` hidden connection.

```bash
curl -X POST "$TS_CONSOLE_URL/stripe/connections/$CONNECTION_ID/request-write-access" -H "authorization: Bearer $SESSION_TOKEN"
```

## POST /stripe/connections/:id/disconnect [ts-console]

- **Auth:** Any console role.
- **Request:** Connection UUID; empty body.
- **Response:** `200` disconnected public metadata.
- **Errors:** `400` invalid UUID; `404` hidden connection.

```bash
curl -X POST "$TS_CONSOLE_URL/stripe/connections/$CONNECTION_ID/disconnect" -H "authorization: Bearer $SESSION_TOKEN"
```

## POST /stripe/customers/sync [ts-console]

- **Auth:** Any console role and connected Stripe account.
- **Request:** Optional sync controls in JSON; empty object performs the normal incremental sync.
- **Response:** `200` counts/cursor for synchronized customers and candidates.
- **Errors:** `400` no/closed connection; `403` insufficient Stripe scope; `502` Stripe failure.

```bash
curl -X POST "$TS_CONSOLE_URL/stripe/customers/sync" -H "authorization: Bearer $SESSION_TOKEN" -H 'content-type: application/json' -d '{}'
```

## GET /stripe/customers/match-candidates [ts-console]

- **Auth:** Any console role.
- **Request:** No body.
- **Response:** `200 {data}` unresolved Stripe-to-Teideal candidates.
- **Errors:** `401` invalid session.

```bash
curl "$TS_CONSOLE_URL/stripe/customers/match-candidates" -H "authorization: Bearer $SESSION_TOKEN"
```

## POST /stripe/customers/:customerId/link-stripe [ts-console]

- **Auth:** Any console role and connected Stripe account.
- **Request:** Teideal customer UUID; either JSON `stripe_customer_id` or `{create_new:{name,email}}`.
- **Response:** `201` customer-to-processor link.
- **Errors:** `400` invalid input/no connection; `404` customer; `409` either side already linked; `502` Stripe failure.

```bash
curl -X POST "$TS_CONSOLE_URL/stripe/customers/$CUSTOMER_ID/link-stripe" -H "authorization: Bearer $SESSION_TOKEN" -H 'content-type: application/json' -d '{"stripe_customer_id":"cus_example"}'
```

## POST /stripe/candidates/:id/create-in-teideal [ts-console]

- **Auth:** Any console role.
- **Request:** Match-candidate UUID; empty body.
- **Response:** `201 {customer,link}`.
- **Errors:** `400` invalid UUID/missing candidate email; `404` candidate missing.

```bash
curl -X POST "$TS_CONSOLE_URL/stripe/candidates/$CANDIDATE_ID/create-in-teideal" -H "authorization: Bearer $SESSION_TOKEN"
```

## GET /stripe/customers/by-stripe-id/:stripeCustomerId [ts-console]

- **Auth:** Any console role.
- **Request:** URL-encoded Stripe customer ID.
- **Response:** `200` processor-neutral customer, subscription, and receivable-balance view.
- **Errors:** `400` malformed ID; `404` no active tenant-owned link.

```bash
curl "$TS_CONSOLE_URL/stripe/customers/by-stripe-id/cus_example" -H "authorization: Bearer $SESSION_TOKEN"
```

## GET /processor-neutrality/disconnect-check [ts-console]

- **Auth:** Any console role.
- **Request:** No body.
- **Response:** `200` invariant/check summary proving Teideal data survives processor disconnect.
- **Errors:** `401` invalid session; `500` query failure.

```bash
curl "$TS_CONSOLE_URL/processor-neutrality/disconnect-check" -H "authorization: Bearer $SESSION_TOKEN"
```

