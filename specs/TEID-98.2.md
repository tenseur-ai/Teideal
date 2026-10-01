# TEID-98.2: Connector landing-zone residuals and the stripe-connect CI lie

| | |
|---|---|
| Epic | TEID-11 (E11 -- Implement Teideal Verify independent revenue verification) |
| Phase | E11 -- Implement Teideal Verify independent revenue verification |
| Priority | Highest (blocks TEID-65) |
| Points | 2 |
| Release | mvp |
| Order | 38.2 (between TEID-98.1 and TEID-65 -- not a live-board story; see Story below) |
| Depends on | TEID-98/TEID-98.1 (merged, PR #59/#61) -- `connectors`/`connector_syncs`/`cursor_high_water`, the `Connector` interface, `MockConnector`, `syncHealth.ts`. All already built; this story extends/documents them, does not replace them. |

## Story (not a live-board story -- source is an independent review)

> This story does not come from the live Teideal board. It comes from `TEID-98.2-Claude-Prompt.md` (repo root), an independent review of merged PR #61. Its own framing: *"This is hygiene on the connector landing zone plus one real CI lie. It is not TEID-65."*
>
> Five of its six items were verified directly against the actual code before being accepted: `.github/workflows/ci.yml`'s "Install connector framework suite dependencies" step genuinely uses `npm install --no-audit --no-fund` while every one of the ~20 other install steps in the same file uses `npm ci` -- confirmed by direct count, a real outlier. `mapConnectorPrice`'s `product_id: typeof product === "string" ? product : product.id ?? null` genuinely uses a bare fixture string as both the product's id and its display name -- confirmed by reading the function -- which is wrong the moment a real connector's `product` field is a human-readable name rather than a platform id. `services/ts-console/src/lib/connectors/credentials.ts` genuinely has no file-level comment stating the Stripe Connect OAuth boundary (TEID-98.1's own spec asked for one; it landed on the migration's SQL column comments but never made it into this file). The watermark merge in `syncHealth.ts` has no comment explaining that `||` is a shallow, whole-key JSONB merge.
>
> **The sixth item -- the `tests/stripe-connect` GCM auth-tag mismatch reported identically across TEID-48, TEID-98, and TEID-98.1's independent verification -- was root-caused directly while writing this spec, not deferred again.** It is not a product bug. `stripeConnect.ts` caches its AES-256-GCM key at module-import time; `tests/stripe-connect`'s own test files import that module directly inside the vitest process, a separate Node process from the `ts-console` server every verification pass starts independently. Every one of the three prior verification passes passed a custom `STRIPE_TOKEN_ENCRYPTION_KEY` to the server command but never to the `npx vitest run` command for `tests/stripe-connect` (or `tests/cross-tenant`, which shares the same gap) -- so the test process silently fell back to `tests/stripe-connect/env.ts`'s own different default key, while the server used whichever key the verification command happened to specify. Two different keys, one GCM auth-tag mismatch, every time. **Confirmed empirically before writing a line of remediation code**: a fresh database, a fresh server, and `tests/stripe-connect`/`tests/cross-tenant` run with the *same* `STRIPE_TOKEN_ENCRYPTION_KEY` passed to both the server and the test command -- `tests/stripe-connect` 16/16, `tests/cross-tenant` 75/75 (including the two tests previously reported failing). `.github/workflows/ci.yml` was already doing this correctly the entire time (it sets `STRIPE_TOKEN_ENCRYPTION_KEY` once for the server-start step to the exact same value `env.ts`'s own default already is) -- real CI was never lying; only the architect's own ad hoc local verification commands were inconsistent. No code change is needed or wanted for this item; see Scoping notes.

## Acceptance criteria

