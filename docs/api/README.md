# Teideal API reference

This reference describes the routes registered by `ts-console` (default
`http://127.0.0.1:8081`) and `go-usage` (default
`http://127.0.0.1:8082`). Paths use the parameter syntax of their service:
Fastify uses `:id`; Go's `ServeMux` uses `{id}`.

Every route entry states its authentication, request, response, errors, and a
worked request. Values such as `$SESSION_TOKEN`, `$API_KEY`, `$CUSTOMER_ID`,
and `$PLAN_ID` are placeholders created by the quick-start. Response examples
are illustrative and are not commands.

Fenced blocks tagged `runnable` are a contract: `tests/docs/run-examples.test.ts`
extracts and executes every one against the live test stack. An untagged block
is still a worked example, but may need route-specific state (for example, an
existing grant or Stripe connection) and is therefore not independently
executable. Authors must never add `runnable` to a partial or pseudocode block.

## Resource groups

- [Authentication, users, API keys, and settings](auth.md)
- [Customers, hierarchy, consumption, and overrides](customers.md)
- [Plans and subscriptions](plans.md)
- [Grants and entitlement state](grants.md)
- [Usage ingestion and adjustments](usage.md)
- [Money, billing periods, and rounding](billing.md)
- [Ledger, reservations, and integrity](ledger.md)
- [Stripe Connect and processor lookup](stripe-connect.md)
- [Sandboxes](sandbox.md)
- [Balance threshold alerts](billing-alerts.md)
- [Billing webhooks](webhooks.md)
- [Customer timeline](timeline.md)
- [Exports, audit, support, health, and security operations](operations.md)
- [Errors and reason values](errors.md)

Run `npx tsx docs/api/check-coverage.ts` from the repository root to compare
these entries with both live route registries. CI runs the same check through
`tests/docs/coverage.test.ts`.

