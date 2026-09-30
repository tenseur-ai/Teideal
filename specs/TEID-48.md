# TEID-48: Webhooks for billing events

| | |
|---|---|
| Epic | TEID-6 (E06 -- Enable operator visibility, alerts, and customer-facing usage) |
| Phase | E06 -- Enable operator visibility, alerts, and customer-facing usage |
| Priority | High |
| Points | 5 |
| Release | mvp |
| Order | 67 (within this phase) |
| Depends on | `billing_alert_thresholds`/`billing_alert_sent`/`balanceAlertWorker.ts` (TEID-47), `grants`/`grantWorker.ts` (TEID-17/18/19), `reservations` (TEID-32, read-only awareness of its identity-only design), `balance_integrity_checks`/`postAlert` (TEID-32/33, go-usage), `roleGuard.ts`/`consoleRoute` (TEID-43), `ADMIN_SECRET`/`x-internal-admin-key` internal-auth pattern (`routes/security.ts`) -- all already built |

## Story (verbatim from the live board)

> As a developer at our customer, I want webhooks for important billing events, so that I can trigger my own emails, in-app messages and upsell flows.
>
> *Context*
> Events: threshold reached, balance depleted, grant expiring soon, grant expired, reservation overrun, reconciliation mismatch, customer suspended.

## Acceptance criteria (verbatim from the live board)

1. Each webhook is signed so the receiver can verify it came from us.
2. Failed deliveries are retried with increasing delays for at least 24 hours.
3. A delivery log shows every attempt and its response, and any webhook can be resent manually.
4. Each webhook has a unique ID so receivers can ignore duplicates.

## Cataloged tests (verbatim from the live board)

| ID | Type | AC | Title |
|---|---|---|---|
| TEID-48-T1 | Functional | 1 | Trigger a balance-depleted webhook event and confirm the payload includes an HMAC signature header that validates successfully against the configured signing secret. |
| TEID-48-T2 | Functional | 2 | Configure a receiving endpoint to return HTTP 500 for the first 6 delivery attempts of a threshold-reached webhook and confirm delivery is retried with increasing backoff delays and continues for at least 24 hours before giving up. |
| TEID-48-T3 | Functional | 3 | Trigger a grant-expiring-soon webhook, confirm the delivery log shows the attempt timestamp, response code and body, then manually resend it from the log and confirm a new delivery attempt is recorded. |
| TEID-48-T4 | Functional | 4 | Trigger a reservation-overrun webhook that is delivered twice due to a retry and confirm both delivery attempts carry the identical unique event ID so the receiver can deduplicate. |
| TEID-48-T5 | Non-functional | 2 | Simulate the receiving endpoint being completely unreachable for the full 24-hour retry window and confirm the system exhausts retries and marks the webhook permanently failed rather than retrying indefinitely. |
| TEID-48-T6 | Non-functional | 3 | Generate 1,000 webhook deliveries across various event types and confirm the delivery log UI remains responsive and searchable by event type and status. |
| TEID-48-T7 | Adversarial | 1 | Send a forged payload without a valid signature to a receiving endpoint and confirm a correctly implemented receiver would reject it, proving the signing scheme cannot be replicated without the shared secret. |
| TEID-48-T8 | Adversarial | 4 | Manually resend a webhook from the delivery log 5 times in quick succession and confirm the receiver-facing event ID stays identical across all 5 resends so an idempotent receiver processes it only once. |

## Scoping notes for this point in the build sequence

**Four of the seven named events have a real trigger mechanism already; two have none; one is deliberately deferred.** The `*Context*` line names seven event types, but only four are named by a cataloged test (`balance.depleted` T1, `threshold.reached` T2, `grant.expiring_soon` T3, `reservation.overrun` T4) -- the other three (`grant.expired`, `reconciliation.mismatch`, `customer.suspended`) appear only in the descriptive context, matching TEID-45's own established precedent that the `*Context*`/`desc` text is flavor, not a literal per-item acceptance requirement. This story wires real detection for every event type that already has one, and documents an honest substitution or deferral for every one that doesn't -- it does not fabricate detection logic just to exercise the delivery mechanism.

