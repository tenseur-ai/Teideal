# TEID-47: Balance threshold alerts

| | |
|---|---|
| Epic | TEID-6 (E06 -- Enable operator visibility, alerts, and customer-facing usage) |
| Phase | E06 -- Enable operator visibility, alerts, and customer-facing usage |
| Priority | High |
| Points | 5 |
| Release | mvp |
| Order | 66 (within this phase) |
| Depends on | `grants` (TEID-17, including commit-sourced grants from TEID-19), `plans` (TEID-16), `notify.ts`'s `sendEmail` stub (TEID-91), `notifications_sent` table (TEID-91) -- all already built |

## Story (verbatim from the live board)

> As a billing operator, I want alerts when a customer's balance or commit reaches levels I choose, so that we can warn customers and start sales conversations before they run out.
>
> *Context*

## Acceptance criteria (verbatim from the live board)

1. Thresholds can be set per plan or customer; the default is 50%, 80% and 100% of balance or commit used.
2. Each threshold alert fires only once per period per customer.
3. Alerts can go to operators by email and Slack, and optionally to the end customer by email.
4. The alert says the customer, threshold reached, remaining balance and projected run-out date.

## Cataloged tests (verbatim from the live board)

| ID | Type | AC | Title |
|---|---|---|---|
| TEID-47-T1 | Functional | 1 | Set a custom threshold set of 60%, 85% and 95% for customer acct_6006, overriding the plan default of 50/80/100%, and confirm alerts fire at the customer-specific percentages rather than the defaults. |
| TEID-47-T2 | Functional | 2 | Drive customer acct_6006's commit usage to cross the 80% threshold twice within the same billing period via a reprocessing spike, and confirm only one 80% alert is sent for that period. |
| TEID-47-T3 | Functional | 3 | Configure alert delivery to operators via email and Slack channel #billing-alerts, plus customer-facing email, then cross the 50% threshold and confirm all three channels receive the alert. |
| TEID-47-T4 | Functional | 4 | Trigger a threshold alert for customer acct_6006 at 80% of a $10,000 commit and confirm the alert content includes the customer name, threshold reached of 80%, remaining balance of $2,000 and a projected run-out date. |
| TEID-47-T5 | Non-functional | 2 | Run the threshold-evaluation job across 10,000 customers simultaneously crossing various thresholds in the same billing cycle and confirm each customer receives exactly the correct alerts with no duplicates or drops. |
| TEID-47-T6 | Non-functional | 3 | Simulate a failed Slack delivery for a threshold alert and confirm the failure is logged and surfaced to operators rather than silently disappearing. |
| TEID-47-T7 | Adversarial | 2 | Rapidly fluctuate customer acct_6006's balance above and below the 80% line 20 times within one hour via grants and usage reversals, and confirm the once-per-period rule still holds with only one alert firing. |
| TEID-47-T8 | Adversarial | 1 | Submit a threshold value of 0% and a value of 150% via the API and confirm both are rejected as invalid rather than creating a threshold that fires immediately or never. |

## Scoping notes for this point in the build sequence

**"Balance or commit used" is scoped to grants, not the ledger's `customer_balance_cache`.** Teideal's entitlement model has no separate customer-facing "account balance" outside grants/commits (TEID-17/18/19) -- the ledger's `customer_balance_cache` (TEID-33) is a receivable/financial-reconciliation figure, a different concept serving a different audience (finance reconciliation, not "how much of this customer's credit is left"). This story evaluates `grants.remaining_amount / grants.amount` per active grant (and, for a commit-sourced grant per TEID-19, the commit's own drawdown), which is the number a billing operator actually means by "80% of a $10,000 commit used." This keeps the evaluation job self-contained inside `services/ts-console`, which already owns the `grants` table -- no cross-service call needed for the hot evaluation path, unlike TEID-45's timeline.

**No real Slack integration exists yet.** TEID-91's `sendEmail` is an explicit stub (writes to `notifications_sent`, never calls a real provider) and there is no existing Slack sender anywhere. This story must build a real outbound Slack webhook sender (Slack's incoming-webhook HTTP contract: `POST` a JSON `{text: ...}` payload to a tenant-configured webhook URL) -- this is genuinely new, not a gap to substitute around. Pattern it directly on `services/go-usage/internal/ledger/ledger.go`'s `postAlert` (env/config-provided URL, JSON POST, bounded timeout, treats non-2xx as a failure) since that is the one existing generic-webhook precedent in this codebase, even though it lives in the other service -- do not import cross-service code, just mirror the same shape in TypeScript.

**Operator email reuses the existing `sendEmail` stub as-is** (same "logged, not actually delivered" behavior TEID-91 already established and that the rest of this codebase already accepts as the current state of email delivery) -- this story does not need to (and should not) integrate a real email provider; that is out of scope.

Everything else this story references already exists: `grants`, `plans`, `customers`.

