# TEID-65: Connect billing systems read-only

| | |
|---|---|
| Epic | TEID-11 (E11 -- Implement Teideal Verify independent revenue verification) |
| Phase | E11 -- Implement Teideal Verify independent revenue verification |
| Priority | Highest |
| Points | 8 |
| Release | mvp |
| Order | 39 (within this phase) |
| Depends on | TEID-98/98.1/98.2's connector framework (`Connector` interface, `httpClient.ts`, `credentials.ts`, `connectors`/`connector_syncs`/`cursor_high_water`, `syncHealth.ts`) -- all merged and clean. TEID-37's Stripe Connect OAuth (`stripeConnect.ts`, `stripe_connections`, `readUsableAccessToken`, `assertWriteScope`) -- already built, reused as-is, not modified. `exportFormats.ts`'s `csvCell`-adjacent conventions exist for CSV *writing* only; CSV *reading* is new. |

## Story (verbatim from the live board)

> As a finance lead, I want to connect our billing and payment systems to Teideal with read-only access, so that Teideal can check our billing without any risk of changing it.
>
> *Context*
> Launch with Stripe Billing, then add Metronome, Orb and Lago in order of design-partner demand. A generic file and API importer covers homegrown systems.

## Acceptance criteria (verbatim from the live board)

1. An operator can connect Stripe Billing at launch, and any system through the generic CSV or API importer.
2. Every connector uses read-only credentials, and Teideal contains no code path that writes to a connected billing system; an automated test on every release confirms this.
3. Teideal pulls customers, prices, subscriptions, invoices, line items, credit notes, payments and refunds.
4. The first sync can load up to 24 months of history; after that, new data is synced at least every hour.
5. The connection screen shows the last successful sync and any errors in plain English.

## Cataloged tests (verbatim from the live board)

| ID | Type | AC | Title |
|---|---|---|---|
| TEID-65-T1 | Functional | 1 | Connect a live Stripe Billing test-mode account through the UI and confirm the connection reaches Connected status within 60 seconds, then upload a 5,000-row CSV of invoices through the generic importer and confirm it is accepted. |
| TEID-65-T2 | Functional | 2 | Provision Stripe API credentials scoped read-only, then attempt a connection with write-scoped credentials, and confirm Teideal rejects the write-scoped key at setup. |
| TEID-65-T3 | Functional | 3 | After a Stripe sync, query the imported data and confirm counts match the source account exactly for customers, prices, subscriptions, invoices, line items, credit notes, payments and refunds. |
| TEID-65-T4 | Functional | 4 | Connect an account with 30 months of Stripe history and confirm the first sync imports exactly the most recent 24 months, then confirm a new invoice created afterward appears in Teideal within 60 minutes. |
| TEID-65-T5 | Functional | 5 | Revoke the API key mid-sync to force a failure, and confirm the connection screen displays a plain-English error message rather than a raw API error code, alongside the timestamp of the last successful sync. |
| TEID-65-T6 | Non-functional | 4 | Run the first sync against an account with 24 months of history totaling 2 million invoice line items and confirm it completes within 4 hours. |
| TEID-65-T7 | Non-functional | 5 | Disconnect network access mid-sync for 3 different connector types and confirm each surfaces a distinct, correctly attributed error message rather than a generic failure. |
| TEID-65-T8 | Adversarial | 2 | Attempt to invoke any billing-system write endpoint, such as create invoice or update subscription, from within Teideal's codebase or API surface, and confirm the release-gating automated test fails the build if such a call path exists. |
| TEID-65-T9 | Adversarial | 3 | Import a CSV through the generic importer containing duplicate invoice IDs and rows with missing required fields, and confirm Teideal rejects or quarantines the bad rows without corrupting the rest of the import. |

## Scoping notes for this point in the build sequence

This story is the single largest scope jump in E11 so far -- it is the framework's first real integration, a brand-new file-import capability, new scheduling infrastructure, and a new release gate, all in one 8-point card. Every genuine gap below was checked directly against the current codebase (not assumed) before deciding how to close it.

