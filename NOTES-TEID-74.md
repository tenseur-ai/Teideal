# TEID-74 implementation notes

The story is implemented from `specs/TEID-74.md`. A few statements in that
spec cannot be satisfied literally against the code that is already merged.
Each one below is resolved by reusing the existing schema and functions.

## Balance responses are not raw go-usage bodies

`RecalculateCustomerBalance` returns `recalculated_at` from `time.Now()`,
`encoding/json` writes `map[string]any` keys in a random order, and
shopspring/decimal's `MarshalJSON` emits `balance` as an unquoted JSON
number (a live call returned `"balance":0`). Two raw responses for the
same ledger are therefore not byte-identical.

`GET /processor-neutrality/disconnect-check` reads the ledger and commits
that read before it calls go-usage, so the cache write cannot change the
ledger portion. It then returns one object, in a fixed field order, with
`recalculated_at` omitted and `balance` kept as text: a JSON string is
passed through, and a finite JSON number is re-encoded with
`JSON.stringify`. T2 compares the ledger portion. T3 compares that balance
object and the raw HTTP body.

## The recalculation call reuses the existing endpoint

`api_keys` stores only a hash, and this service has no gRPC client. The
disconnect-check handler mints a sandbox admin key for the session's
tenant (`expires_at` two minutes out), calls the existing
`POST /customers/{id}/recalculate-balance?account_code=receivable`, and
revokes the key before returning. The plaintext is not logged or returned.
The receivable sum is not reimplemented in TypeScript.

## Other Stripe columns are not the customer reference

`stripe_connections.stripe_account_id` and
`stripe_customer_match_candidates.stripe_customer_id` also hold Stripe
identifiers. Connections are not customer rows, and match candidates have
no `customer_id`. T1 checks that `customers`, `ledger_transactions`,
`ledger_lines`, and `usage_events` have no Stripe column, and that
`stripe_customer_links` is the only table that has both `customer_id` and
a Stripe column.

## Six months of history cannot be backdated

`PostTransaction` stamps `created_at` with `now()`, and the ledger
immutability trigger rejects updates, including updates by a superuser.
T2 and T3 post six transactions through that endpoint, described as
2026-04 through 2026-09, instead of bypassing the trigger to rewrite
timestamps.

## "Connected customer" is the tenant's connection state

`stripe_connections` is one row per tenant connection, not per customer.
T5 times the by-Stripe-id lookup once while a connection is `connected`,
then disconnects every connected row for the tenant and times it again.
The lookup query does not read `stripe_connections.status`.

## Foreign keys are read from pg_catalog

`information_schema.constraint_column_usage` returns no rows for
`teideal_app`; that view lists only constraints the current user owns.
T1 reads `pg_constraint` and requires `ledger_transactions.customer_id`
and `usage_events.customer_id` to reference `customers`.

## T5's timed query is the processor-id lookup

The catalog title for T5 says to query by Teideal identifiers. The
architecture section names `GET /stripe/customers/by-stripe-id/:id` as
the timed lookup, for a connected and a disconnected state, and names the
missing `stripe_customer_id` index as the gap that lookup needs. The test
follows that section and also checks `EXPLAIN` uses
`stripe_customer_links_stripe_customer_id_idx`.

## Cleaning up the 100,000-row fixture

A normal `DELETE` of those customers checks every foreign key that
references `customers`. That statement was still running when the suite's
180 second hook timeout fired, after the seven tests had already passed.
`afterAll` deletes the fixture's `stripe_customer_links` and
`customer_balance_cache` rows, then the customers, on the superuser
connection with `session_replication_role = replica` so those triggers are
skipped for that transaction only. Production code does not do this.
