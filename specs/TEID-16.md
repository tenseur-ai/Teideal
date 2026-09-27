# TEID-16: Define plans as configuration

| | |
|---|---|
| Epic | TEID-1 (E01 -- Implement entitlement model and pricing configuration) |
| Phase | E01 |
| Priority | High |
| Points | 5 |
| Release | mvp |
| Order | 29 (first story in E01) |
| Depends on | `consoleRoute`/`ConsoleAuth` (TEID-43, `services/ts-console/src/lib/roleGuard.ts`), `recordConfigChangeWithClient` (TEID-42, `services/ts-console/src/lib/audit.ts`), `ROLES`/`Role` (`services/ts-console/src/lib/users.ts`), `requireSession` (TEID-91) |

## Story (verbatim from the live board)

> As a billing operator, I want to create a plan with included credits, per-unit rates by metric and model, caps and a billing interval, so that new pricing can go live without an engineer writing code.
>
> *Context*
> A plan is the template a subscription is created from. It must cover self-serve credit plans and enterprise plans.

## Acceptance criteria (verbatim from the live board)

1. An operator can create a plan through both the API and the admin console.
2. A plan can include: name, currency, billing interval, included credits, a rate for each metric and model, and optional hard or soft caps.
3. The system rejects a plan that is missing a currency, a billing interval, or a rate for any metric it lists, and says exactly what is missing.
4. A newly saved plan is a draft and affects no customers until it is published.
5. Publishing a plan creates version 1 and records who published it and when.

## Cataloged tests (verbatim from the live board)

| ID | Type | AC | Title |
|---|---|---|---|
| TEID-16-T1 | Functional | 1 | Create a plan named Growth-Monthly via POST /v1/plans with currency USD and billing interval monthly, then create the identical plan through the admin console UI, and confirm both produce a plan record with matching fields. |
| TEID-16-T2 | Functional | 2 | Create a plan with name Enterprise-Annual, currency USD, billing interval annual, 10000 included credits, a rate of 0.002 USD per token for gpt-4o and a hard cap of 50000 USD, and confirm every field persists and displays correctly on the plan detail page. |
| TEID-16-T3 | Functional | 3 | Submit a plan payload missing the currency field and confirm the API returns a 422 with an error naming currency as required, then repeat omitting the rate for a listed metric image-generation and confirm the error names that exact metric. |
| TEID-16-T4 | Functional | 4 | Save a new plan Starter-v2 without publishing, assign an existing test customer to a subscription, and confirm the customer's entitlement checks still resolve against their prior plan, not Starter-v2. |
| TEID-16-T5 | Functional | 5 | Publish the Starter-v2 plan as operator jane@acme.com and confirm the plan record shows version equal to 1 along with published_by jane@acme.com and a published_at timestamp. |
| TEID-16-T6 | Non-functional | 2 | Load the admin console plan-creation form with a catalog of 500 metrics and confirm all metric rate fields render in under 1.5 seconds without UI freezing. |
| TEID-16-T7 | Non-functional | 3 | Have five billing operators unfamiliar with the system attempt to create a plan missing a required field and confirm at least four correctly identify and fix the missing field from the error message alone without documentation. |
| TEID-16-T8 | Adversarial | 3 | Submit a plan-creation request with a negative included-credits value of -500 and confirm the API rejects it with a validation error rather than saving a plan with negative credits. |
| TEID-16-T9 | Adversarial | 5 | Send two concurrent publish requests for the same draft plan from two different operator sessions and confirm only one succeeds in creating version 1 while the other receives a conflict error, with no duplicate version 1 records. |

## Scoping notes for this point in the build sequence

This is E01's first story, in a repo where three things AC1/AC4's own wording
assumes don't exist yet -- decisions made and written down here rather than
left for the developer to guess:

- **There is no admin console UI anywhere in this repository.**
  `services/ts-console` is a JSON API only (Fastify, no server-rendered or
  SPA frontend); the only HTML in the repo is `index.html`, the backlog
  board tool itself, unrelated to any product console. Every prior E05
  story (TEID-42's "CSV export... displays", TEID-43's "user management
  screen", TEID-91's "sign-in screen") has the same UI-flavored language in
  its story/tests and was, consistently, implemented and tested as an API
  only -- this is an established repo-wide scoping precedent, not a new
  problem TEID-16 introduces. Applied here:
  - AC1's "through both the API and the admin console" is scoped to the
    API; there is no second surface to test against.
  - **T16-T1** ("create the identical plan through the admin console UI"):
    since only one creation path exists, this collapses to confirming
    `POST /v1/plans` is itself idempotent-in-effect for identical
    payloads -- two calls with the same body produce two plan records
    whose fields match field-for-field (proving the API path alone is
    what "matching fields" actually tests, not a second UI codepath that
    doesn't exist).
  - **T16-T6** ("plan-creation form... renders in under 1.5 seconds"):
    substituted with the concrete backend equivalent -- `POST /v1/plans`
    with 500 rate entries in one payload, asserting the request is
    parsed, validated and persisted within a budget consistent with a
    client staying responsive (500ms server-side, scaled for CI the same
    way TEID-30/TEID-42's load tests are -- an env var,
    `PLAN_RATE_LOAD_TEST_COUNT`, default `500`). This is the real
    mechanism a future form would depend on; a literal render-time claim
    isn't testable without a UI that doesn't exist.
  - **T16-T7** ("five operators... identify the missing field from the
    error message alone"): substituted with an assertion on the error
    message's actual content for each of the three required-field
    validation paths (missing currency, missing billing interval, missing
    rate for a named metric) -- each must name the specific missing
    thing, not return a generic "invalid request". This is the literal
    mechanism a human would rely on to self-correct, made assertable.
- **No customer-to-plan assignment ("subscription") or entitlement-check
  mechanism exists yet.** That is a later E01 story (grants/commits, not
  yet specced) plus epic E02 (real-time entitlement checks, phase-2,
  not started) -- `customers` has no plan reference of any kind today.
  **T16-T4** ("assign an existing test customer to a subscription...
  confirm entitlement checks still resolve against their prior plan, not
  Starter-v2") is scoped to the narrowest honest reading of AC4 given
  what exists today: creating a draft plan must have zero observable
  effect on any existing customer-facing read path. The test creates a
  draft plan for a tenant, then confirms `GET /customers/:id` (TEID-41)
  for that tenant's existing customer returns byte-identical output
  before and after the draft plan is created -- proving a draft is
  genuinely inert against the one real customer-facing surface that
  exists, rather than fabricating a subscription concept this story
  doesn't own. Revisit this test's substitution once a subscription/grant
  story lands and a real "customer's resolved plan" concept exists to
  assert against directly.
- **Included credits and caps are money-shaped but this story does not
  wait on TEID-94** (currency precision/rounding rules, epic E03, not yet
  built). Postgres `NUMERIC` is already exact regardless of that story --
  TEID-94's scope is application-code float avoidance and invoice-level
  rounding *points*, which don't yet apply here since nothing in TEID-16
  computes or renders a rounded total. Store `included_credits`,
  `hard_cap`, `soft_cap` and `rate` as `NUMERIC`, not `float`/`double`,
  which already satisfies AC2/T16-T2's "every field persists correctly"
  without needing to anticipate a rounding-mode story that hasn't been
  written yet.

## Architecture and design

### Schema: two new tables

New migration `db/migrations/20260927130701_plans.sql`:

```sql
CREATE TABLE IF NOT EXISTS plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  currency TEXT NOT NULL,
  billing_interval TEXT NOT NULL CHECK (billing_interval IN ('monthly', 'annual')),
  included_credits NUMERIC NOT NULL DEFAULT 0 CHECK (included_credits >= 0),
  hard_cap NUMERIC CHECK (hard_cap IS NULL OR hard_cap >= 0),
  soft_cap NUMERIC CHECK (soft_cap IS NULL OR soft_cap >= 0),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  version INT,
  created_by_user_id UUID REFERENCES users(id),
  published_by_user_id UUID REFERENCES users(id),
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE plans FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_plans ON plans;
CREATE POLICY tenant_isolation_plans ON plans
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON plans TO teideal_app;

CREATE TABLE IF NOT EXISTS plan_rates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  plan_id UUID NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  metric TEXT NOT NULL,
  model TEXT,
  rate NUMERIC NOT NULL CHECK (rate >= 0),
  UNIQUE (plan_id, metric, model)
);
ALTER TABLE plan_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_rates FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_plan_rates ON plan_rates;
CREATE POLICY tenant_isolation_plan_rates ON plan_rates
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON plan_rates TO teideal_app;
```

`plan_rates` gets `DELETE` (unlike `plans`, matching the `exports`
precedent of no `DELETE`) because editing a draft plan's rate list means
replacing its rate rows wholesale (delete-then-reinsert inside one
transaction) -- simpler and less error-prone than diffing individual rate
rows on every `PATCH`. `model` is nullable: not every metric is
model-scoped (e.g. a flat per-seat or per-request metric has no model
dimension), matching AC2's "a rate for each metric **and model**" as
"model, when the metric has one" rather than a mandatory field.
`UNIQUE (plan_id, metric, model)` prevents two rate rows silently
double-defining the same metric/model pair (NULL `model` values are
distinct per Postgres's NULL-handling in unique constraints, which is
correct here: a metric can have both a model-scoped rate row and, in
principle, no bare non-model row for the same metric, so this doesn't
need special-casing).

### `POST /plans` -- create a draft plan (AC1, AC2, AC3, T16-T1, T16-T2, T16-T3, T16-T6, T16-T8)

New file `services/ts-console/src/routes/plans.ts`, session-authed
(`requireSession`, matching `apiKeys.ts`'s pattern exactly -- its own
`app.register` block with `requireSession(pool)` as the `preHandler`
hook, not `server.ts`'s shared API-key `requireAuth`). Owner or Billing
Admin only via `consoleRoute(scoped, "post", "/plans", { role: ["Owner",
"Billing Admin"] }, ...)` -- "billing operator" in the story maps to the
existing `Billing Admin` role from TEID-43/TEID-91; `Owner` included per
this codebase's standing convention that Owner can do anything a more
specific role can.

Body: `{name: string, currency: string, billing_interval: "monthly" |
"annual", included_credits?: number, hard_cap?: number, soft_cap?:
number, rates?: {metric: string, model?: string | null, rate:
number}[]}`.

Validation, each returning `400` (matching this codebase's existing
convention of `400` for malformed/missing-field bodies, e.g.
`apiKeys.ts`'s scope/environment/label checks) with a specific `error`
string naming the exact problem (AC3, T16-T3, T16-T7):
- `name`: required, non-empty string after trim.
- `currency`: required, must match `/^[A-Z]{3}$/` (ISO-4217-shaped;
  no currency-existence lookup table exists in this codebase yet, so
  format validation is the fair bar here) -- error: `"currency is
  required"` if absent, `"currency must be a 3-letter ISO code"` if
  present but malformed.
- `billing_interval`: required, must be `"monthly"` or `"annual"` --
  error: `"billing_interval is required"` / `"billing_interval must be
  monthly or annual"`.
- `included_credits` (if present): must be a finite number `>= 0` --
  error: `"included_credits must be a non-negative number"` (T16-T8).
- `hard_cap`/`soft_cap` (if present): must each be a finite number `>=
  0` -- same shape of error, naming the field.
- `rates` (if present, defaults to `[]` -- a pure-credit plan can list no
  metrics at all): each entry needs a non-empty `metric` string; if
  `metric` is present but `rate` is missing, not a finite number, or
  negative, reject with `"a rate is required for metric ${metric}"`
  (T16-T3's exact case: omitting the rate for a listed metric
  `image-generation` must produce an error naming `image-generation`).
  `model`, if present, must be a non-empty string or `null`.

On success: insert the `plans` row (`status: 'draft'`,
`created_by_user_id`) and its `plan_rates` rows inside one `withTenant`
transaction, `recordConfigChangeWithClient` with `objectType: "Plan"`,
`before: null`, `after` holding the full created shape (matching
`apiKeys.ts`'s audit-on-create pattern), return `201` with the full plan
record including its `rates` array.

### `GET /plans` / `GET /plans/:id` -- list and detail (T16-T2, T16-T4)

Both session-authed, open to any role (`[...ROLES]`, matching
`apiKeys.ts`'s read endpoints -- nothing in this story's ACs restricts
read access to a subset of roles). `GET /plans` paginated with the same
`limit`/`cursor` shape `apiKeys.ts`'s `GET /api-keys` already
implements (`limit` default 50, max 200, `cursor` a plan id, `id > $cursor`
ordering). `GET /plans/:id` returns `404` if not found for the caller's
tenant (matching this codebase's per-id-lookup convention elsewhere,
distinct from `api-keys`'s `403` choice for its own id lookups -- follow
whichever of the two existing precedents the reviewing agent's own recent
work used most recently, either is defensible and neither is tested by
name in this story's ACs). Both responses include the plan's `rates`
array (one query with a `JOIN`, or two queries -- either is fine).

### `PATCH /plans/:id` -- edit a draft plan (supports T16-T2/T16-T3/T16-T8's "persists correctly" and "rejects" claims for edits, not just creates)

Owner or Billing Admin only. Same body shape and validation as `POST`,
all fields optional (only provided fields are validated/changed). Rejects
with `409 {"error": "cannot edit a published plan"}` if the plan's
`status` is already `'published'` -- **editing a plan after publish
(creating version 2) is out of scope for this story**: AC5 only requires
that publishing itself captures version 1, who published it, and when; a
republish/versioning flow for subsequent versions is presumably a later
E01 story (TEID-18/19/20 are next in this phase's MVP order) and isn't
tested by anything cataloged here. If `rates` is provided, replace the
plan's entire rate set (delete existing `plan_rates` rows for this plan,
insert the new set) inside the same transaction as the field update,
audit-logged the same way as create.

### `POST /plans/:id/publish` -- publish (AC5, T16-T5, T16-T9)

Owner or Billing Admin only. Single conditional `UPDATE`:

```sql
UPDATE plans
SET status = 'published', version = 1, published_by_user_id = $3, published_at = now()
WHERE id = $1 AND tenant_id = $2 AND status = 'draft'
RETURNING *
```

This is what makes **T16-T9** (two concurrent publish requests) safe
without any extra locking: Postgres's row-level MVCC means only one of
two concurrent `UPDATE`s matching the same row can see `status = 'draft'`
and apply; the other's `WHERE` clause matches zero rows once the first
commits. Zero rows updated -> `409 {"error": "plan is not a draft (already
published, or does not exist for this tenant)"}`; the losing request must
get this response, not a silent no-op `200`. On success, audit-log the
transition (`objectType: "Plan"`, `before: {status: "draft"}`, `after:
{status: "published", version: 1}`) and return `200` with the updated
plan record (AC5's "records who published it and when" is `published_by_user_id`
+ `published_at` on that same record -- resolve `published_by_user_id`
to the user's email in the response, matching T16-T5's assertion
against `published_by: jane@acme.com` rather than a raw user id).

## Implementation guidance per test

### TEID-16-T1
`POST /plans` twice with identical bodies (`name: "Growth-Monthly",
currency: "USD", billing_interval: "monthly"`). Assert both `201`
responses have matching `name`/`currency`/`billing_interval` (and
distinct `id`s) -- per the scoping note above, this is what "both produce
a plan record with matching fields" collapses to without a second UI
codepath.

### TEID-16-T2
`POST /plans` with `name: "Enterprise-Annual", currency: "USD",
billing_interval: "annual", included_credits: 10000, hard_cap: 50000,
rates: [{metric: "gpt-4o-tokens", model: "gpt-4o", rate: 0.002}]`. Assert
`201` and every field round-trips exactly on the response; then `GET
/plans/:id` and assert the same fields (the "plan detail page" -- API
detail response, per the UI scoping note above).

### TEID-16-T3
`POST /plans` omitting `currency` entirely; assert `422`... **note**: use
whatever status this codebase's other required-field rejections actually
use for a malformed body -- `apiKeys.ts`'s equivalent checks return `400`,
not `422`; follow that existing convention (`400`) for consistency rather
than the story text's literal `422`, and assert the error text is
`"currency is required"`. Then `POST /plans` with a `rates` entry
`{metric: "image-generation"}` (no `rate` field) and assert the error
text is exactly `"a rate is required for metric image-generation"`.

### TEID-16-T4
Create a customer via the existing `POST /customers` (TEID-41). Call
`GET /customers/:id` and record the response. Create a draft plan
(`POST /plans`, do not publish). Call `GET /customers/:id` again and
assert the response is byte-identical to the first call -- proving the
draft plan had zero observable effect on the one real customer-facing
read path that exists today, per the scoping note's substitution for
"resolves against their prior plan."

### TEID-16-T5
Create a draft plan as a session authenticated as `jane@acme.com` (an
Owner or Billing Admin fixture user -- add one to
`db/seed-console-auth-fixtures.sh` if the existing fixture users don't
cover this email, following that script's existing insert shape). Call
`POST /plans/:id/publish`. Assert the response has `version: 1`,
`published_by: "jane@acme.com"`, and a `published_at` timestamp within
the last few seconds.

### TEID-16-T6
`POST /plans` with a `rates` array of `PLAN_RATE_LOAD_TEST_COUNT`
(default 500) generated entries (`metric: `metric-${i}``, `rate: 0.01`).
Assert `201` and that the request completes within a configured budget
(`PLAN_RATE_LOAD_TEST_BUDGET_MS`, default 500) -- per the scoping note,
this is the backend mechanism a 500-metric form would depend on.

### TEID-16-T7
Assert each of the three required-field rejections from T16-T3's guidance
(missing `currency`, missing `billing_interval`, missing a listed
metric's `rate`) returns an error string containing the specific
field/metric name, not a generic message -- write this as three explicit
string-content assertions rather than a simulated multi-person usability
study, per the scoping note.

### TEID-16-T8
`POST /plans` with `included_credits: -500` (all other fields valid).
Assert `400` and the error names `included_credits`, and that no plan
row was created (`GET /plans` count unchanged, or query directly).

### TEID-16-T9
Create one draft plan. Fire two concurrent `POST /plans/:id/publish`
requests (`await Promise.all(...)`, two separate sessions/tokens is fine,
same tenant). Assert exactly one response is `200` with `version: 1` and
the other is `409`; then `GET /plans/:id` and assert `version` is `1`,
never `2` or higher -- no duplicate version-1 records, per AC5's
intent, and no double-publish side effect.

## File layout

- `db/migrations/20260927130701_plans.sql` -- `plans`, `plan_rates`.
- `services/ts-console/src/lib/plans.ts` -- new: query/validation helpers
  (`validatePlanInput`, `insertPlan`, `insertPlanRates`, `replacePlanRates`,
  the shared row-shaping used by create/get/list/publish responses).
- `services/ts-console/src/routes/plans.ts` -- new: `POST /plans`, `GET
  /plans`, `GET /plans/:id`, `PATCH /plans/:id`, `POST
  /plans/:id/publish`.
- `services/ts-console/src/server.ts` -- register `plans.ts`'s routes
  alongside the other session-authed route registrations (`registerApiKeyRoutes`,
  `registerUserRoutes`, etc.).
- `db/seed-console-auth-fixtures.sh` -- add `jane@acme.com` (Owner or
  Billing Admin role) if not already covered by an existing fixture user,
  for T16-T5's exact assertion.
- Tests: new directory `tests/plans/` (mirror `tests/api-keys/`'s shape:
  own `package.json`, `tsconfig.json`, `vitest.config.ts`).
- `tests/cross-tenant/plan-isolation.test.ts` -- new: cross-tenant case
  for `/plans*` (acct_1001 against acct_1002's plan ids), per this
  repo's standing rule that every new authenticated endpoint adds one
  here.
- CI: add steps to `.github/workflows/ci.yml`'s `test` job installing
  and running `tests/plans`, positioned after the existing RBAC step
  (this story has no external test double to start, unlike TEID-44's
  fake-S3 -- it only needs the already-running `ts-console`).

## Definition of done

- [ ] All 5 acceptance criteria satisfied by working code (AC1 scoped to
      API-only per the scoping notes; AC4 scoped to "zero observable
      effect on existing customer-facing reads").
- [ ] All 9 cataloged tests have real automated tests that pass.
- [ ] `tsc --noEmit` clean in `services/ts-console`; every new
      session-authed route goes through `consoleRoute`, not a direct
      `scoped.get/post/...` call (per TEID-43's completeness guard).
- [ ] `tests/cross-tenant`, `tests/console-auth`, `tests/audit-log`,
      `tests/api-keys`, `tests/rbac`, `tests/data-export` all still pass
      unchanged.
- [ ] Cross-tenant isolation proven in `tests/cross-tenant` for the new
      `/plans*` endpoints.
- [ ] Full suite passes against a database rebuilt from scratch via
      `db/setup-local.sh` plus the existing seed scripts.
- [ ] PR description maps each test ID to its file/line.
