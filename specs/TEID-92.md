# TEID-92: API key lifecycle: create, scope, rotate, revoke

| | |
|---|---|
| Epic | TEID-5 (E05 -- Establish tenant isolation, access control, and data ownership) |
| Phase | E05 |
| Priority | Highest |
| Points | 5 |
| Release | mvp |
| Order | 4 (within E05) |
| Depends on | `api_keys` table (TEID-41, `db/migrations/20260926120000_init.sql`), `services/go-usage/internal/auth/auth.go`, `services/ts-console/src/lib/auth.ts`, `recordConfigChange`/`recordConfigChangeWithClient` (TEID-42, `services/ts-console/src/lib/audit.ts`) |

## Story (verbatim from the live board)

> As a developer at our customer, I want to manage API keys with limited scopes and rotate them without downtime, so that a leaked or outdated key never gives more access than necessary or causes an outage.

## Acceptance criteria (verbatim from the live board)

1. Keys can be created with a scope: ingest-only, read-only, or admin, and for either sandbox or production.
2. The full key is shown once at creation; Teideal stores only a hash and can never display it again.
3. Rotating a key issues a new one while the old one keeps working for a grace period (default 24 hours, configurable), then stops.
4. A revoked key stops working everywhere within 60 seconds.
5. Each key shows its creator, scope, creation date and last-used time; creation, rotation and revocation are audit-logged.

## Cataloged tests (verbatim from the live board)

| ID | Type | AC | Title |
|---|---|---|---|
| TEID-92-T1 | Functional | 1 | Create a new API key with scope read-only for the production environment and confirm it is created with environment=production and scope=read-only correctly set. |
| TEID-92-T2 | Functional | 2 | Create a new API key and confirm the full plaintext key is displayed exactly once in the creation dialog, then reopen the key detail view and confirm only a masked value such as sk_live_****1234 is ever shown again. |
| TEID-92-T3 | Functional | 3 | Rotate an active production API key using the default 24-hour grace period, confirm both old and new keys authenticate successfully at hour 23, and confirm the old key is rejected with 401 at hour 25. |
| TEID-92-T4 | Functional | 4 | Revoke an active read-only key that is currently in use and confirm a request made with that key 90 seconds later is rejected with 401 across regions. |
| TEID-92-T5 | Functional | 5 | Create, rotate and revoke a test API key, then confirm the key detail view shows correct creator, scope, creation date and last-used timestamp, and confirm all three lifecycle actions appear as separate audit log entries. |
| TEID-92-T6 | Non-functional | 4 | Measure the time from calling the revoke-key API to the key being rejected across 5 regional edge nodes and confirm propagation completes within the documented 60-second SLA in at least 99% of trials. |
| TEID-92-T7 | Non-functional | 1 | Create 1,000 API keys across sandbox and production scopes for a single tenant and confirm the key management list view still loads and paginates without timeout. |
| TEID-92-T8 | Adversarial | 3 | During the 24-hour grace period after rotating a key, run 5,000 requests per minute against the old key and confirm its scope and rate limits still apply identically to before rotation, with no elevated access granted. |
| TEID-92-T9 | Adversarial | 2 | Attempt to retrieve the plaintext value of a previously created key via any API endpoint or database export and confirm it is unrecoverable, with only a one-way hash ever returned. |

## Scoping notes for this point in the build sequence

- **T6's "5 regional edge nodes"** describes infrastructure that doesn't
  exist yet -- there is one region, one Postgres instance, no caching/edge
  layer in front of API key checks. Every request re-checks `revoked_at`
  synchronously against Postgres (see below), so there is no propagation
  delay to measure today: revocation is consistent the instant the
  `UPDATE` commits. Test this honestly as what it actually is -- revoke,
  then immediately make an authenticated request with the same key and
  confirm 401 -- rather than fabricating multi-region measurement
  infrastructure. When an edge/caching layer is eventually introduced
  (not scheduled), this test needs to be revisited for real propagation
  behavior; note that in the test file itself.
- **T8's "rate limits"** don't exist as a feature anywhere in this
  codebase yet (no story has built rate limiting). Test the part that is
  real -- scope enforcement is unchanged during the grace period, an
  old-but-not-yet-expired key can do exactly what its scope allows, no
  more -- and skip the rate-limit half of the sentence; don't invent a
  rate limiter to satisfy a test title literally. Say so in the test's
  own description/comment, don't silently drop it without a trace.
- **AC1's scopes need something to actually gate**, or "scope" is a
  label with no effect. Neither TEID-41 nor TEID-91 built any scope
  enforcement -- every API key can currently do everything an API key
  can do. This story has to build minimal scope enforcement across
  *both* services that check API keys (`services/go-usage`,
  `services/ts-console`), not just add a `scope` column. See
  "Architecture and design" below for the exact mapping.

