import { createRemoteJWKSet, jwtVerify, errors as joseErrors } from "jose";

// Real Google endpoints by default; overridable so tests run against a
// local fake IdP instead of Google's servers (see
// tests/console-auth/fake-google.ts) -- the verification code path itself
// is unchanged between test and production, only the issuer/JWKS/audience
// it trusts differ.
const JWKS_URL = process.env.GOOGLE_JWKS_URL ?? "https://www.googleapis.com/oauth2/v3/certs";
const ISSUER = process.env.GOOGLE_ISSUER ?? "https://accounts.google.com";
const AUDIENCE = process.env.GOOGLE_AUDIENCE ?? "";

// TEID-91-T7: a slow or unreachable IdP must fail cleanly within budget,
// never hang. 2s covers the JWKS fetch (cached after the first call) and
// leaves headroom under whatever the caller's own request timeout is.
const JWKS_FETCH_TIMEOUT_MS = 2_000;

// jose caches fetched keys for cacheMaxAge (default 10 minutes), which
// would otherwise make repeated test runs skip the network entirely and
// never actually exercise injected IdP latency or a timeout. Production
// keeps jose's normal cache; the test suite starts this service with
// GOOGLE_JWKS_CACHE_MAX_AGE_MS=0 so every verification really does fetch.
const JWKS_CACHE_MAX_AGE_MS = process.env.GOOGLE_JWKS_CACHE_MAX_AGE_MS
  ? Number(process.env.GOOGLE_JWKS_CACHE_MAX_AGE_MS)
  : undefined;

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getJwks() {
  // Constructed lazily (not at import time) so tests can override
  // GOOGLE_JWKS_URL before the first verification and get a fresh fetcher
  // pointed at the fake IdP, rather than one baked in at module load.
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(JWKS_URL), {
      timeoutDuration: JWKS_FETCH_TIMEOUT_MS,
      cacheMaxAge: JWKS_CACHE_MAX_AGE_MS,
    });
  }
  return jwks;
}

export interface GoogleIdentity {
  email: string;
  subject: string;
}

export class GoogleVerificationError extends Error {}
// TEID-91-T7: distinguished from other verification failures so the route
// can return a clear timeout message rather than a generic 401.
export class GoogleTimeoutError extends GoogleVerificationError {}

export async function verifyGoogleIdToken(idToken: string): Promise<GoogleIdentity> {
  try {
    const { payload } = await jwtVerify(idToken, getJwks(), {
      issuer: ISSUER,
      audience: AUDIENCE || undefined,
    });
    if (typeof payload.email !== "string" || typeof payload.sub !== "string") {
      throw new GoogleVerificationError("id token missing email or sub claim");
    }
    return { email: payload.email, subject: payload.sub };
  } catch (err) {
    if (err instanceof GoogleVerificationError) throw err;
    if (err instanceof joseErrors.JWKSTimeout) {
      throw new GoogleTimeoutError("timed out reaching the Google identity provider");
    }
    throw new GoogleVerificationError(`google id token verification failed: ${(err as Error).message}`);
  }
}
