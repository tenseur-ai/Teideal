# TEID-34: Handle late-arriving events

| | |
|---|---|
| Epic | TEID-3 (E03 -- Build usage ingestion and exactly-once ledger) |
| Phase | E03 |
| Priority | High |
| Points | 8 |
| Release | mvp |
| Order | 20 (immediately after TEID-35) |
| Depends on | `period.Boundaries` (TEID-96), `customer_billing_config` (TEID-96), `usage_events`/`PostUsage` (TEID-30/31), `GET /usage` (TEID-30) |

## Story (verbatim from the live board)

> As a finance lead, I want usage that arrives after its billing period has closed to be handled visibly and with approval, so that invoices never change silently.
>
> *Context*
> The time the event happened, not the time it arrived, decides which period it belongs to.

## Acceptance criteria (verbatim from the live board)

1. An event is assigned to the billing period in which it happened.
2. If that period is still open, the event is applied normally.
3. If the period is closed, the event goes into an adjustments queue instead of changing the closed invoice.
4. An operator can approve or reject queued adjustments, and can set automatic approval below a value threshold.
5. Approved adjustments appear on the next invoice as clearly labelled prior-period lines.

## Cataloged tests (verbatim from the live board)

| ID | Type | AC | Title |
|---|---|---|---|
| TEID-34-T1 | Functional | 1 | Submit an event timestamped for March 15 that arrives on April 3, after March's period has closed, and confirm it is assigned to the March period based on when it happened, not when it arrived. |
| TEID-34-T2 | Functional | 2 | Submit a late-arriving event timestamped for the current, still-open period and confirm it is applied immediately to the live balance with no queueing. |
| TEID-34-T3 | Functional | 3 | Submit an event for a period that closed 5 days ago and confirm the already-issued invoice's stored total is unchanged, with the event instead placed in the adjustments queue in a pending state. |
| TEID-34-T4 | Functional | 4 | As an operator, approve one queued adjustment and reject another, confirming the approved one is scheduled for billing and the rejected one is excluded; then set an auto-approval threshold of $10 and confirm a $5 adjustment auto-approves while a $50 adjustment still requires manual review. |
| TEID-34-T5 | Functional | 5 | After approving a $30 late adjustment originally for March, confirm it appears on the next invoice as a distinctly labeled Prior Period Adjustment line item rather than being blended into that period's regular usage charges. |
| TEID-34-T6 | Non-functional | 4 | Confirm an operator can triage a queue of 50 pending adjustments, approve, reject, or view detail, in under 10 minutes using the adjustments review screen. |
| TEID-34-T7 | Adversarial | 3 | Submit 200 late-arriving events for the same closed period simultaneously and confirm none of them mutate the closed invoice's stored totals, and all 200 land correctly in the adjustments queue with no data loss or duplication. |
| TEID-34-T8 | Adversarial | 4 | Attempt to set the auto-approval threshold via direct API manipulation to an invalid value, such as -1 or 999999999, and confirm the system rejects it rather than silently auto-approving everything or nothing unexpectedly. |

## Scoping notes for this point in the build sequence

- **"Closed" is computed, not stored -- reusing TEID-96's existing
  `period.Boundaries` function exactly, not a parallel implementation.**
  A period is closed the instant `now() >= end` for that period's own
  `[start, end)` (the same exclusive-end boundary TEID-96 already
  defines and tests). No new "is this period closed" table or flag is
  needed; `PostUsage` computes it inline per request, the same way it
  already resolves `occurred_at` today.
- **"Invoice" does not exist as a table anywhere in this codebase --
  confirmed by grep, same gap TEID-74's spec hits.** AC3/AC5's "closed
  invoice"/"next invoice" are scoped to the only real, persisted
  artifact this system has for a period: the set of `usage_events` rows
  whose `occurred_at` falls in that period. "The closed invoice's
  stored total is unchanged" (**T3**) concretely means: a late event
  for a closed period is never inserted into `usage_events` until an
  operator approves it, so any future total computed by summing that
  period's events is unaffected until then. **T5**'s "next invoice...
  Prior Period Adjustment line" is a new `usage_events.is_prior_period_adjustment`
  boolean, `false` for every event ingested through the existing normal
  path, `true` only for an approved adjustment -- the queryable
  distinction a future invoice-rendering story would filter on. `GET
  /usage` (already existing, TEID-30) gains a matching
  `prior_period_adjustments=true` filter as this story's concrete
  "appears... as a clearly labelled line" surface.
- **The auto-approval threshold compares directly against `quantity`,
  not a computed dollar amount.** Pricing/rate resolution is
  `services/ts-console`'s domain (TEID-20); `go-usage`'s ingestion path
  has never called out to it and does not start here -- doing so would
  add a synchronous cross-service call to the hot ingestion path for a
  threshold check alone. **T4**'s dollar figures ($10 threshold, $5/$50
  adjustments) are realized in tests via a 1:1 quantity-to-dollar
  fixture convention (matching how TEID-33's own `receivable` ledger
  amounts are treated as abstract NUMERIC "dollars" with no real
  pricing engine behind them) -- the threshold field and comparison are
  real; only the "quantity happens to equal dollars" convention is a
  test-fixture simplification, documented here rather than silently
  assumed.
