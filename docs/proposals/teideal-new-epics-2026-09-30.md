# Teideal — additional epics, stories, acceptance criteria, and tests

Proposed 2026-09-30. These epics sit **beside** the existing E01–E19 backlog. They do not replace ledger, isolation, or Stripe read-first work already done.

Workforce assumption: delivery is **entirely agents** (no human engineers). Stories therefore require machine-checkable acceptance, fixture-driven tests, contract suites that gate merge, and explicit human-only steps limited to legal signature, design-partner conversation, and production-credential approval.

Status of every story below: **To Do**.

Suggested board order after current E11 (Verify) and before E12: **E20, E21, E22, E24, E23**.

---

## E20 — Verify discrepancy engine

Release: verify-v1
Independently re-rate usage against captured contract terms and match the result to invoices from the connected biller. This is the product finance forwards. No writes to the biller.

### TEID-V1  Re-rate and match a billing period

Priority: Highest   Points: 13   Release: verify-v1   Order: 200
Status: To Do

As a finance lead, I want Teideal to compute what we should have billed and compare it to what the connected biller billed, so that I can see leakage without a spreadsheet.

Acceptance Criteria
1. For a mapped customer and a closed period, Teideal produces expected invoice lines from the independent usage feed plus captured terms (plans, grants, commits, overrides, rounding rules).
2. Expected lines are produced by the **same rating kernel** used for live billing (E01/E03). Verify must not implement a second calculator.
3. Each biller line is matched to expected lines by metric, period window, and currency — not by invoice description string alone.
4. Every unmatched dollar is classified as exactly one of: quantity, rate, grant_or_commit, rounding, fx, missing_in_biller, missing_in_usage, unmapped_term, unmapped_customer.
5. Unmapped customers remain in the period denominator and are labelled. They are never dropped to inflate verified percentage.
6. Re-running the same period with the same usage snapshot, terms snapshot, and biller snapshot is byte-identical.
7. The run records data-as-of timestamps for usage sync, biller sync, and terms version.

Test Cases
TEID-V1-T1  [Functional]  --  Not run
Given a golden fixture where usage × terms equals the Stripe invoice to the cent, run Verify and confirm verified_amount = billed_amount, exception_count = 0, verified_pct = 100.

TEID-V1-T2  [Functional]  --  Not run
Remove one 10_000-token line from the biller fixture, keep usage intact, and confirm a single missing_in_biller exception for the exact expected amount.

TEID-V1-T3  [Functional]  --  Not run
Keep quantity identical and change only the unit rate from 0.002 to 0.0015 USD, and confirm a rate exception whose dollar delta equals quantity × 0.0005 after the tenant rounding rule.

TEID-V1-T4  [Functional]  --  Not run
Mark 30 percent of customers unmapped and confirm the report’s verified_pct uses all billed dollars in the denominator and exposes an unmapped_customer bucket rather than reporting 100 percent of mapped dollars as company-verified.

TEID-V1-T5  [Functional]  --  Not run
Replay the same fixtures five times and confirm the exception set and totals are byte-for-byte identical.

TEID-V1-T6  [Non-functional]  --  Not run
Re-rate a fixture of 5_000 customers and 2 million usage events for one monthly period and confirm the job completes within 15 minutes on the standard agent runner profile.

TEID-V1-T7  [Adversarial]  --  Not run
Feed two biller lines that legally collapse to one expected line (split description, same metric/window/rate) and confirm they match without double-counting expected or billed amount.

TEID-V1-T8  [Adversarial]  --  Not run
Introduce a second rating implementation behind a flag, run the kernel-identity suite, and confirm CI fails if Verify output diverges from the live rating kernel on any golden fixture.

---

### TEID-V2  Period discrepancy report

Priority: Highest   Points: 8   Release: verify-v1   Order: 201
Status: To Do

As a finance lead, I want a period report I can forward to a CFO, so that the first conversation is about exceptions rather than about whether Teideal ran.

Acceptance Criteria
1. An operator can generate a report for one tenant, one connected biller, and one closed period.
2. The report is available as PDF and CSV.
3. The report shows: billed total, expected total, delta, verified_pct, coverage_pct (usage days present / days in period), classification totals, top 20 exceptions, generated_at, usage_as_of, biller_as_of, terms_version.
4. If usage coverage for the period is below the tenant threshold (default 95 percent), generation is blocked unless an operator supplies a reason, which is printed on the report.
5. PDF and CSV totals match exactly.
6. A verify_only tenant can generate this report. No payment or entitlement write is required.

