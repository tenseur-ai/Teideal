# TEID-33: Balances derived from the ledger

| | |
|---|---|
| Epic | TEID-3 (E03 -- Build usage ingestion and exactly-once ledger) |
| Phase | E03 |
| Priority | High |
| Points | 8 |
| Release | mvp |
| Order | 18 (immediately after TEID-32) |
| Depends on | `ledger_transactions`/`ledger_lines`, `PostTransaction` (TEID-32), the `DISABLE_BACKGROUND_WORKERS`/ticker-worker pattern and `ONCALL_ALERT_WEBHOOK_URL` (TEID-32) |

## Story (verbatim from the live board)

> As a finance lead, I want balances that are always calculated from the ledger rather than stored as a separate number, so that balances can never drift from the underlying record.
>
> *Context*
> For speed, balances may be cached, but the ledger is always the source of truth.

## Acceptance criteria (verbatim from the live board)

1. Any customer balance can be recalculated from the ledger alone.
2. An automated check at least every hour compares cached balances to recalculated ones for every customer.
3. Any mismatch pages on-call and is shown on an internal integrity dashboard.
4. Operators can trigger a recalculation for a single customer and see the result.

## Cataloged tests (verbatim from the live board)

| ID | Type | AC | Title |
|---|---|---|---|
| TEID-33-T1 | Functional | 1 | Ignore a customer's cached balance entirely and recompute their balance by replaying every ledger entry from scratch, confirming the recomputed value matches the last known cached value. |
| TEID-33-T2 | Functional | 2 | Confirm the reconciliation job's schedule runs at least every 60 minutes and observe one full run comparing cached versus recalculated balances across a test set of 10,000 customers within that hour. |
| TEID-33-T3 | Functional | 3 | Manually offset one customer's cached balance by $0.50 relative to the ledger, run the reconciliation job, and confirm an on-call page fires and the mismatch appears on the integrity dashboard with customer ID and discrepancy amount. |
| TEID-33-T4 | Functional | 4 | As an operator, trigger a manual recalculation for a single named customer through the admin UI and confirm the recalculated balance and a run timestamp are displayed on the same screen. |
| TEID-33-T5 | Non-functional | 2 | Measure the hourly reconciliation job's runtime against a 1-million-customer dataset and confirm it completes in under 20 minutes, well inside its 60-minute window. |
| TEID-33-T6 | Adversarial | 4 | As an operator, fire 20 concurrent recalculation requests for the same customer simultaneously and confirm they converge to one consistent recalculated balance rather than producing conflicting or corrupted cached values. |
| TEID-33-T7 | Adversarial | 3 | Simulate the paging integration being unreachable at the moment a balance mismatch is detected and confirm the mismatch is still recorded and visible on the integrity dashboard rather than silently dropped. |

## Scoping notes for this point in the build sequence

- **Which ledger account is "the balance"?** `ledger.go`'s
  `allowedAccounts` (TEID-32) is a fixed set: `revenue`, `receivable`,
  `payable`, `cash`, `discount`, `overage` -- no generic
  `customer_balance` code exists, and this story does not add one.
  `receivable` is the standard double-entry account for "what this
  customer owes" (a debit increases it, a credit -- e.g. a payment --
  decreases it), so **"a customer's balance" in this story means the
  net of that customer's `receivable`-account ledger lines**
  (`SUM(debit) - SUM(credit)` across every `ledger_lines` row with
  `account_code = 'receivable'` joined to that customer's
  `ledger_transactions`). This is a real, literal use of TEID-32's
  existing schema, not an extension of it.
