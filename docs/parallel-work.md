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
sandbox/permission mode permissive enough to let it run. **Not yet
confirmed end-to-end** -- the first time one of these is actually driven
through a full story, confirm whether it reliably runs `git
commit`/`gh pr create` unprompted, or whether Claude needs to do the
commit/push/PR step itself after the CLI finishes editing the working
tree. Until confirmed, assume the latter and verify PR creation
manually.

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

## Current phases

| Phase (epic) | Spec author | Developer agent | Status |
|---|---|---|---|
| E05 -- tenant isolation, access control, data ownership | Claude | Codex | TEID-41, TEID-91 done (built directly by Claude before this process existed); TEID-42 done (PR #1 merged); TEID-92 done (PR #2 merged, independently verified); TEID-43 done (PR #3 merged, independently verified against a from-scratch DB rebuild -- rbac 8/8, cross-tenant 23/23, console-auth 13/13, audit-log 7/7, api-keys 9/9); TEID-44 done (PR #5 merged -- first story driven via the local-CLI path; Codex got 6/8 tests green before exhausting its usage quota, Claude finished it (re-pinned a broken `@dsnp/parquetjs` release, fixed a Windows-checkout CRLF bug caught during verification), independently verified against a from-scratch DB rebuild and again on GitHub Actions -- data-export 8/8, cross-tenant 27/27, console-auth 13/13, audit-log 7/7, api-keys 9/9, rbac 8/8); no further E05 stories currently cataloged beyond this -- check the live board for anything added since |
| E03 -- usage ingestion and exactly-once ledger | Claude | Gemini | TEID-30 done (merged into Claude's branch, independently verified twice -- once per-branch, again post-merge alongside TEID-43 against a from-scratch DB rebuild); TEID-94 spec next, then TEID-95/96/31/32/33/35/34/97/36 |
| E01 -- entitlement model and pricing configuration | Claude | Cursor/Grok | Newly assigned 2026-09-27. Lives in `services/ts-console` like E05, but a structurally separate file set (new `plans`/`grants`/`commits`/`overrides` tables and routes -- nothing E05 owns). MVP order is TEID-16, 17, 18, 19, 20, 22, 23 (TEID-21 is phase-2, out of order for now). TEID-16 spec next. |
