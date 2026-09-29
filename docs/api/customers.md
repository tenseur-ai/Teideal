# Customers, hierarchy, consumption, and rate overrides

Customer CRUD uses API-key authentication. Hierarchy, consumption, and
override routes use console sessions and enforce tenant visibility.

## POST /customers [ts-console]

- **Auth:** `admin` API key.
- **Request:** JSON `name`, `email`.
- **Response:** `201 {id,name,email,created_at}`.
- **Errors:** `400` missing fields; `401/403` invalid key or scope.

```bash
curl -X POST "$TS_CONSOLE_URL/customers" -H "authorization: Bearer $API_KEY" -H 'content-type: application/json' -d '{"name":"Ada Example","email":"ada@example.test"}'
```

## GET /customers [ts-console]

- **Auth:** `read-only` or `admin` API key.
- **Request:** No body.
- **Response:** `200 {data:[customer...]}` for the key's tenant/customer scope.
- **Errors:** `401/403` invalid key or scope.

```bash
curl "$TS_CONSOLE_URL/customers" -H "authorization: Bearer $API_KEY"
```

## GET /customers/:id [ts-console]

- **Auth:** `read-only` or `admin` API key.
- **Request:** Path customer UUID.
- **Response:** `200` customer.
- **Errors:** `400` invalid UUID; `403` customer hidden from tenant/key; `401` invalid key.

```bash
curl "$TS_CONSOLE_URL/customers/$CUSTOMER_ID" -H "authorization: Bearer $API_KEY"
```

## PATCH /customers/:id [ts-console]

- **Auth:** `admin` API key.
- **Request:** Path UUID; JSON may contain string `name` and/or `email`.
- **Response:** `200` updated customer.
- **Errors:** `400` invalid UUID/field; `403` hidden customer or scope.

```bash
curl -X PATCH "$TS_CONSOLE_URL/customers/$CUSTOMER_ID" -H "authorization: Bearer $API_KEY" -H 'content-type: application/json' -d '{"name":"Ada Updated"}'
```

## POST /organisations [ts-console]

- **Auth:** Owner or Billing Admin session.
- **Request:** JSON `name`, `email`, optional `balance_mode` (`isolated`; pooled roots are rejected).
- **Response:** `201` organisation customer.
- **Errors:** `400` invalid identity/mode; `403` wrong role.

```bash
curl -X POST "$TS_CONSOLE_URL/organisations" -H "authorization: Bearer $SESSION_TOKEN" -H 'content-type: application/json' -d '{"name":"Example Org","email":"billing@example.test","balance_mode":"isolated"}'
```

## POST /organisations/:id/teams [ts-console]

- **Auth:** Owner or Billing Admin session.
- **Request:** Organisation UUID; JSON `name`, `email`, optional `balance_mode`.
- **Response:** `201` child team.
- **Errors:** `400` invalid input; `403` hidden parent/wrong role.

```bash
curl -X POST "$TS_CONSOLE_URL/organisations/$ORGANISATION_ID/teams" -H "authorization: Bearer $SESSION_TOKEN" -H 'content-type: application/json' -d '{"name":"Platform","email":"platform@example.test","balance_mode":"pooled"}'
```

## GET /organisations/:id/tree [ts-console]

- **Auth:** Any console role.
- **Request:** Organisation UUID.
- **Response:** `200` nested customer tree with balance modes.
- **Errors:** `400` invalid UUID; `403` hidden organisation.

```bash
curl "$TS_CONSOLE_URL/organisations/$ORGANISATION_ID/tree" -H "authorization: Bearer $SESSION_TOKEN"
```

## PATCH /organisations/:id/parent [ts-console]

- **Auth:** Owner or Billing Admin session.
- **Request:** Customer UUID; JSON `new_parent_customer_id` (UUID or null).
- **Response:** `200` moved customer.
- **Errors:** `400` invalid UUID/circular hierarchy; `403` hidden node; `409` balance constraint conflict.

```bash
curl -X PATCH "$TS_CONSOLE_URL/organisations/$TEAM_ID/parent" -H "authorization: Bearer $SESSION_TOKEN" -H 'content-type: application/json' -d '{"new_parent_customer_id":"'$ORGANISATION_ID'"}'
```

## POST /customers/:id/consume [ts-console]

- **Auth:** Owner or Billing Admin session.
- **Request:** Customer UUID; JSON `amount`, `unit`, optional RFC3339 `as_of`.
- **Response:** `201` consumption record and ordered draw lines.
- **Errors:** `400` invalid input; `403` hidden customer; `409` hierarchy ceiling exceeded.

