// TEID-91-T6 (Non-functional): 5,000 sessions expiring within the same
// minute are all reclaimed by the sweep without degrading sign-in latency
// for concurrent new logins.
import { describe, expect, it } from "vitest";
import { TS_CONSOLE_URL, ADMIN_SECRET } from "./env.js";
import { TENANT_KEY } from "./fixtures.js";
import { call } from "./http.js";
import { createDisposableUser } from "./testUsers.js";
import { pool } from "./db.js";

const TENANT1_ID = "00000000-0000-0000-0000-000000001001";
const OWNER_USER_ID = "00000000-0000-0000-0000-0000a0001001";
const SESSION_COUNT = 5000;
const CONCURRENCY = 10;

async function timedLogin(email: string, password: string): Promise<number> {
  const start = Date.now();
  const res = await call(`${TS_CONSOLE_URL}/auth/login`, {
    method: "POST",
    body: { tenant_key: TENANT_KEY, email, password },
  });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  return Date.now() - start;
}

async function concurrentLoginBatchMaxMs(): Promise<number> {
  const users = await Promise.all(Array.from({ length: CONCURRENCY }, () => createDisposableUser("Support")));
  const durations = await Promise.all(users.map((u) => timedLogin(u.email, u.password)));
  return Math.max(...durations);
}

describe("TEID-91-T6: bulk session expiry does not degrade new-login latency", () => {
  it("sweeps 5000 expired sessions while concurrent logins stay comparably fast", async () => {
    // Baseline: bcryptjs is CPU-bound and doesn't truly parallelize across
    // concurrent requests, so a batch of concurrent logins is already
    // slower than one login in isolation *before* the sweep is involved.
    // The comparison that actually isolates the sweep's cost is
    // concurrent-with-sweep against concurrent-without-sweep, not against
    // a single serial login.
    const withoutSweepMaxMs = await concurrentLoginBatchMaxMs();

    // Bulk insert in one statement -- 5000 individual round trips would
    // measure this test's overhead, not the sweep's.
    await pool.query(
      `INSERT INTO sessions (issued_to_tenant_id, user_id, token_hash, idle_timeout_minutes, created_at, last_seen_at)
       SELECT $1, $2, encode(sha256(gen_random_uuid()::text::bytea), 'hex'), 1,
              now() - interval '2 hours', now() - interval '2 hours'
       FROM generate_series(1, ${SESSION_COUNT})`,
      [TENANT1_ID, OWNER_USER_ID],
    );

    const concurrentUsers = await Promise.all(Array.from({ length: CONCURRENCY }, () => createDisposableUser("Support")));
    const [sweepResult, ...withSweepDurations] = await Promise.all([
      call(`${TS_CONSOLE_URL}/admin/session-sweep`, { method: "POST", adminKey: ADMIN_SECRET }),
      ...concurrentUsers.map((u) => timedLogin(u.email, u.password)),
    ]);
    const withSweepMaxMs = Math.max(...withSweepDurations);

    expect(sweepResult.status).toBe(200);
    expect(sweepResult.body.removed).toBeGreaterThanOrEqual(SESSION_COUNT);

    const degradationBound = Math.max(withoutSweepMaxMs * 2, 300);
    expect(withSweepMaxMs).toBeLessThan(degradationBound);

    // idle_timeout_minutes = 1 is this test's own marker for the synthetic
    // rows -- real logins always use 30 or 480 -- so this checks exactly
    // the rows this test seeded, not incidentally any other still-valid
    // Owner session another test file left behind.
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM sessions WHERE user_id = $1 AND idle_timeout_minutes = 1`,
      [OWNER_USER_ID],
    );
    expect(rows[0].n).toBe(0);
  });
});
