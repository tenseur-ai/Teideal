# TEID-32 implementation notes

## Spec gap: direct Go worker invocation from a TypeScript suite

The file layout requires all eight cataloged acceptance tests under
`tests/ledger/`, mirroring the TypeScript/Vitest-only `tests/idempotency/`
suite. T5 and T6 also require those tests to call the Go function
`CheckAllTransactionsBalanced` directly, while the endpoint design defines
exactly three production routes and intentionally defines no test-only route.
TypeScript cannot import a Go function in-process.

The conservative resolution is `tests/ledger/worker-helper.go`: a one-shot Go
test helper in a tiny nested module whose import path remains inside
`teideal/go-usage`, allowing it to import the service's `internal/ledger`
package. The Vitest T5/T6 cases execute that helper, which opens the ordinary
application database pool, calls `CheckAllTransactionsBalanced` exactly once
with the supplied fixed instant, reports timing as JSON, and exits. This keeps
the production API surface exactly as specified and tests the real exported
function rather than duplicating its SQL or waiting for the ticker.

## Performance-supporting index

The specified deferred constraint trigger queries `ledger_lines` by
`transaction_id` once for every inserted row. The schema excerpt did not list
an index for that predicate, which would make ordinary posting progressively
scan the entire ledger and conflict with T6's 50-million-row/concurrent-write
requirement. The migration adds only
`ledger_lines_transaction_id_idx (transaction_id)`. It changes no data model,
constraint, trigger, or API semantics; it makes the specified trigger viable
at the specified scale.
