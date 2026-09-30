# TEID-98: Connector framework and contract test suite

| | |
|---|---|
| Epic | TEID-11 (E11 -- Implement Teideal Verify independent revenue verification) |
| Phase | E11 -- Implement Teideal Verify independent revenue verification |
| Priority | Highest |
| Points | 8 |
| Release | mvp |
| Order | 38 (within this phase) |
| Depends on | `roleGuard.ts`/`consoleRoute` (TEID-43), the AES-256-GCM token-encryption pattern in `stripeConnect.ts` (TEID-37, generalized here, not imported), `webhooks.ts`'s bounded-timeout `fetch` pattern (TEID-48) -- all already built. Nothing from TEID-65/99/100/101 (the real Stripe/Metronome/Orb/Lago connectors this framework is *for*) exists yet or is needed -- this story is the framework alone. |

## Story (verbatim from the live board)

> As a Teideal engineer, I want a common framework that every billing-system connector is built on, so that each new connector is read-only, reliable and consistent by construction.
>
> *Context*
> Prerequisite for the Metronome, Orb and Lago connectors. Generalises the connector approach in TEID-65.

## Acceptance criteria (verbatim from the live board)

1. The framework defines one data model for customers, prices, contracts, invoices, credits, payments and refunds.
2. It provides shared handling for authentication, pagination, rate limits, retries, incremental sync and error reporting.
3. A contract test suite checks that a connector is read-only, maps data correctly and survives API failures; a connector cannot ship until it passes.
4. Sync health for every connector appears in the same console view.

## Cataloged tests (verbatim from the live board)

| ID | Type | AC | Title |
|---|---|---|---|
| TEID-98-T1 | Functional | 1 | Instantiate the framework's data model with a sample Stripe export containing customers, prices, contracts, invoices, credits, payments and refunds, and confirm all seven entity types map into the single common schema without field loss. |
| TEID-98-T2 | Functional | 2 | Configure a mock connector with a 100 request per minute rate limit and confirm the shared client throttles requests to stay under the limit while automatically retrying 3 consecutive 429 responses with exponential backoff. |
| TEID-98-T3 | Functional | 3 | Run the contract test suite against a connector stub that includes a hidden write endpoint and confirm the suite fails the read-only check and blocks the connector from being marked shippable. |
| TEID-98-T4 | Functional | 4 | Register two connectors, Stripe and a mock CSV importer, with differing sync states and confirm both appear with last-sync timestamp and status in the same console health view. |
| TEID-98-T5 | Non-functional | 2 | Simulate an incremental sync of 500,000 records through the shared pagination and retry pipeline and confirm it completes within 15 minutes without memory growth beyond 2GB. |
| TEID-98-T6 | Non-functional | 3 | Add a new mock connector implementing only the base interface and confirm the existing contract test suite runs against it with zero test-code changes required. |
| TEID-98-T7 | Adversarial | 3 | Submit a connector to the contract test suite that returns HTTP 500 on 10 percent of paginated requests and confirm the suite fails it for not surviving API failures rather than silently passing. |
| TEID-98-T8 | Adversarial | 2 | Feed the shared retry handler a connector that returns malformed JSON on every retry attempt and confirm it gives up after the configured retry ceiling and reports a clear error rather than retrying indefinitely. |

## Scoping notes for this point in the build sequence

**This story builds the framework only -- no real third-party API integration.** TEID-65 (first real connector, order 39) and TEID-99/100/101 (Metronome/Orb/Lago, all `provisional: true`) are separate, future stories that will *implement* this framework's `Connector` interface against a real billing platform. Every cataloged test here uses a mock/stub connector or a fake HTTP target this story itself builds -- T1's "sample Stripe export" is a realistic-shaped fixture fed directly into the data-model mapper to prove field-loss-free mapping, not a live call to Stripe's API. Nothing in this story talks to a real external service.