- **T8's upper bound is a stated, defensible policy number, not given
  literally by the catalog.** The catalog only says "invalid," naming
  `-1` (negative, already excluded by a `CHECK >= 0`) and
  `999999999` (implausibly large) as examples without stating the real
  ceiling. This story sets the ceiling at 1,000,000 (documented here as
  a sanity bound an operator is exceedingly unlikely to need and a
  typo is exceedingly likely to produce) -- large enough not to
  constrain any real use, small enough to catch `999999999`-shaped
  input errors.
- **T7's "200 simultaneous events, no data loss or duplication" reuses
  TEID-31's existing idempotency-key uniqueness pattern, applied to the
  new queue table.** `usage_adjustments` gets the same
  `UNIQUE (tenant_id, idempotency_key)` constraint `usage_events`
  already has, so 200 concurrent late-arriving submissions serialize on
  Postgres's own constraint exactly the way TEID-31 already proved for
  the normal ingestion path -- no new concurrency primitive.

## Architecture and design

### Schema: one column on an existing table, one new table

New migration `db/migrations/20260929121500_late_arriving_events.sql`:

```sql
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS is_prior_period_adjustment BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE customer_billing_config ADD COLUMN IF NOT EXISTS auto_approve_adjustment_threshold NUMERIC
  CHECK (auto_approve_adjustment_threshold IS NULL OR (auto_approve_adjustment_threshold >= 0 AND auto_approve_adjustment_threshold <= 1000000));

CREATE TABLE IF NOT EXISTS usage_adjustments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id),
  event_type TEXT NOT NULL,
  quantity NUMERIC NOT NULL,
  idempotency_key TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  auto_approved BOOLEAN NOT NULL DEFAULT false,
  reviewed_by_user_id UUID REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  resulting_usage_event_id UUID REFERENCES usage_events(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key)
);
ALTER TABLE usage_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_adjustments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_usage_adjustments ON usage_adjustments;
CREATE POLICY tenant_isolation_usage_adjustments ON usage_adjustments
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON usage_adjustments TO teideal_app;
```

### `PostUsage` -- one new decision point (AC1, AC2, AC3, T1, T2, T3, T7)

`services/go-usage/internal/api/usage.go`'s existing handler, extended
right before its existing idempotency/insert step: reads
`customer_billing_config` for the event's customer (defaulting to
`UTC`/anchor day 1 if no row exists, matching TEID-96's own existing
default), calls `period.Boundaries(tz, anchorDay, occurredAt)`.

- If `now() < end` (**T2**, the open-period path): completely
  unchanged -- inserts into `usage_events` exactly as today, with
  `is_prior_period_adjustment = false`.
- If `now() >= end` (**T1**, **T3**, **T7**, the closed-period path):
  checks the event's `quantity` against
  `customer_billing_config.auto_approve_adjustment_threshold`:
  - If a threshold is set and `quantity <= threshold`: in one
    transaction, inserts a `usage_adjustments` row
    (`status = 'approved'`, `auto_approved = true`) **and** the real
    `usage_events` row (`is_prior_period_adjustment = true`), linking
    `resulting_usage_event_id`. Returns `201`, matching the normal
    ingestion response shape.
  - Otherwise: inserts **only** the `usage_adjustments` row
    (`status = 'pending'`) -- `usage_events` is not touched. Returns
    `202 {"status": "queued_for_review", "adjustment_id": ...}`.
  Either way, the `UNIQUE (tenant_id, idempotency_key)` constraint on
  `usage_adjustments` gives this path the same exactly-once guarantee
  TEID-31 already established for the normal path.

### `POST /adjustments/{id}/approve` and `POST /adjustments/{id}/reject` (AC4, T4)

New handlers in `services/go-usage/internal/api/adjustments.go`,
registered `admin`-scoped in `main.go` (matching TEID-32/33's existing
precedent of serving operator actions directly from go-usage, not
proxied through ts-console). Both `SELECT ... FOR UPDATE` the
`usage_adjustments` row, require `status = 'pending'` (`409` otherwise).
Approve: inserts the real `usage_events` row
(`is_prior_period_adjustment = true`) in the same transaction, sets
`status = 'approved'`, `reviewed_by_user_id`, `reviewed_at`,
`resulting_usage_event_id`. Reject: sets `status = 'rejected'`,
`reviewed_by_user_id`, `reviewed_at` -- never touches `usage_events`.

### `GET /adjustments?status=` (AC4, T6 -- review-screen stand-in)

Same file, `admin`-scoped. Lists `usage_adjustments` filtered by
status, ordered by `created_at`. The stand-in for the "adjustments
review screen" **T6** references -- no UI exists anywhere in this
repo, matching every prior story's established pattern.

### `PUT /customers/{id}/billing-config` -- one field added (AC4, T8)

