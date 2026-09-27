# TEID-43: Role-based access

| | |
|---|---|
| Epic | TEID-5 (E05 -- Establish tenant isolation, access control, and data ownership) |
| Phase | E05 |
| Priority | High |
| Points | 5 |
| Release | mvp |
| Order | 5 (within E05) |
| Depends on | `users.role` (TEID-91, `db/migrations/20260926180000_auth.sql`), `ConsolePrincipal`/`requireSession` (`services/ts-console/src/lib/sessionAuth.ts`), `recordConfigChangeWithClient` (TEID-42, `services/ts-console/src/lib/audit.ts`), `tenant_settings`/`getTenantSettings` (TEID-91, `services/ts-console/src/lib/tenants.ts`), API key endpoints (TEID-92, `services/ts-console/src/routes/apiKeys.ts`) |

## Story (verbatim from the live board)

> As a account owner, I want to give each team member only the access they need, so that support and finance can do their jobs without being able to change pricing.
>
> *Context*

## Acceptance criteria (verbatim from the live board)

1. Built-in roles: Owner, Billing Admin, Finance (read and approve adjustments), Support (read only), Developer (API keys and sandbox).
2. Each API endpoint and console screen checks the user's role.
3. Role changes are recorded in the audit log.
4. Single sign-on can be enabled for the account (phase 2 for SAML).

## Cataloged tests (verbatim from the live board)

| ID | Type | AC | Title |
|---|---|---|---|
| TEID-43-T1 | Functional | 1 | Create one user for each of the five built-in roles Owner, Billing Admin, Finance, Support and Developer and confirm each is assignable and correctly labeled in the user management screen. |
| TEID-43-T2 | Functional | 2 | Log in as a Support-role user and attempt to open the plan-editing screen and call PATCH /plans directly, and confirm both the UI and the API return 403 since Support is read-only. |
| TEID-43-T3 | Functional | 3 | Change a user's role from Developer to Finance and confirm an audit log entry captures the user, old role, new role, acting admin and timestamp. |
| TEID-43-T4 | Functional | 4 | As an Owner, enable single sign-on for the account and confirm the login screen now offers an SSO option consistent with the documented phase-2 scope. |
| TEID-43-T5 | Non-functional | 2 | Add a new console screen without a role annotation on its route and confirm the build or deployment pipeline fails the regression guard rather than shipping an unguarded screen. |
| TEID-43-T6 | Non-functional | 2 | As a Support user, navigate to a restricted screen and confirm the UI shows a clear explanatory access-denied message rather than a blank page or generic error. |
| TEID-43-T7 | Adversarial | 2 | As a Finance-role user, call the admin-only DELETE /users/{id} endpoint directly via API bypassing the UI and confirm the role check still rejects the request with 403. |
| TEID-43-T8 | Adversarial | 1 | Attempt to assign a nonexistent role string such as SuperOwner to a user via a direct API call and confirm the request is rejected with a validation error rather than creating an unrestricted role. |

## Scoping notes for this point in the build sequence

- **There is no console UI anywhere in this repo.** ADR 0001 splits the two
  services purely by API boundary (Go: usage hot path; TypeScript: everything
  else), and nothing under `services/ts-console` renders a screen -- it is a
  Fastify JSON API, full stop. Every "screen"/"UI" reference in AC2 and in
  T1/T2/T5/T6 is therefore tested at the API level, the same substitution
  TEID-41-T2 already made for "every documented API endpoint" and TEID-92
  made for T6's "regional edge nodes." Concretely: T1's "correctly labeled in
  the user management screen" becomes asserting the API's `role` field
  matches AC1's five strings exactly; T6's "clear explanatory access-denied
  message ... rather than a blank page or generic error" becomes asserting
  the 403 body's `error` field names the required role and the caller's
  actual role, not a bare `"forbidden"`. This is not a downgrade of the
  test's intent -- there is no "blank page" to distinguish it from, because
  there is no page.
- **`/plans` doesn't exist.** Pricing/plan configuration is epic TEID-1,
  not started. T2's literal `PATCH /plans` has nothing to call. Substitute:
  this story's own `PATCH /users/:id/role` (Owner-only, genuinely new) is
  the concrete admin-only write action Support must be blocked from, in
  both T2 and T6. T7's endpoint (`DELETE /users/{id}`) is already concrete
  as written and needs no substitution.