**Retry/backoff, rate limiting, and error-injection test doubles are all genuinely new -- no existing code to reuse, checked directly.** `webhooks.ts` and `exportWorker.ts` both retry on a fixed, injectable delay-*array* (`RETRY_DELAYS_MS`-style), not a computed formula -- fine for their own fixed-schedule use cases, but T2's title explicitly says "exponential backoff" against a *configurable* rate limit, which needs a computed `baseDelayMs * 2^attempt` (capped), not a hardcoded table. Rate limiting (token-bucket or equivalent) does not exist anywhere in this codebase for any outbound call, checked by grep across both services. Every existing fake-third-party-server test double (`fake-stripe.ts`, `fake-slack.ts`, `fake-webhook-receiver.ts`, `fake-google.ts`, `fake-oncall.ts`) uses fixed, scenario-baked failure rules with no runtime error-injection API -- this story's own fake connector-target needs one (configurable 429-then-succeed, persistent 5xx, malformed JSON, and a deliberately-hidden write endpoint for T3), since none of the existing fakes provide a pattern to copy.

**Money uses decimal strings, deliberately breaking from `services/ts-console`'s existing plain-JSON-number convention.** Every other ts-console route (`grants.ts`, etc.) converts Postgres `NUMERIC` to a JS `number` before sending JSON -- a float-precision compromise already baked into the rest of the console. E11/Verify's entire purpose is catching revenue leakage to the cent (`TEID-70`: "Leakage and overbilling in dollars"); a common data model that round-trips every connector's invoice/payment amounts through IEEE-754 floats before any reconciliation code sees them would undermine that purpose at the exact precision this epic exists to guarantee. This story's `Price`/`Invoice`/`Payment`/`Credit`/`Refund` types carry `amount: string` (decimal text, matching `go-usage`'s own precision-conscious `internal/money` package's intent even though that package itself is Go-only and not imported here), not `number`. This is a deliberate, one-off deviation from the console's existing convention, not an oversight -- do not "fix" it to match `grants.ts`'s `toNumber()` pattern.

**Role gating for connector configuration is `["Owner", "Billing Admin", "Developer"]`, a deliberate choice, not a copy of the nearest literal precedent.** `stripeConnect.ts`'s four OAuth-connect routes use no role restriction at all (`[...ROLES]`, open to every role including Support) -- an existing inconsistency in this codebase, not a pattern to repeat for a new, more sensitive surface (a connector holds a third-party read credential; "who can configure it" deserves tighter gating). `TEID-47`'s billing-threshold-config routes (`["Owner", "Billing Admin"]`) and `apiKeys.ts`'s create/rotate/revoke routes (`["Owner", "Developer"]`) are both closer analogues; this story takes the union, since a connector is simultaneously a billing-configuration surface (Owner/Billing Admin's territory) and a developer-integration surface (Developer's territory per TEID-43's own AC1 wording, "API keys and sandbox").

**AC4's "sync health" view is modeled on `exportWorker.ts`'s `export_schedules` shape** (`last_run_at`/`last_run_status`/`consecutive_failures`), not TEID-38's `stripe_customer_match_candidates` review-queue shape -- the latter is for resolving *ambiguous data matches*, a different concern from *is this connection currently healthy*.

**This story does not add connector-CRUD (create/connect/disconnect) routes.** Each real connector (TEID-65/99/100/101) will need its own connect flow, shaped by that platform's own auth mechanism (OAuth for some, an API key for others -- Stripe Connect's own OAuth flow, TEID-37, is not a generic template every platform follows). This story defines the shared `connectors`/`connector_syncs` tables, the shared credential-encryption helper, the shared sync-recording helper, and the read-only sync-health endpoint every future connector-specific "connect" route will write into and every future connector-specific console screen will read from -- not the connect routes themselves, which have nothing to conform to yet since no real connector implementation exists. T4's "Register two connectors" is satisfied by seeding `connectors` rows directly (the same way a future connector's own connect endpoint eventually will), not by a generic `POST /connectors` this story would have to invent a contract for without a real caller.

## Architecture and design

**New migration** `db/migrations/20260930110000_connectors.sql`:

```sql
CREATE TABLE connectors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connector_type TEXT NOT NULL, -- 'stripe' | 'metronome' | 'orb' | 'lago' | 'csv_mock' | ... -- open string, not a CHECK enum, since new connector types (TEID-99/100/101) will be added by later migrations without touching this table
  display_name TEXT NOT NULL,
  -- Same AES-256-GCM shape as stripe_connections (TEID-37), generalized: any
  -- connector's credential (an API key, an OAuth token, whatever that
  -- platform needs) is opaque ciphertext to this table.
  credential_ciphertext TEXT,
  credential_iv TEXT,
  credential_auth_tag TEXT,
  status TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'disconnected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE connectors ENABLE ROW LEVEL SECURITY;
ALTER TABLE connectors FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_connectors ON connectors
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON connectors TO teideal_app;

-- AC4/T4: sync health, modeled on export_schedules' last_run_at/
-- last_run_status/consecutive_failures shape.
CREATE TABLE connector_syncs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connector_id UUID NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed')),
  records_synced INT NOT NULL DEFAULT 0,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE connector_syncs ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_syncs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_connector_syncs ON connector_syncs
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON connector_syncs TO teideal_app;
CREATE INDEX connector_syncs_connector_started_idx ON connector_syncs (connector_id, started_at DESC);

-- Running failure-streak counter, updated by recordSyncResult (see below) --
-- avoids recomputing "how many failures in a row" from the sync-history
-- table on every health-view read.
ALTER TABLE connectors ADD COLUMN consecutive_failures INT NOT NULL DEFAULT 0;
```

**Common data model** `services/ts-console/src/lib/connectors/types.ts` -- one TypeScript interface per AC1 entity, every money field a decimal string (see Scoping notes):

```ts
export interface ConnectorCustomer { id: string; name: string; email: string | null; created_at: string; }
export interface ConnectorPrice { id: string; product_name: string; amount: string; currency: string; billing_scheme: string; }
export interface ConnectorContract { id: string; customer_id: string; status: string; started_at: string; ended_at: string | null; }
export interface ConnectorInvoice { id: string; customer_id: string; amount: string; currency: string; status: string; issued_at: string; due_at: string | null; }
export interface ConnectorCredit { id: string; customer_id: string; amount: string; currency: string; reason: string | null; issued_at: string; }
export interface ConnectorPayment { id: string; customer_id: string; invoice_id: string | null; amount: string; currency: string; status: string; paid_at: string; }
export interface ConnectorRefund { id: string; payment_id: string; amount: string; currency: string; reason: string | null; refunded_at: string; }
```

**Base `Connector` interface** `services/ts-console/src/lib/connectors/connector.ts`:

```ts
export interface ConnectorPage<T> { data: T[]; nextCursor: string | null; }

export interface Connector {
  readonly connectorType: string;
  // One paginated, incremental-sync-capable method per entity type. `since`
  // is an ISO timestamp (incremental sync, AC2); `cursor` is opaque,
  // connector-owned pagination state (never interpreted by framework code).
  // Every method is a read: this interface has no write/create/update/delete
  // method of any kind -- there is nothing for a conforming connector to
  // call that isn't a read, by construction of the interface itself.
  listCustomers(since: string | null, cursor: string | null): Promise<ConnectorPage<ConnectorCustomer>>;
  listPrices(since: string | null, cursor: string | null): Promise<ConnectorPage<ConnectorPrice>>;
  listContracts(since: string | null, cursor: string | null): Promise<ConnectorPage<ConnectorContract>>;
  listInvoices(since: string | null, cursor: string | null): Promise<ConnectorPage<ConnectorInvoice>>;
  listCredits(since: string | null, cursor: string | null): Promise<ConnectorPage<ConnectorCredit>>;
  listPayments(since: string | null, cursor: string | null): Promise<ConnectorPage<ConnectorPayment>>;
  listRefunds(since: string | null, cursor: string | null): Promise<ConnectorPage<ConnectorRefund>>;
}

export class ConnectorError extends Error {
  constructor(message: string, readonly statusCode: number, readonly retryable: boolean) { super(message); this.name = "ConnectorError"; }
}
```

T3's "hidden write endpoint" is therefore not something the *interface* can express (there is no write method to hide behind) -- it is a connector *implementation* that internally calls `fetch` directly against the fake target's write path, bypassing the shared client entirely. This is exactly why T3's check must be traffic-based (see the fake target below), not a TypeScript-level structural check: a misbehaving connector can always reach for the global `fetch` regardless of what the interface declares, and the contract suite has to catch that at the network boundary, the only place it's actually observable.

