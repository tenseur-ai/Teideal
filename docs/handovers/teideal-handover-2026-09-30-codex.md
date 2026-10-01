# Handover: Teideal, solution architect + local orchestrator — Codex-only session (starting 2026-09-30)

You're picking up as solution architect on **Teideal**, a multi-tenant
usage-based billing platform. Repo: **`tenseur-ai/Teideal`** (GitHub),
local clone at `C:\Users\kiran\Teideal`, branch **`claude/eager-brown-dlqfl4`**
(== `main`, zero divergence, confirmed via `git rev-list --left-right
--count origin/main...origin/claude/eager-brown-dlqfl4` returning `0 0`
immediately before this handover was written, HEAD `94ea91d`). This is a
continuation, not a fresh start.

**This file supersedes every prior handover in the repo root**
(`teideal-handover-2026-09-28.md`, `teideal-handover-vscode.md`,
`teideal-handover-2026-09-30.md`) — nothing in any of them is still
actionable; their "what's next" sections are all done. This file is
self-contained: everything from the prior handover that's still true is
repeated here in full, so you shouldn't need to open the older files at
all. **Read this whole file before doing anything else.**

**Live tracking board:** `https://claude.ai/artifact/DHJth2uHYfvARADya6xNeZ`.
**A fully standalone local copy now also exists in git**, at
`teideal-board.html` (repo root, committed as `94ea91d`) — self-contained
(the artifact's separate `app.js` is inlined), no external network calls,
opens in any browser with no claude.ai login. **It is a point-in-time
snapshot, not synced with the live Artifact** — the two are independent
copies from the moment it was created. Keep updating the **live Artifact**
(via the `Artifact` tool) as the working source of truth for
`ac[]`/`tests[]` and status, the same as always; only refresh the local
`.html` copy if the user specifically asks for an updated snapshot.

## THIS SESSION'S DIRECTIVE: Codex only

**The user has explicitly instructed: use Codex only this session — do
not spawn Grok.** This is a deliberate, session-scoped choice, not a
permanent reassignment of any phase. It changes the mechanics below in
three concrete ways:

1. **No `scripts/spawn-grok-agent.sh` calls this session.** Whatever
   story you pick, hand it to Codex via `scripts/spawn-codex-agent.sh`
   (see "Codex handoff mechanics" below), even if the story's epic was
   previously Grok's (E06 — see "What to pick next," this is exactly the
   situation you're in).
2. **You do 100% of the git work yourself, every time.** Codex's sandbox
   (`-s workspace-write`) still cannot commit its own git work — confirmed
   repeatedly, root cause believed to be the sandbox categorically
   denylisting `.git` paths, not a config problem worth re-litigating.
   You review Codex's diff, then commit/push/open the PR on its behalf,
   for every single story this session.
3. **You do 100% of the verification yourself, with no shortcuts.** As of
   this session, Codex's sandbox has **zero outbound network access at
   all** — not just GitHub, but npm registry and Docker/Postgres too.
   Confirmed directly: `gh issue view` inside Codex's sandbox failed with
   a raw socket-level connection error, and Codex's own handback messages
   plainly stated it could not run `npm install`, `tsc`, or any test
   suite. It can still read local files (the spec is already checked out)
   and therefore still write plausible-looking, often genuinely correct
   code — but budget for the fact that **none of it has ever actually
   run**. Two real bugs slipped through purely because of this gap last
   time (TEID-62): a broken npm dependency pin that made `npm install`
   fail outright, and a real accessibility violation in hand-rolled
   Markdown rendering. Neither would show up from reading the diff alone
   — you must actually build, install, and run everything yourself, every
   time, more rigorously than usual since there is no "Codex already
   smoke-tested this" baseline to lean on at all this round.

## Your role (non-negotiable, established over many sessions)

You are the **sole solution architect**. You write specs; you do not
write feature code yourself except to fix real bugs found during
independent verification (this happens routinely — six of the seven
stories shipped last session needed at least one real fix found this
way). Ground rules, all still in force:
- Stories within a phase build in the board's `order`, one at a time.
- **Never trust a developer agent's self-reported "all tests passed."**
  Every PR gets independently verified by you before merge: fresh `git
  worktree` (never reuse the agent's own working copy — Codex can't even
  reach one to have "used" in the network sense, but always start clean
  regardless), fresh disposable Postgres container, migrations + seeds
  reapplied from scratch, every service actually built and started, every
  cataloged test suite actually run and its output actually read. For
  anything auth/security-adjacent, go further: mint real credentials and
  actually attack the boundary yourself.
- **You have standing merge authority**: once independent verification
  passes, merge yourself, no separate human click required for a clean
  merge. Admin-merging **past a failing CI check** requires the failure
  to be a confirmed, diff-unrelated instance of an already-documented
  flake class (catalog below) — check the actual log signature, don't
  assume.
- Every commit ends with `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`;
  every PR body ends with the Claude Code footer. Use whatever this
  session's own system-reminder gives you verbatim.
- Fast-forward `main` to match the working branch after every merge,
  without asking, once confirmed a clean fast-forward. If it's ever
  **not** a clean fast-forward (two branches diverged in commit-hash
  terms even with identical content — this happened repeatedly last
  session when a fix landed on one side and got merged into the other
  independently), confirm via `git diff <a> <b> --stat` that one side has
  zero unique content, then `git merge --no-edit` and push the merge
  commit — do not force-push `main` (the auto-mode classifier blocks a
  bare force-push there as "Git Destructive," correctly).
- `gh pr merge --admin` (bypassing a failing check) gets correctly
  blocked by the auto-mode classifier as "Merge Without Review" — this is
  a real guardrail, don't route around it; only use it for a confirmed
  flake with the standing sign-off already established (see flake catalog
  below), and expect it to sometimes also block an unrelated *subsequent*
  read-only command for a turn or two afterward — a genuinely different
  read path (`git ls-remote` instead of `gh pr view`, `Read`/`Glob`
  instead of `Bash cat`) is a legitimate different action, not a
  workaround for the same blocked outcome.

## What to pick next: TEID-48 and TEID-50 (both E06)

These are the two next board-order, non-provisional, no-decision-needed
stories. (Everything else currently unspecced needs either a business
decision the user hasn't made yet, or a structural prerequisite that
isn't built — see "Everything else is decision-gated" below; don't
wander into any of it without asking first.) **Write `specs/TEID-48.md`
and `specs/TEID-50.md` next**, following `specs/TEMPLATE.md` and the
rigor of `specs/TEID-45.md`/`TEID-47.md` (both written last session — good
recent reference for scoping-notes style and architecture-section depth).
Both belong to E06, previously Grok's phase — per this session's Codex-only
directive, both go to Codex instead this time.

Pull `ac[]`/`tests[]` for both fresh from the live board before writing
either spec (never trust the copy below if the two disagree) — but as of
this handover, here is the exact current catalog for both, to save you
the round trip:

### TEID-48 — Webhooks for billing events (order 67, 5 points, High priority)

> As a developer at our customer, I want webhooks for important billing
> events, so that I can trigger my own emails, in-app messages and upsell
> flows.
>
> *Context*
> Events: threshold reached, balance depleted, grant expiring soon, grant
> expired, reservation overrun, reconciliation mismatch, customer
> suspended.

**AC:**
1. Each webhook is signed so the receiver can verify it came from us.
2. Failed deliveries are retried with increasing delays for at least 24 hours.
3. A delivery log shows every attempt and its response, and any webhook can be resent manually.
4. Each webhook has a unique ID so receivers can ignore duplicates.

**Tests:** T1 (HMAC signature validates, Functional/AC1), T2 (6x HTTP 500
then retry with increasing backoff for 24h+, Functional/AC2), T3 (delivery
log shows attempt/response, manual resend works, Functional/AC3), T4 (a
retried delivery keeps the same event ID, Functional/AC4), T5 (endpoint
unreachable the whole 24h window → marked permanently failed, not retried
forever, Non-functional/AC2), T6 (1,000 deliveries, delivery log UI stays
responsive/searchable, Non-functional/AC3), T7 (forged/unsigned payload
would be rejected by a correct receiver, Adversarial/AC1), T8 (5 rapid
manual resends keep an identical event ID, Adversarial/AC4).

**Real architecture gaps to resolve via scoping notes — checked directly
against the current codebase, not assumed:**
- **"Threshold reached" and "balance depleted" already have a real
  detection mechanism**: TEID-47's `balanceAlertWorker.ts`
  (`services/ts-console/src/lib/balanceAlertWorker.ts`) already computes
  exactly this (`claimSlots`/`evaluateTenant`, a `billing_alert_sent`
  dedup table). The natural design is for TEID-48 to be a **fourth
  delivery channel** alongside TEID-47's existing email/Slack/customer-email
  ones, reusing the same claimed-candidate flow rather than re-detecting
  threshold crossings independently — read that file in full before
  designing this story's own worker.
- **"Grant expiring soon" is only half-built.** `grantWorker.ts`
  (`services/ts-console/src/lib/grantWorker.ts`) has
  `processExpiredGrants` (already-expired) and `processRecurringGrants`/
  `processCommitDrawdowns`, but **no "expiring within N days" advance
  check exists yet** — this story needs to add one, or scope "grant
  expiring soon" out with a documented substitution if that's too much
  new surface for 5 points.
- **"Reconciliation mismatch" already has a real detection mechanism**:
  `services/go-usage/internal/ledger/balance.go`'s
  `balance_integrity_checks` table (TEID-33) and `ledger.go`'s
  `CheckAllTransactionsBalanced` (TEID-32) are exactly this. Hook into
  their existing on-call webhook pattern (`postAlert`) as the trigger
  point, don't reinvent detection.
- **"Reservation overrun" has no real mechanism at all.** `reservations`
  (TEID-32) is explicitly a placeholder table (its own migration comment
  says so), with no "overrun" concept anywhere in the schema or code.
  This needs a genuine scoping-note substitution (the same pattern
  TEID-45 used for "invoices don't exist yet") — do not invent a fake
  overrun check just to make the test pass.
- **"Customer suspended" has no real mechanism at all** — grepped the
  entire `services/ts-console/src` for `suspended`/`customer_status`,
  zero hits. There is no concept of a suspended customer anywhere in this
  codebase yet. This is the biggest scoping gap of the four — decide
  explicitly whether this story adds a minimal real `customers.status`
  column (a small, real, justified extension, matching the session's
  established principle of preferring a small real extension over faking
  a test) or documents this event type as out-of-scope-for-now with a
  clear substitution, the same way TEID-45 handled invoices.

### TEID-50 — Period close summary for finance (order 68, 5 points, High priority)

> As a finance lead, I want a summary at the end of each billing period,
> so that month-end close takes hours instead of a week.
>
> *Context*

**AC:**
1. The summary shows per customer: usage billed, credits consumed by
   source, commit drawn down, overage, expired credits and adjustments.
2. Totals tie exactly to the ledger and to the Stripe reconciliation report.
3. It can be exported as CSV and Excel.

**Tests:** T1 (per-customer row shows all six named columns distinctly,
Functional/AC1), T2 (summary total ties to the ledger AND the Stripe
reconciliation report to the cent, Functional/AC2), T3 (CSV + Excel export
both open, identical figures, Functional/AC3), T4 (50,000 customers, ties
out within a 30-minute close window, Non-functional/AC2), T5 (sortable/
searchable by customer name, Non-functional/AC1), T6 (a late adjustment
after generation either updates consistently or flags for regeneration,
never silently mismatches, Adversarial/AC2), T7 (a zero-activity customer
renders a correct zero row, not an error or a missing row, Adversarial/AC1).

**Real architecture gap to resolve via a scoping note — checked directly:**
grepped for `reconciliation.*report`/`StripeReconciliation` across
`services/ts-console/src`, **zero hits**. **No "Stripe reconciliation
report" feature exists anywhere in this codebase.** TEID-38 only syncs
*customers* with Stripe (`stripe_customer_links`), never invoices or
charges — there is nothing Stripe-side to tie a total to yet (that's
squarely Teideal Verify/E11 territory, not built, and E11 is itself
decision-gated — see below). AC2/T2 as literally written cannot be
satisfied today. This needs the same kind of honest, explicit scoping-note
substitution TEID-45 used for "invoices" — most likely: tie out to the
ledger only for now, and document the Stripe side of AC2 as deferred
until E11/Verify exists, rather than fabricating a fake reconciliation
report or silently dropping half the AC.

### Everything else is decision-gated — do not spec into any of it without asking

- **TEID-97** (multi-currency pricing) — flagged `provisional: true` on
  the board itself; needs a named exchange-rate source before a real spec
  is possible.
- **TEID-98** (Verify connector framework) and all of E11 (`TEID-65`
  onward) — `TEID-98` is `provisional: true` and is a structural
  prerequisite for the rest of E11 by its own description.
- **E14** (open-source the core, `TEID-81`/`82`/`84`) — a real strategic/
  licensing decision, not a routine next-story pick, even though not
  epic-flagged provisional.
- **E16–E19** (SOC 2, data protection, platform reliability, AI
  guardrails) — every story epic-flagged `provisional: true`.

If TEID-48/TEID-50 both land and the user hasn't said what's next,
propose the same four items above explicitly rather than guessing at any
of them.

## Codex handoff mechanics (unchanged mechanically, just the only path this session)

1. Write the spec (`specs/TEID-48.md`, then separately `specs/TEID-50.md`
   — handle sequentially, not concurrently, since you'll be doing all the
   git/verification work yourself for each and Codex needs your active
   attention to commit on its behalf).
2. Commit the spec to `claude/eager-brown-dlqfl4`, push.
3. Open a GitHub issue: title `TEID-XX: <summary> (Codex)`, body links
   the spec by raw GitHub URL
   (`https://raw.githubusercontent.com/tenseur-ai/Teideal/claude/eager-brown-dlqfl4/specs/TEID-XX.md`),
   states the base branch (`claude/eager-brown-dlqfl4`) and the target
   branch name convention (`codex/teid-XX-<slug>`).
4. Write a prompt file (e.g. `C:\Users\kiran\teideal-agents\prompt-teid-48-codex.txt`)
   — use `C:\Users\kiran\teideal-agents\prompt-teid-62-codex.txt` (from
   last session, still on disk) as your structural template: confirm the
   issue via `gh issue view`, read the spec's scoping notes especially
   carefully, list the exact files/design decisions to follow, list every
   cataloged test ID and instruct implementing all of them (functional,
   non-functional, adversarial alike — don't skip the hard ones), instruct
   running the full regression suite the spec's DoD lists, instruct
   writing a `NOTES-TEID-XX.md` for any spec ambiguity resolved, and end
   with: **"stop and report back what you built and tested — do NOT
   attempt to commit, push, or open a PR yourself, your sandbox cannot
   access git internals, and Claude will review your diff and handle
   commit/push/PR on your behalf."**
5. Spawn: `bash scripts/spawn-codex-agent.sh codex/teid-XX-<slug> claude/eager-brown-dlqfl4 C:\Users\kiran\teideal-agents\codex-teid-XX prompt-teid-XX-codex.txt C:\Users\kiran\teideal-agents\codex-teid-XX.log`
   — run in background, expect it to take a while, expect its own
   handback message to plainly state what it could and couldn't verify
   given zero network access.
6. Review the actual diff yourself. Given zero network access this round,
   treat every claim as unverified until you've independently confirmed
   it — this is not optional this session, there is no partial-Codex-
   self-test baseline to lean on at all.
7. Run the full independent-verification procedure below yourself.
8. Fix any real bugs found directly (this is expected, not exceptional —
   budget real time for it, likely more than last session given Codex
   could self-check nothing this round).
9. Commit on Codex's behalf, push, open the PR, reference the issue.
10. `gh pr checks <N>` before merging — see the flake catalog below for
    what a confirmed-unrelated failure looks like versus a real one.
11. Merge, fast-forward `main`, update `docs/parallel-work.md`'s phase
    table (E06's row already exists from TEID-45/47 — append to it, don't
    create a duplicate row) and the live board's `EMBEDDED_STATE` (read
    via `Artifact`, build the update with a small Node script rather than
    hand-editing the blob, validate for apostrophe-stripping — grep the
    built string for mangled contractions like `isnt`/`TEID-62s` before
    publishing, this bit last session twice).
12. Clean up: worktree, container, ports.

## Standard independent-verification procedure (repeat for every story)

1. `git worktree add` (or a fresh clone) into a directory distinct from
   Codex's own working copy at `C:\Users\kiran\teideal-agents\codex-teid-XX`.
2. Fresh, uniquely-named, uniquely-ported Postgres container:
   `docker run -d --name teideal-verify-<name> -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=teideal -p <port>:5432 postgres:16`
   — check `docker ps` first, never touch `teideal-postgres`.
3. `TEIDEAL_PG_CONTAINER=teideal-verify-<name> CI=true PGPASSWORD=postgres PSQL_SUPERUSER=postgres bash db/setup-local.sh`, then both seed scripts, same env vars. **Critical:** no native `psql` exists on this Windows machine — the shim at `C:\Users\kiran\bin\psql` forwards to `docker exec <container>`, defaulting to the **shared** `teideal-postgres` if `TEIDEAL_PG_CONTAINER` is unset, and it drops `-h`/`-p` silently rather than honoring them. Always set the env var explicitly. `CI=true` is required too — without it, `db/setup-local.sh` tries a Unix `sudo -u`, which fails confusingly against Windows's different `sudo.exe`.
4. Build/start whichever services the story touches plus whichever fake
   test doubles its regression suites need, all pointed at your container,
   on fresh ports.
5. Run every suite the spec's DoD lists, `npm ci`/`npm install` each one
   first. **Pass every relevant env var explicitly per invocation** —
   `TS_CONSOLE_URL`, `GO_USAGE_URL`, `FAKE_GOOGLE_URL`, `FAKE_STRIPE_URL`,
   `ADMIN_SECRET`, `SUPERUSER_DATABASE_URL` (defaults to port 5432, wrong
   for a non-default container). Before concluding a failure is a real
   bug, double-check every env var the specific suite's own `env.ts`
   actually reads (`grep process.env` for its defaults) against what you
   passed — this caused several false alarms last session.
6. Read actual pass/fail counts and test names, not exit codes. Read a
   sample of test bodies critically — does each one actually assert what
   its name claims?
7. For anything auth/security-adjacent, actually attack it live.
8. `gh pr checks <N>` before merging; if the PR base has drifted
   (`gh pr view <N> --json mergeable` shows `CONFLICTING`), rebase and
   re-verify before merging.
9. Clean up worktree/container/ports, confirming you're not killing
   another concurrent process on a shared default port.

## Known pre-existing CI flake classes (confirmed diff-unrelated every time; standing sign-off to admin-merge past a confirmed instance)

Shared-runner timing/throughput SLA assertions that miss under load but
pass locally and on rerun. Confirm diff-scope (the failing suite's own
files aren't in the PR's diff) before treating a new failure as one of
these:
- `tests/usage-ingestion/load-test.test.ts` — `TEID-30-T3/T6`, p99 < 200ms.
- `tests/commits/commits.test.ts` — `TEID-19-T6`, balance-read p99 < 100ms.
- SDK overhead — `TEID-59-T6`, p99 < 5ms (seen up to 25.97ms, still confirmed unrelated).
- `tests/grants/grants.test.ts` — `TEID-17-T7`'s eligibility-latency assertion (distinct from its already-fixed throughput assertion).

**One flake turned out NOT to be this class** — `TEID-60-T4` failed
identically twice at ~1.6-1.8x over budget (not marginal jitter). If a
"flake" fails by a large, consistent margin rather than a small one,
suspect a genuine capacity gap instead (same class as tracked issue #37)
and give it a real CI-scoped-budget fix, following the pattern already
used for `TEID-20-T5`/`TEID-22-T5`/`TEID-60-T4` (widen the *default*
budget itself via an env var, don't just raise a one-off timeout).

**A recurring cross-story signal worth expecting again:** TEID-62 built a
genuine CI-gated documentation-coverage checker
(`tests/docs/coverage.test.ts`) that correctly failed CI on the next two
PRs after it purely because each added routes it didn't know about yet.
**If TEID-48 or TEID-50 add any new HTTP route, add its `docs/api/*.md`
entry in the same PR** (format: `## METHOD /path [service]` heading, then
`**Auth:**`/`**Request:**`/`**Response:**`/`**Errors:**` bullets, one
worked `curl` example; link it from `docs/api/README.md`'s resource-group
index) or expect this checker to fail loudly and specifically, naming the
exact undocumented routes.

## Cleanup status

Confirmed immediately before writing this handover: `git worktree list`
shows only the main checkout; no open PRs; `main` and
`claude/eager-brown-dlqfl4` identical at `94ea91d`; only `teideal-postgres`
(shared) and an unrelated `sintius-local-postgres-1` container running.

**Two harmless loose ends, unresolved, low priority:**
- `C:\Users\kiran\teideal-agents\codex-teid-34` and `...\codex-teid-60` —
  already-merged stories' worktrees, already `git worktree prune`d, but
  the physical directories wouldn't delete due to a Windows file-lock
  cause never identified. Pure disk cleanup, not blocking anything.
- Local `main` git branch ref (as opposed to `origin/main`) may still be
  stale if nobody's run `git branch -f main origin/main` — harmless,
  nobody works on local `main` directly.

## One more environment note, unrelated to Codex but still true

`services/go-usage/cmd/server/main.go` needs `import _ "time/tzdata"`
(already present) because Windows has no system IANA tzdata. Go binaries
need an explicit `.exe` extension to run via Bash on this machine. Don't
background an entire `cmd1 && cmd2 && cmd3 &` chain, especially one
containing a `cd` — only the specific long-running command should be
backgrounded, or a subsequent command in the same call runs from the
wrong directory.
