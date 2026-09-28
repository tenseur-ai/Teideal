# TEID-32: Append-only double-entry ledger

| | |
|---|---|
| Epic | TEID-3 (E03 -- Build usage ingestion and exactly-once ledger) |
| Phase | E03 |
| Priority | Highest |
| Points | 13 |
| Release | mvp |
| Order | 17 (within E03, directly after TEID-31) |
| Depends on | `usage_events` (TEID-41), `grants`/`plan_rates`/`plans.version` (TEID-16/17, cross-service, `services/ts-console`), `SUPERUSER_DATABASE_URL` test convention (TEID-42) |

## Story (verbatim from the live board)

> As a finance lead, I want every balance change recorded as a permanent entry that shows what caused it, so that every number we bill can be traced and audited.
>
> *Context*
> Corrections are made by adding reversing entries, never by editing or deleting.

## Acceptance criteria (verbatim from the live board)

1. Ledger entries can be added but never edited or deleted, by anyone, including our own staff.
2. Each entry records the cause: the usage event, grant, reservation, rule and plan version involved.
3. Every transaction is double-entry: the amounts across its accounts always sum to zero.
4. Corrections appear as new reversing entries linked to the entry they correct.
5. A daily automated check confirms that every transaction balances; any failure pages the on-call engineer.

## Cataloged tests (verbatim from the live board)

| ID | Type | AC | Title |
|---|---|---|---|
| TEID-32-T1 | Functional | 1 | Attempt to run an UPDATE or DELETE statement directly against the ledger_entries table using an administrative database role and confirm a database-level trigger or permission blocks it, not merely application-layer logic. |
| TEID-32-T2 | Functional | 2 | Post a usage-driven ledger entry and confirm its record includes populated references to the source usage event ID, the applicable grant ID, reservation ID, pricing rule ID, and plan version ID. |
| TEID-32-T3 | Functional | 3 | Post a transaction crediting a revenue account $50.00 and debiting a receivable account $50.00 and confirm the transaction's line amounts sum to exactly 0.00 across all accounts. |
| TEID-32-T4 | Functional | 4 | Issue a correction for a $25.00 overcharge entry and confirm a new reversing entry of -$25.00 is created referencing the original entry's ID, while the original entry remains unchanged. |
| TEID-32-T5 | Functional | 5 | Run the daily balance-integrity job against a dataset containing one intentionally unbalanced transaction and confirm the job flags it and pages the on-call engineer through the alerting integration. |
| TEID-32-T6 | Non-functional | 5 | Confirm the daily ledger-integrity check completes within its nightly maintenance window, under 30 minutes, against a 50-million-entry ledger table without degrading concurrent write throughput. |
| TEID-32-T7 | Adversarial | 1 | Using a database superuser session, attempt to delete a single ledger row directly, bypassing the application layer entirely, and confirm a database-level constraint prevents the deletion. |
| TEID-32-T8 | Adversarial | 3 | Attempt to insert a transaction via the API with intentionally unbalanced debit and credit amounts summing to $0.01 instead of $0.00, and confirm the write is rejected atomically with no partial entries persisted. |

## Scoping notes for this point in the build sequence

This is the first story to introduce a genuine, generic double-entry
ledger to this codebase -- nothing resembling one exists today.
`grant_ledger_entries` (TEID-17) is a single-amount append log scoped to
grants only, not double-entry, and is left completely untouched by this
story. Several load-bearing decisions this story's own ACs don't fully
resolve are made explicitly here, matching every prior E01/E03 spec's
practice:

- **T1's "administrative database role" and T7's "database superuser
  session" are two different privilege levels, tested separately, not
  the same test twice.** This repo's actual Postgres setup has exactly
  two roles: `teideal_app` (the app's own runtime credential, NOSUPERUSER)
  and `postgres` (the real superuser, used for migrations and already
  exposed to every test suite via the established `SUPERUSER_DATABASE_URL`
  convention). T1 is read as "a privileged application credential" --
  `teideal_app` itself -- mirroring TEID-42-T6's existing, already-
  passing precedent (`tests/audit-log`) almost exactly: no `UPDATE`/
  `DELETE` grant, caught as Postgres error `42501`. T7 is the real
  `postgres` role. **This distinction matters because they need different
  mechanisms**: a missing `GRANT` stops `teideal_app` but a superuser
  bypasses `GRANT`/`REVOKE` (and RLS) entirely -- confirmed empirically
  in this repo today, since `tests/audit-log`'s own cleanup code already
  uses the superuser pool to `DELETE FROM audit_log` for fixture
  teardown. Only a trigger stops a superuser (triggers fire regardless of
  role). This story adds this schema's **first-ever** `BEFORE UPDATE`/
  `BEFORE DELETE` trigger for exactly this reason -- no existing
  append-only table (`audit_log`, `grant_ledger_entries`, `usage_events`,
  `usage_consumption_lines`, `idempotency_conflicts`) is superuser-proof
  today, and none of them are retrofitted by this story (out of scope;
  retrofitting risks breaking those tables' own already-passing
  superuser-using test fixtures).
- **"Reservation" does not exist anywhere in this codebase** -- no table,
  no column, no code path. It is genuinely E02/TEID-2 territory (real-
  time entitlement checks, phase-2, not started). T2 nonetheless requires
  a **populated** (non-null) reservation reference on a usage-driven
  entry, which a silently-always-NULL placeholder column cannot satisfy.
  Resolved with a **minimal, narrowly-scoped placeholder `reservations`
  table** -- an identity/traceability anchor only (`id`, `tenant_id`,
  `customer_id`, `usage_event_id`), with a bare-bones `POST /reservations`
  endpoint to create one. This is explicitly **not** E02's real
  hold/reserve-then-settle system (no balance-checking, no expiry, no
  entitlement logic of any kind) -- it exists solely so this story's
  ledger entries can carry a real, non-null `reservation_id` the way T2
  requires, and is expected to be superseded (not necessarily replaced
  wholesale) once E02 builds the real thing. Flagged here explicitly as
  the same kind of honest, minimal substitution TEID-18's synthetic
  `POST /customers/:id/consume` was for its own not-yet-built
  prerequisite.
- **"Rule" is `plan_rates.id`** -- the only real candidate in the schema
  (no other pricing-rule concept exists). **"Plan version" is a captured
  integer snapshot** (`plans.version`, copied onto the ledger transaction
  at post time), not a foreign key to a separate versions table -- no
  such table exists; `plans.version` is a single nullable `INT` set once
  a plan is published.
- **Cross-service references are bare UUID columns, no enforceable FK,
  matching `usage_events.customer_id`'s and TEID-96's
  `customer_billing_config.customer_id`'s already-established precedent
  for a table in one service referencing a row it doesn't own.**
  `usage_event_id` and the new `reservation_id` get real FKs (both live
  in `go-usage`'s own database, same as this story's new tables).
  `grant_id` (owned by `services/ts-console`) and `pricing_rule_id`
  (`plan_rates.id`, also ts-console) do not -- there is no `/proto`
  contract yet for `go-usage` to validate these against ts-console live,
  the same gap TEID-16/17/18/31's specs each already documented for
  their own cross-service references.
- **This story's tables and the daily integrity job both live in
  `services/go-usage`, making this go-usage's first-ever background
  worker -- a deliberate, stated departure from TEID-31's precedent, not
  an oversight.** ADR 0001 names "the exactly-once ledger" as Go's domain
  explicitly, and the ledger tables themselves need to live where their
  data does. TEID-31's spec explained *why* it didn't need a worker
  (reactive expiry-on-conflict, no scheduled purge); that reasoning
  doesn't transfer here -- AC5 is inherently a *scheduled* check with
  no request to react to, so this story has a real, structural reason
  TEID-31 didn't. Implemented as a goroutine + `time.Ticker` in
  `cmd/server/main.go`, guarded by a new `DISABLE_BACKGROUND_WORKERS`
  env var (set `true` in tests, mirroring `services/ts-console/server.ts`'s
  own `NODE_ENV !== "test"` guard for its four existing timers) --
  tests call the check function directly with a fixed instant, the same
  pattern every `ts-console` worker's own tests already use.
- **"Pages the on-call engineer" is a configurable webhook, not a real
  PagerDuty/Opsgenie integration** -- none exists anywhere in this
  codebase, and building one is not this story's job. A new
  `ONCALL_ALERT_WEBHOOK_URL` env var; the daily job `POST`s a JSON
  payload to it on any detected imbalance. Tested via a new local fake
  HTTP double, `tests/ledger/fake-oncall.ts`, following the exact same
  "real local HTTP server the test suite starts and points the app at
  via an env-var override" shape `fake-google.ts`/`fake-s3.ts` already
  establish -- not a mock.
- **Accounts are free-text codes, not a managed chart-of-accounts
  table.** No AC asks for account *management* as a feature (creating,
  renaming, or listing accounts) -- only for posting and integrity. A
  full chart-of-accounts table would be unrequested scope. `ledger_lines`
  carries a plain `account_code TEXT`, validated at the application layer
  against a small fixed allow-list constant (`revenue`, `receivable`,
  `payable`, `cash`, `discount`, `overage`) rather than a managed table
  with its own CRUD surface.
- **Sum-to-zero is enforced twice, deliberately** (belt-and-suspenders,
  matching `audit_log`'s own established "missing GRANT **and** explicit
  REVOKE" double-enforcement precedent): the API computes and rejects an
  unbalanced request before ever attempting an insert (**T8**'s fast,
  clear `400`), and a `DEFERRABLE INITIALLY DEFERRED` constraint trigger
  re-checks the same invariant at commit time regardless of which code
  path wrote the rows -- the real, unbypassable guarantee AC3's "always
  sum to zero" describes as a database-level fact, not merely an
  application habit. **T5's fixture setup** (a deliberately unbalanced
  transaction for the daily job to find) has to get bad data past this
  trigger somehow -- done via `SET session_replication_role = replica`
  on the superuser connection for that one fixture insert only (a
  standard, well-known Postgres technique for bypassing triggers during
  test/fixture setup, not a production code path), then restored
  immediately after.

## Architecture and design

### Schema: three new tables, one new trigger function

New migration `db/migrations/20260928110000_ledger.sql`:

```sql
-- TEID-32: a minimal reservation placeholder -- see specs/TEID-32.md's
-- scoping notes. Not the real E02 hold/reserve-then-settle system.
CREATE TABLE IF NOT EXISTS reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id),
  usage_event_id UUID REFERENCES usage_events(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE reservations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_reservations ON reservations;
CREATE POLICY tenant_isolation_reservations ON reservations
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT ON reservations TO teideal_app;

CREATE TABLE IF NOT EXISTS ledger_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id),
  usage_event_id UUID REFERENCES usage_events(id),
  grant_id UUID,              -- cross-service (ts-console), no FK -- see scoping notes
  reservation_id UUID REFERENCES reservations(id),
  pricing_rule_id UUID,       -- cross-service (plan_rates.id), no FK
  plan_version INT,           -- captured snapshot, not a live reference
  reverses_transaction_id UUID REFERENCES ledger_transactions(id),
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE ledger_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_transactions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_ledger_transactions ON ledger_transactions;
CREATE POLICY tenant_isolation_ledger_transactions ON ledger_transactions
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT ON ledger_transactions TO teideal_app;

CREATE TABLE IF NOT EXISTS ledger_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  transaction_id UUID NOT NULL REFERENCES ledger_transactions(id),
  account_code TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount NUMERIC NOT NULL CHECK (amount > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE ledger_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_lines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_ledger_lines ON ledger_lines;
CREATE POLICY tenant_isolation_ledger_lines ON ledger_lines
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT ON ledger_lines TO teideal_app;

-- AC1/T1/T7: this schema's first trigger-based immutability. Fires for
-- every role including a superuser -- the only mechanism in this
-- codebase's toolkit that isn't bypassed by BYPASSRLS/superuser status.
CREATE OR REPLACE FUNCTION reject_ledger_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'ledger rows are append-only and cannot be updated or deleted (attempted % on %.%)',
    TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_transactions_immutable
  BEFORE UPDATE OR DELETE ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
CREATE TRIGGER ledger_lines_immutable
  BEFORE UPDATE OR DELETE ON ledger_lines
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();

-- AC3/T8: the real, unbypassable sum-to-zero guarantee. Deferred so it
-- checks the *whole* transaction's lines at commit, not row-by-row
-- during insert (which would reject the first line of every valid
-- transaction, since no single line sums to zero on its own).
CREATE OR REPLACE FUNCTION check_ledger_balance() RETURNS TRIGGER AS $$
DECLARE
  imbalance NUMERIC;
BEGIN
  SELECT COALESCE(SUM(CASE WHEN direction = 'debit' THEN amount ELSE -amount END), 0)
    INTO imbalance
    FROM ledger_lines
    WHERE transaction_id = NEW.transaction_id;
  IF imbalance != 0 THEN
    RAISE EXCEPTION 'ledger transaction % does not balance (net %)', NEW.transaction_id, imbalance;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER ledger_lines_balance
  AFTER INSERT ON ledger_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_ledger_balance();
```

### `services/go-usage/internal/ledger/ledger.go` -- new package

- `PostTransaction(ctx, tx, tenantID, input)`: validates `input.Lines`
  sums to zero (`sum(debit) == sum(credit)`, comparing `decimal.Decimal`
  values exactly, matching TEID-94/95's established exact-decimal
  discipline -- never `float64`) -- returns a `400`-shaped error
  immediately if not, before any insert (T8's fast path). Inside one DB
  transaction: `INSERT INTO ledger_transactions (...) RETURNING id`,
  then one `INSERT INTO ledger_lines (...)` per line. The deferred
  constraint trigger re-validates at commit regardless -- this function
  never has to trust its own pre-check alone.
- `ReverseTransaction(ctx, tx, tenantID, originalTransactionID, reason)`:
  reads the original transaction's lines, `INSERT`s a **new** transaction
  with `reverses_transaction_id = originalTransactionID` whose lines are
  the exact mirror image (every `debit` becomes `credit` and vice versa,
  same amounts) -- this is what makes the reversal itself balance to
  zero automatically (AC4, **T4**), and what makes "the original entry
  remains unchanged" trivially true (nothing about the original row is
  ever touched; a new, linked row is added instead).
- `CheckAllTransactionsBalanced(ctx, pool, now)`: for each tenant, `SELECT
  transaction_id, SUM(CASE WHEN direction='debit' THEN amount ELSE
  -amount END) AS net FROM ledger_lines GROUP BY transaction_id HAVING
  SUM(...) != 0` -- a defense-in-depth verification pass independent of
  the insert-time trigger (AC5, **T5**/**T6**). If any tenant has
  unbalanced transactions, `POST`s to `ONCALL_ALERT_WEBHOOK_URL` with
  `{tenant_id, unbalanced_transaction_ids, checked_at}`.

### `POST /reservations` -- the minimal placeholder (T2)

New file `services/go-usage/internal/api/reservations.go`, `admin`-scoped
(matching `rounding-config`/`billing-config`'s existing convention for
non-hot-path config-shaped endpoints). Body: `{customer_id,
usage_event_id?}`. Plain insert, returns the created row. No balance,
hold, or expiry logic of any kind -- see scoping notes.

### `POST /ledger/transactions` -- post a transaction (AC2, AC3, T2, T3, T8)

New file `services/go-usage/internal/api/ledger.go`, `admin`-scoped.
Body: `{customer_id, usage_event_id?, grant_id?, reservation_id?,
pricing_rule_id?, plan_version?, description?, lines: [{account_code,
direction, amount}, ...]}` -- every causal reference is caller-supplied,
not auto-derived (there is no automatic usage-to-ledger pipeline yet;
that's a future story's job, once real pricing/consumption code calls
this endpoint itself). Calls `PostTransaction`. `201` with the full
transaction plus its `lines` array.

### `POST /ledger/transactions/:id/reverse` -- correction (AC4, T4)

Same file, `admin`-scoped. Body: `{reason}`. Calls `ReverseTransaction`.
`201` with the new reversing transaction.

### `GET /ledger/transactions/:id` -- read (supports T3/T4/T8's assertions)

Same file, `admin`-scoped. Returns the transaction plus its `lines`
array, so a test can assert on stored amounts/directions directly via
the API rather than only via a raw DB read.

### Background worker (AC5, T5, T6)

`cmd/server/main.go`: a new goroutine, gated by
`os.Getenv("DISABLE_BACKGROUND_WORKERS") != "true"`, running
`ledger.CheckAllTransactionsBalanced` on a `time.Ticker` (interval via a
new `LEDGER_INTEGRITY_CHECK_INTERVAL_MS` env var, defaulting to 24h in
production). Tests set `DISABLE_BACKGROUND_WORKERS=true` and call
`CheckAllTransactionsBalanced(ctx, pool, fixedNow)` directly, the same
pattern every `services/ts-console` worker's own tests already use.

## Implementation guidance per test

### TEID-32-T1
Using a `teideal_app`-credentialed connection (this test suite's normal
pool, matching `tests/audit-log`'s `TEID-42-T6` exactly), attempt
`UPDATE ledger_transactions SET description = 'x' WHERE id = $1` and
`DELETE FROM ledger_lines WHERE id = $1` against a real posted
transaction. Assert both reject with Postgres error code `42501`
(permission denied), and that a subsequent read shows the row unchanged.

### TEID-32-T2
`POST /reservations` to get a real `reservation_id`. `POST
/ledger/transactions` supplying **all five** causal references
(`usage_event_id` from a real seeded `usage_events` row,
`grant_id`/`pricing_rule_id` as plausible UUIDs since no cross-service
validation exists yet, `reservation_id` from the step above,
`plan_version: 1`) plus a balanced pair of lines. Assert the `201`
response's transaction record has all five fields populated exactly as
sent -- not null, not omitted.

### TEID-32-T3
`POST /ledger/transactions` with `lines: [{account_code: "revenue",
direction: "credit", amount: 50.00}, {account_code: "receivable",
direction: "debit", amount: 50.00}]`. Assert `201`. `GET
/ledger/transactions/:id` and assert the two lines' amounts, summed with
`credit` as `-amount` and `debit` as `+amount`, equal exactly `0.00`
(`NUMERIC` comparison, not floating point).

### TEID-32-T4
Post a transaction representing a `$25.00` overcharge (e.g. `debit
receivable $25.00, credit revenue $25.00`). `POST
/ledger/transactions/:id/reverse` with `{reason: "overcharge correction"}`.
Assert the response is a new transaction with `reverses_transaction_id`
equal to the original's `id`, whose lines are the exact mirror
(`credit receivable $25.00, debit revenue $25.00` -- net `-$25.00`
relative to the original's direction). `GET` the original transaction
again and assert every field is byte-identical to before the reversal.

### TEID-32-T5
Using the superuser connection, wrap one fixture insert in `SET
session_replication_role = replica; ... SET session_replication_role =
DEFAULT;` to insert a transaction with two lines whose amounts don't
balance (bypassing the deferred trigger deliberately, for fixture setup
only -- see scoping notes). Start the fake on-call webhook double
(`tests/ledger/fake-oncall.ts`), set `ONCALL_ALERT_WEBHOOK_URL` to it,
call `CheckAllTransactionsBalanced(ctx, pool, fixedNow)` directly (test-
mode, no waiting on the real ticker). Assert the fake double received
exactly one POST naming the unbalanced transaction's id.

### TEID-32-T6
`LEDGER_INTEGRITY_CHECK_BUDGET_MS`-scaled (CI-scaled down from the
literal 30-minute/50-million-row target, matching TEID-30/42/95's own
established bulk-fixture-plus-env-var-scaling convention) -- bulk-insert
a large synthetic set of balanced transactions via `generate_series`
(the same technique `TEID-42-T4`/`TEID-30-T7` already use), run
`CheckAllTransactionsBalanced`, and assert it completes within the
scaled budget. Concurrently fire a stream of ordinary `POST
/ledger/transactions` calls during the check and assert their latency
doesn't measurably degrade (a relative before/after comparison, matching
this repo's established pattern for "doesn't degrade concurrent
throughput" claims elsewhere).

### TEID-32-T7
Using the real superuser connection (`SUPERUSER_DATABASE_URL`), attempt
`DELETE FROM ledger_lines WHERE id = $1` directly against a real posted
line, with no `session_replication_role` trick this time (a genuine,
unmodified attempt). Assert it fails with the trigger's `RAISE
EXCEPTION` message (not a permission error this time -- a superuser
isn't blocked by `GRANT`/`REVOKE`, only by the trigger firing), and the
row is unchanged afterward.

### TEID-32-T8
`POST /ledger/transactions` with `lines: [{account_code: "revenue",
direction: "credit", amount: 50.00}, {account_code: "receivable",
direction: "debit", amount: 50.01}]` (a one-cent imbalance). Assert
`400` with a message naming the imbalance, and that **no** row exists in
either `ledger_transactions` or `ledger_lines` for this attempt
afterward (the application-level pre-check rejects before any insert is
attempted, so there's nothing for the deferred trigger to even need to
catch in this specific case -- but assert the end state either way,
since that's what T8 actually specifies, not which of the two layers
caught it).

## File layout

- `db/migrations/20260928110000_ledger.sql` -- `reservations`,
  `ledger_transactions`, `ledger_lines`, `reject_ledger_mutation`,
  `check_ledger_balance`, and their triggers.
- `services/go-usage/internal/ledger/ledger.go` -- new:
  `PostTransaction`, `ReverseTransaction`, `CheckAllTransactionsBalanced`.
- `services/go-usage/internal/api/reservations.go` -- new: `POST
  /reservations`.
- `services/go-usage/internal/api/ledger.go` -- new: `POST
  /ledger/transactions`, `POST /ledger/transactions/:id/reverse`, `GET
  /ledger/transactions/:id`.
- `services/go-usage/cmd/server/main.go` -- register the three new
  routes (`admin`-scoped); add the new background-worker goroutine
  guarded by `DISABLE_BACKGROUND_WORKERS`.
- Tests: new directory `tests/ledger/` (mirror `tests/idempotency/`'s
  pure-go-usage shape -- no `session.ts`, `GO_USAGE_URL` only), plus
  `fake-oncall.ts` (mirroring `fake-s3.ts`'s shape), implementing all 8
  cataloged tests.
- CI: `DISABLE_BACKGROUND_WORKERS=true` added to the "Build and start
  go-usage" step's env; add install+test steps for `tests/ledger`,
  positioned after the existing `tests/idempotency` step.

## Definition of done

- [ ] All 5 acceptance criteria satisfied by working code (AC2's
      "reservation" scoped to the minimal placeholder above, not E02's
      real system).
- [ ] All 8 cataloged tests have real automated tests that pass --
      functional, non-functional, and adversarial alike.
- [ ] `go vet ./...` clean in `services/go-usage`.
- [ ] `tests/usage-ingestion`, `tests/billing-periods` (incl. `TEID-96-T8`
      unchanged), `tests/currency-rounding`, `tests/large-quantities`,
      `tests/idempotency`, `tests/cross-tenant`, `tests/data-export` all
      still pass unchanged.
- [ ] Cross-tenant isolation proven in `tests/cross-tenant` for every new
      endpoint.
- [ ] Full suite passes against a database rebuilt from scratch via
      `db/setup-local.sh` plus the existing seed scripts.
- [ ] PR description maps each test ID to its file/line.
