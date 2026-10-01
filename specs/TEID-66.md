<!--
Scope note, read before anything else: this spec deliberately redefines
and narrows the live board's TEID-66 ("Independent usage feed" -- SDK
dual-write/warehouse import/webhook mirroring of raw usage events). Per
explicit 2026-10-01 user direction, the actual next build is the leaner
slice below, which maps much more closely to
docs/proposals/teideal-new-epics-2026-09-30.md's unincorporated TEID-V1
("Re-rate and match a billing period"), specifically its "biller side"
half. The board's original TEID-66 (independent usage ingestion) is
explicitly NOT in scope here or soon -- this story reuses usage_events
(TEID-3) as-is, and reads the billed side from TEID-65's existing
connector_records rather than building a second ingestion pipeline.
The key is kept as TEID-66 because that's what the user asked for by
name; the live board's own TEID-66 entry should be revisited/reconciled
separately, not silently treated as satisfied by this story.
-->

# TEID-66: Map billed Stripe data to a comparable contract shape

| | |
|---|---|
| Epic | TEID-11 (E11 -- Implement Teideal Verify independent revenue verification) |
| Phase | E11 -- Implement Teideal Verify independent revenue verification |
| Priority | Highest |
| Points | 5 |
| Release | mvp |
| Order | 66 (within E11, directly after TEID-65/65.1) |
| Depends on | TEID-65 (`connector_records` landing table) and TEID-65.1 (complete, current invoice lines -- this story is worthless against truncated or stale data, which is exactly why 65.1 comes first). |

## Story

> As the Verify discrepancy engine (TEID-68), I want Stripe's raw billing records turned into typed, queryable facts keyed by customer, price, and period, so that comparing "what was billed" against "what should have been billed" is a structured join, not ad hoc JSONB parsing.

Not on the live board under this description -- a deliberately scoped-down pre-step for TEID-68, per 2026-10-01 user direction ("map Stripe invoices/subscriptions to your contract (customer + price + period). Read from connector_records. No rating yet.").

## Acceptance criteria

