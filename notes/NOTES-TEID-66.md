# TEID-66 implementation notes

The production implementation follows the story's narrowed billed-side scope:
it reads `connector_records` and `stripe_customer_links`, writes only the two
new Verify tables, and performs no usage ingestion, price-plan mapping, rating,
or discrepancy calculation.

## Contract/model gaps resolved conservatively

- TEID-66-T2 describes a subscription/contract `price_id`, but TEID-65's
  `ConnectorContract` has no typed `price_id`; Stripe subscription details are
  retained only in `passthrough`. The test seeds that landed shape and compares
  its passthrough price reference with the invoice line's typed `price_id`. The
  mapper does not introduce a second source of truth or implement TEID-67.
- TEID-66-T5 uses an invoice status change as its example, but the exact
  `verify_billed_lines` schema contains no invoice status column. The test
  changes both the raw invoice status and its line amount, then proves the
  billed row was updated in place through the observable typed field.
- TEID-66-T8 asks for two Stripe customer IDs concurrently linked to one
  Teideal customer. TEID-38's required, read-only `stripe_customer_links`
  schema has `UNIQUE (customer_id)`, so that database state cannot be seeded.
  The test represents the stated reconnection scenario longitudinally: map an
  invoice under the old link, move the existing TEID-38 link to the new Stripe
  ID as test setup, then map the new invoice and confirm both billed facts use
  the same Teideal customer. The architecture specifies upserts, not deletion
  or re-reconciliation of previously derived rows, so the old mapped fact is
  retained. Production mapper code never writes the link.
- TEID-65 permits nullable invoice-line `price_id` and period bounds, while the
  exact TEID-66 target schema makes all three fields `NOT NULL`. No fallback or
  guessed values were invented. Such an inconsistent landed record fails the
  mapping transaction and surfaces as a server error; resolving or explicitly
  quarantining that upstream shape needs a separate contract decision.
- TEID-38 permits one Stripe customer ID to be linked to multiple Teideal
  customers (the reverse side is intentionally non-unique). Selecting one
  would be guessing, so the mapper treats a non-unique Stripe-ID lookup as
  unresolved and records it in `verify_unmapped_customers`.
- The architecture calls the unmapped write an upsert and gives the table a
  mutable-looking `last_seen_at`, but its exact required grant is only
  `SELECT, INSERT`. `ON CONFLICT DO UPDATE` would therefore fail for the
  application role. The mapper uses `ON CONFLICT DO NOTHING`: it idempotently
  records the first observation without expanding the mandated privilege set.
