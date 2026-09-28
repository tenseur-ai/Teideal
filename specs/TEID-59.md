# TEID-59: Python and TypeScript SDKs

| | |
|---|---|
| Epic | TEID-9 (E09 -- Improve developer experience and testing) |
| Phase | E09 |
| Priority | Highest |
| Points | 8 |
| Release | mvp |
| Order | 50 (first story in this phase -- no prior E09 work exists) |
| Depends on | `POST /usage` (TEID-30, `services/go-usage/internal/api/usage.go`), its idempotency semantics (TEID-31) -- read-only dependency, no service-side changes |

## Story (verbatim from the live board)

> As a developer at our customer, I want official SDKs that send usage events to Teideal alongside my existing billing system, so that Teideal gets an independent copy of usage with a few lines of code.
>
> *Context*
> MVP scope is event sending for Verify. Entitlement check, reserve and settle calls are added when TEID-2 is built.

## Acceptance criteria (verbatim from the live board)

1. SDKs are available for Python and TypeScript.
2. MVP: the SDK sends usage events with automatic retries that always reuse the same idempotency key.
3. MVP: a dual-write helper sends each event to Teideal and the existing billing system, and a failure on the Teideal side never blocks or fails the customer's request.
4. MVP: events are buffered locally if Teideal is unreachable and sent later without duplication.
5. Phase 2: the SDK adds entitlement check, reserve and settle calls and the local entitlement cache used in degraded mode (TEID-27).

## Cataloged tests (verbatim from the live board)

| ID | Type | AC | Title |
|---|---|---|---|
| TEID-59-T1 | Functional | 1 | Install the teideal-python and teideal-node packages in separate test projects and confirm both successfully send a usage event to the API. |
| TEID-59-T2 | Functional | 2 | Force a network failure during event send and confirm the SDK retries up to 3 times, reusing the identical idempotency key on every attempt, resulting in exactly one recorded event server-side. |
| TEID-59-T3 | Functional | 3 | Enable the dual-write helper, force the Teideal-side call to return a 500, and confirm the call to the existing billing system still succeeds and the customer's original request is not blocked or failed. |
| TEID-59-T4 | Functional | 4 | Take the Teideal endpoint offline for 10 minutes while the SDK continues firing events, then restore connectivity and confirm all buffered events flush automatically with no duplicates recorded server-side. |
| TEID-59-T5 | Functional | 5 | Call entitlement check, reserve and settle from the SDK, then disconnect from Teideal and confirm the local entitlement cache serves a cached allow/deny decision in degraded mode per TEID-27. |
| TEID-59-T6 | Non-functional | 2 | Benchmark the SDK sending 10,000 events per minute from a single client instance and confirm added client-side latency stays under 5ms per call. |
| TEID-59-T7 | Non-functional | 4 | Confirm SDK error and retry logging integrates with standard Python and Node logging frameworks so operators can observe retry and buffering activity without custom instrumentation. |
| TEID-59-T8 | Adversarial | 4 | Kill the client process mid-flush of the local buffer and restart it, then confirm no buffered events are lost and none are duplicated server-side thanks to the retained idempotency keys. |
| TEID-59-T9 | Adversarial | 2 | Send a usage event payload missing a required field and confirm the SDK raises a validation error locally and never transmits the malformed event. |

## Scoping notes for this point in the build sequence

- **T5 tests AC5, which the story's own text marks "Phase 2" -- a real
  cataloging inconsistency, resolved in favor of the more explicit
  signal, the same way TEID-96's spec resolved its own internal
  contradiction.** The story's context line is unambiguous ("MVP scope
  is event sending for Verify. Entitlement check, reserve and settle
  calls are added when TEID-2 is built"), and AC5 itself is labeled
  "Phase 2:" in the board's own AC list -- yet T5 is cataloged as a plain
  `Functional` test with no phase qualifier, and requires entitlement
  check/reserve/settle calls and "the local entitlement cache... per
  TEID-27," neither of which can exist yet (TEID-2, the epic that adds
  real-time entitlement checks, and TEID-27, the specific story for the
  degraded-mode cache, are both un-started phase-2 work with no server-
  side endpoint for the SDK to call). Implementing T5 now would mean
  building a cache for a decision-fetching call that doesn't exist,
  against a phase-2 behavior spec (TEID-27) not yet written. **T5 is out
  of scope for this story's Definition of Done** -- deferred to whichever
  story actually adds entitlement/reserve/settle. This is stated here
  explicitly, not silently dropped.
