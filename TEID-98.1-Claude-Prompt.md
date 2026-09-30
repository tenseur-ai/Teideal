# TEID-98.1 — Prompt for Claude

Use this as the implementation prompt in Claude Code against `tenseur-ai/Teideal` `main` (PR #59 / `50cdc686`).

---

You are implementing TEID-98.1 — Connector landing-zone follow-up — on tenseur-ai/Teideal.

Do not reopen TEID-98. Do not implement TEID-65 (no live Stripe API, no OAuth, no Metronome/Orb/Lago).
Do not modify stripeConnect.ts, stripe_connections, or existing Stripe Connect routes.
Do not convert connector money fields to JS number. Keep decimal strings.

## Why

PR #59 shipped the HTTP/sync framework. Independent review: the common model and sync tables cannot support Verify (TEID-65/68) without a second schema. Fix the landing zone now.

## Files you may touch

- `specs/TEID-98.md` (add a "TEID-98.1 amendments" section at the bottom; do not rewrite the original story)
- `NOTES-TEID-98.md` (append 98.1 notes)
- New: `specs/TEID-98.1.md` (short spec in the same template as other specs)
- `db/migrations/` — new migration only, timestamp after `20260930110000_connectors.sql`
- `services/ts-console/src/lib/connectors/types.ts`
- `services/ts-console/src/lib/connectors/connector.ts` (only if needed for types)
- `services/ts-console/src/lib/connectors/mockConnector.ts`
- `services/ts-console/src/lib/connectors/syncHealth.ts`
- `services/ts-console/src/routes/connectors.ts` — only if health payload gains watermark/error cap fields
- `docs/api/connectors.md`
- `tests/connectors/**` (extend existing suite; do not invent a second test package)

Forbidden: `services/ts-console/src/lib/stripeConnect.ts`, stripe customer routes, go-usage rating, `internal/rating` if it exists.

## Work items (all required)

### 1. Common model — stop pretending seven skinny fields are "no field loss"

Update `types.ts`.

On every entity (Customer, Price, Contract, Invoice, Credit, Payment, Refund):

- keep existing fields
- add `external_updated_at: string | null` (ISO)
- add `passthrough: Record<string, unknown>` (fields we do not normalize)

Add invoice lines:

```ts
export interface ConnectorInvoiceLine {
  id: string;
  invoice_id: string;
  price_id: string | null;
  description: string | null;
  quantity: string;       // decimal string
  unit_amount: string;    // decimal string, major units
  amount: string;         // decimal string line total
  currency: string;
  period_start: string | null;
  period_end: string | null;
  passthrough: Record<string, unknown>;
}

export interface ConnectorInvoice {
  // existing fields...
  number: string | null;
  period_start: string | null;
  period_end: string | null;
  subtotal: string | null;
  tax: string | null;
  lines: ConnectorInvoiceLine[];
  external_updated_at: string | null;
  passthrough: Record<string, unknown>;
}
```

Price: add `interval: string | null`; `product_id: string | null`; `nickname: string | null`.
Payment: add `processor_charge_id: string | null`.
Refund: add `processor_refund_id: string | null`.

`MockConnector` must populate these from Stripe-shaped fixtures without dropping unknown keys into `passthrough`.
T1-style fixture must include at least one invoice with two lines and a passthrough key that is not a first-class field (e.g. `billing_reason`).

### 2. Currency-aware minor units

Today `decimalAmount` always divides integer minor units by 100. That is wrong for JPY (0) and KWD (3).

Implement `currencyMinorDigits(currency: string): number`

- default 2
- 0: JPY, KRW, VND (and a small explicit set; document the set)
- 3: KWD, BHD, OMR, JOD
- Unknown currency → 2, do not throw.

`decimalAmount(value, currency)` uses that scale with string arithmetic only.
Add tests: 100 JPY → `"100"`; 1001 USD → `"10.01"`; 1234 KWD → `"1.234"`.
Do not use `Number` for the conversion.

### 3. Persist sync watermarks

New migration:

- `connectors.cursor_high_water JSONB NOT NULL DEFAULT '{}'::jsonb`
- optional comment: map of entity name → `{ since: string | null, cursor: string | null }`

Extend `syncHealth.ts`:

- `startSync` unchanged
- `completeSync` accepts optional `watermark: Record<string, { since: string | null; cursor: string | null }>`
  - On success, merge into `connectors.cursor_high_water` in the SAME transaction as `consecutive_failures`.
  - On failure, do not advance the watermark.
- `getSyncHealth` includes `cursor_high_water` on each row.

`GET /connectors/sync-health` response adds `cursor_high_water`. Document it.
Test: successful sync writes watermark; failed sync leaves previous watermark.

### 4. Write the Stripe token rule (spec + comment only — no data migration)

In `specs/TEID-98.1.md` and a short comment on the connectors table / `credentials.ts`:

> TEID-37 Stripe Connect OAuth tokens remain in `stripe_connections` encrypted with `STRIPE_TOKEN_ENCRYPTION_KEY`.
> Verify Stripe (TEID-65) MUST read credentials from `stripe_connections` and MUST only insert/update `connectors` + `connector_syncs` for health/watermarks.
> Do not copy OAuth refresh tokens into `connectors.credential_*`.
> `connectors.credential_*` is for API-key connectors (`csv_mock` now; Metronome/Orb/Lago later), not for Stripe Connect.

No code path that writes Stripe OAuth material into `connectors`.

### 5. Small hygiene

- Do **not** add `UNIQUE (tenant_id, connector_type)` — a tenant may have multiple Stripe accounts later.
- Do add `UNIQUE (tenant_id, connector_type, display_name)` so T4 still works and accidental dup names fail.
- Cap `connector_syncs.error_message` at 500 chars in `completeSync` (slice before write).
- Health endpoint must still omit raw `error_message` (keep current shape + watermark only).
- `tests/connectors` CI: use `npm ci` if `package-lock.json` is committed; do not switch package managers.
- Add Support-role 403 on `GET /connectors/sync-health` (one test).
- Contract suite mapping check must assert `lines[]` on invoices and `passthrough` present (object) on all seven types. Still only needs first row, but first invoice row must have `lines.length >= 1`.

## Tests to add or extend (catalog)

| ID | Requirement |
|---|---|
| TEID-98.1-T1 | Invoice with two lines + `passthrough.billing_reason` round-trips; money stays string. |
| TEID-98.1-T2 | JPY/USD/KWD minor-unit conversion as above. |
| TEID-98.1-T3 | `completeSync` success persists watermark; failure does not. |
| TEID-98.1-T4 | Support session gets 403 on `/connectors/sync-health`; Billing Admin 200. |
| TEID-98.1-T5 | Existing TEID-98-T1 through T8 still pass. If T1 assertions need new fields, update expected objects; do not weaken decimal-string checks. |
| TEID-98.1-T6 | Duplicate `(tenant_id, connector_type, display_name)` insert is rejected. |

## Definition of done

- New migration applies on a DB rebuilt from committed migrations only.
- `tsc --noEmit` clean in `services/ts-console` and `tests/connectors`.
- `tests/connectors` all green including T5 500k if it still exists; do not delete T5.
- `tests/stripe-connect`, `tests/cross-tenant`, `tests/rbac`, `tests/console-auth` not broken by this change (you did not touch those surfaces).
- PR against the current integration branch used for agent work (not a drive-by rewrite of main history).
- PR body maps each TEID-98.1-T* to file/line.
- Branch name: `claude/teid-98.1-landing-zone` (or `codex/teid-98.1-landing-zone` if Codex implements).

## Implementation rules

- Follow existing ts-console patterns: `withTenant`, `consoleRoute`, `roleGuard`.
- No floating point for money.
- No generic `POST /connectors`.
- No second rating function.
- If the spec and this prompt conflict, this prompt wins and you note the conflict in `NOTES-TEID-98.md`.
- Stop when tests listed above pass. Do not start TEID-65.
