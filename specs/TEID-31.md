# TEID-31: Enforced idempotency

| | |
|---|---|
| Epic | TEID-3 (E03 -- Build usage ingestion and exactly-once ledger) |
| Phase | E03 |
| Priority | Highest |
| Points | 5 |
| Release | mvp |
| Order | 16 (within E03; TEID-30/94/95/96 have all already shipped in this
  epic but at higher `order` values reflecting when they were pulled into
  the build sequence, not their catalog position -- this is the next
  E03 story with no dependency on any of those four beyond the shared
  `usage_events` table itself) |
| Depends on | `usage_events` table + its existing `UNIQUE (tenant_id, idempotency_key)` constraint (TEID-41, `db/migrations/20260926120000_init.sql`), `insertUsageEvent`/`postUsageSingle`/`postUsageBatch` (TEID-30, `services/go-usage/internal/api/usage.go`), `Pool.WithTenant` (`internal/db/db.go`), `auth.Middleware` (`internal/auth/auth.go`), `security.LogBlocked` pattern (`internal/security/security.go`, as a shape to follow, not reused directly) |

## Story (verbatim from the live board)

> As a developer at our customer, I want to safely retry sending any event without risk of double charging, so that network failures and retries never create duplicate charges.
>
> *Context*
> Idempotency must be guaranteed by the database, not by application code that can have bugs.

## Acceptance criteria (verbatim from the live board)

1. An event with an idempotency key already seen is acknowledged but not applied again, and the response says it was a duplicate.
2. Keys are remembered for at least the longest billing period plus 7 days.
3. If a repeated key arrives with different contents, it is rejected and flagged for review rather than silently ignored.
4. Uniqueness is enforced by the data store itself; a test that sends the same event from 50 parallel workers results in exactly one ledger entry.

## Cataloged tests (verbatim from the live board)

| ID | Type | AC | Title |
|---|---|---|---|
| TEID-31-T1 | Functional | 1 | Send an event with idempotency key abc-123, then resend the identical event and key, and confirm the second response returns success with a duplicate flag and no second ledger entry is created. |
| TEID-31-T2 | Functional | 2 | For a customer whose longest billing period is annual, submit an event and confirm at day 371 a resend with the same key is still blocked as a duplicate, then confirm at day 372, 365 plus 7, the key has expired and can be reused. |
| TEID-31-T3 | Functional | 3 | Send an event with idempotency key xyz-789 and quantity 100, then resend the same key with quantity 200, and confirm the second request is rejected with a conflict error and appears in the operator's review queue. |
| TEID-31-T4 | Functional | 4 | From 50 concurrent worker threads, simultaneously send the identical event with the same idempotency key and payload, and confirm exactly one ledger entry is created and the other 49 responses indicate duplicate. |
| TEID-31-T5 | Non-functional | 4 | Repeat the 50-way concurrent duplicate-send test 1,000 times in a loop and confirm zero flaky outcomes, exactly one ledger entry every time, demonstrating a database-level uniqueness constraint rather than an application-level race-prone check. |
| TEID-31-T6 | Adversarial | 4 | Send the identical event, same idempotency key, to two different application server instances at the same instant and confirm the shared database constraint allows only one insert to succeed, with the loser returning a duplicate response rather than an unhandled error. |
| TEID-31-T7 | Adversarial | 3 | Reuse an idempotency key with a payload that differs only in a floating-point rounding artifact, such as quantity 100.00 versus 100.0000001, and confirm the mismatch is still detected and flagged for review rather than treated as an identical duplicate. |

## Scoping notes for this point in the build sequence

- **AC4 is already fully built, and has been since before TEID-30.** The
  `UNIQUE (tenant_id, idempotency_key)` constraint on `usage_events`
  (`db/migrations/20260926120000_init.sql`) predates every E03 story --
  its own migration comment already calls it out as *"the exactly-once
  (dedup-on-write) guarantee for TEID-3's ledger later."* `insertUsageEvent`
  does one `INSERT ... RETURNING` with no prior existence check, so the
  constraint, not application code, is the only thing preventing a
  duplicate row. **This story does not add new locking or serialization
  logic for AC4** -- T31-T4/T5/T6 are verification tests for
  already-shipped infrastructure, not new mechanism. Keep the constraint
  exactly as it is (see next point for why it must not move or be dropped).
