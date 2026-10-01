# TEID-65.1: Stripe ingest completeness (TEID-65 follow-up)

| | |
|---|---|
| Epic | TEID-11 (E11 -- Implement Teideal Verify independent revenue verification) |
| Phase | E11 -- Implement Teideal Verify independent revenue verification |
| Priority | Highest (blocks TEID-68/Verify correctness) |
| Points | 5 |
| Release | mvp |
| Order | 65.1 (directly follows TEID-65, before TEID-66) |
| Depends on | TEID-65 (merged, PR #65, `953e459`) -- this story only touches what TEID-65 built. |

## Story

> As a Teideal Verify user, I want the Stripe connector's landing data to be complete and current, so that Verify's discrepancy checks (TEID-68) aren't comparing against an incomplete or stale copy of Stripe's billing data.

Not on the live board as its own story -- this is a review-driven correctness follow-up to TEID-65, raised by an independent review (Grok) of the merged PR. The full review is preserved at `specs/TEID-65.1-Claude-Prompt.md`; this spec restates it in this project's standard format and is the authoritative contract for the implementer. Where the two differ, this spec and the review document agree in substance -- consult the review document for additional rationale/examples if anything here is ambiguous.

## Acceptance criteria

1. An invoice with more line items than Stripe's single `/v1/invoices` list response embeds has **all** of its lines persisted in `connector_records`, not just the first page.
2. After a connector's `backfill_completed_at` is set, an invoice/credit note/charge/refund that changes after its creation (status change, new line, voided, refunded) is reflected in `connector_records` on the next incremental tick -- not only brand-new objects.
3. `DELETE /connectors/:id` for a `connector_type='stripe'` connector stops that connector's own sync activity without deauthorizing the underlying Stripe Connect OAuth connection (`stripe_connections`) that TEID-37/TEID-38/TEID-39 also depend on.
4. A tiered Stripe price (`unit_amount: null`) does not crash the sync; it's mapped to a defined, non-throwing value.

## Cataloged tests

| ID | Type | AC | Title |
|---|---|---|---|
| TEID-65.1-T1 | Functional | 1 | Seed a fake-Stripe invoice whose `lines` response has `has_more: true` and only 1 of 3 real lines. Run a sync and confirm `connector_records` for that invoice has all 3 lines, fetched via `/v1/invoices/{id}/lines` pagination. |
| TEID-65.1-T2 | Functional | 2 | After `backfill_completed_at` is set, change an already-synced invoice's status to `paid` and add a line in the fake Stripe server. Run `incrementalTick` and confirm the stored record picks up the new status and the new line. A `created[gte]`-only implementation must fail this test. |
| TEID-65.1-T3 | Functional | 3 | Call `DELETE /connectors/:id` on a connected Stripe connector. Confirm the `connectors` row is `disconnected` but the underlying `stripe_connections` row is still `connected` and its access token still decrypts. |
| TEID-65.1-T4 | Functional | 1,2 | Re-run TEID-65's own `no-write-guard.test.ts` (T8) and the write-scope-rejection test (T2) and confirm both still pass unchanged -- this story adds no write capability and no new connection path. |
| TEID-65.1-T5 | Regression | - | TEID-65's own T1-T9 all still pass. If this story's cutoff-math changes affect T4's timing assumptions, adjust the test's setup only -- do not weaken the 24-month backfill-window exclusion itself. |
| TEID-65.1-T6 | Adversarial | 4 | Seed a tiered price (`unit_amount: null`) in fake Stripe. Run a sync and confirm it does not throw, and the stored record has a defined `amount` (e.g. `"0"`) with the original price object preserved in `passthrough`. |

## Scoping notes

- **Files you may touch** (from the originating review, binding here too): `stripeBillingConnector.ts`, `syncWorker.ts` (incremental `since` semantics only), `syncHealth.ts` (only if the watermark shape needs an `events` key), `routes/connectors.ts` (the `DELETE` handler), `docs/api/connectors.md`, `tests/connectors/**` (extend, don't fork a second package), `tests/stripe-connect/fake-stripe.ts` (only to add paginated invoice lines / `/v1/events`), and a new migration **only if** a column is actually needed (prefer none). Do not touch `stripeConnect.ts`'s crypto, TEID-38's customer matcher, `go-usage`, or any Metronome/Orb/Lago code -- none of that exists yet and none of it is in scope.
- **AC2's incremental-update mechanism: implement Option A from the review (Stripe Events), not Option B.** `GET /v1/events` with `type[]` filtered to `invoice.updated`, `invoice.finalized`, `invoice.paid`, `invoice.voided`, `charge.refunded`, `credit_note.created` (document the exact set used in `notes/NOTES-TEID-65.md`), watermarked the same way every other entity already is (`since`/`cursor`, `advanceWatermark` per page). For each event, GET the referenced object and upsert that one record (full paginated lines for an invoice). Backfill itself is unchanged -- still `created[gte]` across all seven entity lists for the first 24 months; only the **incremental** path after backfill completes gains this events-based mechanism for invoices/credit notes/charges/refunds. Customers/prices/subscriptions may keep `created[gte]` for incremental (document that known gap -- updates to old prices/subscriptions aren't caught -- rather than silently leaving it unstated).
- **AC3's fix is narrow and specific**: the `DELETE /connectors/:id` handler currently (TEID-65) calls `stripeConnect.ts`'s `deauthorize()` for any `connector_type='stripe'` row, which revokes the OAuth token at Stripe -- but that same `stripe_connections` row is shared with TEID-37/38/39's own Stripe integration, so disconnecting *Verify's read-only connector* currently kills the *customer's* live Stripe Connect integration too. Fix: unregistering a connector sets `connectors.status='disconnected'` (stopping its own scheduled ticks, already filtered on `status='connected'`) and does **not** touch `stripe_connections` or call `deauthorize()` at all. If a real "revoke this Stripe connection" capability is wanted, that's TEID-37's own existing disconnect path (unchanged) -- do not add a second revoke mechanism in this story.
- **AC1's pagination**: request `/v1/invoices` with `expand[]=data.lines` (keep the existing `limit`/cursor params), and when the embedded `lines.has_more` is `true`, page `/v1/invoices/{invoice_id}/lines` with `starting_after` until exhausted, concatenating in order through the existing `mapConnectorInvoice`/`invoiceWithEmbeddedLines` path. Only do this extra fetch for invoices actually being persisted (no speculative N+1 fetching).
- **AC4**: `ConnectorPrice.amount` is not extended in this story -- a tiered price's `unit_amount: null` maps to `"0"` (a decimal string, never a JS number), with the real tiering details already available via `passthrough` (the original Stripe price object survives there untouched, per TEID-65's existing `passthrough` convention).
- This prompt deliberately does not touch discrepancy classification, usage-feed matching, Metronome/Orb/Lago, or any console UI -- those remain TEID-66/68's own scope, unaffected by this story.

