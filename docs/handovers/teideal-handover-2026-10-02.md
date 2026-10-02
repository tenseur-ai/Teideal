# Handover: Teideal, solution architect + local orchestrator (session ending 2026-10-02)

You're picking up as solution architect on **Teideal**, a multi-tenant usage-based billing platform. Repo: **`tenseur-ai/Teideal`** (GitHub), local clone at `C:\Users\kiran\Teideal`, branch **`claude/eager-brown-dlqfl4`**. Read this whole document before doing anything.

Your role: write every spec, hand off implementation to developer agents (Codex via `scripts/spawn-codex-agent.sh`, Grok via `scripts/spawn-grok-agent.sh`, Gemini via the Antigravity VS Code extension — no working programmatic spawn for Gemini), independently verify every PR from scratch before merging (never trust an agent's self-report), merge with standing authorization, keep `docs/parallel-work.md` and the board/CSV in sync. `docs/parallel-work.md` is the authoritative process doc, not this handover — read its E11 phase row in full before touching anything in Verify.

## Do this first

**There is nothing mid-flight and nothing time-critical.** Everything below is merged, CI-green, and independently verified. The one open item is a live demo the user asked for and has not yet responded to (see "Live demo data, still in the database" below) — check whether they've looked at it or want it cleaned up before doing anything else.

**Hard scope freeze, stated explicitly and repeatedly by the user this session — do not self-select past it:**
> "Do not start TEID-67, TEID-40, or the independent usage feed." / "Stop... No TEID-52, no Metronome/Orb/Lago... no further console UI, no hypothetical TEID-68.2 -- await new direction."

Nothing in E11 (Verify), E04 (Stripe connector follow-ons), E07 (margin dashboard), or the Metronome/Orb/Lago connectors gets touched without new, explicit user direction, even though several of them are technically unblocked now. If the user's next message doesn't name a story, ask rather than guess which one they mean.

## Current merged/verified state (this session's work, all on `claude/eager-brown-dlqfl4`)

All four of these build on each other in sequence. Read them in this order if you need to understand current Verify behavior.

1. **Connector fix, `d8fc5e1`** (committed directly, not via PR — found mid-review of TEID-68, before TEID-68 could be trusted at all): Stripe's real invoice line shape nests the service period as `period: {start, end}`; `mapConnectorInvoiceLine` (`services/ts-console/src/lib/connectors/mockConnector.ts`, shared by the real Stripe connector and every connector's test double) only ever read flat `period_start`/`period_end`. Every fixture in the codebase hand-builds the flat shape, so every test passed while every real Stripe invoice line was silently excluded by TEID-66's null-period filter. Fixed in `invoiceWithEmbeddedLines` (`stripeBillingConnector.ts`) with a fallback to `line.period.start`/`.end`, flat fields still taking priority. `TEID-65.1-T7` added. TEID-66's own filter is unchanged.
2. **TEID-68, PR #76, merged `4694525`**: `GET /verify/discrepancy-report?period=YYYY-MM` — one row per (customer, period): expected (via `generatePeriodCloseSummary`, TEID-50, never re-derived) vs. billed (`verify_billed_lines`, TEID-66), classified `missing_line`/`quantity`/`rate_drift`/`known_coverage_gap`/`null` (clean match). New file `services/ts-console/src/lib/verify/discrepancyReport.ts`. Deliberately redefines and narrows the board's own differently-scoped TEID-68 (a from-scratch re-rating engine) — see `specs/TEID-68.md`'s header note. Hit one CI-only snag before merge: `tests/docs/coverage.test.ts`'s route-doc checker (`docs/api/check-coverage.ts`) matches `## METHOD /path [service]` headings literally against each service's registered path — a query string in the heading (`?period=YYYY-MM`) made it look undocumented. **Convention: never put a query string in a route heading**, describe it in prose below instead (see `/period-close-summary`'s own heading for precedent).
3. **TEID-68.1, PR #77, merged `b5709f5`**: a fully-written user spec, implemented by Codex, fixing two bugs TEID-68 shipped with that only showed up against a real Stripe invoice, never a hand-built fixture:
   - The billed-line join required `verify_billed_lines.period_start`/`period_end` to equal the report window exactly. Real Stripe subscription cycles don't align to calendar months. Fixed to the standard half-open interval-overlap predicate (`period_start < window_end AND period_end > window_start`).
   - Any credit/payment/refund record anywhere in the window forced `known_coverage_gap` before the dollar delta was considered — hiding a real, detectable discrepancy on a period that also had genuine overlapping billed lines. The coverage-gap check is now scoped to periods with *zero* overlapping billed lines; it still correctly catches a credit/refund-*only* period (`TEID-68-T10`, unchanged).
   - **Found during review, folded in per explicit user instruction ("wrap it up with 68.1"), not in the original spec**: the `excluded`/unmapped-customer query (same file) had the identical exact-equality bug in the same shape. Fixed the same way; `TEID-68.1-T5` added by Claude directly (not Codex).
   - No backfill, no historical-row rewrites. `caveats` now states plainly that invoices synced before the period-flatten fix need a resync + remap, and that credits/refunds are coverage-gap evidence only, never netted into the billed total.
   - All of TEID-66's 10 tests and TEID-68's original 10 tests still pass unmodified. `tests/verify` is **25/25**.