Test Cases
TEID-V2-T1  [Functional]  --  Not run
Generate PDF and CSV for golden period P and confirm every required field is present and the two formats agree on all money totals.

TEID-V2-T2  [Functional]  --  Not run
Set coverage threshold to 95 percent, supply a period at 80 percent coverage, confirm generation is rejected without a reason, then supply reason incomplete_export and confirm the report prints that reason.

TEID-V2-T3  [Functional]  --  Not run
Confirm the top 20 exceptions are ordered by absolute dollar delta descending.

TEID-V2-T4  [Non-functional]  --  Not run
Generate the report for a 50_000-customer preview fixture and confirm both artifacts are ready within 5 minutes.

TEID-V2-T5  [Adversarial]  --  Not run
Request a report for a period that is still open and confirm the API returns 409 with reason period_not_closed rather than a partial report.

TEID-V2-T6  [Adversarial]  --  Not run
As tenant A, request tenant B’s report ID and confirm 403 with no body leakage.

---

### TEID-V3  Exception inbox

Priority: Highest   Points: 8   Release: verify-v1   Order: 202
Status: To Do

As a finance operator, I want to accept, explain, or contest each exception, so that verified revenue is a decision rather than a dump of diffs.

Acceptance Criteria
1. Each exception has state: open, accepted, contested, adjustment_candidate.
2. Accept requires a reason string and writes only an audit entry plus state change. It does not write to the biller or to the live entitlement ledger.
3. Contest flags the exception for the partner thread and does not change billed or expected amounts.
4. Spawn adjustment_candidate creates a TEID-34 queue item linked to the exception IDs; it does not mutate a closed invoice.
5. Concurrent transitions on the same exception are serialised; the second actor receives a conflict.
6. State changes appear in the audit log with actor (agent id or human id), before, after, reason.

Test Cases
TEID-V3-T1  [Functional]  --  Not run
Accept an open rate exception with reason contracted_override_not_in_stripe and confirm state=accepted, audit row present, Stripe unchanged, ledger unchanged.

TEID-V3-T2  [Functional]  --  Not run
Contest an exception and confirm billed and expected totals on the period report are unchanged.

TEID-V3-T3  [Functional]  --  Not run
Spawn adjustment_candidate from a missing_in_biller exception and confirm a TEID-34 item exists with source=verify_exception and the same money amount.

TEID-V3-T4  [Functional]  --  Not run
List inbox filtered by class=rate and state=open and export CSV of the filter.

TEID-V3-T5  [Non-functional]  --  Not run
Open an inbox of 10_000 exceptions and confirm first page renders within 2 seconds via API.

TEID-V3-T6  [Adversarial]  --  Not run
Fire accept and contest on the same exception in the same millisecond and confirm exactly one terminal state and one audit pair, loser gets 409.

TEID-V3-T7  [Adversarial]  --  Not run
Call accept on a verify_only tenant and confirm it still cannot request Stripe write scope.

---

### TEID-V4  Materiality threshold

Priority: High   Points: 3   Release: verify-v1   Order: 203
Status: To Do

As a finance lead, I want diffs below a threshold rolled into one bucket, so that the inbox is about money that matters.

Acceptance Criteria
1. A tenant can set a materiality threshold as a money amount, a basis-point rate of the period billed total, or both (OR).
2. Default is 1.00 in the invoice currency or 1 bps, whichever rule is enabled.
3. Sub-threshold diffs are not individual inbox rows; they sum into class=immaterial.
4. Changing the threshold regenerates the current period view without rewriting historical report artifacts. A new report generation uses the new threshold and stores it on that report.
5. Threshold changes are audit-logged.

Test Cases
TEID-V4-T1  [Functional]  --  Not run
Seed 50 diffs of 0.04 USD and one diff of 80 USD, set threshold 1.00 USD, and confirm inbox shows one 80 USD row plus an immaterial bucket of 2.00 USD.

TEID-V4-T2  [Functional]  --  Not run
Generate report R1 at threshold 1.00, change threshold to 0.01, confirm R1 still shows its stored threshold, and R2 uses 0.01.

TEID-V4-T3  [Adversarial]  --  Not run
Set threshold to a negative amount via API and confirm 422.

