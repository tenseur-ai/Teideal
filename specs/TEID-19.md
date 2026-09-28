# TEID-19: Annual commits with monthly drawdown

| | |
|---|---|
| Epic | TEID-1 (E01 -- Implement entitlement model and pricing configuration) |
| Phase | E01 |
| Priority | Highest |
| Points | 8 |
| Release | mvp |
| Order | 32 (within E01, directly after TEID-18) |
| Depends on | `grants`/`grant_ledger_entries` (TEID-17), `consumeAcrossGrants`/`CONSUMPTION_SOURCES` (TEID-18, `services/ts-console/src/lib/consumptionOrder.ts`), `recordConfigChangeWithClient` (TEID-42), `consoleRoute` (TEID-43) |

## Story (verbatim from the live board)

> As a billing operator, I want to set up an annual commit that customers draw down as they use the product, with an overage rate once it is used up, so that enterprise contracts are enforced exactly as signed.
>
> *Context*
> Example: a 250,000 USD annual commit drawn down monthly, with a contracted overage rate afterwards.

## Acceptance criteria (verbatim from the live board)

1. An operator can create a commit with amount, term start and end, drawdown schedule (upfront, monthly or quarterly) and overage rate.
2. Usage draws down the commit in real time and the remaining amount is visible at any moment.
3. Overage pricing starts at exactly the event that exhausts the commit; an event that straddles the boundary is split correctly.
4. At the end of the term, any unused commit is reported as a separate line for finance and does not carry over unless the contract says so.
5. Changes to a live commit require a reason and are recorded in the audit log.

## Cataloged tests (verbatim from the live board)

| ID | Type | AC | Title |
|---|---|---|---|
| TEID-19-T1 | Functional | 1 | Create a commit of 250000 USD with term 2026-01-01 to 2026-12-31, monthly drawdown schedule, and an overage rate of 0.0025 USD per token, and confirm the commit record stores all five fields correctly. |
| TEID-19-T2 | Functional | 2 | Submit usage events totaling 40000 USD against the 250000 USD commit and confirm the remaining-balance API returns exactly 210000 USD immediately after the last event. |
| TEID-19-T3 | Functional | 3 | With 500 USD remaining on the commit, submit a single usage event valued at 800 USD, and confirm the ledger splits it into a 500 USD commit-drawdown line and a 300 USD overage line priced at the contracted overage rate. |
| TEID-19-T4 | Functional | 4 | At the end of the 2026 term with 15000 USD of the 250000 USD commit unused and the contract set to non-carryover, confirm the closing report shows a separate unused-commit line of 15000 USD and the new term starts at zero balance. |
| TEID-19-T5 | Functional | 5 | Change the overage rate on a live in-term commit from 0.0025 to 0.003 USD per token with reason renegotiated Q3 pricing, and confirm the change appears in the audit log with the old value, new value, reason and operator. |
| TEID-19-T6 | Non-functional | 2 | Poll the commit remaining-balance endpoint at 1000 requests per second during active drawdown and confirm P99 response latency stays under 50 milliseconds with no stale reads older than 2 seconds. |
| TEID-19-T7 | Non-functional | 3 | Under a burst of 200 concurrent usage events landing within the same 100 millisecond window as the event that exhausts the commit, confirm the boundary-splitting logic still assigns overage correctly with no double-counted commit balance. |
| TEID-19-T8 | Adversarial | 3 | Submit two usage events with identical timestamps, one of which alone would exhaust the commit, and confirm the documented tie-break rule is applied deterministically rather than allowing both to be priced as if full commit balance were available. |
| TEID-19-T9 | Adversarial | 5 | Attempt to change a live commit's overage rate via the API without supplying a reason field, and confirm the request is rejected with a 400 error rather than silently applying the change. |

## Scoping notes for this point in the build sequence

This story is a direct continuation of TEID-17/TEID-18's grants and consumption
machinery, and inherits the same "no real usage-triggered consumption
pipeline yet" gap those two stories already documented (usage is still
submitted via the synthetic `POST /customers/:id/consume`, not a real
`go-usage` event -- see TEID-18's own scoping notes; unchanged here).

