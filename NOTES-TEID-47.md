# TEID-47 implementation notes

## PostgreSQL rejects the spec's inline CHECK subquery

`billing_alert_thresholds_pcts_valid` is specified as:

```sql
CHECK (NOT EXISTS (SELECT 1 FROM unnest(threshold_pcts) p WHERE p <= 0 OR p > 100))
```

PostgreSQL refuses subqueries inside `CHECK` (`cannot use subquery in check constraint`). The migration keeps that exact predicate in an immutable SQL function, `billing_alert_threshold_pcts_valid`, and the named constraint calls the function. Invalid elements still fail with `23514`, which TEID-47-T8 asserts both through the API and with a direct insert.

`db/setup-local.sh` re-applies every migration file, so the statements also use `IF NOT EXISTS` / `DROP POLICY IF EXISTS` / `DROP CONSTRAINT IF EXISTS`, matching the other migrations. The table shape, unique keys, RLS policies, grants, and index match the spec.

## A grant has no plan_id

Customer-scoped config wins when a `billing_alert_thresholds` row exists for that `customer_id`. Otherwise the plan-scoped row is the customer's `customer_plan_subscriptions.current_plan_id` (TEID-23). With no subscription, evaluation uses the hardcoded default `{50, 80, 100}` and no delivery channels. The dedup row is still inserted, and the tick logs `balance_alerts_recorded_without_delivery_channels`.

## "Balance used" and the run-out projection

Usage percent is `(grants.amount - grants.remaining_amount) / grants.amount`. A threshold is crossed at `>=`. That is the grants figure from the scoping notes, not `customer_balance_cache`.

`grant_ledger_entries` does not record consumption. `POST /grants/:id/consume` only decreases `remaining_amount`. Customer consumption writes `usage_consumption_lines`. The projection therefore sums those lines over the trailing 7 days, or since `grants.start_date` when the grant is younger than 7 days, and also sums negative `grant_ledger_entries` amounts other than `expired`, `voided`, and `carried_over` (closures, not draws). If that sum is zero and the grant is younger than 7 days, the rate is `(amount - remaining_amount)` over the grant's age, which is the trace `POST /grants/:id/consume` leaves. The response field stays `projection_method: "linear_7d_average"`.

`period_start` is the customer's billing-period start date (`customer_billing_config`, default UTC and anchor day 1), stored as a `DATE`. The boundary math follows go-usage's anchor rules locally so the tick does not call the other service.

## Dedup insert, Slack failure, and email

`billing_alert_sent` is insert-only (`GRANT SELECT, INSERT`). The first attempt delivers every configured channel, then inserts one row with the outcome, including a fully failed Slack send. A later tick still issues the insert; `23505` is caught and treated as a no-op, and delivery is not repeated. Channels are independent: a Slack 500 does not skip operator or customer email.

Unconfigured channels are stored as `"skipped"`. The spec's status comment only listed `"skipped"` for `customer_email`; operator email and Slack need the same value when the default config has nowhere to send.

Operator email calls the existing `sendEmail` stub, which keeps its own transaction. Slack is `sendSlackAlert` in `notify.ts`: JSON POST, `Content-Type: application/json`, 10 second timeout, non-2xx throws. The webhook URL is the row's `slack_webhook_url` (per-tenant config) rather than go-usage's process-wide `ONCALL_ALERT_WEBHOOK_URL`.

A failed channel is written to stderr as `balance_alert_delivery_failed` and returned by `GET /billing-alert-thresholds/delivery-failures` for Owner and Billing Admin. That is the endpoint the spec names. The ledger on-call webhook stays with go-usage.

There is no grant-balance reversal API. TEID-47-T7 moves `remaining_amount` down and back up, which is the balance the evaluator reads, and runs a tick after each move.
