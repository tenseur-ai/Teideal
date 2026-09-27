# TEID-17: Issue credit grants with expiry

| | |
|---|---|
| Epic | TEID-1 (E01 -- Implement entitlement model and pricing configuration) |
| Phase | E01 |
| Priority | Highest |
| Points | 5 |
| Release | mvp |
| Order | 30 (within E01, directly after TEID-16) |
| Depends on | `consoleRoute`/`ConsoleAuth` (TEID-43), `recordConfigChangeWithClient` (TEID-42), `ROLES`/`Role` (`services/ts-console/src/lib/users.ts`), `requireSession` (TEID-91), `customers` (TEID-41) |

## Story (verbatim from the live board)

> As a billing operator, I want to give a customer prepaid, recurring or promotional credits, each with its own start and expiry date, so that I can run promotions and sell credit packs without manual balance edits.
>
> *Context*
> Grants are the only way credits enter a customer's balance. Every grant must be traceable.

## Acceptance criteria (verbatim from the live board)

1. A grant records amount, unit or currency, source (paid, promotional, commit, goodwill), start date, optional expiry date and the person or system that created it.
2. A grant cannot be consumed before its start date or after its expiry time (evaluated in UTC).
3. When a grant expires with unused credit, the system writes a ledger entry for the expired amount so finance can report it.
4. A recurring grant is issued exactly once per period, even if the scheduler runs twice or retries after a failure.
5. An operator can void a grant with a mandatory reason; voiding writes a reversing ledger entry and never deletes history.

## Cataloged tests (verbatim from the live board)

| ID | Type | AC | Title |
|---|---|---|---|
| TEID-17-T1 | Functional | 1 | Issue a grant of 1000 USD promotional credit with source promotional, start date 2026-10-01, expiry 2026-10-31, created by operator ops@teideal.com, and confirm all six fields are stored and returned exactly on GET /v1/grants/{id}. |
| TEID-17-T2 | Functional | 2 | Create a grant with start date set to tomorrow and attempt to consume it today via a usage event, confirming the check is denied with insufficient balance, then advance to the start date and confirm the same event now succeeds. |
| TEID-17-T3 | Functional | 3 | Create a grant of 500 credits expiring at 2026-11-01T00:00:00Z with 200 credits unused, let it expire, and confirm a ledger entry for exactly 200 expired credits appears the next day and is visible in the finance report. |
| TEID-17-T4 | Functional | 4 | Configure a monthly recurring grant of 100 credits, trigger the issuance scheduler twice in the same period plus simulate one retry after a forced failure, and confirm exactly one grant of 100 credits is issued for that period. |
| TEID-17-T5 | Functional | 5 | Void an active grant of 300 credits with reason duplicate promotion applied, and confirm the original grant remains in the history unaltered while a reversing ledger entry of -300 credits is created. |
| TEID-17-T6 | Non-functional | 4 | Run the recurring grant scheduler for 10000 customers simultaneously at the monthly boundary and confirm every customer receives exactly one grant with no duplicates and the batch completes within 15 minutes. |
| TEID-17-T7 | Non-functional | 2 | Query the grant consumption eligibility check under a load of 2000 requests per second and confirm P99 latency for the UTC start and expiry evaluation stays under 10 milliseconds. |
| TEID-17-T8 | Adversarial | 2 | Issue a grant with expiry set to 2026-09-26T23:59:59Z and submit a usage event timestamped exactly 2026-09-27T00:00:00Z from a client in UTC-8, confirming the event is correctly denied against the grant based on UTC evaluation, not local time. |
| TEID-17-T9 | Adversarial | 5 | Attempt to void the same grant twice in rapid concurrent requests and confirm only one reversing ledger entry is created, not two. |

## Scoping notes for this point in the build sequence

