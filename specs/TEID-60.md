# TEID-60: Sandbox environment

| | |
|---|---|
| Epic | TEID-9 (E09 -- Improve developer experience and testing) |
| Phase | E09 |
| Priority | High |
| Points | 5 |
| Release | mvp |
| Order | 51 (second story in this phase, after TEID-59) |
| Depends on | `tenants`, RLS tenant-isolation policy pattern (TEID-41), `api_keys`/`environment` column (TEID-92), `stripe_connections`/`exchangeCode` (TEID-37) |

## Story (verbatim from the live board)

> As a developer at our customer, I want a separate sandbox with its own keys, so that I can build and test without affecting real customers or money.
>
> *Context*

## Acceptance criteria (verbatim from the live board)

1. Every account has a sandbox with separate API keys and data.
2. The sandbox connects only to Stripe test mode and can never create live charges.
3. Sandbox configuration can be copied to production after review.

## Cataloged tests (verbatim from the live board)

| ID | Type | AC | Title |
|---|---|---|---|
| TEID-60-T1 | Functional | 1 | Create a sandbox for a test account and confirm it is issued a distinct sk_test-prefixed API key and stores its data separately from the production dataset. |
| TEID-60-T2 | Functional | 2 | Attempt to process a charge in the sandbox using a live Stripe card, and separately using a Stripe test-mode card, and confirm only the test-mode card is accepted and no live charge is ever created. |
| TEID-60-T3 | Functional | 3 | Configure pricing and plans in the sandbox, run the copy-to-production action, and confirm the configuration only appears in production after an explicit review-and-approve step. |
| TEID-60-T4 | Non-functional | 1 | Simulate a sandbox infrastructure outage and confirm production API availability and latency are unaffected. |
| TEID-60-T5 | Non-functional | 1 | Confirm sandbox and production are visually distinguished throughout the console (banner, color, label) so an operator cannot mistake one for the other. |
| TEID-60-T6 | Adversarial | 1 | Attempt to call the production API using a sandbox API key, and the sandbox API using a production key, and confirm both cross-environment attempts are rejected with a 401. |
| TEID-60-T7 | Adversarial | 2 | Attempt to paste a live Stripe secret key into the sandbox's processor configuration and confirm the system detects and blocks it to prevent an accidental live charge. |

## Scoping notes for this point in the build sequence

- **"Separate data" reuses this codebase's existing tenant-isolation
  machinery wholesale, rather than adding an `environment` column to
  every tenant-scoped table.** `api_keys.environment` (TEID-92) today is
  a label only (`sk_test_`/`sk_live_` prefix) -- confirmed by grep, no
  other table has an `environment` column and no query filters on it.
  Retrofitting every one of this schema's ~20 tenant-scoped tables with
  an environment column and a second predicate on every query would be
  invasive and error-prone. Instead, **a sandbox is a second `tenants`
  row**, linked to its parent by a new `parent_tenant_id`, and a
  sandbox-issued API key's `issued_to_tenant_id` points at that row, not
  the production tenant's. Every existing RLS policy, every existing
  query, already isolates by `tenant_id` with zero exceptions (TEID-41's
  own structural guarantee) -- a sandbox gets that isolation for free,
  with **zero schema changes to any table this story doesn't itself
  add**, and zero risk of a forgotten environment predicate on some
  future query.
- **No tenant-provisioning endpoint exists anywhere in this codebase
  today** -- tenants are seed-script-only. This story's `POST
  /tenants/:id/sandbox` is therefore the first-ever tenant-creation
  surface, deliberately narrow: it only ever creates a **sandbox**
  child of an **already-existing** tenant, never a new top-level
  account (general account signup/provisioning is not cataloged
  anywhere and is out of scope).
- **T2 and T7 describe a secret-key-paste Stripe integration model that
  does not exist in this codebase and is not this story's job to
  build.** TEID-37/38 built Stripe Connect's OAuth authorization-code
  flow exclusively -- there is no "paste your Stripe secret key" field
  anywhere, and adding one would mean a second, parallel Stripe
  integration pattern this backlog has never called for. **Narrowed
  scope, agreed with the architect before writing this spec**: both
  tests are scoped to the OAuth flow's own `livemode` field (already
  returned by Stripe's real token-exchange response and by
  `fake-stripe.ts`'s fake one, per TEID-37's design) -- a sandbox
  tenant's `POST /stripe/connect/callback` rejects the connection
  outright if the exchanged token's `livemode` is `true` (**T2**'s "live
  card" stands in for "a livemode Stripe account," **T7**'s "paste a
  live secret key" stands in for "complete an OAuth connection to a
  livemode account" -- both prevented the same way: at connection time,
  not at charge time, since no charge-creation code path exists to gate
  in the first place).
- **T3's "copy to production" is scoped to plans and plan rates only**,
  the clearest, narrowest reading of "pricing configuration" a developer
  would build and test in a sandbox before shipping -- not customers,
  usage, grants, or ledger data, which are inherently sandbox-only test
  artifacts with no sensible production equivalent to copy them into.
- **T4's "infrastructure outage" is scoped to what a shared-service,
  shared-database sandbox design can actually simulate**: since sandbox
  and production tenants run through the identical service processes
  and connection pool (by design, per the isolation approach above),
  there is no separate infrastructure to take down. This test instead
  proves the **absence of shared, blockable state** between the two:
  drive heavy concurrent load (errors and slow requests) against the
  sandbox tenant specifically, and confirm production-tenant request
  latency is unaffected -- a real regression guard against some future
  change accidentally introducing a global lock, single connection, or
  other cross-tenant contention point, rather than a literal
  infrastructure-teardown test.
- **T5's "visually distinguished" is the established stand-in**: no
  console UI exists anywhere in this repo. Every authenticated response
  (and a new `GET /tenants/:id` read) includes an explicit `kind:
  "sandbox" | "production"` field, standing in for the banner/color/label
  a future UI would render from it.
- **T6 is largely already true by construction, and this test proves
  it, not adds new logic for it.** A sandbox-issued key's
  `issued_to_tenant_id` is the sandbox tenant's own id; there is no
  "target environment" selector separate from the key itself anywhere
  in this auth model (a key already can only ever act as the one tenant
  it was issued to -- the same mechanism TEID-41 already proves
  exhaustively for cross-tenant isolation in general). This test is the
  sandbox-specific instance of that same guarantee, not new isolation
  logic.

## Architecture and design

### Schema: `tenants` gains two columns, one new table

New migration `db/migrations/20260929093000_sandbox.sql`:

```sql
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'production'
  CHECK (kind IN ('production', 'sandbox'));
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS parent_tenant_id UUID REFERENCES tenants(id);
ALTER TABLE tenants ADD CONSTRAINT tenants_sandbox_has_parent
  CHECK (kind = 'production' OR parent_tenant_id IS NOT NULL);