- **This is a pure client story: zero service-side changes.** `POST
  /usage`'s current contract (both single-event and batch paths, exactly
  as shipped by TEID-30/31) is read-only input to this spec. Full
  current shapes, confirmed directly against
  `services/go-usage/internal/api/usage.go`:
  - Single event (`{...}` body): `201` on success
    (`{id, customer_id, event_type, quantity, idempotency_key, occurred_at}`);
    `200` on an acknowledged duplicate
    (`{status: "duplicate", id, customer_id, event_type, quantity, idempotency_key}`
    -- **no `occurred_at` in this shape**, asymmetric with the `201` shape,
    a real wart in the existing API this SDK must absorb, not fix); `409`
    on a genuine content conflict
    (`{error: "idempotency_key already used with different content", existing_id}`);
    `400`/`403` on validation/visibility failures.
  - Batch (`[...]` body): always `207` with
    `{results: [...]}`, one entry per input item, shapes `{status: "created", ...}`
    / `{status: "duplicate", id}` (**narrower than the single-event
    duplicate shape** -- no other fields) / `{status: "conflict", id, reason}`
    / `{status: "error", reason}`.
  MVP scope (AC2's "sends usage events") only needs the **single-event
  path** -- nothing in the ACs or cataloged tests exercises batch
  sending, and batching is a reasonable, clearly-separable future
  enhancement, not scoped here.
- **AC2's idempotency-key generation is genuinely new; the closest thing
  in this repo is the wrong tool for the job.** Every existing
  `idempotency_key` in this repo's own test fixtures follows a
  test-isolation pattern (`` `${prefix}-${Date.now()}-${random}` ``) meant
  to make one test run's keys distinct from another's -- the opposite
  concern from AC2, which needs one key *stably reused* across every
  retry of the *same* logical event. The SDK generates a real UUIDv4 once,
  at the moment its "send event" function is first called for a given
  event, and persists it alongside that event's buffered state (see AC4
  below) so every retry -- including a retry after a process restart --
  reuses the identical value.
- **AC3's dual-write helper is genuine API design, with no existing
  precedent in this repo to reuse -- resolved here, not left open.**
  Modeled on Segment's `analytics.track()` and Sentry's
  `captureException()`: a synchronous-looking call that returns
  immediately, queues/sends internally, and never raises or rejects into
  the caller's own request handling -- transport/server errors are caught
  and logged (per T7), never propagated. An explicit wrapper function,
  not a decorator/context-manager: `client.send_event_best_effort(...)`
  (Python) / `client.sendEventBestEffort(...)` (TypeScript), called
  alongside the customer's existing billing call, not wrapping it
  magically -- simpler to reason about, and doesn't require the SDK to
  infer event fields from an arbitrary wrapped function's signature.
- **AC4's local buffering must be disk-persistent, not in-memory --
  T8 makes this a hard requirement, not a design choice.** T8 explicitly
  kills the client process mid-flush and asserts no buffered events are
  lost on restart; an in-memory-only queue cannot satisfy this by
  construction. Both SDKs persist pending events to a local file before
  ever attempting to send them, so a crash at any point loses nothing
  already queued. Exact mechanism (per language, since there's no shared
  runtime): Python uses the stdlib `sqlite3` module (no new dependency,
  transactional, safe for one process to mark rows sent without a
  read-modify-write race); TypeScript/Node uses an append-only NDJSON
  journal file with atomic write-to-temp-then-rename compaction (no
  native-binary dependency like `better-sqlite3`, which would complicate
  distribution) -- both stores key on the event's own stable
  idempotency key (from AC2) so a re-read after a crash can safely dedupe
  against anything already flushed.
- **AC1's "SDKs are available"** is scoped to two new, from-scratch
  packages: `sdks/python/` (a real installable package,
  `pyproject.toml`) and `sdks/typescript/` (a real installable npm
  package -- the first package in this repo NOT `"private": true`,
  deliberately, unlike every existing `services/`/`tests/`
  `package.json`). T1's "install... in separate test projects" is
  satisfied by each package being locally installable
  (`pip install ./sdks/python`, `npm install ../sdks/typescript` or
  `npm pack`) from a fresh virtualenv/node project the test suite sets
  up itself, not by an actual PyPI/npm registry publish (out of scope --
  no publish credentials or process exist yet).
