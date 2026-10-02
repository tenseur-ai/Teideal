# Plans, versions, and subscriptions

All routes require a console session. Write operations require Owner or
Billing Admin unless noted.

## POST /plans [ts-console]

- **Auth:** Owner or Billing Admin session.
- **Request:** JSON `name`, optional `currency`, and `rates` (`metric`, `model`, decimal `rate`).
- **Response:** `201` draft plan and rates.
- **Errors:** `400` invalid fields or duplicate metric/model; `403` wrong role.

```bash
curl -X POST "$TS_CONSOLE_URL/plans" -H "authorization: Bearer $SESSION_TOKEN" -H 'content-type: application/json' -d '{"name":"Starter","currency":"USD","rates":[{"metric":"api.request","model":"per_unit","rate":"0.001"}]}'
```

## GET /plans [ts-console]

- **Auth:** Any console role.
- **Request:** Optional `limit` (1–200) and plan UUID `cursor`.
- **Response:** `200 {data,cursor}`.
- **Errors:** `400` invalid pagination; `401` invalid session.

```bash
curl "$TS_CONSOLE_URL/plans?limit=50" -H "authorization: Bearer $SESSION_TOKEN"
```

## GET /plans/:id [ts-console]

- **Auth:** Any console role.
- **Request:** Plan UUID.
- **Response:** `200` plan with rates.
- **Errors:** `400` invalid UUID; `404` no visible plan.

```bash
curl "$TS_CONSOLE_URL/plans/$PLAN_ID" -H "authorization: Bearer $SESSION_TOKEN"
```

## PATCH /plans/:id [ts-console]

- **Auth:** Owner or Billing Admin session.
- **Request:** Plan UUID; JSON may update `name`, `currency`, and/or `rates` while draft.
- **Response:** `200` updated plan.
- **Errors:** `400` invalid/duplicate rates; `404` not found; `409` already published.

```bash
curl -X PATCH "$TS_CONSOLE_URL/plans/$PLAN_ID" -H "authorization: Bearer $SESSION_TOKEN" -H 'content-type: application/json' -d '{"name":"Starter 2027"}'
```

## POST /plans/:id/publish [ts-console]

- **Auth:** Owner or Billing Admin session.
- **Request:** Plan UUID; empty body.
- **Response:** `200` published immutable plan.
- **Errors:** `400` invalid UUID; `409` not publishable/already published.

```bash
curl -X POST "$TS_CONSOLE_URL/plans/$PLAN_ID/publish" -H "authorization: Bearer $SESSION_TOKEN"
```

## POST /plans/:planFamilyId/versions [ts-console]

- **Auth:** Owner or Billing Admin session.
- **Request:** Family UUID; JSON plan fields/rates for the next version.
- **Response:** `201` next draft version.
- **Errors:** `400` invalid/duplicate rates; `404` family missing; `409` current draft/not published.

```bash
curl -X POST "$TS_CONSOLE_URL/plans/$PLAN_FAMILY_ID/versions" -H "authorization: Bearer $SESSION_TOKEN" -H 'content-type: application/json' -d '{"name":"Starter v2","rates":[{"metric":"api.request","model":"per_unit","rate":"0.0008"}]}'
```

## POST /customers/:id/subscription [ts-console]

- **Auth:** Owner or Billing Admin session.
- **Request:** Customer UUID; JSON `plan_id` (published plan UUID).
- **Response:** `201` subscription.
- **Errors:** `400` invalid UUID; `403` hidden customer; `404` plan/subscription missing.

```bash
curl -X POST "$TS_CONSOLE_URL/customers/$CUSTOMER_ID/subscription" -H "authorization: Bearer $SESSION_TOKEN" -H 'content-type: application/json' -d '{"plan_id":"'$PLAN_ID'"}'
```

## GET /customers/:id/subscription [ts-console]

- **Auth:** Owner or Billing Admin session.
- **Request:** Customer UUID.
- **Response:** `200` current subscription row.
- **Errors:** `400` invalid UUID; `403` hidden customer/wrong role; `404` subscription missing.

```bash
curl "$TS_CONSOLE_URL/customers/$CUSTOMER_ID/subscription" -H "authorization: Bearer $SESSION_TOKEN"
```

## POST /customers/:id/subscription/schedule-migration [ts-console]

- **Auth:** Owner or Billing Admin session.
- **Request:** Customer UUID; JSON `target_version` plus exactly one of `use_next_period_boundary:true` or `effective_at`.
- **Response:** `200` scheduled subscription migration.
- **Errors:** `400` invalid schedule/version; `403` hidden customer; `404` subscription/version missing.

```bash
curl -X POST "$TS_CONSOLE_URL/customers/$CUSTOMER_ID/subscription/schedule-migration" -H "authorization: Bearer $SESSION_TOKEN" -H 'content-type: application/json' -d '{"target_version":2,"use_next_period_boundary":true}'
```

## POST /customers/:id/subscription/grandfather [ts-console]

- **Auth:** Owner or Billing Admin session.
- **Request:** Customer UUID; JSON boolean `grandfathered`.
- **Response:** `200` updated subscription.
- **Errors:** `400` invalid UUID/boolean; `403` hidden customer; `404` subscription missing.

```bash
curl -X POST "$TS_CONSOLE_URL/customers/$CUSTOMER_ID/subscription/grandfather" -H "authorization: Bearer $SESSION_TOKEN" -H 'content-type: application/json' -d '{"grandfathered":true}'
```

## GET /plans/:planFamilyId/versions/:version/migration-preview [ts-console]

- **Auth:** Owner or Billing Admin session.
- **Request:** Family UUID and positive integer version.
- **Response:** `200` affected subscriptions and timing preview.
- **Errors:** `400` invalid family/version; `404` version missing; `403` wrong role.

```bash
curl "$TS_CONSOLE_URL/plans/$PLAN_FAMILY_ID/versions/2/migration-preview" -H "authorization: Bearer $SESSION_TOKEN"
```

