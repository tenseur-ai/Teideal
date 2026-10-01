# TEID-65.1 implementation notes

The story was implemented within the existing Stripe connector, sync worker, connector route, fake Stripe, and connector test package. No migration or new credential storage was needed.

Real gaps and ambiguities were resolved conservatively:

- `specs/TEID-65.1-Claude-Prompt.md` is absent from this branch's working tree even though the authoritative spec requires it to be read. The file remains available in Git object `c485460` and was read from there in full before implementation. No attempt was made to restore or edit the spec because story files are outside the requested implementation changes.
- The required event set has no general create event for invoices, charges, or refunds. Replacing TEID-65's created-based incremental lists would therefore regress new-object ingestion. The worker keeps those lists and adds Events as a second incremental pass; the affected entities are no longer synchronized by `created[gte]` alone.
- Stripe's `charge.refunded` event references a charge rather than a refund. The Events pass refreshes that referenced charge/payment record exactly as specified, while the retained `/v1/refunds?created[gte]` list continues to ingest newly created refund records.
- Events begin at `backfill_completed_at` when no `events` watermark exists. On successful exhaustion, the watermark advances to the event attempt's start, matching the existing overlap-safe `since` convention.
- Tiered prices are hardened only in `StripeBillingConnector`: a null `unit_amount` maps to the decimal string `"0"`, while the null sentinel and tier-specific fields remain in `passthrough`. The shared connector type and generic mock mapper were not widened.

The exact Events filter is also recorded in `notes/NOTES-TEID-65.md`, as required. Old price/subscription updates remain the explicitly documented known limitation.
