# Billing connectors

Connector health gives operators one tenant-scoped view of every billing-data
connection, including connections that have not completed their first sync.

## GET /connectors/sync-health [ts-console]

- **Auth:** Owner, Billing Admin, or Developer session.
- **Request:** No parameters; results are scoped to the caller's tenant.
- **Response:** `200 {data:[{connector_id,connector_type,display_name,status,last_sync_at,last_sync_status,consecutive_failures,cursor_high_water,backfill_completed_at,last_error}]}`. Connector `status` is `connected` or `disconnected`. `last_sync_at` retains the last successful sync time after a later failed attempt; `last_sync_status` describes the latest attempt. `last_error` is a human-readable, connector-attributed sentence and never exposes the raw upstream error. `cursor_high_water` is keyed by entity name with `{since,cursor}` page checkpoints. `backfill_completed_at` is null until the 24-month backfill is caught up.
- **Errors:** `401` invalid session; `403` disallowed role.

```bash
curl "$TS_CONSOLE_URL/connectors/sync-health" -H "authorization: Bearer $SESSION_TOKEN"
```

## POST /connectors/stripe/register [ts-console]

- **Auth:** Owner, Billing Admin, or Developer session.
- **Request:** JSON `{stripe_connection_id,display_name}`. The Stripe OAuth connection must belong to the caller's tenant, be connected, and have Stripe-granted `read_only` scope.
- **Response:** `201 {id,status}` for a connected Stripe billing connector.
- **Errors:** `400` invalid input or disconnected connection; `401` invalid session; `403` disallowed role or a write-scoped Stripe connection; `404` Stripe connection not found.

```bash
curl -X POST "$TS_CONSOLE_URL/connectors/stripe/register" -H "authorization: Bearer $SESSION_TOKEN" -H "content-type: application/json" -d '{"stripe_connection_id":"00000000-0000-0000-0000-000000000001","display_name":"Stripe Billing"}'
```

## POST /connectors/csv-import/invoices [ts-console]

- **Auth:** Owner, Billing Admin, or Developer session.
- **Request:** Multipart form containing one CSV file. Required headers are `invoice_id`, `customer_id`, `amount`, `currency`, `status`, and `issued_at`; extra columns are retained in `passthrough`.
- **Response:** `202 {csv_import_id,total,accepted,quarantined}`. Invalid rows are retained in `csv_import_quarantine` and do not prevent valid rows from importing.
- **Errors:** `400` missing/non-multipart file or malformed CSV; `401` invalid session; `403` disallowed role; `413` file exceeds 100 MiB.

```bash
curl -X POST "$TS_CONSOLE_URL/connectors/csv-import/invoices" -H "authorization: Bearer $SESSION_TOKEN" -F "file=@invoices.csv;type=text/csv"
```

## POST /connectors/:id/sync [ts-console]

- **Auth:** Owner, Billing Admin, or Developer session.
- **Request:** Connector UUID in `:id`; no body. The synchronous run is bounded by `CONNECTOR_BACKFILL_TIME_BUDGET_MS` and safely resumes from its page watermark.
- **Response:** `200 {completed,recordsSynced}`. `completed:false` means the bounded chunk made durable progress and the next tick/run will resume it.
- **Errors:** `400` invalid UUID or connector without remote synchronization; `401` invalid session; `403` disallowed role; `404` connected connector not found; `502` remote billing-system failure (humanized, without raw upstream text).

```bash
curl -X POST "$TS_CONSOLE_URL/connectors/$CONNECTOR_ID/sync" -H "authorization: Bearer $SESSION_TOKEN"
```

## DELETE /connectors/:id [ts-console]

- **Auth:** Owner, Billing Admin, or Developer session.
- **Request:** Connector UUID in `:id`; no body. Stripe connectors are also deauthorized through the existing Stripe Connect OAuth flow.
- **Response:** `200 {id,status:"disconnected"}`.
- **Errors:** `400` invalid UUID or Stripe deauthorization failure; `401` invalid session; `403` disallowed role; `404` connected connector not found.

```bash
curl -X DELETE "$TS_CONSOLE_URL/connectors/$CONNECTOR_ID" -H "authorization: Bearer $SESSION_TOKEN"
```
