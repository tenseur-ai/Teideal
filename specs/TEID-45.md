# TEID-45: Customer timeline

| | |
|---|---|
| Epic | TEID-6 (E06 -- Enable operator visibility, alerts, and customer-facing usage) |
| Phase | E06 -- Enable operator visibility, alerts, and customer-facing usage |
| Priority | Highest |
| Points | 8 |
| Release | mvp |
| Order | 65 (within this phase) |
| Depends on | `grants`/`grant_ledger_entries` (TEID-17), `usage_events` (TEID-30), `reservations` (TEID-32), `usage_adjustments` (TEID-34), `ledger_transactions`/`ledger_lines` (TEID-32), `audit_log` (TEID-41/42) -- all already built, read-only for this story |

## Story (verbatim from the live board)

> As a support agent, I want a single timeline of everything that affected a customer's balance, so that I can answer billing questions in minutes without engineering.
>
> *Context*

## Acceptance criteria (verbatim from the live board)

1. The timeline shows grants, usage (grouped by hour, expandable to single events), reservations, adjustments, invoices and configuration changes.
2. It can be filtered by date range, metric, model, team and API key.
3. From any invoice line, the user can drill down to the ledger entries and usage events behind it.
4. The timeline loads in under 3 seconds for a customer with 1 million events in the current period.

## Cataloged tests (verbatim from the live board)

| ID | Type | AC | Title |
|---|---|---|---|
| TEID-45-T1 | Functional | 1 | Open the timeline for customer acct_4004 and confirm it displays grants, hourly-grouped usage buckets expandable to individual events, reservations, adjustments, invoices and configuration changes in one chronological view. |
| TEID-45-T2 | Functional | 2 | Apply filters for date range Aug 1 to Aug 15, metric=tokens, model=gpt-4-class, team=platform-eng and API key=key_789, and confirm the timeline updates to show only entries matching all five filters. |
| TEID-45-T3 | Functional | 3 | From an invoice line showing $342.18 of overage charges, click drill-down and confirm it navigates to the exact ledger entries and usage events that sum to that $342.18 figure. |
| TEID-45-T4 | Functional | 4 | Load the timeline for a customer with exactly 1,000,000 usage events in the current billing period and confirm the page fully renders in under 3 seconds. |
| TEID-45-T5 | Non-functional | 4 | Load the timeline for a customer with 5 million events, 5x the documented benchmark, and confirm the page degrades gracefully via pagination or lazy loading rather than timing out or crashing the browser tab. |
| TEID-45-T6 | Non-functional | 1 | Confirm hourly usage buckets in the timeline are collapsed by default and expand to individual events with a single click, without a full page reload. |
| TEID-45-T7 | Adversarial | 2 | Apply a 5-year date range filter with no other narrowing filters for a high-volume customer and confirm the system paginates the results or returns a clear too-broad-query message rather than hanging or crashing. |
| TEID-45-T8 | Adversarial | 3 | While authenticated as a user scoped only to customer acct_5005, attempt to drill down into an invoice line belonging to customer acct_4004 and confirm the request is denied rather than leaking acct_4004's ledger entries. |

## Scoping notes for this point in the build sequence