TEID-V4-T4  [Adversarial]  --  Not run
Set threshold larger than the period billed total and confirm the report still renders and verified_pct math remains defined (immaterial may absorb everything; unmapped rules still apply).

---

### TEID-V5  Golden period fixture pack (agent-native)

Priority: Highest   Points: 5   Release: verify-v1   Order: 204
Status: To Do

As an agent implementing Verify, I want checked-in golden periods, so that I can prove money changes without a human QA cycle.

Acceptance Criteria
1. Repository contains at least 10 golden periods covering: exact match, missing usage, missing biller line, rate change, grant expiry mid-period, commit exhaustion split, rounding remainder, FX-only diff, unmapped customer, DST boundary event.
2. Each fixture is usage + terms snapshot + biller snapshot + expected exceptions JSON.
3. One documented command runs the pack and exits non-zero on any mismatch.
4. Any PR that touches rating, matching, rounding, or period boundaries must run this pack in CI.
5. Fixtures contain no personal data; customers are synthetic.

Test Cases
TEID-V5-T1  [Functional]  --  Not run
Run the pack on a clean checkout with the documented command and confirm 10 named cases pass.

TEID-V5-T2  [Functional]  --  Not run
Mutate the rate in one expected file and confirm CI fails with the case name in the log.

TEID-V5-T3  [Non-functional]  --  Not run
Confirm the pack completes in under 10 minutes on the standard 4-core agent runner.

TEID-V5-T4  [Adversarial]  --  Not run
Scan fixtures for email, phone, or government-id patterns and confirm zero matches.

---

## E21 — Design-partner operations

Release: verify-v1
Make the first two partners succeed on an agent-operated service: file contract, time-to-report, weekly rerun. Humans appear only as the partner’s finance operator and Teideal’s founder for the relationship.

### TEID-S1  Time-to-first-report

Priority: Highest   Points: 5   Release: verify-v1   Order: 210
Status: To Do

As a founder running design partners, I want a measured path from credentials to first report in five calendar days, so that agents cannot hide behind open-ended integration.

Acceptance Criteria
1. A documented partner-zero run exists in staging: connect Stripe test mode, import S3 usage for 90 days, map 20 customers, generate TEID-V2.
2. For fixtures up to 5_000 customers and 90 days of usage, the automated path completes in ≤ 4 agent-hours of compute and ≤ 5 calendar days including partner file delivery slack.
3. Every step that cannot be completed by an agent (OAuth consent, DPA signature, production key paste) is listed as a human gate with an owner role: partner_admin or teideal_founder.
4. The run writes a timeline artifact: step, start, end, actor_type (agent|human), status.

Test Cases
TEID-S1-T1  [Functional]  --  Not run
Execute partner-zero against Stripe test fixtures and confirm a TEID-V2 artifact exists at the end.

TEID-S1-T2  [Functional]  --  Not run
Confirm the timeline lists OAuth and DPA as human gates and all other steps as agent.

TEID-S1-T3  [Non-functional]  --  Not run
Time compute for the 5_000-customer fixture path and confirm it is under 4 hours.

TEID-S1-T4  [Adversarial]  --  Not run
Start partner-zero with write-scoped Stripe keys and confirm the path stops at TEID-65/TEID-C1 read-only enforcement.

---

### TEID-S2  Usage file contract

Priority: Highest   Points: 5   Release: verify-v1   Order: 211
Status: To Do

As a developer at the partner, I want one published file schema, so that I can dump usage from a warehouse without an SDK.

Acceptance Criteria
1. Published schema (CSV and JSONL): event_id, customer_external_id, metric, quantity, occurred_at (UTC ISO-8601), optional model, optional idempotency_key, optional properties_json.
2. Upload is to a tenant-scoped bucket or via POST /v1/verify/usage-files.
3. Preview reports row count, distinct customers, min/max occurred_at, and per-row errors.
4. Apply uses TEID-31 idempotency. Re-uploading the same file does not double count.
5. Rows with errors are downloadable; valid rows in the same file still apply if the operator chooses apply_partial.
6. Formula-injection and null-byte payloads are rejected or sanitized; the service does not execute formulas.

Test Cases
TEID-S2-T1  [Functional]  --  Not run
Upload a valid 2_000-row CSV and the equivalent JSONL and confirm identical accepted event counts.