## Architecture and design

### Schema: extend `api_keys`

New migration `db/migrations/<timestamp>_api_keys_lifecycle.sql`
(generate the timestamp with `date -u +%Y%m%d%H%M%S`):

```sql
ALTER TABLE api_keys
  ADD COLUMN scope TEXT NOT NULL DEFAULT 'admin'
    CHECK (scope IN ('ingest-only', 'read-only', 'admin')),
  ADD COLUMN environment TEXT NOT NULL DEFAULT 'sandbox'
    CHECK (environment IN ('sandbox', 'production')),
  ADD COLUMN display_hint TEXT NOT NULL DEFAULT '',
  ADD COLUMN creator_user_id UUID REFERENCES users(id),
  ADD COLUMN last_used_at TIMESTAMPTZ,
  ADD COLUMN expires_at TIMESTAMPTZ,
  ADD COLUMN revoked_at TIMESTAMPTZ;

ALTER TABLE api_keys ALTER COLUMN scope DROP DEFAULT;
ALTER TABLE api_keys ALTER COLUMN environment DROP DEFAULT;
```

(The `DEFAULT`s exist only so the `ALTER TABLE` succeeds against
existing rows from TEID-41's dev-fixture seed data; dropped immediately
after so every *new* insert must specify both explicitly -- TEID-41's
fixture keys keep working as `admin`/`sandbox`, which is what they were
implicitly before this story.)

`creator_user_id` is nullable: keys created by TEID-41's seed script
(`db/seed-test-fixtures.sh`) have no console user behind them and stay
`NULL` -- "creator" only applies to keys created through the new
endpoint below. `status` is not a stored column -- compute it when
reading: `revoked` if `revoked_at IS NOT NULL`, else `expired` if
`expires_at IS NOT NULL AND expires_at <= now()`, else `active`. Storing
it separately would just be a second source of truth that can drift from
the timestamps that actually decide it.

### Key format and masking (AC2, T2, T9)