- **"Adjustments" (Finance's AC1 capability) and "sandbox" (Developer's AC1
  capability) don't exist as features anywhere in this codebase either** --
  no credit/override adjustments flow, no sandbox environment beyond the
  existing `environment: sandbox|production` field API keys already carry
  (TEID-92). Nothing to gate for either because there is nothing built yet
  to gate. Not invented here; a future story that adds either one gates it
  through the same `requireRole`/`consoleRoute` mechanism this story
  introduces.
- **AC4's SSO is scoped to what AC4 itself says is in scope now**: SAML is
  explicitly "phase 2" in the AC's own parenthetical. The only SSO mechanism
  that exists today is Google sign-in (TEID-91, `POST /auth/login/google`),
  currently always-on with no account-level toggle. This story adds that
  toggle (`tenant_settings.sso_enabled`) and a small pre-auth discovery
  endpoint; it adds no SAML code, stub or otherwise -- a request for one
  finds no registered route (a real, honest 404), which is the correct
  phase-2 boundary rather than a fabricated "not implemented" response.
- **`security.ts`'s `/admin/security-events` and `/admin/session-sweep`
  are out of AC2's scope.** They are gated by a separate internal-ops
  secret (`x-internal-admin-key`), not a tenant console session -- they are
  Teideal's own staff tooling, spanning all tenants, not one of a tenant's
  five built-in roles. The existing code comment ("placeholder for the role
  check TEID-43 will add") is stale and gets a one-line correction; no
  behavior changes there.
- **`customers.ts` and `go-usage`'s `/usage` are out of AC2's scope too.**
  They are reachable only via API key (`requireAuth`, TEID-92's
  ingest-only/read-only/admin scopes) -- there is no console-session path to
  them at all today. AC2's role check applies to the console-session
  surface (`requireSession`); it doesn't retrofit onto a different
  authentication mechanism that already has its own or­thogonal scoping.
- **Not building last-Owner/self-delete protection.** `DELETE /users/:id`
  lets an Owner delete any user in the tenant, including themselves or the
  tenant's only Owner. No AC or test requires guarding against this, and
  it's a real gap worth a future story, not invented here.

## Architecture and design

### Roles already exist; this story adds enforcement and management

`users.role` (TEID-91's migration) already has the exact `CHECK (role IN
('Owner', 'Billing Admin', 'Finance', 'Support', 'Developer'))` constraint
AC1 asks for, and `lib/users.ts`'s `Role` type already matches it. Nothing
in this story touches that column's shape. What's missing is (a) anything
to manage users through (create, list, change role, remove) and (b) any
actual enforcement of the role on the console-session endpoints that exist.

### Migration: `db/migrations/<timestamp>_rbac.sql`

(generate the timestamp with `date -u +%Y%m%d%H%M%S`)

```sql
-- SSO toggle (AC4). Defaults true so TEID-91's existing Google-sign-in
-- regression suite (which predates this toggle and calls
-- POST /auth/login/google unconditionally) keeps passing unchanged.
ALTER TABLE tenant_settings ADD COLUMN sso_enabled BOOLEAN NOT NULL DEFAULT true;

-- teideal_app has SELECT/INSERT/UPDATE on users (TEID-91's migration,
-- line 45) but never DELETE -- this story's DELETE /users/:id is the
-- first thing that needs to remove a row from this table, and without
-- this grant it fails with Postgres permission error 42501, the same
-- class of gap TEID-92's spec caught for api_keys before any code was
-- written. Caught here the same way, before writing the endpoint.
GRANT DELETE ON users TO teideal_app;
```

### Shared role-guard: `services/ts-console/src/lib/roleGuard.ts` (new)

Every route mounted behind `requireSession` must declare its access rule
through one helper, `consoleRoute`, instead of calling
`scoped.get/post/patch/delete` directly. The declaration is a required
parameter, not an optional one -- a route file that omits it fails `tsc`,
which is what makes AC2 a structural property of the codebase rather than
a convention someone can forget (this is also the mechanism T5 tests; see
below).

```ts
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { ROLES, type Role } from "./users.js";

export type ConsoleAuth = { role: Role[] } | { selfService: true };

// Populated as a side effect of every consoleRoute() call below, in
// registration order. This is the manifest TEID-43-T5's regression test
// reads -- not re-derived from source, read directly off what actually
// got registered.
export const CONSOLE_ROUTE_AUDIT: { method: string; url: string; auth: ConsoleAuth }[] = [];

function guard(auth: ConsoleAuth) {
  if ("selfService" in auth) return async () => {};
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const role = req.consolePrincipal!.role;
    if (!auth.role.includes(role)) {
      return reply.code(403).send({
        error: `this action requires role ${auth.role.join(" or ")}; your role is ${role}`,
      });
    }
  };
}