**No UI exists anywhere in this repo -- confirmed by direct search, the same gap TEID-45 found for invoices.** `services/ts-console` is a pure Fastify JSON API (no React/Vue/Svelte, no `.tsx`, no `src/components`); the only HTML in the repo is the static kanban board. T1's "through the UI" and T5/AC5's "connection screen" have no UI to point to. **The substitution**: every "UI" reference in this story's tests is satisfied by the documented JSON API a future console UI would call -- `GET /connectors/sync-health` (already built by TEID-98, extended here) *is* "the connection screen," and T1's "connect... through the UI" is satisfied by the real HTTP connect flow (OAuth redirect + a `POST /connectors/stripe/register` call) a UI would drive. This mirrors TEID-45's own `ledger_transactions`-stands-in-for-invoices precedent exactly: the underlying mechanism is real and complete, only the literal UI surface is deferred.

**TEID-38's existing Stripe customer sync (`stripeCustomers.ts`, `routes/stripeCustomers.ts`) is deliberately left untouched, not folded into this story.** It already does real, on-demand, email-matched Stripe customer sync for E04's own purpose (resolving a Teideal customer's identity against Stripe, for billing/invoicing integration) -- a different concern from E11/Verify's purpose here (pulling a read-only copy of a tenant's *entire* billing history for independent reconciliation). The two features coexist: E04's matching sync stays exactly as it is; this story adds a second, separate, framework-based sync path with its own landing storage. Refactoring or merging them is out of scope -- nothing in this story's own AC/tests requires it, and doing so would risk a working, already-shipped E04 feature for no tested benefit.

**Stripe connects via its existing OAuth flow (TEID-37), not a new raw-API-key path.** `buildAuthorizeUrl`/`exchangeCode` already request and verify a real Stripe Connect `scope` (`read_only`/`read_write`), already reject a scope mismatch at the OAuth callback, and `assertWriteScope` already blocks a write attempt on a `read_only` connection -- this is real, Stripe-enforced read-only, not a Teideal-side convention alone. T2's "provision Stripe API credentials scoped read-only... reject the write-scoped key at setup" is satisfied by this existing OAuth scope check (reused as-is) -- this story does not build a second, parallel raw-secret-key connection path for Stripe specifically. Raw API-key-style credentials (via `connectors.credential_*`, TEID-98's own existing column) are for the generic importer's "API" half (a homegrown system without an OAuth app) -- not exercised by name in any of this story's own 9 tests (T1/T2 both name Stripe or CSV specifically), so a generic authenticated-API connector beyond CSV is not built in this story; `connectors.credential_*` and `httpClient.ts` already exist for a future one to use unchanged.

**"Generic API importer" (AC1's second half) is satisfied by the framework itself, not a new mechanism.** TEID-98's own `Connector` interface is already the generic contract any homegrown system integrates against; this story does not invent a second, more-generic API-import mechanism beyond what TEID-98 already provides. This story's own concrete deliverable for "generic... importer" is the CSV half (T1/T9 both test CSV specifically) -- scoped to invoices only (matching T1's "5,000-row CSV of invoices" and T9's "duplicate invoice IDs," not a universal 7-entity CSV schema), landing in the same storage every connector writes into.

**No table anywhere stores the data a connector actually pulls -- TEID-98 was framework-only by its own explicit design.** `types.ts`'s common model defines the *shape*; nothing persists it. This story adds `connector_records` (see Architecture) as a single, generic landing table keyed by `(connector_id, entity_type, external_id)`, storing each entity's full mapped common-model JSON. A single JSONB-based table now, not eight rigid per-entity relational tables, is a deliberate choice -- T3 only needs exact-count queryability per entity type, which a JSONB table with a `GROUP BY entity_type` satisfies directly; per-entity typed tables can be introduced later if a reconciliation story (TEID-69 onward) needs relational joins JSONB can't serve efficiently, without this story guessing at that shape prematurely.

**`cursor_high_water` advances per-page during a sync, not only once at the end -- a deliberate, documented extension of TEID-98.1's own design, not a contradiction of it.** TEID-98.1 built `completeSync`'s watermark merge for a short-lived, single-attempt sync where "advance only on full success" is the right safety property. A 24-month, up-to-2-million-line-item backfill (T6) cannot safely defer every checkpoint to one final success at hour four -- a crash at hour three must not lose three hours of real progress. This story adds `advanceWatermark` (see Architecture), called after each successfully-processed page, updating only that one entity's `cursor_high_water` key immediately -- `connector_syncs.status` still only becomes `'succeeded'` at the end of a full attempt (TEID-98.1's own all-or-nothing *attempt* semantics are unchanged), but the watermark itself is now a true incremental checkpoint, not an attempt-scoped one. Document this distinction clearly in code -- a future reader must not assume `cursor_high_water` implies the whole sync it's part of succeeded.

**T8's release-gating write-guard is built as two layers, not one.** TEID-98's own `contractSuite.ts` already proves a *given* connector makes no non-GET request against a fake target it's actually run against -- real, but only as strong as what gets exercised in a test. T8's "from within Teideal's codebase... the release-gating automated test fails the build if such a call path exists" asks for something broader: a static source scan, run as its own test, over every file in `services/ts-console/src/lib/connectors/` (the whole framework plus every real connector implementation) asserting no raw `fetch`/`http.request`/`https.request` call site anywhere in that directory uses a non-`"GET"` method, except inside `credentials.ts` (no network calls there at all) and inside `httpClient.ts`'s own single `fetch` call site (already hardcoded `method: "GET"`, the one place a method literal is allowed to exist). This catches a write call sitting in code no test happens to exercise, which the runtime traffic-log check alone cannot. Both layers run in CI; neither replaces the other.

**`fake-stripe.ts` has no endpoint for prices, subscriptions, invoices, credit notes, charges, or refunds today -- only customers.** This story extends it with all six, following its own existing request-logging/scenario-based-failure conventions (no new error-injection API needed beyond what TEID-98's own `fake-connector-target.ts` already proved is useful, which this story's own tests reuse directly for the CSV/generic-framework pieces rather than duplicating).

## Architecture and design

**New migration** `db/migrations/20261001090000_connector_sync_storage.sql`:

```sql
-- The landing store every connector (Stripe or CSV) writes into. One row
-- per (connector, entity type, external id); re-synced rows upsert.
CREATE TABLE connector_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connector_id UUID NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL CHECK (entity_type IN (
    'customer', 'price', 'contract', 'invoice', 'credit', 'payment', 'refund'
  )),
  external_id TEXT NOT NULL,
  data JSONB NOT NULL, -- the mapped ConnectorX object, verbatim
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (connector_id, entity_type, external_id)
);
ALTER TABLE connector_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_records FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_connector_records ON connector_records
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON connector_records TO teideal_app;
CREATE INDEX connector_records_connector_entity_idx ON connector_records (connector_id, entity_type);

-- Distinguishes "still backfilling" from "caught up, now hourly-incremental."
ALTER TABLE connectors ADD COLUMN backfill_completed_at TIMESTAMPTZ;
-- Links a connector_type='stripe' row to the OAuth connection it reads its
-- token from. NULL for every other connector type (API-key connectors use
-- connectors.credential_* directly; stripe_connections is the only
-- exception, per TEID-98.1's own documented boundary).
ALTER TABLE connectors ADD COLUMN stripe_connection_id UUID REFERENCES stripe_connections(id);

-- CSV import jobs and their quarantined rows (T9).
CREATE TABLE csv_imports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connector_id UUID NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  total_rows INT NOT NULL,
  accepted_rows INT NOT NULL,
  quarantined_rows INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE csv_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE csv_imports FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_csv_imports ON csv_imports
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT ON csv_imports TO teideal_app;

CREATE TABLE csv_import_quarantine (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  import_id UUID NOT NULL REFERENCES csv_imports(id) ON DELETE CASCADE,
  row_number INT NOT NULL,
  raw_row JSONB NOT NULL,
  reason TEXT NOT NULL
);
ALTER TABLE csv_import_quarantine ENABLE ROW LEVEL SECURITY;
ALTER TABLE csv_import_quarantine FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_csv_import_quarantine ON csv_import_quarantine
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT ON csv_import_quarantine TO teideal_app;
```

**`services/ts-console/src/lib/connectors/stripeBillingConnector.ts`** (new): a real `Connector` implementation. Constructor takes the tenant's `stripe_connections` row id, resolves a usable access token via `readUsableAccessToken` (TEID-37, unchanged) at call time (not cached across a long backfill -- a token can be revoked mid-sync, T5/T7's own scenario). Each `list*` method calls `createConnectorHttpClient({baseUrl: STRIPE_API_BASE_URL, requestsPerMinute: ..., ...})`'s `.get()` with `Authorization: Bearer <token>`, against: `GET /v1/customers`, `/v1/prices`, `/v1/subscriptions`, `/v1/invoices` (mapping each invoice's embedded `lines.data` into `ConnectorInvoiceLine[]`, matching TEID-98.1's own `mapConnectorInvoiceLine` shape), `/v1/credit_notes`, `/v1/charges` (-> `ConnectorPayment`), `/v1/refunds`. Maps real Stripe field names (`unit_amount`, `customer`, `created`, etc. -- the exact shapes `mockConnector.ts`'s own `StripeLike*` interfaces already model) into the common types via the same mapping functions TEID-98/98.1/98.2 already built (`mapConnectorCustomer` etc., exported from `mockConnector.ts` and reused here, not duplicated).

