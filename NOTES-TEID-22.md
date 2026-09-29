# NOTES-TEID-22

Decisions where the spec contradicts itself or the code already shipped. The hierarchy, the ceiling check, and the eight tests follow the spec's scoping notes where those notes and the implementation guidance disagree.

## Routes have no `/v1` prefix

The catalog and the architecture section say `POST /v1/organisations` and `GET /v1/organisations/:id/tree`. This service has never mounted a `/v1` prefix (`/customers`, `/grants`, `/api-keys`). The routes are `/organisations`, `/organisations/:id/teams`, `/organisations/:id/tree`, and `/organisations/:id/parent`. The catalog text also writes `GET /v1/organisations/Acme-Corp/tree`, using the name in the path. The spec's own implementation guidance uses the customer UUID (`:acmeId`). The route parameter is that UUID. Validation failures are 400. A customer the caller cannot see is 403 `{"error":"customer not found for this tenant"}`, the same shape as `POST /grants`, and the body does not echo the id.

`GET /organisations/:id/tree` is open to every console role. The three writes are Owner or Billing Admin. `:id` on the team route is any visible customer, not only a root, so a sub-team is the same insert with a deeper parent. That is the arbitrary depth the scoping notes describe.

## A root cannot be `balance_mode = 'pooled'`

`customers_root_is_isolated` requires a root to be isolated, and the scoping notes say the walk stops at the root because the root is always isolated. TEID-22-T2's implementation guidance says to create Acme-Corp with `balance_mode = 'pooled'` and a 50,000-credit grant. That insert is rejected by the constraint.

Acme-Corp is an isolated root that holds the 50,000-credit grant. That grant is the pool a pooled descendant would be debited against. ML-Team is `isolated` with its own 5,000-credit grant, so a draw under ML-Team debits ML-Team and leaves the organisation grant at 50,000. `POST /organisations` with `balance_mode: "pooled"` returns 400 `an organisation root must use an isolated balance` instead of a constraint error. Omitting the field stores `isolated`.

`customers.email` is `NOT NULL`. Organisation and team creates require `name` and `email`, the same check as `POST /customers`.

## Standalone roots still overage

`checkHierarchyLimits` rejects when the minimum remaining balance across grant-bearing ancestors is below the request. Applied to every customer, that would reject TEID-19-T3 and TEID-18-T8, which draw past a root customer's own grants and record an overage line. Those suites must keep passing, and `consumeAcrossGrants` is unchanged.

The rejecting check runs only when the requesting customer has a `parent_customer_id`. A standalone root is resolved (it is already isolated) and passed straight to `consumeAcrossGrants`. A nested customer, pooled or isolated, is ceiling-checked. T3's team has a parent, so its own 200 remaining rejects a 500 request even though the organisation still has 1,000. T2's team has a parent and both ceilings cover 4,000, so the isolated team is debited.

When several grant-bearing nodes are under the request by the same amount, the nearer node (smaller depth in the walk) is the one named on the rejection.

The ceiling sum uses the same active / started / unexpired predicate as `lockEligibleGrants`, including a grant whose `remaining_amount` is already 0. A zero balance is still a ceiling. The sum is not filtered by `unit`, matching the draw, which does not filter by unit either.

## T8 needs the lock before the check

The spec lists `checkHierarchyLimits`, then `resolveBillingCustomerId`, then the unmodified `consumeAcrossGrants`, and says `lockEligibleGrants`' `FOR UPDATE` is what makes T8 safe. `consumeAcrossGrants` does not reject a shortfall. It writes an overage line. A check that runs before that lock can see the same 100 remaining in both transactions; both pass; the second draw then takes the leftover 40 and overages 20. The pool stays non-negative, but both requests are approved and the remaining balance is 0, which is not T8.

`POST /customers/:id/consume` therefore, for a nested customer only:

1. Resolves the billing customer.
2. Locks that customer's eligible grants with the same predicate and `ORDER BY id` as `lockEligibleGrants`.
3. Runs `checkHierarchyLimits`.
4. On failure, returns 409 `{"error":"insufficient balance","governing_customer_id","available"}` and writes nothing. 409 and the error string are the existing grant-consume rejection; the governing node is what this story adds.
5. On success, calls unmodified `consumeAcrossGrants` with the resolved id.

The second of T8's two 60-credit requests blocks on the lock until the first commits, then sees 40 remaining and is rejected. The parent grant ends at 40. `consumeAcrossGrants` and `lockEligibleGrants` are not edited. The duplicate lock statement is the caller's copy of that predicate so the two locks cannot deadlock. Ancestor ceilings that are not the debit target are checked and not row-locked. T8's pool is the debit target.

The catalog text says the two requests come from two API keys. The consume route is the session-authenticated `POST /customers/:id/consume` from TEID-18. The test fires two concurrent calls on that route against the pooled team. The debited `customer_id` on the approved consumption is the organisation, which is the resolved pool.

## API keys stay TEID-92's keys

`api_keys.customer_id` is optional. `POST /api-keys` accepts it and rejects a customer the caller cannot see with the same 403 as the hierarchy routes. The create response includes `customer_id` (`null` when omitted). Rotation copies the association onto the replacement key so a rotated key does not fall off the tree. Billing Admin cannot create keys; TEID-22-T1 uses the Owner session for the key and the Billing Admin session for the organisation and the team. The tree nests `id`, `label`, `display_hint`, `scope`, and `environment`. It does not return `key` or `key_hash`. Keys are filtered by `issued_to_tenant_id` because `api_keys` has no RLS.

## One indexed ceiling query

`checkHierarchyLimits` is a single `WITH RECURSIVE` statement. A `path` array stops a corrupt cycle from looping the walk. Moves still reject a cycle by walking the proposed parent's ancestors, including the proposed parent itself, and writing nothing when the customer being moved appears. The migration's `customers_parent_customer_id_idx` is the spec's index. `grants_hierarchy_ceiling_idx` on `(tenant_id, customer_id) WHERE status = 'active'` is added as well: `grants` had no `customer_id` index, and T5's budget is this join repeated thousands of times after earlier suites have filled `grants`.

`customers_root_is_isolated` is created inside a `DO` block so a second `db/setup-local.sh` apply does not fail on "constraint already exists". The rest of the migration already uses `IF NOT EXISTS` and `DROP POLICY IF EXISTS`.

## T5 and T6

T5 builds organisation, pooled team, isolated sub-team, and a pooled customer standing in for the key level. Grants sit on the organisation (100) and the sub-team (5000). A check for 200 from the deepest customer is rejected in the organisation's name, which is only possible if the walk reached the fourth level. The timed section is `checkHierarchyLimits` itself, after a short warmup so the measured window is the sustained rate rather than the first plan. The target is 5,000 calls per second for 2 seconds with P99 under 20ms. There is no env-var scale-down; the catalog numbers are the assertion.

T6 inserts the 200 teams in one statement and times only `GET /organisations/:id/tree`. The 3 second budget is that response.