export function consoleRoute(
  scoped: FastifyInstance,
  method: "get" | "post" | "patch" | "delete",
  url: string,
  auth: ConsoleAuth,
  handler: (req: FastifyRequest, reply: FastifyReply) => unknown,
): void {
  CONSOLE_ROUTE_AUDIT.push({ method, url, auth });
  scoped[method](url, { preHandler: guard(auth) }, handler);
}
```

`ROLES` is a new runtime export alongside the existing `Role` type in
`lib/users.ts`: `export const ROLES: readonly Role[] = ["Owner", "Billing
Admin", "Finance", "Support", "Developer"];` -- one canonical list, used
both for "any authenticated role" declarations (`{ role: ROLES }`, spread
to a mutable array where a `Role[]` is expected) and for `POST
/users`/`PATCH /users/:id/role`'s input validation (see below).

`consoleRoute`'s preHandler runs after the scope's own
`requireSession(pool)` hook (Fastify runs plugin-level `addHook`
preHandlers before a route's own `preHandler` option, in registration
order), so `req.consolePrincipal` is always already set by the time
`guard()` reads it -- exactly the existing ordering `tenantSettings.ts`
already relies on, just centralized instead of ad hoc per route.

### Applying `consoleRoute` to every existing console-session route

Every route currently registered inside a `scoped.addHook("preHandler",
requireSession(pool))` block gets rewritten to go through `consoleRoute`
instead of calling `scoped.<method>` directly, with this access table:

| Route | Auth |
|---|---|
| `PATCH /tenant-settings` | `{ role: ["Owner"] }` (replaces the existing inline `if (role !== "Owner")` check -- same behavior, now declared through the shared mechanism) |
| `GET /audit-log` | `{ role: ROLES }` |
| `GET /audit-log/export.csv` | `{ role: ROLES }` |
| `PATCH /audit-log/:id` (405 stub) | `{ role: ROLES }` |
| `DELETE /audit-log/:id` (405 stub) | `{ role: ROLES }` |
| `POST /api-keys` | `{ role: ["Owner", "Developer"] }` |
| `GET /api-keys` | `{ role: ROLES }` |
| `GET /api-keys/:id` | `{ role: ROLES }` |
| `POST /api-keys/:id/rotate` | `{ role: ["Owner", "Developer"] }` |
| `POST /api-keys/:id/revoke` | `{ role: ["Owner", "Developer"] }` |
| `POST /auth/mfa/reset` | `{ selfService: true }` |
| `POST /auth/mfa/reset/confirm` | `{ selfService: true }` |
| `POST /auth/mfa/disable` | `{ selfService: true }` |
| `POST /auth/logout` | `{ selfService: true }` |
| `POST /users` (new) | `{ role: ["Owner"] }` |
| `GET /users` (new) | `{ role: ["Owner"] }` |
| `PATCH /users/:id/role` (new) | `{ role: ["Owner"] }` |
| `DELETE /users/:id` (new) | `{ role: ["Owner"] }` |

`{ role: ROLES }` on the audit-log and api-key read/405 routes isn't a
restriction (nothing in AC1-4 or T1-T8 says Support can't read the audit
log or list API keys) -- it's an explicit declaration so `consoleRoute`'s
audit sees every console-session route accounted for, with no implicit
"nobody checked this one" case. The four `selfService` routes act only on
the caller's own account (reset/disable *your own* MFA, log out *your own*
session) -- no role is more or less entitled to manage their own account,
so they're explicitly exempted rather than silently unguarded.