TEID-S2-T2  [Functional]  --  Not run
Upload 500 rows / 12 customers and confirm preview shows 500, 12, and a projected Verify coverage delta before apply.

TEID-S2-T3  [Functional]  --  Not run
Apply twice and confirm the second apply creates zero additional usage rows.

TEID-S2-T4  [Functional]  --  Not run
Include 15 bad rows, download the error slice, fix, re-upload only those 15, and confirm they apply.

TEID-S2-T5  [Non-functional]  --  Not run
Preview a 250_000-row file within 2 minutes.

TEID-S2-T6  [Adversarial]  --  Not run
Upload mismatched columns, embedded null bytes, and a cell starting with =CMD and confirm reject or sanitize with no code execution.

TEID-S2-T7  [Adversarial]  --  Not run
Three concurrent applies of the same file from three agent sessions create only one committed set.

---

### TEID-S3  Recurring weekly Verify

Priority: High   Points: 5   Release: verify-v1   Order: 212
Status: To Do

As a finance lead, I want last week’s close checked every week without asking an agent to remember.

Acceptance Criteria
1. After the first successful report, a weekly job re-syncs biller + incremental usage and re-rates the latest closed period plus the previous period (for late events).
2. If |delta| or unclassified open exceptions exceed tenant thresholds, the system sends one alert (email and optional Slack webhook), not one alert per line.
3. A no-change week sends nothing.
4. Job failures page the on-call agent channel with the tenant id and last successful run.

Test Cases
TEID-S3-T1  [Functional]  --  Not run
Seed a week with zero new diffs and confirm zero alerts.

TEID-S3-T2  [Functional]  --  Not run
Seed 10_000 USD of new rate exceptions and confirm exactly one alert containing the total and a deep link to the inbox.

TEID-S3-T3  [Functional]  --  Not run
Force the weekly job to fail twice and confirm the on-call channel receives a page with tenant id.

TEID-S3-T4  [Adversarial]  --  Not run
Fire the weekly job three times in one window and confirm only one report generation and at most one alert.

---

### TEID-S4  Agent runbook and blast radius

Priority: High   Points: 3   Release: verify-v1   Order: 213
Status: To Do

As an agent on-call, I want a runbook that names allowed tools and forbidden writes, so that I cannot “fix” a partner by touching Stripe.

Acceptance Criteria
1. A versioned runbook lists: how to replay a period, how to re-import a file, how to freeze terms, how to open a TEID-V3 exception.
2. The runbook states forbidden actions: requesting write OAuth scopes, issuing grants, calling payment APIs, deleting ledger rows.
3. An automated check on the Verify service account confirms the credential set contains no biller write scopes.
4. Every production action the agent takes is attributable to an agent_run_id in the audit log.

Test Cases
TEID-S4-T1  [Functional]  --  Not run
Render the runbook and confirm the four allowed and four forbidden actions are present.

TEID-S4-T2  [Functional]  --  Not run
Introspect the Verify service credential and confirm write scopes are absent.

TEID-S4-T3  [Adversarial]  --  Not run
Attempt a Stripe invoice-item create using the Verify account and confirm denial plus an audit security event.

---

## E22 — Commercial wedge and tenant packaging

Release: verify-v1
Package Verify so it can be sold and so agents cannot accidentally turn a read-only tenant into a biller.

### TEID-C1  Verify-only tenant plan

Priority: Highest   Points: 5   Release: verify-v1   Order: 220
Status: To Do

As a founder, I want a tenant type that cannot write entitlements or payments, so that design partners can connect production Stripe without a rip-and-replace risk.

Acceptance Criteria
1. Tenant flag product_mode is one of verify_only, billing_lite, hot_path.
2. verify_only: entitlement mutate, grant issue, commit mutate, invoice sync write, credit-pack grant from Stripe, and payment-processor write APIs return 403 with reason verify_only_tenant.
3. verify_only cannot start a Stripe OAuth flow that requests write scopes. The connect screen states Teideal cannot change Stripe.
4. Mode changes from verify_only to billing_lite require a founder-role human gate and are audit-logged.
5. TEID-V1 through TEID-V4, TEID-65, TEID-66, TEID-67 work fully in verify_only.

Test Cases
TEID-C1-T1  [Functional]  --  Not run
On a verify_only tenant, call POST /v1/grants and POST invoice-sync and confirm both 403 verify_only_tenant.