- **T7's "standard... logging frameworks"**: Python uses the stdlib
  `logging` module directly (`logging.getLogger("teideal")`) -- a
  genuinely standard, singular choice. Node/TypeScript has no equivalent
  single standard; the SDK accepts an optional pluggable logger
  (`{debug, info, warn, error}` shaped, matching the common surface of
  `console`, `winston`, and `pino` alike) in its client constructor,
  defaulting to `console` if none is supplied -- "integrates with
  standard... frameworks" read as "doesn't require custom instrumentation
  to observe," satisfied by accepting whatever logger the operator
  already uses rather than mandating one.
- **CI: a new, separate, lightweight job, not folded into the existing
  `test` job.** SDK unit tests mock the HTTP layer directly (no real
  `go-usage`, no Postgres, no fixture seeding) -- forcing them into the
  existing `test` job would tie their runtime to that job's multi-minute
  full-stack startup for no reason, and couple an unrelated failure
  signal into the same check. New job `sdk-tests` in
  `.github/workflows/ci.yml`: checkout, `actions/setup-python`,
  `actions/setup-node`, then each SDK's own test command, no `services:`
  block. `deploy`'s `needs:` becomes `[test, sdk-tests]`, preserving "a
  failing suite blocks deploy."

## Architecture and design

### Shared client surface (same shape in both languages, idiomatic per language)

```
TeidealClient(base_url: str, api_key: str, logger=None, buffer_path=None)
  .send_event(customer_id, event_type, quantity, occurred_at=None) -> SendResult
      # Synchronous-shaped, MVP path. Generates a stable idempotency key
      # once (uuid4), validates locally (AC2/T9), persists to the local
      # buffer store BEFORE the first send attempt (so a crash between
      # generation and the first network call still has the event
      # recorded), then attempts delivery with retry (below). Returns
      # once terminally resolved (success, ack'd duplicate, or retries
      # exhausted -- in which case the event stays in the buffer for a
      # later flush, it is never silently dropped).
  .send_event_best_effort(customer_id, event_type, quantity, occurred_at=None) -> None
      # AC3's dual-write helper. Identical to send_event, except every
      # exception (validation, network, non-2xx after retries) is caught
      # and logged (T7), never raised/rejected to the caller.
  .flush() -> FlushResult
      # AC4/T4/T8: attempt delivery of every buffered, not-yet-acked
      # event, oldest first, reusing each one's stored idempotency key.
      # Called automatically on client construction (to resume after a
      # restart, per T8) and on an internal timer while the process is
      # unreachable-and-retrying; also callable directly.
```

### Local validation (AC2/T9)

