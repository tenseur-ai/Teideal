# TEID-34 implementation notes

Codex began this story and was cut off partway through by an early usage-window
reset; the architect (Claude) completed and independently tested it directly,
building on Codex's own partial work rather than discarding it.

## Batch ingestion never checked for a closed period

Codex's own partial implementation wired the closed-period check
(`writeUsage`) into `postUsageSingle` only. `POST /usage` also accepts a JSON
array body, handled by a separate function, `postUsageBatch`, which still
called `insertUsageEvent` unconditionally for every item -- AC1/AC3 were not
actually enforced for a batch submission, only a single one. This was caught
by running the existing `tests/billing-periods` regression suite (see below),
whose `TEID-96-T8` submits via the batch path specifically. Fixed by
extracting `writeUsage` to be shared by both `postUsageSingle` and
`postUsageBatch`, including the closed-period 23505-conflict branch (a
duplicate submission landing in `usage_adjustments` needs its own conflict
resolution, `resolveAdjustmentConflict`, mirroring the existing
`resolveIdempotencyConflict` the open-period path already used) -- and adding
a `queued_for_review` per-item batch result status alongside the existing
`created`/`duplicate`/`conflict`/`error` ones.

## `TEID-96`'s own fixture dates went stale

`tests/billing-periods/billing-periods.test.ts`'s `TEID-96-T1` and
`TEID-96-T8` post real events with hardcoded 2026 calendar dates. Those dates
are now in the past relative to real wall-clock time, so once the
closed-period check exists at all (in either ingestion path), both tests'
events are -- correctly, per this story's own AC1/AC3 -- assigned to a closed
period and queued instead of applied immediately, which broke both tests'
original assertions (expecting an immediate `201`). Neither test is actually
about period-closing behavior: `T1` verifies UTC-offset arithmetic
(`-05:00` converts correctly), `T8` verifies exact-instant month-boundary
idempotency, and both are date-value-independent as long as the calendar
*shape* (an offset conversion; a real month boundary) is preserved. Fixed by
moving both tests' hardcoded dates from 2026 to 2030 -- comfortably outside
any realistic run window -- with no other change to either test's logic or
assertions.

## Approval reuses the original idempotency key, not a derived one

The original `idempotency_key` is only ever written to `usage_adjustments`
while a submission is pending or auto-approved -- it is never written to
`usage_events` until (and unless) an operator approves it. Approving an
adjustment therefore reuses the exact original key for the resulting
`usage_events` insert; a resubmission of the same event after approval
correctly resolves against `usage_events`' own unique constraint as a true
duplicate, rather than needing a synthetic derived key.

## Reviewer identity comes from the API key's own creator

`go-usage`'s admin endpoints are authenticated by API key, not a console
session, and this story's `reviewed_by_user_id` needs a real user to
attribute a review action to. `internal/auth.Principal` gained a `UserID
*string` field, sourced from `api_keys.creator_user_id` (already a real
column, from TEID-92) -- nullable, since not every admin key is
user-attributed, but populated for any key that was.
