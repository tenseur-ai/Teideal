<!--
Header note, read before anything else. This spec is written from a
directly user-authored brief (verbatim requirements below, lightly
reorganized into this project's standard spec format) plus a full research
pass against the current codebase (services/ts-console). Four real gaps
between the brief and current reality are called out here, resolved
conservatively, not silently:

1. "Same origin as the session cookie" -- there is no cookie-based session
   anywhere in this codebase. Auth is Bearer-token-only
   (`services/ts-console/src/lib/sessionAuth.ts`); nothing sets a
   Set-Cookie header. Adding real cookie-based auth would mean touching the
   auth middleware used by every existing route in the system -- a far
   bigger, riskier change than "integrate the existing APIs" implies, and
   not something to do silently. Resolved as: the console is a same-origin
   (served from ts-console, no CORS) browser page that holds the session
   token in sessionStorage and attaches it as `Authorization: Bearer` on
   every API call. No new cookie mechanism. "Same origin" is satisfied by
   serving the UI's static files from ts-console itself.
2. No static-file serving, no frontend framework, no build tooling exists
   anywhere in this repo. This story adds the entire stack from zero.
   Resolved as: plain static HTML/CSS/vanilla JS (ES modules), no bundler,
   no framework dependency -- matches this codebase's existing taste
   (minimal, no abstraction beyond what's needed) and keeps the thing
   Claude has to independently verify free of a transpilation step to trust.
3. Three backend routes genuinely don't exist and are in-scope, minimal,
   additive gap-fills -- not "a second backend," the same pattern as every
   existing route, reusing existing service functions where one already
   exists for the API-key-gated path:
   - `GET /auth/me` (session-gated, any role) -- nothing today lets a
     signed-in browser ask "who am I."
   - `GET /customers` and `GET /customers/:id` (session-gated, Owner/Billing
     Admin) -- the existing routes of the same name in
     `routes/customers.ts` are gated by API-key auth
     (`lib/auth.ts`'s `requireAuth`), not session auth; a browser console
     cannot use them without minting and embedding a standing API key,
     which is a worse security posture than adding the session-gated
     equivalent. Extract the existing handler's data-fetching into a
     shared function both routes call -- one implementation, two auth
     guards, not two backends.
   - `GET /customers/:id/subscription` (session-gated, Owner/Billing Admin)
     -- every existing subscription route mutates (assign plan, schedule
     migration, grandfather) and happens to echo the row back; there is no
     plain read.
4. The brief's "Owner and Billing Admin see every screen" and the existing,
   already-shipped `/users` route's hard `role: ["Owner"]` gate (not
   Billing Admin) are in tension. Not resolved by changing existing,
   shipped access-control policy to fit a new UI's convenience. Resolved
   per the brief's own words ("Forbidden calls still hit the existing
   403"): Billing Admin sees the Users nav item like every other screen;
   a mutating action there 403s exactly as it does for any other caller,
   and the UI renders that 403 as an inline error rather than crashing.
   Nothing about this story touches `/users`' role gate.

Out of scope, stated by the user directly and not revisited here: TEID-39
Stripe invoice sync, TEID-67 (price-to-plan mapping), margin/cost
dashboards, widgets, a chatbot. No client-side recomputation of any
monetary figure. No Stripe invoice-item write from this UI, ever. No
disconnect action anywhere in this UI may call
`POST /stripe/connections/:id/disconnect` (revokes the shared Stripe
Connect OAuth token also used by live TEID-39/40 invoice sync) -- the only
disconnect this UI exposes is `DELETE /connectors/:id` (disconnects
Verify's own read-only connector record, leaves the shared OAuth token
untouched), the same distinction TEID-65.1 already had to get right
upstream.
-->

# TEID-UI-1: Integrated admin console for the Verify demo

| | |
|---|---|
| Epic | None on the live board -- first operator-facing UI, user-directed, not a board item |
| Priority | Highest |
| Depends on | TEID-45 (timeline), TEID-50 (period close), TEID-66/68/68.1 (Verify), TEID-37/38/65/65.1 (Stripe connect), TEID-43 (users/roles), TEID-?? (grants/plans), existing API-keys routes. All already shipped. |

## Story

> As an Owner, Billing Admin, Finance user, Support agent, or Developer at a Teideal customer, I want a single web console to sign in, see the Verify discrepancy report, inspect a customer's plan/balance/timeline, manage Stripe connection and billed-line mapping (read-only), view period close, review the audit log, and manage users/API keys -- each scoped to my role -- so that there is one place to operate Teideal day to day, backed entirely by the APIs that already exist.

## Acceptance criteria

1. A visitor with no session sees a sign-in screen; a correct password for an MFA-enrolled user leads to a TOTP prompt (`mfa_required`) or, for a not-yet-enrolled mandatory-MFA role, an enrollment prompt (`mfa_enrollment_required`) with the QR/manual-entry `otpauth_uri`; a correct TOTP code completes sign-in and the console loads.
2. Every screen's nav visibility matches the role matrix in Scoping notes. A direct navigation to (or API call from) a screen a role cannot use either isn't shown, or results in the existing backend's 403 rendered as a plain error, never a crash and never a silently-swallowed failure.
3. The Home screen has a month picker and shows the discrepancy report's `totals` for that month, with nonzero-delta customer rows sorted before zero-delta rows.
4. The Discrepancy Report screen renders exactly the fields `GET /verify/discrepancy-report` returns for each row -- customer, `expected_total`, `billed_total`, `delta`, classification -- with every monetary value rendered as the literal decimal string the API returned, never parsed through `Number()`/`parseFloat` or reformatted. A `null` classification renders as "Match". Clicking a row opens the row's `evidence` (billed Stripe line ids, expected ledger/usage-event ids) without any additional API call beyond the one that already fetched the report. `excluded` (unmapped customers) and `caveats` render in their own section, visually separate from the mapped-customer rows, never merged into the totals a user might mistake for mapped revenue.
5. The Customer screen shows plan and balance (Owner/Billing Admin only) and embeds the existing TEID-45 timeline (every role that can reach this screen, including Support and Finance via their timeline-only access).
6. The Contract screen (Owner/Billing Admin) shows plan, grants, and commits for a customer; a mutating action (assign plan, create/amend a grant or commit) is available only where the underlying route already exists and is called exactly as that route's contract requires -- no new mutation semantics invented in the UI.
7. The Stripe screen (Owner/Billing Admin) supports connect (OAuth), sync, and "map billed lines" (`POST /verify/map-billed-lines`), all read-only with respect to Stripe itself. No control anywhere in this screen can create a Stripe invoice item (TEID-39) or request write scope for that purpose. The only disconnect control calls `DELETE /connectors/:id`; nothing in this UI calls `POST /stripe/connections/:id/disconnect`.
8. The Period Close screen (Owner/Billing Admin/Finance read-only) shows `GET /period-close-summary` for the same month selected elsewhere in the console.
9. The Audit Log screen (every role) lists `GET /audit-log` results for the last 30 days and links to the existing `GET /audit-log/export.csv` download -- no new CSV export is implemented.
10. The Users/Roles/API-Keys screen (Owner full access; Billing Admin sees it, subject to AC2's 403 handling; Developer sees API keys only, defaulting new keys to the sandbox environment) lists users and their roles, lists API keys (`display_hint` only, never plaintext, on every list/detail view), and shows a created or rotated key's plaintext exactly once, in a dialog that states it will not be shown again, immediately after the `POST /api-keys` or `POST /api-keys/:id/rotate` response that returned it.
11. Seeding the exact fixture this spec's T1 test describes and opening the Discrepancy Report for 2026-08 renders the already-live demo customer's row as `expected 500.00`, `billed 500.00`, `delta 0.00`, classification "Match", and its evidence drill-down shows the billed line's period as `2026-08-15` to `2026-09-15`. A second, dev-only seeded customer for the same month renders `expected 500.00`, `billed 400.00`, with a non-"Match" classification and a visibly different row treatment (e.g. a highlighted/colored delta) from the first row.

## Cataloged tests

| ID | Type | AC | Title |
|---|---|---|---|
| TEID-UI-1-T1 | Functional | 1 | Sign in as an MFA-enrolled Billing Admin with the correct password, confirm `mfa_required` and a TOTP prompt render, submit the correct code, confirm the console loads and `GET /auth/me` reflects the signed-in role. |
| TEID-UI-1-T2 | Functional | 1 | Sign in as a user not yet MFA-enrolled whose role is in `MANDATORY_MFA_ROLES`, confirm `mfa_enrollment_required` renders a QR/`otpauth_uri` prompt, submit a code generated from that secret, confirm sign-in completes. |
| TEID-UI-1-T3 | Adversarial | 2 | Sign in as Support, confirm the nav shows only the customer timeline path (no Home/Report/Contract/Stripe/Period-Close/Audit/Users nav items), and confirm a direct call to a Support-forbidden route from the browser's own session token still returns the existing backend 403, rendered as a plain error. |
| TEID-UI-1-T4 | Functional | 2 | Sign in as Billing Admin, open the Users/Roles screen (visible per AC10), attempt to create a user, confirm the existing backend's `role: ["Owner"]`-only 403 is returned and rendered inline, not as a crash. |
| TEID-UI-1-T5 | Functional | 3, 11 | Seed the live demo fixture (clean $500/$500 match) plus a second dev-only customer at $500 expected / $400 billed for 2026-08, open Home, confirm `totals` render and the $400 (nonzero-delta) row sorts before the $500 (zero-delta) row. |
| TEID-UI-1-T6 | Functional | 4, 11 | Open the Discrepancy Report for 2026-08 as Billing Admin and assert, field by field, that every rendered monetary string is byte-identical to the corresponding field in the raw `GET /verify/discrepancy-report` response body (not reformatted, not rounded) -- confirms no client-side recomputation anywhere in the render path. |
| TEID-UI-1-T7 | Functional | 4 | Confirm the clean-match row renders classification "Match" (from a `null` API value) and the mismatched row renders its actual classification string, with visually distinct styling between the two, and that clicking either row shows evidence Stripe line ids and ledger/usage ids with no second network request. |
| TEID-UI-1-T8 | Functional | 4 | Seed an unmapped Stripe customer and a `caveats`-triggering case; confirm both render in a section visually and structurally separate from the mapped-customer `data` rows, and are never summed into a total a viewer could mistake for mapped revenue. |
| TEID-UI-1-T9 | Functional | 5 | As Owner, open a customer with grant/usage activity; confirm plan and balance render and the embedded timeline shows entries consistent with `GET /customers/:id/timeline`'s own response for that customer. |
| TEID-UI-1-T10 | Adversarial | 5 | As Support, open the same customer; confirm only the timeline section renders (no plan/balance section at all, not even empty/greyed), and that the page never calls the new Owner/Billing-Admin-only `GET /customers/:id` endpoint as Support. |
| TEID-UI-1-T11 | Functional | 6 | As Billing Admin, view a customer's existing grants/commits (read), then create a new grant through the UI and confirm it calls `POST /grants` with exactly the fields that route's contract requires and the new grant appears in the list without a page reload losing state. |
| TEID-UI-1-T12 | Adversarial | 7 | Inspect the full rendered Stripe screen's DOM/JS for every role that can reach it; confirm no element or code path exists that calls `POST /stripe/connections/:id/disconnect` or any route that creates a Stripe invoice item, and confirm the screen's only disconnect control calls `DELETE /connectors/:id`. |
| TEID-UI-1-T13 | Functional | 8 | As Finance, open Period Close for 2026-08, confirm `GET /period-close-summary` data renders and no mutating control (e.g. the Stripe-sync-this-period action) is present for this role. |
| TEID-UI-1-T14 | Functional | 9 | Open Audit Log, confirm entries from the last 30 days render, and confirm the export control is a direct link/redirect to the existing `GET /audit-log/export.csv`, not a new export implementation. |
| TEID-UI-1-T15 | Adversarial | 10 | Create an API key, confirm the plaintext is shown once in a dialog; reload the API Keys list and open the same key's detail view; confirm plaintext is absent from both and only `display_hint` appears; rotate the key and confirm the new plaintext appears once more, then is likewise never shown again. |
| TEID-UI-1-T16 | Adversarial | 2, 4 | Any API response with HTTP 401 (expired/invalid session) from any screen clears the stored session token and returns the user to sign-in, without leaking any previously-fetched figures into a subsequent, different user's session on the same browser tab. |

## Scoping notes

**Role / screen visibility matrix** (nav-level; a screen not listed for a role is not shown in nav, per AC2):

| Screen | Owner | Billing Admin | Finance | Support | Developer |
|---|---|---|---|---|---|
| Sign-in / MFA | yes | yes | yes | yes | yes |
| Home | yes | yes | no | no | no |
| Discrepancy report | yes | yes | read-only | no | no |
| Customer: plan/balance | yes | yes | no | no | no |
| Customer: timeline | yes | yes | read-only | read-only (only screen Support reaches) | no |
| Contract (plan/grants/commit) | yes | yes | no | no | no |
| Stripe (connect/sync/map) | yes | yes | no | no | no |
| Period close summary | yes | yes | read-only | no | no |
| Audit log | yes | yes | yes* | yes* | yes* |
| Users / roles / API keys | yes | yes (AC10/AC2) | no | no | API keys only, sandbox-default |

\* `GET /audit-log` and its CSV export are role-gated to `ROLES` (all five) in the existing backend -- the brief doesn't name Audit Log in Finance/Support/Developer's restricted list, so it stays visible to everyone per the backend's own existing policy; this is not a new grant, it's not hiding an already-open door.

- **"Read-only" above** means: the screen's GET calls succeed for that role (the backend already allows it) and no mutating control renders for that role at all -- not "renders disabled," not present in the DOM.
- **Money rendering, everywhere, no exceptions**: every amount displayed anywhere in this console is the literal string a `GET` response returned. No screen may call `Number()`, `parseFloat()`, `toFixed()`, or any arithmetic on a monetary field for display. If a derived figure is genuinely needed (e.g. a sort key), sort by the string's sign/zero-ness or by a separate non-monetary field, never by a float-parsed amount.
- **Session handling**: `sessionStorage` (not `localStorage` -- cleared when the tab closes, not persisted across browser restarts) holds the `session_token` under one fixed key. A shared `apiFetch(path, options)` helper is the only thing that attaches `Authorization: Bearer <token>`; every screen's data-fetching goes through it. A 401 from any call clears the token and routes to sign-in (TEID-UI-1-T16).
- **`GET /auth/me`** (new, minimal): returns `{ user_id, tenant_id, role }` from `req.consolePrincipal`, session-gated, any role. Used once per page load to decide nav visibility; the UI must not infer role from anything cached client-side beyond this call and the original login response.
- **The three new backend routes** (`GET /auth/me`, `GET /customers`, `GET /customers/:id`, `GET /customers/:id/subscription`) follow the exact `consoleRoute(scoped, method, url, {role: [...]}, handler)` pattern already used by every other route in `services/ts-console/src/routes/`, registered the same way (a `scoped` sub-app with `requireSession(pool)` as a `preHandler`). `GET /customers`/`GET /customers/:id`'s data-fetching logic must be a shared function called by both the existing API-key-gated route and this new session-gated one -- read `services/ts-console/src/routes/customers.ts` first and extract, don't duplicate.
- **No build step**: static assets under `services/ts-console/public/`, served via a newly-added `@fastify/static` registration in `server.ts`, mounted under `/console` (with `GET /` redirecting to `/console/`). Plain HTML/CSS and vanilla JS ES modules, no bundler, no framework dependency added to `package.json`. This keeps the whole UI reviewable without trusting a build/transpile step.
- **Tests run under jsdom** (already a dependency via `tests/docs`'s existing accessibility suite -- confirm the version there before adding a new one), loading the served static page and its JS modules directly and asserting rendered DOM against either the live local stack (same pattern every other `tests/*` suite in this repo already uses) or a mocked `fetch`, matching whichever existing `tests/*` convention best fits. No new browser-automation framework (Playwright, Puppeteer, Cypress) is added for this story.
- **The demo fixture** referenced in AC11/T5/T6/T7 is the same data already live in the shared dev database from this session's earlier live-demo verification (connector `914f6b20-66cc-4bac-ab47-6ccf69383409`, Teideal customer `26a005fe-c266-4471-a699-6b702bb19715`, Stripe line period 2026-08-15 to 2026-09-15, $500.00/$500.00/Match) -- reuse it directly rather than re-seeding, and add the second ($500 expected / $400 billed) dev-only customer alongside it for the same tenant/period.
- **Contract screen's mutations**: only wire up actions whose backend route already exists today (`POST /grants`, `POST /grants/:id/consume`, `POST /grants/:id/void`, `PATCH /grants/:id/amend`, `POST /customers/:id/subscription`, `POST /customers/:id/subscription/schedule-migration`, `POST /customers/:id/subscription/grandfather`) -- do not add a new grant/plan mutation shape not already present in `routes/grants.ts` or `routes/planVersions.ts`.
- **Stripe screen's connect/sync/map actions** map 1:1 to existing routes: `GET /stripe/connect/authorize-url`, `POST /stripe/connect/callback`, `GET /connectors/sync-health`, `POST /connectors/stripe/register`, `POST /connectors/:id/sync`, `POST /verify/map-billed-lines`, `DELETE /connectors/:id`. `POST /stripe/connections/:id/request-write-access` and `POST /stripe/connections/:id/disconnect` are never called from this UI -- the former because this UI never needs write scope (no invoice-item creation lives here), the latter per the header note's hard rule.

## Architecture and design

**Service**: entirely `services/ts-console` -- a new `@fastify/static` plugin registration in `server.ts` serving `public/` under `/console`, plus the three new minimal session-gated routes described above. No new service, no new database table (this screen's data all already exists behind the routes catalogued in the research pass).

**Frontend**: `services/ts-console/public/` -- `index.html` (shell: nav + a single content mount point), `app.js` (router, `apiFetch`, session management, role-based nav rendering from `GET /auth/me`), one JS module per screen (`screens/report.js`, `screens/customer.js`, `screens/contract.js`, `screens/stripe.js`, `screens/periodClose.js`, `screens/auditLog.js`, `screens/users.js`, `screens/apiKeys.js`, `screens/home.js`), `styles.css`. Each screen module exports a `render(container, ctx)` function; `app.js`'s router calls the right one based on the current nav selection and the role matrix above.

**Auth flow**: login screen (not a module under `screens/`, rendered before the authenticated shell exists) posts to `/auth/login`, branches on `status` exactly as documented in Scoping notes, posts to `/auth/mfa/verify` or `/auth/mfa/enroll/confirm` as needed, stores the resulting `session_token`, then calls `GET /auth/me` and renders the authenticated shell with nav filtered to that role.

## File layout

- `services/ts-console/src/routes/auth.ts` (extend -- add `GET /auth/me`)
- `services/ts-console/src/routes/customers.ts` (extend -- extract shared data-fetch, add session-gated `GET /customers`, `GET /customers/:id`)
- `services/ts-console/src/routes/planVersions.ts` or a new small file (add read-only `GET /customers/:id/subscription`)
- `services/ts-console/src/server.ts` (register `@fastify/static`, mount `/console`, redirect `/` → `/console/`)
- `services/ts-console/public/index.html`, `app.js`, `styles.css`, `screens/*.js` (new)
- `tests/console-ui/` (new, mirroring every other `tests/<area>/` package's own `package.json`/`db.ts`/`env.ts`/`http.ts`/`session.ts` convention)
- `docs/api/auth.md`, `docs/api/customers.md` or equivalent (extend for the three new routes, following this project's existing `## METHOD /path [service]` heading convention from `docs/api/check-coverage.ts` -- no query string in the heading)

## Definition of done

- [ ] Every acceptance criterion above is satisfied by working code, served from `services/ts-console`, no second backend, no build step.
- [ ] Every cataloged test (T1-T16) has a real automated test that passes under jsdom against the live local stack.
- [ ] `tsc --noEmit` clean in `services/ts-console` and the new `tests/console-ui`.
- [ ] No code path in the shipped UI calls `POST /stripe/connections/:id/disconnect`, creates a Stripe invoice item, or performs client-side arithmetic on any monetary field -- confirmed by T12/T6, not just asserted.
- [ ] The live demo fixture (AC11) renders exactly as specified without re-seeding it.
- [ ] PR description maps each test ID to the file/line that covers it, and states plainly which of the four header-note gaps (cookie assumption, zero existing frontend, three new routes, Users-screen role tension) it resolved and how.
