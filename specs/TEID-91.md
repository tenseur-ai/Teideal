<!--
Retroactive spec, written 2026-10-01. See specs/TEID-41.md's header note
-- same situation: built directly by Claude before the spec-first
process existed, documented here from the real code rather than a plan
predating it.
-->

# TEID-91: Console sign-in with multi-factor authentication

| | |
|---|---|
| Epic | TEID-5 (E05 -- tenant isolation, access control, data ownership) |
| Phase | E05 -- tenant isolation, access control, data ownership |
| Priority | Highest |
| Points | 5 |
| Release | mvp |
| Order | 2 |
| Depends on | TEID-41 (RLS/tenant model this story's sessions and users sit on top of). Complements TEID-43 (RBAC) and TEID-42 (audit log), built afterward. |

## Story (verbatim from the live board)

> As a Teideal user, I want to sign in securely with multi-factor authentication, so that access to financial data is protected even if a password leaks.
>
> *Context*
> Complements role-based access (TEID-43).

## Acceptance criteria (verbatim from the live board)

1. Users can sign in with email and password or with Google sign-in.
2. Multi-factor authentication (authenticator app) is mandatory for Owner and Billing Admin roles and optional for others; an Owner can make it mandatory for everyone.
3. Idle sessions expire after 8 hours by default; the Owner can shorten this.
4. After 10 failed attempts the account is locked for 15 minutes and the user is notified by email.
5. All sign-ins, failed attempts, MFA changes and lockouts are recorded in the audit log (TEID-42).

## Cataloged tests (verbatim from the live board)

| ID | Type | AC | Title |
|---|---|---|---|
| TEID-91-T1 | Functional | 1 | Sign in to the console with valid email and password for support@acmeco.com and confirm success, then repeat sign-in for the same account using Google sign-in and confirm it also succeeds. |
| TEID-91-T2 | Functional | 2 | As an Owner, toggle Require MFA for all roles on, then attempt to sign in as an existing Support-role user with no enrolled MFA and confirm they are forced into authenticator-app enrollment before reaching the dashboard. |
| TEID-91-T3 | Functional | 3 | Leave a Finance user's session idle for 8 hours and 1 minute and confirm the next action requires re-authentication, then confirm an Owner can set the idle timeout to 30 minutes and have it take effect immediately for new sessions. |
| TEID-91-T4 | Functional | 4 | Attempt sign-in with an incorrect password 10 consecutive times for billing@acmeco.com and confirm the account locks for 15 minutes and a lockout notification email is sent to that address. |
| TEID-91-T5 | Functional | 5 | Perform a successful sign-in, a failed sign-in, an MFA method change and an account lockout for the same test user, then confirm all four events appear in the audit log with correct event type and timestamp. |
| TEID-91-T6 | Non-functional | 3 | Simulate 5,000 concurrent sessions reaching their 8-hour idle expiry within the same one-minute window and confirm the expiry job processes all of them without degrading sign-in latency for new logins. |
| TEID-91-T7 | Non-functional | 1 | Add 500ms of simulated latency to the Google OAuth identity provider and confirm sign-in still completes within 2 seconds or fails with a clear timeout message rather than hanging. |
| TEID-91-T8 | Adversarial | 4 | Script 10 failed login attempts against the same account from 10 different IP addresses within one minute and confirm the lockout still triggers based on account identity rather than being bypassed via IP rotation. |
| TEID-91-T9 | Adversarial | 2 | Attempt to disable MFA on an Owner account via a direct API call while authenticated with only a password and no MFA step-up, and confirm the request is rejected. |

## Scoping notes for this point in the build sequence

This story was originally flagged `provisional: true` on the board
(visible in the raw story data) -- resolved in the same way every other
provisional story in this backlog has been: built as specified once
picked up, with the provisional flag now stale relative to the
completed implementation.

## Architecture and design (as built)

**Dual sign-in** (AC1/T1/T7): email+password (bcrypt-hashed, via
`services/ts-console/src/lib/sessionAuth.ts`) and Google OAuth (OIDC,
JWKS-verified against a configurable issuer/audience --
`GOOGLE_JWKS_URL`/`GOOGLE_ISSUER`/`GOOGLE_AUDIENCE`, with
`tests/console-auth/fake-google.ts` standing in for the real IdP in
every automated test). T7's latency requirement is enforced by a
bounded JWKS-fetch timeout rather than an unbounded wait, so a slow IdP
fails fast with a clear error instead of hanging the request.

**MFA** (AC2/T2/T9): TOTP-based (authenticator app), enrollment required
before an Owner/Billing Admin session is usable; `tests/console-auth/totp.ts`
implements the same TOTP algorithm a real authenticator app would, used
by the test suite to generate valid codes. An Owner's tenant-wide
"require MFA for all roles" setting is enforced at sign-in -- a
non-enrolled user under that setting is routed into enrollment before
reaching anything else, never silently let through. Disabling MFA on an
account (T9) requires a step-up MFA challenge even when the request is
otherwise authenticated -- a password-only session cannot disable MFA
on itself or anyone else via a direct API call.

**Idle session expiry** (AC3/T3/T6): a per-tenant configurable idle
timeout (default 8 hours, Owner-adjustable down), enforced by a
background sweep worker (`sweepExpiredSessions`, gated by the same
`NODE_ENV`/`DISABLE_BACKGROUND_WORKERS` convention as every other
background worker in this codebase) rather than only at request time --
this is what T6's 5,000-concurrent-expiry scale test exercises: the
sweep must clear a large expired-session batch without adding latency
to concurrent new-login requests, which it achieves by being a
separate, independently-scheduled tick rather than something inline in
the login path.

**Lockout** (AC4/T8): 10 failed attempts locks the account (not the
source IP) for 15 minutes, with a notification email sent on the
lockout transition. Keyed on account identity specifically so T8's
IP-rotation adversarial case can't bypass it -- the failed-attempt
counter lives on the account/user row, never on a per-IP structure.

**Audit log integration** (AC5/T5): every sign-in, failed attempt, MFA
change, and lockout writes to the shared `audit_log` table (TEID-42,
built immediately after this story) via `recordConfigChangeWithClient`-style
helpers, with each event's specific detail (e.g. which MFA method
changed, which IP a failed attempt came from) carried in the row's
`detail` JSON column rather than a dedicated per-event-type schema.

