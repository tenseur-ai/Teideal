# TEID-44: Full data export

| | |
|---|---|
| Epic | TEID-5 (E05 -- Establish tenant isolation, access control, and data ownership) |
| Phase | E05 |
| Priority | High |
| Points | 8 |
| Release | mvp |
| Order | 6 (within E05) |
| Depends on | `customers` (TEID-41), `usage_events` (TEID-41, `db/migrations/20260926120000_init.sql`), `tenant_settings`/`sso_enabled` (TEID-91/TEID-43), `users`/`ROLES` (TEID-91/TEID-43), `api_keys` (TEID-41/TEID-92), `consoleRoute`/`ConsoleAuth` (TEID-43, `services/ts-console/src/lib/roleGuard.ts`), `recordConfigChangeWithClient` (TEID-42) |

## Story (verbatim from the live board)

> As a account owner, I want to export all of my ledger, events and configuration at any time, so that my data is mine and I am never locked in.
>
> *Context*

## Acceptance criteria (verbatim from the live board)

1. An owner can export the full ledger, usage events, grants and configuration in CSV, JSON and Parquet.
2. A full export of all history is ready within 24 hours; smaller date ranges within 1 hour.
3. Scheduled exports can be delivered daily to the customer's own cloud storage.
4. The export format is documented so it can be loaded into another system.

## Cataloged tests (verbatim from the live board)

| ID | Type | AC | Title |
|---|---|---|---|
| TEID-44-T1 | Functional | 1 | Request a full export of ledger, usage events, grants and configuration for tenant acct_3003 in CSV, JSON and Parquet, and confirm each file is generated with matching record counts across all three formats. |
| TEID-44-T2 | Functional | 2 | Request a full-history export for a tenant with 3 years of data and confirm it completes within 24 hours, then request a 7-day export for the same tenant and confirm it completes within 1 hour. |
| TEID-44-T3 | Functional | 3 | Configure a scheduled daily export to the customer's own S3 bucket and confirm a new export file lands in that bucket at the configured time on 3 consecutive days. |
| TEID-44-T4 | Functional | 4 | Download the published export format documentation and confirm it accurately describes every column present in the actual generated ledger CSV, with no undocumented fields. |
| TEID-44-T5 | Non-functional | 2 | Trigger a full export for a tenant with 50 million usage events and confirm the job completes within the 24-hour SLA without timing out or requiring manual intervention. |
| TEID-44-T6 | Non-functional | 3 | Simulate the customer's S3 destination being temporarily unreachable during a scheduled export and confirm the export is retried and an alert is raised rather than being silently dropped. |
| TEID-44-T7 | Adversarial | 1 | Trigger 5 full-history export requests for the same tenant simultaneously and confirm the system either queues them safely or produces 5 consistent, non-corrupted files rather than a race condition corrupting output. |
| TEID-44-T8 | Adversarial | 3 | Configure a scheduled export destination pointing at a cloud storage bucket the requesting account does not own and confirm the system validates ownership before sending data, rejecting the misconfigured destination. |

## Scoping notes for this point in the build sequence

This story touches more genuinely new ground than any prior E05 story --
four separate infrastructure decisions, made and written down here rather
than left for the developer to guess:

- **"Ledger" and "usage events" (AC1) are the same thing right now.** A
  computed ledger/balance is TEID-33 (epic E03, not started -- TEID-30's
  own spec flagged this same gap). `usage_events` (TEID-41) is the only
  table that exists for this data, so "ledger" and "usage events" export
  as one category from that one table. Revisit when TEID-33 lands.
- **"Grants" (AC1) don't exist as a feature at all.** TEID-17 (epic E01,
  just assigned to a third developer agent, not started -- TEID-16 is
  its first story) is what would create a `grants` table. Nothing to
  export until then; the export format documentation (AC4) notes grants
  as "not yet available" rather than silently omitting any mention of
  them. Revisit when TEID-17 lands.
