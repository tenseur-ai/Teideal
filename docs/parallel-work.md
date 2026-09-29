# How this backlog gets built: one architect, several developers

Two kinds of role, not a fixed number of implementers:

- **Claude (solution architect).** Owns every architecture decision, writes
  a self-contained spec for each story before it's built, independently
  verifies every PR before calling it done, merges it, and does the
  consolidated review at the end of each phase. Does not write feature
  code.
- **Developer agents** (currently Codex, Gemini, and Cursor/Grok -- each
  owns a separate phase, never a slice of one). Each implements its
  assigned phase's stories strictly from spec, writes the unit tests the
  spec calls for, and opens a PR. Doesn't need to consult the live board
  directly -- the spec is the complete contract.

A **phase is one epic.** Stories within a phase are still built in the
backlog's `order`, one at a time, each proved against its own tests
before the next starts -- the "don't jump ahead" rule now applies within
a phase rather than globally. Once every story in a phase is implemented
and green in CI, Claude does one consolidated review of the whole phase
(architecture conformance, security/isolation, code quality, and that
every cataloged test -- functional, non-functional, adversarial -- really
is covered), then syncs the live board for that phase's stories.

**Each developer agent owns a whole phase, never a slice of one.**
Splitting the *stories within* a phase across two agents would break the
"build in order within the phase" rule -- a later story often depends on
an earlier one's schema/endpoints (e.g. TEID-92 extends TEID-41's
`api_keys` table). Splitting *phases* across agents has no such problem
as long as the phases were chosen for minimal file overlap in the first
place (E05 lives almost entirely in `services/ts-console`; E03 lives
almost entirely in `services/go-usage`; E01 (assigned below) is also
`services/ts-console` but a structurally separate set of files from E05
-- new tables and routes for plans/grants/commits/overrides, nothing in
`lib/roleGuard.ts`, `routes/users.ts`, `routes/auth.ts`, or the other
files E05 owns -- see "Current phases" below). When bringing in a new
developer agent, give it a phase with no developer agent currently
assigned, not a share of one already in progress.

## Claude's branch

Claude's own branch name is **session-specific and changes** (the
Claude Code harness assigns a fresh branch name per session, e.g.
`claude/eager-brown-dlqfl4` as of this writing, `claude/upbeat-cerf-c48vx0`
before it). Specs and doc updates always land on whatever Claude's
*current* session branch is -- check the live board or ask if it's not
obvious from context, don't assume a name from an old doc revision or an
old spec's header stays valid. Developer agents base their branch off
Claude's *current* branch (never `main` directly, never each other's
branch) so a freshly written spec is visible immediately, without
waiting on a PR merge.

## How work gets handed to a developer agent (GitHub-issue based)

**As of TEID-44/TEID-94/TEID-16 onward**, Claude hands off each story as
a GitHub issue instead of relaying spec text through the user in chat:

1. Claude writes `specs/TEID-XX.md`, commits it to Claude's current
   branch, and pushes.
2. Claude opens a GitHub issue titled `TEID-XX: <summary> (<agent>)` whose
   body links to the committed spec file (on Claude's branch, by raw
   GitHub URL so it resolves even before any PR exists) and states the
   base branch to build from and target with the PR.
3. Whoever operates that agent points it at the issue number instead of
   receiving pasted spec text -- the issue is the complete, addressable
   handoff; nothing about the spec itself needs to travel through chat
   again.

**Important limitation, checked directly against this repo's GitHub
collaborators as of 2026-09-27: no GitHub App or bot account for Codex,
Gemini, or Cursor/Grok is currently installed on this repository** (the
only collaborator is the human owner). This means opening an issue does
*not* automatically wake any agent today -- a human (or that vendor's own
automation, if configured on their end outside this repo) still has to
tell the agent "work issue #N." If any of these tools ships a GitHub App
that can be installed on this repo with issue-watching access, installing
it (a repo-owner action, not something Claude can do from inside the
repo) would close that last manual step. Until then, the issue format
still removes the actual friction that existed before: no spec text or
verification feedback gets manually retyped or relayed by the user --
only "go look at issue #N" or "go look at the PR" does.

## Local CLI invocation (alternate handoff, confirmed 2026-09-27)

As of this session, Claude runs locally (Claude Code launched from VS
Code), which means -- for the first time -- Claude has real shell access
to the three developer-agent CLIs already installed on this machine.
This adds a second way to hand off a story, alongside (not replacing)
the GitHub-issue handoff above: invoke the CLI directly as a subprocess,
drive it, review what it produced, rather than posting an issue and
waiting for a human to point an agent at it. Which path to use for a
given story is a judgment call, not a hard rule.

Confirmed installed, versions as of this writing:
- **Codex** (`codex`, CLI 0.157.1) -- on this session's PATH.
- **Gemini** (`gemini`, CLI 0.61.0) -- on this session's PATH.
- **Grok** (`grok`, CLI 1.0.41) -- **not on this session's shell PATH**
  (neither the Bash tool's nor PowerShell's); installed at
  `C:\Users\kiran\.grok\bin\grok.exe`. Invoke by full path, or add that
  directory to PATH first.

Non-interactive ("headless") one-shot invocation, confirmed from each
tool's own `--help` (not yet run end-to-end against a real story as of
this writing -- confirm the full loop, especially git/PR behavior below,
before relying on it for real work):
- **Codex**: `codex exec [OPTIONS] [PROMPT]` (alias `codex e`). Key
  flags: `-C/--cd <DIR>` sets the working root, `-s/--sandbox
  <read-only|workspace-write|danger-full-access>` bounds what it can do
  (there's no separate approval prompt in `exec` mode -- sandbox mode
  *is* the control), `--json` streams JSONL events, `-o
  /--output-last-message <FILE>` captures the final message,
  `--worktree` runs in a new managed git worktree instead of the given
  directory.
- **Gemini**: `gemini -p "<prompt>" [--include-directories DIR]
  [--approval-mode default|auto_edit|yolo|plan] [-o/--output-format
  text|json|stream-json]`. `-p` is what makes it headless -- without it,
  `gemini [query]` launches the interactive TUI with the query as the
  initial prompt instead of exiting after one response. `-w/--worktree`
  runs it in a new git worktree.
