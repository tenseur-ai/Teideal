# Handover: Teideal, solution architect + local orchestrator (session 2026-09-29 → 2026-09-30)

You're picking up as solution architect on **Teideal**, a multi-tenant
usage-based billing platform. Repo: **`tenseur-ai/Teideal`** (GitHub),
local clone at `C:\Users\kiran\Teideal`, branch **`claude/eager-brown-dlqfl4`**
(== `main`, zero divergence as of this writing — confirmed via
`git rev-list --left-right --count origin/main...origin/claude/eager-brown-dlqfl4`
returning `0 0`). This is a continuation, not a fresh start.

**Read in this order:** this file first, then `docs/parallel-work.md` in
full (the living process doc — this handover summarizes and updates it,
but that file is the source of truth if the two ever disagree; it now
runs to well over 500 lines and covers every phase's full history). There
are two older handovers in the repo root, `teideal-handover-2026-09-28.md`
and `teideal-handover-vscode.md` — **this file supersedes both**; nothing
in either is still actionable (their "what's next" sections are all done).

**Live tracking board:** `https://claude.ai/artifact/DHJth2uHYfvARADya6xNeZ`
— note this is a **different URL** than the one cited in the 2026-09-28
handover (`.../839FeX3RzSMymBpPySBYXj`); that one is stale, don't use it.
Always pull a story's exact `ac[]`/`tests[]` from the current board before
writing or reviewing a spec — never from memory or from a spec file's own
possibly-paraphrased copy.

## Your role (non-negotiable, established over many sessions)

You are the **sole solution architect**. You write specs; you do not write
feature code yourself except to fix real bugs found during independent
verification (this happens routinely — see "What's shipped" below for six
examples this session alone). Developer agents (Codex CLI, Grok CLI —
Gemini CLI is still unusable, unchanged from last handover) each own a
whole *phase* (= one epic) and implement strictly from your specs, writing
their own tests.

Ground rules, all still in force:
- Stories within a phase build in the board's `order`, one at a time. One
  agent owns one whole phase, never a slice.
- **Never trust a developer agent's self-reported "all tests passed."**
  Every PR gets independently verified by you before merge: fresh `git
  worktree` (never reuse the agent's own working copy), fresh disposable
  Postgres container, migrations + seeds reapplied from scratch, every
  service actually built and started, every cataloged test suite actually
  run and its output actually read — not just the exit code. For anything
  security-sensitive (an auth change, a new cross-tenant code path), go
  further: mint real credentials and actually attack the thing yourself,
  don't just re-read the code and agree it looks fine. This session found
  a real, previously-uncaught concurrency bug (TEID-47, see below) and a
  real role-guard gap (TEID-45) exactly this way — reading the code alone
  would not have caught either.
- **You have standing merge authority**: once independent verification
  passes, merge yourself, no separate human click required for a clean
  merge. Admin-merging **past a failing CI check** requires the failure to
  be a confirmed, diff-unrelated instance of an already-documented flake
  class (see the flake catalog below) — check the actual log signature,
  don't assume. A genuinely new failure, or a security-sensitive PR, gets
  a real fix before merge, not an override.
- Every commit ends with `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`;
  every PR body ends with the Claude Code footer. Use whatever this
  session's own system-reminder gives you verbatim — it can change
  between sessions, don't copy an old one from this file.
- Fast-forward `main` to match the working branch after every merge,
  without asking, once you've confirmed it's a clean fast-forward. **This
  session it kept needing re-syncing** because parallel PRs kept landing
  on `claude/eager-brown-dlqfl4` while `main` lagged — a plain
  `git push origin claude/eager-brown-dlqfl4:main` fails non-fast-forward
  the moment the two branches' *commit hashes* diverge even when their
  *content* doesn't (e.g. a fix cherry-picked onto one side and merged
  into the other independently). If that happens: confirm with `git diff
  <a> <b> --stat` that the divergent side has zero unique content, then
  either `git merge --no-edit` the other branch in and push the merge
  commit, or (only if you're certain no content would be lost and a
  non-destructive merge genuinely isn't warranted) ask before
  force-pushing `main` — the auto-mode classifier will block a bare
  force-push to `main` as "Git Destructive" regardless, so a merge commit
  is the actual path forward, not a workaround.
- Independent-verification subagents you dispatch must clean up their own
  Docker containers/processes/worktrees when done, and must never reuse
  the shared `teideal-postgres` container. Brief every one explicitly
  about the `psql` shim gotcha below — it bit an independent verifier this
  session before being caught.

## Environment gotchas (all confirmed this session, several hit repeatedly)

- **`psql` shim, `C:\Users\kiran\bin\psql`, silently defaults to the
  shared container.** No native `psql` exists on this Windows machine;
  the shim forwards every call to `docker exec <container>`, where
  `<container>` is `$TEIDEAL_PG_CONTAINER` or, if unset, **the shared
  `teideal-postgres` container** — and it drops `-h`/`--host` entirely, so
  passing `-h 127.0.0.1 -p <port>` does **not** override it; only the env
  var does. **Always set `TEIDEAL_PG_CONTAINER=<your-own-container-name>`
  before running `db/setup-local.sh` or any seed script**, or you will
  silently run migrations/seeds against the shared container — which, if
  another agent has a concurrent verification pass running, corrupts its
  state. This happened once this session (an independent verifier's first
  pass), was caught before real damage, but remains a standing risk for
  any future pass that forgets the env var. Consider fixing the shim
  itself (respect `-h`/`-p`, or fail loudly instead of silently defaulting)
  if this keeps recurring.
- **`db/setup-local.sh` branches on `CI=true`** to avoid a Windows-
  incompatible `sudo -u $PSQL_SUPERUSER` path (Windows has `sudo.exe` as a
  *different* program with different flags, which fails confusingly on
  `-u`). Always pass `CI=true PGPASSWORD=postgres` when running it or any
  seed script locally, not just in actual CI.
- **Test suites need every relevant env var passed explicitly per run** —
  there is no shared "current isolated environment" state between
  separate `Bash`/`vitest run` invocations. This session repeatedly lost
  time to forgetting one of: `TS_CONSOLE_URL`, `GO_USAGE_URL`,
  `FAKE_GOOGLE_URL`, `FAKE_STRIPE_URL`, `ADMIN_SECRET`,
  `SUPERUSER_DATABASE_URL` (defaults to port 5432, wrong for any
  non-default container port) for a *specific* test suite, causing
  confusing 401/404/ECONNREFUSED failures that looked like real bugs
  until re-run with the correct env. **Before concluding a test failure is
  a real bug, double-check every env var the specific suite's own
  `env.ts`/`env.go` actually reads** (`grep` for `process.env`/`os.Getenv`
  defaults) against what you actually passed.
- **Go binaries need an explicit `.exe` extension** to run on Windows via
  Bash. `import _ "time/tzdata"` remains mandatory in
  `services/go-usage/cmd/server/main.go` (unchanged from before).
- **Codex's sandbox (`-s workspace-write`) still cannot commit its own git
  work** (confirmed again this session, unrelated new evidence) **and, new
  this session: it has zero outbound network access at all** — no GitHub
  (`gh issue view` fails with a raw `ECONNREFUSED`-style socket error), no
  npm registry, no Docker/Postgres. It can still read local files fine
  (the spec is already checked out), so it can still implement correctly,
  but **cannot verify anything itself** — expect it to hand back
  plausible-looking work it has never actually run, and expect real bugs
  in it that only your own independent verification will catch (this
  session: a broken npm dependency pin that made `npm install` fail
  outright, and a genuine accessibility violation in hand-rolled Markdown
  rendering — neither would show up from reading the diff alone). Codex
  is honest about this limitation in its own handback message and
  `NOTES-TEID-XX.md` — take "I could not run this" at face value and
  budget real verification time accordingly, more than usual.
- **`grok` (`$HOME/.grok/bin/grok.exe`) continues to reliably commit,
  push, and open its own PRs unassisted**, unsandboxed. It sometimes
  auto-compacts mid-run on a long story (visible in its own log output as
  "Auto-compacting conversation (80% full)...") and its final log tail can
  end abruptly without a clean wrap-up message even when it did
  successfully finish, commit, and open a PR — **always check
  `gh pr list --head <branch>` directly rather than trusting the log's
  last visible line** if the log looks cut off.
- **The Claude Code auto-mode classifier blocks `gh pr merge --admin`**
  (an admin override past a failing check) as "Merge Without Review,"
  correctly — this is a genuine guardrail, not a bug, and should not be
  routed around. It can also start blocking **unrelated subsequent
  commands** (including plain read-only ones) for a turn or two afterward
  — if that happens, a *different* read path (`git ls-remote` instead of
  `gh pr view`, `Read`/`Glob` instead of `Bash cat`) is a legitimate,
  different action, not a workaround for the same blocked outcome, and
  typically goes through fine.
- **Don't background an entire `cmd1 && cmd2 && cmd3 &` shell chain**,
  especially one containing a `cd` — only the specific long-running
  command should be backgrounded (via the tool's own `run_in_background`,
  or a separate call with its own explicit `cd`), or a subsequent command
  in the same call runs from the wrong directory.

## Standard independent-verification procedure (repeat for every story)

1. `gh pr checkout <N>` or `git worktree add` into a **fresh directory**
   distinct from the developer agent's own worktree (e.g.
   `../teideal-agents/verify-<name>`, or the agent's own dir if you're
   certain nothing else is using it concurrently).
2. Fresh, uniquely-named, uniquely-ported Postgres container:
   `docker run -d --name teideal-verify-<name> -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=teideal -p <port>:5432 postgres:16`
   — check `docker ps` first and pick a port nothing else is using; **never** reuse or touch `teideal-postgres`.
3. `TEIDEAL_PG_CONTAINER=teideal-verify-<name> CI=true PGPASSWORD=postgres PSQL_SUPERUSER=postgres bash db/setup-local.sh`, then `db/seed-test-fixtures.sh` and `db/seed-console-auth-fixtures.sh`, same env vars.
4. Build/start whichever of `services/go-usage` (`go build -o .tmp-run/go-usage-<name>.exe ./cmd/server`, run with a fresh `PORT`) and `services/ts-console` (`npm install && npm run build && node dist/server.js`, full env var list — see the gotcha above) the story touches, plus whichever fake test doubles its regression suites need (fake-google, fake-s3, fake-stripe), all pointed at your container, all on fresh ports.
5. Run every suite the story's spec's "Definition of done" lists, `npm ci`/`npm install` each one first. **Read the actual pass/fail counts and test names, not just the exit code** — and read a sample of the test bodies critically: does each one actually assert what its name claims, or could it pass vacuously?
6. For anything auth/security-adjacent: mint real credentials (a real session login, a real API key) and actually attack the boundary yourself — cross-tenant reads, scope escalation, malformed input — don't just confirm the cataloged adversarial tests pass.
7. `gh pr checks <N>` before merging (or `gh run view <id> --log-failed | grep -E "FAIL |AssertionError"` on a specific run). On any failure, check the actual log signature against the flake catalog below before assuming it's unrelated — and if the PR's base has drifted (`gh pr view <N> --json mergeable` shows `CONFLICTING`), rebase (`git rebase origin/<base>`) and re-verify before merging, not just before pushing.
8. Merge (`gh pr merge <N> --squash --admin` once you've confirmed either a clean pass or a confirmed-unrelated flake), then fast-forward `main` (see the ground rule above about this needing a merge commit if the two branches have diverged in commit-hash terms even with identical content).
9. Update `docs/parallel-work.md`'s phase table (a full paragraph per story: what it does, real gaps found and fixed, exact regression counts, exact flake handled) and the live board's `EMBEDDED_STATE` (read via the `Artifact` tool's `read` action, build the updated JSON with a small Node script rather than hand-editing the giant single-line blob, republish with the same `url`). **Watch for apostrophes** getting silently stripped if you build the update string through a shell heredoc — validate the published JSON parses and grep the text for any mangled contraction (`isnt`, `wont`, `TEID-62s`) before/after publishing; this happened twice this session and was caught by exactly this check.
10. Clean up: remove the worktree, stop/remove the container, kill the specific ports you started (verify you're not killing another concurrently-running verification's process on a shared default port first).

## What's shipped this session (all independently verified + merged)

Seven stories landed, in this order: **TEID-34** (late-arriving events,
Codex, completed by the architect after Codex hit an early usage-window
reset — batch-ingestion closed-period gap found and fixed), **TEID-60**
(sandbox environment, Codex, same pattern — a missing `UPDATE` grant, a
one-sandbox-per-tenant test-fixture bug, later narrowed further by a
verifier to a single-column grant), **TEID-23** (versioned pricing, Grok,
unassisted — missing CI wiring and an unenforced throughput assertion
fixed), **TEID-74** (processor-neutral ledger, Grok, unassisted — clean
verification, zero follow-up fixes needed, the only story this session
like that), **TEID-62** (docs/quick-start, Codex, zero network access
this round — a broken dependency pin and a real accessibility bug fixed),
**TEID-47** (balance threshold alerts, Grok, unassisted — **a real
concurrency bug**: the original code delivered a real alert *before*
claiming its dedup row, so two overlapping evaluation ticks could both
deliver the same alert; reproduced directly with 5 concurrent calls
sending 5 real Slack messages despite only 1 DB row, fixed by reversing
the order to claim-then-deliver), and **TEID-45** (customer timeline,
Grok, unassisted — a security-sensitive session-token auth change was
specifically attacked, not just read, and confirmed sound; a real but
non-exploitable role-guard gap found and fixed). Full detail, exact PR
numbers, exact merge commits, and exact regression counts for every one
of these are in `docs/parallel-work.md`'s phase table — don't duplicate
that level of detail here, go read it.

**A real, recurring cross-story integration signal, worth knowing about
before it surprises you again:** TEID-62 built a genuine, CI-gated
documentation-coverage checker (`docs/api/check-coverage.ts`, run via
`tests/docs/coverage.test.ts`) that introspects both services' actual
live route registrations and fails if any route lacks a `docs/api/*.md`
entry. It correctly failed CI on **both** of the next two PRs (TEID-47,
TEID-45) purely because each added new routes that didn't exist when
TEID-62 wrote its docs — this is the checker doing exactly its job, not a
flake. **Any future story that adds a new route should add its
`docs/api/*.md` entry in the same PR**, following the established
per-route format (`## METHOD /path [service]` heading, then
`**Auth:**`/`**Request:**`/`**Response:**`/`**Errors:**` bullets, then one
worked `curl` example) — check `docs/api/README.md`'s resource-group
index for where a new file should be linked, and expect
`tests/docs/coverage.test.ts` to fail loudly and specifically (it names
the exact undocumented routes) if you forget.

## Known pre-existing CI flake classes (confirmed diff-unrelated every time; standing user sign-off to admin-merge past a confirmed instance)

All of these are shared-runner timing/throughput SLA assertions that miss
under GitHub Actions load but pass clean locally and on a rerun. Confirm
diff-scope (the failing suite's files aren't in the PR's own diff) before
treating a new failure as one of these rather than a real regression:
- `tests/usage-ingestion/load-test.test.ts` — `TEID-30-T3/T6`, p99 < 200ms. Hit repeatedly this session (values 237-772ms).
- `tests/commits/commits.test.ts` — `TEID-19-T6`, balance-read p99 < 100ms. Hit this session at 202.6ms.
- SDK overhead — `TEID-59-T6`, p99 < 5ms. Hit this session up to 25.97ms (unusually large miss, still confirmed diff-unrelated and cleared on rerun).
- `tests/grants/grants.test.ts` — `TEID-17-T7`'s eligibility-latency assertion (a *different* assertion in the same test than the one that already has a `{retry: 2}` fix for its throughput assertion) — hit once this session (111-167ms vs a 100ms budget), not yet given its own scoped fix; consider doing so if it recurs, following the established `TEID-20-T5`/`TEID-22-T5` CI-scoped-budget pattern.

**One flake this session turned out NOT to be this class** —
`TEID-60-T4` (sandbox production-latency-under-load) failed identically
twice at ~1.6-1.8x over its 2000ms budget (3587ms, 3213ms), a much larger
and more consistent miss than the marginal jitter above. Root-caused as a
genuine GitHub-Actions-runner-capacity gap (same underlying class as the
already-tracked issue #37/`TEID-22-T5`), fixed for real: default budget
widened to 6000ms via a `SANDBOX_PROD_LATENCY_BUDGET_MS` env var (the
tighter 2000ms number still available for a dedicated manual run). If a
"flake" keeps failing by a large, consistent margin rather than a small
one, suspect this class instead and give it a real CI-scoped-budget fix
rather than repeatedly admin-merging past it.

## Cleanup status — mostly clean, two known loose ends

1. **Confirmed clean:** `git worktree list` shows only the main
   checkout; no open PRs (`gh pr list --state open` returns empty);
   `main` and `claude/eager-brown-dlqfl4` are identical; only
   `teideal-postgres` (shared) and an unrelated `sintius-local-postgres-1`
   container are running — no dangling verification containers.
2. **Two leftover directories, safe to ignore or clean up when
   convenient:** `C:\Users\kiran\teideal-agents\codex-teid-34` and
   `...\codex-teid-60` — both already-merged stories' worktrees, already
   `git worktree prune`d (git itself has no record of them), but the
   physical directories wouldn't delete due to a Windows file-lock
   ("Device or resource busy" on subdirectories like `tests/ledger`,
   `tests/console-auth`) from some still-open handle, cause not
   identified. Pure disk-space cleanup, not blocking anything — retry
   `rm -rf` on them, or investigate what's holding the lock, whenever
   convenient. Do not force-kill unlabeled `node.exe`/other processes to
   free them without confirming what each one actually is first — several
   unlabeled Node processes were observed running on this machine this
   session (likely unrelated editor/tooling processes) and were
   deliberately left alone rather than risk killing something the user
   needs.
3. **The live board's per-viewer state lives in the published Artifact's
   `EMBEDDED_STATE` blob, not in this repo's `index.html`.** `index.html`
   in the repo is a separate, older static copy with its own `DATA` catalog
   and localStorage-based state — it is **not** what `docs/parallel-work.md`
   or this handover mean by "the board." Always read/write the board via
   the `Artifact` tool against the URL above, never by editing
   `index.html`.

## What's next — real decisions needed before proceeding, plus one ready-to-go option

**Ready to hand off with no decision needed:** E06 (operator visibility)
has two more non-provisional, fully-specifiable stories queued in board
order right after TEID-45/47 — **TEID-48** (webhooks for billing events,
order 67) and **TEID-50** (period close summary for finance, order 68).
Neither needs a business decision or external integration choice. If the
user wants Grok's next batch, these are the natural continuation — write
specs following `specs/TEMPLATE.md` and the rigor of `specs/TEID-45.md`/
`TEID-47.md` (both written this session, good recent reference for
scoping-notes style and architecture-section depth), open GitHub issues,
spawn via `scripts/spawn-grok-agent.sh`.

**Needs an explicit user decision before speccing (each surfaced and
deliberately left alone this session, not oversights):**
- **TEID-97** (multi-currency pricing) — flagged `provisional: true` on
  the board itself; the spec would need a named exchange-rate source
  (the board's own test catalog names "ECB-daily" as an example, not a
  commitment) before implementation could start for real.
- **TEID-98** (Verify connector framework) and everything under E11
  (`TEID-65` onward) — `TEID-98` is itself `provisional: true` and is a
  structural prerequisite for the rest of E11 (its own desc says so:
  "Prerequisite for the Metronome, Orb and Lago connectors"); starting
  anywhere in E11 before that's unblocked would be architecturally
  backwards.
- **E14** (open-source the core, `TEID-81`/`82`/`84`) — not provisional
  on the board, but genuinely starting this means actually beginning to
  publish core ledger/pricing code publicly, a real strategic/licensing
  decision, not a routine next-story pick.
- **E16-E19** (SOC 2, data protection, platform reliability, AI
  guardrails) — every story epic-flagged `provisional: true`. Treat that
  flag as the board's own signal that these aren't confirmed ready for
  implementation yet; don't spec into them without the user explicitly
  saying the provisional status is resolved.

If the user hasn't said what's next yet, the reasonable default (matching
this session's own pattern) is: propose TEID-48/TEID-50 for Grok as the
no-decision-needed option, and ask specifically about the four
decision-gated items above rather than guessing at any of them — each is
a real fork in the product/business direction, not just an engineering
judgment call.
