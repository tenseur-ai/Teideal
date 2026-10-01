# TEID-39: Send period usage and overage to Stripe invoices

| | |
|---|---|
| Epic | TEID-4 (E04 -- Develop Stripe connector (read-first) and invoice sync) |
| Phase | E04 -- Develop Stripe connector (read-first) and invoice sync |
| Priority | Medium |
| Points | 8 |
| Release | phase-2 |
| Order | 79 (within this phase) |
| Depends on | TEID-37 (Stripe Connect OAuth, `stripeConnect.ts`), TEID-50 (period close summary, `periodCloseSummary.ts`), TEID-48 (webhook/alert worker pattern), TEID-98's `httpClient.ts` (retry/backoff pattern to reuse) |

## Story (verbatim from the live board)

> As a finance lead, I want usage and overage charges added to the customer's Stripe invoice at period close, so that customers receive one accurate invoice.
>
> *Context*

## Acceptance criteria (verbatim from the live board)

1. At period close, usage and overage totals are written to the customer's Stripe invoice as line items.
2. Each line item includes a reference that links back to the ledger entries behind it.
3. If the write to Stripe is retried, no duplicate line items are created.
4. If Stripe is unavailable, the write is retried automatically and the operator is alerted if it has not succeeded within 1 hour.

## Cataloged tests (verbatim from the live board)

| ID | Type | AC | Title |
|---|---|---|---|
| TEID-39-T1 | Functional | 1 | Close a billing period for a customer with $340.00 of usage and $85.00 of overage, and confirm the Stripe invoice for that customer receives two corresponding line items totaling $425.00. |
| TEID-39-T2 | Functional | 2 | Inspect a Stripe invoice line item created by the sync and confirm its metadata includes a reference, such as a ledger entry or batch ID, that maps back to the specific ledger entries composing that charge. |
| TEID-39-T3 | Functional | 3 | Trigger the period-close invoice sync, then manually re-trigger the same sync job for the same period a second time, and confirm no duplicate line items are added to the Stripe invoice. |
| TEID-39-T4 | Functional | 4 | Simulate Stripe returning 503 errors for 45 minutes during a sync attempt, confirm the system automatically retries with backoff, and confirm an operator alert fires once the elapsed time without success passes the 1-hour threshold. |
| TEID-39-T5 | Non-functional | 4 | Measure the retry backoff schedule against a simulated Stripe outage and confirm the system makes at least 5 retry attempts within the first hour before escalating, while staying within Stripe's documented API rate limits. |
| TEID-39-T6 | Adversarial | 3 | Send two concurrent sync requests for the same period-close event, simulating a duplicate cron fire, and confirm only one set of line items reaches the Stripe invoice. |
| TEID-39-T7 | Adversarial | 1 | Simulate a period close where the ledger total changes due to a late adjustment between the sync's calculation step and its Stripe write step, and confirm the system detects the staleness and either aborts or re-reads the latest total rather than posting a now-incorrect amount. |

## Scoping notes for this point in the build sequence

