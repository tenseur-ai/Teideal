# Health, security operations, audit, exports, and support documents

Admin-secret routes use `Authorization: Bearer $ADMIN_SECRET`; console routes
use a session. Health endpoints are unauthenticated.

## GET /healthz [ts-console]

- **Auth:** Public.
- **Request:** No body.
- **Response:** `200 {status:"ok"}`.
- **Errors:** No application errors; transport failure means the service is unavailable.

```javascript runnable
const url = `${process.env.TS_CONSOLE_URL ?? "http://127.0.0.1:8081"}/healthz`;
const response = await fetch(url);
if (!response.ok || (await response.json()).status !== "ok") throw new Error(`Unhealthy: ${url}`);
```

## GET /healthz [go-usage]

- **Auth:** Public.
- **Request:** No body.
- **Response:** `200 {status:"ok"}`.
- **Errors:** No application errors; transport failure means the service is unavailable.

```javascript runnable
const url = `${process.env.GO_USAGE_URL ?? "http://127.0.0.1:8082"}/healthz`;
const response = await fetch(url);
if (!response.ok || (await response.json()).status !== "ok") throw new Error(`Unhealthy: ${url}`);
```

## GET /admin/security-events [ts-console]

- **Auth:** Admin secret.
- **Request:** No body.
- **Response:** `200 {data}` recent blocked security events.
- **Errors:** `401` wrong/missing admin secret; `500` query failure.

```bash
curl "$TS_CONSOLE_URL/admin/security-events" -H "authorization: Bearer $ADMIN_SECRET"
```

## POST /admin/session-sweep [ts-console]

- **Auth:** Admin secret.
- **Request:** Empty body.
- **Response:** `200 {deleted}` expired sessions removed.
- **Errors:** `401` wrong/missing admin secret; `500` database failure.

```bash
curl -X POST "$TS_CONSOLE_URL/admin/session-sweep" -H "authorization: Bearer $ADMIN_SECRET"
```

## GET /audit-log [ts-console]

- **Auth:** Any console role.
- **Request:** Optional object/user/customer/action and date filters.
- **Response:** `200 {data}` up to 500 immutable audit events.
- **Errors:** `400` invalid filter; `401` invalid session.

```bash
curl "$TS_CONSOLE_URL/audit-log?action=ApiKey.created" -H "authorization: Bearer $SESSION_TOKEN"
```

## GET /audit-log/export.csv [ts-console]

- **Auth:** Any console role.
- **Request:** Same filters as `GET /audit-log`.
- **Response:** `200 text/csv` streamed audit rows.
- **Errors:** `400` invalid filter; `401` invalid session.

```bash
curl "$TS_CONSOLE_URL/audit-log/export.csv" -H "authorization: Bearer $SESSION_TOKEN" -o audit-log.csv
```

## PATCH /audit-log/:id [ts-console]

- **Auth:** Any console role.
- **Request:** Audit UUID and any body.
- **Response:** No successful mutation; the log is append-only.
- **Errors:** `405` always, with `the audit log is append-only and cannot be edited or deleted`; `401` invalid session.

```bash
curl -X PATCH "$TS_CONSOLE_URL/audit-log/$AUDIT_ID" -H "authorization: Bearer $SESSION_TOKEN" -H 'content-type: application/json' -d '{}'
```

## DELETE /audit-log/:id [ts-console]

- **Auth:** Any console role.
- **Request:** Audit UUID.
- **Response:** No successful mutation; the log is append-only.
- **Errors:** `405` always, with `the audit log is append-only and cannot be edited or deleted`; `401` invalid session.

```bash
curl -X DELETE "$TS_CONSOLE_URL/audit-log/$AUDIT_ID" -H "authorization: Bearer $SESSION_TOKEN"
```

## POST /exports [ts-console]

- **Auth:** Owner session.
- **Request:** JSON `formats` subset of csv/json/parquet and a bounded date range.
- **Response:** `202` queued export job.
- **Errors:** `400` invalid formats/range; `403` wrong role.

```bash
curl -X POST "$TS_CONSOLE_URL/exports" -H "authorization: Bearer $SESSION_TOKEN" -H 'content-type: application/json' -d '{"formats":["csv"],"start_at":"2030-01-01T00:00:00Z","end_at":"2030-02-01T00:00:00Z"}'
```

## GET /exports/:id [ts-console]

- **Auth:** Owner session.
- **Request:** Export UUID.
- **Response:** `200` job state, requested formats, and timestamps.
- **Errors:** `400` invalid UUID; `403` wrong role/hidden export.

```bash
curl "$TS_CONSOLE_URL/exports/$EXPORT_ID" -H "authorization: Bearer $SESSION_TOKEN"
```

## GET /exports/:id/download [ts-console]

- **Auth:** Owner session.
- **Request:** Export UUID and `format` (`csv`, `json`, `parquet`).
- **Response:** `200` export file stream.
- **Errors:** `400` invalid UUID/format/not requested; `403` hidden export; `409` not completed/unavailable.

```bash
curl "$TS_CONSOLE_URL/exports/$EXPORT_ID/download?format=csv" -H "authorization: Bearer $SESSION_TOKEN" -o export.csv
```

## POST /export-schedules [ts-console]

- **Auth:** Owner session.
- **Request:** JSON `name`, `cron_expression`, `timezone`, `formats`, `destination_type`, and S3 destination fields when applicable.
- **Response:** `201` schedule.
- **Errors:** `400` missing/invalid schedule, format, or destination; `403` wrong role.

```bash
curl -X POST "$TS_CONSOLE_URL/export-schedules" -H "authorization: Bearer $SESSION_TOKEN" -H 'content-type: application/json' -d '{"name":"daily","cron_expression":"0 2 * * *","timezone":"UTC","formats":["csv"],"destination_type":"local"}'
```

## GET /export-schedules [ts-console]

- **Auth:** Owner session.
- **Request:** No body.
- **Response:** `200 {data}` tenant schedules.
- **Errors:** `401` invalid session; `403` wrong role.

```bash
curl "$TS_CONSOLE_URL/export-schedules" -H "authorization: Bearer $SESSION_TOKEN"
```

## GET /support/export-format-doc [ts-console]

- **Auth:** Valid API key.
- **Request:** No body.
- **Response:** `200 text/markdown` canonical export-format document.
- **Errors:** `401` invalid API key.

```bash
curl "$TS_CONSOLE_URL/support/export-format-doc" -H "authorization: Bearer $API_KEY"
```

## GET /support/isolation-design-doc [ts-console]

- **Auth:** Valid API key.
- **Request:** No body.
- **Response:** `200 text/markdown` tenant-isolation design document.
- **Errors:** `401` invalid API key.

```bash
curl "$TS_CONSOLE_URL/support/isolation-design-doc" -H "authorization: Bearer $API_KEY"
```