## Architecture and design

**New migration** `db/migrations/20260929130000_balance_alerts.sql`:

```sql
-- AC1: threshold config, scoped to a plan (applies to every customer on that
-- plan) or a specific customer (overrides the plan's config for that
-- customer only). scope_id is a plan_id or customer_id depending on scope.
CREATE TABLE billing_alert_thresholds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('plan', 'customer')),
  scope_id UUID NOT NULL,
  threshold_pcts SMALLINT[] NOT NULL DEFAULT '{50,80,100}',
  operator_emails TEXT[] NOT NULL DEFAULT '{}',
  slack_webhook_url TEXT,
  notify_customer BOOLEAN NOT NULL DEFAULT false,
  customer_email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, scope, scope_id)
);
-- AC1 adversarial (T8): every element of threshold_pcts must be in (0, 100].
ALTER TABLE billing_alert_thresholds ADD CONSTRAINT billing_alert_thresholds_pcts_valid
  CHECK (NOT EXISTS (SELECT 1 FROM unnest(threshold_pcts) p WHERE p <= 0 OR p > 100));
-- standard tenant RLS, matching every other tenant-scoped table in this repo
ALTER TABLE billing_alert_thresholds ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_alert_thresholds FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_billing_alert_thresholds ON billing_alert_thresholds
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON billing_alert_thresholds TO teideal_app;

-- AC2: dedup ledger. The unique constraint is the actual enforcement
-- mechanism for "once per period per customer per threshold" -- do not
-- rely on application-level "check then insert" logic alone (TOCTOU under
-- T5's 10,000-concurrent-customer load); let a 23505 on this constraint be
-- the signal that a threshold was already alerted this period, exactly
-- like this codebase's existing idempotency-key pattern.
CREATE TABLE billing_alert_sent (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL,
  grant_id UUID NOT NULL,
  threshold_pct SMALLINT NOT NULL,
  period_start DATE NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivery_status JSONB NOT NULL, -- {"operator_email": "sent"|"failed", "slack": "sent"|"failed", "customer_email": "sent"|"failed"|"skipped"}
  UNIQUE (tenant_id, grant_id, threshold_pct, period_start)
);
ALTER TABLE billing_alert_sent ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_alert_sent FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_billing_alert_sent ON billing_alert_sent
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT ON billing_alert_sent TO teideal_app;
CREATE INDEX billing_alert_sent_grant_period_idx ON billing_alert_sent (tenant_id, grant_id, period_start);
```

