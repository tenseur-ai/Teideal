# TEID-50 implementation notes

The specification says both that the period-close migration must contain
exactly two new indexes and that an index on `usage_adjustments.period_start`
already exists from TEID-34. The checked-out migrations contain
`ledger_lines_transaction_id_idx`, but no index on `usage_adjustments`.

The implementation follows the narrower, explicit migration contract: it adds
only `usage_consumptions_tenant_occurred_idx` and
`grant_ledger_entries_tenant_occurred_idx`. The adjustment aggregate remains a
single set-based query filtered by `period_start`; no unrequested third index
or schema change was introduced.

AC2's Stripe comparison remains deferred to E11/Verify, as required by the
scoping notes. This implementation neither creates nor derives a Stripe-side
reconciliation figure. `usage_billed` and `adjustments` tie directly to the
double-entry revenue ledger; consumption and expiry figures remain separate
views of their own authoritative credit/grant ledgers, with no grand total
across the six displayed columns.

The T6 guidance expects approval of a late adjustment to have a corresponding
revenue-ledger post. TEID-34's real approval handler creates and links the
`usage_event`, but it does not price that event or post a ledger transaction.
TEID-50 remains a read-side story and does not add a new write pipeline. Its
T6 fixture therefore uses the real `/adjustments/{id}/approve` path, then
inserts the resulting event's balanced, effective-period ledger transaction
as the stand-in for the separate pricing/posting step. The production summary
still reads only authoritative ledger rows and never derives revenue from the
adjustment quantity.