- **No real business flow posts to this ledger yet, and this story does
  not add one.** TEID-32 shipped the ledger as infrastructure; nothing
  in `services/ts-console` (grants, consumption, commits) or
  `services/go-usage` (usage ingestion) calls `PostTransaction` today --
  confirmed by grep, zero call sites outside TEID-32's own tests. Wiring
  a real business event to post ledger transactions is future work for
  whichever story needs it (plausibly TEID-34/97, not cataloged here).
  This story's tests seed the ledger directly via `PostTransaction`
  (balanced `receivable`/`revenue` pairs) to set up recalculation
  scenarios -- the same "stands in for a not-yet-wired trigger point"
  pattern already used by TEID-17 through TEID-20 and TEID-37 for their
  own not-yet-built callers. `GetCustomerBalance` and the reconciliation
  worker are correct regardless of what eventually posts the real
  transactions; coverage becomes literal, not substituted, once a real
  caller exists.
- **A real, deliberate improvement over TEID-32's own alerting pattern,
  driven directly by T7.** TEID-32's `postAlert` returns an error when
  the webhook is unreachable, and `CheckAllTransactionsBalanced`
  propagates that error with no other record of the finding -- an
  unreachable webhook today means an imbalance is logged to the process
  log and nothing else. T7 explicitly requires the opposite: a mismatch
  must be durably recorded and visible on the dashboard even if paging
  fails. This story's reconciliation worker therefore **writes the
  mismatch row to `balance_integrity_checks` first, inside its own
  transaction, then attempts the webhook** -- webhook failure is caught
  and logged, never allowed to prevent or roll back the already-written
  finding. (Not a fix to TEID-32's existing function -- a new function,
  written correctly from the start.)
- **T4's "admin UI" and "same screen" are the established stand-in**:
  the recalculation endpoint's own response body carries both the
  recalculated balance and a run timestamp, standing in for the screen
  that would display them.
- **"Cached balance" needs a table it can be manually offset in for T3**
  -- a plain row per `(tenant_id, customer_id, account_code)`, not a
  computed view, so a test can `UPDATE` it directly to simulate drift
  without needing to fake an inconsistent ledger.
- **T6's convergence requirement is a per-customer serialization point,
  not a distributed lock.** `SELECT ... FOR UPDATE` on the
  `customer_balance_cache` row inside the recalculation transaction
  (creating the row first if absent) is sufficient: 20 concurrent
  requests for the same customer serialize on that row, each recomputes
  from the ledger (a stable read within its own transaction) and writes
  the same result, so they converge by construction rather than by
  chance -- no corrupted or partial write is possible because every
  writer computes the identical value from the same durable source.

## Architecture and design

### Schema: two new tables

New migration `db/migrations/20260929091500_balance_reconciliation.sql`:

```sql
CREATE TABLE IF NOT EXISTS customer_balance_cache (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id),
  account_code TEXT NOT NULL,
  cached_balance NUMERIC NOT NULL DEFAULT 0,
  last_recalculated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, customer_id, account_code)
);
ALTER TABLE customer_balance_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_balance_cache FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_customer_balance_cache ON customer_balance_cache;
CREATE POLICY tenant_isolation_customer_balance_cache ON customer_balance_cache
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON customer_balance_cache TO teideal_app;

-- Append-only, matching idempotency_conflicts' review-log precedent.
-- Only a real mismatch is ever written here (T2's routine, all-clear
-- comparisons are not logged individually -- see T5's 1M-customer/hour
-- budget, which a per-customer row on every clean check would strain
-- for no operational benefit).
CREATE TABLE IF NOT EXISTS balance_integrity_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id),
  account_code TEXT NOT NULL,
  cached_balance NUMERIC NOT NULL,
  recalculated_balance NUMERIC NOT NULL,
  discrepancy NUMERIC NOT NULL,
  alert_sent BOOLEAN NOT NULL DEFAULT false,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE balance_integrity_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE balance_integrity_checks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_balance_integrity_checks ON balance_integrity_checks;
CREATE POLICY tenant_isolation_balance_integrity_checks ON balance_integrity_checks
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON balance_integrity_checks TO teideal_app;
```

