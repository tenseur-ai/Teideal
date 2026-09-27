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
  ADD COLUMN before JSONB,
  ADD COLUMN after JSONB;

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

### `recordConfigChange` helper

Add to `services/ts-console/src/lib/audit.ts`, alongside the existing
`writeAuditEvent`/`writeAuditEventWithClient`:

```ts
export interface ConfigChange {
  objectType: string;
  objectId: string;
  customerId?: string | null;
  before: unknown;
  after: unknown;
}

export async function recordConfigChange(
  pool: Pool, tenantId: string, actorUserId: string, change: ConfigChange,
): Promise<void> { ... }

export async function recordConfigChangeWithClient(
  client: PoolClient, tenantId: string, actorUserId: string, change: ConfigChange,
): Promise<void> { ... }
```

Both insert one row into `audit_log` with `event_type` set to
`"config_change"` (a fixed marker distinguishing these from TEID-91's
auth event types) and `object_type`/`object_id`/`before`/`after`/
`customer_id` populated from `change`. Follow the exact same
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
  /tenant-settings`: capture the row's `require_mfa_all_roles`/
  `idle_timeout_minutes` *before* the `UPDATE`, then after it succeeds
  call `recordConfigChangeWithClient` with `objectType: "TenantSettings"`,
  `objectId: tenantId`, `before`/`after` as `{require_mfa_all_roles,
  idle_timeout_minutes}` objects (only the fields that were actually
  provided in the request need to differ between before/after, but
  capturing the full settings object for both is simplest and fine).
- `services/ts-console/src/routes/customers.ts`'s `PATCH
  /customers/:id`: capture the row before the `UPDATE` (you already fetch
  it implicitly via the `RETURNING *` -- fetch the prior state with a
  `SELECT` first, or restructure to capture both), then call
  `recordConfigChangeWithClient` with `objectType: "Customer"`,
  `objectId: id`, `customerId: id`, `before`/`after` as `{name, email}`
  objects. This is additive -- do not change the existing 403 behavior
  for cross-tenant/nonexistent customers (TEID-41-T8 must keep passing
  unchanged; a blocked PATCH never reaches this new audit call).

### API: the audit log surface

New file `services/ts-console/src/routes/auditLog.ts`, registered in
`server.ts` under the same admin-key gate as `registerSecurityRoutes`
(`X-Internal-Admin-Key`, TEID-41's pattern -- a placeholder for TEID-43's
RBAC, same as everywhere else this gate is used):

- `GET /admin/audit-log` -- query params `actor_user_id`, `customer_id`,
  `object_type`, `from` (ISO date), `to` (ISO date), all optional and
  AND-combined. Returns `{data: [...]}`, newest first, capped at 500 rows
  (this endpoint is for spot-checking; CSV export below is for bulk).
  Validate `from`/`to` as parseable dates before querying; reject
  malformed values with 400 rather than passing them into SQL
  unparsed (parameterize regardless).
- `GET /admin/audit-log/export.csv` -- same filters, but streams every
  matching row as CSV (do not buffer 1.2M rows in memory -- use Fastify's
  streaming response with a cursor-based or chunked query, e.g. `pg`'s
  cursor support or `LIMIT`/`OFFSET` paging in batches of a few thousand
  rows written to the response as they're fetched). Columns: `id`,
  `occurred_at`, `actor_user_id`, `customer_id`, `object_type`,
  `object_id`, `event_type`, `before`, `after` (JSONB columns serialized
  as JSON text within their CSV cell). Set
  `Content-Type: text/csv` and `Content-Disposition:
  attachment; filename="audit-log.csv"`.
- `PATCH /admin/audit-log/:id` and `DELETE /admin/audit-log/:id` --
  registered explicitly, always return `405` with a body explaining the
  log is append-only. This is a deliberate statement of immutability, not
  an accidental 404 from a route that was never defined.

### Why the DB-level guarantee already covers T6

TEID-91's migration already does
`REVOKE UPDATE, DELETE ON audit_log FROM teideal_app`. T6 is provable by
connecting as `teideal_app` directly (same pattern as
`tests/cross-tenant/rls-audit.test.ts` connecting via `pg` for schema
introspection) and asserting an `UPDATE`/`DELETE` against `audit_log`
fails with a Postgres permission error (SQLSTATE `42501`) -- no new
application code needed for T6 itself, only the test.

## Implementation guidance per test

### TEID-42-T1
`PATCH /tenant-settings` twice as Owner (first to a known starting
`idle_timeout_minutes`, then to a different value), then query
`audit_log` directly (or via `GET /admin/audit-log`) filtered to that
tenant and `object_type = 'TenantSettings'`. Assert one row exists with
`actor_user_id` = the Owner's id, `before`/`after` reflecting the two
values, and `occurred_at` recent.

### TEID-42-T2
`PATCH /admin/audit-log/<any-id>` and `DELETE /admin/audit-log/<any-id>`
(admin key auth) both return 405. Re-fetch the row via
`GET /admin/audit-log` and confirm it's byte-for-byte unchanged.

### TEID-42-T3
Seed a handful of audit rows across two different `actor_user_id`s,
two different `object_type`s, and a spread of `occurred_at` values (a
direct DB insert for fixture setup is fine here, same as
`tests/console-auth`'s fixture patterns). Call
`GET /admin/audit-log/export.csv` with `actor_user_id`, `object_type`,
`from`, `to` all set, parse the returned CSV, and assert every row
matches all four filters and the header row has the expected columns.

### TEID-42-T4
Bulk-insert ~1.2M synthetic `audit_log` rows in one statement (a `SELECT
... FROM generate_series(...)` insert, same technique as
`tests/console-auth/session-sweep.test.ts`), spread across a 2-year
`occurred_at` range, most tied to one `customer_id`. Time
`GET /admin/audit-log/export.csv?customer_id=...` end-to-end and assert
it completes in under 60 seconds. Clean the synthetic rows up after
(`DELETE FROM audit_log WHERE ...` scoped to a marker you control, e.g. a
distinctive `object_type` value used only by this test).

### TEID-42-T5
Create 10,000 disposable customers, then `PATCH /customers/:id` each
once (batched with reasonable concurrency, not necessarily all 10,000
literally simultaneously -- e.g. batches of 50-100 concurrent requests).
Afterward, `SELECT count(*) FROM audit_log WHERE object_type = 'Customer'
AND object_id = ANY($1)` for the 10,000 customer ids and assert the count
is exactly 10,000.

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
- `services/ts-console/src/routes/auditLog.ts` -- new.
- `services/ts-console/src/routes/tenantSettings.ts`,
  `services/ts-console/src/routes/customers.ts` -- add the
  `recordConfigChange*` call after each successful mutation.
- `services/ts-console/src/server.ts` -- register `auditLog.ts`'s routes.
- Tests: new directory `tests/audit-log/` (own `package.json`,
  `tsconfig.json`, `vitest.config.ts`, fixtures -- mirror
  `tests/console-auth/`'s shape rather than growing
  `tests/cross-tenant/` or `tests/console-auth/` further).
- CI: add a step to `.github/workflows/ci.yml`'s `test` job running this
  new suite, same pattern as the existing two.

## Definition of done

- [ ] All 3 acceptance criteria satisfied by working code (AC1 as scoped
      above).
- [ ] All 7 cataloged tests have real automated tests that pass.
- [ ] `tsc --noEmit` clean in `services/ts-console`.
- [ ] Full suite (this story's + TEID-41's + TEID-91's) passes against a
      database rebuilt from scratch via `db/setup-local.sh` plus the
      existing seed scripts.
- [ ] PR description maps each test ID to its test file/line.