Plaintext format: `sk_{live|test}_{43 url-safe base64 chars from 32
random bytes}` (`live` for `environment = 'production'`, `test` for
`sandbox` -- matches T2's literal example `sk_live_****1234`). Hash with
the same `sha256`-hex scheme `api_keys.key_hash` already uses elsewhere
in this codebase (TEID-41's `hashKey` in both `auth.go` and `auth.ts`).
`display_hint` is computed once at creation from the plaintext --
`sk_{live|test}_****{last 4 chars}` -- and stored permanently; it is the
*only* thing derived from the plaintext that is ever persisted besides
the hash. Nothing in this story reads `key_hash` back out anywhere except
to compare against an incoming request's hash -- there is no code path
that could leak or reconstruct the plaintext (T9), and no test should
find one.

### Scope enforcement (AC1, T8)

Exact mapping -- write this down once, both services implement the same
table:

| Route | Required scope(s) |
|---|---|
| `POST /usage` (go-usage) | `ingest-only` or `admin` |
| `GET /usage` (go-usage) | `read-only` or `admin` |
| `GET /customers`, `GET /customers/:id` (ts-console) | `read-only` or `admin` |
| `POST /customers`, `PATCH /customers/:id` (ts-console) | `admin` only |

Neither service has a generic RBAC layer yet (that's TEID-43, and even
then TEID-43 is about console *session* roles, not API key scopes --
don't conflate the two). Implement this as the smallest thing that
enforces the table above:

- **`services/go-usage/internal/auth/auth.go`**: `Principal` gains
  `Scope string`. `Middleware` becomes scope-aware: change its
  signature to `Middleware(pool *pgxpool.Pool, requiredScope string)
  func(http.Handler) http.Handler`, checking `principal.Scope ==
  requiredScope || principal.Scope == "admin"` after resolving, 403 if
  it fails. `cmd/server/main.go` passes `"ingest-only"` when wiring
  `POST /usage` and `"read-only"` for `GET /usage` (two separate
  `Middleware(...)` calls, already how `main.go` wires each route
  individually today -- this is additive to that existing shape, not a
  restructure).
- **`services/ts-console/src/lib/auth.ts`**: `Principal` gains `scope:
  string`. `requireAuth` takes an optional `requiredScope` parameter the
  same way; `services/ts-console/src/routes/customers.ts`'s route
  registrations pass `"read-only"` for the two `GET`s and `"admin"` for
  `POST`/`PATCH`.

### Resolving a key now also checks revocation/expiry and records usage

Both `Resolve` (Go) and `resolveApiKey` (TS) add `AND revoked_at IS NULL
AND (expires_at IS NULL OR expires_at > now())` to the existing `WHERE
k.key_hash = $1` lookup -- a revoked or grace-period-expired key simply
doesn't match the query, so it fails exactly the same way an unknown key
does (`ErrUnknownKey` / `null` / 401) with no special-casing needed at
the call site. On a successful resolve, update `last_used_at = now()`
for that key row (a second, fire-and-forget-is-fine `UPDATE`; a slightly
stale `last_used_at` under heavy concurrent load is acceptable, this is
a display field, not a security control).

### API key management endpoints (new, session-authed, ts-console)

New file `services/ts-console/src/routes/apiKeys.ts`, `requireSession`
-gated (same pattern as `tenantSettings.ts`/`auditLog.ts`), tenant-scoped
via `withTenant`. No role check yet -- the story's own framing is "as a
developer", and TEID-43 (the role that will eventually own this,
per its own AC listing "Developer (API keys and sandbox)") doesn't exist
yet; any authenticated session for the tenant may manage that tenant's
keys, matching how every other pre-RBAC endpoint in this codebase is
scoped.

- `POST /api-keys` -- body `{scope, environment, label}`. Generates the
  key, stores the row (`creator_user_id` from
  `req.consolePrincipal.userId`), calls `recordConfigChangeWithClient`
  (`objectType: "ApiKey"`, `objectId: <new id>`, `before: null`, `after:
  {scope, environment, label, display_hint}` -- never the plaintext or
  the hash in `before`/`after`). Returns `201` with the **plaintext key
  once** (`{id, key: "sk_...", scope, environment, label,
  display_hint}`) -- this is the only response body in the entire API
  that ever contains the plaintext.
- `GET /api-keys` -- paginated (`?limit=`, default 50, max 200;
  `?cursor=` an opaque key id for keyset pagination, same reasoning as
  TEID-42's CSV export but at a much smaller scale -- 1,000 rows doesn't
  strictly need keyset pagination the way 1.2M did, but reusing the same
  pattern is simpler than introducing `LIMIT`/`OFFSET` as a second
  paging style in this codebase). Returns `{data: [...]}`, each entry
  `{id, display_hint, scope, environment, label, creator_user_id,
  created_at, last_used_at, status}` -- never `key_hash`.
- `GET /api-keys/:id` -- same shape as one list entry.
- `POST /api-keys/:id/rotate` -- body `{grace_period_hours?}` (default
  `24`). Creates a new key row (same `scope`/`environment`/`label` as
  the old one, new `creator_user_id` = the rotating session's user),
  sets the **old** row's `expires_at = now() + grace_period_hours
  hours`, calls `recordConfigChangeWithClient` once (on the old key's
  row -- the new row's creation already gets its own audit row from the
  same code path `POST /api-keys` uses), `objectType: "ApiKey"`,
  `objectId: <old id>`, `before: {status:
  "active"}`, `after: {status: "expiring", expires_at, rotated_to:
  <new id>}`. Returns `201` with the new plaintext key once, same shape
  as create.
- `POST /api-keys/:id/revoke` -- sets `revoked_at = now()` immediately
  (no grace period -- AC4 is explicit: "stops working everywhere within
  60 seconds", not "eventually"), `recordConfigChangeWithClient`
  (`before: {status: "active"}`, `after: {status: "revoked"}`).

## Implementation guidance per test

### TEID-92-T1
`POST /api-keys` with `{scope: "read-only", environment: "production",
label: "..."}`. Assert `201`, response has `environment: "production"`,
`scope: "read-only"`, and a `key` starting with `sk_live_`. Fetch it back
via `GET /api-keys/:id` and confirm the same `scope`/`environment`
persisted.

### TEID-92-T2
Same creation call: assert the plaintext `key` field is present in the
`201` body. Then `GET /api-keys/:id`: assert there is no `key` field at
all in that response, only `display_hint` matching `^sk_(live|test)_\*{4}[A-Za-z0-9_-]{4}$`.

### TEID-92-T3
Create a production key, rotate it with default grace period. Directly
`UPDATE api_keys SET expires_at = now() + interval '1 hour' WHERE id =
$1` (simulating "hour 23" without waiting 23 real hours) and confirm
both the old and new plaintext keys still authenticate a request
successfully. Then `UPDATE api_keys SET expires_at = now() - interval
'1 hour' WHERE id = $1` (simulating "hour 25") and confirm the old key
now gets 401 while the new key still works.

### TEID-92-T4
Create a read-only key, use it successfully once (e.g. `GET
/customers`), call `POST /api-keys/:id/revoke`. Wait (or just assert
immediately, per the scoping note above -- there is no propagation delay
to actually wait out) and confirm a request with that key returns 401.

### TEID-92-T5
Create a key, rotate it, revoke the *new* (rotated-to) key. Fetch
`GET /api-keys/:id` for the original and confirm `creator_user_id`,
`scope`, `created_at`, `last_used_at` (non-null after the T4-style usage
above, or make one authenticated call with it first here) are all
correct. Query `audit_log` (or `GET /audit-log?object_type=ApiKey`, from
TEID-42) filtered to these key ids and confirm three separate rows exist
for create/rotate/revoke.

### TEID-92-T6
Revoke a key, immediately (no sleep) make an authenticated request with
it, assert 401 and record the elapsed time. Repeat across e.g. 20
iterations with fresh keys each time and assert every single one is
under 60 seconds (in practice under a few hundred ms, proving the actual
mechanism -- a synchronous per-request DB check -- has no propagation
delay to begin with, not just that it happens to squeak under budget).

### TEID-92-T7
Bulk-create 1,000 keys for one tenant in one statement (`INSERT ...
SELECT ... FROM generate_series(1, 1000)`, computing a distinct
`key_hash` per row the same way TEID-41's/TEID-91's bulk-fixture tests
do -- this doesn't need to go through the API 1,000 times). Time
`GET /api-keys` (first page) and assert it responds well within a
normal request budget (e.g. under 2 seconds) and returns exactly
`limit` rows with a `cursor` for the next page; page through with that
cursor and confirm all 1,000 are reachable with no duplicates.

### TEID-92-T8
Create a read-only key, rotate it (24h default grace period, unexpired).
Using the **old** key, attempt both a `read-only`-scoped call (should
still succeed -- same as before rotation) and an `admin`-scoped call
like `POST /customers` (should still be 403 -- rotation does not upgrade
scope). Confirm both outcomes are identical to what the same key would
have done before rotation.

### TEID-92-T9
Create a key. Assert: no `GET /api-keys*` response ever contains `key`
or `key_hash`. Directly query `api_keys` as `teideal_app` (the same role
the app itself uses) and confirm `key_hash` is present as expected
(the app needs it to authenticate requests) but there is no column or
computed value anywhere that reconstructs the plaintext from it --
`key_hash` is one-way by construction (SHA-256), so this test's real
job is confirming no *other* column or endpoint ever stored or leaks the
plaintext, not re-deriving cryptographic one-wayness.

## File layout

- `db/migrations/<timestamp>_api_keys_lifecycle.sql`
- `services/go-usage/internal/auth/auth.go` -- `Scope` on `Principal`,
  scope-aware `Middleware`, revocation/expiry check, `last_used_at`
  update.
- `services/go-usage/cmd/server/main.go` -- pass `requiredScope` at each
  `Middleware(...)` call site.
- `services/ts-console/src/lib/auth.ts` -- same shape as the Go changes.
- `services/ts-console/src/routes/customers.ts` -- pass `requiredScope`
  into each route's `requireAuth(...)` call.
- `services/ts-console/src/routes/apiKeys.ts` -- new.
- `services/ts-console/src/server.ts` -- register `apiKeys.ts`'s routes
  (`requireSession`-gated group, alongside `tenantSettings.ts`/
  `auditLog.ts`).
- Tests: new directory `tests/api-keys/` (mirror `tests/audit-log/`'s
  shape: own `package.json`, `tsconfig.json`, `vitest.config.ts`). This
  suite spans both services (create/list/rotate/revoke via ts-console,
  scope enforcement checks against both go-usage and ts-console) --
  point it at both `TS_CONSOLE_URL` and `GO_USAGE_URL` like
  `tests/cross-tenant` already does.
- CI: add a step to `.github/workflows/ci.yml`'s `test` job running this
  new suite.

## Definition of done

- [ ] All 5 acceptance criteria satisfied by working code (AC1's scope
      enforcement genuinely gates both services; AC3/AC4's timing as
      scoped above).
- [ ] All 9 cataloged tests have real automated tests that pass.
- [ ] `go vet ./...` clean in `services/go-usage`; `tsc --noEmit` clean
      in `services/ts-console`.
- [ ] `tests/cross-tenant`, `tests/console-auth`, `tests/audit-log` all
      still pass unchanged -- the `Principal`/`Middleware`/`requireAuth`
      signature changes are additive, and TEID-41's dev-fixture keys
      (`admin`/`sandbox` via this migration's dropped defaults) keep
      authenticating exactly as before.
- [ ] Full suite passes against a database rebuilt from scratch via
      `db/setup-local.sh` plus the existing seed scripts.
- [ ] PR description maps each test ID to its file/line.