**`threshold.reached` and `balance.depleted` already have a real detection mechanism: TEID-47's `balanceAlertWorker.ts`.** `evaluateTenant`'s `claimSlots` already atomically decides, once per `(grant_id, threshold_pct, period_start)`, which evaluation tick (if any) owns a genuinely new threshold crossing -- this is exactly the race TEID-47's own post-merge fix closed (claim-before-deliver, not deliver-before-claim). This story adds webhook delivery as a **fourth channel**, alongside the existing operator-email/Slack/customer-email channels, triggered from the same `won` set `evaluateTenant` already computes -- it does not re-detect threshold crossings independently, and it does not wait for `hasChannels`/`toDeliver` gating, since a tenant may configure webhooks without configuring any operator channel. `balance.depleted` is the same underlying crossing at `threshold_pct === 100`, emitted as a second, distinctly-typed event alongside `threshold.reached` (both dedup-safe independently -- see Architecture).

**`grant.expiring_soon` is only half-built.** `grantWorker.ts`'s `expireForTenant` detects a grant that has *already* expired; nothing detects one *approaching* expiry. This story adds a new advance-check function (`checkExpiringSoonGrants`) alongside the existing ones, run on the same timer. It fires once per grant's lifetime (dedup key is the grant ID alone, not a per-tick key), so an expiry-date amendment after the event has already fired does not re-fire it -- not tested, and an acceptable limitation for a first version of this check.

**`grant.expired` has a real, already-existing trigger point.** `expireForTenant` already transitions a grant's `status` to `'expired'` exactly once (guarded by `WHERE status = 'active'` plus `FOR UPDATE SKIP LOCKED`), immediately after the existing `grant_ledger_entries` insert. This story adds one webhook emission call there. Not directly named by a cataloged test, but free to wire correctly since the trigger point already exists and is already safe under concurrency.

**`reconciliation.mismatch` has a real, already-existing trigger point, in the other service.** `services/go-usage/internal/ledger/balance.go`'s reconciliation loop already finds each mismatch, commits it to `balance_integrity_checks`, then calls `postAlert` (an on-call ops webhook, not a tenant-facing one). This story adds a second, tenant-facing emission alongside the existing `postAlert` call. Because webhook configuration (`webhook_endpoints`, with secrets) is tenant-facing config that -- like every other tenant-config table in this codebase -- lives in `services/ts-console`, and go-usage does not own it, this requires a new cross-service call: go-usage POSTs to a new internal ts-console endpoint, authenticated the same way `routes/security.ts`'s existing `/admin/security-events` is (a static `x-internal-admin-key` header checked against `ADMIN_SECRET`) -- this is the first time go-usage calls *into* ts-console (the existing direction, from TEID-45, is ts-console calling into go-usage), but the auth pattern it reuses is already established, just not yet used in this direction. Not directly named by a cataloged test; wired for real since the trigger point already exists and the auth pattern is a direct, non-speculative reuse, not new infrastructure invented for this alone.

**`reservation.overrun` has no real mechanism at all -- this is a genuine scoping-note substitution, the same pattern TEID-45 used for "invoices."** `reservations` (TEID-32) is, by its own migration comment, "the identity-only reservation placeholder required for ledger traceability. It intentionally performs no hold, expiry, balance, or entitlement behavior." There is no overrun concept anywhere in its schema or code to hook into, and building one is far outside this story's 5 points and its own acceptance criteria (which are entirely about the generic delivery mechanism, not about reservation semantics). **The substitution:** `emitWebhookEvent` (the core function every real trigger above also calls) is exported and directly callable with a synthetic `reservation.overrun` payload. T4 calls it directly with a test-constructed payload and dedup key, exercising the exact same signing/delivery/retry/dedup-ID machinery every real event uses -- this is a fair test of the mechanism T4 actually names (identical event ID across a retried delivery), not a test of overrun *detection*, which does not exist and is not claimed to. When a future story adds real reservation limits, it calls this same `emitWebhookEvent` function from its own real detection code; the webhook contract does not change.

**`customer.suspended` has no real mechanism at all, and this story deliberately does not add one.** Grepped `services/ts-console/src` for `suspend`/`customer_status`/a `customers.status`-shaped column: zero hits anywhere in the schema or code (the `customers` table, `db/migrations/20260926120000_init.sql`, has only `id`/`tenant_id`/`name`/`email`/timestamps). Unlike `reservation.overrun`, this event type is not named by any cataloged test, so unlike the substitution above, there is nothing to fairly stand in for. The event type string (`customer.suspended`) is included in `webhook_events.event_type`'s `CHECK` constraint for forward compatibility, but **no code path ever emits it in this story.** The alternative -- adding a `customers.status` column now with nothing that ever sets it except a manual DB write -- would be a half-built feature (a column nobody can reach through any real path), which this codebase's own stated principle is to avoid; a future story that adds real customer suspension calls `emitWebhookEvent` from its own real trigger, exactly like every other event type above.

