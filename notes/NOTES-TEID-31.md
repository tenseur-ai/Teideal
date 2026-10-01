# TEID-31 implementation notes

The checked-in spec is complete enough to implement the story, but three
PostgreSQL details required conservative additions around its pseudocode.
The existing `usage_events` `UNIQUE (tenant_id, idempotency_key)` constraint
has not been moved, dropped, or altered.

## Recovering from the expected `23505`

PostgreSQL marks a transaction failed after a uniqueness violation. A query
issued immediately afterward in that transaction returns `25P02`, so the
specified `resolveIdempotencyConflict` call cannot run unless the failed
statement is first rolled back to a savepoint. Each usage insert is therefore
wrapped in a savepoint. Only a `23505` is rolled back to that savepoint and
classified; the uniqueness constraint remains the sole duplicate detector.

## Runtime permission for the narrow expired-row deletion

The existing runtime grant on `usage_events` is `SELECT, INSERT`, while the
specified expiry path calls `DELETE FROM usage_events WHERE id = $1`. The new
migration grants `DELETE` to `teideal_app`. RLS remains forced, and application
code still issues a primary-key deletion only after the tenant-visible row has
been classified as at least 372 days old.

## Conflict foreign key versus expired-key reuse

The spec declares `existing_usage_event_id` as a foreign key with the default
`NO ACTION`, declares conflict rows append-only, and also requires the
referenced usage row to be deleted when its key is reused after 372 days. If a
key had ever produced a content conflict, those requirements cannot all hold:
the foreign key would reject the required expiry deletion, and retaining the
conflict row would leave a dangling reference.

The migration uses `ON DELETE CASCADE` on that foreign key. This preserves
referential integrity and prioritizes the explicit key-reuse behavior. The
cascade can occur only as a consequence of the narrowly authorized expired-key
deletion; there is no endpoint or application query that updates or directly
deletes review records.

## Direct-database fixture precedent

The spec points to `tests/billing-periods` for a direct-database fixture helper,
but that directory currently has no database helper or direct SQL setup. The
new `tests/idempotency/db.ts` and `fixtures.ts` instead follow the repository's
existing superuser-fixture pattern used by suites such as `large-quantities`
and `data-export`. This is necessary to set `created_at`, which the runtime role
cannot update.
