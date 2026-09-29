# TEID-74: Ledger independent of any processor

| | |
|---|---|
| Epic | TEID-12 (E12 -- Implement processor-neutral payments) |
| Phase | E12 (new phase, no prior stories) |
| Priority | Highest |
| Points | 5 |
| Release | mvp |
| Order | 69 |
| Depends on | `customers`, `stripe_connections`/`stripe_customer_links` (TEID-37/38), `ledger_transactions`/`ledger_lines`/`allowedAccounts` (TEID-32), `GetCustomerBalance`/`balance_integrity_checks` (TEID-33) |

## Story (verbatim from the live board)

> As a founder, I want our ledger and history to use Teideal's own identifiers, with processor IDs stored only as references, so that changing payment processor never breaks our revenue history.
>
> *Context*

## Acceptance criteria (verbatim from the live board)

1. Every customer, invoice and payment has a Teideal identifier; processor identifiers are stored as references only.
2. Disconnecting a processor leaves the full ledger and history intact and readable.
3. An automated test removes a processor connection and confirms all balances and reports are unchanged.

## Cataloged tests (verbatim from the live board)

| ID | Type | AC | Title |
|---|---|---|---|
| TEID-74-T1 | Functional | 1 | Inspect the stored records for a customer, an invoice and a payment and confirm each carries a native Teideal identifier while the corresponding Stripe identifier appears only in a reference field. |
| TEID-74-T2 | Functional | 2 | Disconnect the Stripe connector on a test account holding 6 months of billing history and confirm the full ledger and every historical invoice remain intact and readable afterward. |
| TEID-74-T3 | Functional | 3 | Run the automated processor-disconnection test suite and confirm it removes a processor connection and asserts that all balances and reports are byte-identical before and after. |
| TEID-74-T4 | Non-functional | 3 | Confirm the automated processor-disconnection test from AC3 runs in CI on every pull request touching ledger code and blocks the merge on failure. |
| TEID-74-T5 | Non-functional | 1 | Query customer and invoice records by their Teideal identifiers across a dataset of 100,000 records and confirm lookup latency stays under 200ms regardless of processor connection state. |
| TEID-74-T6 | Adversarial | 2 | Disconnect a processor while a payment is mid-flight and confirm no ledger entry is lost, duplicated, or left in an inconsistent pending state. |
| TEID-74-T7 | Adversarial | 1 | After disconnecting a processor, attempt to look up a record using only its old processor ID and confirm the system still resolves the correct, consistent record via the stored reference. |

## Scoping notes for this point in the build sequence

- **"Invoice" and "payment" are not tables anywhere in this codebase --
  confirmed by an exhaustive grep, and this story does not add them.**
  No invoicing epic has been built yet (E06/E04's invoice-sync stories
  are phase-2 and unstarted). This story's actual, buildable claim is
  about the records that genuinely exist and genuinely hold financial
  history today: `customers`, `ledger_transactions`/`ledger_lines`
  (TEID-32 -- the append-only double-entry record of every balance
  change, the closest real analog to "invoice line items"), and
  `stripe_customer_links` (TEID-38 -- the only place a Stripe identifier
  is ever stored against a Teideal record). Every **T1/T2/T5/T7**
  assertion about "invoice"/"payment" is scoped to these real tables:
  a `ledger_lines` row with `account_code = 'cash'` (TEID-32's existing
  "payment received" account, per its `allowedAccounts` set) stands in
  for "a payment record" -- both already use exclusively Teideal-native
  UUIDs with zero Stripe reference anywhere in their own schema
  (confirmed by grep: `ledger_transactions`/`ledger_lines` have no
  Stripe-related column at all, satisfying AC1 for the ledger side
  *by construction*, not by new code).
- **AC1 is therefore already true for the ledger and largely true for
  customers -- this story's real work is proving it, plus closing one
  small real gap.** `customers.id` is already the sole primary key
  everything joins on; `stripe_customer_links.stripe_customer_id` is
  already a separate reference column, never used as a join key by
  anything outside `stripe_customer_links` itself (confirmed by grep
  across `services/ts-console/src/lib` and `internal/ledger`). The one
  real gap: `stripe_customer_links` has no index on
  `stripe_customer_id` -- **T5**'s 100,000-record/200ms lookup and
  **T7**'s "resolve via the stored reference" both need this to be a
  real index, not a sequential scan, since the whole point is that a
  lookup **by the old processor ID** must still work efficiently after
  disconnection (the reference itself is never deleted, only the
  connection's `status`).
- **AC3's "automated test... removes a processor connection" is
  TEID-33's own reconciliation machinery, run before and after a
  disconnect.** `GetCustomerBalance`/`ReconcileCustomerBalances`
  (go-usage) and a direct read of `ledger_transactions`/`ledger_lines`
  (byte-for-byte row comparison) are what "all balances and reports are
  unchanged" concretely means here -- there is no separate "report"
  concept to build; the ledger and its derived balance **are** the
  report.
- **T4's "runs in CI on every pull request touching ledger code" is
  satisfied by this repo's existing, unconditional CI shape, not new
  path-filtering logic.** `.github/workflows/ci.yml`'s `test` job
  already runs every suite, including this story's new one, on every
  single PR (there is no path-based conditional execution anywhere in
  this workflow, and none is added here) -- which trivially includes
  every PR that touches ledger code, plus every other PR, a strictly
  stronger guarantee than the literal ask.
- **T6's "mid-flight payment" is scoped to the real, existing
  concurrency primitive** -- TEID-32's `PostTransaction` is a single
  atomic DB transaction (insert `ledger_transactions` +
  `ledger_lines`, checked by the deferred sum-to-zero trigger at
  COMMIT). Disconnecting a Stripe connection
  (`stripe_connections.status`, a separate row, separate table) cannot
  partially observe or interrupt an in-flight `PostTransaction` call --
  the two operations share no lock, no table, and no transaction.
  Proven by running both concurrently and asserting the ledger
  transaction either fully commits or fully rolls back, exactly as
  TEID-32's own T8 already established for concurrent ledger writes in
  general.

## Architecture and design

### Schema: one index, no new tables

New migration `db/migrations/20260929120000_processor_neutral_lookup.sql`:

```sql
CREATE INDEX IF NOT EXISTS stripe_customer_links_stripe_customer_id_idx
  ON stripe_customer_links (stripe_customer_id);
```

### `GET /stripe/customers/by-stripe-id/:stripeCustomerId` (T1, T5, T7)

New file `services/ts-console/src/routes/processorLookup.ts`,
`consoleRoute`, role `["Owner", "Billing Admin"]`. Looks up
`stripe_customer_links` by `stripe_customer_id` regardless of the
owning `stripe_connections` row's `status` (connected or
disconnected), returns the linked Teideal `customer_id` and the
customer's own record. This is **T7**'s concrete "resolves the correct
record via the stored reference" surface, and **T5**'s timed lookup
target.

