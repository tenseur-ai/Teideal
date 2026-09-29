# TEID-22: Customer hierarchy with pooled and isolated balances

| | |
|---|---|
| Epic | TEID-1 (E01 -- Implement entitlement model and pricing configuration) |
| Phase | E01 |
| Priority | High |
| Points | 8 |
| Release | mvp |
| Order | 34 (immediately after TEID-20) |
| Depends on | `customers`, `grants`/`consumeAcrossGrants`/`lockEligibleGrants` (TEID-17/18), `api_keys` (TEID-92), `recordConfigChangeWithClient` (TEID-42) |

## Story (verbatim from the live board)

> As a billing operator, I want to model an enterprise as an organisation with teams and API keys, choosing whether balances are shared or separate, so that limits and balances match how the customer's contract is actually structured.
>
> *Context*

## Acceptance criteria (verbatim from the live board)

1. An operator can create organisations, teams under organisations, and API keys under teams.
2. Each level can be set to use a pooled balance (shared with its parent) or an isolated balance.
3. A request is checked against every level above it, and the most restrictive limit wins.
4. Moving a team to a different organisation keeps its history and is recorded in the audit log.

## Cataloged tests (verbatim from the live board)

| ID | Type | AC | Title |
|---|---|---|---|
| TEID-22-T1 | Functional | 1 | Create organisation Acme-Corp, a team Acme-Corp/ML-Team under it, and an API key under ML-Team, and confirm the hierarchy is correctly reflected via GET /v1/organisations/Acme-Corp/tree. |
| TEID-22-T2 | Functional | 2 | Set ML-Team to an isolated balance with its own 5000-credit cap while organisation Acme-Corp uses a pooled 50000-credit balance, and confirm usage under ML-Team draws only from its own 5000 credits, not the org pool. |
| TEID-22-T3 | Functional | 3 | Configure an organisation with a 1000 USD remaining balance and a team under it with a 2000 USD isolated cap but only 200 USD remaining at the team level, submit a request for 500 USD, and confirm it is denied because the team's 200 USD limit, the more restrictive one, governs. |
| TEID-22-T4 | Functional | 4 | Move team Beta-Team from Organisation-A to Organisation-B, and confirm Beta-Team's usage history and balances remain intact and an audit log entry records the move with old parent, new parent, operator and timestamp. |
| TEID-22-T5 | Non-functional | 3 | Measure entitlement check latency for an API key nested four levels deep, organisation, team, sub-team and key, evaluating limits at every level, under 5000 checks per second, and confirm P99 stays under 20 milliseconds. |
| TEID-22-T6 | Non-functional | 1 | Create a hierarchy with 200 teams under a single organisation and confirm the organisation tree view in the console loads within 3 seconds. |
| TEID-22-T7 | Adversarial | 2 | Attempt to move a team so that it becomes its own ancestor by nesting it under one of its own descendant teams, and confirm the system rejects the circular hierarchy operation. |
| TEID-22-T8 | Adversarial | 3 | Fire concurrent requests against a team with a shared pooled balance from two API keys simultaneously, each requesting an amount that alone fits within the remaining pool but together exceed it, and confirm the pooled balance check prevents both from being approved and the pool never goes negative. |

## Scoping notes for this point in the build sequence

- **"Organisation" and "team" are both `customers` rows -- this is a tree
  extension of the existing flat table, not two new entities.** Every
  piece of machinery a node needs already exists and already keys off
  `customer_id`: `grants`, `usage_consumptions`, `usage_events`,
  `customer_rate_overrides`, `priced_usage_lines`. Adding a
  self-referencing `parent_customer_id` to `customers` means a "team" is
  simply a `customers` row with a parent, and every existing table,
  query, and RLS policy works on it unchanged. This also directly
  satisfies **T5**'s "sub-team" (a team can itself be the parent of
  another team -- there is no fixed org/team/sub-team depth limit,
  `parent_customer_id` nests arbitrarily deep).
