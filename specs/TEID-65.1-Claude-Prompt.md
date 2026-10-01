# TEID-65.1 — Prompt for Claude

Use this in Claude Code against `tenseur-ai/Teideal` `main` after merged PR #65.

This remedies the three Verify-blocking gaps in TEID-65. It is not TEID-66 or TEID-68. It is not a rewrite of the sync worker.

---

You are implementing TEID-65.1 — Stripe ingest completeness — on tenseur-ai/Teideal.

Do not implement discrepancy classification, usage-feed matching, Metronome/Orb/Lago, or a console UI.
Do not copy Stripe OAuth tokens into `connectors.credential_*`.
Do not convert money to JS `number`.
Do not weaken GET-only HTTP.
Do not delete T6 2-million-line-item coverage; keep it, but it must use **complete** lines, not a truncated Stripe `lines` page.

## Why

PR #65 shipped a real read connector and a crash-resumable worker. Independent review: three defects make the landing table unsafe for TEID-68.

1. Incremental sync filters Stripe with `created[gte]`. Invoices change after create (`paid`, new lines, tax). Those updates never land.
2. Invoice lines are whatever `/v1/invoices` embedded. Stripe truncates `lines`. Production invoices with more than one page of lines store an incomplete bill.
3. `DELETE /connectors/:id` deauthorizes the Connect OAuth connection. That token is also TEID-37. Unregistering Verify can kill customer Connect.

## Files you may touch

- `specs/TEID-65.1.md` (new, short)
- `notes/NOTES-TEID-65.md` (append 65.1)
- `services/ts-console/src/lib/connectors/stripeBillingConnector.ts`
- `services/ts-console/src/lib/connectors/syncWorker.ts` (incremental `since` semantics only if required)
- `services/ts-console/src/lib/connectors/syncHealth.ts` (only if watermark shape must record `mode`)
- `services/ts-console/src/routes/connectors.ts` (DELETE / unregister)
- `docs/api/connectors.md`
- `tests/connectors/**` (extend; do not create a second package)
- `tests/stripe-connect/fake-stripe.ts` **only** if the fake must emit paginated invoice lines / `updated` / events for the new tests
- New migration only if you add a column (prefer no migration)

Forbidden: `stripeConnect.ts` crypto, TEID-38 customer matcher, rating kernel, `go-usage` money types, Metronome.

## Work items (all required)

### 1. Complete invoice lines

`listInvoices` must persist **all** lines for each invoice.

Required behavior:

- Request `/v1/invoices` with `expand[]=data.lines` (and keep existing `limit` / cursor).
- If `lines.has_more` is true, page `/v1/invoices/{invoice_id}/lines` with `starting_after` until `has_more` is false.
- Concatenate pages in order. Do not drop a line because the list payload was truncated.
- Map through existing `mapConnectorInvoice` / `invoiceWithEmbeddedLines`. Money stays decimal strings.
- `connector_records.data` for `entity_type = 'invoice'` must contain `lines.length` equal to the full Stripe line set.

Do not fetch lines for invoices you are not persisting. Do not N+1 line fetches when `has_more` is false.

### 2. Incremental must see updates, not only new creates

Today every list uses `created[gte]=unix(since)`. That is correct for the **first 24-month backfill** only.

After `backfill_completed_at` is set:

- Customers, prices, subscriptions: Stripe list `created` is acceptable **if and only if** you also document the miss (updates to old prices). Prefer `created` for backfill and, for incremental invoices/credit notes/charges/refunds, do **not** use `created[gte]` alone.
- Invoices, credit notes, charges, refunds — pick **one** of these and implement it fully:

**Option A (preferred, smaller):** use Stripe’s `updated` / available date filters where the object supports them (`created` is wrong). For invoices, use Events:

- Incremental tick lists `GET /v1/events` with `type[]=invoice.updated`, `invoice.finalized`, `invoice.paid`, `invoice.voided`, `charge.refunded`, `credit_note.created` (keep the set documented in NOTES).
- `starting_after` / `created` on events uses the watermark `since`.
- For each event, GET the referenced object and upsert that one record (and full lines for invoices).

