# TEID-30: Usage event ingestion API

| | |
|---|---|
| Epic | TEID-3 (E03 -- Build usage ingestion and exactly-once ledger) |
| Phase | E03 |
| Priority | Highest |
| Points | 8 |
| Release | mvp |
| Order | 12 (within E03 -- first story in this phase) |
| Depends on | `usage_events` table and `POST /usage`/`GET /usage` (TEID-41, `db/migrations/20260926120000_init.sql`, `services/go-usage/internal/api/usage.go`) |

## Story (verbatim from the live board)

> As a developer at our customer, I want to send usage events one at a time or in batches, so that every billable action is recorded reliably.
>
> *Context*
> Each event carries an idempotency key, customer, metric, quantity, the time it happened and optional metadata.

## Acceptance criteria (verbatim from the live board)

1. The API accepts single events and batches of up to 1,000 events.
2. An event is only acknowledged after it has been stored durably; an acknowledged event is never lost.
3. The system sustains 15,000 events per second (three times the customer's current peak) without errors or growing delay.
4. Invalid events are rejected with a specific reason per event; valid events in the same batch are still accepted.
5. Events are reflected in balances within 2 seconds of acknowledgement under normal load.

## Cataloged tests (verbatim from the live board)

| ID | Type | AC | Title |
|---|---|---|---|
| TEID-30-T1 | Functional | 1 | Submit a single event via the ingestion API and confirm a 201 with an event ID, then submit one batch containing exactly 1,000 events and confirm all 1,000 are accepted with individual per-event statuses. |
| TEID-30-T2 | Functional | 2 | Submit an event, capture the timestamp the acknowledgment is returned, and confirm the event is already durably committed and queryable in the store at that exact moment, with no async delay between ack and durability. |
| TEID-30-T3 | Functional | 3 | Run a sustained load test at 15,000 events per second for 30 minutes and confirm zero ingestion errors and no growth in queue backlog or processing lag over the run. |
| TEID-30-T4 | Functional | 4 | Submit a batch of 10 events where events 3 and 7 have an invalid metric name and a negative quantity respectively, and confirm the response lists a specific rejection reason for each of the two while the other 8 are accepted and stored. |
| TEID-30-T5 | Functional | 5 | Submit an event under a steady background load of 1,000 events per second and poll the customer's balance every 100ms, confirming the balance reflects the new event within 2,000ms of acknowledgment. |
| TEID-30-T6 | Non-functional | 3 | Run the 15,000 events/sec load test for 30 minutes and confirm p99 ingestion latency stays under 200ms throughout with no upward trend. |
| TEID-30-T7 | Non-functional | 5 | Monitor the event-to-balance lag metric on the observability dashboard during steady 5,000 events/sec traffic and confirm the p99 lag never exceeds the 2-second alert threshold. |
| TEID-30-T8 | Adversarial | 1 | Submit a batch of 1,001 events in a single request and confirm the API rejects the entire batch with a clear batch-size-exceeded error instead of silently processing only the first 1,000. |
| TEID-30-T9 | Adversarial | 4 | Submit a batch containing one event with a negative quantity and one with SQL-injection-style characters in the metric name field, and confirm both are rejected with specific validation reasons without crashing the service or affecting the other valid events in the batch. |

## Scoping notes for this point in the build sequence

- **"Balances" (AC5, T5, T7) don't exist yet.** Balances derived from the
  ledger is TEID-33 (order 18, later in this same phase). Until then,
  "reflected in balances" is scoped to "durably stored and immediately
  visible via `GET /usage`" -- the real precursor mechanism (read-after-
  write consistency) that TEID-33 will build balance computation on top
  of. T5/T7 test that a freshly-ingested event is queryable via
  `GET /usage?customer_id=...` within the stated time budget, not a
  computed balance figure. Revisit these two tests when TEID-33 lands --
  they should then assert against the real balance, not this stand-in.
