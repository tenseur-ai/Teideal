# TEID-98 implementation notes

The contract leaves two low-level behaviors underspecified or internally tense.
They were resolved conservatively as follows:

1. A conventional token bucket with capacity equal to `requestsPerMinute` can
   issue a full minute's allowance immediately, which conflicts with the
   stronger statement that throughput must never exceed the configured rate.
   The shared client therefore uses a one-token bucket with continuous refill.
   This preserves token-bucket behavior while making the configured RPM a hard
   pacing bound, including for physical retry attempts.
2. Independent random 10% failures almost never produce five consecutive
   failures in a small contract run, so TEID-98-T7 would be flaky and usually
   would not exhaust `maxAttempts`. The fake target assigns intermittent
   failure deterministically by logical page: 10% of pages are "unlucky" and
   continue returning 500 on their retries. This retains the configured 10%
   page failure rate and guarantees that the contract suite can prove it flags
   an exhausted page.

## TEID-98.1 (post-merge follow-up, 2026-09-30)

Implements `specs/TEID-98.1.md`, a remediation for three real gaps an
independent review found in the merged design above (`passthrough`/invoice
lines missing from the common model, a hardcoded 2-decimal currency
assumption, no persisted incremental-sync watermark). See that spec's own
"Scoping notes" for the full reasoning. Notes on this round's own
implementation choices go here, appended below this line by whichever agent
implements it.

- The common fixture mappers now reserve only normalized source keys and copy
  every remaining top-level fixture key into `passthrough`. Optional source
  fields map to explicit `null`/empty-array values, keeping every returned
  entity structurally stable even when older fixtures omit the new data.
- Minor-unit conversion uses an explicit 0-digit set (JPY, KRW, VND), an
  explicit 3-digit set (KWD, BHD, OMR, JOD), and a safe 2-digit default. The
  conversion slices padded strings and never coerces an amount through
  `Number`.
- `completeSync` serializes a supplied successful watermark for a shallow
  JSONB merge in the existing connector-row update. Failed outcomes bind no
  watermark value, so they cannot advance prior progress; their stored error
  text is sliced to 500 characters.
- The sync-health route already returned the rows from `getSyncHealth`
  directly, so adding `cursor_high_water` to that query and result type passes
  it through without changing the established role gate.
- No conflict was found between `specs/TEID-98.1.md` and
  `TEID-98.1-Claude-Prompt.md`; the source prompt therefore required no
  precedence resolution.

## TEID-98.2 (post-merge follow-up, 2026-10-01)

Implements `specs/TEID-98.2.md`: CI install-step hygiene, a real `product_id`
mapping bug fix, three documentation comments, and item 6 -- the
`tests/stripe-connect` GCM auth-tag mismatch reported identically across
TEID-48, TEID-98, and TEID-98.1's independent verification.

**Root cause of item 6, confirmed by actual reproduction, not inferred (by
the architect, before any remediation code was written):** `stripeConnect.ts`
caches its AES-256-GCM encryption key at module-import time, and
`tests/stripe-connect`'s own test files import that module directly inside
the vitest process -- a separate Node process from the `ts-console` server
every verification pass starts independently. Across all three prior
verification passes, the server was started with an explicit, custom
`STRIPE_TOKEN_ENCRYPTION_KEY`, but the `npx vitest run` command for
`tests/stripe-connect` (and `tests/cross-tenant`, which shares the same
import path) was never given that same variable, so it silently fell back to
`tests/stripe-connect/env.ts`'s own different default key. Two different
keys, one real GCM auth-tag mismatch every time -- not a flake, not an
environment quirk, a straightforward key inconsistency in how verification
was invoked. `.github/workflows/ci.yml` was never affected: it already sets
`STRIPE_TOKEN_ENCRYPTION_KEY` once, for the server-start step, to the exact
value `env.ts`'s own default already is, so every real CI run has correctly
exercised this code path the entire time. Confirmed empirically: a fresh
database, a fresh server, and `tests/stripe-connect`/`tests/cross-tenant` run
with the *same* key passed to both the server and the test command --
`tests/stripe-connect` 16/16, `tests/cross-tenant` 75/75 (including the two
tests previously reported failing in TEID-48/50/98/98.1's own verification
notes). No code in `stripeConnect.ts` or `credentials.ts` was changed for
this item; there was nothing wrong with either file.

Implementation notes for items 1-5:

1. The connector framework dependency install in `.github/workflows/ci.yml`
   now uses `npm ci`, matching the repository's lockfile-driven suite installs.
2. `mapConnectorPrice` now resolves object products, `prod_`-prefixed fixture
   ids, and bare display names explicitly. Bare display names retain their name
   but map to a null `product_id`.
3. `decimalAmount` now documents its integer-minor-units-only contract and the
   intentional absence of a major-unit mode.
4. `credentials.ts` now documents the boundary between API-key connector
   credentials and Stripe Connect OAuth tokens.
5. `completeSync` now documents that PostgreSQL JSONB `||` shallowly replaces
   each supplied top-level entity watermark rather than merging nested fields.

TEID-98.2-T1 covers all three supported product shapes, and TEID-98.2-T2
covers USD and JPY integer-minor-unit conversion plus rejection of a dotted
major-unit string. Existing TEID-98/TEID-98.1 product fixtures already conform
to the corrected mapping, so none of their expectations required adjustment.