- **A commit is a `grants` row with `source = 'commit'`, not a new table.**
  TEID-17 already built the row shape (`amount`, `remaining_amount`,
  `start_date`, `expiry_date`, `status`) and TEID-18 already built the
  ordered, locking, splitting consumption engine that treats `'commit'` as
  one of its four source categories (`CONSUMPTION_SOURCES` in
  `consumptionOrder.ts`). A parallel `commits` table would force
  `consumeAcrossGrants` to lock and query a second table inside the same
  transaction for no benefit -- real added complexity, and more surface for
  the exact TEID-18-T8 concurrency bug class to reappear. `grants` gets four
  new nullable columns instead (below), all `NULL`/inapplicable for the
  three non-commit sources.
- **`expiry_date` is reused as "term end."** No separate `term_end` column.
  This is deliberate: `processExpiredGrants` (TEID-17) already treats
  `expiry_date` as "the grant stops being eligible for draw," which is
  exactly what "end of term" means for AC4 -- reusing it means the existing
  expiry worker is the natural place to add AC4's reporting/carryover
  behavior rather than inventing a second, parallel expiry concept.
- **"Drawdown schedule (upfront, monthly or quarterly)" is read as a real,
  storable release mechanism, not flavor text.** The alternative reading --
  that `remaining_amount = amount` is fully available from `start_date`
  exactly like every other grant today, and "drawn down monthly" merely
  describes usage cadence -- would make the `drawdown_schedule` field a
  no-op the operator sets but nothing ever reads. Given AC1 lists it
  alongside three other fields that are all real, structural configuration
  (amount, term, overage rate), the release-based reading is used: `upfront`
  releases the full `amount` into `remaining_amount` immediately (identical
  to today's `insertGrant` behavior, zero new machinery); `monthly`/
  `quarterly` release the first tranche at `start_date` (so the customer has
  a nonzero balance from day one, matching T19-T1/T2's expectation of an
  immediately-usable commit) and further tranches on each monthly/quarterly
  anniversary of `start_date` up to `expiry_date`, via a new worker
  (`processCommitDrawdowns`, modeled directly on `processExpiredGrants`'s
  per-tenant claim-and-settle shape).
- **Tranche count and sizing.** For `monthly`/`quarterly`, `expiry_date` is
  required (validation error if a non-upfront schedule has no expiry_date).
  Tranche count = `floor(monthsBetween(start_date, expiry_date) /
  intervalMonths) + 1` (`intervalMonths` = 1 for monthly, 3 for quarterly;
  the `+1` is the tranche released at `start_date` itself).
  `monthsBetween(a, b)` counts whole calendar-month steps from `a` to `b`
  using UTC calendar arithmetic on the stored timestamps directly (year*12 +
  month, comparing day-of-month/time-of-day only to decide whether the final
  partial month counts) -- **not** `services/go-usage/internal/period/
  period.go`'s `Boundaries` helper, which computes rolling, customer-local,
  anchor-day monthly invoicing periods relative to "now," a different
  concept from a fixed term's internal release schedule; it has no quarterly
  concept at all and would be the wrong tool here. Each tranche =
  `amount / trancheCount`, computed as `NUMERIC` division to the same
  precision the column itself stores, with the **last** tranche taking
  `amount - (tranche * (trancheCount - 1))` so the sum is exactly `amount`
  with no rounding drift (same "last one absorbs the remainder" pattern
  TEID-95 established for split arithmetic elsewhere in this repo).
- **AC3's overage rate resolution when a customer holds no eligible commit.**
  Only a `commit`-source grant carries `overage_rate`. When
  `consumeAcrossGrants` runs out of eligible grants and still has `needed >
  0`, it now checks: did the just-drawn-through set of grants include a
  `commit`-source one? If yes, that grant's own `overage_rate` prices the
  overage line. If the customer holds (and held, for this call) no eligible
  commit-source grant at all, the overage line stays unpriced (`NULL`,
  today's existing behavior) -- there is no rate to apply. This is
  deliberately grounded in the grants actually locked and drawn for *this*
  consumption call, not a separate "customer's most recent commit ever"
  lookup, so it can never disagree with what the response's own `lines`
  array shows.
- **AC4's carryover is implemented as a distinguishing ledger entry type,
  not automatic next-term grant creation.** None of the 9 cataloged tests
  exercise what happens to a carried-over balance afterward -- T19-T4 only
  tests the non-carryover path. Implementing an automatic "spawn a new
  commit for the next term" mechanic would be genuinely new, untested
  surface with no AC/test to pin its behavior (new term length? same
  overage rate? who triggers it?). Scoped instead to exactly what's
  testable: a `carries_over` boolean on the commit; at term end, a
  non-carrying commit's unused balance is reported via the existing
  `entry_type = 'expired'` ledger row (unchanged from TEID-17's behavior,
  which already satisfies "reported as a separate line" for the
  non-carryover case); a carrying commit's unused balance instead gets a new
  `entry_type = 'carried_over'` row for the same amount -- recorded and
  reportable, distinguishable from a real write-off, but not automatically
  re-issued. Flagged here explicitly, matching TEID-18's own practice of
  stating a real, honest scope boundary rather than leaving it implicit.
- **AC5's "amend" is a new endpoint; nothing like it exists today.** The
  only existing "edit a config object" pattern, `PATCH /plans/:id`, is
  explicitly restricted to `status = 'draft'` plans -- the opposite case
  from "changes to a **live** commit." Grants otherwise only ever have
  `void` (terminal) and `consume` (system-driven decrement) mutations.
  Scoped to a new `PATCH /grants/:id/amend`, restricted to `status =
  'active'` and `source = 'commit'`, amending only `overage_rate`,
  `expiry_date`, and `carries_over` -- **not** `amount` or
  `drawdown_schedule`, which no AC or test exercises changing mid-term and
  which would raise real unanswered questions (re-run the tranche schedule?
  from when?) that this story's tests don't pin down. T19-T5's own example
  changes only `overage_rate`.
- **T19-T6/T7's latency/concurrency budgets** follow the same CI-scaled
  env-var convention TEID-18-T6/T7 established
  (`COMMIT_BALANCE_LATENCY_BUDGET_MS`, `COMMIT_SPLIT_BURST_SIZE`) with the
  literal numbers from the board documented as the real target for a
  dedicated perf/fuzz pipeline, not the CI-scaled default.

## Architecture and design

### Schema: four new columns on `grants`, one new column on `usage_consumption_lines`, a wider `entry_type` check

New migration `db/migrations/20260928090000_commit_terms.sql`:

```sql
-- TEID-19: annual commits are grants rows (source = 'commit') carrying four
-- extra, commit-only fields. NULL/inapplicable for the other three sources.
ALTER TABLE grants ADD COLUMN IF NOT EXISTS drawdown_schedule TEXT
  CHECK (drawdown_schedule IN ('upfront', 'monthly', 'quarterly'));
ALTER TABLE grants ADD COLUMN IF NOT EXISTS overage_rate NUMERIC
  CHECK (overage_rate >= 0);
ALTER TABLE grants ADD COLUMN IF NOT EXISTS carries_over BOOLEAN NOT NULL DEFAULT false;
-- Drives processCommitDrawdowns's polling; NULL once no further tranche is
-- owed (upfront schedules, or a monthly/quarterly schedule's final tranche
-- already released).
ALTER TABLE grants ADD COLUMN IF NOT EXISTS next_release_at TIMESTAMPTZ;

-- The overage line's priced dollar amount when a commit's overage_rate
-- applies (see consumeAcrossGrants below). NULL when no commit rate applies,
-- matching today's unpriced-overage default.
ALTER TABLE usage_consumption_lines ADD COLUMN IF NOT EXISTS overage_amount_due NUMERIC
  CHECK (overage_amount_due >= 0);

-- Widen entry_type for AC1's drawdown tranches and AC4's carryover case.
-- grant_ledger_entries_entry_type_check is Postgres's default name for the
-- original single-column, unnamed CHECK in the TEID-17 migration.
ALTER TABLE grant_ledger_entries DROP CONSTRAINT grant_ledger_entries_entry_type_check;
ALTER TABLE grant_ledger_entries ADD CONSTRAINT grant_ledger_entries_entry_type_check
  CHECK (entry_type IN ('issued', 'expired', 'voided', 'released', 'carried_over'));
```

No new tables, no new RLS policies -- every touched table already has
tenant-isolating RLS from TEID-17/18's own migrations, and adding a column
does not change that.

### `POST /grants` extended for commit fields (AC1)

Extend `validateGrantInput`/`CreateGrantInput`
(`services/ts-console/src/lib/grants.ts`) with three new optional fields,
validated **only when `source === 'commit'`** (reject with `400` if any is
supplied for a non-commit source -- these fields are meaningless outside a
commit):

- `drawdown_schedule`: required when `source === 'commit'` (`400
  "drawdown_schedule is required for a commit"` if missing), must be one of
  `'upfront' | 'monthly' | 'quarterly'`.
- `overage_rate`: required when `source === 'commit'`, must be a finite
  number `>= 0`.
- `carries_over`: optional boolean, defaults to `false`.
- If `drawdown_schedule !== 'upfront'`, `expiry_date` becomes required (today
  it's already optional for other sources) -- `400 "expiry_date is required
  for a monthly or quarterly commit"` if missing.

`insertGrant` extended: for `source !== 'commit'` or `drawdown_schedule ===
'upfront'`, behavior is unchanged (`remaining_amount = amount` immediately,
`next_release_at = NULL`). For `monthly`/`quarterly`: compute `trancheCount`
and the first tranche per the scoping notes' formula, insert with
`remaining_amount = firstTranche` (not the full `amount`), and set
`next_release_at` to `start_date` advanced by one interval (the *second*
tranche's due date -- the first tranche is already released at row
insertion). `insertIssuedLedger`'s existing `entry_type: 'issued'` call still
fires once, for the *first* tranche amount only (matching "issued" meaning
"this grant came into existence," not "every tranche") -- later tranches use
the new `'released'` entry type via the worker below, not `'issued'` again.

### `processCommitDrawdowns` -- the tranche-release worker (AC1's schedule, AC2)

New function in `services/ts-console/src/lib/grantWorker.ts`, same
per-tenant claim-and-settle shape as `processExpiredGrants`:

```ts
async function releaseDueTranchesForTenant(client: PoolClient, now: Date): Promise<number> {
  const claimed = await client.query<DueCommit>(
    `SELECT id, tenant_id, amount::text, remaining_amount::text, start_date,
            expiry_date, drawdown_schedule, next_release_at
     FROM grants
     WHERE status = 'active' AND source = 'commit'
       AND next_release_at IS NOT NULL AND next_release_at <= $1
     FOR UPDATE SKIP LOCKED`,
    [now],
  );
  for (const row of claimed.rows) {
    const { trancheAmount, nextReleaseAt } = computeNextTranche(row); // shared helper, see below
    await client.query(
      `UPDATE grants SET remaining_amount = remaining_amount + $2::numeric, next_release_at = $3
       WHERE id = $1`,
      [row.id, String(trancheAmount), nextReleaseAt],
    );
    await client.query(
      `INSERT INTO grant_ledger_entries (tenant_id, grant_id, entry_type, amount)
       VALUES ($1, $2, 'released', $3::numeric)`,
      [row.tenant_id, row.id, String(trancheAmount)],
    );
  }
  return claimed.rows.length;
}

export async function processCommitDrawdowns(pool: Pool, now = new Date()): Promise<number> {
  let released = 0;
  for (const tenantId of await tenantIds(pool)) {
    released += await withTenant(pool, tenantId, (client) => releaseDueTranchesForTenant(client, now));
  }
  return released;
}
```

`computeNextTranche` is a pure function (new file
`services/ts-console/src/lib/commitSchedule.ts`, unit-testable without a
database) shared between `insertGrant`'s first-tranche computation and this
worker's later-tranche computation, so both use the exact same tranche-size
and date-arithmetic logic (the "last tranche absorbs the remainder" rule
must agree in both places, or T19-T1's stored amounts and the worker's later
releases could drift). It takes the row's `amount`, `start_date`,
`expiry_date`, `drawdown_schedule`, and which tranche index is next, and
returns that tranche's size and the timestamp after it (or `null` for
`nextReleaseAt` if this was the final tranche).

Register `processCommitDrawdowns` in `services/ts-console/src/server.ts`
alongside the existing `exportTimer`/`grantTimer` `setInterval` pattern
(guarded the same way, `NODE_ENV !== "test"`), on its own timer
(`COMMIT_DRAWDOWN_INTERVAL_MS`, matching the naming convention of
`EXPORT_WORKER_INTERVAL_MS`/`GRANT_WORKER_INTERVAL_MS` already in that file).
Tests call `processCommitDrawdowns(pool, fixedInstant)` directly, the same
way `tests/grants` already calls `processRecurringGrants`/
`processExpiredGrants` directly with a fixed `now` rather than waiting on the
timer.

### `GET /grants/:id` and `/grants/:id/eligibility` -- already sufficient (AC2)

No changes needed. `remaining_amount` on the existing `GrantRecord` is
already the live balance for a commit exactly as for any other grant, and
`shapeGrantRecord` already returns it. T19-T2/T6 exercise these unchanged
existing endpoints.

### `consumeAcrossGrants` extended for priced overage (AC3)

In `services/ts-console/src/lib/consumptionOrder.ts`:

- `DrawableGrant`/`LockedGrantRow` gain an `overage_rate: number | null`
  field, and `lockEligibleGrants`'s `SELECT` list gains
  `overage_rate::text AS overage_rate`.
- Inside the draw loop (`consumeAcrossGrants`'s `for (const grant of
  sorted)`), track `let lastCommitOverageRate: number | null = null;` --
  updated to `grant.overage_rate` every time a `commit`-source grant is
  drawn from (whether or not it was fully exhausted by this call; per the
  scoping notes, this reflects "the commit this call actually touched," not
  a separate lookup).
- In the existing `if (needed > 0) { ... }` overage branch: if
  `lastCommitOverageRate !== null`, compute `overageAmountDue = needed *
  lastCommitOverageRate` and include it in the `INSERT INTO
  usage_consumption_lines (..., overage_amount_due) VALUES (..., $N)` call
  (new column) and in the returned `ConsumptionLine` (new optional field
  `overage_amount_due?: number`). If `lastCommitOverageRate === null`,
  behavior is unchanged (`overage_amount_due` stays `NULL`, field omitted
  from the response line).

This is the same mechanism T19-T3 exercises directly: a single 800 USD
event against a commit with 500 USD remaining draws 500 from the commit
(a normal grant-draw line, unchanged), then prices the remaining 300 as
`300 * overage_rate` in the new `overage_amount_due` field on the overage
line.

### `processExpiredGrants` extended for AC4

In `services/ts-console/src/lib/grantWorker.ts`'s `expireForTenant`: when
the expiring row is a `commit`-source grant, read its `carries_over` flag
(add it to the existing claim query's `SELECT`) and use `entry_type =
'carried_over'` instead of `'expired'` for the final ledger row when
`carries_over` is `true`; otherwise unchanged (`'expired'`, exactly as
today). The grant's `status` still becomes `'expired'` in both cases -- "the
new term starts at zero balance" (T19-T4) means *this* grant stops being
drawable either way; only the ledger's characterization of the leftover
amount differs.

### `GET /grant-ledger-entries` -- add `entry_type` and `source` filters (AC4's "reported... for finance")

`validateLedgerFilters`/`LedgerFilters`
(`services/ts-console/src/lib/grants.ts`) gain two new optional query
params: `entry_type` (must be one of the five valid values) and `source`
(must be one of the four grant sources, requires joining `grants.source` --
`listLedgerEntries`'s query already `JOIN`s `grants g`, so this is one more
`WHERE` clause, not a new join). This makes T19-T4's "closing report" a real,
filterable query finance can run (`?entry_type=expired&source=commit` or
`?entry_type=carried_over`) rather than requiring a client to fetch
everything and filter in memory.

### `PATCH /grants/:id/amend` -- amending a live commit (AC5)

New handler in `services/ts-console/src/routes/grants.ts`, Owner or Billing
Admin only, session-authed via `consoleRoute`. Body: `{reason: string,
overage_rate?: number, expiry_date?: string, carries_over?: boolean}` --
`reason` is mandatory (`400` if missing/empty, reusing
`validateVoidInput`'s exact non-empty-string check, renamed/generalized to
`validateReason` since void and amend now share it) and at least one
amendable field must be present (`400 "at least one field must change"` if
the body has a reason but nothing else). New `validateAmendCommitInput` in
`lib/grants.ts` validates the optional fields with the same rules
`validateGrantInput` already uses for each (`overage_rate >= 0`,
`expiry_date` via `parseExplicitTimestamp`).

New `amendCommit` in `lib/grants.ts`:

```ts
export async function amendCommit(
  client: PoolClient, tenantId: string, grantId: string,
  changes: { overage_rate?: number; expiry_date?: Date; carries_over?: boolean },
): Promise<{ before: GrantRecord; after: GrantRecord } | null> {
  const before = await readGrant(client, tenantId, grantId);
  if (!before || before.status !== "active" || before.source !== "commit") return null;
  // UPDATE ... SET <only the supplied columns> WHERE id = $1 AND tenant_id = $2
  //   AND status = 'active' -- re-checked in the WHERE clause, not just read
  //   above, so a concurrent void/expiry between the read and this write
  //   cannot amend an already-dead commit.
  const updated = await client.query(`UPDATE grants SET ... WHERE id = $1 AND tenant_id = $2 AND status = 'active' RETURNING id`, [...]);
  if ((updated.rowCount ?? 0) === 0) return null;
  const after = await readGrant(client, tenantId, grantId);
  if (!after) throw new Error("amended commit was not readable");
  return { before, after };
}
```

Route calls `recordConfigChangeWithClient` with `objectType: "Grant"`,
`objectId: id`, `before`/`after` the full `GrantRecord` (matching every
other grant mutation's existing shape) -- T19-T5 asserts the audit entry's
`before`/`after` JSON shows the old and new `overage_rate`, and the
top-level `reason`/`actor_user_id` columns already on `audit_log` cover
"reason and operator." Returns `404` if the commit doesn't exist for this
tenant, `409` (reusing the existing `VOID_CONFLICT`-style message, worded
for amend) if it exists but isn't an active commit.

## Implementation guidance per test

### TEID-19-T1
`POST /grants` with `source: "commit"`, `amount: 250000`, `unit: "USD"`,
`start_date: "2026-01-01T00:00:00Z"`, `expiry_date: "2026-12-31T23:59:59Z"`,
`drawdown_schedule: "monthly"`, `overage_rate: 0.0025`. Assert `201` and
that the returned record's `amount`, `start_date`, `expiry_date`,
`drawdown_schedule`, `overage_rate` all match exactly what was sent (the
"stores all five fields correctly" -- the fifth being the schedule itself).
Also assert `remaining_amount` equals the first monthly tranche (`amount /
trancheCount`, per the scoping notes' formula), not the full `250000` --
this is the direct, concrete check that the release-based reading of AC1
was implemented, not the "fully available immediately" alternative reading.

### TEID-19-T2
Using T1's commit, submit consumption calls via `POST
/customers/:id/consume` totaling `40000` USD against it (a customer holding
only this one commit-source grant, so the full amount draws from it,
assuming the tranches already released cover 40000 -- seed the test with an
`upfront`-schedule commit instead, or advance `processCommitDrawdowns`
enough ticks first, whichever keeps the test simplest; either is a fair
reading of "usage draws down the commit in real time"). Immediately after
the last event, `GET /grants/:id` and assert `remaining_amount` is exactly
`210000`.

### TEID-19-T3
One customer, one `upfront`-schedule commit with `overage_rate: 0.0025`
and `remaining_amount: 500` (seed directly at that balance, e.g. via a
smaller `amount` or a preceding consumption). `POST
/customers/:id/consume` with `amount: 800`. Assert the response's `lines`
array has exactly two entries: `{grant_id: <commit id>, source_category:
"commit", amount: 500}` and `{grant_id: null, source_category: "overage",
amount: 300, overage_amount_due: 0.75}` (`300 * 0.0025`).

### TEID-19-T4
One customer, one `upfront`-schedule commit, `amount: 250000`,
`carries_over: false`, `expiry_date` set to a near-future fixed instant.
Consume `235000` (leaving `15000` remaining). Call
`processCommitDrawdowns`/`processExpiredGrants` with a fixed `now` past the
`expiry_date`. Assert: `GET /grant-ledger-entries?grant_id=<id>` (or the new
`?entry_type=expired&source=commit` filter) shows a `-15000` `entry_type:
'expired'` row; `GET /grants/:id` now shows `status: 'expired'` ("the new
term starts at zero balance" -- this grant no longer participates in any
future draw).

### TEID-19-T5
An active `monthly` or `upfront` commit with `overage_rate: 0.0025`. `PATCH
/grants/:id/amend` with `{reason: "renegotiated Q3 pricing", overage_rate:
0.003}`. Assert `200` and the response's `overage_rate` is now `0.003`.
`GET /grant-ledger-entries` won't show this (amend isn't a balance event --
see scoping notes) -- instead query `audit_log` directly (via the test's own
`withTenant`/superuser pool, the same pattern `tests/grants` already uses
for ledger assertions) and assert the matching `config_change` row's
`before`/`after` JSON show `overage_rate: 0.0025` -> `0.003`, and that the
row's `actor_user_id` matches the calling operator.

### TEID-19-T6
`upfront`-schedule commit with a large `remaining_amount`. Fire
`COMMIT_BALANCE_LATENCY_BUDGET_MS`-scaled-down concurrent `GET
/grants/:id` requests (env-var-scaled per the scoping notes, default e.g.
50 req/s for a few seconds in CI, with `1000`/`50ms` documented as the real
target) while a background loop keeps consuming small amounts against it.
Assert P99 latency stays under the budget and that no returned
`remaining_amount` is stale by more than the CI-scaled equivalent of "2
seconds" (in practice: since every read is a direct, uncached `SELECT`
against the row, staleness beyond normal query latency shouldn't be
possible -- assert this property holds rather than assuming it trivially
does, the same rigor TEID-18-T6 applied to its own determinism claim).

### TEID-19-T7
One customer, one commit with `remaining_amount` sized so it's exhausted
partway through a burst. Fire `COMMIT_SPLIT_BURST_SIZE`-scaled concurrent
`POST /customers/:id/consume` calls (default e.g. 20 in CI, `200` documented
as the real target) within a tight time window. Assert: summing every
returned line's `amount` for the commit-source grant across all responses
never exceeds the commit's starting `remaining_amount` (no double-counted
balance -- the same property TEID-18-T8 already proved for the general
`FOR UPDATE`-locking mechanism; this test proves it holds specifically at a
commit's exhaustion boundary under concurrent load) and that every response
whose lines include an `overage` line prices it with the correct
`overage_rate`.

### TEID-19-T8
One customer, one commit with `remaining_amount` exactly enough for one of
two identically-timestamped consumption requests (construct both requests
with the same `as_of` value). Fire both (e.g. via `Promise.all`). Assert:
exactly one succeeds with the full amount drawn from the commit and the
other's shortfall becomes an overage line -- **not** both partially
succeeding as if double the balance were available. Document the specific
tie-break outcome this implementation produces (which of the two "wins" the
full commit balance) in `NOTES-TEID-19.md` if the AC doesn't mandate one --
the property under test is determinism/no-double-spend, not which of two
identically-timed requests wins, mirroring how TEID-18-T8 was scoped.

### TEID-19-T9
`PATCH /grants/:id/amend` on an active commit with `{overage_rate: 0.003}`
-- no `reason` field. Assert `400` and that the commit's `overage_rate` is
unchanged afterward (`GET /grants/:id`).

## File layout

- `db/migrations/20260928090000_commit_terms.sql` -- `grants.
  drawdown_schedule`/`overage_rate`/`carries_over`/`next_release_at`,
  `usage_consumption_lines.overage_amount_due`, widened
  `grant_ledger_entries.entry_type` check.
- `services/ts-console/src/lib/commitSchedule.ts` -- new: pure
  `computeNextTranche`/tranche-count/date-arithmetic helpers, shared by
  `insertGrant` and `processCommitDrawdowns`.
- `services/ts-console/src/lib/grants.ts` -- extend `validateGrantInput`/
  `CreateGrantInput`/`insertGrant` for the three new commit fields; add
  `validateAmendCommitInput`, `amendCommit`; generalize
  `validateVoidInput`'s reason check into a shared `validateReason` used by
  both void and amend; extend `validateLedgerFilters`/`LedgerFilters`/
  `listLedgerEntries` with `entry_type`/`source`.
- `services/ts-console/src/lib/grantWorker.ts` -- add
  `processCommitDrawdowns`/`releaseDueTranchesForTenant`; extend
  `expireForTenant` for the `carries_over` -> `'carried_over'` branch.
- `services/ts-console/src/lib/consumptionOrder.ts` -- extend
  `DrawableGrant`/`LockedGrantRow`/`lockEligibleGrants` with
  `overage_rate`; extend `consumeAcrossGrants`'s overage branch to price it.
- `services/ts-console/src/routes/grants.ts` -- new `PATCH
  /grants/:id/amend` handler.
- `services/ts-console/src/server.ts` -- register `processCommitDrawdowns`
  on its own `setInterval` (`COMMIT_DRAWDOWN_INTERVAL_MS`), same guard
  pattern as the existing `exportTimer`/`grantTimer`.
- Tests: new directory `tests/commits/` (mirror `tests/grants/`'s shape:
  own `package.json`/`tsconfig.json`/`vitest.config.ts`, shared
  `db.ts`/`env.ts`/`http.ts`/`session.ts`), implementing all 9 cataloged
  tests.
- `tests/cross-tenant/commit-isolation.test.ts` -- new: cross-tenant case
  for `POST /grants` (commit fields), `PATCH /grants/:id/amend`, and the
  ledger filter additions, matching `grant-isolation.test.ts`'s shape.
- CI: add steps to `.github/workflows/ci.yml`'s `test` job to install and
  run `tests/commits`, positioned after the existing `tests/consumption-order`
  step.

## Definition of done

- [ ] All 5 acceptance criteria satisfied by working code (AC4's carryover
      scoped to a distinguishing ledger entry type, not automatic next-term
      grant creation, per the scoping notes).
- [ ] All 9 cataloged tests have real automated tests that pass --
      functional, non-functional, and adversarial alike.
- [ ] `tsc --noEmit` clean in `services/ts-console`; the new
      `PATCH /grants/:id/amend` route goes through `consoleRoute`.
- [ ] `tests/cross-tenant`, `tests/console-auth`, `tests/audit-log`,
      `tests/api-keys`, `tests/rbac`, `tests/data-export`, `tests/plans`,
      `tests/grants`, `tests/consumption-order` all still pass unchanged.
- [ ] Cross-tenant isolation proven in `tests/cross-tenant` for every new/
      changed endpoint (`POST /grants` commit fields, `PATCH
      /grants/:id/amend`, `GET /grant-ledger-entries`'s new filters).
- [ ] Full suite passes against a database rebuilt from scratch via
      `db/setup-local.sh` plus the existing seed scripts.
- [ ] PR description maps each test ID to its file/line.