```bash
curl -X POST "$TS_CONSOLE_URL/customers/$CUSTOMER_ID/consume" -H "authorization: Bearer $SESSION_TOKEN" -H 'content-type: application/json' -d '{"amount":10,"unit":"credits"}'
```

## GET /customers/:id/consumption-timeline [ts-console]

- **Auth:** Any console role.
- **Request:** Customer UUID; optional `limit` and UUID `cursor`.
- **Response:** `200 {data,cursor}` ordered newest first.
- **Errors:** `400` invalid UUID/pagination; `403` hidden customer.

```bash
curl "$TS_CONSOLE_URL/customers/$CUSTOMER_ID/consumption-timeline?limit=50" -H "authorization: Bearer $SESSION_TOKEN"
```

## PUT /customers/:id/consumption-order [ts-console]

- **Auth:** Owner or Billing Admin session.
- **Request:** Customer UUID; JSON `sources`, a permutation of promotional/paid/commit/goodwill.
- **Response:** `200` saved override.
- **Errors:** `400` invalid UUID/order; `403` hidden customer/wrong role.

```bash
curl -X PUT "$TS_CONSOLE_URL/customers/$CUSTOMER_ID/consumption-order" -H "authorization: Bearer $SESSION_TOKEN" -H 'content-type: application/json' -d '{"sources":["promotional","paid","commit","goodwill"]}'
```

## GET /customers/:id/consumption-order [ts-console]

- **Auth:** Any console role.
- **Request:** Customer UUID.
- **Response:** `200` configured order and effective source.
- **Errors:** `400` invalid UUID; `403` hidden customer.

```bash
curl "$TS_CONSOLE_URL/customers/$CUSTOMER_ID/consumption-order" -H "authorization: Bearer $SESSION_TOKEN"
```

## POST /customers/:id/consumption/replay-check [ts-console]

- **Auth:** Owner or Billing Admin session.
- **Request:** Customer UUID; JSON `event_ids` (1–50,000 UUIDs).
- **Response:** `200` deterministic replay result.
- **Errors:** `400` invalid UUID/list; `403` hidden customer/event; `409` replay mismatch.

```bash
curl -X POST "$TS_CONSOLE_URL/customers/$CUSTOMER_ID/consumption/replay-check" -H "authorization: Bearer $SESSION_TOKEN" -H 'content-type: application/json' -d '{"event_ids":["'$EVENT_ID'"]}'
```

## POST /customers/:id/rate-overrides [ts-console]

- **Auth:** Owner or Billing Admin session.
- **Request:** Customer UUID; JSON `metric`, `model`, decimal `rate`, `starts_at`, optional `ends_at`.
- **Response:** `201` override.
- **Errors:** `400` invalid/range-overlap input; `403` hidden customer.

```bash
curl -X POST "$TS_CONSOLE_URL/customers/$CUSTOMER_ID/rate-overrides" -H "authorization: Bearer $SESSION_TOKEN" -H 'content-type: application/json' -d '{"metric":"api.request","model":"per_unit","rate":"0.0008","starts_at":"2030-01-01T00:00:00Z"}'
```

## GET /customers/:id/rate-overrides [ts-console]

- **Auth:** Any console role.
- **Request:** Customer UUID; optional `limit` and cursor.
- **Response:** `200 {data,cursor}`.
- **Errors:** `400` invalid UUID/pagination; `403` hidden customer.

```bash
curl "$TS_CONSOLE_URL/customers/$CUSTOMER_ID/rate-overrides" -H "authorization: Bearer $SESSION_TOKEN"
```

## GET /docs/rate-override-precedence [ts-console]

- **Auth:** Any console role.
- **Request:** No body.
- **Response:** `200 {rule}` describing customer override, plan rate, then no-rate precedence.
- **Errors:** `401` invalid session.

```bash
curl "$TS_CONSOLE_URL/docs/rate-override-precedence" -H "authorization: Bearer $SESSION_TOKEN"
```

## POST /customers/:id/price-usage [ts-console]

- **Auth:** Owner or Billing Admin session.
- **Request:** Customer UUID; JSON `metric`, `model`, `quantity`, optional `plan_id` and `as_of`.
- **Response:** `201` priced usage line including resolved rate/override.
- **Errors:** `400` invalid input; `403` hidden customer; `404` no subscription/rate.

```bash
curl -X POST "$TS_CONSOLE_URL/customers/$CUSTOMER_ID/price-usage" -H "authorization: Bearer $SESSION_TOKEN" -H 'content-type: application/json' -d '{"plan_id":"'$PLAN_ID'","metric":"api.request","model":"per_unit","quantity":2500}'
```

