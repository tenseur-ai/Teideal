# TEID-68 implementation notes

- The specification places the story in `services/ts-console`, but the required
  quantity comparison and ledger evidence live in go-usage-owned tables and ADR
  0001 forbids ts-console from querying them directly. The conservative
  resolution was to enrich the existing `/period-close/ledger-summary` response
  already called by `generatePeriodCloseSummary`. The discrepancy report still
  calls `generatePeriodCloseSummary` directly and adds no second cross-service
  request or independent expected-value calculator.
- The API contract does not define multi-currency aggregation. This v0 preserves
  each billed line's currency in evidence and performs the specified numeric
  period-total comparison without FX conversion. Operators should run it only
  where a tenant/customer period is denominated consistently; currency-aware
  grouping or conversion needs a separate product decision.
- A refund connector record has no `customer_id` in the connector contract. The
  AC7 existence check resolves it through its referenced payment record. If that
  payment record is absent, there is no reliable customer attribution and the
  refund cannot flag a customer-period.
- A null-bound invoice line cannot identify its service period on its own. The
  coverage check associates it with a period using, in order of available
  evidence, its remaining bound, the parent invoice bounds, or the invoice issue
  timestamp. This is intentionally a coarse coverage warning, never a leakage
  classification.
- Quantity tolerance is the spec-permitted hardcoded default of 1% (`0.01`) for
  this first cut. It is returned by the report and documented in the API; no
  settings table was added.