- **This is the first story that needs a `read_write`-scoped Stripe
  connection.** TEID-37's OAuth flow and `stripe_connections.scope CHECK
  (IN ('read_only','read_write'))` already support this; TEID-65 only ever
  exercised the `read_only` path (and explicitly rejects `read_write`
  connections at registration). `stripeConnect.ts` already has a
  `assertWriteScope(connection)` guard with a comment naming this story
  (`// Future Stripe call sites (TEID-39/40) must go through this before
  using a token.`) -- call it before every write in this story. Reuse
  `requireConnectedAccessToken`/`decryptToken` exactly as TEID-65 does for
  reads; do not add a second encryption/token path.
- **"Usage" and "overage" totals already exist, computed by TEID-50's
  `periodCloseSummary.ts`.** Its `consumption` query aggregates
  `usage_consumption_lines.amount` by `source_category` (one of
  `CREDIT_SOURCES = ["paid","promotional","commit","goodwill","overage"]`).
  For this story: **usage** = the sum of every category except
  `"overage"`; **overage** = the `"overage"` category's own total. Call
  `periodCloseSummary.ts`'s existing exported summary function (extend its
  return shape with the underlying `usage_consumption_lines` row IDs
  per category if the current return doesn't already carry them --- T2
  needs a reference back to the specific lines composing each total, not
  just the aggregate) rather than re-querying `usage_consumptions`/
  `usage_consumption_lines` a second time. Do not touch `go-usage`'s
  separate `usage_events`/`ledger_transactions` tables -- this story reads
  ts-console's own consumption ledger exclusively, exactly as TEID-50
  does, per the per-table-ownership ADR.
- **No "period-close invoice sync" tracking table exists yet.** Introduce
  one, modeled directly on TEID-98's `connector_syncs` attempt-tracking
  pattern (`startSync`/`completeSync` in `syncHealth.ts`) rather than
  inventing a new idempotency mechanism: one row per (tenant, customer,
  period) sync *attempt*, plus a separate durable record of which Stripe
  invoice line item IDs were actually created for that (tenant, customer,
  period) once an attempt succeeds. T3's "re-trigger a second time" and
  T6's "two concurrent requests" both resolve the same way a connector
  sync does: a `UNIQUE (tenant_id, customer_id, period_start, period_end)`
  constraint on the *succeeded-line-items* record (not the attempts table)
  makes a second successful write impossible to duplicate, and a
  `SELECT ... FOR UPDATE` (or a `status = 'running'` guard identical to
  `startSync`'s) on the attempts table makes two concurrent attempts for
  the same period collapse into one actually reaching Stripe.
- **Retry-with-backoff (T4/T5) should reuse `httpClient.ts`'s existing
  token-bucket + exponential-backoff `ConnectorHttpClient`** (TEID-98)
  rather than writing a second backoff implementation. Stripe's own
  documented rate limit (100 req/s in live mode, lower in test mode) is
  already what `requestsPerMinute` in that client is for. "Alert the
  operator once 1 hour has elapsed without success" reuses the existing
  balance-alert/webhook worker pattern (TEID-47/48): a background tick
  (same `NODE_ENV`/`DISABLE_BACKGROUND_WORKERS`-gated convention as every
  other worker in `server.ts`) that finds sync attempts stuck in
  `running`/`failed` for over an hour and fires one alert per attempt
  (not one per retry) through the existing webhook-delivery path, with a
  new webhook event type (`period_close_sync.stalled` or similar -- follow
  `WebhookEventType`'s existing naming convention in `webhooks.ts`).
- **T7 (staleness between calculation and write)** needs the sync to
  re-verify the total immediately before the Stripe write, not just once
  at the start of a long-running attempt. Recompute (or re-sum) the
  period's consumption total right before constructing the Stripe
  `invoiceitem` payload; if it differs from what was computed when the
  attempt started, abort the attempt as `failed` with a clear reason
  (`"ledger total changed during sync"`) rather than posting a now-stale
  amount -- the next scheduled/manual retry will pick up the corrected
  total naturally, it does not need special-case recovery logic.

## Architecture and design

**Data model** (new migration, `db/migrations/<timestamp>_period_close_invoice_sync.sql`,
owned by ts-console since it only touches ts-console-owned tables):

```sql
CREATE TABLE period_close_invoice_sync_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id),
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  error_message TEXT
);
-- RLS: tenant_isolation_period_close_invoice_sync_attempts, same shape as
-- every other tenant-scoped table.

