# Handover: Teideal, solution architect + local orchestrator (session ending 2026-10-01, 5-hour reset)

You're picking up as solution architect on **Teideal**, a multi-tenant usage-based billing platform. Repo: **`tenseur-ai/Teideal`** (GitHub), local clone at `C:\Users\kiran\Teideal`, branch **`claude/eager-brown-dlqfl4`**. Read this whole document before doing anything — several items below are time-critical or state-sensitive.

Your role: write every spec (`specs/TEID-XX.md`), hand off implementation to developer agents (Codex, Grok, Gemini/Antigravity — never write feature code yourself), independently verify every PR from scratch before merging (never trust an agent's self-report), merge with standing authorization, keep `docs/parallel-work.md` and the live board in sync. Full process rules live in `docs/parallel-work.md` — read it, it is the authoritative process doc, not this handover.

## Do this first, in order

### 1. Check whether Antigravity is still running (DO NOT TOUCH its files until you've confirmed)

As of this handover, **Google Antigravity (VS Code extension) was actively running directly in this checkout** (`C:\Users\kiran\Teideal`, the same directory you work in — not a separate worktree), implementing TEID-51. Check `tasklist | grep -i antigravity` (PowerShell: `Get-Process Antigravity`). If it's still running, **wait for it to finish before running any broad git command** (`git add -A`, `git checkout .`, `git reset`, `git clean`, `git stash` — anything that touches the whole working tree). Stage and commit only specific files you intend, the same way this session did throughout.

### 2. Validate and land TEID-51 (Antigravity/Gemini)

The user says Gemini has completed TEID-51 (`specs/TEID-51.md`, issue #67, E07's first story). This was done via the **Google Antigravity VS Code extension**, not the `gemini` CLI tool (that CLI's headless auth was previously confirmed broken in this project — see `docs/parallel-work.md`'s "Gemini auth" note; this is a different invocation path, same underlying model family, no working script to spawn it programmatically). There is **no PR, no commit** — everything is sitting as uncommitted working-tree changes in the main repo directory. Last known file list (confirm current with `git status --short` — Antigravity may still be editing):

```
 M .github/workflows/ci.yml
 M docs/api/errors.md
 M services/go-usage/internal/api/adjustments.go
 M services/go-usage/internal/api/usage.go
 M services/ts-console/src/server.ts
?? NOTES-TEID-51.md                                  (should move to notes/NOTES-TEID-51.md)
?? db/migrations/20261001130000_inference_costs.sql
?? docs/api/cost-rates.md
?? services/ts-console/src/lib/costRates.ts
?? services/ts-console/src/routes/costRates.ts
?? tests/cost-analytics/
```

`NOTES-TEID-51.md`'s self-report (read it in full) claims AC 3/3, tests 7/7, `go test ./...` / `tsc --noEmit` / docs coverage all passing. **Treat this exactly like a Codex handoff**: review the diff critically against `specs/TEID-51.md` (especially the Scoping notes — the `model`/`actual_cost` nullable-column design, `cost_rates` keyed on `(tenant_id, model, metric, effective_from)`, cost resolution happening report-side in ts-console not on go-usage's ingestion hot path), fix anything wrong yourself, move `NOTES-TEID-51.md` into `notes/`, commit on its behalf, push to a new branch (`gemini/teid-51-inference-costs` or similar), open a PR against `claude/eager-brown-dlqfl4`, then run full independent verification (fresh/rebuilt DB, every regression suite this story could plausibly touch — at minimum `tests/cost-analytics` itself, `tests/docs` coverage, `go vet`/`go test` in `services/go-usage`, `tsc --noEmit`) before merging. Do not mark TEID-51 done on the board until that's actually clean.

### 3. PR #68 (TEID-39) — CI is RED, not just pending, with a known exact cause

Grok implemented TEID-39 (`specs/TEID-39.md`, issue #66, E04). During this session: rebased it onto current base (it had fallen behind TEID-65's merge), fixed a real architectural issue (Grok's `ConnectorHttpClient.post()` addition lived inside `connectors/`, the directory `tests/connectors/no-write-guard.test.ts` exists specifically to prove is read-only — relocated the retry-capable client to a new `services/ts-console/src/lib/httpRetryClient.ts`, restored `connectors/httpClient.ts` to its exact TEID-65 form), and added missing cross-tenant coverage (`tests/cross-tenant/period-close-isolation.test.ts` — neither of period-close's routes had one). Pushed as commit `bf631c5` on `grok/teid-39-stripe-invoice-sync`.

**CI then failed** on both runs, same cause: `tests/processor-neutrality/processor-neutrality.test.ts:289` (TEID-74-T1) asserts the database's only Stripe-ID-referencing column across all tables is `stripe_customer_links` — a structural audit proving Teideal's own UUIDs are canonical. TEID-39's new `period_close_invoice_line_items` table has a `stripe_invoice_item_id TEXT NOT NULL` column, which is the exact same *correct* pattern (a non-primary-key reference to Stripe's own ID, never used as the row's identity) — this is legitimate processor-neutral design, not a violation. **The fix is almost certainly just updating that test's hardcoded expected-table array** to include `"period_close_invoice_line_items"` alongside `"stripe_customer_links"` (check the exact query at line ~287 first — confirm it's really just an allowlist of *expected* Stripe-referencing tables, not something that should structurally reject a second one, before changing it). This was not fixed this session due to the time boundary — verify the diagnosis, fix the test, re-run `tests/processor-neutrality` plus the full suite this session already verified clean once (connectors 30/30, stripe-connect 16/16, docs 6/6, period-close 14/14, cross-tenant 77/77 — these should still hold, just confirm), push, confirm CI green, then independently verify and merge following the standard process.

### 4. TEID-65.1 — review-driven follow-up to merged TEID-65, not yet started

Grok independently reviewed the merged TEID-65 (PR #65, `953e459`) and found three real gaps, written up in `specs/TEID-65.1-Claude-Prompt.md` (full technical detail/rationale). This session synthesized that into `specs/TEID-65.1.md` (standard spec format) and opened **issue #69** for Codex. **Not yet assigned to an agent** — this is the natural next Codex pickup (same phase, E11, directly continues TEID-65):

1. Invoice lines get truncated (Stripe paginates `lines`; the connector only ever persisted the first page).
2. Incremental sync uses `created[gte]` only, so an invoice that *changes* after creation (paid, voided, new line, refunded) never updates in the landing table.
3. `DELETE /connectors/:id` currently deauthorizes the *shared* Stripe Connect OAuth token, which also kills TEID-37/38/39's own live Stripe integration — unregistering Teideal Verify's read-only connector should never do that.

Read both documents in full before spawning Codex on this (`specs/TEID-65.1.md` is the contract; the `-Claude-Prompt.md` has additional worked examples).

### 5. Two new specs are ready to hand off (after items 2-4 land)

- **`specs/TEID-65.1.md`** → Codex, issue **#69**. (Also covered in #4 above — this is the "Codex" spec requested.)
- **`specs/TEID-52.md`** → Gemini, issue **#70**. Margin dashboard, second story in E07. **Explicitly blocked on TEID-51 being independently verified and merged first** (depends directly on `cost_rates`/`resolveEventCost`) — do not hand this off until item 2 above is actually done, not just self-reported done.

Neither agent was spawned this session (ran out of time) — both are ready to go as soon as their blockers clear.

## What else can be picked up after those two specs

Per `docs/parallel-work.md`'s "each developer agent owns a whole phase" rule, the natural next pick for each already-active agent, once free:

- **Grok** (owns E01, E04, E06, E12 currently) — after TEID-39 lands: TEID-40 (E04, Stripe payment → grant creation, next in order after TEID-39), or TEID-46/TEID-49 (E06), or TEID-75/76/77 (E12, processor-neutral payments — note TEID-74 already shipped the identifier-resolution half, these three continue it). TEID-21 (E01's last story, hard caps) was deliberately **not** picked this session — its AC references real-time entitlement-check denial, which depends on E02 (0/6 stories, unbuilt); needs a scoping decision before it's specable, same category of gap as TEID-99/100/101.
- **Codex** (owns E05, E09, E11) — after TEID-65.1: TEID-66 onward in E11 (not yet specced — check the live board), or TEID-61 (E09's last story), or TEID-93 (E05's last story, provisional).
- **Gemini/Antigravity** (now owns E07, via TEID-51) — after TEID-52: TEID-53 (E07's third and last story, low-margin-customer alerts), continuing the same phase.

Untouched, unassigned epics (good candidates for a brand-new agent or a new phase for an existing one, with no file overlap with anything above): E02 (real-time authorization — foundational, several other stories depend on it), E08 (AI operator intelligence), E13 (migration from other platforms), E10 (shadow enforcement/go-live, depends on E02). `docs/proposals/teideal-new-epics-2026-09-30.md` has a detailed, **not yet incorporated into the live board**, proposal for six further epics (E20-E25) worth reading before picking a totally new direction — it explicitly maps against the current backlog and should be reconciled with the user before any of it gets specced.

## Current merged/verified state

- **TEID-65 (E11): done.** PR #65, merged `953e459`, `main` fast-forwarded. Full verification record in `docs/parallel-work.md`'s E11 row. Three real bugs found and fixed during review (esbuild parser quirk in a shared test fixture, a TypeScript generic-inference gap, a wrong DELETE-permission assumption in a new test's cleanup) plus a genuine off-by-one in a boundary-timing test — all documented there in detail.
- Everything from before this session (E01 MVP, E03 9/11, E04 2/4 pre-TEID-39, E05 6/7, E06 4/6, E09 3/4, E12 1/4) is unchanged — see `docs/parallel-work.md` for full per-story verification records.

## Process/environment notes carried forward

- **`notes/` folder**: developer-agent implementation notes now go in `notes/NOTES-TEID-XX.md`, not the repo root (moved this session; 27 files relocated). Update any copied-from-an-old-session prompt that still says "write NOTES-TEID-XX.md at the repo root."
- **`docs/handovers/`** and **`docs/proposals/`**: also new this session — loose root-level scratch docs filed here instead of littering the project root.
- **`STRIPE_TOKEN_ENCRYPTION_KEY` consistency**: always pass the identical value to the server process and every test runner that touches Stripe-connect-adjacent code (`02DWhpwMvIIHYMC/Z73W+qfHPlGd/gBN3riv9zqXQmY=`, matching `tests/stripe-connect/env.ts`'s and `ci.yml`'s own default) — a mismatch causes a GCM auth-tag error that looks like a product bug but isn't. This was the single most time-costly mistake across this project's history; see the saved memory `feedback_stripe_key_consistency`.
- **The local `psql` shim** (`C:\Users\kiran\bin\psql`) silently forwards every call to `docker exec teideal-postgres` (the **shared, persistent** dev container), ignoring `-h`/`-p` flags entirely, unless `TEIDEAL_PG_CONTAINER` is set. There is no real local psql client and no cheap way to get a truly isolated database for verification on this machine — every story's independent verification this session (and prior ones) has run against that one shared container. It has accumulated significant leftover test data (Grok's own TEID-39 notes mention ~36k leftover customers) — this doesn't invalidate verification (CI rebuilds from scratch every time) but can make bulk-count-style assertions misleading if you're not careful; prefer scoped queries (`WHERE tenant_id = ...`) over raw table counts when verifying locally.
- **`no-write-guard.test.ts`'s regex has a real blind spot**: it detects `fetch(url, { method: "POST" })` and `fetch(url, { method: someVar })` but **not** `fetch(url, { method })` (ES2015 shorthand property — no colon for the regex to find). Worth tightening the scanner itself at some point so this class of story doesn't need a human/Claude to catch it by hand again.
- **Live board**: `https://claude.ai/artifact/3fGfA2zf4AELT8vKU9L2YF` (the `docs/parallel-work.md`-documented URL was stale pointing at a dead link until this session fixed it — confirm this one still resolves before trusting it blindly, per the pattern of this URL going dead twice already). Local snapshot at `teideal-board.html` (repo root) is kept in sync — always update both together.
- **`teideal-stories.csv`** (repo root, untracked, regenerate on request only): regenerated fresh at the end of this session, reflects current board state including TEID-65 done.
- **Gemini CLI** (`gemini` command): headless auth still unconfirmed/historically broken per `docs/parallel-work.md`. TEID-51 was done via Antigravity instead — if asked to "use Gemini" again, confirm with the user whether they mean the CLI (untested, likely still broken) or Antigravity (manual handoff: write spec + GitHub issue, user points Antigravity at it themselves — no programmatic spawn available).
- **Grok** spawns via `scripts/spawn-grok-agent.sh <branch> <base> <dest> <prompt-file> <log-file>` — fully unattended, commits/pushes/opens its own PR. **Codex** via `scripts/spawn-codex-agent.sh` — cannot commit (sandboxed), you must review its diff and commit/push/PR on its behalf every time, this is permanent, not a workaround to fix.

## Open ambiguity to clarify with the user

The user's handover request said "TEID-65 is awaiting CI completion." Verified ground truth: **TEID-65 itself is merged and done** (not awaiting anything). The closest actual match is **PR #68 (TEID-39)**, which is awaiting a CI fix (see item 3 above) — or possibly the user meant the not-yet-started **TEID-65.1** follow-up (item 4), whose *eventual* PR will need to pass CI once someone starts it. Confirm which one the user meant if it matters for prioritization; both are accurately described above regardless.
