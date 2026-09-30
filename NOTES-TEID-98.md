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