**Shared HTTP client** `services/ts-console/src/lib/connectors/httpClient.ts`:
- `createConnectorHttpClient(config: { baseUrl: string; requestsPerMinute?: number; maxAttempts?: number; baseDelayMs?: number; maxDelayMs?: number; timeoutMs?: number })` returns `{ get: (path, headers?) => Promise<{status, body}> }` -- **`get` is the only method exposed**, enforcing read-only at the type level for any connector that routes its calls through this client (a connector that wants to cheat still can, via raw `fetch`, per above -- the shared client makes the honest path the easy path, it does not sandbox the dishonest one).
- Token-bucket rate limiting (AC2/T2): `requestsPerMinute` (default unset = unlimited) governs a bucket refilled continuously (`capacity / (60_000 / requestsPerMinute)` ms per token); `get` awaits an available token before issuing the request, so throughput never exceeds the configured rate regardless of how fast the caller loops.
- Retry (AC2/T2/T7/T8): retryable outcomes are HTTP 429, HTTP 5xx, a network error, or a JSON-parse failure on a response whose `Content-Type` claims JSON. Non-retryable: any other 4xx (fails immediately, matching `ConnectorError.retryable = false`). Delay for retry attempt `n` (1-indexed) is `min(baseDelayMs * 2 ** (n - 1), maxDelayMs)` (defaults: `baseDelayMs = 1000`, `maxDelayMs = 60_000`, `maxAttempts = 5`). After `maxAttempts` total attempts, throws `ConnectorError` with the last failure's detail and `retryable: false` -- T8's "gives up... reports a clear error rather than retrying indefinitely" is this ceiling, not a separate mechanism.
- Timeout (bounded per attempt, pattern from `webhooks.ts`'s `attemptDelivery`): `AbortController` + `setTimeout(timeoutMs)`, default `30_000`, per attempt (a timeout counts as a retryable failure, consuming one of `maxAttempts`).

**Credential encryption** `services/ts-console/src/lib/connectors/credentials.ts`: `encryptCredential(plaintext, key)` / `decryptCredential({ciphertext, iv, authTag}, key)`, the exact AES-256-GCM shape `stripeConnect.ts` already uses, generalized to take the key as a parameter (`CONNECTOR_CREDENTIAL_ENCRYPTION_KEY` env var, same 32-byte-base64 validation as `STRIPE_TOKEN_ENCRYPTION_KEY`) instead of being Stripe-specific. `stripeConnect.ts` itself is not modified by this story -- its own key/columns stay as they are; this is a new, separate helper for connectors built on this framework going forward, not a migration of existing Stripe Connect data.

**Sync recording** `services/ts-console/src/lib/connectors/syncHealth.ts`:
- `startSync(pool, tenantId, connectorId): Promise<string>` -- inserts a `connector_syncs` row (`status = 'running'`), returns its id.
- `completeSync(pool, tenantId, syncId, outcome: {status: 'succeeded' | 'failed', recordsSynced: number, errorMessage?: string})` -- updates the row (`completed_at = now()`), and updates the parent `connectors.consecutive_failures` (reset to `0` on success, incremented on failure) in the same transaction.
- `getSyncHealth(pool, tenantId): Promise<Array<{connector_id, connector_type, display_name, status, last_sync_at, last_sync_status, consecutive_failures}>>` -- one row per connector, its most recent `connector_syncs` row joined in (`DISTINCT ON (connector_id) ... ORDER BY connector_id, started_at DESC`), a connector with zero sync history still appears with nulls (AC4 says "every connector," not "every connector that has synced").

**New route** `services/ts-console/src/routes/connectors.ts`: `GET /connectors/sync-health`, role-gated `["Owner", "Billing Admin", "Developer"]`, returns `{data: [...]}` from `getSyncHealth`.

**Reference mock connector** `services/ts-console/src/lib/connectors/mockConnector.ts`: a real, working `Connector` implementation backed by an in-memory or fixture-driven data set (not a real API) -- this is what T1's data-model check and T4's "mock CSV importer" registration exercise, and what the contract suite itself is developed and proven against before any real platform-specific connector exists. `connectorType = "csv_mock"`.

**Contract test suite** `tests/connectors/contractSuite.ts` (new, alongside the other test suites but exported as a reusable module, not a `.test.ts` file itself): `runConnectorContractSuite(setup: () => Promise<{connector: Connector, fakeTarget: FakeConnectorTarget}>)` -- a function containing `describe`/`it` blocks (T3's read-only check, T7's failure-survival check, and a data-mapping-completeness check) that any connector's own test file calls with just its own `setup`. T6 is satisfied by construction: a brand-new connector's test file is `import { runConnectorContractSuite } from "../connectors/contractSuite.js"; runConnectorContractSuite(async () => ({connector: new MyNewConnector(...), fakeTarget: ...}));` -- zero changes to `contractSuite.ts` itself.

**Fake connector-target test double** `tests/connectors/fake-connector-target.ts` (new -- no existing fake has an error-injection API, per Scoping notes): a real `http.createServer`, logging every request (method, path, headers) to a `requests[]` array (`GET /_requests` to retrieve, matching every other fake's convention), plus a `POST /_configure` endpoint accepting `{failureMode: "none" | "rate_limited" | "persistent_5xx" | "malformed_json" | "intermittent_5xx", failureRate?: number}` and a `/v1/customers`-style paginated read endpoint plus one deliberately-undocumented write endpoint (`POST /v1/customers/:id/close`) that a misbehaving stub connector can be made to call, for T3.

## Implementation guidance per test

### TEID-98-T1
Feed a realistic, Stripe-shaped fixture object (nested/differently-named fields, matching how Stripe's own API actually names things, e.g. `unit_amount`, `customer`, `subscription`) through the mock connector's own mapping logic (or a shared `mapToConnectorModel` helper if the mock connector's fixtures are pre-shaped -- either way, the test must exercise real field-by-field mapping code, not just construct `ConnectorCustomer` objects directly). Assert every one of the 7 resulting entity arrays is non-empty and that every field defined on each interface is present and correctly typed (in particular, every money field is a decimal *string*, never a `number`), with no fixture field silently dropped.

### TEID-98-T2
Configure the shared HTTP client with `requestsPerMinute: 100` against `fake-connector-target.ts`. Set the fake target's failure mode to `rate_limited` for its first 3 responses (429), then succeed. Drive enough requests through the client to measure sustained throughput over at least 30 seconds; assert the observed rate stays at or under 100/min (with reasonable tolerance for bucket-refill granularity). Assert the 3 rate-limited responses were retried (visible in `fake-connector-target.ts`'s request log as 4 total requests for that one logical call) with strictly increasing delays between them, and that the call ultimately succeeds.

### TEID-98-T3
Implement a stub `Connector` whose `listCustomers` calls the shared client's `get` for the documented read path, but *also* makes a raw `fetch` `POST` to `fake-connector-target.ts`'s hidden `/v1/customers/:id/close` endpoint (the "hidden write endpoint"). Run `runConnectorContractSuite` against this stub. Assert the read-only check fails specifically because `fake-connector-target.ts`'s request log contains a non-GET method, and assert the suite's overall result is "not shippable" (whatever boolean/status the suite's own top-level export reports -- design it to return a clear pass/fail summary, not just individual `it()` pass/fail, since T3 explicitly needs "blocks the connector from being marked shippable" as an assertable outcome).

### TEID-98-T4
Seed two `connectors` rows directly (`connector_type = 'stripe'` and `connector_type = 'csv_mock'`) with differing `connector_syncs` history (one with a recent `succeeded` sync, one with a `failed` sync and `consecutive_failures > 0`). Call `GET /connectors/sync-health`. Assert both connectors appear in the response with their correct `last_sync_at`/`last_sync_status`/`consecutive_failures`, in the same single response (the "same console view" AC4 requires).

### TEID-98-T5
Configure `fake-connector-target.ts` to serve a large paginated dataset (500,000 total records across pages of e.g. 1,000-5,000 each, minimal artificial latency, no rate limit configured for this test specifically -- this test measures the pagination/streaming pipeline's own throughput and memory behavior, decoupled from T2's separate tight-rate-limit scenario, which would make 500K records in 15 minutes arithmetically impossible at 100/min). Drive a full incremental sync of the mock connector against it using an async-generator/streaming consumption pattern (never collecting all 500,000 records into one in-memory array at once). Assert the sync completes within 15 minutes and assert peak process memory (`process.memoryUsage().rss` sampled periodically during the run) never exceeds 2GB.

### TEID-98-T6
Write a second, deliberately trivial `Connector` implementation in the test file itself (or a small fixture connector), implementing only the base interface against `fake-connector-target.ts`. Call `runConnectorContractSuite` with this new connector's own `setup`, importing `contractSuite.ts` unchanged. Assert the suite runs and passes (or fails appropriately if configured to) without any modification to `contractSuite.ts`'s own source -- this is best proven by literally not touching that file for this test's own implementation, confirmed by the PR diff itself alongside the passing test.

### TEID-98-T7
Configure `fake-connector-target.ts`'s failure mode to `intermittent_5xx` with `failureRate: 0.1` (10% of paginated requests return 500). Run `runConnectorContractSuite` against the mock connector pointed at this target. Assert the suite's failure-survival check explicitly fails (not silently passes) when the connector cannot complete a full sync despite the shared client's own retry logic exhausting attempts on an unlucky page -- i.e., this test proves the *contract suite itself* correctly flags a connector/target combination that doesn't reliably survive real-world intermittent failures, distinct from T2's test of the retry mechanism succeeding on a *bounded* number of failures.

### TEID-98-T8
Configure `fake-connector-target.ts`'s failure mode to `malformed_json` (every response returns `HTTP 200` with a body that fails `JSON.parse`). Call the shared HTTP client's `get` directly against this target. Assert it retries up to `maxAttempts`, then throws a `ConnectorError` with a clear, human-readable message (not a raw `SyntaxError` from a failed `JSON.parse` leaking out) and `retryable: false`, and assert via the fake target's request log that exactly `maxAttempts` requests were made -- not more (proving the ceiling actually stops it, not just that it eventually gives up by accident).

## File layout

- `db/migrations/20260930110000_connectors.sql` -- `connectors`, `connector_syncs` tables.
- `services/ts-console/src/lib/connectors/types.ts` -- the 7 common entity interfaces.
- `services/ts-console/src/lib/connectors/connector.ts` -- `Connector` interface, `ConnectorPage`, `ConnectorError`.
- `services/ts-console/src/lib/connectors/httpClient.ts` -- rate-limited, retrying, timeout-bounded, GET-only shared client.
- `services/ts-console/src/lib/connectors/credentials.ts` -- AES-256-GCM encrypt/decrypt, generalized from `stripeConnect.ts`.
- `services/ts-console/src/lib/connectors/syncHealth.ts` -- `startSync`/`completeSync`/`getSyncHealth`.
- `services/ts-console/src/lib/connectors/mockConnector.ts` -- the reference mock/CSV-importer connector.
- `services/ts-console/src/routes/connectors.ts` -- `GET /connectors/sync-health`.
- `services/ts-console/src/server.ts` -- register the new route.
- Tests: new directory `tests/connectors/` -- `contractSuite.ts` (the reusable, exported suite), `fake-connector-target.ts` (the new configurable-failure fake), `connectors.test.ts` (T1, T2, T4, T5 plus invoking the contract suite for T3/T6/T7/T8's own scenarios).

## Definition of done

- [ ] Every acceptance criterion above is satisfied by working code.
- [ ] Every cataloged test has a real automated test that passes -- functional, non-functional, and adversarial alike.
- [ ] `tsc --noEmit` is clean in `services/ts-console`.
- [ ] `tests/cross-tenant`, `tests/console-auth`, `tests/rbac`, `tests/api-keys`, `tests/stripe-connect` all still pass unchanged (this story adds a new, separate credential-encryption helper and does not touch `stripeConnect.ts`'s own tables/routes).
- [ ] `contractSuite.ts` itself is not modified by T6's own test file -- confirmed by the PR diff.
- [ ] `docs/api/connectors.md` documents `GET /connectors/sync-health`, linked from `docs/api/README.md`; `tests/docs/coverage.test.ts` passes.
- [ ] The suite passes against a database rebuilt from scratch using only committed migration/seed scripts.
- [ ] PR description includes a checklist mapping each test ID to the file/line that covers it.