- **Grok**: `grok -p "<prompt>" --cwd <DIR> [--always-approve]
  [--permission-mode
  default|acceptEdits|auto|dontAsk|bypassPermissions|plan]
  [--output-format plain|json|streaming-json|streaming-messages-json]`.
  (`-p/--single` is the top-level one-shot flag, the analogue of the
  other two tools' headless mode; `grok agent headless`/`grok agent
  stdio` are a separate, session/relay-oriented integration path, not
  needed for a simple one-shot invocation.) `-w/--worktree` again runs
  it in a new git worktree.

**Git/PR behavior -- none of the three CLIs has a dedicated "open a PR"
flag** in its `--help` output. All three just run as an agent with
shell access inside the given working directory/sandbox; if a PR gets
opened, it's because the agent itself chose to invoke `git`/`gh` as a
tool call, which needs `gh` authenticated in that environment and a
sandbox/permission mode permissive enough to let it run.

**Confirmed end-to-end, three real stories in (TEID-44 and TEID-94 via
Codex, TEID-16 via Grok):**
- **Codex, run with `--sandbox workspace-write`, cannot commit its own
  work at all -- confirmed on both a `git worktree` checkout and a full
  clone, which rules out "the worktree's `.git` lives outside the
  sandbox" as the actual cause.** First finding (TEID-44, TEID-94): on a
  worktree checkout, `git commit` fails creating `index.lock` at
  `<main-repo>/.git/worktrees/<name>/`, outside the sandboxed workdir --
  and passing `--add-dir "<main-repo>/.git"` does not fix it, despite the
  startup banner confirming the sandbox accepted that path as writable.
  Second finding (a deliberate, minimal test after TEID-16/TEID-94
  shipped): switching Codex to a **full clone**, whose `.git` directory
  is entirely self-contained *inside* the sandboxed workdir with nothing
  external to grant, **still fails the identical way** -- a normal file
  at the clone root was created without issue in the same run, but
  `git add`/`git commit` still got "Permission denied" creating
  `.git/index.lock`. Since both the worktree-external-metadata theory and
  the fix for it are now ruled out by that second test, the actual cause
  looks like Codex's sandbox denylisting `.git` paths specifically as a
  category, regardless of `--sandbox workspace-write`'s general workdir
  grant -- most plausibly intentional (stopping a sandboxed agent from
  touching version-control internals directly, e.g. rewriting history or
  hiding a commit), not a bug. **Don't spend more time trying to
  configure around this.** Claude reviews Codex's diff and commits it
  after every run, on this platform -- treat that as a permanent step in
  the process, not a workaround to eventually remove. `scripts/
  spawn-codex-agent.sh` codifies the working parts of this (worktree
  setup, the npm-cache fix below) without re-attempting the disproven
  clone workaround.
- **The npm-cache-in-a-nested-directory failure (a separate, unrelated
  issue that also hit Codex on both TEID-44 and TEID-94) does have a
  real fix**: pin npm's cache via the `npm_config_cache` **environment
  variable** when launching `codex exec`, not a `.npmrc` file. npm only
  reads a project `.npmrc` from the exact current working directory, not
  parent directories, so a `.npmrc` at the worktree root never helped
  `npm install` running inside a nested `tests/<name>/` directory with
  its own `package.json` -- Claude had to rediscover and patch this by
  hand, per-directory, every time. An env var applies to every npm
  invocation in the whole process tree regardless of cwd depth, so this
  class of failure shouldn't recur. `scripts/spawn-codex-agent.sh` sets
  this by default.
- **Grok, run with no `--sandbox` flag (so no sandboxing at all) and
  `--permission-mode bypassPermissions`, commits, pushes, and opens its
  own PR successfully**, unassisted, referencing the handoff issue number
  as instructed. No git-access workaround needed -- the absence of a
  sandbox is exactly why.
- **Gemini was never actually tested end-to-end this round** -- its
  personal/free Google OAuth login is deprecated for this CLI version
  (`IneligibleTierError`, redirects to a separate "Antigravity" product)
  and it has no working headless auth without a `GEMINI_API_KEY`, which
  wasn't available. TEID-94 was reassigned to Codex instead once Codex's
  usage quota reset. Revisit Gemini once an API key is available.

Given none of the three self-manages branches, the practical pattern for
a local-CLI-driven story: Claude creates the agent's branch first
(`git checkout -b codex/teid-44-full-export` off Claude's current
branch, per the existing branch-naming convention), invokes the CLI with
`--cd`/`--cwd` pointed at that checkout (or that tool's `--worktree`/`-w`
flag, to run in an isolated git worktree instead of the main checkout --
useful for running more than one agent concurrently without them
stepping on each other's working tree), then handles commit/push/PR
itself if the CLI didn't already. Independent verification before merge
(see below) applies exactly the same regardless of which handoff path
produced the PR -- a local CLI feeling more directly observed than a
cloud one is not a reason to skip it.

## The per-story loop

1. **Claude** pulls the story's exact `ac[]` and `tests[]` from the live
   board (never from memory) and writes `specs/TEID-XX.md` following
   `specs/TEMPLATE.md`. This includes any scoping decisions needed because
   an AC or test references something not built yet (common early in a
   phase) -- those decisions are made and written down here, not left for
   the developer to guess.
2. Claude commits the spec to its current branch (see above), pushes, and
   opens the handoff issue described above.
3. **The developer agent assigned to that phase bases its branch on
   Claude's current branch**, prefixed by agent name
   (`codex/<story-slug>`, `gemini/<story-slug>`, `grok/<story-slug>` or
   `cursor/<story-slug>`) so agents' branches never collide even if they
   touch the same filename in passing. The agent implements the story
   strictly against the spec, with the automated tests the spec's
   per-test guidance describes, and opens a PR against Claude's current
   branch referencing the TEID key(s), with a short checklist mapping
   each test ID to where it's covered. If a spec seems wrong, incomplete,
   or blocked by something missing, the agent says so instead of
   improvising past it -- this has already caught several real gaps
   before any code was written; keep doing it.
4. CI gates the PR the same way it gates everything else in this repo
   (see `.github/workflows/ci.yml`) -- it must be green before merge.
5. **Claude independently verifies before merging -- never on the
   agent's self-report.** Pull the branch into a fresh git worktree
   (under `/home/user/`, not the scratchpad path -- the `postgres` OS
   user can't traverse into it), drop and rebuild the `teideal` Postgres
   database from scratch via `db/setup-local.sh` plus every seed script,
   build and run the actual services, run every claimed test suite (the
   one this story added *and* every pre-existing suite its changes could
   plausibly touch -- this has caught real regressions and even a
   would-be-broken CI step that self-reports missed), and spot-check
   that the test assertions are substantive, not tautological.
6. **Once verification passes, Claude merges the PR itself** (explicit
   standing authorization from the user, granted 2026-09-27) -- no
   separate human click required. If verification finds something real,
   Claude sends it back to the agent (as a PR comment when useful for the
   agent's own tooling to see, and/or directly) and re-verifies the fix
   the same way before merging; this loop repeats until it's actually
   clean, not until an agent says it is.
7. Repeat for the next story in that phase's order.

## The per-phase (epic) loop

Once every story in a phase is merged and green:

1. **Claude** reviews the whole phase as a unit against
   `specs/TEID-XX.md` for each of its stories: does the implementation
   match the spec's intent, does it hold up architecturally next to the
   rest of the system, is there anything a per-story view would miss
   (e.g. two stories in the same phase touching the same table in ways
   that don't quite compose)? Findings go back to the developer agent as
   spec addendums for anything substantial; trivial fixes may be made
   directly.
2. Once the phase is clean, Claude syncs the live board (the published
   claude.ai artifact's `EMBEDDED_STATE`) marking the phase's stories
   Done, with a history entry naming what was independently verified.
3. Move to the next phase -- which may mean assigning that agent a new
   phase, or nothing further if all currently-staffed phases are done.

Two or more phases can be mid-review at overlapping times if their
developer agents finish around the same time -- review each
independently, in whatever order they finish. Once several phases are
merged into Claude's branch, Claude fast-forwards `main` to match (a
clean fast-forward as long as `main` hasn't diverged -- check with
`git merge-base --is-ancestor origin/main origin/<claude's current branch>`
before assuming that still holds; this has been done after every merge
so far and `main` has never diverged).

