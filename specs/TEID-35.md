# TEID-35: Same result regardless of event order

| | |
|---|---|
| Epic | TEID-3 (E03 -- Build usage ingestion and exactly-once ledger) |
| Phase | E03 |
| Priority | High |
| Points | 5 |
| Release | mvp |
| Order | 19 (immediately after TEID-33) |
| Depends on | `grants`/`usage_consumptions`/`usage_consumption_lines` (TEID-17/18/19), `consumeAcrossGrants`/`lockEligibleGrants` (`services/ts-console/src/lib/consumptionOrder.ts`) |

## Story (verbatim from the live board)

> As a finance lead, I want balances to end up identical no matter what order events arrive in, so that network delays and retries never change what a customer pays.
>
> *Context*

## Acceptance criteria (verbatim from the live board)

1. Processing the same set of events in any order produces identical final balances and invoice totals.
2. An automated test replays a real-sized sample of events in at least 100 random orders and compares the results.
3. Where order genuinely matters (for example, the event that exhausts a commit), the event's timestamp decides, with a documented tie-break rule.

## Cataloged tests (verbatim from the live board)

| ID | Type | AC | Title |
|---|---|---|---|
| TEID-35-T1 | Functional | 1 | Feed the same 5,000 usage events through ingestion in three different arrival orders and confirm the resulting customer balance and invoice total are byte-identical each time. |
| TEID-35-T2 | Non-functional | 2 | Replay a 5,000-event sample in 100 randomly shuffled orders and confirm every replay produces an identical final balance, with no replay taking measurably longer due to reordering overhead. |
| TEID-35-T3 | Functional | 3 | Submit two events with different timestamps out of arrival order, where the earlier-timestamped event is the one that exhausts a commit, and confirm the earlier event receives the commit draw regardless of which one the system received first. |
| TEID-35-T4 | Functional | 3 | Submit two events sharing the exact same timestamp where either could exhaust a commit, and confirm exactly one deterministically wins according to the documented tie-break rule, on every repeated trial with the same inputs. |
| TEID-35-T5 | Adversarial | 1 | Deliberately submit a large batch of events in reverse chronological order and confirm the final balance still matches the forward-chronological-order result exactly, with no partial or intermediate state visible to a concurrent reader. |
| TEID-35-T6 | Adversarial | 3 | Submit 50 events for the same commit in random order where the true chronological processing would place the exhaustion boundary at event 27, and confirm the boundary lands at event 27 by timestamp regardless of arrival order, not at whichever event physically arrived 27th. |
| TEID-35-T7 | Adversarial | 2 | Replay the same 100-order test after artificially injecting a duplicate of one event into 10 of the orderings and confirm the duplicate is rejected by existing idempotency enforcement and does not change the final balance in any of the 10 runs. |

## Scoping notes for this point in the build sequence

- **A real, load-bearing finding, not just a gap: today's live consume
  path is arrival-ordered, not timestamp-ordered, for exactly the
  scenario AC3 names.** `consumeAcrossGrants`
  (`services/ts-console/src/lib/consumptionOrder.ts`) locks a
  customer's eligible grants via `ORDER BY id FOR UPDATE` (a fixed lock
  order that only exists to prevent cross-request deadlocks) and
  decrements `remaining_amount` against whichever request's transaction
  commits first -- `input.as_of`/`occurred_at` plays no role in which of
  two concurrent requests draws a nearly-exhausted commit.
  `TEID-19-T8`'s own test comment says this explicitly: "Which request
  wins is the one that takes the row lock." This is correct and
  sufficient for two requests sharing one instant (no timestamp-based
  answer exists for a true tie -- **T4** keeps this behavior, unchanged),
  but it is not sufficient for two requests with **different**
  timestamps that simply arrive out of order (network retry, queueing
  delay) -- **T3**'s and **T6**'s scenarios, which the live path today
  gets wrong if the later-timestamped event's request happens to reach
  the database first.
- **This story builds and proves a deterministic recompute engine; it
  does not change the live `POST /customers/:id/consume` endpoint.**
  Wiring live traffic to detect and correct an out-of-order arrival is
  explicitly **TEID-34**'s job ("Handle late-arriving events"), the very
  next story in this phase's order -- a natural split, not a deferral: a
  synchronous HTTP endpoint cannot always know whether an
  earlier-timestamped event is still in flight, so *deciding what to do
  about* a late arrival (TEID-34) is a different problem from *proving
  the correct answer is computable and stable* (this story). **AC1**'s
  "processing the same set of events in any order" and **T2**'s "replay
  ... in at least 100 random orders" describe exactly this: a batch, not
  a live race -- a function fed a fixed set of already-recorded events
  can always sort them first, which is what makes order-independence
  achievable at all. This is the reuse point TEID-34 and TEID-36
  (backfill) will call once they exist, per the same "coverage becomes
  literal once the real caller exists" pattern used throughout this
  backlog.
- **The tie-break rule (T4) is by usage event `id` (UUID), not a second
  timestamp field.** `usage_events.id` is assigned once at ingestion and
  never changes, so sorting by `(occurred_at, id)` is fully deterministic
  and repeatable across replays with the same input set -- satisfying
  AC3's "documented tie-break rule" without inventing a new column.
- **T7's duplicate-injection check reuses TEID-31's existing idempotency
  enforcement exactly as built** -- this story does not add new dedup
  logic, it proves the existing `usage_events` unique constraint
  (idempotency key) still holds under this story's own replay path,
  since a replay that fails to filter a duplicate would silently double
  the final balance.

## Architecture and design

### `services/ts-console/src/lib/consumptionReplay.ts` -- new file