Both PRs' CI went fully green (`test`, `sdk-tests`, `deploy`) before merge — no flakes this round, no admin-merge needed.

## Live demo data, still in the database — check before cleaning up

After TEID-68.1 merged, the user asked for direct proof (not another story) that this all actually works against a real Stripe-shaped invoice end to end: resync → map → report, confirm the row is a match/delta/coverage-gap, never a false `missing_line`. Ran it as an ad-hoc script (not committed, already deleted) against the live dev stack:

- Connected a real Stripe connector via the actual OAuth flow (not a fixture shortcut).
- Seeded an invoice line with Stripe's genuine nested `period: {start, end}` — a subscription cycle **Aug 15 → Sep 15, 2026**, straddling the Aug report window (Aug 1 → Sep 1), not equal to it, not contained in it.
- `POST /connectors/:id/sync` → period flattened correctly.
- `POST /verify/map-billed-lines` → line landed in `verify_billed_lines` with those bounds, $500.00, quantity 50.
- `GET /verify/discrepancy-report?period=2026-08` → **clean match**: `expected_total: "500.00"`, `billed_total: "500.00"`, `delta: "0.00"`, `classification: null`. Not `missing_line`.

This data is **still live** in the shared dev Postgres container, left there on purpose in case the user wants to hit the endpoint themselves rather than trust a transcript:
- Connector: `914f6b20-66cc-4bac-ab47-6ccf69383409` (display name `Live Demo 1790864763373`)
- Stripe customer: `cus_demo_1790864763394`, invoice `in_demo_1790864763394`, line `il_demo_1790864763394`
- Teideal customer: `26a005fe-c266-4471-a699-6b702bb19715` ("Live Demo Customer")
- Query it yourself: `curl "http://127.0.0.1:18081/verify/discrepancy-report?period=2026-08" -H "authorization: Bearer <session-token>"` (needs ts-console running, see below, and a Billing/Finance/Owner session token — `billing@acmeco.com` / `BillingPass123!` / MFA secret `KRSXG5CTMVRXEZLU`, same as every other local verification this project does).

**If the user confirms they've seen it (or doesn't care to look), clean it up**: delete `connector_records`/`verify_billed_lines` rows for this connector, the connector itself, the customer, `stripe_customer_links`, `usage_events`/`ledger_transactions`/`ledger_lines` rows tied to that customer. Don't delete it preemptively without checking first — it's the actual evidence they asked for.

## Board and CSV: checked, confirmed zero drift, nothing to update

The user asked to update `teideal-board.html` and `teideal-stories.csv`. Checked properly rather than guessing: regenerated the CSV fresh, programmatically, straight from `teideal-board.html`'s own embedded `window.DATA` + `window.EMBEDDED_STATE` JSON (script was ad hoc, not saved — rebuild it the same way if you need to re-verify: extract both `window.X=...` assignments with brace-balanced parsing, not regex, since they're adjacent in the same `<script>` tag with no whitespace between them). Diffed against the committed CSV: **byte-identical content** (only CRLF/LF line-ending bytes differ). Still 36/108 done.

**Why nothing changed**: TEID-65.1, the redefined TEID-66/68, and TEID-68.1 all deliberately don't correspond to the board's *official* definitions of those keys (the official TEID-66 is a from-scratch independent usage feed; the official TEID-68 is a from-scratch re-rating engine — neither is what got built, by explicit user design this whole arc). Marking those official entries "Done" would misrepresent what shipped. This has been true and intentional since TEID-65.1/66 in the prior session too — not something this session discovered newly, just re-confirmed.

**Did not attempt a cosmetic "recent activity" note on the board itself**: `teideal-board.html` is a self-contained single-page app that can rebuild its *entire* `<body>` from `window.DATA`/`window.EMBEDDED_STATE` via a `buildDocument()`/`bodyTemplate()` function pair (used by its own Export/Reset-adjacent machinery) — any hand-added static HTML outside that data risks being silently dropped if that regeneration path ever fires, and extending it properly would mean modifying the app's own rendering JS, which is scope creep this session's explicit "not a story" instruction ruled out. If the user wants visibility for this arc of work beyond `docs/parallel-work.md`, that's a real (small) feature decision for them to make, not something to guess at.

## Process/environment notes carried forward, plus new ones from this session