`alert_sent` lets T7 assert the row exists and is visible on the
dashboard even when the webhook call itself failed (`alert_sent =
false`), distinguishing "recorded, paging failed" from "recorded,
paged successfully" without losing either fact.

### `services/go-usage/internal/ledger/balance.go` -- new file

- `GetCustomerBalance(ctx, tx, customerID, accountCode string) (decimal.Decimal, error)`:
  `SELECT COALESCE(SUM(CASE WHEN ll.direction = 'debit' THEN ll.amount ELSE -ll.amount END), 0) FROM ledger_lines ll JOIN ledger_transactions lt ON lt.id = ll.transaction_id WHERE lt.customer_id = $1 AND ll.account_code = $2` --
  AC1's recalculation, callable standalone (T1) or from the endpoints
  below.
- `RecalculateCustomerBalance(ctx, pool, tenantID, customerID, accountCode string, now time.Time) (decimal.Decimal, time.Time, error)`:
  within `pool.WithTenant`, `SELECT ... FOR UPDATE` the
  `customer_balance_cache` row (creating it with `cached_balance = 0` if
  absent), calls `GetCustomerBalance`, `UPDATE ... SET cached_balance =
  $1, last_recalculated_at = $2`, returns the fresh balance and
  timestamp (AC4/T4, and T6's serialization point).
- `ReconcileCustomerBalances(ctx, pool *db.Pool, now time.Time) error`:
  the hourly worker (AC2). For every tenant, for every
  `(customer_id, account_code)` pair present in either
  `customer_balance_cache` or with any `receivable`-account ledger
  activity, computes the recalculated balance via one batched SQL query
  per tenant (not one round-trip per customer -- T5's 1M-customer/20-
  minute budget) and compares it to the cached value. On a mismatch:
  insert a `balance_integrity_checks` row inside the same transaction as
  the comparison (T7 -- durable regardless of what happens next), then
  attempt `postAlert` (reusing TEID-32's existing webhook client and
  `ONCALL_ALERT_WEBHOOK_URL`), and `UPDATE balance_integrity_checks SET
  alert_sent = true` in a second, separate statement only if the webhook
  call succeeds (never inside the same transaction the finding itself
  was committed in, so a slow or failing webhook can never roll back or
  delay the recorded finding).

### `POST /customers/{id}/recalculate-balance?account_code=receivable` (AC4, T4, T6)

New route in `services/go-usage/cmd/server/main.go`, `admin`-scoped
(matching `POST /reservations`/`POST /ledger/transactions`'s existing
gate). Calls `RecalculateCustomerBalance`, returns `{customer_id,
account_code, balance, recalculated_at}`.

### `GET /balance-integrity/checks` (AC3, T3, T7 -- dashboard stand-in)

Same file, same gate. `SELECT * FROM balance_integrity_checks ORDER BY
detected_at DESC LIMIT 500` -- the dashboard stand-in, same pattern as
TEID-31's `idempotency_conflicts` read and TEID-38's match-candidates
read.

### Background worker

Extends `main.go`'s existing `DISABLE_BACKGROUND_WORKERS`-guarded
ticker block (TEID-32's exact pattern) with a second ticker: interval
`BALANCE_RECONCILIATION_INTERVAL_MS` (default 1 hour, matching AC2's
"at least every hour"), calling `ledger.ReconcileCustomerBalances`.
Runs alongside, not instead of, TEID-32's own `CheckAllTransactionsBalanced`
ticker -- two independent integrity checks over the same underlying
ledger, checking different invariants (transaction-level sum-to-zero
vs. customer-level cache-vs-ledger agreement).

## Implementation guidance per test

### TEID-33-T1
Post a balanced synthetic transaction via `PostTransaction` (debit
`receivable` $100, credit `revenue` $100) for a fresh customer. Call
`RecalculateCustomerBalance` once to establish a cached value of $100.
Call `GetCustomerBalance` directly (bypassing the cache entirely) and
assert it returns $100, matching the cached value with no drift.

### TEID-33-T2
Seed 10,000 customers each with a few `PostTransaction` calls and an
initial cache row. Configure `BALANCE_RECONCILIATION_INTERVAL_MS` to a
short test value, start the worker, and assert `ReconcileCustomerBalances`
is invoked (directly, or observed via a completed run) covering all
10,000 customers within the configured hour-scale window.

### TEID-33-T3
Establish a customer's correct cached balance, then directly `UPDATE
customer_balance_cache SET cached_balance = cached_balance + 0.50`.
Invoke `ReconcileCustomerBalances` once. Assert a `balance_integrity_checks`
row exists with `discrepancy = 0.50`, `alert_sent = true`, and the fake
on-call webhook (`tests/ledger/fake-oncall.ts`, reused from TEID-32)
received a POST naming this customer and the discrepancy amount.

### TEID-33-T4
Post a few transactions for a customer with no existing cache row.
`POST /customers/{id}/recalculate-balance`. Assert the response includes
the correct recalculated balance and a `recalculated_at` timestamp
within the test's execution window, and that `customer_balance_cache`
now reflects it.

### TEID-33-T5
Seed 1,000,000 customers (batched inserts) each with a small, fixed
number of ledger postings. Time a single `ReconcileCustomerBalances`
run end to end. Assert it completes in under 20 minutes.

### TEID-33-T6
For one customer with existing ledger activity, fire 20 concurrent
`POST /customers/{id}/recalculate-balance` requests. Assert all 20
responses report the identical balance value, and the final
`customer_balance_cache` row's `cached_balance` matches
`GetCustomerBalance`'s independently-computed value (no corruption, no
divergent results).

### TEID-33-T7
Point `ONCALL_ALERT_WEBHOOK_URL` at an address nothing listens on (or
stop the fake on-call server for this one test). Introduce the same
$0.50 drift as T3 and invoke `ReconcileCustomerBalances`. Assert it
returns without crashing, a `balance_integrity_checks` row exists for
the mismatch with `alert_sent = false`, and `GET
/balance-integrity/checks` still returns it.

## File layout

- `db/migrations/20260929091500_balance_reconciliation.sql` -- new
  `customer_balance_cache`, `balance_integrity_checks` tables.
- `services/go-usage/internal/ledger/balance.go` -- new:
  `GetCustomerBalance`, `RecalculateCustomerBalance`,
  `ReconcileCustomerBalances`.
- `services/go-usage/internal/api/` -- new handlers for `POST
  /customers/{id}/recalculate-balance`, `GET /balance-integrity/checks`.
- `services/go-usage/cmd/server/main.go` -- register the two new
  routes; add the second ticker goroutine
  (`BALANCE_RECONCILIATION_INTERVAL_MS`).
- Tests: new directory `tests/balance-reconciliation/` (mirroring
  `tests/ledger/`'s shape -- `db.ts`/`env.ts`/`http.ts`, reusing
  `tests/ledger/fake-oncall.ts` and, for T5/T6-scale Go-side assertions,
  a one-shot Go test helper following `tests/ledger/worker-helper.go`'s
  exact precedent) implementing all 7 cataloged tests.

## Definition of done

- [ ] All 4 acceptance criteria satisfied by working code.
- [ ] All 7 cataloged tests have real automated tests that pass --
      functional, non-functional, and adversarial alike.
- [ ] `go vet ./...` clean in `services/go-usage`.
- [ ] `tests/ledger` (all TEID-32 tests, unchanged), `tests/cross-tenant`,
      `tests/usage-ingestion`, `tests/idempotency`, `tests/currency-rounding`,
      `tests/large-quantities`, `tests/billing-periods` all still pass
      unchanged.
- [ ] Full suite passes against a database rebuilt from scratch via
      `db/setup-local.sh` plus the existing seed scripts.
- [ ] PR description maps each test ID to its file/line.