TEID-C1-T2  [Functional]  --  Not run
Start Stripe connect on verify_only and confirm requested scopes are read-only.

TEID-C1-T3  [Functional]  --  Not run
Generate a TEID-V2 report on verify_only and confirm success.

TEID-C1-T4  [Adversarial]  --  Not run
Agent session attempts to patch product_mode to billing_lite without founder gate and is rejected.

TEID-C1-T5  [Adversarial]  --  Not run
Replay an intercepted write-scope OAuth code on a verify_only tenant and confirm it is not stored.

---

### TEID-C2  Launch residency and DPA packet

Priority: Highest   Points: 3   Release: verify-v1   Order: 221
Status: To Do

As a founder, I want a public residency statement and a signable DPA, so that legal review is not a custom agent project per partner.

Acceptance Criteria
1. Public page names launch region(s), data classes stored there (usage, invoices, terms, audit), and that ledger amounts are not mixed into the personal-data store (aligns with existing privacy stories).
2. Standard DPA covers GDPR and India’s DPDP Act (complements TEID-115).
3. Packet includes sub-processor list with purpose and location.
4. A partner cannot receive production credentials until DPA accepted_at is set. This is a hard gate in the connect flow.

Test Cases
TEID-C2-T1  [Functional]  --  Not run
GET the public residency page unauthenticated and confirm region and data classes are present.

TEID-C2-T2  [Functional]  --  Not run
Attempt Stripe production connect with dpa_accepted_at null and confirm the flow blocks.

TEID-C2-T3  [Functional]  --  Not run
Set dpa_accepted_at and confirm connect proceeds to read-only OAuth.

TEID-C2-T4  [Adversarial]  --  Not run
Forge accepted_at via API without founder or legal role and confirm rejection.

---

### TEID-C3  Verify commercial meter (internal)

Priority: Medium   Points: 3   Release: verify-v1   Order: 222
Status: To Do

As a founder, I want to know reviewed billings and event volume per tenant, so that I can price Verify without building a second billing company first.

Acceptance Criteria
1. Each successful period report stores reviewed_billings_amount, event_count, exception_count, compute_ms.
2. An internal-only endpoint (Teideal operator) lists tenants and trailing-90-day reviewed billings.
3. This meter is not shown to the partner as a bill in v1 unless product_mode says so.
4. Numbers reconstruct from report artifacts; they are not a separate mutable counter.

Test Cases
TEID-C3-T1  [Functional]  --  Not run
Generate two period reports and confirm internal listing sums reviewed_billings to those two billed totals.

TEID-C3-T2  [Adversarial]  --  Not run
Partner API key calling the internal listing receives 403.

---

## E23 — Migration later (replaces empty E13 scope)

Release: billing-lite
Only after two paying Verify tenants. Shadow first. Cut over one SKU. Keep Verify on.

### TEID-M1  Shadow bill versus live biller

Priority: High   Points: 8   Release: billing-lite   Order: 230
Status: To Do

As a finance lead, I want Teideal to produce invoices that are not sent and to diff them against the live biller, so that cutover is a measured decision.

Acceptance Criteria
1. For selected customers or a SKU tag, Teideal generates shadow invoices for a period using the live rating kernel.
2. Shadow invoices are marked unsent and cannot reach a processor.
3. Differences flow into TEID-V1 classes against the live biller snapshot.
4. Turning shadow off deletes nothing; artifacts remain.

Test Cases
TEID-M1-T1  [Functional]  --  Not run
Shadow-bill 10 customers and confirm zero Stripe writes and 10 shadow artifacts.

TEID-M1-T2  [Functional]  --  Not run
Align terms so shadow equals live and confirm exception_count = 0 for those customers.

TEID-M1-T3  [Adversarial]  --  Not run
Attempt to send a shadow invoice via the invoice-sync job and confirm the job skips documents with shadow=true.

---

### TEID-M2  Cutover checklist

Priority: High   Points: 5   Release: billing-lite   Order: 231
Status: To Do

As a founder, I want a machine-checked cutover checklist, so that an agent cannot flip writes because a ticket said “looks good.”

Acceptance Criteria
1. Checklist items: terms frozen for SKU, dual usage coverage ≥ 99 percent for 14 days, two consecutive closed periods with verified_pct ≥ tenant threshold, TEID-39 idempotency tests green, rollback drill recorded.
2. Invoice write (TEID-39) cannot enable for a SKU until all items are true or a founder override with reason is stored.
3. Checklist state is visible on the tenant.