1. `tests/connectors`' CI install step uses `npm ci`, matching every other suite in this repo, with its committed lockfile kept in sync.
2. `mapConnectorPrice` never derives `product_id` from a bare display-name string; a real platform id (recognizable by an explicit prefix convention) is distinguished from a human-readable name.
3. `decimalAmount`'s integer-minor-units-only contract is documented on the function itself and covered by a test that a dotted major-unit string is rejected, not silently accepted.
4. `credentials.ts` states the Stripe Connect OAuth boundary in a file-level comment (the same rule TEID-98.1 already enforces via the migration's column comments, now also visible where a future connector author is most likely to actually read it).
5. The `cursor_high_water` shallow-merge behavior is documented at its one call site.
6. `tests/stripe-connect` is confirmed green for a documented, verified reason (a prior verification-process key mismatch, now understood and avoided) -- not because a test was skipped, deleted, or because the underlying cause was left unexplained.

## Cataloged tests (verbatim from `TEID-98.2-Claude-Prompt.md`'s own catalog, AC mapping added here)

| ID | Type | AC | Title |
|---|---|---|---|
| TEID-98.2-T1 | Functional | 2 | Three `product` shapes (`{id, name}`, an explicit `prod_`-prefixed id string, an unprefixed display-name string) each produce the correct `product_id`/`product_name` pair. |
| TEID-98.2-T2 | Adversarial | 3 | `decimalAmount` converts `1001`/`"USD"` to `"10.01"` and `100`/`"JPY"` to `"100"` as before, and rejects `"10.01"`/`"USD"` (a dotted major-unit string) with a `ConnectorError`. |
| TEID-98.2-T3 | Adversarial | 1-5 | Every one of TEID-98's original 8 tests and TEID-98.1's 6 tests still passes unmodified in behavior (T1's `product`-shaped fixtures may need their expected `product_id` updated to match the corrected rule -- see Implementation guidance). |
| TEID-98.2-T4 | Functional | 6 | `tests/stripe-connect`'s full suite passes against a database rebuilt from committed migrations, run with the same `STRIPE_TOKEN_ENCRYPTION_KEY` passed to both the server and the test command. |

## Scoping notes for this point in the build sequence

**This is hygiene plus one documentation/process item, not a design change.** Nothing in TEID-98/TEID-98.1's own architecture changes -- the GET-only `Connector` interface, rate limiting, retry/backoff, the contract suite, the watermark persistence mechanism, and the currency-aware money conversion are all unchanged. Every item here is either a CI config line, a bug-fix inside one existing function, a comment, or (for item 6) a correction to how this codebase's own verification has been run, not to the codebase itself.

**Item 6 requires no code change in `stripeConnect.ts`, `credentials.ts`, or any test file's assertions.** The fix is entirely procedural: document the root cause precisely (done in this spec's Story section and to be echoed in `NOTES-TEID-98.md`), and confirm -- by actually running it, not by asserting it in prose -- that `tests/stripe-connect` passes when the key is held consistent. Do **not** add a workaround that makes the test suite tolerate a key mismatch (e.g. catching the decrypt error and treating it as an expected failure mode, or weakening the GCM check) -- that would hide a real security property (a wrong key must fail loudly) behind a process mistake that has nothing to do with the encryption code's own correctness. The actual deliverable for item 6 is: `NOTES-TEID-98.md` states the root cause in one paragraph (per the source prompt's own instruction), and the PR's own verification section demonstrates a clean `tests/stripe-connect` run with the key held consistent -- exactly what this spec's own investigation already did once, to be repeated as part of this story's independent verification.

**`product_id` rule, restated precisely from the source prompt:** `product` is `{id?, name}` -> `product_id = id ?? null`, `product_name = name` (unchanged from today). `product` is a bare string matching `/^prod_/` -> `product_id = product`, `product_name = product` (acceptable only because no better name exists in that fixture shape). `product` is any other bare string -> `product_id = null`, `product_name = product` (today's actual bug: this case currently sets `product_id` to the display-name string, which is wrong). This changes TEID-98's own T1 fixture's expected output for its `prices` entity (`product: { name: "API calls" }` is unaffected -- that's the first case -- but any *other* existing fixture using a bare non-`prod_`-prefixed string as `product` will need its expected `product_id` updated from that string to `null`).

**`decimalAmount` already rejects a dotted string today** (`/^-?\d+$/` has no `.` in its character class), so AC3's rejection behavior is not new -- what's missing is a test proving it and a comment stating the contract explicitly, so a future connector author reading this function doesn't need to infer the rule from a regex.

**`npm ci` requires a lockfile that's actually in sync with `package.json`.** `tests/connectors/package-lock.json` is already committed (from TEID-98); if `npm ci` fails locally because the lockfile has drifted (e.g. from an `npm install` run against a newer npm resolving slightly different metadata, the same class of incidental drift this session has repeatedly reverted during its own verification passes), regenerate the lockfile for real (a clean `npm install` followed by committing the result) rather than reverting the CI step back to `npm install`.

## Architecture and design

**`.github/workflows/ci.yml`**: change the "Install connector framework suite dependencies" step's `run:` line from `npm install --no-audit --no-fund` to `npm ci`, matching every other install step in the file verbatim.

**`services/ts-console/src/lib/connectors/mockConnector.ts`**, `mapConnectorPrice`:

```ts
const PRODUCT_ID_PREFIX = /^prod_/;

function resolveProduct(product: string | { id?: string; name: string }): { productId: string | null; productName: string } {
  if (typeof product !== "string") return { productId: product.id ?? null, productName: product.name };
  if (PRODUCT_ID_PREFIX.test(product)) return { productId: product, productName: product };
  return { productId: null, productName: product };
}
```

`mapConnectorPrice` calls `resolveProduct(product)` once and uses its two fields in place of today's two separate inline ternaries. Add a one-line comment above `PRODUCT_ID_PREFIX` stating this is a documented, narrow id-recognition convention for fixture/mock data -- a real connector (TEID-65 onward) maps its platform's actual id/name fields directly and does not need this heuristic at all, since a real API response always carries both fields distinctly.