This is the story TEID-44's spec explicitly flagged as missing
("'Grants' (AC1) don't exist as a feature at all... Revisit when TEID-17
lands") -- it's landing now, in `services/ts-console` (E01, this
story's own phase), not `services/go-usage`. Several ACs and tests are
written assuming machinery that doesn't exist yet:

- **No real usage-triggered consumption or real-time entitlement check
  exists.** TEID-2 ("real-time authorization and entitlement checks",
  the epic that would let an actual usage event on the hot path consume
  a grant) is phase-2 and not started; building that here would mean
  `services/ts-console` reaching into `services/go-usage`'s usage-event
  ingestion path, crossing into a different developer agent's phase and
  file set -- exactly the risk TEID-44's own spec already reasoned
  through and avoided for a much narrower case (a read-only query).
  Instead, this story models consumption **within the credits ledger it
  owns**: `grants.remaining_amount` starts equal to the issued amount,
  and `POST /grants/:id/consume` (a synthetic stand-in, the same role
  `POST /money/preview` plays for TEID-94's invoicing) decrements it
  after the same start/expiry eligibility check a real hot-path caller
  would need. T17-T2's "attempt to consume it... via a usage event" and
  T17-T8's "submit a usage event" are both scoped to calling this
  endpoint instead of a real `go-usage` usage event -- the mechanism
  under test (UTC start/expiry evaluation gating consumption) is
  identical either way, and this is the literal mechanism TEID-2 will
  call once it exists.
- **T17-T3's "with 200 credits unused" requires knowing 300 of 500 were
  already consumed.** The test explicitly drives this through
  `POST /grants/:id/consume` first (consume 300, leaving
  `remaining_amount = 200`), then lets the grant expire and asserts the
  expiry ledger entry is for exactly that 200 -- "unused" is
  `remaining_amount` at the moment of expiry, which is well-defined
  precisely because this story tracks it explicitly rather than trying
  to infer it from a usage pipeline that doesn't exist yet.
- **No computed ledger/balance exists yet** (TEID-33, epic E03, not
  started -- the same gap TEID-44's spec already navigated for usage
  events). This story's "ledger entries" (AC3, AC5) are scoped to a new,
  self-contained `grant_ledger_entries` table this story owns -- the
  credit side of the eventual full ledger. When TEID-33 lands, it
  incorporates these rows rather than this story inventing a duplicate,
  generic ledger table it has no mandate to design.
- **"Finance report" (T17-T3) doesn't exist as a feature.** No admin
  console UI exists anywhere in this repo (the same gap every other
  story's spec this session has documented). Scoped to `GET
  /grant-ledger-entries` (a plain listing/filter endpoint over the new
  table) returning the expiry entry -- the API surface a future finance
  report would read from, not a UI.
- **"Created by ... system" (AC1)**: a recurring grant's issuance is
  system-triggered, not by a specific operator. `created_by_user_id` is
  nullable for exactly this case; a manually-issued grant always has one
  (enforced at the route level, not the schema, since a system-issued
  recurring grant is a legitimate NULL).

## Architecture and design

### Schema: three new tables

New migration `db/migrations/20260927143258_grants.sql`, following the
same RLS/GRANT boilerplate every prior migration in this repo uses:

```sql
CREATE TABLE IF NOT EXISTS recurring_grant_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id),
  amount NUMERIC NOT NULL CHECK (amount > 0),
  unit TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('paid', 'promotional', 'commit', 'goodwill')),
  interval TEXT NOT NULL CHECK (interval IN ('monthly')),
  created_by_user_id UUID REFERENCES users(id),
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE recurring_grant_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE recurring_grant_templates FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_recurring_grant_templates ON recurring_grant_templates;
CREATE POLICY tenant_isolation_recurring_grant_templates ON recurring_grant_templates
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON recurring_grant_templates TO teideal_app;

CREATE TABLE IF NOT EXISTS grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id),
  amount NUMERIC NOT NULL CHECK (amount > 0),
  remaining_amount NUMERIC NOT NULL CHECK (remaining_amount >= 0),
  unit TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('paid', 'promotional', 'commit', 'goodwill')),
  start_date TIMESTAMPTZ NOT NULL,
  expiry_date TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'void')),
  created_by_user_id UUID REFERENCES users(id),
  recurring_template_id UUID REFERENCES recurring_grant_templates(id),
  period_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS grants_recurring_period_unique
  ON grants (recurring_template_id, period_key) WHERE recurring_template_id IS NOT NULL;
