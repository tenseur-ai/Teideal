# TEID-42: Audit log of all configuration changes

| | |
|---|---|
| Epic | TEID-5 (E05 -- Establish tenant isolation, access control, and data ownership) |
| Phase | E05 |
| Priority | Highest |
| Points | 5 |
| Release | mvp |
| Order | 3 (within E05) |
| Depends on | TEID-91's `audit_log` table (`db/migrations/20260926180000_auth.sql`), `writeAuditEvent`/`writeAuditEventWithClient` (`services/ts-console/src/lib/audit.ts`), `PATCH /tenant-settings` (`services/ts-console/src/routes/tenantSettings.ts`), `PATCH /customers/:id` (`services/ts-console/src/routes/customers.ts`) |
| Revision | v2 -- see "Revision note" below. Supersedes the admin-key audit surface and the mandatory-`actorUserId` helper signature from v1. |

## Revision note

A first implementation attempt correctly stopped and flagged two gaps
instead of improvising around them. Both were real spec mistakes, not
ambiguity the developer should have resolved. Fixed here:

1. **The audit surface had no tenant context.** v1 copied the
   `X-Internal-Admin-Key` pattern from TEID-41's
   `/admin/security-events`, but that pattern only works there because
   `security_events` has no RLS -- it's a deliberate, documented
   exception (cross-tenant security telemetry). `audit_log` has `FORCE`
   RLS keyed on `app.tenant_id`, and `teideal_app` doesn't bypass it,
   so an admin-key-only request had no way to satisfy the policy. The
   actual mistake was misreading who this feature is for: re-reading the
   story ("As a finance lead, I want...") -- a finance lead is the
   *tenant's own* staff, not Teideal's internal ops team. This is a
   tenant-facing feature and belongs behind `requireSession` +
   `withTenant`, exactly like `PATCH /tenant-settings` already is, not
   behind the internal admin key. Fixed below: the endpoints move from
   `/admin/audit-log*` to `/audit-log*`, session-authed, scoped to the
   caller's own tenant automatically (no tenant selector needed or
   wanted).
2. **`recordConfigChange` assumed every actor is a human user.**
   `PATCH /customers/:id` authenticates via API key (tenant-level
   programmatic access, TEID-41), which has no user concept at all.
   Fixed below: `audit_log` gets a second, equally-nullable attribution
   column (`actor_api_key_id`), and `recordConfigChange` takes a
   discriminated `actor` describing which kind of credential acted.

## Story (verbatim from the live board)

> As a finance lead, I want a permanent record of who changed what and when, so that every pricing or balance decision can be explained to auditors.
>
> *Context*

## Acceptance criteria (verbatim from the live board)

1. Every change to plans, grants, commits, overrides, caps, users and integrations is logged with who, when, what, before and after.
2. Audit log entries cannot be edited or deleted.
3. The audit log can be filtered by person, customer, object and date, and exported as CSV.

## Cataloged tests (verbatim from the live board)

| ID | Type | AC | Title |
|---|---|---|---|
| TEID-42-T1 | Functional | 1 | Change the monthly cap on customer acct_2002 from $5,000 to $7,500 and confirm an audit entry is created showing the acting user, timestamp, object type Cap, before value 5000 and after value 7500. |
| TEID-42-T2 | Functional | 2 | Attempt a direct DELETE and a direct PATCH against an existing audit log entry ID via the API using an Owner-level key and confirm both are rejected with 403 or 405 and the entry remains unchanged. |
| TEID-42-T3 | Functional | 3 | Filter the audit log by person jane@acmeco.com, object type Plan and a 30-day date range, then export the filtered results as CSV and confirm the file contains only matching rows with correct column headers. |
| TEID-42-T4 | Non-functional | 3 | Filter and export the audit log for a single customer over a 2-year range containing 1.2 million entries and confirm the CSV export completes within 60 seconds. |
| TEID-42-T5 | Non-functional | 1 | Generate 10,000 configuration changes in a load test and confirm exactly 10,000 corresponding audit entries are produced with no drops or duplicates. |
| TEID-42-T6 | Adversarial | 2 | Attempt to truncate or overwrite audit log rows via a database-level connection using a compromised service-role credential and confirm append-only or immutability controls prevent silent deletion or tampering. |
| TEID-42-T7 | Adversarial | 1 | Submit two simultaneous conflicting updates to the same grant record from two different admin sessions and confirm both changes are captured as separate, correctly ordered audit entries rather than one overwriting the other's log record. |