CREATE TABLE period_close_invoice_line_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id),
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('usage','overage')),
  stripe_invoice_item_id TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  ledger_reference TEXT NOT NULL, -- the batch/reference this line's metadata points back to
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, customer_id, period_start, period_end, category)
);
-- RLS: same tenant_isolation_* pattern.
```

The `UNIQUE (tenant_id, customer_id, period_start, period_end, category)`
constraint on `period_close_invoice_line_items` is the actual T3/T6
enforcement point: a second attempt that reaches the insert for a period
already synced gets a constraint violation, which the sync code treats as
"already done" (not an error) rather than retrying the Stripe write.

**Service ownership.** Everything in this story lives in
`services/ts-console` -- it reads ts-console's own consumption ledger
and writes through ts-console's own Stripe OAuth connection. No
`go-usage` changes.

**API contract:**
- `POST /period-close/:customerId/stripe-sync` -- manual trigger (role
  gate: same `["Owner","Billing Admin"]`-style roles as the rest of
  period-close). Body: `{ period_start, period_end }`. Returns `202` with
  `{ attempt_id, status }` if a sync starts, or `200` with the existing
  `period_close_invoice_line_items` rows if that period was already
  synced (idempotent re-trigger -- this is what T3 exercises).
- The background worker (hourly tick, matching `connectorIncrementalIntervalMs`'s
  convention) calls the same underlying function for every customer whose
  period just closed and has no successful sync yet.
- Extend `GET /connectors/sync-health`-style visibility -- or, simpler
  and more consistent with how period-close already surfaces its own
  state, add `last_stripe_sync_status`/`last_stripe_sync_error` fields to
  the existing period-close summary response so an operator sees sync
  health in the same place they see the summary itself.

**Stripe write.** Use Stripe's `invoiceitem` API (two items per
synced period: one `category='usage'`, one `category='overage'`, skip
creating an item for a category whose total is exactly zero). Each
item's `description`/`metadata.ledger_reference` carries a string an
operator or support engineer can trace back to the specific
`usage_consumption_lines` rows that composed it (T2) -- a stable,
human-readable reference such as `"period-close:<tenant_id>:<customer_id>:<period_start>:<category>"`
is sufficient; it does not need to be a literal database ID, just
reconstructable back to the exact query that produced the total.

## Implementation guidance per test

### TEID-39-T1
Seed `usage_consumption_lines` (or go through the real consumption path
used elsewhere in this test suite) so one customer's period has exactly
$340.00 across non-overage categories and $85.00 in `overage`. Trigger
the sync. Against the fake Stripe server (`tests/stripe-connect/fake-stripe.ts`,
extend with an `invoiceitems` create endpoint if it doesn't already have
one, following the same `/_seed`/`/_requests` convention as its other
endpoints), assert exactly two invoice items were created for that
customer, amounts $340.00 and $85.00, summing to $425.00.

### TEID-39-T2
From the same fixture, fetch the logged create-invoiceitem request body
and assert its metadata/description contains a reference string, then
independently reconstruct the expected reference from the same
tenant/customer/period/category and assert it matches exactly (not just
"contains some text").

### TEID-39-T3
Trigger `POST /period-close/:customerId/stripe-sync` for a period, let it
succeed, then call the exact same endpoint with the same body again.
Assert the second call returns the prior `period_close_invoice_line_items`
rows (not new ones) and that the fake Stripe server's request log shows
no second `invoiceitems` create call for that period/category.

### TEID-39-T4
Configure the fake Stripe server (reuse the existing failure-injection
convention from `fake-connector-target.ts`'s `/_configure` endpoint, or
add an equivalent to `fake-stripe.ts`) to return `503` for a bounded
window. Drive the sync's retry loop forward with injected time (same
pattern as TEID-47's run-out-projection tests advance a fake clock) past
the 1-hour mark and assert exactly one alert fires, with a message
naming the customer/period, not a raw Stripe error.

### TEID-39-T5
Using the same injected-failure fixture, assert the retry attempts'
timestamps are spaced by the `ConnectorHttpClient`'s computed
`min(baseDelayMs * 2^n, maxDelayMs)` schedule and that there are at
least 5 attempts logged before the 1-hour alert fires, with no attempt
exceeding the configured `requestsPerMinute` budget.

### TEID-39-T6
Issue two concurrent `POST /period-close/:customerId/stripe-sync` calls
(`Promise.all`) for the same period. Assert the fake Stripe server's
request log shows exactly one `invoiceitems` create per category (not
two), and that one of the two HTTP responses reflects "already synced"
while the other reflects the real create.

### TEID-39-T7
Start a sync attempt, then -- before it reaches the Stripe write step --
mutate the underlying `usage_consumption_lines` total for that period
(simulating a late adjustment landing mid-attempt). Assert the attempt
completes as `failed` with an error naming the staleness, that no
Stripe invoice item was created with the stale amount, and that a
fresh sync attempt afterward picks up the corrected total and succeeds.

## File layout

- `db/migrations/<timestamp>_period_close_invoice_sync.sql` -- new tables
  above.
- `services/ts-console/src/lib/periodCloseInvoiceSync.ts` (new) -- the
  sync function, attempt tracking, staleness recheck, Stripe write.
- `services/ts-console/src/routes/periodClose.ts` (extend) -- the new
  `POST /period-close/:customerId/stripe-sync` route.
- `services/ts-console/src/server.ts` (extend) -- the hourly background
  tick, gated exactly like every existing worker.
- `tests/stripe-connect/fake-stripe.ts` (extend) -- `invoiceitems`
  create endpoint, failure injection if not already general-purpose.
- `tests/period-close/period-close-stripe-sync.test.ts` (new) -- TEID-39-T1
  through T7.
- `docs/api/period-close.md` (or wherever TEID-50's route is already
  documented) -- extend with the new route, so `tests/docs/coverage.test.ts`
  stays green.

## Definition of done

- [ ] Every acceptance criterion above is satisfied by working code.
- [ ] Every cataloged test has a real automated test that passes --
      functional, non-functional, and adversarial alike.
- [ ] `tsc --noEmit` is clean.
- [ ] The suite passes against a database rebuilt from scratch using only
      committed migration/seed scripts (not just the developer's already-
      warm local state).
- [ ] PR description includes a checklist mapping each test ID to the
      file/line that covers it.