Mirrors `services/go-usage/internal/api/usage.go`'s own server-side rules
exactly, so a locally-rejected event is one the server would also have
rejected -- not a stricter or looser copy: `customer_id` must be a
syntactically valid UUID; `event_type` must match
`^[A-Za-z0-9_.:-]{1,128}$`; `quantity` must be a finite number, `>= 0`,
`<= 1_000_000_000_000`. A local failure raises immediately (Python:
`TeidealValidationError`; TypeScript: `TeidealValidationError extends Error`)
and the event is never written to the buffer or sent (T9's "never
transmits the malformed event").

### Retry (AC2/T2/T6)

Up to 3 attempts total per event per `flush()`/`send_event` call, each
against the same generated idempotency key. Retryable outcomes: network
error, `5xx`, timeout. Non-retryable, terminal: `201` (success), `200`
duplicate-ack (also a success from the caller's perspective -- AC2's own
framing, "automatic retries," implies a retried-and-acked event is not a
failure), `409` conflict (a real, permanent error -- logged and raised,
not retried, since retrying an already-conflicting payload can't
change the outcome), `400`/`403` (permanent client errors, not
retried). Fixed short backoff between attempts (e.g. 100ms/300ms), not
exponential -- three attempts is a small, bounded window per the AC's own
number, not a long-running backoff strategy; documented as a constant
each SDK exposes for the caller to override if needed. **T6's 5ms-added-
latency budget** is measured on the *happy path* (first attempt succeeds)
-- local validation plus buffer-write overhead, not inclusive of actual
network round-trip time or retry delay, matching how TEID-19-T6/T7's own
"added latency" framing in this repo has consistently excluded the
underlying operation's own unavoidable cost.

### Local buffer store (AC4/T4/T8)

Python (`sdks/python/teideal/_buffer.py`): a single SQLite file
(default `~/.teideal/buffer.db`, override via `buffer_path`), one table
`(idempotency_key TEXT PRIMARY KEY, payload TEXT, attempts INT, created_at TEXT, sent_at TEXT NULL)`.
`persist()` = `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING` (so
re-persisting an event already known, e.g. after a crash-and-restart
re-attempt, is a safe no-op, not a duplicate row). `mark_sent()` sets
`sent_at`; sent rows are periodically vacuumed (not immediately deleted,
so a brief post-send crash can't lose the dedupe record before the
caller's own `201` response was durably observed -- a small bounded
retention window, e.g. 24h, is enough).

TypeScript (`sdks/typescript/src/buffer.ts`): an append-only NDJSON
journal (default `~/.teideal/buffer.ndjson`), each line
`{idempotencyKey, payload, attempts, createdAt, sentAt}`. `persist()`
appends a line only if the key isn't already present in the in-memory
index built from the file at startup (T8: the index rebuild on
construction is what makes "restart, no events lost" work -- the whole
file is read once at startup before anything else happens).
`markSent()` updates the in-memory index and triggers a compaction
(atomic temp-file-then-`rename()` rewrite containing only unsent
entries) once the sent-count crosses a small threshold, avoiding an
unbounded-growth journal without needing a rewrite on every single
send.

Both stores' `persist()` happens synchronously before the first network
attempt for that event (not after) -- this is what makes T8's "kill mid-
flush" safe: the event was already durable before delivery was ever
attempted, so a kill at any point loses at most an in-flight HTTP
request, never the record of the event itself.

### `flush()` and startup recovery (AC4/T4/T8)

On `TeidealClient` construction, the buffer store is opened and its
index loaded (Python: query for `sent_at IS NULL`; TypeScript: the
NDJSON read above) -- any event left over from a prior process (crashed,
or simply stopped mid-backlog) is now known and will be retried on the
next `flush()`. `flush()` iterates not-yet-sent events oldest-first,
applying the same retry logic as `send_event`, marking each sent (or
leaving it for the next flush if still failing). A background timer
(configurable interval, default e.g. 30s) calls `flush()` automatically
while any unsent events remain, so **T4**'s "restore connectivity and
confirm all buffered events flush automatically" doesn't require the
caller to do anything -- and stops polling once the buffer is empty, so
a healthy client isn't flushing an empty store forever.

## Implementation guidance per test

### TEID-59-T1
For each language, build the package (`pip install -e sdks/python`,
`npm install` + `npm run build` in `sdks/typescript`, or pack+install
into a fresh throwaway project directory), import/require it, construct
a client pointed at a locally-running `go-usage` (the same fake-free
real service other suites already start), call `send_event(...)`, assert
the returned result's `id` matches a subsequent `GET /usage?customer_id=...`
lookup.

### TEID-59-T2
Point the client at a URL that fails the first 2 attempts (a tiny local
proxy/test double that returns a connection-refused/500 for the first N
requests to a given path, then passes through -- new, small test helper,
not `go-usage` itself, since this needs to simulate transient failure
deterministically) and succeeds on the 3rd. Assert exactly 3 requests
were made, all carrying the identical `idempotency_key`, and exactly one
row exists in `go-usage` afterward for that key.

### TEID-59-T3
`send_event_best_effort(...)` against a real `go-usage` instance
reconfigured (or proxied) to return `500` unconditionally. Assert the
call returns without raising/rejecting, a fake "existing billing system"
stand-in (a trivial local function/mock the test itself defines) was
still called and succeeded, and the SDK logged the failure (via the
pluggable logger, T7) rather than silently swallowing it with no trace.

### TEID-59-T4
Point the client at an address that's unreachable for the test's
duration (not `go-usage` itself, so `go-usage` can be started fresh
*after* the buffering period without the test needing a real 10-minute
wait -- scale the "10 minutes" down via an env var,
`SDK_OFFLINE_TEST_DURATION_MS`, matching this repo's established
CI-scaling convention, with `600_000` documented as the real target).
Call `send_event`/`send_event_best_effort` several times while
unreachable (each persists to the buffer, attempts fail, event stays
pending), then point the client at a real running `go-usage` and either
wait for the background flush timer or call `flush()` directly. Assert
every event eventually appears server-side exactly once.

### TEID-59-T5
Not implemented -- deferred, per the scoping notes above (tests AC5,
explicitly phase-2, no entitlement/reserve/settle endpoint exists to
call). Documented here, not silently omitted.

### TEID-59-T6
`SDK_LATENCY_BENCHMARK_EVENTS_PER_MIN`-scaled load (CI-scaled down from
literal `10000`, matching every other non-functional test's established
convention in this repo) against a real, reachable `go-usage`. Measure
wall-clock time from `send_event()` call to its return for each event on
the happy path (first attempt succeeds), assert the mean/p99 added
overhead (call time minus the measured raw HTTP round-trip time to the
same endpoint) stays under 5ms.

### TEID-59-T7
Inject a capturing logger (a simple in-memory list-appending stand-in
implementing the pluggable logger interface) into the client
constructor. Force a retry (as in T2) and a buffered-then-flushed event
(as in T4, scaled down). Assert the captured log records include
identifiable retry-attempt and buffer-flush events -- proving the
integration point works, not asserting exact message text.

### TEID-59-T8
Using each language's real subprocess-spawning facility (Python:
`subprocess.Popen` running a tiny throwaway script that constructs a
client, buffers several events against an unreachable address, then
`os.kill`'s itself mid-`flush()` via a controlled hook; TypeScript:
`child_process.spawn` with the equivalent), kill the child process after
it has persisted events to the buffer but before any could have
succeeded. Start a **new** client instance pointed at the same
`buffer_path`/`buffer.ndjson` file, pointed at a now-reachable
`go-usage`, and assert `flush()`/the automatic startup flush delivers
every one of the originally-buffered events exactly once (no loss, no
duplication) -- the concrete proof that persistence happens before
delivery is attempted, not after.