## Shared resources and how to avoid stepping on them

- **Branches.** Each developer agent works on its own branch(es),
  prefixed by agent name, never on Claude's or another agent's. All merge
  into Claude's current branch via PRs, and Claude alone fast-forwards
  `main` afterward.
- **`specs/`.** Written and owned by Claude. Developer agents read them,
  don't edit them.
- **`db/migrations/`.** Filenames are timestamp-prefixed
  (`YYYYMMDDHHMMSS_description.sql`), not sequentially numbered --
  generate the prefix with `date -u +%Y%m%d%H%M%S` when adding one. This
  is what stops migrations added around the same time (by the same agent
  or different ones) from colliding on the same filename.
  `db/setup-local.sh` applies every file in the directory in sorted
  (chronological) order. Never edit a migration that's already merged to
  fix something -- add a new one instead.
- **`.github/workflows/ci.yml`.** Agents will occasionally add a step
  here for their phase's new test suite. Expect the occasional small
  manual merge conflict when two agents' PRs land close together --
  normal, not a sign something went wrong (this has happened for real,
  between TEID-43 and TEID-30, and resolved cleanly), and resolved the
  same way regardless of how many agents are contributing.
- **`tests/cross-tenant`.** This is the standing "every documented API
  endpoint" regression suite (TEID-41-T2) -- it is not owned by one
  phase. Any story in any phase that adds an endpoint reachable by an
  authenticated caller adds that endpoint's cross-tenant case here, not
  only to its own phase's test directory. Every agent's spec should call
  this out explicitly when it applies (TEID-92's and TEID-43's specs do,
  as examples to follow).