## Architecture and design

No new tables expected (the review explicitly prefers no migration; only add one if a column genuinely can't be avoided). `cursor_high_water`'s existing JSONB shape (`{entity: {since, cursor}}`) gains an optional `events` key for the new events-based incremental watermark -- same shape, same `advanceWatermark` mechanism TEID-65 already built, no schema change needed since it's JSONB.

`stripeBillingConnector.ts` gains: a line-pagination helper for invoices, an `listEvents`-style method (or an internal helper used only by `syncWorker.ts`'s incremental path, not exposed as a new `Connector` interface method unless that's the cleanest fit -- implementer's call, but keep the `Connector` interface's existing GET-only contract intact either way).

`routes/connectors.ts`'s `DELETE /connectors/:id` handler: remove the `deauthorize()` call and the `stripe_connections` status mutation for the Stripe case; everything else (role gate, response shape) unchanged.

## Implementation guidance per test

See the Cataloged tests table above -- each row states setup/action/assertion concretely enough to implement directly. `specs/TEID-65.1-Claude-Prompt.md` (the originating review) has additional worked detail per item if anything here needs more context.

## File layout

Per "Files you may touch" in Scoping notes above -- no new top-level directories, this extends TEID-65's existing files in place.

## Definition of done

- [ ] Every acceptance criterion above is satisfied by working code.
- [ ] Every cataloged test has a real automated test that passes.
- [ ] `tsc --noEmit` clean in `services/ts-console` and `tests/connectors`.
- [ ] `tests/connectors` green including TEID-65.1-T1-T6 and all of TEID-65/98.x's prior tests, unchanged.
- [ ] `tests/stripe-connect` green, with the same `STRIPE_TOKEN_ENCRYPTION_KEY` passed to both the server process and the test runner (see `notes/feedback_stripe_key_consistency` precedent from this project's own history -- do not reintroduce that exact mismatch).
- [ ] `docs/api/connectors.md` no longer claims `DELETE` revokes the Stripe OAuth connection.
- [ ] PR description maps each TEID-65.1-T* to the file/line that covers it.
- [ ] Do not start TEID-66 in this PR -- this story only.