`api-keys`'s split (`Owner`/`Developer` write, everyone read) is the one
mapping directly stated by AC1: "Developer (API keys and sandbox)" names
API keys as that role's domain. `POST /users`/`PATCH .../role`/`DELETE
/users/:id` are Owner-only, matching T7's own wording ("the admin-only
DELETE /users/{id} endpoint") -- account/role administration is treated as
an Owner-level action throughout, since no AC or test names any other
role as entitled to manage users.

### New file: `services/ts-console/src/routes/users.ts`

Session-authed (`requireSession`), all four routes Owner-only per the table
above.

- **`POST /users`** -- body `{email, password, role}`. Validate
  `role` against `ROLES` in app code (mirrors `apiKeys.ts`'s
  `SCOPES.has(body.scope)` pattern) and reply `400` before touching the
  database if it's not one of the five -- this is what makes T8 a clean
  validation error rather than a Postgres `23514` check-violation surfacing
  as a raw 500 (the CHECK constraint stays as defense-in-depth, not the
  primary validation path). `email`/`password` follow the same "non-empty
  string" validation every other route in this codebase uses (e.g.
  `customers.ts`'s `name`/`email`) -- no new password-complexity policy is
  introduced; none exists anywhere else in this codebase today either.
  Hash with `hashPassword` (`lib/passwords.ts`, already implemented,
  unused until now). Insert with `tenant_id` from
  `req.consolePrincipal.tenantId`. A duplicate `(tenant_id, email)` hits
  the existing `UNIQUE` constraint (Postgres `23505`); catch it and reply
  `409` rather than letting it surface as a raw 500. On success, `201` with
  `{id, email, role, created_at}` -- never `password_hash`. Call
  `recordConfigChangeWithClient` (`objectType: "User"`, `objectId: <new
  id>`, `before: null`, `after: {email, role}`).
- **`GET /users`** -- `WHERE tenant_id = $1`, ordered by `created_at`.
  `{data: [{id, email, role, mfa_enrolled: boolean, created_at}]}` (`
  mfa_enrolled` is `mfa_enrolled_at IS NOT NULL`) -- never `password_hash`,
  `mfa_secret`, or `pending_mfa_secret`.
- **`PATCH /users/:id/role`** -- body `{role}`, validated against `ROLES`
  the same way as create (`400` if not one of the five -- T8 covers this
  path too, not just create). `WHERE id = $1 AND tenant_id = $2`; no
  matching row is `403` (matches `customers.ts`'s and `apiKeys.ts`'s
  rotate/revoke convention for "a write against a row the caller can't
  act on"). Reads the current role first (`FOR UPDATE`), updates, then one
  `recordConfigChangeWithClient` call (`objectType: "User"`, `objectId:
  id`, `before: {role: oldRole}`, `after: {role: newRole}`) -- this is
  what T3 asserts against.
- **`DELETE /users/:id`** -- `WHERE id = $1 AND tenant_id = $2`; no match
  is `403`. Reads the row first, deletes it, then one
  `recordConfigChangeWithClient` call (`objectType: "User"`, `objectId:
  id`, `before: {email, role}`, `after: null`). Returns `200 {id, status:
  "deleted"}`.

These four endpoints are new API surface reachable by a
tenant-authenticated session, so per `docs/parallel-work.md`'s
"Shared resources" rule (the same one TEID-92's spec called out for
`/api-keys*`), add cross-tenant regression cases for all four to
`tests/cross-tenant` (acct_1001 attempting to list/create/change-role/
delete against acct_1002's users), not only to this story's own suite.

### SSO toggle (AC4, T4)

- **`lib/tenants.ts`**: `TenantSettings` gains `ssoEnabled: boolean`;
  `getTenantSettings` selects `sso_enabled` and defaults it to `true` in
  the no-row fail-safe path (matching the migration's default, so a
  missing settings row behaves identically to one that has never been
  touched).
- **`routes/tenantSettings.ts`**: `PATCH /tenant-settings` (now via
  `consoleRoute(..., { role: ["Owner"] }, ...)`) accepts an optional
  `sso_enabled: boolean` alongside the existing two fields, validated the
  same way, included in the `before`/`after` audit payload and in the
  response row.
- **`routes/auth.ts`**: new **`GET /auth/sso-status?tenant_key=...`** --
  public, pre-session, same category as `POST /auth/login` (resolves the
  tenant by key before any user/session exists -- this is the "login
  screen" discovery step AC4/T4 describe, in API terms). Resolves the
  tenant via the existing `resolveTenantByKey`; unknown key is `404`.
  Response: `{tenant_key, sso_enabled}` -- deliberately no SAML field of
  any kind; there is nothing to report because nothing SAML-shaped is
  built (the phase-2 boundary from the scoping notes, made concrete).
- **`POST /auth/login/google`**: after resolving `tenantId`, fetch
  `getTenantSettings` and check `ssoEnabled` before calling
  `verifyGoogleIdToken` (fail fast, no wasted round-trip to the IdP if
  SSO is off for this tenant). If `false`, `403 {error: "single sign-on is
  disabled for this account"}`.

### Route-guard completeness check (T5)

The primary enforcement is `consoleRoute`'s required `auth` parameter
(above) -- a route file that skips it is a `tsc` compile failure, which
*is* "the build ... pipeline fails" T5 asks for, not something a runtime
test can independently trigger (TypeScript's type error happens at compile
time, before any test process starts). What a runtime test *can* and must
still check is the one thing the type system alone doesn't catch: a route
declared with `{ role: [] }` -- syntactically valid, semantically wrong
(silently unreachable by anyone). `CONSOLE_ROUTE_AUDIT` (exported from
`roleGuard.ts`, populated by every `consoleRoute` call as the app module
loads) is asserted, in a real test, to be non-empty and to have every
entry be either `{selfService: true}` or a `role` array with at least one
entry. State plainly in the test file's own comment (mirroring TEID-92's
T6 scoping-note style) that this is the runtime half of a two-part
guarantee, and that the compile-time half is what `tsc --noEmit` (already
in this story's Definition of Done, as it is every story's) is actually
proving.

