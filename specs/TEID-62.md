# TEID-62: Documentation and quick-start

| | |
|---|---|
| Epic | TEID-9 (E09 -- Improve developer experience and testing) |
| Phase | E09 -- Improve developer experience and testing |
| Priority | High |
| Points | 5 |
| Release | mvp |
| Order | 52 (within this phase) |
| Depends on | the full existing REST API surface of both services (read-only, documenting what exists), `sdks/python`/`sdks/typescript` (TEID-59) |

## Story (verbatim from the live board)

> As a developer at our customer, I want clear documentation and a quick-start guide, so that I can integrate in one working day.
>
> *Context*

## Acceptance criteria (verbatim from the live board)

1. Documentation covers every endpoint, error and reason code with examples.
2. A quick-start guide takes a new developer from sign-up to a working entitlement check and event in under one hour.
3. The guarantees we make (exactly-once, ordering, degraded mode) are documented along with how we test them.

## Cataloged tests (verbatim from the live board)

| ID | Type | AC | Title |
|---|---|---|---|
| TEID-62-T1 | Functional | 1 | Cross-check the published documentation against the actual API surface and confirm every endpoint, error code and reason code has a documented entry with a working example. |
| TEID-62-T2 | Functional | 2 | Have a developer with no prior Teideal exposure follow the quick-start guide starting from sign-up and confirm they complete a working entitlement check and a working usage event send in under 60 minutes. |
| TEID-62-T3 | Functional | 3 | Review the documented guarantees for exactly-once delivery, ordering and degraded mode and confirm each links to or names the specific automated test suite that verifies that guarantee. |
| TEID-62-T4 | Non-functional | 2 | Run a timed quick-start trial with 5 developers unfamiliar with the product and confirm the median completion time and log every point of friction they hit. |
| TEID-62-T5 | Non-functional | 2 | Run an accessibility check on the documentation site (screen reader, keyboard navigation, color contrast) and confirm it meets WCAG 2.1 AA on the quick-start pages. |
| TEID-62-T6 | Adversarial | 1 | Execute every code sample in the documentation exactly as written, with no external knowledge added, and confirm none produce a runtime error from a stale or broken example. |
| TEID-62-T7 | Adversarial | 1 | Call an endpoint using a deprecated path referenced in an older cached version of the docs and confirm the error response points the developer to the current documentation rather than failing silently. |

## Scoping notes for this point in the build sequence

**No documentation site, OpenAPI spec, or `docs/api` directory exists yet** -- confirmed by direct search (only `docs/adr/`, `docs/isolation-design.md`, `docs/parallel-work.md`, `docs/export-format.md` exist, none of which is developer-facing API reference). This story starts from near-zero on the docs side, though it can build on the two existing SDK packages and their READMEs (TEID-59).

**T2 and T4 are literal human-trial tests that cannot run as a CI-gated automated assertion the way every other cataloged test in this codebase does.** Rather than skip them or fake them, split each into a real automated proxy plus an explicitly-manual step, following this repo's established practice of finding the closest real mechanism rather than either faking the assertion or dropping it silently (see TEID-60's sandbox-tenant OAuth extension, TEID-22-T5's CI-scoped throughput budget for the same kind of precedent):
- **T2's automated proxy**: a scripted walkthrough test that executes the exact sequence of commands/API calls the quick-start guide instructs (sign-up → API key creation → one entitlement check → one usage event send), using *only* what the published guide says, run end-to-end against a real running stack, asserting it completes successfully and the whole scripted sequence finishes within a generous mechanical bound (e.g. 5 minutes of wall-clock script execution -- this proves the technical path works and is fast, not that a human reads and understands it in under an hour). This is the real, repeatable, CI-gated test that ships with this story.
- **T2's human half and all of T4** are a genuinely manual exercise (recruit developers, time them, log friction points) that happens once as part of this story's own acceptance, is written up in `docs/quickstart-trial-results.md`, and is **not** a repeatable automated test -- the Definition of Done below lists it separately from the automated test suite for this reason. Do not write a fake "test" that always passes for these; report the real trial results in that file instead.