- **AC1 is real but inconsistent between the two existing ingestion paths,
  and AC2/AC3 are net-new** -- `postUsageBatch` already catches a `23505`
  and acks with `{"status": "duplicate", "id": <existing id>}`
  (`services/go-usage/internal/api/usage.go` lines 395-409); `postUsageSingle`
  instead returns a bare `409 {"error": "idempotency_key already used..."}`
  (lines 271-276) -- a rejection, not an ack, and with no existing event id
  for the caller to look up. No test today exercises retrying the same key
  on the single-event path (confirmed by grep across every test directory),
  so bringing it to parity is a real behavior change but breaks nothing
  existing.
- **The constraint must stay on `usage_events` itself, unmoved, to avoid
  breaking existing fixtures.** `tests/data-export/data-export.test.ts` (and
  other seed scripts) already write raw
  `INSERT ... ON CONFLICT (tenant_id, idempotency_key) DO NOTHING` against
  `usage_events` for idempotent test-fixture seeding. Moving the constraint
  to a new dedicated table (the "obvious" normalized design) would break
  every one of those `ON CONFLICT` clauses across multiple already-merged
  stories' test suites. The design below keeps the existing constraint
  completely untouched and layers AC2/AC3's new behavior around it
  reactively, in the application code's handling of the `23505` the
  constraint already produces -- more consistent with "the data store
  enforces uniqueness, not application code" than it might first appear:
  the constraint is still the *sole* source of truth for "does this key
  exist," the application only decides *what to do* once it's told a
  duplicate exists.