## Implementation guidance per test

### TEID-43-T1
As the seeded Owner (`owner@acmeco.com`, acct_1001), call `POST /users`
five times, one per role in `ROLES` (including a second `"Owner"` --
nothing forbids more than one Owner per tenant). Assert each `201` with
`role` echoing exactly what was sent. `GET /users` and assert all five
new users appear with the same `role` values -- this is "correctly
labeled in the user management screen," tested as the API response shape
per the scoping notes above.

### TEID-43-T2
Create a Support-role user via `POST /users`, log them in via `POST
/auth/login` (their own set password), then call `PATCH
/users/:id/role` (any other user's id) with that session's token. Assert
`403` with an `error` message naming `Owner` as the required role, per
the scoping note substituting this endpoint for the nonexistent
`PATCH /plans`.

### TEID-43-T3
As Owner, create a Developer-role user, then `PATCH /users/:id/role`
`{role: "Finance"}`. Query `audit_log` (or `GET /audit-log?object_type=
User`) filtered to that user id and confirm one row with `object_type =
'User'`, `before = {"role":"Developer"}`, `after = {"role":"Finance"}`,
`actor_user_id` = the acting Owner's id, and a populated `occurred_at`.

### TEID-43-T4
Using a tenant whose `sso_enabled` starts at its default (`true`): as
Owner, `PATCH /tenant-settings {sso_enabled: false}`, then confirm `GET
/auth/sso-status?tenant_key=acct_1001` returns `sso_enabled: false` and
that `POST /auth/login/google` for that tenant now `403`s. Then `PATCH
/tenant-settings {sso_enabled: true}` and confirm both flip back (status
shows `true`, Google login succeeds again against the fake IdP, matching
TEID-91's existing test double). Separately, confirm the SSO-status
response never contains any SAML-related field, and that a plausible SAML
login path (e.g. `POST /auth/login/saml`) is a plain `404` -- not a
stubbed "coming soon" response -- proving AC4's phase-2 boundary is a real
absence, not a fabricated one.

### TEID-43-T5
Import `CONSOLE_ROUTE_AUDIT` from the built `roleGuard.ts` after
`buildServer()` has run (so every route file's module-level
`consoleRoute` calls have executed). Assert the array is non-empty and
that every entry satisfies: `"selfService" in auth` is `true`, OR
`auth.role` is an array with `length >= 1`. Add a comment in the test
file stating explicitly that this covers the "declared but empty" case,
while the "declaration missing entirely" case is enforced by `tsc`
failing to compile a `consoleRoute` call with a missing required
argument -- both halves are needed for T5's guarantee, only one is
runtime-testable.

### TEID-43-T6
As a Support-role user (seeded fixture, no need to create a new one),
call `POST /api-keys` (Owner/Developer-only). Assert `403` and that the
body's `error` field is a specific, human-readable sentence -- assert it
matches `/requires role/i` and contains both `"Developer"` and
`"Support"` -- not merely that the field exists, per the scoping note's
"not a blank page or generic error" substitution.

### TEID-43-T7
As the seeded Finance-role user, call `DELETE /users/:id` (any valid
user id in the tenant) directly. Assert `403`. Confirm via `GET /users`
(as Owner, in the same test) that the target user still exists --
proving the request was actually rejected, not silently accepted and
then something else failed.

### TEID-43-T8
As Owner, `POST /users` with `{email, password, role: "SuperOwner"}`.
Assert `400` (not `201`, not `500`) with a validation-error message
naming the five valid roles. Confirm via `GET /users` that no row with
that email was created. Repeat the same assertion against `PATCH
/users/:id/role {role: "SuperOwner"}` on an existing user -- both are
new endpoints this story adds, and both must reject the same invalid
input the same way.

## File layout

- `db/migrations/<timestamp>_rbac.sql` -- `sso_enabled` column,
  `GRANT DELETE ON users`.
- `db/seed-console-auth-fixtures.sh` -- add a fifth fixture user,
  `developer@acmeco.com` (Developer role, no MFA required, matching
  Finance/Support's existing no-MFA pattern), so `tests/rbac` and future
  suites have a ready-made Developer-role session without creating one
  per test.
- `services/ts-console/src/lib/users.ts` -- add the `ROLES` runtime array.
- `services/ts-console/src/lib/tenants.ts` -- `ssoEnabled` on
  `TenantSettings`; `getTenantSettings` selects and defaults it.
- `services/ts-console/src/lib/roleGuard.ts` -- new: `ConsoleAuth`,
  `CONSOLE_ROUTE_AUDIT`, `consoleRoute`.
- `services/ts-console/src/routes/users.ts` -- new: the four `/users*`
  endpoints.
- `services/ts-console/src/routes/tenantSettings.ts` -- refactor to
  `consoleRoute`; add `sso_enabled` to body/response.
- `services/ts-console/src/routes/auditLog.ts` -- refactor all four
  routes to `consoleRoute`.
- `services/ts-console/src/routes/apiKeys.ts` -- refactor all five
  routes to `consoleRoute` with the Owner/Developer split above.
- `services/ts-console/src/routes/auth.ts` -- refactor the four
  session-authed routes to `consoleRoute({selfService: true})`; add
  `GET /auth/sso-status`; add the `ssoEnabled` check to
  `POST /auth/login/google`.
- `services/ts-console/src/routes/security.ts` -- one-line comment
  correction (no behavior change); see scoping notes.
- Tests: new directory `tests/rbac/` (mirror `tests/api-keys/`'s shape:
  own `package.json`, `tsconfig.json`, `vitest.config.ts`), covering
  T1-T8 against `TS_CONSOLE_URL`.
- `tests/cross-tenant` -- add cross-tenant cases for the four new
  `/users*` endpoints (acct_1001 against acct_1002's users), per the
  "Shared resources" rule in `docs/parallel-work.md`.
- CI: add a step to `.github/workflows/ci.yml`'s `test` job running
  `tests/rbac`, after the existing `tests/api-keys` step (installs +
  `npx vitest run`, same pattern as every prior story's step).

## Definition of done

- [ ] All 4 acceptance criteria satisfied by working code (AC1's five
      roles already existed; AC2 is now enforced through `consoleRoute`
      on every console-session route with no exceptions; AC3 audit-logs
      role changes; AC4's Google-based SSO is toggleable, SAML remains a
      genuine 404).
- [ ] All 8 cataloged tests have real automated tests that pass,
      including T5's two-part (compile-time + runtime) guarantee.
- [ ] Cross-tenant isolation is proven for all four new `/users*`
      endpoints in `tests/cross-tenant`: list/create are scoped by
      `tenant_id` in their `WHERE`/`INSERT`; role-change/delete against
      another tenant's user id are `403`.
- [ ] `tsc --noEmit` clean in `services/ts-console` -- in particular, every
      `scoped.get/post/patch/delete` call under a `requireSession`-gated
      scope has been replaced by `consoleRoute` (a stray direct call is
      exactly the "unguarded screen" T5 exists to catch, and would still
      compile if left as a plain Fastify call rather than converted --
      review the diff for any route file that didn't switch over).
- [ ] `tests/cross-tenant`, `tests/console-auth`, `tests/audit-log`,
      `tests/api-keys` all still pass unchanged (the `consoleRoute`
      refactor is behavior-preserving for every existing route; the
      `sso_enabled` default of `true` keeps TEID-91's Google-login tests
      passing without modification).
- [ ] Full suite passes against a database rebuilt from scratch via
      `db/setup-local.sh` plus all existing seed scripts, including the
      updated `db/seed-console-auth-fixtures.sh`.
- [ ] PR description maps each test ID to its file/line.