## Scoping notes for this point in the build sequence

AC1 names object types (plans, grants, commits, overrides, caps,
integrations) that belong to epics not yet built (E01 entitlement model,
order 29+; E04 Stripe connector, order 36+). This story's job is to build
the audit **mechanism** -- generic, reusable, and already comprehensive
in the columns it captures -- not to retrofit those future features.
Each of those stories will call the same `recordConfigChange` helper
this spec introduces when it's built; AC1's literal coverage completes
incrementally, automatically, without touching this story again.

For the tests that name a specific not-yet-built object type, substitute
the closest real analog that already exists and is genuinely
config-like, and say so honestly in the audit entry (never label a
`TenantSettings` change as `Cap` to make a test look like it's testing
something it isn't):

- **TEID-42-T1** ("Cap", $5,000 -> $7,500): use `tenant_settings.idle_timeout_minutes`
  (an existing numeric, Owner-configurable setting via `PATCH
  /tenant-settings`, TEID-91) as the changed object. `object_type` in the
  audit entry is `"TenantSettings"`, not `"Cap"`. The test asserts the
  mechanism T1 is really checking -- before/after values, acting user,
  timestamp -- against this real object.
- **TEID-42-T3** ("object type Plan"): filter by whatever object types
  actually exist after this story (`"TenantSettings"`, `"Customer"`) --
  assert the *filter mechanism* works correctly (only matching rows come
  back), not that a literal `"Plan"` type exists yet.
- **TEID-42-T5** (10,000 load-tested changes): use `PATCH
  /customers/:id` (TEID-41) as the vehicle -- create 10,000 distinct
  customers and PATCH each once. This avoids single-row lock contention
  that hammering one `tenant_settings` row 10,000 times would cause, and
  is why `PATCH /customers/:id` needs to start calling
  `recordConfigChange` too (see below) even though "customers" isn't
  literally named in AC1 -- it's a legitimate configuration-ish object
  and the natural high-cardinality target for this load test.
- **TEID-42-T7** ("the same grant record", "two different admin
  sessions"): use `tenant_settings` again (single row, session-authed,
  matches "admin sessions") -- two concurrent `PATCH /tenant-settings`
  calls racing on the same tenant's row.

## Architecture and design

### Schema: extend `audit_log`, don't replace it

New migration `db/migrations/<timestamp>_audit_log_extend.sql` (generate
the timestamp with `date -u +%Y%m%d%H%M%S`; do not edit the TEID-91
migration):

```sql
ALTER TABLE audit_log
  ADD COLUMN object_type TEXT,
  ADD COLUMN object_id TEXT,
  ADD COLUMN customer_id UUID REFERENCES customers(id),
  ADD COLUMN actor_api_key_id UUID REFERENCES api_keys(id),
  ADD COLUMN before JSONB,
  ADD COLUMN after JSONB,
  ADD CONSTRAINT audit_log_actor_check CHECK (
    (actor_user_id IS NOT NULL)::int + (actor_api_key_id IS NOT NULL)::int <= 1
  );

CREATE INDEX audit_log_object_idx ON audit_log (tenant_id, object_type, object_id);
CREATE INDEX audit_log_customer_idx ON audit_log (tenant_id, customer_id) WHERE customer_id IS NOT NULL;
```

Existing columns (`id`, `tenant_id`, `occurred_at`, `actor_user_id`,
`event_type`, `detail`) are unchanged and keep working for TEID-91's auth
events (which have no `object_type`/`before`/`after` -- those stay
`NULL` for auth events, that's expected). RLS, `FORCE`, the tenant
isolation policy, and the `REVOKE UPDATE, DELETE` from TEID-91's
migration already cover the table as extended -- no policy changes
needed, adding columns doesn't touch them.

`actor_user_id` and `actor_api_key_id` are both nullable, and the check
constraint above ensures at most one is set per row (never both; system-
initiated rows may eventually have neither, though nothing in this story
produces one). This is the "who" in AC1: a human session or an API key,
recorded honestly as whichever kind actually acted, never invented or
attributed to the wrong kind. `api_keys` has no RLS (TEID-41 -- it's a
pre-auth resolution table), so referencing it from `audit_log` doesn't
create a new cross-tenant leak: `actor_api_key_id` is only ever a foreign
key value written by trusted server code, never something a filter query
joins out to reveal another tenant's key material.

### `recordConfigChange` helper

Add to `services/ts-console/src/lib/audit.ts`, alongside the existing
`writeAuditEvent`/`writeAuditEventWithClient`:

```ts
export type ConfigChangeActor = { userId: string } | { apiKeyId: string };

export interface ConfigChange {
  objectType: string;
  objectId: string;
  customerId?: string | null;
  before: unknown;
  after: unknown;
}

export async function recordConfigChange(
  pool: Pool, tenantId: string, actor: ConfigChangeActor, change: ConfigChange,
): Promise<void> { ... }

export async function recordConfigChangeWithClient(
  client: PoolClient, tenantId: string, actor: ConfigChangeActor, change: ConfigChange,
): Promise<void> { ... }
```

Both insert one row into `audit_log` with `event_type` set to
`"config_change"` (a fixed marker distinguishing these from TEID-91's
auth event types), `actor_user_id`/`actor_api_key_id` set from whichever
variant of `actor` was passed (the other left `NULL`), and
`object_type`/`object_id`/`before`/`after`/`customer_id` populated from
`change`. Follow the exact same
pool-vs-client split `sessions.ts`/`pendingLogins.ts` already establish
(see `services/ts-console/src/lib/sessions.ts`'s `Queryable` comment) --
callers already holding an open client (e.g. inside
`PATCH /tenant-settings`'s `withTenant` block) must use the
`WithClient` variant, never acquire a second pool connection while the
first is open. Getting this wrong caused a real production-shaped
deadlock in TEID-91 (see `services/ts-console/src/lib/loginFlow.ts`'s
comment) -- don't reintroduce it here.

### Wire it into existing mutating endpoints

- `services/ts-console/src/routes/tenantSettings.ts`'s `PATCH
  /tenant-settings` (session-authed, `req.consolePrincipal.userId`
  available): capture the row's `require_mfa_all_roles`/
  `idle_timeout_minutes` *before* the `UPDATE`, then after it succeeds
  call `recordConfigChangeWithClient` with `actor: {userId:
  req.consolePrincipal.userId}`, `objectType: "TenantSettings"`,
  `objectId: tenantId`, `before`/`after` as `{require_mfa_all_roles,
  idle_timeout_minutes}` objects (only the fields that were actually
  provided in the request need to differ between before/after, but
  capturing the full settings object for both is simplest and fine).
- `services/ts-console/src/routes/customers.ts`'s `PATCH
  /customers/:id` (API-key-authed, no user -- see below): capture the row
  before the `UPDATE` (you already fetch it implicitly via the
  `RETURNING *` -- fetch the prior state with a `SELECT` first, or
  restructure to capture both), then call `recordConfigChangeWithClient`
  with `actor: {apiKeyId: req.principal.apiKeyId}`, `objectType:
  "Customer"`, `objectId: id`, `customerId: id`, `before`/`after` as
  `{name, email}` objects. This is additive -- do not change the
  existing 403 behavior for cross-tenant/nonexistent customers
  (TEID-41-T8 must keep passing unchanged; a blocked PATCH never reaches
  this new audit call).

### `services/ts-console/src/lib/auth.ts` needs the API key's own id

`Principal` currently carries only `{tenantId, tenantKey}` -- there's no
way to know *which* key made a request, only which tenant it belongs to.
Add `apiKeyId: string`, populated from the same lookup that already
resolves the tenant:

```ts
export interface Principal {
  tenantId: string;
  tenantKey: string;
  apiKeyId: string;
}
```

```ts
const { rows } = await pool.query<{ id: string; external_key: string; api_key_id: string }>(
  `SELECT t.id, t.external_key, k.id AS api_key_id
   FROM api_keys k
   JOIN tenants t ON t.id = k.issued_to_tenant_id
   WHERE k.key_hash = $1`,
  [hashKey(plaintextKey)],
);
...
return { tenantId: rows[0].id, tenantKey: rows[0].external_key, apiKeyId: rows[0].api_key_id };
```

This is additive to `Principal`'s shape -- existing callers that only
read `tenantId`/`tenantKey` (TEID-41's customers/usage routes) are
unaffected.

### API: the audit log surface is tenant-facing, not internal-admin

New file `services/ts-console/src/routes/auditLog.ts`, registered in
`server.ts` under `requireSession` (TEID-91's pattern -- same as
`registerTenantSettingsRoutes`), **not** the `X-Internal-Admin-Key` gate.
This is a finance lead viewing their own company's audit trail, not
Teideal ops viewing across tenants -- see the revision note above. Every
query runs inside `withTenant(pool, req.consolePrincipal.tenantId, ...)`,
scoping to the caller's own tenant automatically; there is no tenant
selector in the request because there's nothing to select, exactly like
`GET /customers`. No role check yet (any authenticated session for the
tenant can read its own audit log) -- TEID-43 (RBAC) will narrow this to
specific roles when it exists; don't invent a role check now.

- `GET /audit-log` -- query params `actor_user_id`, `customer_id`,
  `object_type`, `from` (ISO date), `to` (ISO date), all optional and
  AND-combined. Returns `{data: [...]}`, newest first, capped at 500 rows
  (this endpoint is for spot-checking; CSV export below is for bulk).
  Validate `from`/`to` as parseable dates before querying; reject
  malformed values with 400 rather than passing them into SQL
  unparsed (parameterize regardless).
- `GET /audit-log/export.csv` -- same filters, but streams every
  matching row as CSV (do not buffer 1.2M rows in memory -- use Fastify's
  streaming response with a cursor-based or chunked query, e.g. `pg`'s
  cursor support or `LIMIT`/`OFFSET` paging in batches of a few thousand
  rows written to the response as they're fetched, each batch's query
  still running inside the same tenant-scoped transaction). Columns:
  `id`, `occurred_at`, `actor_user_id`, `actor_api_key_id`,
  `customer_id`, `object_type`, `object_id`, `event_type`, `before`,
  `after` (JSONB columns serialized as JSON text within their CSV cell).
  Set `Content-Type: text/csv` and `Content-Disposition:
  attachment; filename="audit-log.csv"`.
- `PATCH /audit-log/:id` and `DELETE /audit-log/:id` -- registered
  explicitly (still `requireSession`), always return `405` with a body
  explaining the log is append-only. This is a deliberate statement of
  immutability, not an accidental 404 from a route that was never
  defined. RLS means a session could only ever reach its own tenant's
  row anyway -- the 405 is what proves immutability specifically, not
  cross-tenant isolation (that's TEID-41's job, already covered).

### Why the DB-level guarantee already covers T6

TEID-91's migration already does
`REVOKE UPDATE, DELETE ON audit_log FROM teideal_app`. T6 is provable by
connecting as `teideal_app` directly (same pattern as
`tests/cross-tenant/rls-audit.test.ts` connecting via `pg` for schema
introspection) and asserting an `UPDATE`/`DELETE` against `audit_log`
fails with a Postgres permission error (SQLSTATE `42501`) -- no new
application code needed for T6 itself, only the test.

### T4's fixture data needs a connection T6 deliberately doesn't have

T4 needs to insert ~1.2M rows (fine -- `INSERT` is still granted to
`teideal_app`) and then delete them afterward to avoid leaving 1.2M rows
behind for every other test and every future run. But T6 just proved
`teideal_app` cannot `DELETE` from `audit_log` -- by design. The test
suite's cleanup step needs a different, more privileged connection for
that one operation, the same way `db/setup-local.sh` and
`db/seed-*.sh` already run as the `postgres` superuser rather than
`teideal_app` for exactly the same class of reason (they need
privileges the app role deliberately doesn't have).

Add `SUPERUSER_DATABASE_URL` (default
`postgres://postgres:postgres@127.0.0.1:5432/teideal`, matching the
`postgres`/`postgres` credentials CI's Postgres service container
already uses) to `tests/audit-log/env.ts`, and a second `pg.Pool`
connected with it, used **only** for this one test's bulk insert and
cleanup -- never for assertions (assertions must go through the normal
`teideal_app` pool, the same one the real API uses, or they're not
actually proving anything about the API's behavior).

**Local dev one-time setup**, needed because local Postgres normally
uses peer auth for the `postgres` role (no password, unix-socket only)
rather than the password-based TCP auth CI's container ships with by
default: `sudo -u postgres psql -c "ALTER USER postgres PASSWORD
'postgres';"`. `db/setup-local.sh`'s existing `PSQL_SUPERUSER`/`CI`
branching is unaffected by this -- it still uses peer auth locally,
unchanged; this password is additionally needed only for this one
test's TCP connection as `postgres`. Document this in
`tests/audit-log`'s own setup notes (a short README or a comment at the
top of `env.ts`) so it isn't a silent prerequisite.

Rolling back an open transaction instead of running a real `DELETE`
was considered and rejected: T4 exercises the CSV export over the real
running `ts-console` service, a separate process/connection that would
never see this test's own uncommitted rows. The data has to actually be
committed for the thing under test to see it, so a real (superuser)
`DELETE` afterward is genuinely necessary, not just convenient.

## Implementation guidance per test

### TEID-42-T1
`PATCH /tenant-settings` twice as Owner (first to a known starting
`idle_timeout_minutes`, then to a different value), then query
`audit_log` directly (or via `GET /audit-log` using that same Owner's
session token) filtered to `object_type = 'TenantSettings'`. Assert one
row exists with `actor_user_id` = the Owner's id (`actor_api_key_id`
NULL), `before`/`after` reflecting the two values, and `occurred_at`
recent.

### TEID-42-T2
`PATCH /audit-log/<any-id>` and `DELETE /audit-log/<any-id>` (a valid
session token, any role) both return 405. Re-fetch the row via
`GET /audit-log` (same session) and confirm it's byte-for-byte
unchanged.

### TEID-42-T3
Seed a handful of audit rows across two different `actor_user_id`s,
two different `object_type`s, and a spread of `occurred_at` values (a
direct DB insert for fixture setup is fine here, same as
`tests/console-auth`'s fixture patterns -- insert via a normal
tenant-scoped `withTenant` call, no elevated privileges needed for
`INSERT`). Using a session token, call `GET
/audit-log/export.csv` with `actor_user_id`, `object_type`, `from`,
`to` all set, parse the returned CSV, and assert every row matches all
four filters and the header row has the expected columns.

### TEID-42-T4
Using the `SUPERUSER_DATABASE_URL` connection described above,
bulk-insert ~1.2M synthetic `audit_log` rows in one statement (a
`SELECT ... FROM generate_series(...)` insert, same technique as
`tests/console-auth/session-sweep.test.ts` -- `INSERT` itself doesn't
strictly need the superuser connection, but using the same connection
for insert and cleanup keeps the fixture's lifecycle in one place),
spread across a 2-year `occurred_at` range, all tied to one
`customer_id`. Using a session token, time `GET
/audit-log/export.csv?customer_id=...` end-to-end and assert it
completes in under 60 seconds. Clean the synthetic rows up afterward via
the superuser connection (`DELETE FROM audit_log WHERE ...` scoped to a
marker you control, e.g. a distinctive `object_type` value used only by
this test) -- in a `finally`/`afterAll`, so a failed assertion still
leaves the table clean for the next run.

### TEID-42-T5
Create 10,000 disposable customers, then `PATCH /customers/:id` each
once via API key (batched with reasonable concurrency, not necessarily
all 10,000 literally simultaneously -- e.g. batches of 50-100 concurrent
requests). Afterward, `SELECT count(*) FROM audit_log WHERE object_type
= 'Customer' AND object_id = ANY($1)` for the 10,000 customer ids and
assert the count is exactly 10,000, with `actor_api_key_id` set (not
`actor_user_id`) on each of those rows.

### TEID-42-T6
Connect directly as `teideal_app` (bypassing the API, same as
`rls-audit.test.ts`) and attempt `UPDATE audit_log SET event_type =
'tampered' WHERE id = <existing id>` and `DELETE FROM audit_log WHERE id
= <existing id>`. Assert both throw a Postgres permission-denied error
and the row is unchanged afterward.

### TEID-42-T7
Fire two concurrent `PATCH /tenant-settings` requests (different
`idle_timeout_minutes` values) using two separately-obtained Owner
sessions, via `Promise.all`. After both resolve, query `audit_log` for
that tenant/object and assert exactly two rows exist (not one
overwritten by the other), with `occurred_at` values that are distinct
and in an order consistent with when each request was actually
processed.

## File layout

- `db/migrations/<timestamp>_audit_log_extend.sql`
- `services/ts-console/src/lib/audit.ts` -- add `recordConfigChange`/
  `recordConfigChangeWithClient` alongside existing exports.
- `services/ts-console/src/lib/auth.ts` -- add `apiKeyId` to `Principal`
  and its resolving query.
- `services/ts-console/src/routes/auditLog.ts` -- new, `requireSession`-gated.
- `services/ts-console/src/routes/tenantSettings.ts`,
  `services/ts-console/src/routes/customers.ts` -- add the
  `recordConfigChange*` call after each successful mutation.
- `services/ts-console/src/server.ts` -- register `auditLog.ts`'s routes
  (inside the `requireSession`-gated group, alongside
  `registerTenantSettingsRoutes`, not alongside
  `registerSecurityRoutes`'s admin-key group).
- Tests: new directory `tests/audit-log/` (own `package.json`,
  `tsconfig.json`, `vitest.config.ts`, fixtures -- mirror
  `tests/console-auth/`'s shape rather than growing
  `tests/cross-tenant/` or `tests/console-auth/` further). Include a
  `SUPERUSER_DATABASE_URL`-documenting note (README or top-of-file
  comment) per the T4 guidance above.
- CI: add a step to `.github/workflows/ci.yml`'s `test` job running this
  new suite, same pattern as the existing two, with
  `SUPERUSER_DATABASE_URL: postgres://postgres:postgres@127.0.0.1:5432/teideal`
  added to the job's `env:` block (the CI Postgres service container
  already uses that username/password, per the existing `PGPASSWORD:
  postgres` in that same `env:` block -- no new CI secret needed).

## Definition of done

- [ ] All 3 acceptance criteria satisfied by working code (AC1 as scoped
      above).
- [ ] All 7 cataloged tests have real automated tests that pass.
- [ ] `tsc --noEmit` clean in `services/ts-console`.
- [ ] Full suite (this story's + TEID-41's + TEID-91's) passes against a
      database rebuilt from scratch via `db/setup-local.sh` plus the
      existing seed scripts.
- [ ] `tests/cross-tenant` and `tests/console-auth` still pass unchanged
      -- the `Principal`/`auth.ts` change is additive only.
- [ ] PR description maps each test ID to its test file/line.