- **`usage_events` is a table `services/go-usage` owns, not
  `services/ts-console`** (this story's own service, per ADR 0001's
  per-table ownership rule) -- and a second developer agent (Gemini) is
  now actively building further E03 stories against `services/go-usage`.
  Normally a cross-service need means going through the owning service's
  API (ADR 0001, consequence 2) or, for an internal call, a new
  gRPC/protobuf contract (ADR 0001, decision 5 -- "expected at TEID-2").
  Neither fits well here: extending `go-usage`'s HTTP surface or adding
  its first `/proto` contract would mean this story's files land inside
  the *other* active developer agent's phase, exactly the file-overlap
  risk the two-agent-two-service split exists to avoid, and gRPC's
  reason for existing (a typed, low-latency binary contract for the
  request-path) doesn't apply to a batch export job with no latency
  requirement at all.

  **Narrow, explicit exception to ADR 0001's per-table ownership rule,
  for this story only:** the export job reads `usage_events` with a
  direct, read-only SQL query from `services/ts-console`, the same way
  every other tenant-scoped table in this codebase is read -- `SET LOCAL
  app.tenant_id` inside a transaction (`withTenant`, already the pattern
  every route in both services uses identically) and let RLS enforce
  isolation exactly as it does for `go-usage`'s own queries against this
  same table. This is safe for the reason ADR 0001 itself gives for the
  shared-role design: "Both connect to the same Postgres instance under
  the same non-owner, non-superuser role (`teideal_app`), so RLS applies
  identically regardless of which language issued the query." `teideal_app`
  already has `SELECT` on `usage_events` (TEID-41's migration) -- no new
  grant is needed. The ownership rule exists to stop *business logic*
  from being duplicated across services (entitlement calculations, event
  validation, anything with behavior that could drift); a raw, read-only
  export of a stable, already-immutable event schema has no business
  logic to duplicate, which is why this exception is narrow rather than
  a general erosion of the boundary -- it does not extend to writing
  `usage_events`, and it does not extend to any other cross-service read
  unless a future spec makes the same argument explicitly.
- **This story introduces two new runtime dependencies** to
  `services/ts-console`: `@aws-sdk/client-s3` and `@aws-sdk/client-sts`
  (AC3's S3 delivery) and `@dsnp/parquetjs` (AC1's Parquet format, the
  maintained fork of the now-abandoned `parquetjs`). Pin current stable
  versions in `package.json` at implementation time. No other AC/test
  scopes a non-S3 destination, so "the customer's own cloud storage"
  (AC3's wording) is scoped to S3 specifically -- the concrete, only
  thing any of T3/T6/T8 actually test.

## Architecture and design

### Schema: two new tables

New migration `db/migrations/<timestamp>_data_export.sql` (generate the
timestamp with `date -u +%Y%m%d%H%M%S`):

```sql
CREATE TABLE IF NOT EXISTS exports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  requested_by_user_id UUID REFERENCES users(id),
  range_start TIMESTAMPTZ,
  range_end TIMESTAMPTZ,
  formats TEXT[] NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  record_counts JSONB,
  file_paths JSONB,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
ALTER TABLE exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE exports FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_exports ON exports;
CREATE POLICY tenant_isolation_exports ON exports
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON exports TO teideal_app;

CREATE TABLE IF NOT EXISTS export_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_by_user_id UUID REFERENCES users(id),
  s3_bucket TEXT NOT NULL,
  s3_prefix TEXT NOT NULL DEFAULT '',
  s3_region TEXT NOT NULL,
  role_arn TEXT NOT NULL,
  formats TEXT[] NOT NULL DEFAULT ARRAY['csv'],
  enabled BOOLEAN NOT NULL DEFAULT true,
  last_run_at TIMESTAMPTZ,
  last_run_status TEXT CHECK (last_run_status IN ('succeeded', 'failed')),
  consecutive_failures INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE export_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE export_schedules FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_export_schedules ON export_schedules;
CREATE POLICY tenant_isolation_export_schedules ON export_schedules
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON export_schedules TO teideal_app;
```

`role_arn`, not an access key: the schedule stores an IAM role ARN in
the *customer's own* AWS account that trusts Teideal's AWS account
(standard cross-account access pattern) -- Teideal never stores or
handles the customer's AWS credentials at all, which is also what makes
AC3's "the customer's own cloud storage" and T8's ownership check work
naturally (see "Ownership validation" below), rather than needing a
bespoke validation step invented on top of stored secret keys. No field
is added for a secret key because none is ever stored.

### File generation: local scratch, then either downloaded or uploaded

No object storage exists for Teideal's own infrastructure yet (that is
a platform-operations decision, TEID-89, not started). Generated files
are written to local disk scratch space under a configurable
`EXPORT_STORAGE_DIR` (default `/tmp/teideal-exports`), named
`<export_id>.<format>`. This is consistent with this codebase's existing
single-instance-deployment assumption (no multi-instance infra decision
has been made anywhere yet) -- note it plainly as an interim choice to
revisit once TEID-89 exists, the same way TEID-30 noted its own
CI-scale substitution.

- **CSV**: streamed row-by-row exactly like TEID-42's
  `tests/audit-log`/`routes/auditLog.ts` CSV export already does --
  reuse that file's `csvCell`/streaming-writer shape rather than
  reinventing it.
- **JSON**: newline-delimited JSON (one record per line), not a single
  JSON array -- avoids needing to buffer the whole result set in memory
  or handle a closing-bracket edge case when a job is interrupted
  mid-stream. Document this explicitly in the format doc (AC4) so a
  consumer doesn't expect `[...]`.
- **Parquet**: written with `@dsnp/parquetjs`'s streaming writer,
  which needs to manage its own row-group buffering and footer write
  against a local file handle -- this is *why* Parquet specifically
  needs local scratch space rather than a pure HTTP stream, unlike
  CSV/JSON.

### Export sources (what "full ledger, usage events, grants and
configuration" resolves to today)

| Category | Table | Columns exported | Notes |
|---|---|---|---|
| Usage events (== ledger, see scoping notes) | `usage_events` | `id, customer_id, event_type, quantity, idempotency_key, occurred_at, created_at` | Read directly per the narrow ADR exception above |
| Customers | `customers` | `id, name, email, created_at, updated_at` | |
| Configuration: tenant settings | `tenant_settings` | `require_mfa_all_roles, idle_timeout_minutes, sso_enabled, updated_at` | |
| Configuration: users | `users` | `id, email, role, mfa_enrolled_at IS NOT NULL AS mfa_enrolled, created_at` | Same safe-field shape `routes/users.ts`'s `GET /users` already returns -- never `password_hash`/`mfa_secret`/`pending_mfa_secret` |
| Configuration: API keys | `api_keys` | `id, display_hint, scope, environment, label, creator_user_id, created_at, last_used_at, status` | Same `KEY_VIEW` shape `routes/apiKeys.ts` already computes -- never `key_hash` |
| Grants | -- | -- | Not yet available (see scoping notes); documented as such, not silently omitted |

`audit_log` is deliberately not part of this export -- TEID-42 already
built a dedicated, filterable CSV export for it; duplicating it here
would be a second, divergent way to get the same data.

### `POST /exports` -- request an export (AC1, AC2)

New file `services/ts-console/src/routes/exports.ts`, Owner-only via
`consoleRoute(scoped, "post", "/exports", { role: ["Owner"] }, ...)` --
"An owner can export" is AC1's own framing, and this is the first write
action in this store of data outward, matching the same admin-only
posture the rest of E05 uses for account-level actions.

Body: `{formats: ["csv","json","parquet"], range_start?: ISO date,
range_end?: ISO date}`. `formats` must be a non-empty subset of
`["csv","json","parquet"]` (400 with a specific reason otherwise, same
convention as `apiKeys.ts`'s `SCOPES`/`ENVIRONMENTS` validation).
Omitting both range fields means a full-history export; both must be
present or both absent (400 otherwise); `range_start` must be before
`range_end`.

Inserts one `exports` row, `status: 'pending'`, and returns `202
{id, status: "pending"}` immediately -- generation happens
asynchronously (see "Export worker" below), which is what makes AC2's
"ready within 24 hours" / "within 1 hour" meaningful as an SLA on a job
rather than a synchronous request.

`GET /exports/:id` -- Owner-only, `WHERE id = $1 AND tenant_id = $2`
(no match: 403, matching every other id-specific endpoint's convention
in this codebase). Returns `{id, status, formats, range_start,
range_end, record_counts, created_at, completed_at, error_message}`.

`GET /exports/:id/download?format=csv|json|parquet` -- Owner-only,
same tenant check as above; 400 if `format` isn't one of the export's
own `formats`; 409 if `status != 'completed'`. Streams the file from
`EXPORT_STORAGE_DIR` with the matching `Content-Type`
(`text/csv`, `application/x-ndjson`, `application/octet-stream`) and a
`Content-Disposition: attachment` header, same pattern
`routes/auditLog.ts`'s CSV export already uses.

### Export worker (AC2, AC3, T3, T5, T6, T7)

New file `services/ts-console/src/lib/exportWorker.ts`, started from
`server.ts` on a timer, the same shape TEID-91's session-sweep already
established (`setInterval`, skipped when `NODE_ENV === "test"`, tests
call the worker's functions directly instead).

- **`processPendingExports(pool)`**: claims one pending row at a time
  with `SELECT ... FOR UPDATE SKIP LOCKED` inside a short transaction
  that immediately flips it to `'running'` and commits -- this is what
  makes T7's five simultaneous requests safe: each is its own row, and
  `SKIP LOCKED` means concurrent worker invocations (or a slow one still
  running) never double-claim the same job, a standard Postgres
  job-queue idiom, not a new abstraction. For each claimed job: run the
  category queries above (scoped by `range_start`/`range_end` when set,
  via `occurred_at`/`created_at` as appropriate per table -- see "per-test
  guidance" for exactly which column each category filters on), write
  one file per requested format, record `record_counts` (one count per
  category, identical across all three formats since they render the
  same rows) and `file_paths`, set `status: 'completed'`,
  `completed_at: now()`. On any error, `status: 'failed'`,
  `error_message` set, and re-raise so it's logged -- never leave a job
  stuck in `'running'`.
- **`processScheduledExports(pool)`**: for every `export_schedules` row
  with `enabled = true` and (`last_run_at IS NULL OR last_run_at < now()
  - interval '1 day'`), generates a full export the same way as above
  (formats from the schedule, no range = full history) directly to a
  local file, then attempts delivery: `AssumeRole` on `role_arn` (a
  fresh STS client per attempt, region from the schedule), then
  `PutObject` to `s3_bucket`/`s3_prefix` for each generated file. Up to
  3 attempts with a short backoff (e.g. 1s, 5s) before giving up for
  this run. On success: `last_run_at = now()`, `last_run_status =
  'succeeded'`, `consecutive_failures = 0`. On exhausted retries (T6):
  `last_run_status = 'failed'`, `consecutive_failures` incremented, and
  one alert email via the existing `sendEmail` (`lib/notify.ts`) sent to
  every `Owner`-role user on the tenant, subject naming the schedule and
  the failure -- reusing TEID-91's lockout-email mechanism rather than
  inventing a second notification path. Generated local files are
  deleted after a successful or exhausted-retry delivery attempt either
  way, so scratch disk doesn't grow unbounded across days.

### Ownership validation (AC3, T8)

`POST /export-schedules` (Owner-only) validates the destination
*before* ever storing it as active: attempt `AssumeRole` on the
submitted `role_arn`, then a lightweight `HeadBucket` (or
`ListObjectsV2` with `MaxKeys: 1`) against `s3_bucket` using the
resulting temporary credentials. Either call failing (access denied, role
doesn't trust Teideal's account, bucket doesn't exist, role has no
permission on that bucket) is rejected with `400 {"error": "could not
verify write access to the configured bucket -- check the role's trust
policy and permissions"}`, and no row is inserted. This is what T8
actually tests: a role/bucket combination Teideal's account can't
assume into or write to is rejected at configuration time, not
discovered later as a silent delivery failure. The same check re-runs
before each scheduled delivery too (`processScheduledExports` naturally
re-attempts `AssumeRole`/`PutObject` every run), so a bucket whose
permissions changed *after* the schedule was created still fails safely
into T6's retry-then-alert path rather than silently succeeding against
data it can no longer actually reach.

### `GET /support/export-format-doc` -- format documentation (AC4, T4)

New static doc `docs/export-format.md`, listing exactly the column
table above (one section per category, including a "Grants -- not yet
available" note) plus the JSON-lines/CSV/Parquet format notes. Served
the same way TEID-41-T4's isolation design doc already is: new function
in `routes/support.ts` (or `routes/exports.ts`, co-located with the rest
of this story -- either is fine, pick one and be consistent), reading
the file from disk and returning it, no session auth required beyond
whatever `support.ts`'s existing pattern already requires (tenant
API-key auth, matching that route's own precedent). **The column list in
this doc and the column list actually written into the CSV must be kept
in lockstep by construction** -- generate both the doc's table and the
CSV header from the same shared column-name arrays in
`lib/exportSources.ts`, not two independently maintained copies, so
T4's "no undocumented fields" can't silently drift.

## Implementation guidance per test

### TEID-44-T1
`POST /exports {formats: ["csv","json","parquet"]}` for a tenant with a
handful of customers and usage events. Poll `GET /exports/:id` until
`status: "completed"`. Download all three formats, parse each (CSV
rows, JSON-lines, Parquet via `@dsnp/parquetjs`'s reader), and assert
the row count for each category (customers, usage_events) is identical
across all three files and matches `record_counts` in the job's own
status response.

### TEID-44-T2
Full-history export: assert `completed_at - created_at` is comfortably
under the CI-scale equivalent of 24 hours (see T5's scoping below for
how "3 years of data" is substituted in an automated run). 7-day-range
export (`range_start`/`range_end` 7 days apart): assert it completes
faster, well under the CI-scale equivalent of 1 hour, and that
`GET /exports/:id/download` for it contains only rows with
`occurred_at`/`created_at` inside that window.

### TEID-44-T3
`POST /export-schedules` against the fake S3/STS test double (see File
layout) configured to accept the given `role_arn`. Advance/trigger
`processScheduledExports` three times, simulating one day apart each
time (directly call the function with a mocked "now", the same
`processPendingExports`/timer-avoidance pattern TEID-91's session-sweep
tests already use). Assert the fake S3 double received exactly one
`PutObject` per day, three total, for the configured bucket/prefix.

### TEID-44-T4
`GET /support/export-format-doc`. Parse the returned column list per
category and assert it's an exact set match (not a subset) against the
actual header row of a freshly generated CSV for that category --
proving the doc and the file can never silently drift, per the shared
source-of-truth requirement above.

### TEID-44-T5
Bulk-insert usage events for one tenant via
`INSERT ... SELECT ... FROM generate_series(...)` (the same bulk-fixture
technique TEID-92-T7/TEID-30-T7 already use) rather than one row at a
time. Scale down for CI the same way TEID-30-T3/T6 did: env vars
`EXPORT_LOAD_TEST_EVENTS` (default `50_000`) and
`EXPORT_LOAD_TEST_SLA_SECONDS` (default `120`), overridable for a real
50,000,000-row run outside CI. Assert the export completes within the
configured SLA with `status: "completed"`, not `"failed"` or stuck
`"running"`. Document the full 50M/24h target as what a dedicated
perf/staging pipeline validates before a release that changes the
export path, matching TEID-30's own T3/T6 precedent exactly.

### TEID-44-T6
Point a schedule's `role_arn`/`s3_bucket` at the fake S3 double
configured to fail `PutObject` for every attempt (simulating an
unreachable destination) for this one run. Trigger
`processScheduledExports` once. Assert the fake double recorded 3
`PutObject` attempts (the retry count), `export_schedules.last_run_status
= 'failed'`, `consecutive_failures` incremented, and exactly one email
was sent (via the existing `notifications_sent` table TEID-91 already
writes to) to the tenant's Owner-role user(s) naming the schedule.

### TEID-44-T7
Fire 5 concurrent `POST /exports` requests for the same tenant (`await
Promise.all(...)`). Assert 5 distinct `exports` rows are created. Run
`processPendingExports` repeatedly (or in parallel invocations) until
all 5 reach `status: "completed"`. Download and parse all 5 sets of
files; assert every one has identical, correct row counts and no file
is truncated, duplicated, or contains another job's rows mixed in --
the concrete meaning of "5 consistent, non-corrupted files."

### TEID-44-T8
`POST /export-schedules` with a `role_arn`/`s3_bucket` the fake STS
double is configured to reject `AssumeRole` for (simulating a role that
doesn't trust Teideal's account, or a bucket the assumed role can't
write to). Assert `400` and the specific "could not verify write
access" reason. Confirm via `GET` (list schedules, if implemented, or a
direct query) that no `export_schedules` row was created.

## File layout

- `db/migrations/<timestamp>_data_export.sql` -- `exports`,
  `export_schedules`.
- `services/ts-console/src/lib/exportSources.ts` -- new: per-category
  queries and the shared column-name arrays the CSV header and the
  format doc both read from.
- `services/ts-console/src/lib/exportFormats.ts` -- new: CSV (reusing
  `auditLog.ts`'s streaming-writer shape), JSON-lines, and Parquet
  (`@dsnp/parquetjs`) writers.
- `services/ts-console/src/lib/s3.ts` -- new: thin wrapper around
  `@aws-sdk/client-s3`/`@aws-sdk/client-sts` (`AssumeRole`, `PutObject`,
  `HeadBucket`), pointed at a configurable endpoint
  (`AWS_ENDPOINT_URL_OVERRIDE`, both SDK clients support this) so tests
  can target the fake double instead of real AWS.
- `services/ts-console/src/lib/exportWorker.ts` -- new:
  `processPendingExports`, `processScheduledExports`.
- `services/ts-console/src/routes/exports.ts` -- new: `POST /exports`,
  `GET /exports/:id`, `GET /exports/:id/download`, `POST
  /export-schedules`, `GET /export-schedules`, `GET
  /support/export-format-doc`.
- `services/ts-console/src/server.ts` -- register `exports.ts`'s
  routes; start the export-worker timer alongside the existing
  session-sweep one.
- `docs/export-format.md` -- new.
- Tests: new directory `tests/data-export/` (mirror `tests/api-keys/`'s
  shape: own `package.json`, `tsconfig.json`, `vitest.config.ts`) plus
  `tests/data-export/fake-s3.ts`, a minimal S3/STS test double (mirror
  `tests/console-auth/fake-google.ts`'s role: a small HTTP server
  implementing just enough of `AssumeRole`/`PutObject`/`HeadBucket` to
  drive T3/T6/T8, configurable per-test via a small control endpoint the
  same way `fake-google.ts`'s `/mint` is).
- CI: add steps to `.github/workflows/ci.yml`'s `test` job installing
  and running `tests/data-export`, starting `fake-s3.ts` the same way
  `fake-google.ts` is already started.

## Definition of done

- [ ] All 4 acceptance criteria satisfied by working code (AC1/AC2 as
      scoped above for "ledger"/"grants"; AC3 scoped to S3).
- [ ] All 8 cataloged tests have real automated tests that pass.
- [ ] The CSV header and the format documentation's column list are
      generated from the same shared source, not maintained twice.
- [ ] `tsc --noEmit` clean in `services/ts-console`; every new
      session-authed route goes through `consoleRoute`, not a direct
      `scoped.get/post/...` call (per TEID-43's completeness guard).
- [ ] `tests/cross-tenant`, `tests/console-auth`, `tests/audit-log`,
      `tests/api-keys`, `tests/rbac` all still pass unchanged.
- [ ] Cross-tenant isolation proven in `tests/cross-tenant` for the new
      `/exports*` and `/export-schedules*` endpoints (acct_1001 against
      acct_1002's export/schedule ids), per the standing rule any new
      authenticated endpoint adds a case there.
- [ ] Full suite passes against a database rebuilt from scratch via
      `db/setup-local.sh` plus the existing seed scripts.
- [ ] PR description maps each test ID to its file/line.