Test Cases
TEID-M2-T1  [Functional]  --  Not run
With two items false, enable TEID-39 and confirm 409 listing the false items.

TEID-M2-T2  [Functional]  --  Not run
Mark all items true and confirm enable succeeds and is audit-logged.

TEID-M2-T3  [Adversarial]  --  Not run
Agent sets all checklist flags true via raw table write without going through the checklist API; application layer still treats items as false unless signed by the checklist service.

---

### TEID-M3  One-action rollback of invoice writes

Priority: High   Points: 3   Release: billing-lite   Order: 232
Status: To Do

As a billing operator, I want to disable Teideal invoice writes in one action, so that a bad close does not keep pushing lines to Stripe.

Acceptance Criteria
1. One API and one console action sets invoice_write=off for the tenant or SKU within 60 seconds on all workers.
2. Ledger, Verify, and history remain readable.
3. In-flight TEID-39 jobs abort without creating duplicate line items (existing idempotency keys stand).
4. Action requires founder or billing-admin plus reason.

Test Cases
TEID-M3-T1  [Functional]  --  Not run
Disable writes and confirm the next period-close job does not call Stripe write endpoints.

TEID-M3-T2  [Functional]  --  Not run
Confirm Verify still generates TEID-V2 after disable.

TEID-M3-T3  [Adversarial]  --  Not run
Disable mid-job and confirm no duplicate Stripe lines for that period.

---

## E24 — SOC 2 Type I evidence pack (narrow)

Release: verify-v1
Produce auditor-consumable evidence from systems that already exist (TEID-41, 42, 91, 92). Do not start a seven-story “compliance programme” before a customer.

### TEID-Q1  Evidence pack from live controls

Priority: High   Points: 8   Release: verify-v1   Order: 240
Status: To Do

As a founder, I want an evidence pack an auditor can read, so that the first enterprise partner’s security questionnaire does not become a new product.

Acceptance Criteria
1. Pack includes: access-review export from RBAC + last 90 days of sign-in audit, change-management export from TEID-42 for production deploys, backup restore test record, sub-processor list (TEID-115), network diagram of Verify v1 (batch + Postgres + object storage + Stripe read).
2. Pack is regenerated by one agent command and timestamped.
3. Scope statement says Type I, Verify production surface only, no hot-path entitlement edge.
4. Failed restore test blocks the pack from being marked current.

Test Cases
TEID-Q1-T1  [Functional]  --  Not run
Run the pack command and confirm all five artifacts exist and are non-empty.

TEID-Q1-T2  [Functional]  --  Not run
Simulate backup restore failure and confirm pack status is not current.

TEID-Q1-T3  [Adversarial]  --  Not run
Confirm the pack contains no plaintext API keys or Stripe access tokens.

---

### TEID-Q2  Verify surface pentest gate

Priority: High   Points: 5   Release: verify-v1   Order: 241
Status: To Do

As a security reviewer at the partner, I want the Verify HTTP surface tested for tenant isolation and file-parse abuse, so that I can approve a production usage dump.

Acceptance Criteria
1. Automated suite covers: IDOR on report and exception IDs, path-swap of tenant UUID, usage-file parser bombs, OAuth state reuse.
2. Suite runs in CI on every Verify service release.
3. A release that fails isolation or parser cases cannot be tagged production.

Test Cases
TEID-Q2-T1  [Functional]  --  Not run
Replay TEID-41-style cross-tenant GETs on /verify/reports/{id} and confirm 403.

TEID-Q2-T2  [Functional]  --  Not run
Upload the TEID-S2 adversarial file and confirm the process stays up.

TEID-Q2-T3  [Adversarial]  --  Not run
Reuse a consumed OAuth state and confirm rejection (aligns with TEID-37-T8).

---

## E25 — Agent delivery system

Release: verify-v1
The company has no human engineers. Velocity comes from contracts, fixtures, WIP limits, and blast-radius locks — not from more stories.

### TEID-A1  Single rating-kernel gate

Priority: Highest   Points: 3   Release: verify-v1   Order: 250
Status: To Do

As an agent changing pricing code, I want CI to fail if Verify and live billing diverge, so that I cannot ship a second calculator by accident.

