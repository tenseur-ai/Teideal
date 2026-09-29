# TEID-45 implementation notes

## Invoice lines do not exist; `ledger_transactions` is the stand-in

No `invoices` table or invoice-generation path exists in this checkout. AC1's
"invoices" and AC3/T3/T8's "invoice line" are implemented as
`ledger_transactions` / `ledger_lines`, exactly as the spec's scoping notes
require. Timeline entries of type `charge` are labeled with category
`Charges`. Drill-down is `GET /ledger/transactions/{id}/detail` (go-usage)
proxied for the console as `GET /customers/{id}/timeline/charges/{transactionId}`.

## `model` has no backing column

`usage_events` and `ledger_transactions` have no `model` (or team/api-key)
column. `priced_usage_lines.model` exists but is owned by ts-console and is
not a timeline source. Per the spec, a filter whose attribute is absent on a
source table does not narrow that entry type. The timeline endpoint accepts
`model=` so AC2's query shape is stable; T2 uses date, metric (`event_type`
prefix), team (child customer name via TEID-22 hierarchy), and `api_key_id`
(audit_log.actor_api_key_id) as the filters that actually discriminate, and
asserts a seeded non-matching usage event is absent.

`team` is a customer in the TEID-22 hierarchy (a child of the path customer,
matched by UUID or name). `api_keys.customer_id` is the customer-scoped key
attribute T8 uses; it is not present on `usage_events`.

## T8 cannot rely on RLS

RLS is tenant-scoped. A key whose `api_keys.customer_id` points at customer B
still sees customer A's rows under the same tenant. `GET /ledger/transactions/{id}/detail`
re-checks `customers` visibility and, when the caller is customer-scoped,
requires `txn.customer_id == principal.CustomerID` before returning lines or
the originating usage event — the same explicit
`customer_id not visible to caller's tenant` pattern as `usage.go`'s batch
path.

## Hourly bucketing is a Postgres `GROUP BY`, not an application fold

`GET /usage?group_by=hour` runs

```sql
GROUP BY date_trunc('hour', occurred_at), event_type
```

in go-usage. ts-console merges those pre-aggregated rows into `usage_bucket`
timeline entries. The init migration's `(tenant_id, customer_id)` index does
not include `occurred_at`; `20260929140000_usage_events_customer_occurred_idx.sql`
adds `(tenant_id, customer_id, occurred_at)` so T4/T5's million-row aggregates
can use an index. No new tables.

## Session tokens on go-usage

ts-console fans out with the caller's `Authorization` header. Console users
hold session tokens, not recoverable API-key plaintext (keys are stored
hashed). go-usage `auth.Resolve` therefore accepts a `sessions.token_hash`
hit as a tenant-scoped `read-only` principal after the API-key lookup misses.
`GET /adjustments` is read-only so a session can list a customer's queue;
approve/reject remain admin.

## T6 UI assertion

No console UI test harness exists. T6 asserts the API contract: a large
`usage_bucket` does not inline every event, and
`GET /customers/{id}/timeline/usage-bucket` returns only that hour's events.
Collapsed-by-default click/no-reload is deferred to a future console E2E suite.

## Cursor scheme

Existing list endpoints (api-keys, plans) keyset-paginate by `id`. Timeline
sources are ordered by timestamp descending, so go-usage list cursors are
opaque base64url `{t, id}` pairs (still keyset, not offset). The aggregation
endpoint's `next_cursor` is the same idea over `(occurred_at, type:id)`.