## Architecture and design

**New migration** `db/migrations/20260930090000_webhooks.sql`:

```sql
CREATE TABLE webhook_endpoints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  secret TEXT NOT NULL, -- generated server-side at creation; shown on every GET
                         -- (a verification secret a developer must keep
                         -- re-reading to configure their own receiver, unlike
                         -- a bearer API key -- deliberately not a create-once
                         -- reveal, matching Stripe's own webhook-secret UX,
                         -- not TEID-92's API-key-secret UX).
  subscribed_events TEXT[] NOT NULL DEFAULT '{}', -- empty = every event type
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE webhook_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_endpoints FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_webhook_endpoints ON webhook_endpoints
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON webhook_endpoints TO teideal_app;

-- The canonical event: one row per logical occurrence, its id IS the
-- receiver-facing dedup ID (AC4/T4/T8). dedup_key is this story's own
-- claim-before-emit mechanism (mirrors TEID-47's post-fix claimSlots
-- pattern): the UNIQUE constraint, not application logic, is what makes
-- two concurrent callers for the same real occurrence produce exactly one
-- event row. raw_body is the exact byte string that was signed and is
-- resent verbatim on every retry/resend -- never re-serialized from
-- payload, so the signature never drifts across attempts.
CREATE TABLE webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'threshold.reached', 'balance.depleted', 'grant.expiring_soon',
    'grant.expired', 'reservation.overrun', 'reconciliation.mismatch',
    'customer.suspended'
  )),
  dedup_key TEXT NOT NULL,
  payload JSONB NOT NULL,
  raw_body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, dedup_key)
);
ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_webhook_events ON webhook_events
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT ON webhook_events TO teideal_app;
CREATE INDEX webhook_events_tenant_type_idx ON webhook_events (tenant_id, event_type, created_at DESC);

-- One row per (event, endpoint) pair -- the mutable scheduling/summary
-- state the delivery-log list view and the retry worker both read.
CREATE TABLE webhook_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  webhook_event_id UUID NOT NULL REFERENCES webhook_events(id) ON DELETE CASCADE,
  webhook_endpoint_id UUID NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'exhausted')),
  attempt_count INT NOT NULL DEFAULT 0,
  first_attempted_at TIMESTAMPTZ,
  next_retry_at TIMESTAMPTZ, -- NULL: due now (first attempt, or a resend)
  last_http_status INT,
  last_response_body TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (webhook_event_id, webhook_endpoint_id)
);
ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_webhook_deliveries ON webhook_deliveries
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON webhook_deliveries TO teideal_app;
CREATE INDEX webhook_deliveries_pending_idx ON webhook_deliveries (tenant_id, status, next_retry_at) WHERE status = 'pending';
CREATE INDEX webhook_deliveries_tenant_status_idx ON webhook_deliveries (tenant_id, status);

-- The immutable per-attempt log AC3 requires ("shows every attempt and its
-- response"). Never updated, only inserted.
CREATE TABLE webhook_delivery_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  webhook_delivery_id UUID NOT NULL REFERENCES webhook_deliveries(id) ON DELETE CASCADE,
  attempt_number INT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('sent', 'failed')),
  http_status INT,
  response_body TEXT,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE webhook_delivery_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_delivery_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_webhook_delivery_attempts ON webhook_delivery_attempts
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT ON webhook_delivery_attempts TO teideal_app;
CREATE INDEX webhook_delivery_attempts_delivery_idx ON webhook_delivery_attempts (webhook_delivery_id, attempt_number);
```

**Core module** `services/ts-console/src/lib/webhooks.ts`:

- `RETRY_DELAYS_MS = [5*60_000, 30*60_000, 2*3_600_000, 6*3_600_000, 12*3_600_000, 24*3_600_000]` -- offsets from `first_attempted_at`. One immediate attempt plus 6 retries = 7 total attempts, the last at +24h, satisfying AC2/T2's "at least 24 hours" and T5's "exhausts after 24 hours."
- `signBody(secret: string, rawBody: string): string` -- `"sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex")`.
- `verifyWebhookSignature(rawBody: string, signatureHeader: string, secret: string): boolean` -- recomputes `signBody` and compares with `crypto.timingSafeEqual` (constant-time, guards a length mismatch by hashing both sides to a fixed length first rather than throwing). Exported and documented in `docs/api/webhooks.md` as the receiver-side verification recipe -- this is literally "a correctly implemented receiver" for T7's own purposes.
- `emitWebhookEvent(pool: Pool, tenantId: string, eventType: WebhookEventType, dedupKey: string, payload: Record<string, unknown>): Promise<void>` -- within `withTenant`: `INSERT INTO webhook_events (...) VALUES (...) ON CONFLICT (tenant_id, dedup_key) DO NOTHING RETURNING id`. No row returned means this exact occurrence was already emitted (by this call or a concurrent one) -- return immediately, matching TEID-47's claim-before-act lesson exactly, applied here via a UNIQUE constraint instead of a separate `claimSlots` step since there is only one thing to claim (the event itself), not a delivery-status placeholder. On a real insert: load `webhook_endpoints WHERE tenant_id = $1 AND active AND (subscribed_events = '{}' OR $2 = ANY(subscribed_events))`, insert one `webhook_deliveries` row per endpoint (`ON CONFLICT (webhook_event_id, webhook_endpoint_id) DO NOTHING` as defense-in-depth), then call `attemptDelivery` once, synchronously, per newly-inserted delivery -- a working receiver gets the webhook immediately, not after waiting for the next worker tick; only *retries* wait for the worker.
- `attemptDelivery(pool: Pool, delivery: { id, webhookEventId, webhookEndpointId, ... }): Promise<void>` -- loads the event's `raw_body`/`event_type`/`id` and the endpoint's `url`/`secret`, POSTs with headers `X-Teideal-Event-Id: <event id>`, `X-Teideal-Event-Type: <event_type>`, `X-Teideal-Signature: <signBody(...)>`, `Content-Type: application/json`, body = the stored `raw_body` verbatim, 10s timeout (matching `sendSlackAlert`'s own `SLACT_TIMEOUT_MS` convention). Inserts one `webhook_delivery_attempts` row recording the outcome, then updates the `webhook_deliveries` row: on 2xx, `status = 'sent'`; on any other outcome (non-2xx, timeout, network error), increment `attempt_count`, set `first_attempted_at` if null, and if `attempt_count <= RETRY_DELAYS_MS.length` schedule `next_retry_at = first_attempted_at + RETRY_DELAYS_MS[attempt_count - 1]`, else set `status = 'exhausted'`.

**Retry worker** `services/ts-console/src/lib/webhookDeliveryWorker.ts`: `webhookDeliveryIntervalMs()` reads `WEBHOOK_DELIVERY_INTERVAL_MS`, default `30_000`, following `balanceAlertIntervalMs`'s exact validation pattern. `evaluateWebhookRetries(pool: Pool, now = new Date())` selects `webhook_deliveries WHERE status = 'pending' AND attempt_count > 0 AND next_retry_at <= now` (the `attempt_count > 0` guard excludes rows still awaiting their sychronous first attempt) and calls `attemptDelivery` for each. Wired into `server.ts` exactly like `balanceAlertTimer` -- `DISABLE_BACKGROUND_WORKERS`-gated, `NODE_ENV !== "test"`-gated, tests call `evaluateWebhookRetries` directly with a fixed `now`.

**Manual resend**: `POST /webhook-deliveries/:id/resend` calls `attemptDelivery` directly against the existing delivery row, regardless of its current `status`/`next_retry_at` (so an already-`exhausted` delivery can still be manually recovered) -- since `attemptDelivery` always re-reads the same `webhook_event_id`'s `raw_body`, the resent request carries the identical `X-Teideal-Event-Id` (T8).

**Trigger wiring:**
- `balanceAlertWorker.ts`'s `evaluateTenant`, immediately after `won` is computed (before the `toDeliver`/`noChannel` split, so this runs independent of operator-channel configuration): for each `candidate` in `won`, `await emitWebhookEvent(pool, tenantId, 'threshold.reached', \`threshold:${candidate.grantId}:${candidate.thresholdPct}:${candidate.periodStart}\`, { customer_id, customer_name, grant_id, threshold_pct, remaining_amount, amount, period_start })`; additionally, when `candidate.thresholdPct === 100`, also `emitWebhookEvent(..., 'balance.depleted', \`depleted:${candidate.grantId}:${candidate.periodStart}\`, { customer_id, customer_name, grant_id, remaining_amount: 0, amount, period_start })`. Deliberately does not reuse `deliver()`'s own `projectRunOut` call (that stays specific to the operator-alert content) -- the webhook payload only needs fields `won` already carries, keeping event emission decoupled from the heavier per-candidate projection query.
- `grantWorker.ts`'s `expireForTenant`, immediately after `UPDATE grants SET status = 'expired'`: `await emitWebhookEvent(client_wrapped_pool, tenantId, 'grant.expired', \`expired:${row.id}\`, { customer_id: ..., grant_id: row.id, source: row.source, expired_amount: row.remaining_amount })` (note: `emitWebhookEvent` takes a `Pool`, not the open `PoolClient` this loop already holds -- call it after the transaction commits, the same "committed data before any alert attempt" ordering `balance.go`'s own reconciliation loop already uses, not inside the same transaction).
- New `checkExpiringSoonGrants(pool: Pool, now = new Date()): Promise<number>` in `grantWorker.ts`: per tenant, `SELECT id, customer_id, expiry_date, remaining_amount, amount FROM grants WHERE status = 'active' AND expiry_date IS NOT NULL AND expiry_date > $1 AND expiry_date <= $1 + ($2 || ' days')::interval`, `$2` from `GRANT_EXPIRING_SOON_DAYS` (default `7`); for each row, `emitWebhookEvent(pool, tenantId, 'grant.expiring_soon', \`expiring_soon:${row.id}\`, { customer_id, grant_id: row.id, expiry_date, remaining_amount, amount })`. Called from `server.ts`'s existing `grantTimer` tick, added to the same `Promise.all([processRecurringGrants(pool), processExpiredGrants(pool), checkExpiringSoonGrants(pool)])`.
- `services/go-usage/internal/ledger/balance.go`'s mismatch loop, alongside the existing `postAlert(ctx, payload)` call: a new `postWebhookEvent(ctx, tenantID, "reconciliation.mismatch", dedupKey, payload)` helper (new file `services/go-usage/internal/ledger/webhookEvents.go`, patterned directly on `postAlert`'s own shape) that POSTs `{tenant_id, event_type, dedup_key, payload}` to `os.Getenv("TS_CONSOLE_URL") + "/internal/webhook-events"` with header `X-Internal-Admin-Key: os.Getenv("ADMIN_SECRET")`. `dedupKey` is `fmt.Sprintf("mismatch:%s:%s:%s", customerID, accountCode, detectedAt.Format(time.RFC3339))`. Matches `postAlert`'s own soft-fail behavior exactly: if either env var is unset, or the call fails, log and `continue` -- this is auxiliary tenant notification, not core reconciliation correctness, and must never block or fail the reconciliation loop itself.
- New internal endpoint `POST /internal/webhook-events` in `services/ts-console/src/routes/webhooks.ts`, registered outside `consoleRoute`'s session/RBAC guard (matching `security.ts`'s own `/admin/*` routes exactly): checks `req.headers["x-internal-admin-key"] === adminSecret`, else `401`; body `{tenant_id, event_type, dedup_key, payload}`; calls `emitWebhookEvent` directly (this is the only call site with tenant_id supplied by the caller rather than derived from a session/API key, since it is an internal service-to-service call, not a tenant-authenticated one).
- `reservation.overrun`: no automatic trigger. `emitWebhookEvent` is exported from `webhooks.ts` and called directly by T4's own test code with a synthetic payload -- see Scoping notes above.
- `customer.suspended`: no trigger anywhere in this story -- see Scoping notes above.