- **The live tracking board** (the published claude.ai artifact's
  `EMBEDDED_STATE`). Claude owns syncing this -- no developer agent has
  publish access to it.
  **Current URL: `https://claude.ai/artifact/DHJth2uHYfvARADya6xNeZ`**
  (republished 2026-09-28 -- the previous board, referenced in earlier
  handover docs as `.../839FeX3RzSMymBpPySBYXj`, became unreadable this
  session: it resolved as owned by a different account than this
  session's, with no write access and only a lossy isolated-summary read.
  The board's source app (`index.html`/`app.js`, uses the Artifact tool's
  `artifact` capability to republish itself on every edit) lives on the
  `claude/adoring-wright-lu1uyw` branch, a separate line of work from the
  feature branches -- its `window.DATA` seed (all epics/stories/ac/tests)
  was reused as-is; `window.EMBEDDED_STATE` was rebuilt from the user's
  "Export progress" download plus this session's own completions
  (TEID-19, TEID-31) folded in, and republished as a fresh artifact this
  session owns. **If this session's own board access ever breaks again**,
  the fix is the same: pull `index.html`/`app.js` from
  `claude/adoring-wright-lu1uyw`, get current progress via that board's
  own "Export progress" button (or reconstruct from this doc's phase
  tables if that's unavailable too), splice the JSON into
  `window.EMBEDDED_STATE=...;` in place of its `null`, and republish with
  `capabilities: {artifact: {}}`.

## Current phases

| Phase (epic) | Spec author | Developer agent | Status |
|---|---|---|---|
| E05 -- tenant isolation, access control, data ownership | Claude | Codex | TEID-41, TEID-91 done (built directly by Claude before this process existed); TEID-42 done (PR #1 merged); TEID-92 done (PR #2 merged, independently verified); TEID-43 done (PR #3 merged, independently verified against a from-scratch DB rebuild -- rbac 8/8, cross-tenant 23/23, console-auth 13/13, audit-log 7/7, api-keys 9/9); TEID-44 done (PR #5 merged -- first story driven via the local-CLI path; Codex got 6/8 tests green before exhausting its usage quota, Claude finished it (re-pinned a broken `@dsnp/parquetjs` release, fixed a Windows-checkout CRLF bug caught during verification), independently verified against a from-scratch DB rebuild and again on GitHub Actions -- data-export 8/8, cross-tenant 27/27, console-auth 13/13, audit-log 7/7, api-keys 9/9, rbac 8/8); no further E05 stories currently cataloged beyond this -- check the live board for anything added since |
| E03 -- usage ingestion and exactly-once ledger | Claude | Gemini (TEID-30), Codex (TEID-94/TEID-95, reassigned -- see below) | TEID-30 done (merged into Claude's branch, independently verified twice -- once per-branch, again post-merge alongside TEID-43 against a from-scratch DB rebuild); TEID-94 done (PR #9, merged as `946d3b3` -- Codex implemented after Gemini's auth turned out to be broken, see "Gemini auth" note below; independently verified against a from-scratch DB rebuild and again on GitHub Actions -- currency-rounding 9/9, usage-ingestion 7/7 in isolation); TEID-95 done (PR #12, merged as `97e9fe0` -- retrofits `usage_events.quantity`'s float64 handling to `decimal.Decimal` end-to-end, the change TEID-94 deliberately deferred; independently verified against a from-scratch DB rebuild and again on GitHub Actions -- large-quantities 7/7, usage-ingestion 7/7 re-run twice given this story touches that suite's own code, currency-rounding 9/9); TEID-96 done (PR #16, merged as `21dd675` -- DST-aware, month-end-clamped period-boundary computation plus an optional `occurred_at` field on `POST /usage`; found and resolved a real internal inconsistency in its own spec (architecture vs. one test's exclusive-end wording) in favor of the more precise architecture description; independently verified against a from-scratch DB rebuild and again on GitHub Actions -- billing-periods 11/11 with T5's 4 DST/month-end cases confirmed individually named, usage-ingestion 7/7 re-run twice, currency-rounding 9/9, large-quantities 7/7; CI's only failure was the known data-export cold-start flake, confirmed via the exact same "Hook timed out"/"Test timed out" signature already documented below); TEID-31 done (PR #21, merged as `c1c8305` -- enforced idempotency for usage ingestion. AC4 (DB-enforced uniqueness) turned out to already be fully built since TEID-41; this story added AC1/AC2/AC3's duplicate-ack/retention-expiry/content-conflict-review behavior reactively around `usage_events`'s existing unique constraint, left completely untouched. Implemented by Codex; independently verified twice (fresh DB, every service, all 7 tests, every regression suite) before landing -- two real issues found and fixed during verification beyond Codex's own implementation: an `ON DELETE CASCADE` that would've silently erased `idempotency_conflicts` review-queue audit history on a later legitimate key reuse (changed to nullable + `SET NULL`), and a `SAVEPOINT` wrapping every insert unconditionally (not just conflicts), adding hot-path overhead removed by restructuring to a second, separate transaction only on an actual `23505`. Also fixed a real bug in the new test fixtures (an unqualified, dual-typed SQL parameter Postgres rejected outright). Content comparison deliberately excludes `occurred_at`, preserving `TEID-96-T8` unchanged. Merged past a CI failure on `tests/usage-ingestion`'s p99 latency gate with explicit user sign-off -- see the confirmed-pre-existing-flake note below (that gate failed on a one-line, unrelated commit predating this story entirely, and TEID-31's diff never touches the ts-console code the other failing instance of this flake class hit)); TEID-32 done (PR #27, merged as `726d5ac`+admin-merged past the flake, fast-forwarded to `main` at `8687521` -- append-only double-entry ledger. New `reservations` (minimal placeholder, not the real E02 hold/settle system), `ledger_transactions`, `ledger_lines` tables; first-ever trigger-based immutability (`BEFORE UPDATE OR DELETE` triggers reject even a superuser); sum-to-zero enforced twice (app-level pre-check + a deferred constraint trigger at COMMIT); go-usage's first-ever background worker for the daily integrity check, alerting via a configurable on-call webhook. Implemented by Codex, committed by Claude on its behalf (Codex's sandbox cannot run git commit). Codex's own notes added a real missing index (`ledger_lines_transaction_id_idx`) the spec's schema excerpt omitted, needed so the deferred trigger doesn't degrade to a full scan at 50M-row scale; also built a one-shot Go test helper (`tests/ledger/worker-helper.go`) so the TypeScript suite can call the real exported `CheckAllTransactionsBalanced` function directly, since the spec deliberately defines no test-only HTTP route. Hit tonight's Docker Desktop crash mid-implementation (degraded Codex's own self-testing; redone in full during independent verification). Independently verified against a from-scratch DB rebuild -- ledger 8/8, plus every other regression suite, `tsc --noEmit` clean. Merged past a CI failure on the same pre-existing shared-runner flake class as TEID-19/TEID-31 (this time `TEID-19-T6`, `tests/commits`, diff-scope confirmed -- PR #27 is ledger-only) with explicit user sign-off. TEID-33 done (PR #34, admin-merged past the flake as `a44f9df`, fast-forwarded to `main` at `40abf7e` -- balances derived from the ledger. New `GetCustomerBalance`/`RecalculateCustomerBalance`/`ReconcileCustomerBalances` against the `receivable` ledger account (TEID-32's fixed `allowedAccounts` set has no generic "customer_balance" code); new `customer_balance_cache`/`balance_integrity_checks` tables; a second, independent hourly background worker alongside TEID-32's own daily integrity-check ticker. A mismatch commits to `balance_integrity_checks` *before* any on-call webhook attempt -- a deliberate improvement over TEID-32's own `postAlert`/`CheckAllTransactionsBalanced`, which has no durable record if the webhook itself is unreachable. Implemented by Codex, committed by Claude on its behalf. Codex's own notes: the spec's own general "seed via `PostTransaction`" guidance conflicts with T5's 1-million-customer scale requirement (can't build that one call at a time) -- resolved by having T1/T3/T4/T6/T7 go through the real `POST /ledger/transactions` handler while T2/T5 use set-based bulk SQL fixtures with triggers disabled only on that superuser fixture session, following TEID-32-T6's own precedent for its 50M-row scale test exactly. `ledger.go`'s `postAlert` signature widened from a ledger-specific struct to `any` so both workers share one webhook sender -- confirmed non-breaking, TEID-32's own 8 tests unchanged. Independently verified against a from-scratch DB rebuild -- balance-reconciliation 7/7 (T5's 1M-customer fixture re-timed independently at ~12-14s, confirming Codex's own ~18.6s report was not overstated), ledger 8/8 (TEID-32 unchanged), plus every other regression suite, `go vet`/`go test` clean. Merged past a CI failure on the same pre-existing shared-runner flake class (this time `TEID-20-T5`, `tests/rate-overrides`, diff-scope confirmed -- PR #34 is go-usage-only) with the same standing user sign-off. Next: TEID-34/35/97, TEID-35 already specced (see below), not yet handed off |
| E01 -- entitlement model and pricing configuration | Claude | Cursor/Grok | TEID-16 done (PR #8, merged as `ffea8df` -- Grok implemented, committed, pushed, and opened its own PR fully unassisted, unsandboxed; independently verified against a from-scratch DB rebuild and again on GitHub Actions -- plans 9/9, cross-tenant 32/32, console-auth 13/13, audit-log 7/7, api-keys 9/9, rbac 8/8, data-export 8/8). TEID-17 done (PR #13, merged as `187779b` -- the "grants" story TEID-44's own spec had flagged as not-yet-existing; Grok implemented, committed, pushed, and opened its own PR fully unassisted again; independently verified against a from-scratch DB rebuild and again on GitHub Actions -- grants 9/9, cross-tenant 41/41, console-auth 13/13, api-keys 9/9, rbac 8/8, plans 9/9, audit-log 7/7, data-export 8/8; Grok caught and fixed its own concurrency bug in T17-T7 during self-testing before ever handing it off). Lives in `services/ts-console` like E05, but a structurally separate file set (new `plans`/`plan_rates`/`grants`/`recurring_grant_templates`/`grant_ledger_entries` tables and routes -- nothing E05 owns). MVP order is TEID-16, 17, 18, 19, 20, 22, 23 (TEID-21 is phase-2, out of order for now). TEID-18 done (PR #17, merged as `a36c2a3` -- Grok implemented, committed, pushed, and opened its own PR fully unassisted again; independently verified against a from-scratch DB rebuild -- consumption-order 10/10, cross-tenant 45/45, console-auth 13/13, api-keys 9/9, rbac 8/8, audit-log 7/7, plans 9/9, grants 9/9, data-export 8/8 (one retry needed for the known TEID-44-T1 cold-start flake), `tsc --noEmit` clean; one minimal accepted deviation -- added `"put"` to `roleGuard.ts`'s method-type union for the new consumption-order endpoint). TEID-19 done (PR #20, merged as `c1c8305` -- annual commits with monthly/quarterly drawdown. A commit is a `grants` row with `source = 'commit'`, extended with `drawdown_schedule`/`overage_rate`/`carries_over`/`next_release_at` -- reuses TEID-17/18's grants/consume machinery rather than a parallel table. Implemented and committed by Grok, unassisted; independently verified against a from-scratch DB rebuild and again on GitHub Actions -- commits 9/9 (12/12 incl. supporting sub-tests), cross-tenant 49/49 (incl. new commit-isolation cases), console-auth 13/13, api-keys 9/9, rbac 8/8, data-export 8/8, plans 9/9, grants 9/9, consumption-order 10/10, `tsc --noEmit` clean. Caught a genuine error in the spec during implementation (claimed `audit_log` had a top-level `reason` column; it doesn't -- resolved by storing it in the existing `detail` JSON and extending `recordConfigChangeWithClient` with an optional `reason` field). `tests/audit-log`'s TEID-42-T4 (1.2M-row export, 120s budget) ran over on this dev machine in isolated verification (~121s) but is confirmed untouched by this story's diff -- pre-existing machine-speed marginality, not a regression. Merged past a CI failure on the same confirmed-pre-existing `tests/usage-ingestion` p99 latency flake as TEID-31 above, with explicit user sign-off (TEID-19's diff never touches `services/go-usage` at all). TEID-20 done (PR #26, merged and fast-forwarded to `main` as `726d5ac` -- per-customer rate overrides, override-beats-plan precedence via an explicit `plan_id` on the pricing request body. Implemented and committed by Grok, unassisted (worked around a mid-session Docker Desktop crash by downloading portable Postgres binaries instead of waiting -- flagged to the verification agent as an unverified deviation, so verification below reran everything from scratch under the standard Docker-based procedure once Docker was back up). Grok's own notes caught a real security gap in the spec itself: `resolveEffectiveRate` can return an override without ever checking that the request's `plan_id` is visible under the caller's own tenant RLS, so a malicious `plan_id` from another tenant would otherwise still resolve and insert a `priced_usage_lines` row pointing at it -- fixed by an RLS-visibility check before resolving. Independently verified against a from-scratch DB rebuild -- rate-overrides 8/8, cross-tenant 54/54 (incl. the new `rate-override-isolation.test.ts`'s cross-tenant `plan_id` check, confirmed as a real, working 404-with-no-leak assertion, not just a file existing), console-auth 13/13, api-keys 9/9, rbac 8/8, grants 9/9, consumption-order 10/10, plans 9/9, commits 12/12, data-export 8/8 (one retry, known TEID-44-T1 flake), `tsc --noEmit` clean. TEID-22 done (PR #35, admin-merged as `8d79601`, fast-forwarded to `main` at `a53eae1` -- customer hierarchy with pooled and isolated balances. `customers` extended into a tree via a self-referencing `parent_customer_id` (organisations and teams are both just `customers` rows -- no new entities), a `balance_mode` column, and a new cascading ceiling check (`checkHierarchyLimits`, one recursive SQL query) layered on top of TEID-18's existing, completely unmodified `consumeAcrossGrants`/`lockEligibleGrants`. The largest, most architecturally involved story handed off this session. Grok independently found and fixed two real correctness gaps in the architect's own spec before ever handing it off: (1) applying the new ceiling check universally would have broken TEID-18/19's existing overage-recording behavior for every pre-existing (non-nested) customer -- fixed by gating the rejecting check behind `customerIsNested`, so a standalone root still overages exactly as before; (2) the spec's literal check-then-consume ordering had a real TOCTOU race for two concurrent pooled draws (since `consumeAcrossGrants` records overage rather than rejecting a shortfall) -- fixed by locking the resolved billing customer's grants *before* running the ceiling check, closing the race. Also reasonably deviated from two literal-but-inconsistent details: no `/v1` route prefix (this service has never used one) and an isolated (not pooled) organisation root, required by a schema constraint the spec's own T2 test-guidance text contradicted. `api_keys.customer_id` added (nullable, carried through rotation) so a key can be associated with a hierarchy node. Independently verified against a from-scratch DB rebuild -- customer-hierarchy 8/8 (T5's P99 directly measured at 7.6ms/8,843 checks-per-sec, well inside budget), zero regressions in the highest-risk suites (consumption-order 10/10, commits 12/12), plus cross-tenant 70/70, grants 9/9, plans 9/9, rate-overrides 8/8, api-keys 9/9, rbac 8/8, `tsc --noEmit` clean. Merged past a CI-only failure on `TEID-22-T5` with explicit user sign-off -- **not the usual shared-runner noise**: both CI runs failed identically (~143 checks/sec vs the 5,000 target, ~60x short), a real, reproducible GitHub-Actions-runner-capacity gap distinct from this session's other marginal-miss flakes, tracked as issue #37 for a CI-scoped budget fix (the same pattern TEID-20-T5 already uses). Next: TEID-23, not specced yet. |
| E04 -- Stripe connector (read-first) and invoice sync | Claude | Cursor/Grok | New phase, started 2026-09-27 as the second concurrent track alongside E01 once the "2 stories per agent" pattern was approved. TEID-37 done (PR #28, admin-merged past the flake as `fcae3b6`, fast-forwarded to `main` at `8687521` -- connect a Stripe account, read-only first, via a hand-rolled OAuth 2.0 authorization-code flow (not the `stripe` npm package, since its OAuth resource may not support host-overriding for the fake-Stripe test double). New `stripe_connections` table storing an AES-256-GCM-encrypted access token (recoverable, not a one-way hash, since it must be presented back to Stripe), role-gated to Owner/Billing Admin. Implemented by Grok, committed/pushed/PR opened fully unassisted. Grok's own notes documented real security hardening beyond the spec's literal text: added a `jti` nonce and tenant/user-match check to the signed OAuth `state` token (rejects a callback whose embedded tenant/user isn't the actual signed-in operator, before ever exchanging the code -- stops a leaked code+state pair from being redeemed by a different attacker session) and requires Stripe's granted scope to exactly equal the requested scope (stops silent scope-widening); also refused to add an insecure dev-fallback encryption key, unlike `ADMIN_SECRET`'s existing fallback pattern, reasoning a silent default would encrypt tokens under a known key. Independently verified against a from-scratch DB rebuild -- stripe-connect 8/8, plus every other regression suite, `tsc --noEmit` clean; the state/session-binding hardening was independently re-tested by hand beyond the cataloged tests (mint a valid state as one operator, attempt the callback as a different operator in the same tenant) and confirmed to reject with no Stripe call made. Hit a real port collision with TEID-32's on-call webhook (both defaulted to `127.0.0.1:8092` in CI) resolving the merge -- on-call webhook moved to 8093. Merged past the same pre-existing shared-runner flake class as TEID-19/31/32 (this time `tests/commits`' throughput assertion, on a run that included the freshly-added `sdk-tests` job -- a second run on the identical commit passed clean) with the same standing user sign-off already given for this flake class tonight. TEID-38 done (PR #32, merged as `2c618bd`, fast-forwarded to `main` at `6c2dc6d` -- sync customers with Stripe. New `stripe_customer_links`/`stripe_customer_match_candidates` tables; matching order is exact Stripe-ID hit (a no-op today, since nothing has a stored ID before a link exists), then case-insensitive exact email, then a review-queue candidate. Two manual endpoints (create-in-Stripe, create-in-Teideal) cover AC2's both directions. Implemented by Grok, unassisted. Grok's own notes: loads the tenant's most-recently-connected `stripe_connections` row (TEID-37's own suite leaves more than one `connected` row in the shared test tenant); `createStripeCustomer` grew a third `connection: {scope}` parameter beyond the spec's literal signature since `assertWriteScope` needs the connection's scope, not recoverable from the access token alone; T8 proved both scope-guard layers independently -- Teideal's own `assertWriteScope` (rejects before any Stripe call) and the fake double's own independent `read_only` check on `POST /v1/customers`. **This completes E04's MVP scope** (`TEID-39`/`TEID-40` are phase-2, invoice sync and credit-purchase grants, not part of the MVP release). Independently verified against a from-scratch DB rebuild -- stripe-connect 16/16 (8 TEID-37 unchanged + 8 new), cross-tenant 66/66 (all 4 new endpoints), plus every other regression suite, `tsc --noEmit` clean. Next MVP work for this agent: TEID-22 (E01), spec written and handed off. |
| E09 -- developer experience and testing | Claude | Codex | New phase, started 2026-09-27 as the second concurrent track alongside E03 once the "2 stories per agent" pattern was approved. TEID-59 done (PR #29, merged as `e329637`, fast-forwarded to `main` at `09e6e29` -- Python and TypeScript SDKs. Pure client-side story, zero service changes; wraps the already-shipped `POST /usage` contract. New `sdks/python`/`sdks/typescript` packages with disk-persistent buffering (SQLite for Python, an NDJSON journal for TypeScript) so buffered events survive a kill-mid-flush per T8; a new, independent `sdk-tests` CI job (not folded into the main `test` job), gated into `deploy` alongside it. T5 (Phase-2 entitlement/reserve/settle) explicitly out of scope, documented not silently dropped, matching the spec's own Definition of Done. Implemented by Codex, committed by Claude on its behalf. Codex's own notes: every 4xx (not just the spec's named 400/403/409) is treated as retry-terminal, since the service can return other 4xx (e.g. 401) the spec didn't account for; `base_url`/`baseUrl` made writable for T4's offline-to-restored-endpoint scenario, with credentials/buffer config fixed. Independently verified against a from-scratch DB rebuild -- sdk-integration 6/6 plus both packages' own suites (Python 7/7, TypeScript 7/7) covering T7/T9, `mypy teideal` clean (a gap Codex's own sandbox network policy never let it confirm locally), `tsc --noEmit` clean, T8's kill-mid-flush confirmed genuinely adversarial (a real `SIGKILL` on a child process mid-request, recovered from the real on-disk journal, not mocked), idempotency-key stability across a crash confirmed directly in both buffer implementations. Regression suites cross-tenant 50/50, billing-periods 11/11, idempotency 7/7, commits 12/12. No further E09 stories currently specced |

**Flake pattern found during TEID-17's verification (2026-09-27), investigated
and closed out (2026-09-28):** `tests/data-export` (TEID-44's own suite,
already merged) intermittently hangs on its first test (`TEID-44-T1`,
inside `processPendingExports`'s first write of a session) for the full
120-180s hook/test timeout, then passes cleanly on an immediate retry with
no code changes -- reproduced repeatedly across TEID-16/17/18/96's CI runs
and local repro attempts, and again in a dedicated root-cause investigation
session. Distinct from the already-known `tests/usage-ingestion` p99-latency
flake (a threshold miss under load, not a hang).

Ruled out, each via direct measurement, not just circumstantial reasoning:
cold `@dsnp/parquetjs` dynamic import (374ms plain Node, 119ms under
vitest's own transform pipeline); the per-tenant `processPendingExports`
claim loop (only 3 tenants exist by the time T1 runs in a fresh CI job;
the loop itself completes in ~1ms); a suspected `JsonLinesWriter`
event-loop-blocking defect (an isolated synthetic benchmark of the writer
classes alone processed 450k rows in ~3s, and the real
query+write pipeline -- real Postgres round trips, real `Promise.all`,
real file writes, no vitest/server overhead -- processed 450,068 real rows
for the accumulated-data tenant in ~8s); a missing index on
`usage_events (tenant_id, occurred_at, id)` forcing a full parallel
seq-scan+sort per 10k-row export batch (confirmed via `EXPLAIN ANALYZE`,
but each batch still only cost ~60-90ms, nowhere near enough to explain a
multi-hundred-second hang, and doesn't apply at all to T1's own 1-row
scenario). No deterministic code-level cause was found in the
export-writer/query code paths specifically.

Mitigation landed: `TEID-44-T1` now has vitest's `{ retry: 1 }` per-test
option (scoped to this one test only, not a blanket timeout increase),
matching the empirical "hangs once, clean retry" signature seen every
time this has occurred.

**Live CI confirmed the retry mechanism itself works, but revealed this is
a genuine indefinite hang, not mere jitter (2026-09-28):** on a GitHub
Actions rerun, T1 hung on attempt 1 and was retried automatically -- all 8
tests in the file, including T1, were individually reported as passed. But
the shared `afterAll` hook (`pool.end(); superPool.end();`) then hung and
failed the suite anyway. First hypothesis -- vitest's retry doesn't cancel
the abandoned first attempt's in-flight promise, so a lingering client
checked out from the shared `pool` just needed more time to release before
`pool.end()` could resolve -- was directly tested and **disproven**:
widening the hook's timeout from 120s to 300s made no difference at all; it
hung for the full 300s again, identically. A hang that's unaffected by a
2.5x larger budget is not a slow drain, it's a connection that never
releases on its own -- i.e. a real, still-unlocated stuck
connection/transaction bug somewhere in this path, not transient CI/GC
jitter as first concluded. That specific bug remains **unresolved and is
real follow-up debt**, not something this session's investigation found.

Given the actual test assertions (T1-T8) all pass even when this happens,
and `afterAll`'s only job here is best-effort graceful pool shutdown (not a
correctness assertion), the pragmatic fix landed is to stop letting cleanup
block the suite: `pool.end()`/`superPool.end()` are now each raced against a
10s timeout inside `afterAll` (a `closeWithTimeout` helper), logging a
warning and proceeding rather than failing if a client never releases. This
unblocks CI without claiming the underlying leak is fixed -- if it recurs
often, the next step is live `pg_stat_activity` instrumentation during an
actual hang to find exactly which query/transaction is the one that's stuck
and why.

**Production impact and mitigation (2026-09-28):** this same
`processPendingExports`/`processScheduledExports` code, and the same
shared `pool`, run on a recurring production timer in
`services/ts-console/src/server.ts` (`exportTimer`, guarded only by
`NODE_ENV !== "test"`) -- not just in tests, against real customer data.
Left unbounded, a stuck idle-in-transaction connection permanently removes
one connection from the shared pool every time it happens; enough
occurrences and every feature needing a DB connection stops working, not
only exports. Added `idle_in_transaction_session_timeout: 60_000` to the
pool config in `services/ts-console/src/lib/db.ts`'s `createPool` --
Postgres will forcibly terminate any connection idle inside an open
transaction past 60s, verified directly against a live Postgres 16
instance. 60s is a >300x margin over every real measurement taken this
session (a 450k-row export batches in ~180ms/10k rows between queries).
This bounds the blast radius; it does not fix the underlying stuck-
connection bug, which is still unresolved and worth a dedicated
investigation session if it recurs.

**Open item, not yet investigated: TEID-44-T2's relative-timing SLA flake
(2026-09-28).** `tests/data-export/data-export.test.ts:286`
(`expect(rangeElapsed).toBeLessThanOrEqual(fullElapsed * 2 + 100)`) failed
once on GitHub Actions with `823ms` vs a `283ms` bound -- both absolute
values are trivially fast, so this is CI-noise hitting a
relative-ratio-between-two-timed-calls assertion, which is inherently
flake-prone regardless of what either call is doing. Unrelated to the T1
hang/retry/cleanup work above (T1 and T2 are different tests; nothing
touched in this session's fixes runs anywhere near this code path or
timescale). Not investigated further this session -- logged as an open
item, not blocking.

**Open item, confirmed pre-existing and unrelated to any specific story
(2026-09-28): `tests/usage-ingestion/load-test.test.ts:80`'s p99 latency
SLA gate (`expect(...).toBeLessThanOrEqual(200)`).** Failed on GitHub
Actions (not just a local dev machine) at `212ms`, `228ms`, and other
values just over the 200ms threshold, across multiple unrelated commits --
including on a commit (`e0ef409`, a one-line bash script fix with zero
relation to `go-usage` or the usage-ingestion insert path) that predates
any TEID-31 code changes entirely. This conclusively rules out any
specific story's code as the cause -- it's the same class of relative/
absolute-timing SLA flake as TEID-44-T2 above, just on a tighter absolute
margin (200ms) that GitHub Actions' shared runners apparently cross often
enough to matter. Mitigation: rerun the failed job (`gh run rerun <id>
--failed`), matching this repo's established practice for this flake
class. Not investigated further -- a real fix would mean loosening the
threshold or making the test retry-aware, neither done this session.

**Update (2026-09-28), same evening, merging TEID-19/TEID-31:** hit this
same class of flake four more times across both PRs' reruns -- three more
`load-test.test.ts:80` failures (332ms one of them) and, once, a
*different* test entirely, `tests/grants/grants.test.ts:352`'s eligibility-
throughput assertion (185.3 rps vs a 200 rps floor). The `grants.test.ts`
failure is the cleanest evidence yet: it happened on **TEID-31's PR**,
which is a `services/go-usage`-only diff that never touches
`services/ts-console` or `tests/grants` at all -- that PR's copy of
`tests/grants` is byte-identical to the base branch, so TEID-31's code
cannot have caused it. Symmetrically, TEID-19's PR (a `services/ts-console`-
only diff, never touches `services/go-usage`) kept failing specifically on
the `go-usage`-side `load-test.test.ts`. Each PR's failures landed in code
its own diff structurally could not have touched -- stronger evidence than
the earlier single-commit case, though still not a fully isolated
determination of *why* GitHub's shared runners are inconsistent here (noisy
neighbor VM contention vs. these tests' thresholds simply being too tight
even under normal shared-runner variance are both live explanations,
possibly both true at once -- not distinguished this session). Both PRs
were ultimately merged past this flake via `gh pr merge --admin` with
explicit user sign-off, once per PR, after one rerun each per the user's
own "one more try, then stop either way" instruction.

**Real fix landed for the two proven instances (2026-09-28):** scoped
`{ retry: 2 }` added directly to `tests/usage-ingestion/load-test.test.ts`'s
p99 assertion (TEID-30-T3/T6) and `tests/grants/grants.test.ts`'s throughput
assertion (TEID-17-T7) -- the two specific assertions with decisive
diff-scope proof of being pre-existing shared-runner noise, not scoped to
every SLA test in the repo. Verified clean on a subsequent full green CI run
including the `deploy` stage.

**A fourth instance, the morning after (2026-09-29, TEID-33's PR #34):**
`tests/rate-overrides/rate-overrides.test.ts`'s `TEID-20-T5` (override
resolution overhead, budget 50ms, one run measured 622ms) failed on one of
two CI runs triggered against the identical commit -- the other passed
clean. PR #34 is `go-usage`-only (ledger/balance-reconciliation code) and
never touches `tests/rate-overrides` or anything in `services/ts-console`,
so the same diff-scope argument applies. This is now four distinct SLA-
timing tests hit by the same underlying shared-runner-contention class
across one evening/morning: `tests/usage-ingestion`'s p99 gate,
`tests/grants`' throughput gate, `tests/commits`' `TEID-19-T6`, and now
`tests/rate-overrides`' `TEID-20-T5` -- admin-merged with the same standing
sign-off given for this flake class.

**A third instance of the same flake class, a different test (2026-09-28,
TEID-32's PR #27):** `tests/commits/commits.test.ts`'s `TEID-19-T6` (P99
balance-read latency, budget 100ms, one run measured 350ms) failed on one of
two CI runs triggered against the identical commit 21 seconds apart -- the
later run passed clean. TEID-32's diff is ledger-only
(`services/go-usage/internal/ledger/`, `internal/api/ledger.go`,
`internal/api/reservations.go`, the ledger migration, `tests/ledger/`) and
never touches `tests/commits` or anything in its path, so the same
diff-scope argument applies.

**Escalation and resolution while landing TEID-32/TEID-37 back to back
(2026-09-28, same evening):** with three PRs' CI queued around the same
time (#27, #28, #29), the flake got measurably worse -- `TEID-30-T3/T6`
failed all 3 attempts on one PR #28 CI run even with the `{ retry: 2 }` fix
already landed (845ms, 356ms, 424ms, all far over the 200ms budget, worse
than any single-attempt miss seen earlier tonight), and a separate run hit
`tests/commits`' throughput assertion (32.6 rps vs a 50 rps floor) instead.
Consistent with runner contention from concurrent CI across this session's
own PRs, not a code regression -- neither PR's diff touches the failing
suite's own code. Given user sign-off, both PR #27 and PR #28 were merged
via `gh pr merge --admin`, each confirmed first against a second, clean CI
run on the identical commit. Not investigated further beyond diff-scope
evidence -- widening retry counts further was considered and explicitly
declined in favor of admin-merging with evidence in hand, given three PRs
contending for shared-runner capacity is itself a temporary, one-night
condition.

**Gemini auth (2026-09-27):** Gemini CLI's personal/free Google OAuth login is deprecated for this installed version -- attempting it returns `IneligibleTierError` and redirects to a separate "Antigravity" product. Headless use needs a `GEMINI_API_KEY` (or a working Vertex AI/GCP setup), neither of which was available this session. TEID-94 was reassigned to Codex instead (justified under the "story hasn't been started, no sunk work" exception -- see "If an agent hits a usage-window limit mid-story" above, which applies equally to an agent that can't authenticate at all). Revisit Gemini once an API key is available; until then, treat it as unusable for this workflow.

**A different, non-noise class of CI failure: genuine shared-runner capacity
gaps on throughput-heavy tests (2026-09-29, TEID-22's PR #35).**
`TEID-22-T5` (5,000 hierarchy-check requests/sec, P99 under 20ms, against a
live server + Postgres) failed **identically on both CI runs** for the same
commit -- ~142-143 checks/sec, P99 200-235ms, roughly 60x short of target.
Local independent verification on this same commit measured 8,843
checks/sec, P99 7.6ms -- comfortably passing. Unlike this session's other
flakes (a marginal miss that clears on an immediate rerun, evidence of
transient contention), this is a **deterministic, reproducible** gap between
a capable local dev machine and GitHub's standard shared runner's actual
throughput ceiling for a live HTTP+Postgres load-generating test -- it will
fail the same way on every future CI run touching this file, not just
sometimes. Merged past it with explicit user sign-off ("merge now, deal
with the throughput issue after"); tracked as **issue #37** for the real
fix -- a CI-scoped rate/budget env var, the same pattern `TEID-20-T5`
already uses (`RATE_OVERRIDE_LATENCY_SAMPLES`/`_BUDGET_MS`), keeping the
literal catalog numbers as the default for local/manual runs. Any future
story writing a raw-throughput (not just latency-budget) non-functional
test should default to CI-scoped scaling from the start, following
TEID-20's precedent, rather than hard-coding catalog-scale numbers the way
TEID-22-T5 did.
