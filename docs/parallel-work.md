# How this backlog gets built: architect + developer

Two roles, not two implementers:

- **Claude (solution architect).** Owns every architecture decision, writes
  a self-contained spec for each story before it's built, and does the
  consolidated review at the end of each phase. Does not write feature
  code.
- **Codex (developer).** Implements each story strictly from its spec,
  writes the unit tests the spec calls for, opens a PR. Does not need to
  consult the live board directly -- the spec is the complete contract.

A **phase is one epic.** Stories within a phase are still built in the
backlog's `order`, one at a time, each proved against its own tests
before the next starts -- the "don't jump ahead" rule now applies within
a phase rather than globally. Once every story in a phase is implemented
and green in CI, Claude does one consolidated review of the whole phase
(architecture conformance, security/isolation, code quality, and that
every cataloged test -- functional, non-functional, adversarial -- really
is covered), then syncs the live board for that phase's stories.

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
3. **Codex bases its branch on `claude/upbeat-cerf-c48vx0`, not on
   `main`** -- that's what makes the spec visible to Codex immediately,
   without waiting on a PR merge. Codex implements the story strictly
   against the spec, with the automated tests the spec's per-test
   guidance describes, and opens a PR (against `main`, or against
   `claude/upbeat-cerf-c48vx0` if the human prefers to land specs on
   `main` first -- either way, confirm with the human once before the
   first PR so both sides agree which base to target) referencing the
   TEID key(s), with a short checklist mapping each test ID to where
   it's covered.
4. CI gates the PR the same way it gates everything else in this repo
   (see `.github/workflows/ci.yml`) -- it must be green before merge.
   Merging an individual green PR does not require waiting for the rest
   of the phase.
5. Repeat for the next story in that phase's order.

## The per-phase (epic) loop

Once every story in a phase is merged and green:

1. **Claude** reviews the whole phase as a unit against
   `specs/TEID-XX.md` for each of its stories: does the implementation
   match the spec's intent, does it hold up architecturally next to the
   rest of the system, is there anything a per-story view would miss
   (e.g. two stories in the same phase touching the same table in ways
   that don't quite compose)? Findings go back to Codex as spec
   addendums for anything substantial; trivial fixes may be made
   directly.
2. Once the phase is clean, Claude syncs the live board (and this repo's
   `index.html`) marking the phase's stories Done, exactly as done for
   TEID-41/TEID-91.
3. Move to the next phase.

## Shared resources and how to avoid stepping on them

- **Branches.** Codex works on its own branch, never on Claude's. Both
  merge into `main` via PRs.
- **`specs/`.** Written and owned by Claude. Codex reads them, doesn't
  edit them -- if a spec seems wrong or incomplete once implementation
  starts, that's a signal to flag back, not to silently improvise past
  it.
- **`db/migrations/`.** Filenames are timestamp-prefixed
  (`YYYYMMDDHHMMSS_description.sql`), not sequentially numbered --
  generate the prefix with `date -u +%Y%m%d%H%M%S` when adding one. This
  is what stops two migrations added around the same time from colliding
  on the same filename. `db/setup-local.sh` applies every file in the
  directory in sorted (chronological) order. Never edit a migration
  that's already merged to fix something -- add a new one instead.
- **`.github/workflows/ci.yml`.** Expect the occasional small manual
  merge conflict here as phases add new services/suites to run -- normal,
  not a sign something went wrong.
- **The live tracking board** (`index.html`'s embedded `DATA`/state, and
  the published claude.ai artifact). Claude owns syncing this -- Codex
  has no publish access to the artifact side of it anyway.

## Current phases

| Phase (epic) | Spec author | Implementer | Status |
|---|---|---|---|
| E05 -- tenant isolation, access control, data ownership | Claude | Codex | TEID-41, TEID-91 done (built directly by Claude before this process existed); TEID-42 spec ready, TEID-92/TEID-43/TEID-44 to follow |
| E03 -- usage ingestion and exactly-once ledger | Claude | Codex | TEID-30 spec ready; TEID-94/95/96/31/32/33/35/34/97/36 to follow |