### `GET /processor-neutrality/disconnect-check?customerId=` (T2, T3, T6 -- test/verification surface)

Same file, same role gate. Runs, in one read-only pass:
1. `SELECT` the customer's full `ledger_transactions`/`ledger_lines`
   history (a stable, orderable snapshot -- `ORDER BY id`).
2. Calls `RecalculateCustomerBalance` (TEID-33, via an internal
   go-usage call) for the `receivable` account.
Returns both as a single JSON snapshot. The test suite calls this
**before** and **after** disconnecting the Stripe connection
(`POST /stripe/connections/:id/disconnect`, TEID-37, unchanged) and
asserts byte-identical results -- the concrete meaning of **AC3**'s
"balances and reports are unchanged."

## Implementation guidance per test

### TEID-74-T1
Read a `customers` row and its linked `stripe_customer_links` row
directly. Assert `customers.id` (a Teideal UUID) is what every other
table (`ledger_transactions.customer_id`, `usage_events.customer_id`)
joins on, and `stripe_customer_id` appears **only** in
`stripe_customer_links`, never duplicated into any other table.
Additionally query `ledger_lines WHERE account_code = 'cash'`
(the payment-record stand-in) and assert no row or its parent
transaction references any Stripe identifier.

### TEID-74-T2
Seed a customer with 6 months of `ledger_transactions`/`ledger_lines`
history and a connected Stripe connection. Call the disconnect-check
snapshot endpoint, disconnect the connection
(`POST /stripe/connections/:id/disconnect`), call the snapshot
endpoint again. Assert the ledger portion of both snapshots is
identical.

### TEID-74-T3
Same flow as T2, asserting the **balance** portion (from
`RecalculateCustomerBalance`) is also identical before and after.

### TEID-74-T4
Confirm (by reading `.github/workflows/ci.yml`) that this story's new
test file is registered as an unconditional step in the `test` job,
with no path filter excluding it from any PR.

### TEID-74-T5
Seed 100,000 `stripe_customer_links` rows. Time
`GET /stripe/customers/by-stripe-id/:id` for both a connected and a
disconnected customer's Stripe id. Assert both resolve correctly and
both complete under 200ms.

### TEID-74-T6
Fire a `PostTransaction` call and a `POST
/stripe/connections/:id/disconnect` call concurrently for the same
customer/tenant (`Promise.all`/goroutine equivalent). Assert the
ledger transaction either fully committed (both lines present, balance
trigger satisfied) or did not run at all -- never a partial state --
regardless of the disconnect's own outcome.

### TEID-74-T7
Disconnect a Stripe connection. Call
`GET /stripe/customers/by-stripe-id/:id` with the now-disconnected
connection's own `stripe_customer_id`. Assert it still resolves to the
correct, unchanged Teideal customer record (the reference row itself
is never deleted by a disconnect, only the connection's own status).

## File layout

- `db/migrations/20260929120000_processor_neutral_lookup.sql` -- new
  index on `stripe_customer_links.stripe_customer_id`.
- `services/ts-console/src/routes/processorLookup.ts` -- new: `GET
  /stripe/customers/by-stripe-id/:stripeCustomerId`, `GET
  /processor-neutrality/disconnect-check`.
- `services/ts-console/src/server.ts` -- register the new route file.
- Tests: new directory `tests/processor-neutrality/` implementing all
  7 cataloged tests, reusing `tests/stripe-connect/`'s fixtures and
  fake double.

## Definition of done

- [ ] All 3 acceptance criteria satisfied by working code.
- [ ] All 7 cataloged tests have real automated tests that pass --
      functional, non-functional, and adversarial alike.
- [ ] `tsc --noEmit` clean in `services/ts-console`.
- [ ] `tests/stripe-connect` (TEID-37/38, unchanged), `tests/ledger`
      (TEID-32, unchanged), `tests/balance-reconciliation` (TEID-33,
      unchanged), `tests/cross-tenant` all still pass unchanged.
- [ ] Full suite passes against a database rebuilt from scratch via
      `db/setup-local.sh` plus the existing seed scripts.
- [ ] PR description maps each test ID to its file/line.