**`services/ts-console/src/lib/connectors/syncWorker.ts`** (new):
- `advanceWatermark(pool, tenantId, connectorId, entityType, position: {since, cursor})`: updates just that one `cursor_high_water` key, immediately, independent of `completeSync`'s own end-of-attempt semantics (see Scoping notes).
- `runConnectorSync(pool, tenantId, connector, connectorInstance, options: {entityTypes, timeBudgetMs})`: calls `startSync`; for each entity type, pages via `list*(since, cursor)` starting from the current watermark, upserts every row into `connector_records` (`ON CONFLICT (connector_id, entity_type, external_id) DO UPDATE SET data = excluded.data, synced_at = now()`), calls `advanceWatermark` after each page, stops (returns, not errors) once `timeBudgetMs` elapses mid-entity-type (resumable next tick) or once every entity type's pagination is exhausted for a 24-month-bounded `since`. Calls `completeSync` at the end with the attempt's overall outcome.
- `backfillTick(pool)`: for every `connectors` row with `backfill_completed_at IS NULL` and `status = 'connected'`, calls `runConnectorSync` with `timeBudgetMs` bounded per tick (default 5 minutes) and `since` = 24 months before `now()` the first time, else the persisted watermark; sets `backfill_completed_at = now()` once a sync attempt completes with every entity type's cursor exhausted. Driven by a new interval timer, default every 60s while any connector is still backfilling (`CONNECTOR_BACKFILL_TICK_INTERVAL_MS`).
- `incrementalTick(pool)`: for every connector with `backfill_completed_at IS NOT NULL`, calls `runConnectorSync` using the watermark's own `since` going forward, no time budget (an incremental catch-up is bounded by definition -- at most an hour of new data). Driven by a new interval timer, default every hour (`CONNECTOR_INCREMENTAL_INTERVAL_MS`), matching AC4's "at least every hour."
- Both timers registered in `server.ts` exactly like every other worker (`DISABLE_BACKGROUND_WORKERS`/`NODE_ENV !== "test"`-gated; tests call `backfillTick`/`incrementalTick` directly with a fixed instant, matching every prior worker's own test convention).

**`services/ts-console/src/lib/connectors/csvInvoiceImporter.ts`** (new): `parseAndImportInvoiceCsv(pool, tenantId, connectorId, csvText): Promise<{total, accepted, quarantined}>`. Required columns: `invoice_id, customer_id, amount, currency, status, issued_at` (a minimal, documented schema -- extra columns pass through into `data.passthrough`, matching every other connector's own passthrough convention). A row is quarantined (written to `csv_import_quarantine`, not imported) if: a required column is missing/empty, `invoice_id` duplicates an `invoice_id` already seen *within this same file* (T9's own "duplicate invoice IDs" case), or `amount` fails the same decimal-string validation `decimalAmount` already enforces elsewhere. Every other row upserts into `connector_records` (`entity_type = 'invoice'`) under a `connector_type = 'csv_import'` connector row. One bad row never aborts the whole import -- the function processes every row exactly once and returns a summary, matching T9's "without corrupting the rest of the import."

**New routes** `services/ts-console/src/routes/connectors.ts` (extend TEID-98's existing file), role-gated `["Owner", "Billing Admin", "Developer"]` (unchanged from TEID-98):
- `POST /connectors/stripe/register {stripe_connection_id, display_name}` -- validates the given `stripe_connections` row belongs to the caller's tenant, has `status = 'connected'` and `scope = 'read_only'` (a `read_write`-scoped connection is rejected here with a clear error -- this is T2's actual enforcement point, reusing TEID-37's own already-verified Stripe-granted scope, not re-deriving it), creates a `connectors` row (`connector_type = 'stripe'`, `stripe_connection_id` set).
- `POST /connectors/csv-import/invoices` (multipart, new dependency `@fastify/multipart`) -- accepts a CSV file, creates a `connector_type = 'csv_import'` connector row if the caller doesn't already have one for this tenant (idempotent lookup-or-create), calls `parseAndImportInvoiceCsv`, returns the summary plus `csv_import_id`.
- `POST /connectors/:id/sync` -- triggers one `runConnectorSync` call synchronously (bounded by the same `timeBudgetMs` the backfill tick uses), for manual/test use.
- `DELETE /connectors/:id` -- marks `status = 'disconnected'`; for `connector_type = 'stripe'`, also calls `stripeConnect.ts`'s existing `deauthorize` on the linked `stripe_connections` row (reused, not reimplemented).
- `GET /connectors/sync-health` (already exists, extend): `getSyncHealth`'s each row gains `backfill_completed_at` and a humanized `last_error` -- a small `humanizeConnectorError(rawMessage): string` mapping known `ConnectorError` classes (network/timeout, 401/403 auth, 429 rate-limited, 5xx upstream) to a plain-English sentence (AC5/T5), falling back to a generic "the last sync failed; contact support if this persists" for anything unrecognized rather than ever surfacing a raw API error string.

**Release-gating write guard** (T8) `tests/connectors/no-write-guard.test.ts` (new, in `tests/connectors/` alongside the existing contract suite): reads every `.ts` file under `services/ts-console/src/lib/connectors/` (via `node:fs`, no new dependency), regex/AST-scans for `fetch(` call sites, asserts each one's `method` option is `"GET"` or absent, except inside `credentials.ts` (asserted to contain zero `fetch(` calls at all) where none should exist. This runs as a normal CI test (`tests/connectors`'s existing suite), so it fails the build exactly like any other test failure -- "the release-gating automated test" from T8's own wording.

**`fake-stripe.ts` extension**: add `GET /v1/prices`, `/v1/subscriptions`, `/v1/invoices` (with embedded `lines.data`), `/v1/credit_notes`, `/v1/charges`, `/v1/refunds`, each following the existing `/v1/customers` pagination convention (`starting_after`/`has_more`), plus a `POST /_seed/<entity>` per new entity type (matching the existing `/_seed/customers` convention) so tests can pre-populate large, realistic datasets (T4/T6's scale fixtures).

## Implementation guidance per test

### TEID-65-T1
Drive the real OAuth flow against `fake-stripe.ts` (matching `tests/stripe-connect`'s own existing test pattern) through to a `connected`, `read_only` `stripe_connections` row, call `POST /connectors/stripe/register`, assert the resulting `connectors` row's `status` (or `GET /connectors/sync-health`'s corresponding row) reaches a connected state within 60 seconds of the call (should be immediate -- this test is really proving the registration path works end-to-end, not timing it). Separately, build a 5,000-row CSV fixture of invoices (set-generated, not hand-written), `POST` it to `/connectors/csv-import/invoices` as multipart, assert `202`/`200` with `accepted: 5000`.

### TEID-65-T2
Seed a `stripe_connections` row with `scope = 'read_write'`, `status = 'connected'`. Call `POST /connectors/stripe/register` with that connection's id. Assert the request is rejected (400/403) with a clear "connection must be read-only" error, and assert no `connectors` row was created as a result (verify via direct DB read, matching this codebase's established convention for proving a rejection didn't silently half-succeed).

### TEID-65-T3
Seed `fake-stripe.ts` with a known, exact count of each of the 7 entity types (including invoice line items nested in a few invoices). Run `runConnectorSync` (or `POST /connectors/:id/sync` repeatedly until exhausted). Query `connector_records` grouped by `entity_type`, `COUNT(*)`. Assert every count matches the seeded fixture exactly, including a separate count of invoice line items extracted from the `data->'lines'` JSONB path.

### TEID-65-T4
Seed `fake-stripe.ts` with invoices spanning 30 months of `created` timestamps. Run a full backfill (`backfillTick` repeated until `backfill_completed_at` is set). Assert `connector_records` contains invoices only from the most recent 24 months (count and date-range check), none older. Then seed one new invoice with a `created` timestamp after the backfill completed, run `incrementalTick`, assert it appears in `connector_records` -- and assert this whole round trip's *elapsed real time* is not what's being measured (T4 doesn't require actually waiting 60 real minutes; assert the incremental tick's own `since` correctly starts from the watermark and would run at least hourly per the configured interval, i.e. test the interval configuration and the incremental-pickup logic directly, not a real wall-clock wait).

### TEID-65-T5
Seed a `stripe_connections` row, register it, begin a sync. Mid-sync (e.g. after the first successful page), reconfigure `fake-stripe.ts` (or the connection's stored token) to return 401 on every subsequent request, matching "revoke the API key." Let the sync attempt fail. Call `GET /connectors/sync-health`, assert the connector's row shows a `last_error` that is a plain sentence (assert it does NOT contain raw strings like `"401"` or a JSON error blob) and assert `last_sync_at`/the prior successful sync's timestamp is still present and unchanged (the failure doesn't erase the record of the last good sync).

### TEID-65-T6
Seed `fake-stripe.ts` with 2,000,000 invoice line items across realistically-distributed invoices spanning the 24-month window (generated algorithmically by the fake target, not held in memory as 2M literal fixture objects -- matching `fake-connector-target.ts`'s own established on-demand-generation pattern from TEID-98). Run the real backfill loop (`backfillTick` called repeatedly, or a single long-running test invocation of the underlying sync function with a generous but finite test timeout) and assert it completes (`backfill_completed_at` set, all line items present in `connector_records`) within a budget scaled for CI the same way TEID-20-T5/TEID-22-T5/TEID-50-T4 scale their own non-functional budgets -- the literal "4 hours" stays available as a documented manual-run target; the automated CI assertion uses an env-configurable `CONNECTOR_BACKFILL_SCALE_BUDGET_MS` default sized for this suite's actual CI runtime.

### TEID-65-T7
For 3 distinct connector types (Stripe, CSV import, and the existing `csv_mock`/`MockConnector` from TEID-98 standing in as a third "generic" connector type for this adversarial test, per TEID-98's own established substitution precedent), simulate a network failure mid-sync (point the connector's `baseUrl` at an unreachable port, or kill the fake target mid-request). Assert each produces a distinct `last_error` message correctly attributing which connector/sync failed (not one generic "something went wrong" shared across all three), queryable via `GET /connectors/sync-health`.

### TEID-65-T8
Run `tests/connectors/no-write-guard.test.ts` against the real, final state of `services/ts-console/src/lib/connectors/`. As a adversarial proof the guard itself works (not just that today's code happens to pass it), add a throwaway fixture file *within the test itself* (a string literal containing a `fetch(url, {method: "POST"})` call, not a real source file) and assert the scanner's own detection logic flags it -- proving the test would fail the build if such code existed, per T8's own wording, without permanently adding a forbidden call to the real codebase to prove it.

### TEID-65-T9
Build a CSV fixture with: a majority of valid invoice rows, several rows sharing a duplicate `invoice_id`, several rows missing a required column. `POST` it to `/connectors/csv-import/invoices`. Assert the response's `accepted`/`quarantined` counts match exactly what the fixture construction intended. Query `connector_records` and assert only the valid rows (and exactly one instance of any legitimately-first-seen id, not a duplicate) are present; query `csv_import_quarantine` and assert every bad row is recorded with a correct `reason`.

## File layout

- `db/migrations/20261001090000_connector_sync_storage.sql` -- `connector_records`, `csv_imports`, `csv_import_quarantine`, `connectors.backfill_completed_at`/`stripe_connection_id`.
- `services/ts-console/src/lib/connectors/stripeBillingConnector.ts` (new) -- real Stripe `Connector` implementation.
- `services/ts-console/src/lib/connectors/syncWorker.ts` (new) -- `advanceWatermark`, `runConnectorSync`, `backfillTick`, `incrementalTick`.
- `services/ts-console/src/lib/connectors/csvInvoiceImporter.ts` (new) -- CSV parse/validate/quarantine/import.
- `services/ts-console/src/lib/connectors/mockConnector.ts` (extend) -- export the existing `mapConnector*` functions if not already exported, for reuse by `stripeBillingConnector.ts`.
- `services/ts-console/src/routes/connectors.ts` (extend) -- the 4 new routes, `getSyncHealth`'s extended response.
- `services/ts-console/src/lib/connectors/syncHealth.ts` (extend) -- `advanceWatermark`, `humanizeConnectorError`.
- `services/ts-console/src/server.ts` -- register the two new timers, the multipart plugin.
- `services/ts-console/package.json` -- add `@fastify/multipart`.
- `tests/stripe-connect/fake-stripe.ts` (extend) -- the 6 new entity endpoints plus seed routes.
- Tests: `tests/connectors/stripe-billing.test.ts` (new, T1/T2/T3/T4/T5/T6/T7's Stripe-specific cases), `tests/connectors/csv-import.test.ts` (new, T1/T9's CSV cases), `tests/connectors/no-write-guard.test.ts` (new, T8).

## Definition of done

- [ ] Every acceptance criterion above is satisfied by working code (AC1/AC5's "UI" wording satisfied via the documented API substitution above, not a fabricated UI).
- [ ] Every cataloged test has a real automated test that passes -- functional, non-functional, and adversarial alike.
- [ ] `tsc --noEmit` is clean in `services/ts-console`.
- [ ] `tests/cross-tenant`, `tests/console-auth`, `tests/rbac`, `tests/stripe-connect`, `tests/connectors` (TEID-98/98.1/98.2's existing 19) all still pass unchanged.
- [ ] `docs/api/connectors.md` documents every new route; `tests/docs/coverage.test.ts` passes.
- [ ] The suite passes against a database rebuilt from scratch using only committed migration/seed scripts.
- [ ] PR description includes a checklist mapping each test ID to the file/line that covers it.
