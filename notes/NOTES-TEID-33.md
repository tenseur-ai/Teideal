# TEID-33 implementation notes

The specification says generally that tests seed ledger transactions through
`PostTransaction`, while T5 specifically requires a one-million-customer data
set created with batched inserts. `PostTransaction` is intentionally a
single-transaction API (customer validation, one transaction insert, then its
lines), so it cannot perform a set-based million-row fixture load.

The conservative resolution is:

- T1, T3, T4, T6, and T7 post every synthetic ledger transaction through the
  existing `POST /ledger/transactions` handler, which calls `PostTransaction`.
- T2 and T5 use set-based SQL only for their 10,000- and 1,000,000-customer
  scale fixture setup, following TEID-32-T6's existing bulk-fixture precedent.
  Every inserted transaction still has an exact `receivable` debit and
  `revenue` credit. Trigger execution is disabled only on that superuser
  fixture session and only during setup; the reconciliation run itself uses
  the normal application role, RLS, and production function.

This preserves meaningful scale coverage without introducing a second batch
posting implementation into production code or turning fixture setup into
millions of sequential database round trips.