-- A production tenant has at most one sandbox (AC1's "a sandbox", singular).
CREATE UNIQUE INDEX IF NOT EXISTS tenants_one_sandbox_per_parent
  ON tenants (parent_tenant_id) WHERE kind = 'sandbox';

-- AC3: which plan/plan_rate rows have been reviewed and copied from a
-- sandbox into its parent production tenant, and when -- so a second
-- copy-to-production run can skip what already made it across.
CREATE TABLE IF NOT EXISTS sandbox_promotions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sandbox_tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  production_tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_plan_id UUID NOT NULL,
  created_plan_id UUID NOT NULL REFERENCES plans(id),
  promoted_by_user_id UUID REFERENCES users(id),
  promoted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE sandbox_promotions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sandbox_promotions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_sandbox_promotions ON sandbox_promotions;
CREATE POLICY tenant_isolation_sandbox_promotions ON sandbox_promotions
  USING (production_tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (production_tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT ON sandbox_promotions TO teideal_app;
```

`tenants` itself is read via the superuser/admin connection (it is the
RLS anchor, not RLS-scoped -- matching how `tenants` is already read
today), so no policy is added to it.

### `POST /tenants/:id/sandbox` (AC1, T1)

New file `services/ts-console/src/routes/sandbox.ts`, `consoleRoute`,
role `["Owner"]` (provisioning a whole environment is exactly the kind
of tenant-wide action `tenantSettings.ts`'s existing `Owner`-only
precedent is for), `requireSession`. Rejects if a sandbox already
exists for this tenant (`409`). Creates the child `tenants` row
(`kind = 'sandbox'`, `parent_tenant_id = :id`), then mints its first API
key via the existing TEID-92 key-issuance path
(`services/ts-console/src/routes/apiKeys.ts`'s `insertKey`, reused
directly) with `environment: 'sandbox'` against the **new** tenant id
-- producing a real `sk_test_...` key whose `issued_to_tenant_id` is the
sandbox tenant, not the caller's own. Returns `{sandbox_tenant_id,
api_key: {...}}` (the full plaintext key, once, per TEID-92-T2's
existing precedent).

### `GET /tenants/:id` (T5)

Same file, `requireAuth`/`consoleRoute` read access. Returns
`{id, kind, parent_tenant_id}` -- the stand-in for a UI banner.

### Stripe connect: one guard added to the existing callback (AC2, T2, T7)

`services/ts-console/src/routes/stripeConnect.ts`'s existing `POST
/stripe/connect/callback` (TEID-37) gains one check, inserted right
after `exchangeCode` returns: if the calling tenant's `kind =
'sandbox'` and the exchanged token's `livemode` is `true`, reject with
`403 {"error": "a sandbox cannot connect a live Stripe account"}`
**before** the token is ever encrypted or stored. `exchangeCode`'s
returned shape already omits `livemode` (per TEID-37's spec) -- this
story extends `ExchangedToken` with a `livemode: boolean` field read
from the same token-exchange response, and extends the fake double's
`/oauth/token` response to include it (defaulting `false`; tests
constructing a "live" fake connection pass a query param the fake
double reads to set `livemode: true` on that one issued token, matching
how `fake-stripe.ts` already varies `scope` per authorize call).

### `POST /tenants/:id/sandbox/promote-plans` (AC3, T3)

Same file, role `["Owner", "Billing Admin"]`. Two-step, matching every
other "review screen" stand-in in this backlog:
- `GET /tenants/:id/sandbox/promote-plans/preview`: reads the sandbox
  tenant's `plans`/`plan_rates` rows not yet present in
  `sandbox_promotions`, returns them as a diff-shaped preview (no
  writes).
- `POST /tenants/:id/sandbox/promote-plans` with `{plan_ids:
  string[]}` (the operator's explicit approval of a subset of the
  preview -- "after an explicit review-and-approve step", **T3**):
  for each named sandbox plan, inserts a new `plans`/`plan_rates` row
  under the **production** tenant (a copy, never a cross-tenant
  reference -- RLS forbids a foreign key spanning tenants in any case),
  records a `sandbox_promotions` row, and calls
  `recordConfigChangeWithClient` under the production tenant. Only
  callable by a user with access to **both** the sandbox and its parent
  (enforced by checking the sandbox's `parent_tenant_id` matches the
  caller's own tenant before proceeding).

## Implementation guidance per test

### TEID-60-T1
`POST /tenants/:id/sandbox`. Assert `201`, the returned key starts with
`sk_test_`, and its `issued_to_tenant_id` (readable via a direct DB
check) is the new sandbox tenant, not the caller's own. Create a
customer using the sandbox key and confirm `GET /customers` using the
**production** tenant's own key does not include it (separate data, by
the existing RLS mechanism).

### TEID-60-T2
Create a sandbox, then attempt `POST /stripe/connect/callback` against
it twice: once where the fake double's issued token carries
`livemode: true` (simulate "a live card"/live account), once
`livemode: false` (test-mode). Assert the first is rejected `403` with
no `stripe_connections` row created, and the second succeeds normally.

### TEID-60-T3
In a sandbox tenant, create a plan with rates. Call the preview
endpoint and assert it lists that plan. Call promote-plans with its id.
Assert a new `plans` row now exists under the **production** tenant
with matching rates, and a `sandbox_promotions` row records the
mapping. Confirm the plan did **not** appear in production before the
explicit promote call (only after preview, and only for the
specifically-approved id).

### TEID-60-T4
Create a sandbox and a production tenant. Drive 200 concurrent
error-triggering and slow requests against the **sandbox** tenant's API
key. Concurrently measure the **production** tenant's own request
latency and error rate. Assert production's p99 latency and error rate
are unaffected (within normal baseline variance) by the sandbox load.

### TEID-60-T5
`GET /tenants/:id` for both a sandbox and its parent production tenant.
Assert the response's `kind` field is `"sandbox"` and `"production"`
respectively.

### TEID-60-T6
Using a sandbox-issued key, attempt any authenticated request that
would only make sense against production data (e.g. reading a
production-only customer by id). Assert `403`/empty result (matching
this codebase's existing cross-tenant response shape, TEID-41). Using a
production key, attempt to read a sandbox-only customer. Assert the
same. (Framed as `401` on the live board; this codebase's established,
consistent response for "not visible to this tenant" is `403`/empty per
TEID-41's own design -- matching that existing precedent exactly, not
introducing a new `401` case for this one scenario.)

### TEID-60-T7
Repeat T2's live-connection attempt (fake double issuing
`livemode: true`) specifically framed as the adversarial case: assert
the rejection happens at the callback step, before any row is written
to `stripe_connections`, and that the tenant's Stripe connection status
afterward is exactly as if no connection attempt had ever been made.

## File layout

- `db/migrations/20260929093000_sandbox.sql` -- `tenants.kind`/
  `parent_tenant_id`, new `sandbox_promotions` table.
- `services/ts-console/src/routes/sandbox.ts` -- new: `POST
  /tenants/:id/sandbox`, `GET /tenants/:id`, `GET
  /tenants/:id/sandbox/promote-plans/preview`, `POST
  /tenants/:id/sandbox/promote-plans`.
- `services/ts-console/src/lib/stripeConnect.ts` -- extended:
  `ExchangedToken.livemode`, the sandbox/livemode guard in the callback
  route.
- `tests/stripe-connect/fake-stripe.ts` -- extended: an optional
  `livemode` param on `GET /oauth/authorize` propagated into the
  issued token's `/oauth/token` response.
- `services/ts-console/src/server.ts` -- register `sandbox.ts`.
- Tests: new directory `tests/sandbox/` implementing all 7 cataloged
  tests.
- `tests/cross-tenant/` -- extended with sandbox-specific cases (T6).

## Definition of done

- [ ] All 3 acceptance criteria satisfied by working code.
- [ ] All 7 cataloged tests have real automated tests that pass --
      functional, non-functional, and adversarial alike.
- [ ] `tsc --noEmit` clean in `services/ts-console`.
- [ ] `tests/stripe-connect` (all TEID-37/38 tests, unchanged),
      `tests/cross-tenant`, `tests/console-auth`, `tests/audit-log`,
      `tests/api-keys`, `tests/rbac`, `tests/plans` all still pass
      unchanged.
- [ ] Full suite passes against a database rebuilt from scratch via
      `db/setup-local.sh` plus the existing seed scripts.
- [ ] PR description maps each test ID to its file/line.