**Tenant-facing API** (new `services/ts-console/src/routes/webhooks.ts`), role-gated `["Owner", "Billing Admin", "Developer"]` (matching TEID-43's role model; "Developer" specifically because this is squarely the role that "owns API keys and sandbox" per TEID-43's own AC1, and this story's own framing is "as a developer at our customer"):
- `POST /webhook-endpoints` `{url, subscribed_events?}` -> generates `secret` server-side (`randomBytes(32).toString("hex")`), inserts, returns the full row including `secret`.
- `GET /webhook-endpoints` -> list, `secret` included on every read (see the migration comment above for why this differs from TEID-92's API-key create-once-reveal convention).
- `PATCH /webhook-endpoints/:id` `{url?, subscribed_events?, active?}`.
- `DELETE /webhook-endpoints/:id`.
- `GET /webhook-deliveries?event_type=&status=&cursor=&limit=` -> `{data: [{id, event_id, event_type, endpoint_id, endpoint_url, status, attempt_count, last_http_status, last_response_body, first_attempted_at, next_retry_at, created_at}], next_cursor}`, cursor-paginated matching the existing `api-keys.ts` convention, `limit` capped server-side (e.g. 500) for T6.
- `GET /webhook-deliveries/:id` -> the same shape plus `attempts: [{attempt_number, outcome, http_status, response_body, attempted_at}]` ordered by `attempt_number`.
- `POST /webhook-deliveries/:id/resend` -> calls `attemptDelivery` as described above, returns the updated delivery + its new attempt.

## Implementation guidance per test

### TEID-48-T1
Create a `webhook_endpoints` row pointed at a fake receiver (new test double, see File layout) with a known `secret`. Drive a grant to exactly 100% used and run `evaluateBalanceAlerts` (TEID-47's real function, unmodified entry point) so `balance.depleted` fires through the real path. Assert the fake receiver recorded a request whose `X-Teideal-Signature` header, when checked with `verifyWebhookSignature(receivedRawBody, receivedSignatureHeader, secret)`, returns `true`.

### TEID-48-T2
Configure the fake receiver in a mode that returns `500` for its first 6 requests to a given delivery, then `200`. Trigger a `threshold.reached` event (drive a grant to a configured threshold, run `evaluateBalanceAlerts`). Call `evaluateWebhookRetries` repeatedly with `now` advanced by each successive `RETRY_DELAYS_MS` offset from the first attempt's timestamp. Assert exactly 7 attempts are recorded in `webhook_delivery_attempts` (1 initial + 6 retries), each attempt's `attempted_at` gap from the previous one matching the corresponding `RETRY_DELAYS_MS` entry (proving the delays are genuinely increasing, not fixed), and the final (7th) attempt is `"sent"` with `webhook_deliveries.status = 'sent'`.

### TEID-48-T3
Seed a grant with `expiry_date` inside the default 7-day window. Call `checkExpiringSoonGrants`. Call `GET /webhook-deliveries?event_type=grant.expiring_soon`, take the one delivery's `id`, call `GET /webhook-deliveries/:id`, assert `attempts` has one entry with a real `attempted_at`, `http_status`, and `response_body` matching what the fake receiver actually returned. Call `POST /webhook-deliveries/:id/resend`, assert the response's `attempts` array (or a follow-up `GET`) now has 2 entries.

### TEID-48-T4
Call `emitWebhookEvent` directly (imported in the test, matching the documented `reservation.overrun` substitution) with a synthetic `dedupKey`/payload representing a reservation exceeding some usage. Configure the fake receiver to fail its first attempt then succeed, forcing a retry via `evaluateWebhookRetries`. Assert both `webhook_delivery_attempts` rows for this delivery -- read from the fake receiver's own captured requests -- carry the identical `X-Teideal-Event-Id` header value, and that value equals the `webhook_events.id` the test's own `emitWebhookEvent` call returned/can independently query.

### TEID-48-T5
Configure the fake receiver to fail every request unconditionally (connection-refused or persistent 500 -- pick whichever the double supports for "unreachable"). Trigger any real event (e.g. `threshold.reached`). Call `evaluateWebhookRetries` with `now` advanced past each of the 6 retry offsets in turn, ending past `first_attempted_at + 24h`. Assert `webhook_deliveries.status = 'exhausted'` after the 7th failed attempt, `attempt_count = 7`, `next_retry_at` unchanged/irrelevant (no 8th attempt happens even if `evaluateWebhookRetries` is called again with `now` further advanced -- assert this directly by calling it once more and confirming no new `webhook_delivery_attempts` row appears).

### TEID-48-T6
Bulk-insert (set-based SQL, not one-by-one through `emitWebhookEvent`, matching TEID-32-T6/TEID-45-T4's own precedent for scale fixtures) 1,000 `webhook_events` plus one `webhook_deliveries` row each, spread across at least 3 different `event_type` values and a mix of `status` values. Call `GET /webhook-deliveries?event_type=threshold.reached&status=sent&limit=50` and a second call filtered differently; assert both return only matching rows, assert the call completes in a bounded time (e.g. under 2s, generous given no non-functional latency budget is cataloged for this one), and assert pagination (`next_cursor`) works across the full 1,000-row set without duplicates or gaps.

### TEID-48-T7
Compute a real `raw_body` and a deliberately wrong (or absent) signature value. Call `verifyWebhookSignature(rawBody, forgedSignature, secret)` directly -- this is "a correctly implemented receiver," per the test's own wording -- and assert it returns `false`. Additionally assert `verifyWebhookSignature(tamperedRawBody, correctlyComputedOriginalSignature, secret)` also returns `false` (a receiver that only checks the header format, not that it matches the actual received bytes, would be a broken implementation of this same contract).

### TEID-48-T8
Trigger any real event with an endpoint configured to succeed. Call `POST /webhook-deliveries/:id/resend` 5 times in quick succession (sequential awaited calls, not truly concurrent -- resend is explicitly a manual, deliberate action, not a race this story needs to prove is race-safe). Assert all 6 requests captured by the fake receiver (1 original + 5 resends) carry the identical `X-Teideal-Event-Id` header.

## File layout

- `db/migrations/20260930090000_webhooks.sql` -- new tables.
- `services/ts-console/src/lib/webhooks.ts` (new) -- `emitWebhookEvent`, `attemptDelivery`, `signBody`, `verifyWebhookSignature`.
- `services/ts-console/src/lib/webhookDeliveryWorker.ts` (new) -- `evaluateWebhookRetries`, `webhookDeliveryIntervalMs`.
- `services/ts-console/src/lib/balanceAlertWorker.ts` (extend) -- emit `threshold.reached`/`balance.depleted` from `evaluateTenant`.
- `services/ts-console/src/lib/grantWorker.ts` (extend) -- emit `grant.expired` from `expireForTenant`; add `checkExpiringSoonGrants`.
- `services/ts-console/src/routes/webhooks.ts` (new) -- tenant-facing CRUD/delivery-log/resend routes, plus the internal `/internal/webhook-events` endpoint.
- `services/ts-console/src/server.ts` -- register the new route, the new worker timer (env/`NODE_ENV`-gated like `balanceAlertTimer`), and add `checkExpiringSoonGrants` to the existing `grantTimer`'s `Promise.all`.
- `services/go-usage/internal/ledger/webhookEvents.go` (new) -- `postWebhookEvent`, patterned on `postAlert`.
- `services/go-usage/internal/ledger/balance.go` (extend) -- call `postWebhookEvent` alongside the existing `postAlert` in the mismatch loop.
- Tests: new directory `tests/webhooks/` implementing all 8 cataloged tests, plus `fake-webhook-receiver.ts` test double (patterned on `tests/balance-alerts/fake-slack.ts`: a real `http.createServer`, `/_requests` to inspect captured requests including headers, `/_mode` to configure failure count/persistent-failure behavior, `/_reset`).
- `docs/api/webhooks.md` (new) -- document every new route (`POST/GET/PATCH/DELETE /webhook-endpoints`, `GET /webhook-deliveries`, `GET /webhook-deliveries/:id`, `POST /webhook-deliveries/:id/resend`) following the established per-route format, plus a short "Verifying webhook signatures" section documenting the `X-Teideal-Signature`/`X-Teideal-Event-Id`/`X-Teideal-Event-Type` header contract and the `sha256=hmac(secret, rawBody)` scheme (the `/internal/webhook-events` endpoint is internal-only and is not documented here, matching how `/admin/*` internal routes are handled). Link it from `docs/api/README.md`'s resource-group index.

## Definition of done

- [ ] Every acceptance criterion above is satisfied by working code.
- [ ] Every cataloged test has a real automated test that passes -- functional, non-functional, and adversarial alike.
- [ ] `go vet`/`tsc --noEmit` (whichever applies) is clean in both `services/go-usage` and `services/ts-console`.
- [ ] `tests/cross-tenant`, `tests/console-auth`, `tests/audit-log`, `tests/api-keys`, `tests/rbac`, `tests/balance-alerts`, `tests/grants`, `tests/ledger`, `tests/balance-reconciliation` all still pass unchanged.
- [ ] `docs/api/webhooks.md` exists and `tests/docs/coverage.test.ts` passes (every new route documented).
- [ ] The suite passes against a database rebuilt from scratch using only committed migration/seed scripts.
- [ ] PR description includes a checklist mapping each test ID to the file/line that covers it.