- **T3/T6's 15,000 events/sec for 30 minutes is a real production NFR,
  not a per-commit CI test.** A 30-minute sustained-load run on every
  push would make the CI gate itself violate TEID-41-T5's 15-minute
  suite budget. Scale the automated version down via env vars
  (`LOAD_TEST_EVENTS_PER_SEC`, default `2000`; `LOAD_TEST_DURATION_SECONDS`,
  default `60`) so CI proves the mechanism (sustained concurrent
  ingestion, no error growth, no latency creep) at a size that fits
  inside the existing CI budget. Document the full 15,000/sec-for-30-min
  target as what a dedicated perf/staging pipeline validates before a
  release that changes the ingestion path -- that pipeline doesn't exist
  yet and isn't this story's job to build.

## Architecture and design

### No new tables

`usage_events` (TEID-41) already has every column this story needs:
`tenant_id`, `customer_id`, `event_type`, `quantity`, `idempotency_key`,
`occurred_at`. Do not widen it for "optional metadata" mentioned in the
story context unless a test actually requires it -- none of the 9 tests
above exercise a metadata field, so it's out of scope here (add it in
whichever later story's tests actually need it).

### `POST /usage` accepts either shape

Keep the existing single-object behavior in
`services/go-usage/internal/api/usage.go`'s `PostUsage` completely
unchanged (TEID-41-T2/T7/T8 in `tests/cross-tenant` must keep passing
byte-for-byte) -- do not rename or move it. Add batch handling as a
branch at the top of the same handler: decode the raw body far enough to
tell whether it's a JSON object (`{...}`, existing single-event path) or
a JSON array (`[...]`, new batch path), then dispatch.

**Batch path:**

1. Reject outright (400, no per-item processing at all) if the array has
   more than 1,000 elements: `{"error": "batch exceeds 1000 events"}`
   (TEID-30-T8). An empty array is a 400 too (`"batch must contain at
   least 1 event"`).
2. Validate and insert each item **independently** -- each item's
   validation and insert is its own unit of work, so one bad item never
   aborts or rolls back another item's success (TEID-30-T4/T9 require
   this). Do not wrap the whole batch in one transaction.
3. Respond `207 Multi-Status` with a body `{"results": [...]}`, one
   entry per input item, **in input order**:
   - success: `{"status": "created", "id": "<uuid>", "customer_id": ...,
     "event_type": ..., "quantity": ..., "idempotency_key": ...,
     "occurred_at": ...}`
   - validation failure: `{"status": "error", "reason": "<specific
     message>"}`
   - customer not visible under caller's tenant: `{"status": "error",
     "reason": "customer not found for this tenant"}` -- note this
     differs from the single-event path, which still returns a
     request-level 403 for this case (TEID-41-T2 depends on that).
     Batch mode never fails the whole request for one item's problem.
   - duplicate idempotency key (already exists for this tenant, from
     this request or a prior one): `{"status": "duplicate", "id":
     "<existing event's id>"}` -- not an error; report the existing
     event, matching "an acknowledged event is never lost" for a retried
     submission.

### New validation rules (apply to both single and batch paths)

- `event_type`: required, must match `^[A-Za-z0-9_.:-]{1,128}$`. Anything
  else (including SQL-injection-style characters -- TEID-30-T9) is
  rejected with reason `"event_type must match ^[A-Za-z0-9_.:-]{1,128}$"`.
  This is an input-shape rule, independent of and in addition to
  parameterized queries already making injection impossible at the SQL
  layer -- the point of this validation is a *specific, per-item reason*
  in the response, not defense in depth (that already exists).
- `quantity`: required, must be a finite number `>= 0`. Negative or
  non-numeric is rejected with reason `"quantity must be a non-negative
  number"`.
- Existing `customer_id` (valid UUID) and `idempotency_key` (non-empty)
  validation already in `PostUsage` applies unchanged to both paths.

