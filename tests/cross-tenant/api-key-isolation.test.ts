// TEID-41-T2 regression extension from TEID-92: api_keys deliberately has
// no RLS, so every management endpoint must enforce issued_to_tenant_id
// manually. acct_1001 is the attacker; acct_1002 owns the victim key.
import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { DATABASE_URL, TS_CONSOLE_URL, loadFixtures, type Fixtures } from "./env.js";
import { call } from "./http.js";

const pool = new pg.Pool({ connectionString: DATABASE_URL });
let fx: Fixtures;
let attackerSession: string;
let victimKeyId: string;

beforeAll(async () => {
  fx = loadFixtures();
  attackerSession = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(attackerSession).digest("hex");
  await pool.query(
    `INSERT INTO sessions (issued_to_tenant_id, user_id, token_hash, idle_timeout_minutes)
     VALUES ($1, $2, $3, 480)`,
    [fx.tenant1.id, "00000000-0000-0000-0000-0000a0001001", tokenHash],
  );
  victimKeyId = (await pool.query<{ id: string }>(
    `SELECT id FROM api_keys WHERE issued_to_tenant_id = $1 AND label = 'test-fixture'`, [fx.tenant2.id],
  )).rows[0].id;
});

afterAll(() => pool.end());

describe("TEID-41-T2: API key management tenant isolation", () => {
  it("GET /api-keys returns 200 without any victim key", async () => {
    const response = await call(`${TS_CONSOLE_URL}/api-keys?limit=200`, { apiKey: attackerSession });
    expect(response.status).toBe(200);
    expect(response.body.data.map((row: { id: string }) => row.id)).not.toContain(victimKeyId);
    expect(JSON.stringify(response.body)).not.toContain(victimKeyId);
  });

  it("GET /api-keys/:id returns 404 without leaking the victim key", async () => {
    const response = await call(`${TS_CONSOLE_URL}/api-keys/${victimKeyId}`, { apiKey: attackerSession });
    expect(response.status).toBe(404);
    expect(JSON.stringify(response.body)).not.toContain(victimKeyId);
  });

  it("POST /api-keys/:id/rotate returns 403 and leaves the victim key usable", async () => {
    const response = await call(`${TS_CONSOLE_URL}/api-keys/${victimKeyId}/rotate`, {
      method: "POST", apiKey: attackerSession, body: {},
    });
    expect(response.status).toBe(403);
    expect((await call(`${TS_CONSOLE_URL}/customers`, { apiKey: fx.tenant2.apiKey })).status).toBe(200);
  });

  it("POST /api-keys/:id/revoke returns 403 and leaves the victim key usable", async () => {
    const response = await call(`${TS_CONSOLE_URL}/api-keys/${victimKeyId}/revoke`, {
      method: "POST", apiKey: attackerSession, body: {},
    });
    expect(response.status).toBe(403);
    expect((await call(`${TS_CONSOLE_URL}/customers`, { apiKey: fx.tenant2.apiKey })).status).toBe(200);
  });
});