- **AC2 and AC4 are in real tension, resolved here deliberately.** AC4 wants
  permanent, unconditional DB-enforced uniqueness. AC2/T31-T2 want a key to
  become *reusable* -- a genuinely new event with the same key succeeding,
  not merely acknowledged as a duplicate -- after 372 days (`365 + 7`,
  T31-T2's own literal numbers; used exactly as stated, not `366` for leap
  years, since the test pins the literal figure). A `usage_events` row is
  also a permanent billing-ledger entry that should never be silently
  deleted for its own sake. The design: on `23505`, look up the conflicting
  row's `created_at` (the moment the key was actually first recorded --
  not `occurred_at`, which is client-supplied and could be backdated).
  - If the conflicting row is **younger** than 372 days: it's a real,
    in-window duplicate -- proceed to the AC1/AC3 content-comparison path
    below.
  - If the conflicting row is **372 days or older**: the key has expired
    per AC2. Delete that one row and retry the original insert once (now
    succeeds, since the constraint's conflicting row is gone). The response
    is a normal `created` response with a brand-new id -- **not** an ack
    of the old one -- matching T31-T2's "has expired and can be reused,"
    not "is treated as a duplicate." This only ever deletes a row at the
    exact moment its own key is legitimately reused past the retention
    floor, which is a narrower, more defensible operation than a blanket
    time-based purge job, and satisfies AC2's literal wording ("remembered
    for **at least**" the floor -- nothing is forgotten *before* 372 days;
    what happens *at or after* is exactly what T31-T2 specifies).
  - **"Longest billing period" resolves to a hardcoded 372-day constant,
    not a live lookup.** The only interval concept longer than a month
    anywhere in the system is `services/ts-console`'s `plans.billing_interval
    CHECK (... IN ('monthly', 'annual'))` (TEID-16) -- owned by a different
    service's table, which `go-usage` cannot query directly per ADR 0001's
    per-table ownership rule, and there is no proto/gRPC contract yet to ask
    for it (nor any customer-to-plan assignment yet to resolve a specific
    customer's plan in the first place, the same gap TEID-16/17/18's specs
    already documented). `go-usage`'s own `customer_billing_config`
    (TEID-96) has no interval field at all -- only timezone/anchor-day.
    Given `'annual'` is the longest interval this product supports today,
    a single constant (`IDEMPOTENCY_KEY_RETENTION_DAYS = 372`, new file
    `services/go-usage/internal/api/idempotency.go`) is used tenant-wide
    rather than building a cross-service lookup for what is currently a
    two-value enum with no live customer resolution path anyway. Documented
    here as a deliberate simplification to revisit once real per-tenant
    plan assignment exists.
- **AC3's "different contents" excludes `occurred_at` -- a load-bearing
  decision, not an oversight.** `tests/billing-periods/billing-periods.test.ts`'s
  `TEID-96-T8` (already merged, currently passing) submits the *same*
  idempotency key twice with `occurred_at` values 1ms apart straddling a
  period boundary, and asserts the second is silently acked as a duplicate
  of the first -- the test's own name, *"keeps the first timestamp when
  duplicate submissions straddle a boundary,"* frames this as tolerating
  clock-skew-sized timestamp differences between a request and its retry,
  not a real different event. Comparing `event_type`, `quantity`, and
  `customer_id` (excluding `occurred_at`) for AC3's mismatch check preserves
  `TEID-96-T8` completely unchanged -- zero regression -- while still
  implementing AC3 for the fields that represent what actually happened.
  State this explicitly rather than leaving readers to wonder why
  `occurred_at` isn't compared.
- **AC3's "flagged for review" needs a genuinely new table and endpoint.**
  No review-queue/conflict-flagging concept exists anywhere in this
  codebase. `security.LogBlocked`/`security_events` is the nearest existing
  precedent in *shape* (synchronous insert in the same request, admin-
  readable via a `GET`) but is deliberately RLS-exempt/cross-tenant by
  design (`docs/isolation-design.md`) -- wrong fit for a tenant-owned
  billing anomaly, which must stay RLS-isolated like every other tenant
  table. A new, tenant-scoped `idempotency_conflicts` table follows
  instead, read via a new `admin`-scoped `GET`, matching
  `rounding-config`/`billing-config`'s existing endpoint conventions
  (`internal/api/billing_config.go`) rather than `security_events`'s.
- **No background worker of any kind exists yet in `services/go-usage`**
  (confirmed: `cmd/server/main.go` has no goroutine/ticker anywhere,
  unlike `services/ts-console/src/server.ts`'s `exportTimer`/`grantTimer`
  pattern) -- but this story needs none either, since expiry is handled
  reactively on the `23505` path above, not by a scheduled purge. No new
  worker, no new `NODE_ENV`-equivalent test-mode guard needed.

## Architecture and design

### Schema: one new table, no changes to `usage_events`

New migration `db/migrations/20260928091500_idempotency_conflicts.sql`:

```sql
-- TEID-31 AC3: a repeated idempotency key whose content (excluding
-- occurred_at -- see specs/TEID-31.md's scoping notes on TEID-96-T8)
-- differs from the original is rejected and recorded here for an
-- operator's review, rather than silently treated as a duplicate.
CREATE TABLE IF NOT EXISTS idempotency_conflicts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  existing_usage_event_id UUID NOT NULL REFERENCES usage_events(id),
  attempted_customer_id UUID,
  attempted_event_type TEXT,
  attempted_quantity NUMERIC,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE idempotency_conflicts ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_conflicts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_idempotency_conflicts ON idempotency_conflicts;
CREATE POLICY tenant_isolation_idempotency_conflicts ON idempotency_conflicts
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
-- Append-only: a conflict record is never edited or removed by the app.
GRANT SELECT, INSERT ON idempotency_conflicts TO teideal_app;
```

`usage_events` and its existing `UNIQUE (tenant_id, idempotency_key)`
constraint are **not** touched by this migration, per the scoping notes.

### Shared resolution logic (new file `services/go-usage/internal/api/idempotency.go`)

```go
const IdempotencyKeyRetentionDays = 372 // 365 + 7, see specs/TEID-31.md

type idempotencyOutcome int

const (
	outcomeInserted idempotencyOutcome = iota // no conflict, or conflict was expired and cleared
	outcomeDuplicate                          // in-window conflict, content matches -> ack
	outcomeConflict                           // in-window conflict, content differs -> reject + flag
)

type existingEvent struct {
	ID         string
	CustomerID string
	EventType  string
	Quantity   decimal.Decimal
	CreatedAt  time.Time
}

// resolveIdempotencyConflict is called from inside the same transaction as
// the insert attempt, immediately after a 23505 on (tenant_id,
// idempotency_key). It does not itself decide insert vs. reject -- it loads
// the conflicting row and classifies it (expired / duplicate / real
// conflict) so the caller (postUsageSingle/postUsageBatch) can act.
func resolveIdempotencyConflict(
	ctx context.Context, tx pgx.Tx, idempotencyKey string,
	attemptedCustomerID, attemptedEventType string, attemptedQuantity decimal.Decimal,
	now time.Time,
) (idempotencyOutcome, existingEvent, error) {
	var existing existingEvent
	err := tx.QueryRow(ctx, `
		SELECT id, customer_id, event_type, quantity, created_at
		FROM usage_events WHERE idempotency_key = $1
	`, idempotencyKey).Scan(&existing.ID, &existing.CustomerID, &existing.EventType, &existing.Quantity, &existing.CreatedAt)
	if err != nil {
		return outcomeConflict, existingEvent{}, err
	}

	if now.Sub(existing.CreatedAt) >= IdempotencyKeyRetentionDays*24*time.Hour {
		if _, err := tx.Exec(ctx, `DELETE FROM usage_events WHERE id = $1`, existing.ID); err != nil {
			return outcomeConflict, existingEvent{}, err
		}
		return outcomeInserted, existingEvent{}, nil // caller retries the original INSERT
	}

	if existing.CustomerID == attemptedCustomerID &&
		existing.EventType == attemptedEventType &&
		existing.Quantity.Equal(attemptedQuantity) {
		return outcomeDuplicate, existing, nil
	}
	return outcomeConflict, existing, nil
}

func recordConflict(
	ctx context.Context, tx pgx.Tx, tenantID, idempotencyKey, existingID string,
	attemptedCustomerID, attemptedEventType string, attemptedQuantity decimal.Decimal,
) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO idempotency_conflicts (
			tenant_id, idempotency_key, existing_usage_event_id,
			attempted_customer_id, attempted_event_type, attempted_quantity
		) VALUES ($1, $2, $3, $4, $5, $6)
	`, tenantID, idempotencyKey, existingID, attemptedCustomerID, attemptedEventType, attemptedQuantity)
	return err
}
```

`decimal.Decimal.Equal` (already used throughout `services/go-usage` per
TEID-94/95's exact-decimal conventions) is exact, not float-approximate --
T31-T7's "100.00 versus 100.0000001" case compares as genuinely unequal,
which is the correct "flag it" outcome (a real, if tiny, content
difference), not a false negative from float rounding.

### `postUsageSingle` extended (AC1, AC2, AC3)

Inside the existing `h.Pool.WithTenant(...)` closure
(`services/ts-console`... no, `services/go-usage/internal/api/usage.go`
lines 245-258), on the `23505` branch (currently lines 271-276): call
`resolveIdempotencyConflict` with `time.Now()`. On `outcomeInserted`, retry
the original `insertUsageEvent` call once inside the same transaction (the
expired row is already gone) and fall through to the normal `201 created`
response. On `outcomeDuplicate`, return `200` (not `409` -- an
acknowledged retry is a success, not a conflict) with a new response shape
`{"status": "duplicate", "id": existing.ID, "customer_id": ..., "event_type":
..., "quantity": ..., "idempotency_key": ...}` -- the existing event's full
data, shaped consistently with `usageEvent` but tagged `status: "duplicate"`
so a caller can distinguish it from a fresh `201` without inspecting the
status code alone (useful for client libraries that log the body). On
`outcomeConflict`, call `recordConflict` (still inside the same
transaction, so the flag is recorded atomically with the rejection -- never
flagged-but-not-actually-rejected or vice versa) and return `409
{"error": "idempotency_key already used with different content",
"existing_id": existing.ID}`.

### `postUsageBatch` extended (same three outcomes, per item)

Same `resolveIdempotencyConflict`/`recordConflict` calls, inside each
item's existing per-item `h.Pool.WithTenant(...)` closure
(lines 368-381), replacing the batch path's current bare "look up existing
id, ack as duplicate" block (lines 395-409) which today has no content
comparison at all. `batchResultItem` gains one more `Status` value,
`"conflict"` (alongside today's `"created"`/`"duplicate"`/`"error"`), with
`Reason` set to the same message `postUsageSingle` uses, so a batch caller
can distinguish "this item was a harmless retry" from "this item's retry
had different content and was flagged" without a second API call.

### `GET /idempotency-conflicts` -- the review queue (AC3)

New file `services/go-usage/internal/api/idempotency_conflicts.go`,
`admin`-scoped (matching `rounding-config`/`billing-config`'s
`auth.Middleware(pool.Pool, "admin")` registration in `cmd/server/main.go`).
Optional `customer_id`/`idempotency_key` query filters (validated the same
way `GetUsage`'s `customer_id` filter already is -- UUID-checked before it
ever reaches a query). Returns `{"data": [...]}`, newest-first, each row
shaped `{id, idempotency_key, existing_usage_event_id, attempted_customer_id,
attempted_event_type, attempted_quantity, detected_at}` -- everything
`recordConflict` stored, so an operator reviewing a flagged conflict can see
both what's on record and what the rejected retry attempted.

## Implementation guidance per test

### TEID-31-T1
`POST /usage` (single-event path) with `idempotency_key: "abc-123"` and
some fixed `customer_id`/`event_type`/`quantity`. Assert `201`. Resend the
**identical** body. Assert `200` (not `409`), `body.status === "duplicate"`,
`body.id` equals the first response's `id`. `GET /usage?customer_id=...`
and assert exactly one matching row (no second ledger entry).

### TEID-31-T2
Seed a `usage_events` row directly (bypassing the API, via the test's own
DB fixture helper -- the same pattern `tests/billing-periods` already uses
for direct-DB setup) with `created_at` backdated to exactly 371 days before
the test's fixed `now`. `POST /usage` with the same `idempotency_key`
(content doesn't matter for this test -- use identical content to isolate
the retention-window behavior from AC3's content check). Assert `200
duplicate` (still within the 372-day window). Advance the fixture's
`created_at` to exactly 372 days before `now` (or equivalently, run the
same check with `now` advanced by one more day -- whichever is simpler to
express against this test's fixed-clock setup) and resend. Assert `201`
(not `200`/duplicate) with a **new** `id`, different from the original
seeded row's id -- confirming reuse, not an ack.

### TEID-31-T3
`POST /usage` with `idempotency_key: "xyz-789"`, `quantity: 100`. Assert
`201`. Resend the same key with `quantity: 200` (same `customer_id`/
`event_type`). Assert `409` with the conflict error shape (`existing_id`
present). `GET /idempotency-conflicts?idempotency_key=xyz-789` and assert
one row with `attempted_quantity: 200` and `existing_usage_event_id`
matching the first response's `id`.

### TEID-31-T4
From 50 concurrent goroutines/workers (matching the load-test harness shape
already established in `tests/usage-ingestion/load-test.test.ts`), `POST`
the identical event (same `idempotency_key`, `customer_id`, `event_type`,
`quantity`) simultaneously (`Promise.all` if driven from the TS test
harness, as `tests/usage-ingestion` already is). Assert exactly one
response has `status: "created"`/`201` and the other 49 have `status:
"duplicate"`/`200`, all sharing the same `id`. `GET
/usage?customer_id=...` and assert exactly one matching row.

### TEID-31-T5
Repeat T31-T4's exact scenario `CONSUMPTION_ORDER_FUZZ_REPLICAS`-style
CI-scaled count of times (new env var
`IDEMPOTENCY_CONCURRENCY_FUZZ_ITERATIONS`, default scaled down for CI,
`1000` documented as the real target for a dedicated perf/fuzz pipeline,
matching TEID-18-T6's established convention), each iteration against a
fresh, distinct `idempotency_key` (so iterations don't interfere with each
other) and its own fresh customer or a shared one -- either is fine since
each iteration's key is unique. Assert zero iterations deviate from
"exactly one created, N-1 duplicates."

### TEID-31-T6
Functionally identical to T31-T4 in a single-process test environment (this
repo has no real multi-instance deployment to test against yet -- "two
different application server instances" is satisfied by two concurrent
requests against the one running `go-usage` process under test, the same
substitution TEID-17/18's specs already made for "the console UI" and
similar not-yet-built infrastructure). The meaningful assertion this test
adds beyond T31-T4 is **no unhandled error** on the losing side -- assert
both responses parse as valid JSON with a `2xx` status (`201` or `200`),
never a `500` or a raw driver error leaking through.

### TEID-31-T7
`POST /usage` with `quantity: 100.00`. Resend the same key with `quantity:
100.0000001` (same `customer_id`/`event_type`). Assert `409` (not `200`
duplicate) -- `decimal.Decimal.Equal`'s exact comparison means this tiny
difference is still detected. `GET /idempotency-conflicts` and assert the
flagged row's `attempted_quantity` is `100.0000001`, confirming the
comparison used exact decimal semantics, not a float-rounded or
truncated one.

## File layout

- `db/migrations/20260928091500_idempotency_conflicts.sql` -- new
  `idempotency_conflicts` table only; `usage_events` unchanged.
- `services/go-usage/internal/api/idempotency.go` -- new:
  `IdempotencyKeyRetentionDays`, `resolveIdempotencyConflict`,
  `recordConflict`.
- `services/go-usage/internal/api/usage.go` -- extend `postUsageSingle`'s
  and `postUsageBatch`'s `23505` handling to call the above; extend
  `batchResultItem` with the `"conflict"` status; change
  `postUsageSingle`'s duplicate response from `409` to `200
  {"status": "duplicate", ...}`.
- `services/go-usage/internal/api/idempotency_conflicts.go` -- new:
  `GetIdempotencyConflicts` handler.
- `services/go-usage/cmd/server/main.go` -- register
  `GET /idempotency-conflicts` as `admin`-scoped, alongside
  `/rounding-config`/`/customers/{id}/billing-config`.
- Tests: new directory `tests/idempotency/` (mirror
  `tests/usage-ingestion/`'s shape: own `package.json`/`tsconfig.json`/
  `vitest.config.ts`, shared `db.ts`/`env.ts`/`http.ts` helpers, direct-DB
  fixture helpers for T31-T2's backdated `created_at` seeding), implementing
  all 7 cataloged tests.
- CI: add install+test steps to `.github/workflows/ci.yml`'s `test` job for
  `tests/idempotency`, positioned after the existing `tests/usage-ingestion`
  step (both exercise `go-usage`, so keeping them adjacent matches the
  existing grouping of same-service suites).

## Definition of done

- [ ] All 4 acceptance criteria satisfied by working code (AC4 verified
      against already-shipped infrastructure per the scoping notes, not
      new mechanism).
- [ ] All 7 cataloged tests have real automated tests that pass --
      functional, non-functional, and adversarial alike.
- [ ] `go vet ./...` clean in `services/go-usage`.
- [ ] `tests/usage-ingestion`, `tests/billing-periods` (including
      `TEID-96-T8` unchanged, per the scoping notes on `occurred_at`),
      `tests/currency-rounding`, `tests/large-quantities`,
      `tests/cross-tenant`, `tests/data-export` (whose seed fixtures rely
      on `usage_events`'s untouched constraint) all still pass unchanged.
- [ ] Cross-tenant isolation proven in `tests/cross-tenant` for `GET
      /idempotency-conflicts` (a tenant must never see another tenant's
      flagged conflicts).
- [ ] Full suite passes against a database rebuilt from scratch via
      `db/setup-local.sh` plus the existing seed scripts.
- [ ] PR description maps each test ID to its file/line.