- **Starting the local stack**: no `.env` file exists for either service; always pass env vars explicitly. This exact block works (ports chosen to avoid the fake-Stripe default on 18092, which is a separate long-lived process already up at `127.0.0.1:18092` — check `netstat -ano | grep 18092` before assuming you need to start it):
  ```
  cd services/go-usage && go build -o /tmp/go-usage.exe ./cmd/server
  PORT=18082 DATABASE_URL="postgres://teideal_app:teideal_app_dev_password@localhost:5432/teideal?sslmode=disable" \
    nohup /tmp/go-usage.exe > go-usage.log 2>&1 &

  cd services/ts-console && npm run build
  PORT=18081 GO_USAGE_URL=http://127.0.0.1:18082 \
    DATABASE_URL="postgres://teideal_app:teideal_app_dev_password@127.0.0.1:5432/teideal" \
    STRIPE_API_BASE_URL=http://127.0.0.1:18092 STRIPE_CONNECT_BASE_URL=http://127.0.0.1:18092 \
    STRIPE_CONNECT_CLIENT_ID=ca_test_teideal STRIPE_CONNECT_CLIENT_SECRET=sk_test_teideal_connect_secret \
    STRIPE_CONNECT_REDIRECT_URI=http://127.0.0.1:18081/stripe/connect/oauth/return \
    STRIPE_TOKEN_ENCRYPTION_KEY=02DWhpwMvIIHYMC/Z73W+qfHPlGd/gBN3riv9zqXQmY= \
    nohup node dist/server.js > ts-console.log 2>&1 &
  ```
  As of this handover, ts-console (PID 14056) and go-usage (PID 55320) are **still running** on 18081/18082 from this session's live demo — reuse them or kill and restart, your call.
- **ts-console crashes under this shared environment, repeatedly, not a product bug**: an unhandled `error` event on a `pg` Client (most often `idle_in_transaction_session_timeout`, Postgres code `25P03`, or a plain dropped connection) crashes the entire Node process — seen 3 times this session, always during or right after a long/heavy test run (e.g. the 2-million-line scale test) on this one shared, long-lived `teideal-postgres` container under concurrent load. Recovery is just kill + restart with the block above. Don't mistake this for a regression in whatever you just changed — confirm by restarting and re-running before concluding anything's actually broken.
- **The fake-Stripe test double expects integer minor units, matching real Stripe**: `amount`/`unit_amount`/`amount_due` must be strings like `"50000"` for $500.00, not `"500.00"` — `decimalAmount()` in `mockConnector.ts` throws `invalid fixture money amount` on anything with a decimal point. Bit the live demo script once; all the committed test fixtures already get this right, it's only an issue writing new ad-hoc scripts.
- **Any ad-hoc script touching the database directly (not through `tests/*/db.ts` helpers) must wrap every query in a tenant-scoped transaction**: `BEGIN; SELECT set_config('app.tenant_id', $1, true); ...; COMMIT;` on every connection it opens. A bare `pool.query(...)` with RLS enabled either throws (`new row violates row-level security policy`, for writes) or silently returns zero rows (for reads) — the latter is the more dangerous failure mode since it looks like "the data isn't there" rather than "you forgot tenant context." Cost real debugging time twice during this session's live demo.
- **`notes/` folder**: developer-agent implementation notes go in `notes/NOTES-TEID-XX.md`, not the repo root. `notes/NOTES-TEID-68.1.md` follows this.
- **`STRIPE_TOKEN_ENCRYPTION_KEY` consistency**: always the same value, `02DWhpwMvIIHYMC/Z73W+qfHPlGd/gBN3riv9zqXQmY=`, on every process (server + every test runner). A mismatch produces a GCM auth-tag error that looks like a product bug. See saved memory `feedback_stripe_key_consistency`.
- **The local `psql` shim** (`C:\Users\kiran\bin\psql`) silently forwards every call to `docker exec teideal-postgres`, ignoring `-h`/`-p`. There is no real isolated local database — every verification this project has ever done runs against that one shared, accumulating container. Prefer scoped `WHERE tenant_id = ...` queries over raw counts.
- **Prompt files for spawned agents** (`prompt-teid-XX-codex.txt` etc.) are left at the repo root, untracked, intentionally — referenced by name in `docs/parallel-work.md`'s per-story entries for provenance. `prompt-teid-68-1-codex.txt` is the only one currently present; clean up service/spawn `.log` files freely (done this session), but leave prompt files unless the story they document is long closed and nobody would need to re-check the agent's exact instructions.
- **Codex spawn**: `scripts/spawn-codex-agent.sh <branch> <base> <dest-worktree-dir> <prompt-file> <log-file>` — synchronous, blocks until Codex finishes, cannot commit/push/PR itself (sandboxed), you review and commit on its behalf every time, every story. Always `npm install` fresh in a new worktree before building/testing — node_modules is never carried over.
- **Doc-coverage route headings** (`docs/api/check-coverage.ts`): `## METHOD /path [service]` must be the exact literal registered path, no query string, no trailing slash mismatch. Caught this session for TEID-68's route; worth remembering as a standing rule for any new route doc.

## Nothing else is pending

No open PRs, no running worktrees besides the main checkout, no failing CI anywhere on this branch. `git worktree list` shows only `C:/Users/kiran/Teideal`. The two Codex worktrees used this session (`codex-teid-68`, `codex-teid-68-1`) were removed and their branches deleted after merge.