ALTER TABLE grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE grants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_grants ON grants;
CREATE POLICY tenant_isolation_grants ON grants
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON grants TO teideal_app;

CREATE TABLE IF NOT EXISTS grant_ledger_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  grant_id UUID NOT NULL REFERENCES grants(id) ON DELETE CASCADE,
  entry_type TEXT NOT NULL CHECK (entry_type IN ('issued', 'expired', 'voided')),
  amount NUMERIC NOT NULL,
  reason TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE grant_ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE grant_ledger_entries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_grant_ledger_entries ON grant_ledger_entries;
CREATE POLICY tenant_isolation_grant_ledger_entries ON grant_ledger_entries
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
-- Append-only, matching audit_log's own precedent: no UPDATE/DELETE grant.
GRANT SELECT, INSERT ON grant_ledger_entries TO teideal_app;
```

`amount` is always positive on `grants`; sign lives on
`grant_ledger_entries.amount` instead (`+amount` for `issued`,
`-amount` for `voided`, `-remaining_amount-at-expiry` for `expired`) --
this is what makes "sum the ledger" a meaningful future balance
computation once TEID-33 exists, rather than needing a `CASE` on
`entry_type` everywhere.

### `POST /grants` -- issue a grant (AC1, T17-T1)

New file `services/ts-console/src/routes/grants.ts`, session-authed
(`requireSession`, this file's own `app.register` block, matching
`plans.ts`'s pattern exactly), Owner or Billing Admin only via
`consoleRoute`.

Body: `{customer_id, amount, unit, source, start_date, expiry_date?}`.
Validation (400, specific error per field, matching `plans.ts`'s
convention): `customer_id` must be a UUID resolving to a customer in the
caller's tenant (403 if not visible, matching `usage.go`'s
customer-visibility pattern); `amount` a positive finite number;
`unit` a non-empty string; `source` one of the four enum values;
`start_date` a valid ISO 8601 timestamp; `expiry_date`, if present, a
valid ISO 8601 timestamp strictly after `start_date`.

On success, inside one `withTenant` transaction: insert the `grants` row
(`remaining_amount = amount`, `status: 'active'`, `created_by_user_id`
from the session), insert a `grant_ledger_entries` row (`entry_type:
'issued'`, `amount: +amount`), `recordConfigChangeWithClient`
(`objectType: "Grant"`). Return `201` with the full grant record.

### `GET /grants`, `GET /grants/:id` (T17-T1)

Same shape as `plans.ts`'s equivalents: paginated list (any role), `404`
detail lookup scoped to the caller's tenant (any role).

### `GET /grants/:id/eligibility?as_of=<ISO timestamp, optional>` -- read-only check (AC2, T17-T7)

Any role. Defaults `as_of` to `now()` if omitted; if provided, must
parse as ISO 8601 (naive/no-timezone timestamps are rejected -- always
require an explicit offset or `Z`, so "UTC evaluation" per AC2/T17-T8
is unambiguous at the API boundary rather than assumed). Returns
`{eligible: boolean, remaining_amount: string, reason?: string}` --
`eligible` is `true` only when `status = 'active'`, `as_of >=
start_date`, and (`expiry_date IS NULL OR as_of < expiry_date`), all
compared as `timestamptz` (Postgres does this in UTC internally
regardless of session timezone, which is what makes T17-T8's UTC-8
client timestamp evaluate correctly without any special handling in
application code -- the comparison is on the absolute instant, not a
local wall-clock string). No side effect -- this is the endpoint
T17-T7's load test hits repeatedly.

### `POST /grants/:id/consume` -- the synthetic stand-in for real usage-triggered consumption (AC2, T17-T2, T17-T3, T17-T8)

Owner or Billing Admin only (see scoping notes for why this exists).
Body: `{amount, as_of?}` (same `as_of` handling as `/eligibility`).
Runs the identical eligibility check inside the same transaction as the
decrement (not a separate read-then-write, to avoid a race between
checking and consuming), plus `amount <= remaining_amount`. On
ineligibility (before start, at/after expiry, not active, or
insufficient remaining): `409 {"error": "insufficient balance"}` --
this exact wording matches T17-T2's own framing of a date-ineligible
grant as an "insufficient balance" denial. On success: `UPDATE grants
SET remaining_amount = remaining_amount - $amount WHERE id = $1 AND
tenant_id = $2 AND status = 'active' AND $as_of >= start_date AND
(expiry_date IS NULL OR $as_of < expiry_date) AND remaining_amount >=
$amount RETURNING remaining_amount` -- the whole eligibility check
lives in the `WHERE` clause of one conditional `UPDATE`, so there's no
window between checking and decrementing for a concurrent call to
invalidate the check.

### `POST /grants/:id/void` (AC5, T17-T5, T17-T9)

Owner or Billing Admin only. Body: `{reason: string}` (required,
non-empty -- AC5's "mandatory reason"). Conditional `UPDATE grants SET
status = 'void' WHERE id = $1 AND tenant_id = $2 AND status = 'active'
RETURNING amount` -- the same `WHERE status = 'active'` pattern
TEID-16's publish endpoint already uses, which is what makes T17-T9 (two
concurrent void requests) safe: only one matches and updates; the other
gets zero rows back. Zero rows: `409 {"error": "grant is not active
(already void or expired, or does not exist for this tenant)"}`. On
success: insert a `grant_ledger_entries` row (`entry_type: 'voided'`,
`amount: -<original amount>`, `reason`), `recordConfigChangeWithClient`.
The original `grants` row is never deleted or overwritten beyond its
`status` field -- "the original grant remains in the history unaltered"
(T17-T5) is satisfied by construction, since every other column is
untouched.

### `POST /grant-templates` -- recurring grants (AC4, T17-T4, T17-T6)

Owner or Billing Admin only. Body: `{customer_id, amount, unit, source,
interval: "monthly"}` (only `"monthly"` is a valid `interval` value for
this story -- nothing in the ACs or tests requires any other cadence).
Inserts a `recurring_grant_templates` row. Returns `201`.

### Recurring-issuance worker (AC4, T17-T4, T17-T6)

New file `services/ts-console/src/lib/grantWorker.ts`, started from
`server.ts` on a timer alongside the existing session-sweep/export-worker
ones (`setInterval`, skipped when `NODE_ENV === "test"`; tests call the
function directly, exactly like TEID-44's export worker).

`processRecurringGrants(pool)`: for every `recurring_grant_templates` row
with `active = true`, compute the current UTC period key for its
interval (`"monthly"` -> `YYYY-MM` of `now()`), then attempt:

```sql
INSERT INTO grants (tenant_id, customer_id, amount, remaining_amount, unit,
                     source, start_date, recurring_template_id, period_key)
SELECT tenant_id, customer_id, amount, amount, unit, source, now(), id, $period_key
FROM recurring_grant_templates
WHERE id = $template_id
ON CONFLICT (recurring_template_id, period_key) WHERE recurring_template_id IS NOT NULL
DO NOTHING
RETURNING id
```

This is what makes **T17-T4** (scheduler runs twice plus a retry) safe:
the partial unique index on `(recurring_template_id, period_key)` means
a second or third attempt for the same template and period is a no-op
at the database level regardless of how many times or how concurrently
`processRecurringGrants` is invoked -- no application-level "have I
already run this period" bookkeeping needed, and none to get wrong. When
a grant is actually inserted (not skipped by the conflict), also insert
its `issued` ledger entry in the same transaction.

### Expiry worker (AC3, T17-T3)

Same file, `processExpiredGrants(pool)`: claims expired-but-still-active
grants with `SELECT ... FOR UPDATE SKIP LOCKED` (the same job-queue
idiom TEID-44's export worker already established for exactly this
"concurrent invocations must not double-process the same row" problem):

```sql
SELECT id, tenant_id, remaining_amount FROM grants
WHERE status = 'active' AND expiry_date IS NOT NULL AND expiry_date <= now()
FOR UPDATE SKIP LOCKED
```

For each claimed row: insert a `grant_ledger_entries` row (`entry_type:
'expired'`, `amount: -remaining_amount`), then `UPDATE grants SET status
= 'expired' WHERE id = $1`. Both in the same transaction as the claim.

### `GET /grant-ledger-entries` -- the "finance report" surface (T17-T3)

New route, any role, session-authed: `?grant_id=`/`?customer_id=`/date-range
filters (mirror `auditLog.ts`'s existing filter-parameter shape rather
than inventing a new one), paginated. This is what T17-T3's "visible in
the finance report" resolves to per the scoping notes.

## Implementation guidance per test

### TEID-17-T1
`POST /grants` with all six fields (`amount: 1000`, `unit: "USD"`,
`source: "promotional"`, `start_date: "2026-10-01T00:00:00Z"`,
`expiry_date: "2026-10-31T00:00:00Z"`, and a session authenticated as an
operator whose email is `ops@teideal.com` -- add this fixture user to
`db/seed-console-auth-fixtures.sh` if it doesn't already exist, matching
that script's existing insert shape). Assert `201`, then `GET
/grants/:id` and assert all six fields (amount, unit, source, start
date, expiry date, `created_by`) match exactly.

### TEID-17-T2
`POST /grants` with `start_date` set to tomorrow (relative to the test's
own clock). `POST /grants/:id/consume` with `as_of` set to today (before
start): assert `409 {"error": "insufficient balance"}`. Repeat with
`as_of` set to tomorrow (the start date): assert `200` and
`remaining_amount` decremented correctly.

### TEID-17-T3
`POST /grants` with `amount: 500`, `expiry_date:
"2026-11-01T00:00:00Z"`. `POST /grants/:id/consume` with `amount: 300`
(leaves `remaining_amount: 200`). Directly call `processExpiredGrants`
with the test's own mocked "now" set past the expiry (the same
timer-avoidance pattern TEID-44's export-worker tests and TEID-91's
session-sweep tests already use). Assert a `grant_ledger_entries` row
exists with `entry_type: 'expired'`, `amount: -200`, and that `GET
/grant-ledger-entries?grant_id=...` returns it.

### TEID-17-T4
`POST /grant-templates` for one customer, `amount: 100`,
`interval: "monthly"`. Call `processRecurringGrants` directly twice in
immediate succession, then simulate a retry-after-failure by calling it
a third time. Assert exactly one `grants` row exists with that
`recurring_template_id`/period, with `amount: 100`.

### TEID-17-T5
`POST /grants` with `amount: 300`. `POST /grants/:id/void` with
`{reason: "duplicate promotion applied"}`. Assert `200`, then `GET
/grants/:id` shows `status: "void"` with every other field (amount,
unit, source, dates) unchanged from creation, and a
`grant_ledger_entries` row exists with `entry_type: 'voided'`,
`amount: -300`.

### TEID-17-T6
Bulk-insert (via `INSERT ... SELECT ... FROM generate_series(...)`, the
same bulk-fixture technique used elsewhere in this repo, not one HTTP
call per customer) 10,000 `recurring_grant_templates` rows across
distinct customers, scaled down for CI the same way TEID-30/TEID-42's
load tests are (env vars `GRANT_SCHEDULER_LOAD_TEST_COUNT`, default
`10_000`, and `GRANT_SCHEDULER_LOAD_TEST_BUDGET_MS`, default
`900_000` i.e. 15 minutes, both overridable). Call
`processRecurringGrants` once, assert it completes within budget and
exactly one `grants` row exists per template for that period (a single
`COUNT(*) GROUP BY recurring_template_id HAVING COUNT(*) > 1` query
returning zero rows is the concrete "no duplicates" assertion).

### TEID-17-T7
Fire `GRANT_ELIGIBILITY_LOAD_TEST_RPS` (default a CI-scaled-down value,
e.g. 200, with the literal 2000 documented as the real target for a
dedicated perf pipeline, matching TEID-30/TEID-44's own precedent for
scaling a load test's target down for CI) requests per second against
`GET /grants/:id/eligibility` for a fixed grant, and assert measured P99
latency stays under 10ms (or the CI-scaled equivalent, documented the
same way).

### TEID-17-T8
`POST /grants` with `expiry_date: "2026-09-26T23:59:59Z"`. `POST
/grants/:id/consume` with `as_of: "2026-09-27T00:00:00Z"` (one second
after expiry in UTC) even though this instant is `"2026-09-26T16:00:00-08:00"`
in UTC-8 -- i.e. still "today" and well before midnight from that
client's own local perspective. Assert `409` -- the comparison must use
the absolute instant (already guaranteed by comparing `timestamptz`
values in Postgres), not a local-time reinterpretation of the string.

### TEID-17-T9
Create one active grant. Fire two concurrent `POST /grants/:id/void`
requests (`await Promise.all(...)`, same reason for both, is fine).
Assert exactly one `200` and one `409`, then `GET
/grant-ledger-entries?grant_id=...` and assert exactly one `voided`
entry exists, never two.

## File layout

- `db/migrations/20260927143258_grants.sql` -- `recurring_grant_templates`,
  `grants`, `grant_ledger_entries`.
- `services/ts-console/src/lib/grants.ts` -- new: validation and query
  helpers, mirroring `plans.ts`'s shape.
- `services/ts-console/src/lib/grantWorker.ts` -- new:
  `processRecurringGrants`, `processExpiredGrants`.
- `services/ts-console/src/routes/grants.ts` -- new: `POST /grants`,
  `GET /grants`, `GET /grants/:id`, `GET /grants/:id/eligibility`,
  `POST /grants/:id/consume`, `POST /grants/:id/void`,
  `POST /grant-templates`, `GET /grant-ledger-entries`.
- `services/ts-console/src/server.ts` -- register `grants.ts`'s routes;
  start the grant-worker timer alongside the existing session-sweep and
  export-worker ones.
- `db/seed-console-auth-fixtures.sh` -- add `ops@teideal.com` if not
  already covered by an existing fixture user (T17-T1's exact
  assertion).
- Tests: new directory `tests/grants/` (mirror `tests/plans/`'s exact
  shape), implementing all 9 cataloged tests.
- `tests/cross-tenant/grant-isolation.test.ts` -- new: cross-tenant case
  for `/grants*`, `/grant-templates`, and `/grant-ledger-entries`
  (acct_1001 against acct_1002's grant ids), matching
  `plan-isolation.test.ts`'s shape.
- CI: add steps to `.github/workflows/ci.yml`'s `test` job to install
  and run `tests/grants`, positioned after the existing `tests/plans`
  step.

## Definition of done

- [ ] All 5 acceptance criteria satisfied by working code (AC2/AC3
      scoped to the synthetic `/consume`/`/eligibility` stand-ins per
      the scoping notes, since no real usage-triggered consumption
      pipeline exists yet).
- [ ] All 9 cataloged tests have real automated tests that pass.
- [ ] `tsc --noEmit` clean in `services/ts-console`; every new
      session-authed route goes through `consoleRoute`.
- [ ] `tests/cross-tenant`, `tests/console-auth`, `tests/audit-log`,
      `tests/api-keys`, `tests/rbac`, `tests/data-export`, `tests/plans`
      all still pass unchanged.
- [ ] Cross-tenant isolation proven in `tests/cross-tenant` for every
      new `/grants*`/`/grant-templates`/`/grant-ledger-entries`
      endpoint.
- [ ] Full suite passes against a database rebuilt from scratch via
      `db/setup-local.sh` plus the existing seed scripts.
- [ ] PR description maps each test ID to its file/line.