- `replayConsumption(events: ReplayableConsumeInput[]): ReplayResult` --
  a pure, synchronous, in-memory function (no DB access): sorts the
  input events by `(occurred_at, id)` ascending, then walks them in that
  order applying the same draw logic `consumeAcrossGrants` already uses
  (grant selection via `resolveEffectiveOrder`/`sortGrantsForDraw`,
  reused directly, not reimplemented) against an in-memory copy of each
  grant's starting `remaining_amount`, producing the same
  `ConsumptionLine[]` shape per event that the live endpoint produces.
  Deterministic and side-effect-free by construction: the same input set
  in any order produces the same sorted sequence internally, hence the
  same output (**AC1**, **T1**, **T5**).
- `ReplayableConsumeInput`: `{id: string; customerId: string; occurredAt: Date; amount: number; unit: string}`
  -- the minimal shape needed to replay, matching each recorded
  `usage_consumptions` row plus its originating `usage_events.id`.
- This function takes grants' **starting** state (as of before any of
  the batch's events), not live current state -- callers (this story's
  own tests today; TEID-34/36 later) are responsible for supplying a
  consistent starting snapshot, matching how a real reconciliation or
  backfill run would work (snapshot, then replay against it).

### `POST /customers/:id/consumption/replay-check` (test/verification surface, T1/T2/T5/T6)

New route in `services/ts-console/src/routes/consumptionOrder.ts` (the
existing file, not a new one -- this is a thin diagnostic layer over
the existing consumption-order machinery, not a new domain), `["Owner",
"Billing Admin"]`, `requireAuth(pool, "admin")` matching this file's
existing pattern. Body: `{event_ids: string[]}` -- reads the named
`usage_consumptions` rows (assumed already recorded, e.g. by the tests'
own direct inserts) plus the customer's grants' state as of before the
earliest one, calls `replayConsumption` on a **shuffled** copy of the
input order (shuffling happens server-side so the test can call this
endpoint repeatedly with the same `event_ids` and get a fresh random
order each time, per **T2**), and returns the resulting per-grant final
`remaining_amount` and total commit-vs-overage split. This is the
concrete, callable surface **T1/T2/T5/T6** exercise -- standing in for
"whatever reconciliation job eventually calls this," the same
established pattern as every other not-yet-wired-to-production
function this backlog has scoped.

## Implementation guidance per test

### TEID-35-T1
Seed 5,000 usage-consumption events for one customer (a realistic mix
against several grants, no exhaustion boundary crossed). Call the
replay-check endpoint three times (three different random shuffles of
the same `event_ids`). Assert all three responses report byte-identical
final `remaining_amount` per grant and identical total commit/overage
split.

### TEID-35-T2
Same 5,000-event set. Call the replay-check endpoint 100 times. Assert
all 100 results are identical to each other, and that the 100th call's
latency is not measurably worse than the 1st (no O(n) reordering cost
accumulating call over call -- each call is independent).

### TEID-35-T3
Create a commit with exactly enough remaining balance for one of two
events. Record event A (`occurred_at` earlier, the one that should
exhaust the commit) and event B (`occurred_at` later) in **reverse**
order (B recorded before A). Call replay-check with both `event_ids`.
Assert the commit line is attributed to A, and B is priced as overage --
regardless of insertion order.

### TEID-35-T4
Two events with an identical `occurred_at`, either capable of exhausting
the same commit. Call replay-check with `[eventA, eventB]` and again
with `[eventB, eventA]`. Assert both calls attribute the commit draw to
the **same** one (by `id` tie-break), not whichever was passed first in
the input array.

### TEID-35-T5
50,000-event batch, submitted to replay-check in strict reverse
chronological order. Assert the result matches a second call with the
same events in strict forward chronological order, exactly.

### TEID-35-T6
50 events for one commit, constructed so the true chronological
exhaustion point is event #27 by `occurred_at`. Call replay-check with
the 50 `event_ids` in a random shuffle. Assert the commit/overage split
places the boundary at the 27th event by timestamp, not by whatever
position it held in the shuffled input array.

### TEID-35-T7
Take one of T2's 100 orderings and inject a second `usage_consumptions`
row sharing the same underlying `usage_events.idempotency_key` (already
rejected at ingestion per TEID-31, so this event never actually reaches
`usage_consumptions` as a duplicate -- assert directly that attempting
to seed the duplicate is rejected the same way TEID-31-T1 already
proves, and that the 10 replay runs including this attempted seed all
still match the other 90's final balance).

## File layout

- `services/ts-console/src/lib/consumptionReplay.ts` -- new:
  `replayConsumption`.
- `services/ts-console/src/routes/consumptionOrder.ts` -- extended:
  `POST /customers/:id/consumption/replay-check`.
- Tests: new directory `tests/replay-consistency/` implementing all 7
  cataloged tests, following `tests/consumption-order/`'s existing
  structure and fixtures.

## Definition of done

- [ ] All 3 acceptance criteria satisfied by working code.
- [ ] All 7 cataloged tests have real automated tests that pass --
      functional, non-functional, and adversarial alike.
- [ ] `tsc --noEmit` clean in `services/ts-console`.
- [ ] `tests/consumption-order` (all TEID-18 tests, unchanged),
      `tests/commits` (all TEID-19 tests, unchanged, including
      TEID-19-T8's live arrival-order tie-break behavior which this
      story does not change), `tests/cross-tenant`, `tests/grants`,
      `tests/plans` all still pass unchanged.
- [ ] Full suite passes against a database rebuilt from scratch via
      `db/setup-local.sh` plus the existing seed scripts.
- [ ] PR description maps each test ID to its file/line.
