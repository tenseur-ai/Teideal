# Inference Cost Rates

Operator-facing CRUD API for managing effective-dated cost rates per model and metric.
Used to calculate unit costs and gross margins for usage events.

## POST /cost-rates [ts-console]

- **Auth:** Owner or Billing Admin session token.
- **Request:** JSON body with `model` (string), `metric` (string, matching `event_type`), `rate_per_unit` (non-negative number), optional `unit_size` (positive integer, default `1`), and `effective_from` (ISO 8601 timestamp string).
- **Response:** `201 {id, tenant_id, model, metric, rate_per_unit, unit_size, effective_from, created_at}`.
- **Errors:** `400` invalid input parameters; `409` a cost rate entry already exists for this model, metric, and effective date.

```bash
curl -X POST "$TS_CONSOLE_URL/cost-rates" \
  -H "Authorization: Bearer $SESSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4-class","metric":"tokens","rate_per_unit":0.02,"unit_size":1000,"effective_from":"2026-10-01T00:00:00Z"}'
```

## GET /cost-rates [ts-console]

- **Auth:** Session token (all roles).
- **Request:** Query parameters `model` (optional string) and `metric` (optional string).
- **Response:** `200 {data: [{id, tenant_id, model, metric, rate_per_unit, unit_size, effective_from, created_at}]}`.
- **Errors:** Standard authentication errors.

```bash
curl "$TS_CONSOLE_URL/cost-rates?model=gpt-4-class" \
  -H "Authorization: Bearer $SESSION_TOKEN"
```
