# TEID-98.1: Connector landing-zone follow-up

| | |
|---|---|
| Epic | TEID-11 (E11 -- Implement Teideal Verify independent revenue verification) |
| Phase | E11 -- Implement Teideal Verify independent revenue verification |
| Priority | Highest (blocks TEID-65 and everything after it in E11) |
| Points | 3 |
| Release | mvp |
| Order | 38.1 (between TEID-98 and TEID-65 -- not a live-board story; see Story below) |
| Depends on | TEID-98 (merged, PR #59, `1c93c2d`) -- `connectors`/`connector_syncs` tables, the `Connector` interface, `MockConnector`, `syncHealth.ts`, `GET /connectors/sync-health`, the contract suite. All already built and merged; this story extends them, does not replace them. |

## Story (not a live-board story -- source is an independent review)

> This story does not come from the live Teideal board. It comes from `TEID-98.1-Claude-Prompt.md` (repo root), an independent review of merged PR #59 written before TEID-65 (the first real connector) starts. Its own "Why": *"PR #59 shipped the HTTP/sync framework. Independent review: the common model and sync tables cannot support Verify (TEID-65/68) without a second schema. Fix the landing zone now."*
>
> Verified directly against the merged code before writing this spec (not taken on faith): `types.ts` is seven flat interfaces with no `passthrough` field and no invoice line items -- a real Stripe invoice's `billing_reason`, discounts, and per-line pricing detail are silently dropped, not merely unmapped. `mockConnector.ts`'s `decimalAmount` hardcodes a 2-decimal-place assumption (`slice(0, -2)` / `slice(-2)`) with no currency parameter at all -- wrong for JPY/KRW/VND (0 decimal places) and KWD/BHD/OMR/JOD (3), a genuine bug, not a hypothetical one. The `connectors` table has no column anywhere to persist where an incremental sync left off -- every sync would have to restart from `since = null` every time, which quietly defeats TEID-98's own AC2 ("incremental sync") the moment a second sync ever runs. All three are real, independently-confirmed gaps this story closes.

## Acceptance criteria

1. The common connector data model captures passthrough/unmapped fields and invoice line items, so Verify (TEID-65/68) does not need a second schema later.
2. Money conversion uses the correct minor-unit scale per currency (not a hardcoded 2-decimal assumption), using string arithmetic only, never `Number`.
3. Incremental-sync progress (`since`/`cursor` per entity) persists across sync runs, advancing only on a successful sync and never on a failed one.
4. Connector health/config surfaces stay correctly role-gated, structurally hygienic (unique connector naming, capped stored error messages), and the boundary between TEID-37's existing Stripe Connect OAuth credentials and this framework's own `connectors.credential_*` storage is documented and enforced by construction (no code path can write Stripe OAuth material into `connectors`).

## Cataloged tests (verbatim from `TEID-98.1-Claude-Prompt.md`'s own catalog, AC mapping added here)

| ID | Type | AC | Title |
|---|---|---|---|
| TEID-98.1-T1 | Functional | 1 | Invoice with two lines plus `passthrough.billing_reason` round-trips through the mapping layer intact; every money field stays a decimal string. |
| TEID-98.1-T2 | Functional | 2 | Currency minor-unit conversion is correct for a 0-decimal currency (100 JPY -> `"100"`), a 2-decimal currency (1001 USD -> `"10.01"`), and a 3-decimal currency (1234 KWD -> `"1.234"`), using string arithmetic only. |
| TEID-98.1-T3 | Functional | 3 | `completeSync` persists the supplied watermark into `connectors.cursor_high_water` on a successful sync; a failed sync leaves the previous watermark untouched. |
| TEID-98.1-T4 | Functional | 4 | A Support-role session receives `403` from `GET /connectors/sync-health`; a Billing Admin session receives `200`. |
| TEID-98.1-T5 | Adversarial | 1, 3 | Every one of TEID-98's original 8 cataloged tests still passes -- T1's own assertions are updated for the new fields (never weakening the existing decimal-string checks), and T5's real 500,000-record streaming test is not deleted or reduced. |
| TEID-98.1-T6 | Adversarial | 4 | Inserting a second `connectors` row with the same `(tenant_id, connector_type, display_name)` as an existing one is rejected by the database, not just application logic. |

## Scoping notes for this point in the build sequence

**This is a landing-zone widening, not a rewrite.** TEID-98's own architecture (GET-only `Connector` interface, token-bucket rate limiting, computed exponential backoff, the contract suite, the fake-target error-injection double) is unchanged and untouched by this story -- confirmed by the file list below, which never touches `httpClient.ts`, `credentials.ts` (except a doc comment), `fake-connector-target.ts`, or `contractSuite.ts`'s retry/rate-limit/read-only logic. Every addition here is either a new field on an existing type, a new column read/written by existing functions, or a new constraint -- nothing here changes how a connector talks to a third-party API.

**No real Stripe/Metronome/Orb/Lago integration, same boundary as TEID-98 itself.** `MockConnector`'s fixtures gain richer shape (invoice lines, a `passthrough` key); nothing here calls a real external service.

**`stripeConnect.ts` and `stripe_connections` are explicitly out of scope and untouched.** TEID-37's OAuth connection table and routes are a separate, already-working system for a different purpose (Teideal's own billing, via processor-neutral payments/E12) than this framework's `connectors` table (third-party billing-system *read* connections, for Verify/E11). AC4's "documented and enforced by construction" is satisfied by a doc comment on the `connectors` table plus the fact that no code anywhere in this story (or TEID-98 before it) ever reads from or writes to `stripe_connections` -- there is no shared code path to misuse, so "enforced by construction" means "the two systems remain structurally disjoint," not a new runtime guard. When TEID-65 (the first real, Stripe-backed Verify connector) is built, it must read the OAuth token from `stripe_connections` (via `stripeConnect.ts`'s own `readUsableAccessToken`, unchanged) and write only sync bookkeeping (`connectors`/`connector_syncs`/`cursor_high_water`) -- this story states that rule in the spec and in a schema comment; it does not and cannot enforce it in code yet, since TEID-65 doesn't exist yet to violate it.

**Currency minor-unit table is a fixed, documented, non-exhaustive set with a safe default.** `currencyMinorDigits` returns `2` for anything not explicitly listed -- this matches ISO 4217's own overwhelming majority case and mirrors `services/go-usage/internal/money`'s existing `CurrencyMinorUnits` map's spirit (though that package is Go-only and not imported here; this is a second, independent TypeScript implementation of the same well-known currency-exponent facts, not a code-sharing opportunity across languages). An unknown/unrecognized currency code defaults to 2 rather than throwing, since a connector framework must not hard-fail an entire sync over one exotic currency Teideal hasn't explicitly catalogued yet.

**Watermark persistence is per-entity, not per-connector.** `cursor_high_water` is a JSONB map (`{customers: {since, cursor}, invoices: {since, cursor}, ...}`) because each of the 7 entity types syncs independently and can be at a different point in its own incremental history -- a single scalar watermark would force all 7 entity types to advance in lockstep, which isn't how `Connector.list*(since, cursor)` is actually called (a real sync driver, built later, will paginate one entity type to completion before moving to the next).

## Architecture and design

**New migration** `db/migrations/20260930120000_connector_watermarks.sql`:

```sql
ALTER TABLE connectors ADD COLUMN cursor_high_water JSONB NOT NULL DEFAULT '{}'::jsonb;
COMMENT ON COLUMN connectors.cursor_high_water IS
  'Map of entity name -> {since, cursor}, advanced only on a successful completeSync call. Never used for Stripe Connect (TEID-37); that flow''s own OAuth state lives entirely in stripe_connections.';

COMMENT ON COLUMN connectors.credential_ciphertext IS
  'For API-key-style connectors (csv_mock now; Metronome/Orb/Lago later). Stripe Connect OAuth tokens for Verify (TEID-65) MUST continue to live in stripe_connections, encrypted under STRIPE_TOKEN_ENCRYPTION_KEY -- never copy an OAuth refresh/access token into this column.';

-- AC4/T6: a tenant may have multiple accounts of the same connector_type
-- (e.g. two Stripe accounts) later, so the uniqueness is on the display
-- name within a type, not on the type alone.
ALTER TABLE connectors ADD CONSTRAINT connectors_tenant_type_name_uniq
  UNIQUE (tenant_id, connector_type, display_name);
```

**`types.ts`** (extend, per the prompt's exact shape): add `external_updated_at: string | null` and `passthrough: Record<string, unknown>` to all seven existing interfaces; add `ConnectorInvoiceLine` (id, invoice_id, price_id, description, quantity, unit_amount, amount, currency, period_start, period_end, passthrough); extend `ConnectorInvoice` with `number`, `period_start`, `period_end`, `subtotal`, `tax`, `lines: ConnectorInvoiceLine[]`; extend `ConnectorPrice` with `interval`, `product_id`, `nickname`; extend `ConnectorPayment` with `processor_charge_id`; extend `ConnectorRefund` with `processor_refund_id`. Every new money-shaped field (`subtotal`, `tax`, invoice-line `unit_amount`/`amount`) is a decimal string, matching every existing money field's convention.

**`mockConnector.ts`**: replace `decimalAmount(value)` with `decimalAmount(value, currency)`, adding `currencyMinorDigits(currency: string): number`:

```ts
const ZERO_DECIMAL_CURRENCIES = new Set(["JPY", "KRW", "VND"]);
const THREE_DECIMAL_CURRENCIES = new Set(["KWD", "BHD", "OMR", "JOD"]);

export function currencyMinorDigits(currency: string): number {
  const code = currency.toUpperCase();
  if (ZERO_DECIMAL_CURRENCIES.has(code)) return 0;
  if (THREE_DECIMAL_CURRENCIES.has(code)) return 3;
  return 2;
}
```

`decimalAmount` pads/slices using `currencyMinorDigits(currency)` instead of the hardcoded `2` -- for `digits = 0`, no decimal point at all (`"100"`, not `"100."`); string arithmetic throughout, `Number` never called on the amount. Fixture mapping functions (`mapConnectorPrice`, `mapConnectorInvoice`, etc.) pass `row.currency` into `decimalAmount` (they already read `row.currency` for the `currency` field, so this is a one-line change per mapper, not new data). Every unmapped fixture key not already destructured into a named field is collected into that entity's `passthrough` object (a `const { id, name, email, created, ...passthrough } = row` destructure per mapper, or equivalent), so a fixture with an extra `billing_reason` key genuinely ends up in `passthrough.billing_reason`, not silently dropped -- this is what T1 actually proves, not just that the field exists on the TypeScript type.

**`syncHealth.ts`**: `completeSync`'s `SyncOutcome` gains an optional `watermark?: Record<string, { since: string | null; cursor: string | null }>`. On `status: 'succeeded'` with a supplied watermark, merge it into `connectors.cursor_high_water` (`cursor_high_water = cursor_high_water || $watermark::jsonb`, a shallow per-entity-key merge, in the same `UPDATE ... SET consecutive_failures = ...` statement/transaction already updating the connector row -- one round trip, one transaction, matching the existing "both updates or neither" guarantee). On `status: 'failed'`, `cursor_high_water` is left untouched (no watermark parameter is read at all in that branch -- the type signature should make a failed-sync watermark either disallowed or simply ignored, whichever is cleaner in the actual diff, but the *behavior* must be "failure never advances the watermark," per AC3). `outcome.errorMessage` is truncated to 500 characters before the `UPDATE` (`errorMessage.slice(0, 500)`), addressing the "cap `connector_syncs.error_message`" hygiene item. `getSyncHealth`'s returned rows include `cursor_high_water` (read straight from the `connectors` row, no extra query).

**`routes/connectors.ts`**: `GET /connectors/sync-health`'s response gains `cursor_high_water` per row (from `getSyncHealth`'s extended return type) -- no route-handler logic change beyond passing the new field through. Role gate stays `["Owner", "Billing Admin", "Developer"]`, unchanged from TEID-98 -- T4's Support-403/Billing-Admin-200 check is a regression-proving addition to the test suite (this role gate was already correct in TEID-98; T4 makes sure a future change can't silently loosen it, since TEID-98's own test file never actually exercised the negative case).

**Contract suite** (`tests/connectors/contractSuite.ts`): `mappingResult`'s per-entity `validFields` checks gain `passthrough: (value) => typeof value === "object" && value !== null` on all seven entity checks, and the invoice check additionally asserts `Array.isArray(customers... invoices.data[0].lines) && invoices.data[0].lines.length >= 1`. This still only inspects the first row of each entity's first page (unchanged from TEID-98), now checking two more structural properties.

## Implementation guidance per test

### TEID-98.1-T1
Extend the mock connector's fixture-mapping test (or add alongside TEID-98-T1's existing fixture) with an invoice carrying two `ConnectorInvoiceLine`-shaped raw rows and at least one extra fixture key not destructured into any named field (e.g. `billing_reason: "subscription_cycle"`). Assert the mapped `ConnectorInvoice.lines` array has exactly 2 entries with correct `amount`/`unit_amount` as decimal strings, and assert `passthrough.billing_reason === "subscription_cycle"` on the mapped invoice (and, separately, on at least one other entity type, to prove this isn't invoice-specific). Assert every money field touched (`amount`, `unit_amount`, `subtotal`, `tax` if present) is `typeof "string"`.

### TEID-98.1-T2
Call `currencyMinorDigits`/`decimalAmount` (or the full `mapConnectorPrice`/`mapConnectorInvoice` path, whichever the actual diff makes directly testable) with three fixture rows: `{unit_amount: 100, currency: "jpy"}` -> `"100"`; `{unit_amount: 1001, currency: "usd"}` -> `"10.01"`; `{unit_amount: 1234, currency: "kwd"}` -> `"1.234"`. Assert exact string equality for all three (not a numeric comparison), and assert the currency code on the mapped result is uppercased regardless of input case, matching the existing convention.

### TEID-98.1-T3
Start a sync (`startSync`), call `completeSync` with `status: "succeeded"` and a watermark for at least 2 entity types (e.g. `{customers: {since: "2026-09-01T00:00:00Z", cursor: null}, invoices: {since: "2026-09-01T00:00:00Z", cursor: "500"}}`). Query `connectors.cursor_high_water` directly and assert it matches. Start a second sync on the same connector, call `completeSync` with `status: "failed"` and a *different* watermark value (to prove it's genuinely ignored, not coincidentally unchanged). Query `cursor_high_water` again and assert it still matches the *first* (successful) sync's watermark, unchanged by the second (failed) one.

### TEID-98.1-T4
Using the existing `billingSession()`-style helper plus a new `supportSession()` (or reuse one if `tests/connectors` already has access to one via a shared helper), call `GET /connectors/sync-health` as Support and assert `403`; call it as Billing Admin and assert `200`.

### TEID-98.1-T5
Run the existing `tests/connectors/connectors.test.ts` file (TEID-98's own 8 tests) unmodified except for T1's own expected-object literals, which must be updated to include the new `passthrough`/`external_updated_at` (and, for invoices, `lines`/`number`/`period_start`/`period_end`/`subtotal`/`tax`) fields now present on every mapped entity -- every existing decimal-string assertion in T1 stays exactly as strict as before. Assert T5 (the 500,000-record streaming test) is present, unmodified in scale, and still passes.

### TEID-98.1-T6
Insert a `connectors` row (`tenant_id`, `connector_type = 'stripe'`, `display_name = 'Dup Test'`). Attempt to insert a second row with the identical `(tenant_id, connector_type, display_name)` triple. Assert the database itself rejects it (a raw `23505` unique-violation, caught and surfaced as whatever HTTP-level error this codebase's existing convention uses for a DB constraint violation on an insert -- check an existing similar-shaped insert route, e.g. `webhook-endpoints`, for the established pattern), not merely an application-level pre-check that could be bypassed by a second, concurrent insert.

## File layout

- `db/migrations/20260930120000_connector_watermarks.sql` -- new column, new constraint, doc comments.
- `services/ts-console/src/lib/connectors/types.ts` (extend) -- `passthrough`/`external_updated_at` on all seven types, `ConnectorInvoiceLine`, extended `ConnectorInvoice`/`ConnectorPrice`/`ConnectorPayment`/`ConnectorRefund`.
- `services/ts-console/src/lib/connectors/mockConnector.ts` (extend) -- `currencyMinorDigits`, currency-aware `decimalAmount`, passthrough collection, invoice-line fixture mapping.
- `services/ts-console/src/lib/connectors/syncHealth.ts` (extend) -- `completeSync`'s watermark parameter and merge, `getSyncHealth`'s `cursor_high_water` field, `error_message` truncation.
- `services/ts-console/src/routes/connectors.ts` (extend, only if the response shape needs an explicit field list rather than passing the extended row through implicitly) -- `cursor_high_water` in the sync-health response.
- `docs/api/connectors.md` (extend) -- document `cursor_high_water` in the sync-health response shape.
- `specs/TEID-98.md` (extend) -- a "TEID-98.1 amendments" section at the bottom, not a rewrite.
- `NOTES-TEID-98.md` (extend) -- append TEID-98.1 notes below the existing TEID-98 notes.
- Tests: extend `tests/connectors/connectors.test.ts` and `tests/connectors/contractSuite.ts` in place -- no second test package, per the source prompt's own explicit instruction.

## Definition of done

- [ ] Every acceptance criterion above is satisfied by working code.
- [ ] Every cataloged test (TEID-98.1-T1 through T6) has a real automated test that passes.
- [ ] The new migration applies cleanly on a database rebuilt from committed migrations only (including TEID-98's own migration, unmodified).
- [ ] `tsc --noEmit` is clean in both `services/ts-console` and `tests/connectors`.
- [ ] `tests/connectors`' full suite -- TEID-98's original 8 plus TEID-98.1's new 6 -- passes, including the unmodified-scale T5.
- [ ] `tests/stripe-connect`, `tests/cross-tenant`, `tests/rbac`, `tests/console-auth` remain unbroken (this story never touches `stripeConnect.ts`, `stripe_connections`, or any route those suites exercise).
- [ ] `docs/api/connectors.md` documents `cursor_high_water`; `tests/docs/coverage.test.ts` still passes (no new route is added, so no new coverage gap is possible, but confirm regardless).
- [ ] PR description maps each TEID-98.1-T* to the file/line that covers it.
