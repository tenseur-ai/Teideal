# TEID-37 implementation notes

The spec was implementable as written. A few points conflict with an existing
suite, with each other, or with running the eight tests in one shared
database. Each resolution below keeps the spec's own behavior.

## Startup validation versus in-process `buildServer()`

`stripeConnect.ts` is specified to read `STRIPE_TOKEN_ENCRYPTION_KEY` once at
module load and fail startup with a 400-shaped error when the key is missing
or the wrong length, "matching `ADMIN_SECRET`". `ADMIN_SECRET` is not actually
required: `server.ts` substitutes `dev_admin_secret` when it is unset.
`tests/rbac` also imports `buildServer()` inside the test process, which does
not have the Stripe variables. Throwing from the import, or from
`buildServer()`, fails that suite.

A present key is decoded once at module load. A wrong length is stored and
`assertStripeConfig()` raises `StripeConfigError` (`statusCode` 400). The
process entrypoint calls that before `listen` and exits when the key or the
other Connect settings are missing. `buildServer()` does not exit, so the
role-manifest test can still construct the app. There is no dev-key fallback
in the server: a silent default would encrypt tokens under a known key.

## One canned code versus eight connections

The fake double is specified to redirect with "a canned code" and to remember
consumed codes in a `Set`. One shared code would make the second test's first
exchange fail, because the first test already consumed it. Each
`GET /oauth/authorize` mints a fresh `ac_test_…` code and remembers the scope
that was requested. The `Set` still rejects a second `POST /oauth/token` for
that same code with `400 {"error":"invalid_grant"}`. "Canned" here means the
double mints the code, the way `fake-google.ts` mints an id token.

`GET /_requests` and `GET /healthz` are not written into that exchange log.
The log endpoint's own body would otherwise contain the log.

## "Exactly one row" in a shared database

T1 and T8 say `stripe_connections` has exactly one row. The cross-tenant case
and the other seven tests insert rows into the same database before and after
T1. The assertions are the behavior the sentences are there to prove: this
exchange inserted one row, and replaying the code inserted nothing and did
not modify the first row.

## Notice text

The architecture section gives the notice as one exact sentence. T2's
guidance also mentions the phrase "cannot make changes", which that sentence
does not contain. The response uses the architecture sentence verbatim. It
says Teideal cannot create, modify, or delete anything in Stripe. T2 asserts
that sentence.

## State nonce and session binding

The architecture payload is `{tenantId, userId, scope}`. The scoping notes
also require a nonce, and T3 requires two authorize URLs minted in the same
second to differ. The signed state carries those three claims plus a `jti`
nonce and a 10-minute expiry. `verifyState` still returns only
`{tenantId, userId, scope}`.

The callback rejects the state when its tenant or user is not the signed-in
operator, and it does that before exchanging the code. Otherwise an attacker
session could redeem a victim's code. The granted scope is also required to
equal the scope in the state, so a token response cannot widen a read-only
request into write access.
