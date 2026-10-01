# TEID-62 implementation notes

## Issue lookup limitation

`gh issue view 50` was run first, as requested, but this sandbox denied the
outbound connection to `api.github.com`. `specs/TEID-62.md` was available and
was used as the complete implementation contract.

## Sign-up and entitlement wording

The spec asks the quick-start to begin at sign-up, but the registered API has
no sign-up route: accounts are provisioned out of band and local accounts are
created by committed migration/fixture scripts. The guide therefore labels
operator or local-seed provisioning as step 1 and does not invent an endpoint.

The repository also explicitly records real-time entitlement checks as a
later Phase-2 feature. TEID-62's implementation guidance permits an
“entitlement/plan-rate-check”; the walkthrough uses the existing exact-decimal
`POST /money/price` plan-rate calculation. This is the smallest reuse-based
resolution and does not expand the API or database schema.

## Human trial evidence

T2's human half and T4 require five real unfamiliar human participants. None
were available to this sandbox. `docs/quickstart-trial-results.md` records that
fact and the executable protocol instead of inventing passing data. This means
the manual acceptance item remains open even though the separately scoped
automated proxy is real and CI-gated.

## Architect follow-up (2026-09-29)

Codex's sandbox had no npm registry, Docker/Postgres, or GitHub network
access at all, so none of `tests/docs`, the full regression suites, or
`tsc --noEmit` could actually be run before handoff -- Codex disclosed this
plainly rather than claiming untested work passed. The architect ran
everything for real against a fresh isolated Postgres container and found
two genuine bugs, both fixed before merge:

- **`tests/docs/package.json` pinned exact dependency versions** (no `^`)
  instead of the caret ranges every other `tests/*/package.json` in this
  repo uses -- a direct consequence of never having npm access to resolve
  and test the pins. `@types/node@22.10.2` (exact) conflicted with
  `vite@8.3.1`'s peer requirement for `@types/node@^20.19.0 || >=22.12.0`,
  and `npm install` failed outright. Switched every entry to `^`, matching
  convention; installs cleanly.
- **`renderMarkdown.ts`'s list renderer produced a real WCAG violation.**
  Markdown list items that wrap across two lines (an indented continuation
  line with no leading `- `, the normal convention used throughout
  `docs/quickstart.md`'s own "Production checklist" section) fell through
  to the paragraph-accumulation branch while a `<ul>` was still open,
  emitting a stray `<p>` as a direct child of `<ul>` -- exactly what axe's
  `list` rule flags (a `<ul>`'s only valid direct children are `<li>`,
  `<script>`, or `<template>`). Fixed by detecting an indented continuation
  line while a list is open and appending it into the just-emitted `<li>`
  instead of starting a new paragraph. Confirmed via a full rerun: 0 axe
  violations.
- **`docs/api/errors.md` was missing `405`**, which `services/ts-console`
  genuinely returns from the audit log's append-only guard
  (`routes/auditLog.ts`) -- caught by `check-coverage.ts`'s own
  `missingErrorCodes` check, which is real and was correctly failing.
  Added the missing row.

All 6 `tests/docs` tests pass for real against a live stack after those
fixes, plus the spec's required regression suites: cross-tenant 75/75,
console-auth 13/13, api-keys 9/9, rbac 8/8. `tsc --noEmit` clean.