**Evaluation job:** a new periodic background worker in `services/ts-console` (this service does not yet have a background-worker precedent the way go-usage does with TEID-32/33's tickers -- follow the same overall shape: a configurable interval, `DISABLE_BACKGROUND_WORKERS` env-gated for tests, guarded by `NODE_ENV !== "test"` the way `exportTimer` already is in `server.ts`). Each tick: for every tenant, for every active grant with `remaining_amount / amount` past a threshold, resolve the effective threshold config (customer-scoped override if one exists for that `customer_id`, else the plan-scoped config for that grant's plan, else the hardcoded default `{50,80,100}` with no delivery channels configured -- an alert with nowhere to send is still recorded in `billing_alert_sent` for dedup correctness but delivers nothing, and this should be logged, not silently dropped), and for each crossed-and-not-yet-sent threshold (checked via `billing_alert_sent`, keyed by `period_start` = the grant's current billing period start), attempt delivery to every configured channel, then `INSERT` into `billing_alert_sent` inside the same transaction as the delivery attempt's outcome recording -- **insert the dedup row unconditionally on the FIRST delivery attempt (even a fully failed one), relying on the unique constraint to prevent a second attempt this period**, since T6 requires a failed Slack send to be surfaced, not silently retried into a duplicate operator email storm.

**Remaining balance and run-out projection (AC4):** `remaining_amount` is already on `grants`. Projected run-out date: linear extrapolation from the grant's own recent consumption rate (e.g. average daily draw over the trailing 7 days of `grant_ledger_entries`, or the whole grant lifetime if younger than 7 days) -- `remaining_amount / avg_daily_draw` days from now. This is a simple estimate, not a forecasting model; document it as such in the API response (`projected_run_out_date`, `projection_method: "linear_7d_average"`) so a future story can replace the method without changing the contract.

**Threshold config API** (new): `GET/PUT /billing-alert-thresholds?scope=plan&scope_id=` and `GET/PUT /billing-alert-thresholds?scope=customer&scope_id=` in `services/ts-console/src/routes/`, role-gated `["Owner", "Billing Admin"]` (matching TEID-43's existing role set for billing configuration), validating `threshold_pcts` server-side (T8) before any write.

## Implementation guidance per test

### TEID-47-T1
Set a customer-scoped `billing_alert_thresholds` row for `acct_6006` with `{60,85,95}`, leaving the plan's own default `{50,80,100}` unchanged. Drive the customer's grant usage to exactly 85% remaining-consumed. Run one evaluation tick. Assert a `billing_alert_sent` row exists for threshold 85 and none exists for 80 (which the customer-scoped override does not include).

### TEID-47-T2
Drive a commit-sourced grant to 80%+ used, run an evaluation tick, assert one `billing_alert_sent` row for threshold 80. Reprocess/re-run the evaluation tick again without advancing the period (simulating the "reprocessing spike" named in the test). Assert still exactly one `billing_alert_sent` row for that `(grant_id, 80, period_start)` -- the second tick's insert attempt must hit the unique constraint and be handled as a no-op, not a 500.

### TEID-47-T3
Configure a `billing_alert_thresholds` row with `operator_emails`, a `slack_webhook_url` pointed at a fake Slack endpoint (a new lightweight test double, `tests/balance-alerts/fake-slack.ts`, recording received payloads -- pattern it on `tests/stripe-connect/fake-stripe.ts`'s shape), `notify_customer: true`, and a `customer_email`. Cross the 50% threshold. Assert the fake Slack endpoint received exactly one POST with the expected payload shape, and assert `billing_alert_sent.delivery_status` records `"sent"` for all three channels (operator email verified via the existing `notifications_sent` table, matching TEID-91's own test convention).

### TEID-47-T4
Set up a $10,000 commit-sourced grant at exactly $2,000 remaining (80% used). Trigger evaluation. Assert the alert payload delivered to at least one channel (check the fake Slack payload or the `notifications_sent` row's stored content) contains the customer's name, `threshold_pct: 80`, `remaining_amount: 2000`, and a non-null `projected_run_out_date`.

### TEID-47-T5
Seed 10,000 customers with grants distributed across multiple threshold-crossing states (some past 50%, some past 80%, some past 100%, some not past any). Run one evaluation tick. Assert the total count of `billing_alert_sent` rows exactly equals the number of genuinely-crossed thresholds across all 10,000 customers (compute the expected count independently in the test from the seeded data, don't just assert "some rows exist"), with zero duplicates (a `GROUP BY (grant_id, threshold_pct, period_start) HAVING COUNT(*) > 1` query returns no rows) and zero drops.

### TEID-47-T6
Point `slack_webhook_url` at an endpoint that returns 500 (the fake Slack double supports a failure-simulation mode). Cross a threshold. Assert `billing_alert_sent.delivery_status.slack === "failed"`, assert the failure is queryable by operators (a `GET /billing-alert-thresholds/delivery-failures` endpoint, or surfaced via the existing audit-log/alert-webhook pattern -- reuse `postAlert`'s own on-call-webhook convention from go-usage if a cross-service alert channel is simpler than a new endpoint, since "surfaced to operators" doesn't require a bespoke UI for this story), and assert the operator-email and customer-email channels (if configured) still attempted delivery independently -- one channel's failure must not abort the others.

### TEID-47-T7
Simulate 20 rapid crossings above and below the 80% line within one hour (grant draws followed by reversing adjustments/voids back above the line, repeated). Run evaluation after each fluctuation. Assert exactly one `billing_alert_sent` row for threshold 80 across the whole sequence, proving the dedup key is period-scoped (not "re-arms" on dropping back below the threshold).

### TEID-47-T8
Call the threshold-config `PUT` endpoint with `threshold_pcts: [0]` and separately with `threshold_pcts: [150]`. Assert both are rejected with a 400-level validation error and that no `billing_alert_thresholds` row is written or updated as a result of either call (verify via a direct DB read, not just the HTTP response code).

## File layout

- `db/migrations/20260929130000_balance_alerts.sql` -- new tables.
- `services/ts-console/src/routes/billingAlerts.ts` (new) -- threshold config CRUD.
- `services/ts-console/src/lib/balanceAlertWorker.ts` (new) -- the periodic evaluation job.
- `services/ts-console/src/lib/notify.ts` (extend) -- add `sendSlackAlert`, patterned on go-usage's `postAlert`.
- `services/ts-console/src/server.ts` -- register the route and start the worker (env-gated, matching `exportTimer`'s existing convention).
- Tests: new directory `tests/balance-alerts/` implementing all 8 cataloged tests, plus `fake-slack.ts` test double.

## Definition of done

- [ ] Every acceptance criterion above is satisfied by working code.
- [ ] Every cataloged test has a real automated test that passes -- functional, non-functional, and adversarial alike.
- [ ] `tsc --noEmit` is clean in `services/ts-console`.
- [ ] `tests/cross-tenant`, `tests/console-auth`, `tests/audit-log`, `tests/api-keys`, `tests/rbac`, `tests/grants`, `tests/plans`, `tests/commits` all still pass unchanged.
- [ ] The suite passes against a database rebuilt from scratch using only committed migration/seed scripts.
- [ ] PR description includes a checklist mapping each test ID to the file/line that covers it.
