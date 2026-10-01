# TEID-98.2 — Prompt for Claude

Use this in Claude Code against `tenseur-ai/Teideal` `main` after merged PR #61 (`ed79fb66`).

This is hygiene on the connector landing zone plus one real CI lie. It is not TEID-65.

---

You are implementing TEID-98.2 — residual landing-zone and CI fixes — on tenseur-ai/Teideal.

Do not implement TEID-65. No live Stripe API. No OAuth rewrite. No Metronome/Orb/Lago.
Do not convert connector money fields to JS `number`.
Do not invent a second common model.
Do not revert TEID-98 or TEID-98.1 behavior that already passed review.

## Why

Independent review of PR #61: landing zone is good enough to start Verify Stripe **after** these leftovers. Two are real defects (CI install drift; `product_id` when fixture `product` is a name string). One is a standing CI failure that three unrelated PRs have waved through (`tests/stripe-connect` GCM auth-tag mismatch). Two items are comments only.

## Files you may touch

- `.github/workflows/ci.yml` — connectors suite install line only, unless the Stripe GCM fix needs a missing env var in the same job
- `services/ts-console/src/lib/connectors/mockConnector.ts` — `mapConnectorPrice` / `decimalAmount` comments + product_id rule
- `services/ts-console/src/lib/connectors/credentials.ts` — add the Stripe-token boundary comment (was specified for 98.1, still missing here)
- `services/ts-console/src/lib/connectors/syncHealth.ts` — one-line comment that JSONB `||` is a shallow key merge
- `NOTES-TEID-98.md` — append 98.2 notes
- New: `specs/TEID-98.2.md` (short, same template)
- `tests/connectors/**` — only tests for product_id + decimalAmount contract
- `tests/stripe-connect/**` and `services/ts-console/src/lib/stripeConnect.ts` **only if** required to fix the GCM mismatch. Prefer the smallest fix. Do not redesign Connect.

Forbidden: new connector types, rating kernel, generic `POST /connectors`, deleting T5 500k.

## Work items

### 1. CI: `tests/connectors` must use `npm ci`

In `.github/workflows/ci.yml` the step "Install connector framework suite dependencies" is still:

```yaml
npm install --no-audit --no-fund
```

Change it to `npm ci`, matching `tests/stripe-connect`, `tests/rbac`, etc.

`tests/connectors/package-lock.json` is already committed. If `npm ci` fails, fix the lockfile in that directory — do not revert to `npm install`.

### 2. `product_id` must not be a product name

In `mapConnectorPrice` today:

```ts
product_id: typeof product === "string" ? product : product.id ?? null,
product_name: typeof product === "string" ? product : product.name,
```

When `product` is a bare string it is used as **both** name and id. That is wrong for TEID-65 (Stripe ids are `prod_…`).

Rule:

- `product` is `{ id?, name }` → `product_id = id ?? null`, `product_name = name`
- `product` is a string matching `/^prod_/` (or another explicit id prefix you document) → `product_id = product`, `product_name = product` only if you have no other name (acceptable for fixtures)
- `product` is any other string (a display name) → `product_id = null`, `product_name = product`

Add TEID-98.2-T1 covering all three shapes.

### 3. `decimalAmount` contract — document and guard

Keep integer-minor-unit input only. Add a comment on `decimalAmount` that callers must pass Stripe-style integer minor units, never a major-unit decimal string.

If the input already contains `.`, throw `ConnectorError` (already true via `/^-?\d+$/`). Add TEID-98.2-T2: `"10.01"` + `"USD"` throws; `1001` + `"USD"` → `"10.01"`; `100` + `"JPY"` → `"100"`.

Do not add a second converter that accepts major units. TEID-65 maps with this helper only.

### 4. Stripe token comment on `credentials.ts`

Add a file-level comment:

> `CONNECTOR_CREDENTIAL_ENCRYPTION_KEY` encrypts API-key connector secrets on `connectors.credential_*`.
> Stripe Connect OAuth access/refresh tokens stay on `stripe_connections` under `STRIPE_TOKEN_ENCRYPTION_KEY`.
> TEID-65 must read Stripe tokens from `stripe_connections` and must not copy them into `connectors.credential_*`.

No behavior change.

### 5. Watermark merge comment

On the `cursor_high_water || $4::jsonb` update in `syncHealth.ts`, comment that `||` is **shallow**: each entity key is replaced as a whole `{since, cursor}` object. Nested merge is not supported. No code change unless the current SQL does something different (it should not).

### 6. Fix the `tests/stripe-connect` GCM auth-tag mismatch

This failure has been reported on TEID-48, TEID-98, and TEID-98.1 verifications and called “env, not this PR.” That is no longer acceptable. Three PRs waving it through means CI does not actually prove Stripe token encrypt/decrypt.

Do this:

1. Run `tests/stripe-connect` and capture the exact failing test name and assertion.
2. Root-cause: key bytes differ between encrypt and decrypt; IV/auth tag column swap; `STRIPE_TOKEN_ENCRYPTION_KEY` missing in one process; base64 vs raw key; test encrypts with key A and server decrypts with key B.
3. Fix the smallest real cause. Typical in this repo: test helper and `ts-console` must use the **same** 32-byte key that CI already exports (`STRIPE_TOKEN_ENCRYPTION_KEY` in `ci.yml`).
4. After the fix: `tests/stripe-connect` green on a DB rebuilt from committed migrations. Do not skip or `it.skip` the failing case.
5. In `NOTES-TEID-98.md` write the root cause in one paragraph. If you cannot reproduce, say so and leave the tests failing — do not invent a “flake” story.

Do not “fix” GCM by catching decrypt errors and returning empty tokens.

## Tests catalog

| ID | Requirement |
|---|---|
| TEID-98.2-T1 | Three product shapes → product_id/name as specified above. |
| TEID-98.2-T2 | decimalAmount USD/JPY plus reject dotted major-unit string. |
| TEID-98.2-T3 | Existing TEID-98-T1..T8 and TEID-98.1-T1..T6 still pass. |
| TEID-98.2-T4 | `tests/stripe-connect` suite green (the previously failing GCM case included). |

## Definition of done

- `npm ci` is what CI runs in `tests/connectors`.
- `tsc --noEmit` clean.
- `tests/connectors` green.
- `tests/stripe-connect` green for a reason you can explain, not because a test was deleted.
- `stripeConnect.ts` changes only if required for T4, and still AES-256-GCM with auth tag.
- PR against the current agent integration branch.
- Branch: `claude/teid-98.2-residuals` (or `codex/teid-98.2-residuals`).
- PR body maps each TEID-98.2-T* to file/line.
- Stop. Do not start TEID-65 in this PR.

## Implementation rules

- Prompt wins over older specs if they conflict; note conflicts in `NOTES-TEID-98.md`.
- No floating point for money.
- No unique constraint on `(tenant_id, connector_type)` alone.
- WIP: this story only.
