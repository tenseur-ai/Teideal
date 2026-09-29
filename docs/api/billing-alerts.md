# Balance threshold alerts

Per-plan or per-customer configuration for balance/commit threshold alerts,
delivered to operators by email and Slack and optionally to the end
customer by email. A background worker evaluates active grants on an
interval and fires each crossed threshold at most once per billing period.

## GET /billing-alert-thresholds [ts-console]

- **Auth:** Owner or Billing Admin session.
- **Request:** Query `scope` (`plan` or `customer`) and `scope_id` (UUID).
- **Response:** `200 {id,scope,scope_id,threshold_pcts,operator_emails,slack_webhook_url,notify_customer,customer_email,created_at,updated_at}`.
- **Errors:** `400` invalid `scope`/`scope_id`; `404` no config exists for that scope.

```bash
curl "$TS_CONSOLE_URL/billing-alert-thresholds?scope=customer&scope_id=$CUSTOMER_ID" -H "authorization: Bearer $SESSION_TOKEN"
```

## PUT /billing-alert-thresholds [ts-console]

- **Auth:** Owner or Billing Admin session.
- **Request:** Query `scope`/`scope_id` as above; JSON body `threshold_pcts` (array of integers, each `0 < pct <= 100`), optional `operator_emails`, `slack_webhook_url`, `notify_customer`, `customer_email` (required when `notify_customer` is `true`). Defaults to `[50, 80, 100]` when no row exists yet and `threshold_pcts` is omitted.
- **Response:** `200` the saved configuration, same shape as `GET`.
- **Errors:** `400` invalid `scope`/`scope_id`/threshold values/missing `customer_email`; `404` the plan or customer named by `scope_id` does not exist for this tenant.

```bash
curl -X PUT "$TS_CONSOLE_URL/billing-alert-thresholds?scope=customer&scope_id=$CUSTOMER_ID" -H "authorization: Bearer $SESSION_TOKEN" -H 'content-type: application/json' -d '{"threshold_pcts":[60,85,95],"slack_webhook_url":"https://hooks.example.test/services/T000/B000/XXXX"}'
```

## GET /billing-alert-thresholds/delivery-failures [ts-console]

- **Auth:** Owner or Billing Admin session.
- **Request:** No parameters; scoped to the caller's tenant.
- **Response:** `200 {data:[{id,customer_id,customer_name,grant_id,threshold_pct,period_start,sent_at,delivery_status}]}` — every recorded alert with at least one failed channel (`delivery_status.operator_email`/`slack`/`customer_email` is `"failed"`).
- **Errors:** none beyond standard auth.

```bash
curl "$TS_CONSOLE_URL/billing-alert-thresholds/delivery-failures" -H "authorization: Bearer $SESSION_TOKEN"
```
