# Billing connectors

Connector health gives operators one tenant-scoped view of every billing-data
connection, including connections that have not completed their first sync.

## GET /connectors/sync-health [ts-console]

- **Auth:** Owner, Billing Admin, or Developer session.
- **Request:** No parameters; results are scoped to the caller's tenant.
- **Response:** `200 {data:[{connector_id,connector_type,display_name,status,last_sync_at,last_sync_status,consecutive_failures,cursor_high_water}]}`. Connector `status` is `connected` or `disconnected`. `last_sync_at` and `last_sync_status` are `null` before the first sync; non-null sync statuses are `running`, `succeeded`, or `failed`. `cursor_high_water` is an object keyed by entity name whose values are `{since:string|null,cursor:string|null}`; it advances only after a successful sync and is `{}` until a watermark has been stored.
- **Errors:** `401` invalid session; `403` disallowed role.

```bash
curl "$TS_CONSOLE_URL/connectors/sync-health" -H "authorization: Bearer $SESSION_TOKEN"
```