- **"API keys under teams" reuses TEID-92's existing `api_keys` table
  with one new nullable column, not a new key system.** TEID-92's keys
  authenticate operator/developer access to Teideal's own API
  (tenant-scoped); this story does not change that. It adds an optional
  `customer_id` to `api_keys` so a key can be **associated with** a
  specific organisation/team node for the tree view and reporting
  (**T1**'s `GET /v1/organisations/:id/tree` groups keys under the node
  they're associated with). Which `customer_id` a given usage event
  bills against is still whatever `POST /usage`'s existing
  `customer_id` field names -- unchanged from every prior story.
- **"Pooled" and "isolated" resolve to one, and only one, debited node
  per request; "checked against every level above it" (AC3) is a
  separate, non-debiting ceiling check across every ancestor that has
  its own grants.** This reconciles **T2** ("draws only from its own
  5000 credits, not the org pool" -- an isolated node's balance is
  decremented, nothing above it is) with **T3** (the org's 1000 is still
  a real, checked ceiling even though the team is isolated -- it simply
  isn't the binding one here, since the team's own 200 is smaller). A
  pooled node has no grants of its own at all; its requests resolve
  upward to the nearest non-pooled ancestor (or the root) for both the
  ceiling check and the debit. An isolated node has its own grants,
  checked and debited at its own level, **plus** every ancestor above it
  that independently has its own grants is checked (not debited) as an
  additional ceiling -- the minimum available amount across every
  grant-bearing level in the chain governs (**T3**'s "the more
  restrictive one governs", read literally).
- **T5's entitlement-check latency SLA is E02's own headline
  requirement (`docs/parallel-work.md`'s E02 description: "p99 under 20
  ms"), applied here to hierarchy resolution specifically, before E02
  itself exists.** Agreed with the architect's own standing pattern
  (the same one TEID-37's `request-write-access` endpoint used for
  TEID-39/40): this story builds a real, narrow function
  (`checkHierarchyLimits`) that satisfies **T5**'s literal scenario --
  4 levels deep, 5000 checks/sec, P99 under 20ms -- as a single indexed
  recursive query, not a placeholder. It is not E02's entitlement-check
  API (no reservation/hold/settle lifecycle, no streaming/long-running
  job support, none of E02's other cataloged stories) -- it is the
  hierarchy-resolution piece E02 will need and can reuse once it exists,
  proven correct and fast now rather than later.
- **T7's cycle rejection is a plain ancestor-chain walk**, not a graph
  algorithm: before completing a move, walk the **proposed** new
  parent's own ancestor chain (via `parent_customer_id`) up to the root;
  if the team being moved appears in it, reject. Bounded by the tree's
  actual depth (small in practice, and **T6**'s 200-node test is
  breadth, not depth).
- **T8's concurrency guarantee is the existing `FOR UPDATE` row-lock
  pattern (`lockEligibleGrants`, TEID-18) applied to the resolved
  target, not a new primitive.** Two concurrent pooled requests from
  different teams both resolve to the same ancestor's grants; both
  transactions lock that ancestor's grant rows via the same mechanism
  TEID-19-T8 already relies on for its own concurrent-exhaustion
  guarantee -- correct by reuse, not by new design.

## Architecture and design

### Schema: `customers` and `api_keys` extended, one new table

New migration `db/migrations/20260929094500_customer_hierarchy.sql`:

```sql
ALTER TABLE customers ADD COLUMN IF NOT EXISTS parent_customer_id UUID REFERENCES customers(id);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS balance_mode TEXT NOT NULL DEFAULT 'isolated'
  CHECK (balance_mode IN ('pooled', 'isolated'));
-- A pooled node has no meaningful balance of its own -- see scoping notes.
ALTER TABLE customers ADD CONSTRAINT customers_root_is_isolated
  CHECK (parent_customer_id IS NOT NULL OR balance_mode = 'isolated');

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES customers(id);

-- AC4: history of a team's moves between parents, for the audit trail
-- and so a moved team's own usage/balance history is provably untouched
-- (nothing here references usage_events/grants -- the move never
-- touches them, which is itself the guarantee T4 checks).
CREATE TABLE IF NOT EXISTS customer_hierarchy_moves (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id),
  old_parent_customer_id UUID REFERENCES customers(id),
  new_parent_customer_id UUID REFERENCES customers(id),
  moved_by_user_id UUID REFERENCES users(id),
  moved_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE customer_hierarchy_moves ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_hierarchy_moves FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_customer_hierarchy_moves ON customer_hierarchy_moves;
CREATE POLICY tenant_isolation_customer_hierarchy_moves ON customer_hierarchy_moves
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT ON customer_hierarchy_moves TO teideal_app;

CREATE INDEX IF NOT EXISTS customers_parent_customer_id_idx ON customers (parent_customer_id);
```

### `services/ts-console/src/lib/customerHierarchy.ts` -- new file

- `resolveBillingCustomerId(client, tenantId, customerId): Promise<string>`
  -- walks `parent_customer_id` upward while the current node's
  `balance_mode = 'pooled'`, returns the first `isolated` node found (or
  the root, which is always isolated per the schema constraint above).
- `checkHierarchyLimits(client, tenantId, customerId, amount, asOf): Promise<{ ok: true } | { ok: false; governingCustomerId: string; available: number }>`
  -- one recursive query: `WITH RECURSIVE chain AS (SELECT id,
  parent_customer_id, balance_mode, 0 AS depth FROM customers WHERE id =
  $1 UNION ALL SELECT c.id, c.parent_customer_id, c.balance_mode,
  chain.depth + 1 FROM customers c JOIN chain ON c.id =
  chain.parent_customer_id)`, joined against each chain member's
  eligible, unexpired `grants` to sum `remaining_amount` per node,
  returning every node in the chain that has at least one grant. The
  caller takes the minimum across those (**AC3**, **T3**), identifying
  which node's limit governs a rejection. This is the function
  **T5** times directly.
- `moveCustomer(client, tenantId, customerId, newParentCustomerId, userId): Promise<void>`
  -- **T7**'s cycle check (walk `newParentCustomerId`'s own ancestors,
  reject if `customerId` appears), then `UPDATE customers SET
  parent_customer_id = $1`, an insert into
  `customer_hierarchy_moves`, and `recordConfigChangeWithClient`
  (`objectType: "Customer"`, `before: {parent_customer_id}`, `after:
  {parent_customer_id}`) -- all in one transaction. Never touches
  `grants`, `usage_events`, or any consumption table (**T4**'s "history
  and balances remain intact" is true by construction: nothing here
  references them).

### `consumeAcrossGrants` -- one call-site change, no logic change

`services/ts-console/src/routes/consumption.ts`'s existing handler
(TEID-18) calls `checkHierarchyLimits` first; on failure, returns the
existing "insufficient balance"-shaped rejection, naming the governing
node. On success, it calls `resolveBillingCustomerId` and passes
**that** id to the existing, unmodified `consumeAcrossGrants` --
`lockEligibleGrants`'s own `FOR UPDATE` locking already gives **T8** its
concurrency guarantee against the resolved target with zero new code
there.

### `POST /v1/organisations` (AC1) and `POST /v1/organisations/:id/teams` (AC1)

New file `services/ts-console/src/routes/customerHierarchy.ts`,
`consoleRoute`, role `["Owner", "Billing Admin"]`. Both are thin wrappers
over the existing `customers` insert (`services/ts-console/src/routes/customers.ts`'s
pattern, reused) plus `parent_customer_id`/`balance_mode` on the team
route. "Organisation" is simply a customer created with no parent.

### `GET /v1/organisations/:id/tree` (AC1, T1, T6)

Same file, same role gate (read-scoped variant). Recursive query
returning the full subtree (`{id, name, balance_mode, children: [...],
api_keys: [...]}`), with each node's associated `api_keys` (via the new
`api_keys.customer_id`) nested under it -- the stand-in for the console
tree view **T1**/**T6** reference.

### `PATCH /v1/organisations/:id/parent` (AC4, T4, T7)

Same file, same role gate. Body `{new_parent_customer_id}`. Calls
`moveCustomer`.

## Implementation guidance per test

### TEID-22-T1
`POST /v1/organisations` (Acme-Corp), `POST /v1/organisations/:id/teams`
(ML-Team, parent = Acme-Corp), create an API key with `customer_id` =
ML-Team's id. `GET /v1/organisations/:acmeId/tree`. Assert the response
shows ML-Team nested under Acme-Corp with the API key listed under
ML-Team.

### TEID-22-T2
Create Acme-Corp (`balance_mode = 'pooled'`, a 50,000-credit grant) and
ML-Team under it (`balance_mode = 'isolated'`, its own 5,000-credit
grant). Consume 4,000 credits under ML-Team. Assert ML-Team's own grant
now shows 1,000 remaining and Acme-Corp's grant is unchanged at 50,000.

### TEID-22-T3
Org with a 1,000 USD grant, team under it (isolated) with a 2,000 USD
grant but only 200 USD `remaining_amount`. Submit a 500 USD consume
request against the team. Assert it is rejected, and the rejection
names the team (not the org) as the governing, more-restrictive level.

### TEID-22-T4
Create Organisation-A and Organisation-B, Beta-Team under A with some
usage history. `PATCH /v1/organisations/:betaId/parent` to B's id.
Assert Beta-Team's `usage_events`/`grants`/`remaining_amount` are
byte-identical before and after, and `customer_hierarchy_moves` plus the
audit log both record old parent, new parent, actor, and timestamp.

### TEID-22-T5
Build a 4-level chain (org / team / sub-team / a customer representing
the "key" level) with grants at two of the four levels. Fire 5,000
`checkHierarchyLimits` calls per second for a sustained window. Assert
P99 latency stays under 20ms.

### TEID-22-T6
Create 200 teams under one organisation. `GET
/v1/organisations/:id/tree`. Assert it returns within 3 seconds.

### TEID-22-T7
Create org > team-A > team-B (B nested under A). Attempt `PATCH
/v1/organisations/:aId/parent` with `new_parent_customer_id: teamB.id`
(moving A under its own descendant B). Assert `400`/rejection, and that
`customers.parent_customer_id` for A is unchanged.

### TEID-22-T8
Team with a pooled balance resolving to a parent with exactly 100
credits remaining. Fire two concurrent consume requests for 60 credits
each (each individually fits in 100; together they don't). Assert
exactly one succeeds, the other is rejected as insufficient balance, and
the parent's final `remaining_amount` is never negative (40, matching
the one successful draw).

## File layout

- `db/migrations/20260929094500_customer_hierarchy.sql` -- `customers.parent_customer_id`/`balance_mode`,
  `api_keys.customer_id`, new `customer_hierarchy_moves` table.
- `services/ts-console/src/lib/customerHierarchy.ts` -- new:
  `resolveBillingCustomerId`, `checkHierarchyLimits`, `moveCustomer`.
- `services/ts-console/src/routes/customerHierarchy.ts` -- new: `POST
  /v1/organisations`, `POST /v1/organisations/:id/teams`, `GET
  /v1/organisations/:id/tree`, `PATCH /v1/organisations/:id/parent`.
- `services/ts-console/src/routes/consumption.ts` -- extended: calls
  `checkHierarchyLimits`/`resolveBillingCustomerId` before
  `consumeAcrossGrants`.
- `services/ts-console/src/server.ts` -- register the new route file.
- Tests: new directory `tests/customer-hierarchy/` implementing all 8
  cataloged tests, following `tests/consumption-order/`'s conventions.
- `tests/cross-tenant/` -- extended with cases for the four new
  endpoints.

## Definition of done

- [ ] All 4 acceptance criteria satisfied by working code.
- [ ] All 8 cataloged tests have real automated tests that pass --
      functional, non-functional, and adversarial alike.
- [ ] `tsc --noEmit` clean in `services/ts-console`.
- [ ] `tests/consumption-order` (all TEID-18 tests, unchanged),
      `tests/commits` (all TEID-19 tests, unchanged), `tests/grants`,
      `tests/plans`, `tests/rate-overrides`, `tests/cross-tenant`,
      `tests/api-keys` all still pass unchanged.
- [ ] Full suite passes against a database rebuilt from scratch via
      `db/setup-local.sh` plus the existing seed scripts.
- [ ] PR description maps each test ID to its file/line.