**`decimalAmount`**: add a doc comment immediately above its signature stating the contract explicitly (integer minor units only; a caller holding a major-unit decimal string must convert to the platform's own integer minor-unit representation before calling this function; this function intentionally has no major-unit mode and none should be added).

**`credentials.ts`**: add a file-level comment at the top of the file (below the existing `import`, or above it, whichever this codebase's own convention for file-level comments favors -- check an existing file like `stripeConnect.ts` itself for precedent) stating the exact three sentences from the source prompt's Work item 4, verbatim.

**`syncHealth.ts`**: add a one-line comment directly above (or beside) the `cursor_high_water = CASE ... cursor_high_water || $4::jsonb ...` line in `completeSync`'s SQL, stating that `||` is a shallow merge -- each top-level entity key in the supplied watermark fully replaces that key's prior `{since, cursor}` object, never merges within it.

**`tests/stripe-connect` verification (item 6, no source-code change)**: confirm the suite's own `env.ts` default `STRIPE_TOKEN_ENCRYPTION_KEY` and `.github/workflows/ci.yml`'s explicit server-start value are identical (they are, confirmed during this spec's own investigation) -- no change needed there. The deliverable is the verification record, not a diff.

## Implementation guidance per test

### TEID-98.2-T1
Call `mapConnectorPrice` (or the full `MockConnector` fixture path) with three fixture rows: `product: { id: "prod_abc", name: "API calls" }` -> expect `product_id: "prod_abc"`, `product_name: "API calls"`; `product: "prod_xyz"` -> expect `product_id: "prod_xyz"`, `product_name: "prod_xyz"`; `product: "Compute"` (a bare display name, no `prod_` prefix) -> expect `product_id: null`, `product_name: "Compute"`. Assert all three in one test.

### TEID-98.2-T2
Call `decimalAmount(1001, "USD")` -> assert `"10.01"` (unchanged). Call `decimalAmount(100, "JPY")` -> assert `"100"` (unchanged). Call `decimalAmount("10.01", "USD")` -> assert it throws `ConnectorError` (confirm the existing regex guard still covers this, add the explicit assertion if TEID-98/98.1 never wrote one for exactly this input shape).

### TEID-98.2-T3
Re-run `tests/connectors/connectors.test.ts` in full. If any existing fixture (TEID-98's own T1, or any TEID-98.1 fixture) used a bare non-`prod_`-prefixed string as a `product` value expecting that string back as `product_id`, update that one expected value to `null` -- this is the one legitimate behavior change this story makes, and it is a bug fix, not a regression, so the expectation changes, not the code reverting to match a wrong old expectation.

### TEID-98.2-T4
Start a fresh disposable Postgres container, apply migrations + both seed scripts, build and start `ts-console` with an explicit `STRIPE_TOKEN_ENCRYPTION_KEY`, start `fake-stripe`/`fake-google`, then run `tests/stripe-connect` with the **identical** `STRIPE_TOKEN_ENCRYPTION_KEY` value passed to the `npx vitest run` command. Assert all tests pass. This is the empirical proof for item 6 -- it must actually be run as part of this story's own independent verification, not asserted from the investigation already documented in this spec's Story section (that investigation used a throwaway environment outside any PR's own verification pass; this story's real PR needs its own, equally real, run).

## File layout

- `.github/workflows/ci.yml` (extend) -- one line changed.
- `services/ts-console/src/lib/connectors/mockConnector.ts` (extend) -- `resolveProduct`, `decimalAmount`'s doc comment.
- `services/ts-console/src/lib/connectors/credentials.ts` (extend) -- file-level comment only, no behavior change.
- `services/ts-console/src/lib/connectors/syncHealth.ts` (extend) -- one comment, no behavior change.
- `tests/connectors/connectors.test.ts` (extend) -- TEID-98.2-T1/T2, plus any TEID-98/98.1 fixture expectation updates TEID-98.2-T3 requires.
- `NOTES-TEID-98.md` (extend) -- append TEID-98.2 notes, including the one-paragraph root-cause statement for item 6.
- No new migration, no new route, no new table.

## Definition of done

- [ ] `tests/connectors`'s CI step runs `npm ci`, with a lockfile that's genuinely in sync (confirmed by `npm ci` actually succeeding, not reverted back to `npm install`).
- [ ] `tsc --noEmit` is clean in `services/ts-console`.
- [ ] `tests/connectors` passes in full (TEID-98's original 8, TEID-98.1's 6, TEID-98.2's new 4).
- [ ] `tests/stripe-connect` passes in full, verified with the server and test command given the identical `STRIPE_TOKEN_ENCRYPTION_KEY` -- this is a real, repeatable, documented green run, not an assertion.
- [ ] `tests/cross-tenant` also confirmed clean with the same key-consistency fix applied (the two previously "known" failures there shared the exact same root cause).
- [ ] `stripeConnect.ts` is not modified (this story's own investigation found no defect in it to fix).
- [ ] `NOTES-TEID-98.md` states item 6's root cause in one paragraph.
- [ ] PR description maps each TEID-98.2-T* to the file/line that covers it, and explicitly states that item 6's fix is "none -- process only" alongside the verification evidence.