`services/go-usage/internal/api/period.go`'s existing handler
(TEID-96), extended to accept an optional
`auto_approve_adjustment_threshold` in its request body, validated
against the new `CHECK` constraint's bounds (`0` to `1,000,000`) before
the update -- a value outside that range is rejected `400` before any
write, satisfying **T8** without a new endpoint.

### `GET /usage` -- one filter added (AC5, T5)

`services/go-usage/internal/api/usage.go`'s existing listing handler
(TEID-30), extended with an optional `prior_period_adjustments=true`
query filter (`WHERE is_prior_period_adjustment = true`), the concrete
"appears... as a clearly labelled line" surface **T5** checks.

## Implementation guidance per test

### TEID-34-T1
Set a customer's billing config so March's period has already closed
relative to the test's simulated "now." `POST /usage` with
`occurred_at` in mid-March. Assert `202`, a `usage_adjustments` row
with `period_start`/`period_end` matching March's real boundaries
(computed via `period.Boundaries` independently in the test), and no
new `usage_events` row.

### TEID-34-T2
`POST /usage` with `occurred_at` in the current, still-open period.
Assert `201` and a normal `usage_events` row with
`is_prior_period_adjustment = false`, applied immediately (readable via
`GET /usage` right away).

### TEID-34-T3
Seed 5 days of "closed period" elapsed time (via the same billing-config/
simulated-now technique as T1). `POST /usage` for that closed period.
Assert `202`, a `pending` `usage_adjustments` row, and that summing
`usage_events` for that period (the "closed invoice's stored total"
stand-in) is unchanged from before the submission.

### TEID-34-T4
Create two pending adjustments. `POST /adjustments/{id}/approve` on one,
`POST /adjustments/{id}/reject` on the other. Assert the approved one
now has a linked `usage_events` row (`is_prior_period_adjustment =
true`) and the rejected one has none. Set
`auto_approve_adjustment_threshold = 10` via the billing-config
endpoint. Submit a closed-period event with `quantity = 5`: assert
`201`, auto-approved, immediate `usage_events` row. Submit one with
`quantity = 50`: assert `202`, pending.

### TEID-34-T5
Approve a `quantity = 30` closed-period adjustment originally submitted
for March. `GET /usage?prior_period_adjustments=true`. Assert the
resulting event is included and `is_prior_period_adjustment` reads
`true`; a plain `GET /usage` for March's own period (excluding the
filter) still separates it out, not blended into March's original
total.

### TEID-34-T6
Seed 50 pending `usage_adjustments`. Time an operator script that lists
(`GET /adjustments?status=pending`), approves, rejects, and reads detail
for all 50 via the real endpoints. Assert the full pass completes in
under 10 minutes (in practice, a network/DB-bound loop over 50 items
comfortably clears this).

### TEID-34-T7
Fire 200 concurrent `POST /usage` calls for the same closed period and
customer, each with a distinct `idempotency_key`. Assert all 200 land
as `usage_adjustments` rows (no loss), no duplicates (200 distinct
rows, `UNIQUE` constraint never violated across genuinely distinct
keys), and zero new `usage_events` rows for that period.

### TEID-34-T8
`PUT /customers/{id}/billing-config` with
`auto_approve_adjustment_threshold: -1`. Assert `400`, config
unchanged. Repeat with `999999999`. Assert `400`, config unchanged.

## File layout

- `db/migrations/20260929121500_late_arriving_events.sql` --
  `usage_events.is_prior_period_adjustment`,
  `customer_billing_config.auto_approve_adjustment_threshold`, new
  `usage_adjustments` table.
- `services/go-usage/internal/api/usage.go` -- extended: `PostUsage`'s
  closed-period branch, `GetUsage`'s new filter.
- `services/go-usage/internal/api/adjustments.go` -- new: `POST
  /adjustments/{id}/approve`, `POST /adjustments/{id}/reject`, `GET
  /adjustments`.
- `services/go-usage/internal/api/period.go` -- extended:
  `PutBillingConfig` accepts and validates
  `auto_approve_adjustment_threshold`.
- `services/go-usage/cmd/server/main.go` -- register the three new
  routes.
- Tests: new directory `tests/late-adjustments/` implementing all 8
  cataloged tests, following `tests/ledger/`'s conventions (a
  one-shot Go test helper if any assertion needs to observe simulated-
  time behavior TypeScript alone can't drive).

## Definition of done

- [ ] All 5 acceptance criteria satisfied by working code.
- [ ] All 8 cataloged tests have real automated tests that pass --
      functional, non-functional, and adversarial alike.
- [ ] `go vet ./...` clean in `services/go-usage`.
- [ ] `tests/usage-ingestion` (TEID-30/31, unchanged), `tests/billing-periods`
      (TEID-96, unchanged), `tests/idempotency`, `tests/cross-tenant` all
      still pass unchanged.
- [ ] Full suite passes against a database rebuilt from scratch via
      `db/setup-local.sh` plus the existing seed scripts.
- [ ] PR description maps each test ID to its file/line.
