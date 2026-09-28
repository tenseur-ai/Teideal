# TEID-37: Connect a Stripe account, read-only first

| | |
|---|---|
| Epic | TEID-4 (E04 -- Develop Stripe connector (read-first) and invoice sync) |
| Phase | E04 (new phase, no prior stories) |
| Priority | Highest |
| Points | 3 |
| Release | mvp |
| Order | 36 (first story in this phase) |
| Depends on | `recordConfigChangeWithClient` (TEID-42), `consoleRoute`/`requireSession` (TEID-43), `jose` (already a dependency, TEID-91's JWT verification) |

## Story (verbatim from the live board)

> As a billing operator, I want to connect our Stripe account with read-only access to start, so that Teideal can verify our billing without being able to change anything.
>
> *Context*
> Customers grant read access for Verify on day one. Write access is a separate, later decision when they move billing onto Teideal.

## Acceptance criteria (verbatim from the live board)

1. An operator can connect Stripe using Stripe's standard authorisation flow.
2. By default only read access is requested, and the connection screen states that Teideal cannot change anything in Stripe.
3. Write access is requested separately, only when the operator enables invoice sync or credit grants (TEID-39, TEID-40).
4. No card or bank details are ever stored in our system.
5. Disconnecting stops all access to Stripe immediately and is recorded in the audit log.

## Cataloged tests (verbatim from the live board)

| ID | Type | AC | Title |
|---|---|---|---|
| TEID-37-T1 | Functional | 1 | Click Connect Stripe and complete Stripe's standard OAuth Connect authorization flow with a test Stripe account, confirming the connection succeeds and an access token is stored. |
| TEID-37-T2 | Functional | 2 | Complete the initial Stripe connection and confirm the requested OAuth scopes are read-only and the UI displays explicit text stating Teideal cannot make changes in Stripe. |
| TEID-37-T3 | Functional | 3 | With a read-only Stripe connection active, enable the invoice-sync feature and confirm a separate, distinct OAuth re-authorization prompt requesting write scope is triggered rather than write access being silently granted. |
| TEID-37-T4 | Functional | 4 | Complete a full Stripe connection using Stripe's hosted OAuth page and confirm no card number, CVV, or bank account detail ever appears in Teideal's database, logs, or API payloads. |
| TEID-37-T5 | Functional | 5 | Disconnect an active Stripe integration, immediately attempt an API call using the previously valid token and confirm it is rejected, and confirm an audit log entry records the disconnect action, actor, and timestamp. |
| TEID-37-T6 | Non-functional | 5 | Confirm that revoking a Stripe connection propagates and blocks all in-flight and new API calls within 5 seconds of the disconnect action being confirmed. |
| TEID-37-T7 | Adversarial | 3 | Attempt to call a Stripe write endpoint, such as creating an invoice item, using a connection that only holds read-only scope, and confirm the connector rejects the call with a permissions error rather than silently succeeding. |
| TEID-37-T8 | Adversarial | 1 | Attempt to replay or reuse an intercepted OAuth authorization code after it has already been exchanged once and confirm the second exchange attempt is rejected, preventing connection hijacking. |

## Scoping notes for this point in the build sequence

This is the first story in a brand-new epic (E04) with a completely
clean foothold -- confirmed by an exhaustive repo-wide grep: nothing
Stripe-related exists anywhere except two identical code comments
(`lib/notify.ts`, `db/migrations/20260926180000_auth.sql`) that merely
*mention* the Stripe connector as a future example of a pluggable
integration, and one forward-reference in TEID-42's own spec. ADR 0001
names this service placement explicitly, by name -- "TypeScript owns...
the console, admin tooling, billing/usage views, **the Stripe
connector**" -- so `services/ts-console` is not an inference here, it's
stated.

- **This is a real OAuth 2.0 authorization-code flow, structurally
  different from this repo's only existing external-IdP precedent.**
  TEID-91's Google sign-in verifies a client-obtained OIDC `id_token`
  against a JWKS endpoint -- no redirect, no server-to-IdP token
  exchange, no client secret. Stripe Connect's OAuth is the classic
  three-legged flow: redirect the operator to Stripe's hosted authorize
  page, Stripe redirects back with a `code`, the server exchanges that
  `code` for an access token via a server-to-server `POST` with a client
  secret. The *pattern* `fake-google.ts`/`fake-s3.ts` establish (a real,
  standalone local HTTP process, started by CI as its own service,
  polled on `/healthz`, with the real production code pointed at it via
  an env-var base-URL override) transfers directly; the actual endpoints
  and flow are newly designed here, not copied.
- **Hand-rolled HTTP calls, not the real `stripe` npm package.** The
  `stripe` package is not a dependency anywhere in this repo today. Its
  `oauth` resource (the piece that would wrap the token-exchange/
  deauthorize calls this story needs) talks to `connect.stripe.com`,
  a different host than the rest of the SDK's `api.stripe.com` calls,
  and isn't confirmed to support pointing at a fake host for testing.
  Given the OAuth surface this story actually needs is exactly three
  simple HTTP calls (an authorize-URL redirect target requiring zero
  server-side call at all, one token-exchange `POST`, one deauthorize
  `POST`), and this repo's own established precedent is "point a real
  client at an overridable base URL" (`lib/google.ts`'s `jose` usage)
  rather than "hand-roll a shim to dodge a dependency," the *cleanest*
  application of that same precedent here is a small, real
  `fetch`-based client against a new `STRIPE_CONNECT_BASE_URL` env var
  (defaulting to the real `https://connect.stripe.com` in production,
  overridden to the fake double's URL in tests) -- not adding the
  `stripe` package for three calls it may not even cleanly support
  redirecting in tests.
- **AC2's "connection screen states..." and T2's "the UI displays
  explicit text"** are scoped the same way every prior story's UI-
  flavored AC has been: no admin console UI exists anywhere in this
  repo. The connection-status endpoint's response includes a fixed,
  human-readable `notice` field stating the read-only guarantee in
  words, standing in for the future UI's display of that same text --
  T2 asserts against that field, not a rendered page.
- **AC3/T3's "enable the invoice-sync feature" references TEID-39, which
  doesn't exist yet.** What's actually testable now is the
  *re-authorization mechanism itself* -- that requesting a scope upgrade
  produces a genuinely separate authorize flow with `scope=read_write`,
  not a silent grant -- independent of whatever future UI trigger
  TEID-39/40 eventually wire to it. Scoped to a standalone endpoint,
  `POST /stripe/connections/:id/request-write-access`, that returns a
  new authorize URL requesting write scope -- the same kind of synthetic
  stand-in TEID-17/18/19/20 each used for their own not-yet-built
  trigger points, here standing in for "whatever button TEID-39/40 will
  eventually call this from."
- **AC4's "no card or bank details are ever stored" is proved two ways,
  following TEID-92-T9's own "prove a negative" precedent exactly**: (a)
  a schema-level check (`information_schema.columns` on
  `stripe_connections` contains none of `card_number`/`cvv`/
  `account_number`/`routing_number`/`last4`/similar), and (b) a
  flow-level check -- because Stripe's hosted OAuth page means card/bank
  data never transits through Teideal's server at all (the token-
  exchange response contains only `access_token`/`stripe_user_id`/
  `scope`/`livemode`, structurally no payment-instrument fields), every
  request and response body the connect flow ever sends or receives is
  captured against the fake double and asserted to contain none of those
  fields -- proving the absence at the wire-protocol level, the stronger
  and more direct proof, not just "we didn't add a column for it."
- **Recoverable token storage, not a one-way hash -- the first story in
  this codebase needing this, and a real design decision, stated
  explicitly.** `api_keys.key_hash` (TEID-92) works as SHA-256 because
  Teideal *issued* that secret and only ever needs to compare, never
  retrieve it. A Stripe access token is the opposite: Teideal must
  *present* the exact token back to Stripe on every future read call, so
  a one-way hash is structurally the wrong tool. `pgcrypto` is already
  enabled in this schema but used only for `gen_random_uuid()` --
  nothing does reversible encryption today. Node-side AES-256-GCM
  (`node:crypto`, stdlib, no new dependency) is used instead of
  `pgp_sym_encrypt`, matching this codebase's consistent existing
  pattern of doing secret-handling crypto in the TypeScript layer, not
  SQL (`bcryptjs` for passwords, `createHash` for API keys) -- the
  encryption key comes from a new `STRIPE_TOKEN_ENCRYPTION_KEY` env var
  (a 32-byte key, base64-encoded), wired through `server.ts`/CI the same
  way `ADMIN_SECRET` already is.
- **Role gate: `["Owner", "Billing Admin"]`, not `Owner`-only.** A real
  judgment call between two existing but conflicting precedents in this
  codebase: `tenantSettings.ts`/`exports.ts` reserve `Owner`-only for the
  most tenant-wide-impact actions (granting a third party ongoing access
  is arguably that kind of action), while every billing-configuration
  mutation (`grants`, `plans`, `commits`, `consumption-order`) uses
  `["Owner", "Billing Admin"]`. AC1's own text explicitly names "a
  billing operator" as the actor -- the persona this story is written
  for is exactly the role this codebase already calls "Billing Admin" --
  so `["Owner", "Billing Admin"]` is used, matching the persona over the
  `Owner`-only precedent.
- **No card/bank-detail retention risk from the state parameter either.**
  OAuth CSRF protection uses a short-lived, signed `state` value (HMAC'd
  via `jose`, embedding tenant id, user id, a nonce, and a 10-minute
  expiry) rather than a new database table -- verified on callback
  without needing server-side state storage, avoiding a
  `stripe_oauth_states` table for what's fundamentally a stateless CSRF
  check.

## Architecture and design

### Schema: one new table

New migration `db/migrations/20260928120000_stripe_connections.sql`:

```sql
CREATE TABLE IF NOT EXISTS stripe_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  stripe_account_id TEXT NOT NULL,
  access_token_ciphertext TEXT NOT NULL,
  access_token_iv TEXT NOT NULL,
  access_token_auth_tag TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('read_only', 'read_write')),
  status TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'disconnected')),
  connected_by_user_id UUID REFERENCES users(id),
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  disconnected_at TIMESTAMPTZ
);
ALTER TABLE stripe_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_connections FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_stripe_connections ON stripe_connections;
CREATE POLICY tenant_isolation_stripe_connections ON stripe_connections
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON stripe_connections TO teideal_app;
```

`stripe_account_id` is Stripe's own `acct_...` identifier -- not secret,
safe to display (the `display_hint`-equivalent field, per `api_keys`'
precedent). `access_token_ciphertext`/`_iv`/`_auth_tag` together hold the
AES-256-GCM-encrypted access token; none of the three alone is useful
without the app-level `STRIPE_TOKEN_ENCRYPTION_KEY`.

### `services/ts-console/src/lib/stripeConnect.ts` -- new file

- `encryptToken`/`decryptToken`: `node:crypto`'s `createCipheriv`/
  `createDecipheriv` with `aes-256-gcm`, key from
  `STRIPE_TOKEN_ENCRYPTION_KEY` (read once at module load, `400`-shaped
  startup failure if missing/wrong length -- matching `ADMIN_SECRET`'s
  existing required-env-var precedent).
- `buildAuthorizeUrl(tenantId, userId, scope)`: constructs
  `${STRIPE_CONNECT_BASE_URL}/oauth/authorize?response_type=code&client_id=${STRIPE_CONNECT_CLIENT_ID}&scope=${scope}&redirect_uri=${STRIPE_CONNECT_REDIRECT_URI}&state=${signedState}`.
  `signedState` is a `jose` `SignJWT` (reusing the same library TEID-91's
  Google flow already depends on) with `{tenantId, userId, scope}`,
  5-minute... **10-minute** expiry, signed with
  `STRIPE_TOKEN_ENCRYPTION_KEY` (reused as the HMAC secret -- one secret,
  not two, since both are app-internal signing/encryption keys with the
  same trust boundary).
- `verifyState(token)`: `jose`'s `jwtVerify`, returns `{tenantId,
  userId, scope}` or throws on expiry/tamper (**T8**'s replay defense's
  first layer -- an expired or tampered state is rejected before any
  Stripe call is even made).
- `exchangeCode(code)`: `fetch(`${STRIPE_CONNECT_BASE_URL}/oauth/token`,
  {method: "POST", body: new URLSearchParams({client_secret:
  STRIPE_CONNECT_CLIENT_SECRET, code, grant_type:
  "authorization_code"})})` -- returns `{accessToken, stripeAccountId,
  scope}` or throws on a non-2xx (which is exactly how **T8**'s second,
  real defense works: Stripe itself rejects a second exchange of the
  same already-consumed `code`, and this function's error propagates as
  a `400` to the caller -- no code-tracking table needed on Teideal's
  side, the authority for single-use `code` semantics is Stripe's own,
  which the fake double must faithfully simulate, see below).
- `deauthorize(stripeAccountId)`: `fetch(`${STRIPE_CONNECT_BASE_URL}/oauth/deauthorize`,
  {method: "POST", body: new URLSearchParams({client_id:
  STRIPE_CONNECT_CLIENT_ID, stripe_user_id: stripeAccountId})})`.
- `assertWriteScope(connection)`: throws a typed `StripeScopeError` if
  `connection.scope !== "read_write"` -- the app-level guard **T7**
  exercises, checked before any call to Stripe's main API host is ever
  made (not relying on Stripe's own API to reject it, matching this
  story's "reject... rather than silently succeeding" wording with a
  guard Teideal controls).

### `GET /stripe/connect/authorize-url?scope=read_only` (AC1, AC2)

New file `services/ts-console/src/routes/stripeConnect.ts`, `["Owner",
"Billing Admin"]`, session-authed via `consoleRoute`. `scope` query
param defaults to `read_only` if omitted (AC2's "by default only read
access is requested"); only `read_only`/`read_write` accepted. Returns
`{url, notice: "Teideal will only be able to read your Stripe data. It cannot create, modify, or delete anything in Stripe."}`
(the notice text is AC2/T2's console-screen stand-in).

### `POST /stripe/connect/callback` (AC1, AC4, T1, T4, T8)

Same file, `["Owner", "Billing Admin"]`. Body: `{code, state}`. Calls
`verifyState` (rejects expired/tampered state), `exchangeCode`,
encrypts the returned token, `INSERT INTO stripe_connections`, calls
`recordConfigChangeWithClient` (`objectType: "StripeConnection"`,
`before: null`, `after: {stripe_account_id, scope, status: "connected"}`
-- deliberately never including the token, ciphertext or otherwise, in
the audit row). `201` with the created connection's public fields
(`id, stripe_account_id, scope, status, connected_at`) -- **never** the
token or its ciphertext in any response body.

### `POST /stripe/connections/:id/request-write-access` (AC3, T3)

Same file, same role gate. Loads the existing connection, calls
`buildAuthorizeUrl(tenantId, userId, "read_write")`. Returns `{url}` --
a **new**, separate authorize flow, not a silent scope upgrade on the
existing row (the existing connection's `scope` only changes once a
**new** `POST /stripe/connect/callback` completes with the upgraded
scope, reusing the same callback handler and inserting a fresh
`stripe_connections` row -- an upgrade is a new connection event, kept
in the same append-and-supersede spirit as this codebase's other
config-change patterns, not an in-place mutation of the existing row's
`scope` column after the fact).

### `POST /stripe/connections/:id/disconnect` (AC5, T5, T6)

Same file, same role gate. Loads the connection, calls `deauthorize`,
`UPDATE stripe_connections SET status = 'disconnected', disconnected_at
= now() WHERE id = $1` (the one `UPDATE` this table's `GRANT` allows --
status transition only, never touching the token fields), calls
`recordConfigChangeWithClient` (`before: {status: "connected"}`, `after:
{status: "disconnected"}`, `reason` omitted -- disconnect needs no
operator-supplied reason per this story's ACs, unlike TEID-19's amend).
Every call site that would use a connection's token (none exist yet in
this story beyond the connect/disconnect flow itself, but this is the
contract future stories like TEID-39/40 must follow) checks `status =
'connected'` before using a decrypted token -- **T5**'s "immediately
attempt an API call... confirm it is rejected" is satisfied by this
status check, not by Stripe's own deauthorize call alone (belt-and-
suspenders: even if Stripe's own revocation were somehow delayed,
Teideal's own status check blocks use immediately, satisfying **T6**'s
5-second propagation budget trivially, since it's a synchronous local DB
read, not a network round trip to Stripe to confirm revocation).

### The fake Stripe double (`tests/stripe-connect/fake-stripe.ts`)

New standalone HTTP process, following `fake-google.ts`'s exact shape:
`GET /healthz`; `GET /oauth/authorize` (302s straight back to the
`redirect_uri` with a canned `code` and the caller's own `state` echoed
back -- no simulated consent-page UI, matching `fake-google.ts`'s `/mint`
skipping simulated human login); `POST /oauth/token` (tracks consumed
codes in memory -- a `Set<string>`; the **first** exchange of a given
code returns `{access_token, stripe_user_id, scope, livemode: false,
token_type: "bearer"}`; a **second** exchange of the same code returns
`400 {"error": "invalid_grant"}`, faithfully simulating real Stripe's
documented single-use `code` behavior -- this is what makes **T8** a
real, meaningful test rather than one only provable against production
Stripe); `POST /oauth/deauthorize` (returns `{stripe_user_id}`, no
further effect needed since the fake has no separate "is this token
still valid" state to revoke).

## Implementation guidance per test

### TEID-37-T1
`GET /stripe/connect/authorize-url?scope=read_only`, follow the returned
URL to the fake double (which redirects back with a `code`+`state`),
`POST /stripe/connect/callback` with those values. Assert `201` and that
`stripe_connections` has exactly one row with `access_token_ciphertext`
populated (non-null, non-empty) and decrypting it (via the test's own
import of `decryptToken`, or a raw DB read plus manual decryption using
the same key) yields the fake's canned access token.

### TEID-37-T2
`GET /stripe/connect/authorize-url` with no `scope` param. Assert the
returned `url` contains `scope=read_only` (not `read_write`) and the
response's `notice` field contains the required "cannot" / "cannot make
changes" text.

### TEID-37-T3
Complete a normal read-only connection (as in T1). `POST
/stripe/connections/:id/request-write-access`. Assert the returned
`url` contains `scope=read_write` and is a **different** URL/state than
the original connection's authorize URL (not a mutation of the same
authorize request). Assert the original connection's own `scope` in the
database is still `read_only` (no silent upgrade).

### TEID-37-T4
Complete a full connection (as in T1), capturing every request/response
body exchanged with the fake double via the fake's own request log (a
`GET /_requests` debug endpoint the fake double exposes, logging every
request it received, matching a lightweight version of `fake-s3.ts`'s
own request-capture pattern used elsewhere in this repo). Assert none of
those captured bodies, nor the `stripe_connections` row, nor any
`console.log`/logger output captured during the test, contains a
16-digit-looking number, a 3-4 digit CVV-shaped field, or any field
named `card`/`cvv`/`account_number`/`routing_number`. Separately, query
`information_schema.columns` for `stripe_connections` and assert none of
those column names appear.

### TEID-37-T5
Complete a connection, `POST /stripe/connections/:id/disconnect`.
Immediately attempt a (synthetic, since no real Stripe-read feature
exists yet) internal call that would use the connection's token --
directly exercise the same status-check guard a future TEID-39/40 call
site would use, asserting it throws/rejects because `status =
'disconnected'`. `GET` the tenant's audit log and assert an entry with
`object_type: "StripeConnection"`, the disconnecting user's id as
`actor_user_id`, and a timestamp within the test's own execution window.

### TEID-37-T6
Time from the `disconnect` call's response to the status-check guard
(as in T5) correctly rejecting -- since the guard is a synchronous local
DB read, not a call to Stripe, assert this is comfortably under 5
seconds (in practice, well under 100ms) -- proving the architectural
choice (local status check, not waiting on Stripe's own propagation)
rather than merely timing Stripe's real revocation latency, which this
repo cannot control or meaningfully test against a fake.

### TEID-37-T7
Complete a read-only connection. Call `assertWriteScope` against it
directly (or via a thin diagnostic route if the implementer prefers an
HTTP-level test over a unit-level one -- either satisfies this test,
pick one and be consistent) and assert it throws `StripeScopeError`
before the fake double's request log shows any request was made to it
for this attempt (proving the guard runs before any network call, not
after a failed one).

### TEID-37-T8
Complete a connection via the callback flow once (as in T1). Using the
**same** `code` value again, `POST /stripe/connect/callback` a second
time with a freshly-generated valid `state` (isolating this test to
proving code-replay rejection specifically, not state-expiry rejection).
Assert `400` (propagated from the fake double's `invalid_grant`
response) and that `stripe_connections` still has exactly one row (the
first, successful connection) -- no second row created, no existing row
modified.

## File layout

- `db/migrations/20260928120000_stripe_connections.sql` -- new
  `stripe_connections` table.
- `services/ts-console/src/lib/stripeConnect.ts` -- new: token
  encryption/decryption, authorize-URL construction, state signing/
  verification, code exchange, deauthorize, `assertWriteScope`.
- `services/ts-console/src/routes/stripeConnect.ts` -- new: `GET
  /stripe/connect/authorize-url`, `POST /stripe/connect/callback`, `POST
  /stripe/connections/:id/request-write-access`, `POST
  /stripe/connections/:id/disconnect`.
- `services/ts-console/src/server.ts` -- register the new route file;
  read and validate `STRIPE_TOKEN_ENCRYPTION_KEY`,
  `STRIPE_CONNECT_CLIENT_ID`, `STRIPE_CONNECT_CLIENT_SECRET`,
  `STRIPE_CONNECT_BASE_URL`, `STRIPE_CONNECT_REDIRECT_URI` at startup.
- Tests: new directory `tests/stripe-connect/` (mirror
  `tests/console-auth/`'s shape: `env.ts`/`http.ts`/`session.ts`/
  `db.ts`), `fake-stripe.ts` (mirroring `fake-google.ts`), implementing
  all 8 cataloged tests.
- `tests/cross-tenant/stripe-connect-isolation.test.ts` -- new:
  cross-tenant case for every new endpoint.
- CI: `.github/workflows/ci.yml` gets a new "Install and start the fake
  Stripe service" step (port `8092`, next free after `FAKE_S3_URL`'s
  `8091`), a new `FAKE_STRIPE_URL` workflow-level env var, the
  `ts-console` start step gains `STRIPE_CONNECT_BASE_URL="$FAKE_STRIPE_URL"`
  plus test-fixed `STRIPE_CONNECT_CLIENT_ID`/`_SECRET`/
  `_REDIRECT_URI`/`STRIPE_TOKEN_ENCRYPTION_KEY`, and install+test steps
  for `tests/stripe-connect`, positioned after the existing
  `tests/commits` step (or after TEID-20's `tests/rate-overrides` if
  that lands first -- either ordering is fine, they don't depend on each
  other).

## Definition of done

- [ ] All 5 acceptance criteria satisfied by working code.
- [ ] All 8 cataloged tests have real automated tests that pass --
      functional, non-functional, and adversarial alike.
- [ ] `tsc --noEmit` clean in `services/ts-console`; every new route
      goes through `consoleRoute`.
- [ ] `tests/cross-tenant`, `tests/console-auth`, `tests/audit-log`,
      `tests/api-keys`, `tests/rbac`, `tests/data-export`, `tests/plans`,
      `tests/grants`, `tests/consumption-order`, `tests/commits` all
      still pass unchanged.
- [ ] Cross-tenant isolation proven in `tests/cross-tenant` for every new
      endpoint.
- [ ] Full suite passes against a database rebuilt from scratch via
      `db/setup-local.sh` plus the existing seed scripts.
- [ ] PR description maps each test ID to its file/line.
