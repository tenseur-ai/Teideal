# TEID-60 implementation notes

## Application permission required for sandbox creation

The cataloged migration grants access to `sandbox_promotions`, but the new
`POST /tenants/:id/sandbox` endpoint also has to insert into `tenants` while
the service runs as `teideal_app`. The pre-existing schema grants that role
only `SELECT` on `tenants`. The migration therefore adds the narrow missing
`GRANT INSERT ON tenants TO teideal_app`; it does not grant update or delete.

## Promotion route identifier

The route shape uses `/tenants/:id/sandbox/promote-plans`, while the ownership
rule says to verify that the sandbox's `parent_tenant_id` is the caller's
tenant. I interpret `:id` on the two promotion routes as the sandbox tenant
ID. This is the only interpretation that permits that exact ownership check
without inferring a sandbox through a production ID. `:id` remains the parent
production tenant ID on `POST /tenants/:id/sandbox`, where it is the tenant
for which the sandbox is created.

## Promotion status

The spec says to copy plans and plan rates but does not say to publish the
new production plan. Promotion reuses the existing plan insertion path, so
the copied production plan is a draft with matching pricing configuration.
Publishing remains the existing explicit production action.

## Architect follow-up (2026-09-29)

Codex built the bulk of TEID-60 (migration, `sandbox.ts`, the
`stripeConnect.ts`/`apiKeys.ts` plumbing, `tests/sandbox/`'s fixtures) before
its usage window reset early. The architect completed and independently
verified the story from there. Two real gaps found and fixed, beyond the
test-fixture restructuring below:

**`GRANT INSERT` alone was not enough.** `POST /tenants/:id/sandbox` locks
the parent tenant row with `SELECT ... FOR UPDATE` before inserting the
sandbox (serializing concurrent creation attempts ahead of the unique-index
backstop). `FOR UPDATE` requires Postgres's `UPDATE` privilege on the table,
not just `SELECT` -- confirmed directly against a live Postgres 16 instance
via `docker logs`, which showed the exact failing statement was the `FOR
UPDATE` clause, not the plain `SELECT`. The migration now grants
`INSERT, UPDATE ON tenants`.

**Sandbox tenants have no console users**, so the existing session-scoped
Stripe OAuth flow (`GET /stripe/connect/authorize-url`, `POST
/stripe/connect/callback`) could never target a sandbox at all -- there is
no one who could ever be signed in as it. `stripeConnect.ts` now accepts an
optional `sandbox_id` query param on the authorize-url request; the caller's
own production session authorizes the request via a new exported
`ownedSandbox` check (from `sandbox.ts`), and the signed OAuth `state`
carries the real target tenant (`state.tenantId`), which may now differ from
the caller's own session tenant. The callback's anti-hijack check was
widened from a strict `state.tenantId === tenantId` equality to also accept
a sandbox the caller owns. This mirrors the existing `promote-plans` pattern
(`:id` in the URL names the target, the caller's session authorizes it).

**`tests/sandbox/sandbox.test.ts` was restructured** from one sandbox per
test (via a shared `createSandbox()` helper called independently in all 7
`it()` blocks) to a single sandbox created once in `beforeAll`, because
`tenants_one_sandbox_per_parent` is a real unique constraint (AC1's "a
sandbox" is singular) -- only the first per-test creation could ever
succeed. T7 (asserts zero `stripe_connections` rows) now runs before T2
(which leaves the sandbox connected), relying on vitest's default sequential
execution within a `describe` block.

**T6 as originally written used a console session token (`billingSession()`)
to `POST /customers`**, but that route requires an API key
(`requireAuth(pool, "admin")`), not a session -- it would have always
401'd. Per the spec's actual T6 text ("using a sandbox-issued key... and the
sandbox API using a production key"), both directions now use real API
keys: the sandbox key (already minted) against a directly-inserted
production customer, and a freshly-minted production key (via `POST
/api-keys`) against a directly-inserted sandbox customer. Fixture inserts
follow `tests/cross-tenant`'s existing convention of writing rows directly
rather than through auth meant for a different credential type.

Full regression run against a disposable, isolated Postgres 16 container
(never the shared one): `tests/sandbox` (7/7), `tests/stripe-connect`
(16/16, TEID-37/38 unchanged), `tests/cross-tenant` (70/70),
`tests/console-auth` (13/13), `tests/audit-log` (7/7), `tests/api-keys`
(9/9), `tests/rbac` (8/8), `tests/plans` (9/9). `tsc --noEmit` clean in
`services/ts-console`.
