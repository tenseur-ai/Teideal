# TEID-38: Sync customers with Stripe

| | |
|---|---|
| Epic | TEID-4 (E04 -- Develop Stripe connector (read-first) and invoice sync) |
| Phase | E04 |
| Priority | High |
| Points | 5 |
| Release | mvp |
| Order | 37 (second story in this phase) |
| Depends on | `stripe_connections` (TEID-37), `readUsableAccessToken`/`loadStripeEnv` (`services/ts-console/src/lib/stripeConnect.ts`), `customers` table, `recordConfigChangeWithClient` (TEID-42), `consoleRoute`/`requireSession` (TEID-43) |

## Story (verbatim from the live board)

> As a billing operator, I want our customers linked to their Stripe customer records, so that invoices and payments line up with the right account.
>
> *Context*

## Acceptance criteria (verbatim from the live board)

1. Existing Stripe customers can be matched to our customers automatically by ID or email, with a review screen for uncertain matches.
2. New customers created in either system can be linked, with the operator choosing which system creates the Stripe record.
3. A customer can never be linked to more than one Stripe customer.

## Cataloged tests (verbatim from the live board)

| ID | Type | AC | Title |
|---|---|---|---|
| TEID-38-T1 | Functional | 1 | Run the sync with a Stripe test account containing customers whose email exactly matches an existing Teideal customer and confirm each is automatically linked by that shared email. |
| TEID-38-T2 | Functional | 1 | Run the sync with a Stripe test account containing a customer whose email is a close but not exact variant of an existing Teideal customer's email and confirm it is queued for manual review rather than auto-linked. |
| TEID-38-T3 | Functional | 2 | Create a new customer in Teideal, choose "create in Stripe," and confirm a corresponding Stripe customer record is created and linked. |
| TEID-38-T4 | Functional | 2 | With an existing Stripe customer that has no Teideal match, choose "create in Teideal," and confirm a new Teideal customer is created from the Stripe record's name and email and linked. |
| TEID-38-T5 | Functional | 3 | Attempt to link a Teideal customer that is already linked to a Stripe customer to a second, different Stripe customer and confirm the request is rejected. |
| TEID-38-T6 | Non-functional | 1 | Run the sync against a Stripe test account with 10,000 customers and confirm matching completes and the review queue is populated within 5 minutes. |
| TEID-38-T7 | Adversarial | 3 | Submit two concurrent link requests for the same Teideal customer against two different Stripe customer IDs and confirm only one succeeds and the other is rejected, not both silently applied. |
| TEID-38-T8 | Adversarial | 1 | Submit a sync request using a Stripe connection whose scope is read-only and confirm the sync still succeeds (it only reads Stripe customers, never writes), while a manual "create in Stripe" request against the same read-only connection is rejected. |

## Scoping notes for this point in the build sequence

- **"Review screen" has no UI, same precedent as every prior story.**
  Matching TEID-31's `idempotency_conflicts` review-queue table exactly:
  an uncertain match is written to a new `stripe_customer_match_candidates`
  table rather than displayed, and a `GET
  /stripe/customers/match-candidates` endpoint stands in for the screen
  T2 references.
- **"Automatically by ID or email" -- ID matching needs a starting
  point.** Nothing in this schema stores a Stripe customer ID against a
  Teideal customer before this story runs, so "matched by ID" only
  applies on a **second** sync run, once at least one link already
  exists (a link created by this run's own email match, or by T3/T4's
  create-and-link flows). The sync's matching order is: exact
  `stripe_customer_links.stripe_customer_id` match first (a no-op if
  already linked), then exact-email match (T1), then everything else
  becomes a review candidate (T2) -- this is a genuine, literal ID-match
  path, not a placeholder, it just has nothing to match on until a link
  exists.
- **"Close but not exact variant" (T2) is scoped to a concrete,
  checkable rule**, following TEID-92-T9's "prove a negative" style of
  making a fuzzy AC concrete: any Stripe customer whose email does not
  case-insensitively equal exactly one existing Teideal customer's email
  is a review candidate. This correctly includes the T2 scenario
  (`Jane.Doe@acmeco.com` vs `jane.doe@acmeco.co` -- different domain, not
  a match) without needing a fuzzy-matching library.