**T7 references a "deprecated path" and "older cached version of the docs."** At this stage, nothing in the API has ever been deprecated or versioned yet -- there is no real deprecated path to test against. Scoping substitute: build the deprecation-redirect mechanism itself (a small registry of retired-path → current-path mappings, currently empty in production but exercised by the test with one synthetic entry added specifically for this test, e.g. registering a fake `/v0/usage` as deprecated in favor of `/usage`), and prove the mechanism works end-to-end. When a real path is deprecated in a future story, it uses this same registry and this test's coverage becomes literal rather than synthetic.

Everything else this story references already exists: the full REST API surface of both services, `sdks/python`, `sdks/typescript`.

## Architecture and design

**No new database schema.** This is a documentation-and-tooling story; its "application code" is (a) the docs content itself, (b) a coverage-checking script, (c) a code-sample-execution test harness, and (d) the small deprecated-path-redirect registry for T7.

**Docs location:** `docs/api/` -- one Markdown file per resource group (e.g. `customers.md`, `usage.md`, `grants.md`, `plans.md`, `ledger.md`, `stripe-connect.md`, `sandbox.md`, `auth.md`, `errors.md`), each listing every route in that group with method, path, auth requirement, request/response shape, every documented error/reason code for that route, and one worked `curl` (or SDK) example per route. A top-level `docs/api/README.md` indexes all groups. `docs/quickstart.md` is the standalone guide for AC2, built from real `sdks/python`/`sdks/typescript` snippets (reuse the SDKs' own existing README examples as a starting point rather than inventing new untested snippets). `docs/guarantees.md` covers AC3 (exactly-once, ordering, degraded mode), each guarantee naming the exact test file/suite that verifies it (e.g. "exactly-once ingestion is verified by `tests/usage-ingestion/functional-adversarial.test.ts`'s idempotency-key tests and `tests/idempotency`'s TEID-31 suite").

**Coverage-checking mechanism (T1):** a script, `docs/api/check-coverage.ts` (or `.mjs`, runnable via `npx tsx`), that (a) introspects the actual registered routes -- for `services/ts-console`, walk `consoleRoute`/`app.get/post/patch/delete` registrations the same way `tests/rbac/rbac.test.ts`'s TEID-43-T5 route-manifest completeness check already does (reuse that same introspection approach/helper if one is factored out there, rather than writing a second one from scratch); for `services/go-usage`, walk `main.go`'s `mux.Handle` registrations -- and (b) diffs the introspected route list against `docs/api/`'s documented routes (parsed from the Markdown files' own method+path headers, or from a small sidecar `docs/api/routes.json` manifest the docs generation keeps in sync, whichever is less brittle to implement). This script is run as a real automated test (`tests/docs/coverage.test.ts` invoking it and asserting zero undocumented routes), not just a standalone tool nobody runs -- this is what makes T1 a real, CI-gated assertion rather than a one-time manual audit.

**Code-sample execution (T6):** every fenced code block in `docs/api/*.md` and `docs/quickstart.md` tagged with a language+`runnable` marker (e.g. ` ```bash runnable ` or ` ```python runnable `) is extracted by a test harness (`tests/docs/run-examples.test.ts`) and actually executed against a live running stack (same fixture tenant/API-key conventions as every other test suite in this repo), asserting each exits zero / returns a 2xx where applicable. A code block without the `runnable` marker (e.g. an illustrative response-shape snippet with no live call to make) is exempt -- document this convention at the top of `docs/api/README.md` so authors know which blocks are held to this bar.

**Deprecated-path registry (T7):** a small new table or, simpler and sufficient for this story's real scope, an in-memory/config-file registry in `services/ts-console` (`services/ts-console/src/lib/deprecatedRoutes.ts`, a `Record<string, string>` of old path → current path/docs anchor) checked by a shared middleware that returns a `410 Gone` with `{ error: "this path is deprecated", see: "<current path or docs URL>" }` for any request matching a registered old path, registered before the normal router so it takes precedence. Empty in production; the test registers one synthetic entry for its own use.

