# Customer timeline

A single, read-only, chronologically merged view of everything that
affected a customer's balance: grants, hourly-bucketed usage, reservations,
adjustments, charges (see [Ledger, reservations, and balance
integrity](ledger.md)'s `GET /ledger/transactions/{id}/detail`, this
feature's "invoice line" stand-in), and configuration changes. `ts-console`
fans out to `go-usage`'s own read endpoints over HTTP, forwarding the
caller's own `Authorization` header, and merges the results.

## GET /customers/:id/timeline [ts-console]

- **Auth:** Any console role in the tenant, or an API key scoped to that customer.
- **Request:** Customer UUID; optional `since`, `until`, `metric`, `team` (a child customer in the TEID-22 hierarchy), `api_key_id`, `model` (accepted but does not narrow any entry -- no source table carries it, see `NOTES-TEID-45.md`), `cursor`, `limit`.
- **Response:** `200 {entries:[{type,occurred_at,id,...}],next_cursor}`. `type` is one of `grant`, `usage_bucket`, `reservation`, `adjustment`, `charge`, `config_change`.
- **Errors:** `400` invalid UUID/date range/cursor/`api_key_id`; `403` customer not visible to caller's tenant (or API-key customer scope mismatch); `502` an upstream `go-usage` call failed.

```bash
curl "$TS_CONSOLE_URL/customers/$CUSTOMER_ID/timeline?since=2026-09-01T00:00:00Z" -H "authorization: Bearer $SESSION_TOKEN"
```

## GET /customers/:id/timeline/usage-bucket [ts-console]

- **Auth:** Same as the timeline endpoint above.
- **Request:** Customer UUID; required `hour` (the bucket's start instant) and `event_type`; optional `cursor`/`limit`.
- **Response:** `200 {hour,event_type,events,next_cursor}` -- the individual usage events an hourly bucket summarizes, expanding a bucket the main timeline response left collapsed.
- **Errors:** `400` missing/invalid `hour`/`event_type`; `403` customer not visible; `502` upstream call failed.

```bash
curl "$TS_CONSOLE_URL/customers/$CUSTOMER_ID/timeline/usage-bucket?hour=2026-09-01T14:00:00Z&event_type=tokens.in" -H "authorization: Bearer $SESSION_TOKEN"
```

## GET /customers/:id/timeline/charges/:transactionId [ts-console]

- **Auth:** Same as the timeline endpoint above.
- **Request:** Customer UUID and ledger transaction UUID.
- **Response:** `200` the transaction's `ledger_lines` and originating `usage_event` -- the timeline's "invoice line" drill-down, proxying `go-usage`'s `GET /ledger/transactions/{id}/detail`.
- **Errors:** `400` invalid UUID; `403` customer or transaction not visible to caller's tenant; `404` transaction missing; `502` upstream call failed.

```bash
curl "$TS_CONSOLE_URL/customers/$CUSTOMER_ID/timeline/charges/$TRANSACTION_ID" -H "authorization: Bearer $SESSION_TOKEN"
```
