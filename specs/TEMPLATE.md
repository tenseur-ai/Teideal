<!--
Template for a story spec. Copy to specs/TEID-XX.md, fill in every
section. This document is the complete contract between the architect
(Claude) and the developer (Codex) for one story -- Codex should not need
to open the live board or guess at anything left unstated here.
-->

# TEID-XX: <summary>

| | |
|---|---|
| Epic | TEID-N (E0N -- name) |
| Phase | (epic name, same as above) |
| Priority | |
| Points | |
| Release | mvp / phase-2 / phase-3 |
| Order | N (within this phase) |
| Depends on | (prior stories/tables/endpoints this one builds on) |

## Story (verbatim from the live board)

> <desc, copied exactly, not paraphrased>

## Acceptance criteria (verbatim from the live board)

1. ...
2. ...

## Cataloged tests (verbatim from the live board)

| ID | Type | AC | Title |
|---|---|---|---|
| TEID-XX-T1 | Functional | 1 | ... |

## Scoping notes for this point in the build sequence

<Only needed when an AC or test references something not yet built.
State the substitution plainly: what stands in for the missing piece,
why it's a fair test of the same mechanism, and what happens naturally
once the real thing is built (usually: it calls the same helper this
story introduces, and coverage becomes literal rather than substituted).
If nothing is missing, write "None -- everything this story references
already exists.">

## Architecture and design

<Data model changes (new tables/columns, which migration file — pick a
fresh timestamp), which service owns what, API contract (method, path,
request/response shapes, status codes for each outcome), security/
isolation requirements (RLS policy shape if a new table is tenant-scoped,
auth method required), and how this fits the existing ADR
(docs/adr/0001-architecture-and-api-boundary.md).>

## Implementation guidance per test

<For each test ID: what the automated test should set up, do, and
assert, concretely enough that two people implementing it would produce
the same test. Call out non-functional and adversarial tests explicitly
-- they're the ones most likely to get skipped or faked if
under-specified.>

### TEID-XX-T1

...

## File layout

<Where new code should live, following existing conventions in
services/go-usage or services/ts-console (internal/ or lib/ for logic,
routes/ or internal/api/ for handlers, one test file per test ID or
logical group under the appropriate tests/ directory).>

## Definition of done

- [ ] Every acceptance criterion above is satisfied by working code.
- [ ] Every cataloged test has a real automated test that passes --
      functional, non-functional, and adversarial alike.
- [ ] `go vet`/`tsc --noEmit` (whichever applies) is clean.
- [ ] The suite passes against a database rebuilt from scratch using only
      committed migration/seed scripts (not just the developer's already-
      warm local state).
- [ ] PR description includes a checklist mapping each test ID to the
      file/line that covers it.