**Accessibility (T5):** the docs are rendered as static HTML (a minimal static-site step -- a Markdown-to-HTML renderer is sufacient, e.g. reuse the same rendering the project already has access to via its npm dependency tree if one exists, or add a small, standard one; this does not need a full docs-site framework for 5 points of scope). `tests/docs/accessibility.test.ts` runs an automated `axe-core` scan (via `@axe-core/playwright` or `axe-core` + `jsdom`, whichever is lighter to add given this repo's existing test tooling) against the rendered `docs/quickstart.md` HTML output and asserts zero WCAG 2.1 AA violations.

## Implementation guidance per test

### TEID-62-T1
Run `docs/api/check-coverage.ts` as a test. Assert it reports zero routes present in the live route registrations that are absent from `docs/api/`'s documented set, and zero documented routes that no longer exist (a stale-doc check in the same direction, valuable even though not explicitly named in the AC). Additionally assert every route's documented entry includes at least one example block.

### TEID-62-T2
Write a script that performs, in order, using only instructions copied verbatim from `docs/quickstart.md` (a literal fidelity check -- the test should fail if the script needs any step the doc doesn't actually say): create an API key, perform one entitlement/plan-rate-check call, send one usage event, and confirm the event is queryable back. Assert the whole script exits successfully within a 5-minute wall-clock bound. Separately, `docs/quickstart-trial-results.md` documents the real single-developer walkthrough referenced by this AC's "developer with no prior exposure" framing -- write it up as part of this story's own completion, not as a repeatable test.

### TEID-62-T3
A test that parses `docs/guarantees.md` and asserts it names all three guarantees (exactly-once, ordering, degraded mode) and that each entry's named test suite/file actually exists on disk (e.g. resolve `tests/usage-ingestion/functional-adversarial.test.ts` and assert the file is present) -- this catches the doc drifting to reference a suite that got renamed or removed.

### TEID-62-T4
Not an automated test. `docs/quickstart-trial-results.md` records the 5-developer trial: each developer's completion time, the computed median, and every friction point logged verbatim. This file is part of this story's Definition of Done but is not part of the automated test suite.

### TEID-62-T5
Render `docs/quickstart.md` to static HTML via the chosen renderer, run the axe-core scan against the rendered output, assert zero AA-level violations. If any are found, fix the actual Markdown/rendering (heading structure, alt text, color contrast in any custom CSS) rather than suppressing the finding.

### TEID-62-T6
Extract every ` ```lang runnable ` block from `docs/**/*.md`, execute each in order against a live test stack, assert each succeeds. Deliberately seed the test run against a fresh-enough environment that a stale hardcoded ID or expired token in an example would actually fail -- this is the whole point of T6, so the harness must not paper over a failure by, e.g., always using a hardcoded known-good fixture the example itself doesn't create.

### TEID-62-T7
Register one synthetic deprecated-path entry (e.g. `/v0/usage` → `/usage`) via the test's own setup, call the deprecated path, and assert a `410` with a `see` field pointing at the current path/docs location -- not a generic 404, which would look like "failing silently" from the caller's perspective (indistinguishable from a typo) rather than a clear deprecation signal.

## File layout

- `docs/api/README.md`, `docs/api/*.md` (per-resource docs), `docs/api/check-coverage.ts`, `docs/api/routes.json` (if used as the sidecar manifest).
- `docs/quickstart.md`, `docs/guarantees.md`, `docs/quickstart-trial-results.md`.
- `services/ts-console/src/lib/deprecatedRoutes.ts` (new) -- the registry and middleware.
- `services/ts-console/src/server.ts` -- wire the deprecation middleware ahead of the normal router.
- Tests: new directory `tests/docs/` implementing T1, T3, T6, T7 as real automated tests, plus T2's scripted-walkthrough proxy and T5's accessibility scan.

## Definition of done

- [ ] AC1 and AC3 satisfied by working documentation content, cross-checked by the automated coverage/link tests above (T1, T3).
- [ ] AC2 satisfied by `docs/quickstart.md` plus the T2 automated proxy passing; the human trial (T2's manual half, T4) is completed once and written up in `docs/quickstart-trial-results.md`.
- [ ] T1, T3, T5, T6, T7 all pass as real, repeatable automated tests.
- [ ] `tsc --noEmit` is clean in `services/ts-console`.
- [ ] `tests/cross-tenant`, `tests/console-auth`, `tests/api-keys`, `tests/rbac` all still pass unchanged (the new deprecation middleware must not intercept any real, non-deprecated route).
- [ ] The suite passes against a database rebuilt from scratch using only committed migration/seed scripts.
- [ ] PR description includes a checklist mapping each test ID to the file/line that covers it, and explicitly notes T2/T4's manual-trial component and where its results are written up.