**Option B:** if Events are too large for this story, then for invoices only: incremental `listInvoices` must refetch any invoice whose `id` is already in `connector_records` when Stripe returns it on a list that is **not** create-filtered — still insufficient. Do not ship Option B unless you also add a daily “reconcile open invoices” pass that re-GETs every invoice with `status` in (`draft`,`open`) stored locally.

Implement **Option A**. If the fake Stripe in tests has no `/v1/events`, add the minimum list fixture there.

Watermark keys may add `events: { since, cursor }` without breaking existing entity keys. `advanceWatermark` per page still applies.

Backfill remains `created[gte]` from 24 months, all seven entity lists. Do not change backfill to Events.

### 3. Unregister ≠ deauthorize Connect

`DELETE /connectors/:id` for `connector_type = 'stripe'`:

- Set `connectors.status = 'disconnected'`.
- Stop scheduled ticks (already filtered on `status = 'connected'`).
- **Do not** call Stripe deauthorize / do not flip `stripe_connections` to disconnected.
- Response stays `{ id, status: "disconnected" }`.

Add `POST /connectors/:id/revoke-oauth` only if you already have a Connect revoke helper and can wire it in < 20 lines. Otherwise document “revoke remains TEID-37 Connect disconnect” in `docs/api/connectors.md` and do **not** add a second revoke API.

Update the docs that currently say DELETE deauthorizes Connect. That sentence is the bug.

### 4. Mapper hardness (small, required)

In `stripeBillingConnector.ts` (not by rewriting mock mappers globally):

- Price with `unit_amount: null` (tiered) must not throw. Persist `amount` as `"0"` or null **only if** you extend `ConnectorPrice.amount` — do **not** extend the type in this story. Use `"0"` plus `passthrough.billing_scheme` / original price object already in passthrough.
- Customer with null `name` already falls back to email/id — keep that.

### 5. Hygiene

- `DISABLE` nothing in CI.
- Do not hand-edit `package-lock.json` unless you add a dependency (you should not).
- Humanize errors still must not leak raw Stripe bodies on `/connectors/sync-health`.

## Tests catalog

| ID | Requirement |
|---|---|
| TEID-65.1-T1 | Fake invoice list embeds `lines.has_more: true` and only 1 of 3 lines. Connector persists **3** lines after follow-up `/v1/invoices/{id}/lines`. |
| TEID-65.1-T2 | After backfill complete, an existing invoice changes `status` to `paid` and gains a line. Incremental tick upserts the new status and full lines. A `created[gte]`-only implementation must fail this test. |
| TEID-65.1-T3 | `DELETE /connectors/:id` leaves `stripe_connections` connected; connector row is `disconnected`. A subsequent Connect helper that reads that connection still decrypts a token (or the row `status` is still connected). |
| TEID-65.1-T4 | Write-scoped register still 403. GET-only contract suite still passes for the Stripe billing connector. |
| TEID-65.1-T5 | Existing TEID-65 T1–T9 still pass. Adjust T4 timing only if 65.1 changes cutoff math; do not weaken 24-month exclusion. |
| TEID-65.1-T6 | Tiered price `unit_amount: null` syncs; tick does not throw. |

## Definition of done

- `tsc --noEmit` clean in `services/ts-console` and `tests/connectors`.
- `tests/connectors` green including 65.1 T1–T6 and prior 98.x / 65 tests.
- `tests/stripe-connect` green (same `STRIPE_TOKEN_ENCRYPTION_KEY` on server and vitest process).
- Docs for DELETE no longer claim OAuth revoke.
- PR against the current agent integration branch.
- Branch: `claude/teid-65.1-ingest` or `codex/teid-65.1-ingest`.
- PR body maps each TEID-65.1-T* to file/line.
- Stop. Do not start TEID-66 in this PR.

## Implementation rules

- This prompt wins over PR #65 docs if they conflict. Note conflicts in `notes/NOTES-TEID-65.md`.
- Option A for incremental. Not a comment saying “Events later.”
- No floating point for money.
- No generic Stripe API-key path.
- WIP: this story only.