### TEID-59-T9
`send_event(customer_id="not-a-uuid", ...)` and separately
`send_event(..., event_type="")`. Assert both raise
`TeidealValidationError` (or the TypeScript equivalent) synchronously,
and that no HTTP request was made at all (a request-capturing test
double, or simply asserting `go-usage`'s own event count is unchanged
afterward) and the buffer store contains no row for the attempted event.

## File layout

- `sdks/python/` -- new package: `pyproject.toml`, `teideal/__init__.py`,
  `teideal/client.py` (`TeidealClient`), `teideal/_buffer.py` (SQLite-
  backed store), `teideal/_validation.py`, `teideal/errors.py`
  (`TeidealValidationError`, `TeidealError`), `tests/` (this package's
  own unit tests, mocking the HTTP layer -- separate from the repo-root
  `tests/` convention used by every other story, since these are the
  SDK's own packaged unit tests, not an integration suite against a real
  stack).
- `sdks/typescript/` -- new package: `package.json` (not `"private": true`),
  `tsconfig.json`, `src/client.ts`, `src/buffer.ts` (NDJSON-backed
  store), `src/validation.ts`, `src/errors.ts`, `src/index.ts`, its own
  `test/` directory (vitest, mocking the HTTP layer).
- `tests/sdk-integration/` -- new, repo-root-convention integration
  suite (own `package.json`/`vitest.config.ts`, matching every other
  `tests/*` directory's shape) implementing T1-T4, T6, T8 (the tests
  that need a real running `go-usage`), spawning/importing both SDK
  packages as dependencies. T7/T9 can live here or inside each SDK
  package's own unit tests (T7/T9 don't need a real server) -- either is
  fine, pick one and be consistent across both languages.
- A new, small test double: a local network-failure-injecting proxy for
  T2 (returns failure for the first N requests to a path, then passes
  through) -- new file, e.g. `tests/sdk-integration/flaky-proxy.ts`,
  following the existing `fake-google.ts`/`fake-s3.ts` test-double
  convention (own tiny HTTP server, started/stopped per test or per
  suite).
- `.github/workflows/ci.yml` -- new `sdk-tests` job (checkout,
  `actions/setup-python`, `actions/setup-node`, run each SDK's own test
  command, plus `tests/sdk-integration` against a real `go-usage` it
  starts itself the same way `test`'s job does); `deploy`'s `needs:`
  becomes `[test, sdk-tests]`.

## Definition of done

- [ ] AC1-4 satisfied by working code in both Python and TypeScript.
      AC5 explicitly out of scope for this story (see scoping notes).
- [ ] 8 of the 9 cataloged tests have real automated tests that pass
      (T1-T4, T6-T9); T5 is documented as deferred, not implemented,
      not silently dropped.
- [ ] `tsc --noEmit` clean for `sdks/typescript`; the Python package
      type-checks cleanly under `mypy` (or an equivalent the spec's
      implementer sets up, matching this repo's general "strict typing"
      posture even where no prior Python code exists to follow as
      precedent).
- [ ] Every other suite (`tests/cross-tenant` through `tests/billing-periods`,
      `tests/idempotency`, `tests/commits`) still passes unchanged --
      this story touches no service code at all.
- [ ] Full suite passes against a database rebuilt from scratch via
      `db/setup-local.sh` plus the existing seed scripts (for the
      integration suite's real `go-usage` dependency).
- [ ] PR description maps each implemented test ID to its file/line, and
      explicitly calls out T5's deferral.
