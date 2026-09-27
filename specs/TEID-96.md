# TEID-96: Billing periods, time zones and boundary rules

| | |
|---|---|
| Epic | TEID-3 (E03 -- Build usage ingestion and exactly-once ledger) |
| Phase | E03 |
| Priority | Highest |
| Points | 5 |
| Release | mvp |
| Order | 15 (within E03, directly after TEID-95) |
| Depends on | `usage_events` (TEID-41/TEID-30/TEID-95), `internal/money` (TEID-94/TEID-95, for the `pgtype.Numeric` conversion pattern precedent), `Pool.WithTenant` |

## Story (verbatim from the live board)

> As a finance lead, I want billing periods to start and end at the right moment in each customer's time zone, so that events near midnight, month end or clock changes are always assigned to the correct period.

## Acceptance criteria (verbatim from the live board)

1. All event times are stored in UTC.
2. Each customer has a billing time zone (default UTC), and period boundaries are calculated in that zone, including daylight-saving changes.
3. An event timestamped exactly on a boundary belongs to the new period; this rule is documented.
4. Month-end anchors are handled consistently (a subscription anchored on the 31st bills on the last day of shorter months).
5. Automated tests cover daylight-saving transition days, month ends, year ends and 29 February.

## Cataloged tests (verbatim from the live board)

| ID | Type | AC | Title |
|---|---|---|---|
| TEID-96-T1 | Functional | 1 | Submit an event with local timestamp 2026-03-10T02:30:00-05:00 and confirm it is persisted internally as 2026-03-10T07:30:00Z. |
| TEID-96-T2 | Functional | 2 | Set a customer's billing timezone to America/New_York and confirm their monthly period boundary on the November DST fall-back date rolls over at local midnight, 05:00 UTC that day, rather than the 04:00 UTC offset used on adjacent days. |
| TEID-96-T3 | Functional | 3 | Submit an event timestamped at exactly the period boundary instant in the customer's zone, 2026-04-01T00:00:00 local, and confirm it is allocated to the new period rather than the closing one. |
| TEID-96-T4 | Functional | 4 | Create a subscription anchored on the 31st and confirm its February period closes on the last day of February and its April period closes on April 30, rather than rolling into the following month. |
| TEID-96-T5 | Functional | 5 | Run the automated boundary regression suite covering the March DST spring-forward gap, the November DST fall-back overlap, the December 31 to January 1 year-end, and February 29 in a leap year, and confirm every case assigns events to the documented period. |
| TEID-96-T6 | Non-functional | 5 | Confirm the DST and month-end boundary regression suite runs in CI with individually named test cases per scenario, so a failure identifies the exact broken boundary case rather than a single generic failure. |
| TEID-96-T7 | Adversarial | 2 | Submit an event timestamped during the repeated local hour created by a fall-back DST transition and confirm the system deterministically assigns it to one specific period per the documented tie-break rule, rather than raising an ambiguous-time error or varying across retries. |
| TEID-96-T8 | Adversarial | 3 | Submit the same event twice with UTC timestamps 1 millisecond apart, straddling a period boundary due to clock skew between two ingestion nodes, and confirm both attempts, sharing an idempotency key, resolve to the same period assignment. |

## Scoping notes for this point in the build sequence

- **`usage_events` has no client-supplied event timestamp today.**
  `occurred_at` is always `DEFAULT now()` (server ingestion time) --
  TEID-30 never needed a caller-supplied event time. AC1/T96-T1
  explicitly require submitting an event with a specific local timestamp
  and confirming its stored UTC value, which is impossible without one.
  This story adds an **optional** `occurred_at` field to `POST /usage`
  (defaulting to `now()` if omitted, preserving TEID-30's existing
  behavior and its existing tests unchanged) -- a real, small addition to
  already-shipped ingestion code, following the same "extend, don't
  break the existing contract" approach TEID-95 already used for
  `quantity`.