Apply the same `event_type`/`quantity` rules to the **single-event**
path too (currently `PostUsage` doesn't validate either) -- AC4 doesn't
distinguish single from batch, and TEID-41's existing tests never sent
an invalid `event_type`/negative `quantity`, so this is additive and
safe.

### Durability (AC2, T2)

Already correct: `PostUsage` inserts inside a transaction and only
responds after `Commit()` returns. No change needed to the mechanism --
T2 just needs a test proving it (read immediately after ack, same
connection pool, confirm the row is there).

## Implementation guidance per test

### TEID-30-T1
Single event: unchanged existing behavior, confirm 201 + id (this
already passes -- add an explicit test for it in the new suite so the
whole story's coverage lives in one place). Batch: submit exactly 1,000
valid events in one request, confirm 207 with 1,000 `results` entries,
every one `status: "created"`, in the same order as submitted (assert by
matching each result's `id` back to a per-input marker, e.g. put a
distinguishing value in each item's `event_type` like `test-load-<i>`).

### TEID-30-T2
Submit one event, capture wall-clock time right after the response
returns, then immediately `GET /usage?customer_id=...` and confirm the
just-created event's id is present. There is no window here to
race -- if this is ever flaky, that itself is the bug (durability isn't
actually synchronous), not the test.

### TEID-30-T3 / TEID-30-T6
One test, run under `LOAD_TEST_EVENTS_PER_SEC`/`LOAD_TEST_DURATION_SECONDS`
(defaults `2000`/`60`, overridable via env for a real 15000/1800 run
outside CI): a client pool submitting single events at the configured
rate for the configured duration, distinct `customer_id`s and
`idempotency_key`s throughout. Track every response's status and
latency. Assert zero non-201 responses and that p99 latency in the
second half of the run is not meaningfully higher than the first half
(no upward trend) and stays under 200ms at the CI scale.

### TEID-30-T4
Batch of 10, items at index 2 (0-based, "event 3") with an invalid
`event_type` and index 6 ("event 7") with `quantity: -1`. Confirm the
207 response's `results[2]` and `results[6]` are `status: "error"` with
the specific reasons above, and the other 8 are `status: "created"`;
confirm via `GET /usage` that exactly 8 new rows exist for this test's
customer.

### TEID-30-T5 / TEID-30-T7
Background load (1,000/sec for T5, 5,000/sec for T7 -- both can reuse
the T3/T6 load generator at a different configured rate) plus one
"marked" event submitted mid-run. Poll `GET
/usage?customer_id=<marked event's customer>` every 100ms starting
immediately after that event's ack and record how long until it appears
in the response. Assert under 2,000ms (T5) / track p99 across many such
marked events and assert p99 under 2,000ms (T7).

### TEID-30-T8
POST an array of 1,001 valid events. Assert the response is a
request-level 400 with a batch-size-exceeded message, and via
`GET /usage` confirm **zero** of the 1,001 were stored (not "the first
1,000" -- the whole batch is rejected).

### TEID-30-T9
Batch of a few valid events plus one with `quantity: -5` and one with
`event_type: "click'; DROP TABLE usage_events;--"`. Assert both get
`status: "error"` with the specific reasons above, the valid events in
the same batch get `status: "created"`, the service is still up and
`usage_events` still exists and is queryable afterward (confirm with a
trivial `GET /usage` call), and no error touched anything outside this
request.

## File layout

- `services/go-usage/internal/api/usage.go` -- extend `PostUsage`, add
  the batch branch and shared validation helpers (`validateEventType`,
  `validateQuantity`).
- `services/go-usage/internal/db/db.go` -- no changes expected;
  per-item inserts should each be their own short-lived
  `Pool.WithTenant` call (already the shape `PostUsage` uses), not one
  transaction wrapping all 1,000.
- Tests: new directory `tests/usage-ingestion/` (own `package.json`,
  `tsconfig.json`, `vitest.config.ts` -- mirror `tests/console-auth/`'s
  shape). Keep the load-test file (T3/T6/T5/T7) separate from the
  functional/adversarial ones (T1/T2/T4/T8/T9) so the fast tests aren't
  gated on the ~60s load test's runtime during normal iteration.
- CI: add a step to `.github/workflows/ci.yml`'s `test` job running this
  new suite.

## Definition of done

- [ ] All 5 acceptance criteria satisfied by working code (AC3/AC5 as
      scoped above).
- [ ] All 9 cataloged tests have real automated tests that pass.
- [ ] `go vet ./...` clean in `services/go-usage`.
- [ ] TEID-41's existing `tests/cross-tenant` suite still passes
      unchanged -- the single-event path's behavior must not regress.
- [ ] Full suite passes against a database rebuilt from scratch via
      `db/setup-local.sh` plus the existing seed scripts.
- [ ] PR description maps each test ID to its test file/line.