## Implementation guidance per test (as built -- file/line covering each)

| Test | Covered by |
|---|---|
| TEID-91-T1 | `tests/console-auth/login.test.ts`, `tests/console-auth/fake-google.ts` |
| TEID-91-T2 | `tests/console-auth/mfa-enrollment.test.ts` |
| TEID-91-T3 | `tests/console-auth/idle-timeout.test.ts` |
| TEID-91-T4 | `tests/console-auth/lockout.test.ts` |
| TEID-91-T5 | `tests/console-auth/audit-log.test.ts` |
| TEID-91-T6 | `tests/console-auth/session-sweep.test.ts` |
| TEID-91-T7 | `tests/console-auth/google-latency.test.ts` |
| TEID-91-T8 | `tests/console-auth/lockout-ip-rotation.test.ts` |
| TEID-91-T9 | `tests/console-auth/mfa-disable.test.ts` |

## File layout (as built)

- `services/ts-console/src/lib/sessionAuth.ts`, `sessions.ts` -- sign-in,
  session issuance, idle-expiry sweep.
- `tests/console-auth/` -- one file per AC/test area (see table above),
  plus shared fixtures (`fixtures.ts`, `testUsers.ts`, `totp.ts`,
  `fullLogin.ts`, `fakeGoogleClient.ts`, `fake-google.ts`).
- `docs/isolation-design.md` / `docs/api/` -- auth-flow documentation
  alongside the rest of this codebase's API docs.

## Definition of done

- [x] Every acceptance criterion above is satisfied by working code.
- [x] Every cataloged test has a real automated test that passes --
      functional, non-functional, and adversarial alike.
- [x] `tsc --noEmit` is clean.
- [x] The suite passes against a database rebuilt from scratch using only
      committed migration/seed scripts -- reverified repeatedly across
      every subsequent story's independent-verification pass this
      session (`tests/console-auth` is part of the standing regression
      battery every later story runs against).