- **"Each customer has a billing time zone" (AC2) would naturally live on
  the `customers` table, but that table is owned by `services/ts-console`
  (ADR 0001), a different phase.** Following the same discipline TEID-44,
  TEID-17, and TEID-18 already applied (never write into another
  developer agent's owned tables), this story adds a new table,
  `customer_billing_config`, owned entirely by `services/go-usage` --
  the natural home given this epic (E03) owns period/ledger
  computation. It references `customer_id` the same way `usage_events`
  already does (a cross-service foreign key to a table this service
  doesn't own the writes to, which is already this codebase's normal,
  established pattern -- see `usage_events.customer_id`), so no ADR
  exception is needed, just a new table.
- **No real "period" or invoice object exists yet** (TEID-33, not
  started -- the same gap TEID-94 and TEID-95 already navigated). This
  story establishes the period-*boundary computation* primitive TEID-33
  will need, exposed through a synthetic testing endpoint, `POST
  /period/resolve`, the same role `POST /money/preview` (TEID-94) and
  `POST /money/price` (TEID-95) already play for their own primitives --
  not a real billing-period product feature yet.
- **Windows has no system IANA time zone database**, unlike Linux/macOS,
  and this repo's local dev/CI verification runs on Windows for local
  sessions (Linux for GitHub Actions). Go's standard library resolves
  named zones (e.g. `America/New_York`) via the OS's tzdata by default,
  which is silently absent on a bare Windows install -- `time.LoadLocation`
  would fail or (worse) succeed inconsistently depending on what
  happens to be installed. This story **must** blank-import
  `time/tzdata` (`import _ "time/tzdata"` in `cmd/server/main.go`) to
  embed the full IANA database directly into the compiled binary,
  making DST/zone handling identical and correct on every platform this
  runs on, not just Linux CI. Flagging this explicitly because it is
  exactly the kind of platform-only-manifests-locally gap this session
  has hit before (the `--add-dir`/npm-cache/Docker findings) and a
  spec that didn't call it out would likely cost a full debugging cycle
  discovering it.

## Architecture and design

### Schema: one new table

New migration `db/migrations/20260927153353_customer_billing_config.sql`:

```sql
-- TEID-96: per-customer billing time zone and month-end anchor day.
-- Owned by go-usage (period/ledger computation is this epic's domain),
-- not services/ts-console, even though it references customers(id) --
-- the same cross-service FK pattern usage_events.customer_id already
-- established.

CREATE TABLE IF NOT EXISTS customer_billing_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL UNIQUE REFERENCES customers(id) ON DELETE CASCADE,
  billing_timezone TEXT NOT NULL DEFAULT 'UTC',
  billing_anchor_day INT NOT NULL DEFAULT 1 CHECK (billing_anchor_day BETWEEN 1 AND 31),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE customer_billing_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_billing_config FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_customer_billing_config ON customer_billing_config;
CREATE POLICY tenant_isolation_customer_billing_config ON customer_billing_config
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON customer_billing_config TO teideal_app;
```

A customer with no row defaults to `UTC`/anchor-day-1 -- a row only needs
to exist once someone changes it (same pattern as TEID-94's
`rounding_configs`).

### `internal/period` package (AC2, AC3, AC4)

New package `services/go-usage/internal/period/period.go`:

```go
// Boundaries returns the [start, end) UTC instants of the billing period
// containing `instant`, for a customer billing in `tz` with a monthly
// anchor on `anchorDay`. end is exclusive: an event timestamped exactly
// at `end` belongs to the *next* period (AC3).
func Boundaries(tz string, anchorDay int, instant time.Time) (start, end time.Time, err error)
```

Implementation approach:
- `time.LoadLocation(tz)` (relies on the blank `time/tzdata` import from
  the scoping notes above to always succeed for any valid IANA name,
  regardless of host OS).
- Convert `instant` into that location to find the current local
  calendar month, then construct the period's local start as
  `anchorDay` of the appropriate month **clamped to that month's actual
  last day** (AC4 -- e.g. anchor 31 in February becomes local midnight
  on the 28th, or the 29th in a leap year; April becomes the 30th).
  Go's `time.Date` constructor already normalizes an out-of-range day by
  rolling into the next month, which is the *wrong* behavior for AC4 and
  must be explicitly guarded against (compute the target month's actual
  day count first, e.g. via `time.Date(year, month+1, 0, ...)`'s
  well-known "day 0 of next month" idiom, and take `min(anchorDay,
  thatCount)` before constructing the date -- do not rely on
  `time.Date`'s own rollover).
- `end` is the same construction one calendar month later, independently
  clamped the same way (so a period starting on a clamped day doesn't
  compound drift across months).
- Convert both local instants back to UTC via `.In(time.UTC)` (or
  equivalently, `time.Time` carries its own instant regardless of the
  `Location` used to construct it -- constructing with a local
  `*time.Location` and reading it back is what makes Go's own DST-aware
  offset calculation do the correct UTC conversion automatically for
  AC2's "including daylight-saving changes", with no manual offset
  arithmetic required).
- **Fall-back ambiguity (T96-T7):** Go's `time.Date` in a location with
  an ambiguous repeated local hour resolves deterministically already
  (it picks one specific UTC instant per its documented pre-transition
  vs. post-transition rule, consistently across calls -- verify and
  document *which* instant this repo's Go version resolves to as "the
  tie-break rule" AC3 requires be documented, rather than asserting a
  specific rule this spec hasn't verified against). Since AC1 requires
  every ingested event to carry an explicit UTC offset (never a naive
  local string, per the existing convention this repo already uses for
  `as_of` in TEID-17/TEID-18), an *event's own* timestamp is never
  ambiguous -- only the period-boundary computation constructs a local
  time from a bare `(year, month, day)` triple, so `Boundaries` is the
  only place this matters, and it only needs to be internally consistent
  (the same input always produces the same output), not free of the
  general DST-ambiguity question.

### `POST /usage`: optional `occurred_at` (AC1, T96-T1, T96-T8)

Modify `services/go-usage/internal/api/usage.go`: add `OccurredAt
*time.Time` (pointer, so omission is distinguishable from an explicit
value) to `postUsageRequest` and the batch item shape, parsed from an
RFC3339 string that **must** include an explicit UTC offset or `Z` --
reject a bare, offset-less local timestamp the same way TEID-17/TEID-18
already reject an offset-less `as_of` (`400`, naming the requirement).
If omitted, behavior is unchanged from today (`DEFAULT now()`). If
present, insert it explicitly instead of relying on the column default.
This is the only change to the ingestion path -- `quantity`'s
`decimal.Decimal` handling (TEID-95) is untouched and unaffected.

### `GET`/`PUT /customers/:id/billing-config` (AC2)

New file `services/go-usage/internal/api/billing_config.go`, same
conventions as TEID-94/TEID-95's admin-gated endpoints. `GET` returns
the stored row or the `UTC`/anchor-1 default if none exists. `PUT`
validates `billing_timezone` via `time.LoadLocation` (reject an unknown
zone name with `400` naming the problem) and `billing_anchor_day`
(`1..31`), upserts.

### `POST /period/resolve` -- the synthetic testing surface (AC3, AC4, AC5, T96-T2..T7)

New file `services/go-usage/internal/api/period.go`. Body:
`{customer_id, instant}` (`instant` an RFC3339 string with explicit
offset). Resolves the customer's `customer_billing_config` (or the
UTC/anchor-1 default), calls `period.Boundaries`, and returns
`{period_start, period_end}` as UTC ISO strings, plus
`in_new_period_as_of_boundary: true` implicitly demonstrated by
`period_start`/`period_end` being exclusive/inclusive per AC3's rule
(document this explicitly in the response or in a code comment -- either
is fine, but state the rule once, unambiguously, matching AC3's own
"this rule is documented" requirement).

## Implementation guidance per test

### TEID-96-T1
`POST /usage` with `occurred_at: "2026-03-10T02:30:00-05:00"` and
otherwise-valid fields. Assert `201` and that the response's
`occurred_at` (and a subsequent `GET /usage`) shows
`2026-03-10T07:30:00Z` (or the equivalent parsed UTC instant) -- proving
the offset conversion is exact.

### TEID-96-T2
`PUT /customers/:id/billing-config` with `billing_timezone:
"America/New_York"`, default anchor day. `POST /period/resolve` with an
`instant` on the November DST fall-back date for that year. Assert the
returned period boundary for that month is `05:00Z` (America/New_York
is UTC-4 before fall-back and UTC-5 after; the whole month prior to this
one starts at the UTC-4 offset, `04:00Z`) -- confirming the boundary
calculation picks up the *current* DST offset for the month being
computed rather than a cached or adjacent-month offset.

### TEID-96-T3
`POST /period/resolve` for a customer in a named zone with a period
boundary of local midnight April 1st. Assert an `instant` of exactly
that local midnight (converted to its correct UTC equivalent) resolves
into the **new** period (i.e. is `>= period_start` of the period
starting then), not the closing one -- the concrete form of AC3's "an
event timestamped exactly on a boundary belongs to the new period."

### TEID-96-T4
`PUT /customers/:id/billing-config` with `billing_anchor_day: 31`.
`POST /period/resolve` with an `instant` in February of a non-leap year
and assert the resolved period's `period_end` is March 1st 00:00 local
(i.e. the period closes on February 28th, the month's actual last day).
Repeat for April and assert `period_end` is May 1st 00:00 local (closes
April 30th). Repeat for a leap-year February and assert closure on the
29th.

### TEID-96-T5
A dedicated test file (or `describe` block) with one **individually
named** test case per scenario (T96-T6 requires this explicitly): the
March DST spring-forward gap (a local time that never occurs, e.g.
2:30am on the spring-forward date -- confirm `Boundaries` doesn't panic
or error, and document/assert whichever of "treat as before" or "treat
as after" this implementation's Go runtime resolves it to), the November
fall-back overlap (T96-T2's scenario, re-asserted as its own named
case here for the regression suite), the December 31 -> January 1
year boundary, and February 29 in a leap year (T96-T4's scenario,
similarly re-asserted as its own case). Every one of these cases must
assign its probe instant to the period this spec's own documented rule
predicts.

### TEID-96-T6
Confirm (by inspecting the test file structure, or simply by construction
if T96-T5 is implemented as separate `it(...)` blocks rather than one
loop with assertions inside) that each of the four named scenarios above
is its own named test, not one parameterized/looped assertion that would
report a single generic failure -- CI must be able to point at exactly
which boundary case broke.

### TEID-96-T7
Identify the specific UTC instant that falls within the repeated local
hour on a fall-back date in a zone this repo's Go runtime resolves
deterministically for `time.Date` (verify which instant that actually is
during implementation, per the architecture note above, rather than
assuming one). `POST /period/resolve` with that exact instant twice in
separate calls and assert both return the identical `period_start`/
`period_end` -- proving determinism across calls, not just within one.

### TEID-96-T8
`POST /usage` twice with the same `idempotency_key`, `occurred_at`
values 1 millisecond apart straddling a period boundary (e.g.
`...T23:59:59.9995Z` and `...T00:00:00.0005Z` the next day), and
otherwise-identical fields. Assert the second request resolves as the
existing "duplicate" outcome per TEID-30's already-shipped idempotency
behavior (the `idempotency_key` unique constraint on `usage_events`
already guarantees only the *first* submission's `occurred_at` is ever
stored) -- confirm via `GET /usage` that only one event exists, and that
calling `POST /period/resolve` with that one stored `occurred_at`
resolves to a single, unambiguous period. This test needs no new
idempotency logic; it's confirming TEID-30's existing mechanism
composes correctly with the new optional `occurred_at` field.

## File layout

- `services/go-usage/internal/period/period.go` -- new: `Boundaries`.
- `services/go-usage/internal/api/usage.go` -- modified: optional
  `occurred_at` on `postUsageRequest` and the batch item shape.
- `services/go-usage/internal/api/billing_config.go` -- new: `GET`/`PUT
  /customers/:id/billing-config`.
- `services/go-usage/internal/api/period.go` -- new: `POST
  /period/resolve`.
- `services/go-usage/cmd/server/main.go` -- register the two new route
  files; add `import _ "time/tzdata"`.
- `db/migrations/20260927153353_customer_billing_config.sql` -- new.
- Tests: new directory `tests/billing-periods/` (mirror
  `tests/currency-rounding/`'s exact shape), implementing all 8
  cataloged tests, with T96-T5 as individually named cases per the
  spec's own T96-T6 requirement.
- `.github/workflows/ci.yml` -- add install/run steps for
  `tests/billing-periods`, positioned after the existing
  `tests/large-quantities` step.

## Definition of done

- [ ] All 5 acceptance criteria satisfied by working code (AC2's
      "customer" config lives in a new go-usage-owned table per the
      scoping notes, not on `customers` itself).
- [ ] All 8 cataloged tests have real automated tests that pass, with
      T96-T5's four scenarios as individually named cases.
- [ ] `go build ./...` clean in `services/go-usage`; `import _
      "time/tzdata"` present in `cmd/server/main.go`.
- [ ] `tests/usage-ingestion`, `tests/currency-rounding`,
      `tests/large-quantities` all still pass unchanged -- this story
      adds an optional field to `usage.go`; it must not change behavior
      for callers that omit it.
- [ ] Full suite passes against a database rebuilt from scratch via
      `db/setup-local.sh` plus the existing seed scripts.
- [ ] PR description maps each test ID to its file/line.