**Invoices do not exist yet anywhere in this codebase** -- no `invoices` table, no invoice-generation code in either service (confirmed by direct search). AC1's "invoices" and AC3/T3/T8's "invoice line" have no real thing to point at yet. The substitution: **`ledger_transactions` stands in for an invoice line.** A `ledger_transactions` row is already the real, immutable, append-only unit that a future invoice line will summarize or reference one-to-one (per TEID-32's design, each transaction already carries `customer_id`, `usage_event_id`, `grant_id`, `reservation_id`, `pricing_rule_id`, and a `description`), so a timeline entry of type `ledger_transaction` is a fair, literal test of the same drill-down mechanism AC3 describes -- clicking it must resolve to the exact `ledger_lines` rows and the originating `usage_event`, which is precisely what T3 asserts, just with "ledger transaction" as the visible label instead of "invoice line." When invoicing is built, it calls this same drill-down endpoint from an invoice line UI instead of a ledger-transaction-list UI; the underlying `GET /ledger/transactions/{id}/detail` contract (see below) does not change. The `desc` field's AC1 wording ("invoices") is satisfied by rendering ledger transactions in the timeline under a clearly-labeled "Charges" category; do not fabricate a placeholder `invoices` table or fake invoice rows.

Everything else this story references already exists: `grants`/`grant_ledger_entries` (TEID-17), `usage_events` (TEID-30/34), `reservations` (TEID-32's placeholder table), `usage_adjustments` (TEID-34), `audit_log` (TEID-41/42).

## Architecture and design

**No new tables or migrations.** This story is purely a read-side aggregation over six existing tables, three owned by `services/go-usage` and three owned by `services/ts-console`, per ADR 0001's per-table ownership rule (the non-owning service never queries another service's table directly).

**Data sources and their owning service:**

| Timeline entry type | Table | Owning service | Timestamp column | Customer link |
|---|---|---|---|---|
| Grant issued/expired/voided | `grant_ledger_entries` (join `grants`) | ts-console | `occurred_at` | via `grant_id -> grants.customer_id` |
| Usage (hourly bucket) | `usage_events` | go-usage | `occurred_at` | `customer_id` |
| Reservation | `reservations` | go-usage | `created_at` | `customer_id` |
| Adjustment (TEID-34) | `usage_adjustments` | go-usage | `occurred_at` (for ordering; `reviewed_at` shown separately when set) | `customer_id` |
| Charge ("invoice line" stand-in) | `ledger_transactions` | go-usage | `created_at` | `customer_id` |
| Configuration change | `audit_log` | ts-console | `occurred_at` | `customer_id` (nullable -- only customer-scoped audit rows appear on this timeline) |

**New go-usage read endpoints** (go-usage owns 4 of the 6 source tables and must expose list-by-customer reads that don't exist yet):
- `GET /customers/{id}/reservations?since=&until=&limit=&cursor=` -- no reservation-listing endpoint exists today (TEID-32 only wrote rows, never listed them). Auth: `read-only` scope, same pattern as `GetUsage`.
- `GET /customers/{id}/ledger-transactions?since=&until=&limit=&cursor=` -- no listing-by-customer endpoint exists today (only `GET /ledger/transactions/{id}` by single ID). Auth: `read-only`.
- `GET /ledger/transactions/{id}/detail` -- returns the transaction's own `ledger_lines` plus the originating `usage_event` (join via `usage_event_id`), for AC3/T3's drill-down. Auth: `read-only`, and must independently re-verify the transaction's `customer_id` resolves under the caller's own tenant RLS before returning anything (this is exactly what T8 tests -- do not rely on RLS alone without an explicit ownership check in the handler, matching the existing pattern in `usage.go`'s batch endpoint where `customer_id not visible to caller's tenant` is checked explicitly).
- `GET /usage?customer_id=&since=&until=&limit=&cursor=` and `GET /adjustments?customer_id=&since=&until=` already exist (TEID-30, TEID-34) -- extend `GetAdjustments` with an optional `customer_id` query filter if it does not already accept one (check `adjustments.go` before assuming).

All four above: cursor-based pagination (`limit` capped at e.g. 500 server-side, `cursor` opaque, matching the pattern anywhere else in the codebase already paginating -- check `api-keys.go`'s `GET /api-keys` pagination for the existing convention and reuse it, not a new scheme).

**New ts-console aggregation endpoint** (the one the console UI actually calls):
- `GET /customers/{id}/timeline?since=&until=&metric=&model=&team=&api_key_id=&cursor=&limit=` in `services/ts-console/src/routes/` (new `timeline.ts`). Auth: session (`requireSession`) or API key, `read-only`, same role set as other customer-read endpoints.
- Handler: resolves the caller's own `grant_ledger_entries`/`audit_log` rows directly (own tables), and in parallel fans out to go-usage's four endpoints above over HTTP (service-to-service call, matching how `stripeConnect.ts` already calls out to `fake-stripe`/real Stripe -- an outbound HTTP call from ts-console is an established pattern, not a new one). Merges all six sources into one array sorted by timestamp descending, applies the requested filters (`metric`/`model` apply to `usage_events` and any ledger transaction whose originating usage event matches; `team`/`api_key_id` apply wherever the source row carries that attribution -- check `usage_events`/`ledger_transactions` for existing `team`/`api_key_id`-equivalent columns before assuming; if absent on a given table, that filter simply does not narrow that entry type, and the spec's own AC2 wording ("filtered by... team and API key") should be read as filtering what those attributes exist on, not requiring every table to carry every column).
- **Hourly usage bucketing (AC1, T6) happens at this ts-console aggregation layer**, not by adding a new column anywhere: group `usage_events` rows returned by go-usage into one timeline entry per `(customer_id, event_type, date_trunc('hour', occurred_at))` with a count and total quantity, expandable client-side to the individual events already present in the same response payload (no second round-trip needed for the common case; for a bucket whose event count exceeds what fits in one page, T6 must instead lazy-load: return `GET /customers/{id}/timeline/usage-bucket?hour=&event_type=` on expand).
- Response shape: `{ entries: [{ type: 'grant'|'usage_bucket'|'reservation'|'adjustment'|'charge'|'config_change', occurred_at, ...type-specific fields }], next_cursor: string|null }`.

**Performance (AC4/T4, T5):** the 1M-event, <3s target is dominated by `usage_events`' hourly bucketing query -- this must be a single `GROUP BY date_trunc('hour', occurred_at), event_type` aggregate query in go-usage (pushed down to Postgres, not fetched row-by-row and bucketed in application code), reusing the existing `(tenant_id, customer_id, occurred_at)`-shaped index this table already has from prior stories' query patterns (check `usage_events`' actual indexes in the init migration before assuming one exists in the right column order; add one via a new migration only if genuinely missing). T5's 5M-event graceful-degradation case is the same aggregate query at 5x scale plus this endpoint's own `limit`/`cursor` pagination already handling the non-bucketed entry types -- no separate code path needed if the aggregate query and pagination are both real from the start.

## Implementation guidance per test

### TEID-45-T1
Seed a customer with at least one row in all six source categories (a grant issue, 3+ hours of usage events spanning 2+ hours so bucketing is visible, a reservation, one pending adjustment, one ledger transaction, one audit_log config change). Call the aggregation endpoint with no filters. Assert the response contains at least one entry of each of the six `type` values, and that usage entries are `usage_bucket` (not raw individual events) by default.

### TEID-45-T2
Seed events spanning a wider date range and multiple `metric`/`model`/`team`/`api_key_id` values than the filter targets. Call the endpoint with all five filters set. Assert every returned entry matches all five constraints, and assert at least one seeded-but-non-matching event is *not* present (a filter that returns everything unfiltered is a false pass).

### TEID-45-T3
Seed a `ledger_transactions` row with known `ledger_lines` summing to a specific dollar amount and a known originating `usage_event`. Call `GET /ledger/transactions/{id}/detail` (via the ts-console endpoint or directly against go-usage, whichever the timeline UI's drill-down actually calls -- the test should call what the UI calls, not just the underlying data). Assert the returned `ledger_lines` sum to the seeded amount and the returned `usage_event` matches the seeded one exactly.

### TEID-45-T4
Seed exactly 1,000,000 `usage_events` rows for one customer in the current period (set-based bulk SQL insert, not one-by-one through the API, matching TEID-32-T6/TEID-33-T5's own established precedent for million-row-scale fixtures) across a realistic spread of hours. Time the aggregation endpoint call end-to-end (network + query + response serialization) and assert it completes in under 3,000ms. Assert the response actually contains bucketed usage entries (not an empty/degenerate result cheating the timing).

### TEID-45-T5
Same fixture approach at 5,000,000 rows. Assert the endpoint does not hang or error, and that the response is either paginated (a `next_cursor` is present and non-null with a bounded `entries` length) or the usage buckets are still returned as pre-aggregated hourly rows rather than attempting to enumerate all 5M individual events in one response.

### TEID-45-T6
This is a UI-behavior test as much as an API one. At minimum, assert at the API layer that a `usage_bucket` entry in the default response never itself contains the full per-event array inline when the bucket is large (forcing a real expand call), and that the lazy-load "expand" endpoint returns only that bucket's individual events. If a console UI test harness exists by this point, additionally assert the collapsed-by-default/expand-without-reload behavior client-side; otherwise this test may assert the API-level contract alone with a note in the test file explaining the UI-level assertion is deferred to a future console E2E suite.

### TEID-45-T7
Call the endpoint with `since` 5 years in the past and no other filters, against a customer with a genuinely large event count. Assert the response is either correctly paginated (bounded `entries` length, valid `next_cursor`) or returns a clear 400-level "range too broad, narrow your filters" error -- assert it does NOT time out (bound the test's own wait with a generous but finite timeout, e.g. 10s, and fail the test explicitly on timeout rather than letting vitest's own default timeout obscure what happened) and does NOT 500.

### TEID-45-T8
Seed two customers under two different tenants (or two customers where the caller is scoped to only one, per this codebase's existing customer-scoping conventions -- check how `acct_5005`-style customer-level API key scoping is expressed elsewhere, e.g. `api_keys.customer_id`, TEID-22/60's precedent) with a ledger transaction belonging to the customer the caller is NOT scoped to. Call `GET /ledger/transactions/{id}/detail` for the foreign transaction's ID. Assert `403` or `404` (matching this codebase's established cross-tenant-denial convention) and assert no `ledger_lines`/`usage_event` data appears anywhere in the response body.

## File layout

- `services/go-usage/internal/api/reservations.go` (new) -- `GET /customers/{id}/reservations`.
- `services/go-usage/internal/api/ledger.go` (extend) -- `GET /customers/{id}/ledger-transactions`, `GET /ledger/transactions/{id}/detail`.
- `services/go-usage/internal/api/adjustments.go` (extend) -- add `customer_id` filter to `GetAdjustments` if not already present.
- `services/go-usage/cmd/server/main.go` -- register the new/extended routes.
- `services/ts-console/src/routes/timeline.ts` (new) -- the aggregation endpoint, hourly bucketing, cross-service fan-out.
- `services/ts-console/src/lib/goUsageClient.ts` (new, or extend an existing internal HTTP client if one already exists -- check `lib/` before assuming none does) -- the outbound calls to go-usage's four read endpoints.
- `services/ts-console/src/server.ts` -- register the new route.
- Tests: new directory `tests/customer-timeline/` implementing all 8 cataloged tests.

## Definition of done

- [ ] Every acceptance criterion above is satisfied by working code (AC1/AC3's "invoices" satisfied via the documented `ledger_transactions` substitution, not literal invoice rows).
- [ ] Every cataloged test has a real automated test that passes -- functional, non-functional, and adversarial alike.
- [ ] `go vet`/`tsc --noEmit` (whichever applies) is clean in both `services/go-usage` and `services/ts-console`.
- [ ] `tests/cross-tenant`, `tests/console-auth`, `tests/audit-log`, `tests/api-keys`, `tests/rbac`, `tests/grants`, `tests/usage-ingestion`, `tests/ledger` all still pass unchanged.
- [ ] The suite passes against a database rebuilt from scratch using only committed migration/seed scripts.
- [ ] PR description includes a checklist mapping each test ID to the file/line that covers it.