1. Every Stripe invoice line in `connector_records` (entity_type='invoice') is turned into one `verify_billed_lines` row carrying the Teideal customer id (not Stripe's), the price id, the line's period bounds, quantity, and amount as a decimal string.
2. A Stripe customer with no resolvable Teideal customer mapping is excluded from `verify_billed_lines` and listed separately as unmapped, never silently dropped or guessed.
3. Re-running the mapping for the same `connector_records` snapshot is idempotent -- no duplicate `verify_billed_lines` rows, and a later-synced update to an invoice (e.g. after TEID-65.1 lands) replaces the prior mapped row rather than appending a second one.
4. This story computes nothing -- no rate comparison, no expected amount, no discrepancy. It only produces the structured "billed" side TEID-68 will read.

## Cataloged tests

| ID | Type | AC | Title |
|---|---|---|---|
| TEID-66-T1 | Functional | 1 | Seed `connector_records` with a Stripe invoice carrying 2 lines (different prices, same period) for a customer already linked via `stripe_customer_links`. Run the mapper and confirm exactly 2 `verify_billed_lines` rows, each with the correct Teideal `customer_id`, `price_id`, `period_start`/`period_end`, `quantity`, and `amount`. |
| TEID-66-T2 | Functional | 1 | Seed a subscription (`entity_type='contract'`) and confirm its `price_id` cross-references cleanly against `verify_billed_lines` rows derived from invoices under that same subscription (i.e. the mapping is consistent whether read from the invoice line or the subscription, not two disagreeing sources). |
| TEID-66-T3 | Functional | 2 | Seed a Stripe invoice for a Stripe customer id with no row in `stripe_customer_links`. Run the mapper and confirm zero `verify_billed_lines` rows for that invoice, and that the customer appears in the unmapped list with the raw Stripe customer id and name. |
| TEID-66-T4 | Functional | 3 | Run the mapper twice against an unchanged `connector_records` snapshot and confirm `verify_billed_lines`'s row count and content are identical after the second run (no duplicates). |
| TEID-66-T5 | Functional | 3 | Mutate a `connector_records` invoice row (simulating TEID-65.1's incremental update landing a status change) and re-run the mapper; confirm the corresponding `verify_billed_lines` row reflects the new data, not a second stale-plus-new pair. |
| TEID-66-T6 | Non-functional | 1 | Run the mapper against 50,000 pre-seeded invoice lines across 500 customers and confirm it completes within a documented CI-scoped budget (`VERIFY_MAPPING_SCALE_BUDGET_MS`, following this codebase's established scale-test convention). |
| TEID-66-T7 | Adversarial | 1 | Seed an invoice line whose `price_id` references a price not present in `connector_records` at all (a real-world gap: the price was deleted/archived in Stripe after the invoice was issued). Confirm the mapper still produces the `verify_billed_lines` row (quantity/amount/period are on the line itself, independent of the price record existing) rather than dropping it, with `price_id` preserved as-is for later joins to resolve or fail gracefully. |
| TEID-66-T8 | Adversarial | 2 | Seed two different Stripe customer ids that both map to the same Teideal customer (a real scenario: a customer reconnected Stripe and got a new Stripe customer id, both still referenced across different invoices). Confirm both contribute `verify_billed_lines` rows under the one correct Teideal `customer_id`, not treated as two separate customers. |

## Scoping notes

- **Customer identity resolution reuses TEID-38's existing `stripe_customer_links` table** (`customer_id <-> stripe_customer_id`), not a new matching system. TEID-65's connector records store the raw Stripe customer id only; this story is the first to need the Stripe-id-to-Teideal-id resolution for Verify's own purposes, so it reads (never writes) that existing table. A Stripe customer id with no link row is unmapped (AC2) -- this story does not attempt fuzzy/email-based matching itself, since that's TEID-38's own job and duplicating it here would create two disagreeing identity-resolution paths.
- **"Price" here means `connector_records`' own `price` entity id** (`ConnectorPrice.id`, the Stripe price id), carried through unresolved -- this story does not map a Stripe price to a Teideal `plans`/`plan_rates` row. That mapping (if ever needed) is TEID-67's job (capturing contract terms for re-rating), explicitly out of scope here.
- **Idempotency (AC3)** is a straightforward upsert: `verify_billed_lines` keyed on `(tenant_id, stripe_invoice_line_id)` with `ON CONFLICT DO UPDATE`, mirroring the exact pattern TEID-65's own `connector_records` upsert already uses.
- **Money stays a decimal string throughout** -- `ConnectorInvoiceLine.amount`/`quantity` are already decimal strings per TEID-65's established convention; this story never converts either to a JS/Go number.

## Architecture and design

**New table**, `db/migrations/<timestamp>_verify_billed_lines.sql`, owned by ts-console (this is a Verify-specific derived read model, not raw connector data):

```sql
CREATE TABLE verify_billed_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id),
  connector_id UUID NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  stripe_invoice_line_id TEXT NOT NULL,
  price_id TEXT NOT NULL,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  quantity NUMERIC NOT NULL,
  amount NUMERIC NOT NULL,
  currency TEXT NOT NULL,
  mapped_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, stripe_invoice_line_id)
);
-- RLS: tenant_isolation_verify_billed_lines, same shape as every other
-- tenant-scoped table. GRANT SELECT, INSERT, UPDATE ON verify_billed_lines
-- TO teideal_app; -- do not repeat TEID-51's missing-grant mistake.

CREATE TABLE verify_unmapped_customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connector_id UUID NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  stripe_customer_id TEXT NOT NULL,
  stripe_customer_name TEXT,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, connector_id, stripe_customer_id)
);
-- Same RLS/GRANT pattern.
```

**Mapping function** (`services/ts-console/src/lib/verify/billedLineMapper.ts`): reads `connector_records` where `entity_type='invoice'`, extracts each `data->'lines'` array entry, resolves the Stripe customer id (the invoice's `customer_id` field) via `stripe_customer_links`, and upserts into `verify_billed_lines` on a hit or `verify_unmapped_customers` on a miss. Run on-demand (`POST /verify/map-billed-lines` or similar, role-gated like every other Verify-adjacent route) rather than as a background tick for this first story -- TEID-68 will decide whether this needs to run automatically after every sync once the full pipeline exists end to end.

## Implementation guidance per test

See the Cataloged tests table -- each row states setup/action/assertion concretely enough to implement directly against the schema and mapping function above.

## File layout

- `db/migrations/<timestamp>_verify_billed_lines.sql`
- `services/ts-console/src/lib/verify/billedLineMapper.ts`
- `services/ts-console/src/routes/verify.ts` (new, or extend if TEID-68 also lands here -- architect's call at implementation time based on how TEID-68 shapes up)
- `tests/verify/billed-line-mapping.test.ts` (new directory, matching this project's per-story-area convention)
- `docs/api/verify.md`

## Definition of done

- [ ] Every acceptance criterion above is satisfied by working code.
- [ ] Every cataloged test has a real automated test that passes.
- [ ] `tsc --noEmit` clean.
- [ ] The suite passes against a database rebuilt from scratch using only committed migration/seed scripts.
- [ ] PR description includes a checklist mapping each test ID to the file/line that covers it.
