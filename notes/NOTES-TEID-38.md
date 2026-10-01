# TEID-38 implementation notes

The spec was implementable as written. A few points needed a conservative
choice so the eight tests and TEID-37's existing suite can share one
database and one fake process.

## Which connected Stripe row the new endpoints load

The four customer endpoints "load the tenant's connected
`stripe_connections` row". TEID-37 leaves more than one `connected` row
in the shared tenant (T1/T3/T8 each insert). The endpoints take the most
recently connected row (`status = 'connected' ORDER BY connected_at DESC
LIMIT 1`) and then call `readUsableAccessToken`. Each TEID-38 test
completes its own OAuth flow immediately before the call under test, so
that row is the one the test just created.

## `createStripeCustomer` needs the connection's scope

The spec's signature is `createStripeCustomer(accessToken, { name, email })`
and also says that function "calls `assertWriteScope` first".
`assertWriteScope` reads `connection.scope`, which is not in the access
token. The implemented signature is
`createStripeCustomer(accessToken, { name, email }, connection: { scope })`.
The route still calls `assertWriteScope` only on T3's create-in-Stripe
path; T4 and matching never write to Stripe.

## Partial unique index

The SQL block in the architecture section did not include the partial
unique index the endpoint design then uses
(`ON CONFLICT (tenant_id, stripe_customer_id) WHERE status = 'pending'`).
The migration adds `stripe_customer_match_candidates_pending_uniq` so
that upsert is a real constraint, not an application-only check.

## `matched_by = 'stripe_id'`

The CHECK constraint includes `'stripe_id'`. The matching order is
"already in `stripe_customer_links.stripe_customer_id`, skip" and then
exact-email. An ID hit is a no-op on an existing link, so this story
never INSERTs a row with `matched_by = 'stripe_id'`. The value stays in
the constraint as specified.

## T8 tests both scope layers

`assertWriteScope` runs before the fake is called, so a passing 403 on
`POST /stripe/customers/:id/link-stripe` alone would not prove the
double's own check. T8 also POSTs `/v1/customers` at the fake with the
read-only bearer token and asserts `403 {"error":"read_only"}`, and
asserts the Teideal call never produced a `POST /v1/customers` in the
fake log.

## T6 versus leftover review rows

`GET /stripe/customers/match-candidates` returns every pending row in
the tenant, including candidates earlier tests queued. T6 accounts for
its 10,000 seeded customers by `linked + candidates` on the sync
response, then checks that the follow-up GET's rows whose
`stripe_customer_id` starts with `cus_t6_` equal that `candidates`
count.

## Create-in-Teideal when Stripe has no name

`customers.name` is `NOT NULL`; `stripe_name` is nullable. If a pending
candidate has an email and no name, the insert uses the email as the
name. T4 seeds both.

## `STRIPE_API_BASE_URL`

`stripeCustomers.ts` reads it (default `https://api.stripe.com`).
`server.ts` calls `stripeApiBaseUrl()` at app construction so the env
var is consulted. CI and the stripe-connect test env point it at the
same fake process as `STRIPE_CONNECT_BASE_URL`.