- **AC2's "operator choosing which system creates the Stripe record"
  covers two directions, not one.** T3 covers Teideal-customer-exists,
  create-in-Stripe. T4 covers Stripe-customer-exists (from the sync's
  own read, unmatched), create-in-Teideal. Both are explicit endpoints,
  not a single ambiguous "link" call, so the operator's choice of
  direction is a choice of which endpoint to call, not a flag.
- **T8's "read-only sync still succeeds" is the same guard TEID-37
  already built, applied correctly for the first time by a caller.**
  `GET /stripe/customers` (Stripe's list-customers endpoint) is called
  regardless of scope -- reading is never gated by
  `assertWriteScope`. Only the two endpoints that write to Stripe
  (T3's create-in-Stripe) call `assertWriteScope` first; T4 (create in
  Teideal, not Stripe) and matching/linking (AC1, AC3) never call Stripe
  at all beyond the read, so they are unaffected by scope.
- **The fake double needs a second surface.** `tests/stripe-connect/fake-stripe.ts`
  only implements the Connect OAuth host today. This story adds `GET
  /v1/customers` (list, `email` query param for exact-match filtering,
  Stripe's real shape) and `POST /v1/customers` to the same fake
  process (matching `fake-s3.ts`'s own precedent of one fake process
  covering more than one logical Stripe/AWS host), gated on
  `Authorization: Bearer <token>` matching a token the OAuth flow
  actually issued (T8's "read-only connection" scenario needs the fake
  to know which scope a given bearer token was issued with, so it can
  reject a write with a Stripe-shaped `403` the same way real Stripe
  would -- extend `IssuedCode`'s in-memory record to be looked up by
  issued `accessToken`, not deleted after the OAuth exchange completes).
- **T6's 10,000-customer/5-minute budget is a full sync run**, not a
  single customer -- batched Stripe list-customer pages (100 per page,
  Stripe's real default) processed and matched in batches, not one
  Stripe API call per Teideal customer.

## Architecture and design

### Schema: two new tables

New migration `db/migrations/20260929090000_stripe_customers.sql`:

```sql
CREATE TABLE IF NOT EXISTS stripe_customer_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL UNIQUE REFERENCES customers(id),
  stripe_customer_id TEXT NOT NULL,
  matched_by TEXT NOT NULL CHECK (matched_by IN ('stripe_id', 'email', 'manual_create_in_stripe', 'manual_create_in_teideal')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE stripe_customer_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_customer_links FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_stripe_customer_links ON stripe_customer_links;
CREATE POLICY tenant_isolation_stripe_customer_links ON stripe_customer_links
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
-- AC3: a customer_id can only ever have one row (UNIQUE above). A
-- stripe_customer_id is intentionally NOT unique here -- nothing in this
-- story requires the reverse (one Stripe customer could, in principle,
-- be re-synced after a Teideal-side merge/rename; that is out of scope).
GRANT SELECT, INSERT ON stripe_customer_links TO teideal_app;

CREATE TABLE IF NOT EXISTS stripe_customer_match_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  stripe_customer_id TEXT NOT NULL,
  stripe_name TEXT,
  stripe_email TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'dismissed')),
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
ALTER TABLE stripe_customer_match_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_customer_match_candidates FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_stripe_customer_match_candidates ON stripe_customer_match_candidates;
CREATE POLICY tenant_isolation_stripe_customer_match_candidates ON stripe_customer_match_candidates
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON stripe_customer_match_candidates TO teideal_app;
```

`matched_by` records which of AC1's two automatic paths or AC2's two
manual paths produced the link, for the audit trail and for T1/T3/T4's
assertions to check against, not just that a link exists.

### `services/ts-console/src/lib/stripeCustomers.ts` -- new file

- `listStripeCustomers(accessToken, { email? })`: `fetch(`${STRIPE_API_BASE_URL}/v1/customers?...`, { headers: { Authorization: `Bearer ${accessToken}` } })`, paginating on Stripe's `has_more`/`starting_after`, returning `{id, name, email}[]`.
- `createStripeCustomer(accessToken, { name, email })`: `assertWriteScope` first, then `POST ${STRIPE_API_BASE_URL}/v1/customers`.
- `STRIPE_API_BASE_URL` env var, default `https://api.stripe.com`, overridden to the fake double's URL in tests (same fake process as `STRIPE_CONNECT_BASE_URL`, different path prefix).

### `POST /stripe/customers/sync` (AC1, T1, T2, T6, T8)

New file `services/ts-console/src/routes/stripeCustomers.ts`, `consoleRoute`, role `["Owner", "Billing Admin"]`, `requireSession`. Loads the tenant's connected `stripe_connections` row, calls `readUsableAccessToken` (works regardless of scope -- read-only is sufficient, T8). Lists all Stripe customers, then for each:
1. If its `id` already appears in `stripe_customer_links.stripe_customer_id`, skip (already linked).
2. Else if its email case-insensitively matches exactly one `customers.email` in this tenant that has no existing `stripe_customer_links` row, insert a link with `matched_by = 'email'`.
3. Else, upsert a `stripe_customer_match_candidates` row (`ON CONFLICT (tenant_id, stripe_customer_id) WHERE status = 'pending'` -- add a partial unique index for this) with `status = 'pending'`.

Returns `{linked: N, candidates: N}`. Runs the whole list+match loop inside one `withTenant` transaction per batch of 100 Stripe customers (T6's throughput target), not one DB round-trip per customer.

### `GET /stripe/customers/match-candidates` (review screen stand-in, T2)

Same file, same role gate. `SELECT * FROM stripe_customer_match_candidates WHERE status = 'pending' ORDER BY detected_at`.

### `POST /stripe/customers/:customerId/link-stripe` (AC2, T3, T7, T8)

Same file, same role gate. Body `{stripe_customer_id}` OR `{create_new: true, name, email}` (T3's "create in Stripe" path -- calls `createStripeCustomer`, which calls `assertWriteScope` first, so a read-only connection gets `403 StripeScopeError`, T8's second half). Either way, inserts into `stripe_customer_links` with `matched_by = 'manual_create_in_stripe'` (create path) or checks the given `stripe_customer_id` is a real Stripe customer via `listStripeCustomers` before linking (no `matched_by` value needed beyond marking it manual -- reuse `'manual_create_in_stripe'` for both, since both result in a Teideal customer pointed at a Stripe-side record it did not exist-match). `INSERT ... ON CONFLICT (customer_id) DO NOTHING` inside `SELECT ... FOR UPDATE` on the customer row (T7's concurrency guard -- the `UNIQUE` constraint is the ultimate backstop, but locking first gives a clean `409`, not a raw constraint-violation `500`, to the loser of the race), returning `409 {"error": "customer is already linked to a Stripe customer"}` for AC3's rejection (T5) or T7's race loser.

### `POST /stripe/candidates/:id/create-in-teideal` (AC2, T4)

Same file, same role gate. Loads the pending candidate, `INSERT INTO customers (tenant_id, name, email) VALUES (...)` from the candidate's `stripe_name`/`stripe_email`, then `INSERT INTO stripe_customer_links (..., matched_by = 'manual_create_in_teideal')`, marks the candidate `status = 'resolved'`, `resolved_at = now()`. Both inserts and the audit call (`recordConfigChangeWithClient`, `objectType: "Customer"`) happen in one `withTenant` transaction.

### The fake Stripe double -- extended, not replaced

`tests/stripe-connect/fake-stripe.ts` gains:
- `GET /v1/customers` (optional `email` query param, `starting_after`/`has_more` pagination): requires `Authorization: Bearer <token>` matching a token this fake process issued via `/oauth/token`; returns the fake's own in-memory seeded customer list (tests seed it via a new `POST /_seed/customers` debug endpoint, matching `/_requests`'s existing debug-endpoint precedent).
- `POST /v1/customers`: same auth check, additionally rejects (`403 {"error": "read_only"}`) if the matched token's issued scope was `read_only` -- the fake enforcing the same rule Stripe itself would, so T8's "manual create is rejected" is a real assertion against the double's own scope check, not only against Teideal's own `assertWriteScope` guard (both layers are tested).
- `issued` tokens are no longer deleted from an exchange-only map; a small `issuedTokens: Map<string, {scope, stripeCustomers: Map<string, {name,email}>}>` keyed by `accessToken` persists for the life of the fake process, seeded per-connection at OAuth-exchange time.

## Implementation guidance per test

### TEID-38-T1
Seed the fake double with 3 Stripe customers, one whose email exactly matches an existing Teideal customer (case-different: `Jane@Acme.com` vs `jane@acme.com`). `POST /stripe/customers/sync`. Assert the response's `linked` count includes that customer and `stripe_customer_links` has a row for it with `matched_by = 'email'`.

### TEID-38-T2
Seed a Stripe customer whose email is `jane.doe@acmeco.co` against an existing Teideal customer `jane.doe@acmeco.com` (different TLD). Sync. Assert no link was created and `GET /stripe/customers/match-candidates` includes this Stripe customer with `status: 'pending'`.

### TEID-38-T3
Create a Teideal customer with no existing link. `POST /stripe/customers/:id/link-stripe` with `{create_new: true, name, email}` against a connection with `read_write` scope. Assert `201`, a `stripe_customer_links` row with `matched_by = 'manual_create_in_stripe'`, and the fake double's seeded customer list now contains the new Stripe customer (captured via the fake's own state, not just Teideal's side).

### TEID-38-T4
Seed a Stripe customer with no matching Teideal customer; sync to produce a `pending` candidate. `POST /stripe/candidates/:id/create-in-teideal`. Assert `201`, a new `customers` row with the candidate's name/email, a `stripe_customer_links` row (`matched_by = 'manual_create_in_teideal'`), and the candidate's `status` is now `resolved`.

### TEID-38-T5
Link a customer via T3's flow. Attempt a second `POST /stripe/customers/:id/link-stripe` against the same customer with a different `stripe_customer_id`. Assert `409` and that `stripe_customer_links` still has exactly one row for that customer, unchanged.

### TEID-38-T6
Seed the fake double with 10,000 customers (a mix designed so roughly a third match by email and the rest become candidates). `POST /stripe/customers/sync`, time the response. Assert it returns within 5 minutes and the sum of `linked` + `candidates` in the response, plus a follow-up `GET /stripe/customers/match-candidates` count, together account for all 10,000.

### TEID-38-T7
Create one unlinked customer. Fire two concurrent `POST /stripe/customers/:id/link-stripe` requests against two different `stripe_customer_id` values. Assert exactly one returns `201` and the other returns `409`, and `stripe_customer_links` has exactly one row for that customer matching whichever request won.

### TEID-38-T8
Complete a Stripe connection with `read_only` scope. `POST /stripe/customers/sync` and assert it succeeds normally (reads are unaffected by scope). Then `POST /stripe/customers/:id/link-stripe` with `{create_new: true, ...}` against the same connection and assert `403` (from `assertWriteScope`, propagated as `StripeScopeError`).

## File layout

- `db/migrations/20260929090000_stripe_customers.sql` -- new
  `stripe_customer_links`, `stripe_customer_match_candidates` tables.
- `services/ts-console/src/lib/stripeCustomers.ts` -- new: Stripe
  customer list/create HTTP calls.
- `services/ts-console/src/routes/stripeCustomers.ts` -- new: `POST
  /stripe/customers/sync`, `GET /stripe/customers/match-candidates`,
  `POST /stripe/customers/:customerId/link-stripe`, `POST
  /stripe/candidates/:id/create-in-teideal`.
- `services/ts-console/src/server.ts` -- register the new route file;
  read `STRIPE_API_BASE_URL` (default `https://api.stripe.com`).
- `tests/stripe-connect/fake-stripe.ts` -- extended with `GET/POST
  /v1/customers` and a `/_seed/customers` debug endpoint.
- Tests: new files under `tests/stripe-connect/` (this story's tests
  belong in the same suite/directory as TEID-37's, since they share the
  same fake double and connection fixtures) implementing all 8
  cataloged tests.
- `tests/cross-tenant/stripe-connect-isolation.test.ts` -- extended:
  cross-tenant cases for the four new endpoints.

## Definition of done

- [ ] All 3 acceptance criteria satisfied by working code.
- [ ] All 8 cataloged tests have real automated tests that pass --
      functional, non-functional, and adversarial alike.
- [ ] `tsc --noEmit` clean in `services/ts-console`.
- [ ] `tests/stripe-connect` (all TEID-37 tests, unchanged), `tests/cross-tenant`,
      `tests/console-auth`, `tests/audit-log`, `tests/api-keys`, `tests/rbac`,
      `tests/data-export`, `tests/plans`, `tests/grants`,
      `tests/consumption-order`, `tests/commits`, `tests/rate-overrides`
      all still pass unchanged.
- [ ] Cross-tenant isolation proven in `tests/cross-tenant` for every new
      endpoint.
- [ ] Full suite passes against a database rebuilt from scratch via
      `db/setup-local.sh` plus the existing seed scripts.
- [ ] PR description maps each test ID to its file/line.