Acceptance Criteria
1. A shared package owns rating. Verify and billing import it.
2. CI includes a grep/architecture test that fails if a second money calculator is added under verify/.
3. Golden pack TEID-V5 is mandatory on that package.

Test Cases
TEID-A1-T1  [Functional]  --  Not run
Add a duplicate round() helper under verify/rating and confirm CI fails the architecture test.

TEID-A1-T2  [Functional]  --  Not run
Change rounding in the shared package and confirm both a billing fixture and a Verify fixture fail together.

---

### TEID-A2  WIP and definition of shipped

Priority: High   Points: 2   Release: verify-v1   Order: 251
Status: To Do

As a founder, I want at most three stories in progress, so that agents do not start E08 while Verify has no report.

Acceptance Criteria
1. Board automation prevents a fourth story entering In Progress.
2. A story may not be marked Done unless: golden/CI tests named in the story passed, and for Slice A stories a partner-zero or fixture report artifact is attached.
3. Definition of shipped for Verify v1 is: a non-Teideal tenant generated TEID-V2 from real Stripe read data plus a real usage file.

Test Cases
TEID-A2-T1  [Functional]  --  Not run
Attempt to move a fourth story to In Progress and confirm the board API rejects it.

TEID-A2-T2  [Functional]  --  Not run
Mark TEID-V2 Done without a report artifact and confirm rejection.

---

### TEID-A3  Agent identity on every mutating call

Priority: High   Points: 3   Release: verify-v1   Order: 252
Status: To Do

As an auditor, I want every mutate attributed to an agent_run_id or a human founder id, so that “the system changed it” is not an answer.

Acceptance Criteria
1. Service-to-service and operator APIs require an actor header: agent:&lt;id&gt;:&lt;run&gt; or human:&lt;id&gt;.
2. Missing actor is 400. Unknown agent id is 403.
3. Audit log stores actor as a first-class field (extends TEID-42).

Test Cases
TEID-A3-T1  [Functional]  --  Not run
Accept an exception with actor agent:verify-ops:run_9 and confirm the audit row stores that value.

TEID-A3-T2  [Adversarial]  --  Not run
Omit actor and confirm 400 and no state change.

---

### TEID-A4  Allowed tool surface for coding agents

Priority: Medium   Points: 3   Release: verify-v1   Order: 253
Status: To Do

As an implementing agent, I want a declared interface (OpenAPI + event schema + fixture command), so that I do not invent UI or transport.

Acceptance Criteria
1. Verify v1 ships OpenAPI for connect, usage-file, mapping, run, report, inbox.
2. No undocumented routes in the Verify service: a CI check diffs OpenAPI and served routes.
3. README documents one command each for: load fixtures, run pack, generate sample PDF.

Test Cases
TEID-A4-T1  [Functional]  --  Not run
Start the service and confirm every served /v1/verify route exists in OpenAPI.

TEID-A4-T2  [Functional]  --  Not run
Add an undocumented route in a branch and confirm CI fails.

---

## Mapping to existing backlog (do not duplicate)

Implement these existing stories **inside** the slices above; do not rewrite them here:

- TEID-98 Connector framework
- TEID-65 Stripe read-only for Verify
- TEID-66 Independent usage feed — **CSV/S3 path only** for verify-v1; SDK dual-write and webhook mirroring stay To Do until billing-lite
- TEID-67 Capture contract terms
- TEID-34 Late events / adjustments
- TEID-97 Multi-currency — **invoice currency + fx class only** for verify-v1
- TEID-46 Plain-English charge explanation (Slice B)
- TEID-62 Docs / quick start, Verify-scoped
- TEID-115 DPA and sub-processors
- TEID-39 / TEID-40 / TEID-23 / TEID-21 / TEID-24 only after E23 checklist

Do not pull E08, E07, TEID-49, E14 public repo, or E12 second processor into verify-v1.

---

## Agent operating notes (binding for implementers)

1. Prefer batch Verify (worker + Postgres + object storage). Do not build an edge entitlement cache to satisfy these epics.
2. If a contract term cannot be represented, flag unmapped_term. Do not approximate.
3. Humans: DPA, production OAuth consent, product_mode promotion, cutover override. Everything else must be scriptable.
4. A story is not done because an agent said it is done. Golden pack + CI + artifact.
5. verify_only is the only mode that may touch a partner’s production Stripe in verify-v1.
