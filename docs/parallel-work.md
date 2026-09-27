# How this backlog gets built: one architect, several developers

Two kinds of role, not a fixed number of implementers:

- **Claude (solution architect).** Owns every architecture decision, writes
  a self-contained spec for each story before it's built, and does the
  consolidated review at the end of each phase. Does not write feature
  code.
- **Developer agents** (currently Codex; Gemini joining on a separate
  phase). Each implements its assigned phase's stories strictly from
  spec, writes the unit tests the spec calls for, opens a PR. Doesn't
  need to consult the live board directly -- the spec is the complete
  contract. Two developer agents never share a phase -- see below.

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
almost entirely in `services/go-usage` -- see "Current phases" below).
When bringing in a new developer agent, give it a phase with no developer
agent currently assigned, not a share of one already in progress.

## The per-story loop

1. **Claude** pulls the story's exact `ac[]` and `tests[]` from the live
   board (never from memory) and writes `specs/TEID-XX.md` following
   `specs/TEMPLATE.md`. This includes any scoping decisions needed because
   an AC or test references something not built yet (common early in a
   phase) -- those decisions are made and written down here, not left for
   the developer to guess.
2. Claude commits the spec to `claude/upbeat-cerf-c48vx0` (Claude's
   standing branch -- it never pushes to any other branch without
   explicit permission, so specs land here, not on `main`) and tells the
   user it's ready.
3. **The developer agent assigned to that phase bases its branch on
   `claude/upbeat-cerf-c48vx0`, not on `main`** -- that's what makes the
   spec visible immediately, without waiting on a PR merge. Branch names
   are prefixed by agent (`codex/<story-slug>`, `gemini/<story-slug>`)
   so two agents' branches never collide even if they touch the same
   filename in passing. The agent implements the story strictly against
   the spec, with the automated tests the spec's per-test guidance
   describes, and opens a PR (against `main`, or against
   `claude/upbeat-cerf-c48vx0` if the human prefers to land specs on
   `main` first -- either way, confirm with the human once before the
   first PR so all sides agree which base to target) referencing the
   TEID key(s), with a short checklist mapping each test ID to where
   it's covered. If a spec seems wrong, incomplete, or blocked by
   something missing, the agent says so instead of improvising past it
   -- this has already caught several real gaps before any code was
   written; keep doing it.
4. CI gates the PR the same way it gates everything else in this repo
   (see `.github/workflows/ci.yml`) -- it must be green before merge.
   Merging an individual green PR does not require waiting for the rest
   of the phase, and does not require waiting on the other phase's agent.
5. Repeat for the next story in that phase's order.

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
2. Once the phase is clean, Claude syncs the live board (and this repo's
   `index.html`) marking the phase's stories Done, exactly as done for
   TEID-41/TEID-91/TEID-42.
3. Move to the next phase -- which may mean assigning that agent a new
   phase, or nothing further if all currently-staffed phases are done.

Two phases can be mid-review at overlapping times if two developer
agents finish around the same time -- review each independently, in
whatever order they finish.

## Shared resources and how to avoid stepping on them

- **Branches.** Each developer agent works on its own branch(es),
  prefixed by agent name, never on Claude's or another agent's. All
  merge into `main` (or `claude/upbeat-cerf-c48vx0`, per whatever the
  human confirmed) via PRs.
- **`specs/`.** Written and owned by Claude. Developer agents read them,
  don't edit them.
- **`db/migrations/`.** Filenames are timestamp-prefixed
  (`YYYYMMDDHHMMSS_description.sql`), not sequentially numbered --
  generate the prefix with `date -u +%Y%m%d%H%M%S` when adding one. This
  is what stops two migrations added around the same time (by the same
  agent or different ones) from colliding on the same filename.
  `db/setup-local.sh` applies every file in the directory in sorted
  (chronological) order. Never edit a migration that's already merged to
  fix something -- add a new one instead.
- **`.github/workflows/ci.yml`.** Both agents will occasionally add a
  step here for their phase's new test suite. Expect the occasional
  small manual merge conflict -- normal, not a sign something went
  wrong, and resolved the same way regardless of how many agents are
  contributing.
- **`tests/cross-tenant`.** This is the standing "every documented API
  endpoint" regression suite (TEID-41-T2) -- it is not owned by one
  phase. Any story in any phase that adds an endpoint reachable by an
  authenticated caller adds that endpoint's cross-tenant case here, not
  only to its own phase's test directory. Both agents' specs should
  call this out explicitly when it applies (TEID-92's spec does, as an
  example to follow).
- **The live tracking board** (`index.html`'s embedded `DATA`/state, and
  the published claude.ai artifact). Claude owns syncing this -- no
  developer agent has publish access to the artifact side of it anyway.

## Current phases

| Phase (epic) | Spec author | Developer agent | Status |
|---|---|---|---|
| E05 -- tenant isolation, access control, data ownership | Claude | Codex | TEID-41, TEID-91 done (built directly by Claude before this process existed); TEID-42 done (PR #1 merged); TEID-92 done (PR #2 merged, independently verified against a from-scratch DB rebuild); TEID-43 done (PR #3 merged, independently verified against a from-scratch DB rebuild -- all 5 relevant suites re-run: rbac 8/8, cross-tenant 23/23, console-auth 13/13, audit-log 7/7, api-keys 9/9); TEID-44 spec next |
| E03 -- usage ingestion and exactly-once ledger | Claude | Gemini | TEID-30 done (merged into claude/eager-brown-dlqfl4, independently verified twice -- once per-branch, again post-merge against a from-scratch DB rebuild alongside TEID-43); TEID-94 spec next, then TEID-95/96/31/32/33/35/34/97/36 |
