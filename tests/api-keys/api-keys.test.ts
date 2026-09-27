import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, withTenant } from "./db.js";
import { GO_USAGE_URL, TS_CONSOLE_URL } from "./env.js";
import { call } from "./http.js";
import { CUSTOMER_ID, OWNER_ID, TENANT_ID, ownerSession } from "./session.js";

let sessionToken: string;

beforeAll(async () => { sessionToken = await ownerSession(); });
afterAll(() => pool.end());

async function createKey(scope: string, environment: "sandbox" | "production" = "sandbox") {
  const response = await call(`${TS_CONSOLE_URL}/api-keys`, {
    method: "POST",
    token: sessionToken,
    body: { scope, environment, label: `test-${randomUUID()}` },
  });
  expect(response.status).toBe(201);
  return response.body as { id: string; key: string; scope: string; environment: string; label: string; display_hint: string };
}

async function customerGet(key: string) {
  return call(`${TS_CONSOLE_URL}/customers`, { token: key });
}

async function customerPost(key: string) {
  const marker = randomUUID();
  return call(`${TS_CONSOLE_URL}/customers`, {
    method: "POST", token: key, body: { name: `Scope ${marker}`, email: `${marker}@example.test` },
  });
}

async function usageGet(key: string) {
  return call(`${GO_USAGE_URL}/usage`, { token: key });
}

async function usagePost(key: string) {
  return call(`${GO_USAGE_URL}/usage`, {
    method: "POST",
    token: key,
    body: {
      customer_id: CUSTOMER_ID,
      event_type: "api_call",
      quantity: 1,
      idempotency_key: `teid-92-${randomUUID()}`,
    },
  });
}

describe("TEID-92 API key lifecycle", () => {
  // TEID-92-T1 (Functional): creation persists scope/environment and the
  // exact scope table is enforced in both API-key-authenticated services.
  it("TEID-92-T1 creates scoped keys and enforces every route-to-scope mapping", async () => {
    const readOnly = await createKey("read-only", "production");
    expect(readOnly.scope).toBe("read-only");
    expect(readOnly.environment).toBe("production");
    expect(readOnly.key).toMatch(/^sk_live_[A-Za-z0-9_-]{43}$/);
    const detail = await call(`${TS_CONSOLE_URL}/api-keys/${readOnly.id}`, { token: sessionToken });
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ scope: "read-only", environment: "production" });
    expect((await customerGet(readOnly.key)).status).toBe(200);
    expect((await usageGet(readOnly.key)).status).toBe(200);
    expect((await customerPost(readOnly.key)).status).toBe(403);
    expect((await usagePost(readOnly.key)).status).toBe(403);

    const ingestOnly = await createKey("ingest-only");
    expect((await usagePost(ingestOnly.key)).status).toBe(201);
    expect((await usageGet(ingestOnly.key)).status).toBe(403);
    expect((await customerGet(ingestOnly.key)).status).toBe(403);
    expect((await customerPost(ingestOnly.key)).status).toBe(403);

    const admin = await createKey("admin");
    expect((await usagePost(admin.key)).status).toBe(201);
    expect((await usageGet(admin.key)).status).toBe(200);
    expect((await customerGet(admin.key)).status).toBe(200);
    expect((await customerPost(admin.key)).status).toBe(201);
  });

  // TEID-92-T2 (Functional): plaintext appears in the create response only;
  // detail returns the persisted non-secret mask.
  it("TEID-92-T2 displays plaintext once and only the mask afterward", async () => {
    const created = await createKey("read-only", "production");
    expect(created.key).toMatch(/^sk_live_[A-Za-z0-9_-]{43}$/);
    const detail = await call(`${TS_CONSOLE_URL}/api-keys/${created.id}`, { token: sessionToken });
    expect(detail.status).toBe(200);
    expect(detail.body).not.toHaveProperty("key");
    expect(detail.body).not.toHaveProperty("key_hash");
    expect(detail.body.display_hint).toMatch(/^sk_live_\*{4}[A-Za-z0-9_-]{4}$/);
  });

  // TEID-92-T3 (Functional): default rotation overlaps for 24 hours, then
  // the old key fails while the replacement remains valid.
  it("TEID-92-T3 rotates with a 24-hour grace period and expires only the old key", async () => {
    const oldKey = await createKey("read-only", "production");
    const rotated = await call(`${TS_CONSOLE_URL}/api-keys/${oldKey.id}/rotate`, {
      method: "POST", token: sessionToken, body: {},
    });
    expect(rotated.status).toBe(201);
    const newKey = rotated.body as { id: string; key: string };
    const expiry = await pool.query<{ hours: number }>(
      `SELECT extract(epoch FROM (expires_at - now())) / 3600 AS hours FROM api_keys WHERE id = $1`, [oldKey.id],
    );
    expect(Number(expiry.rows[0].hours)).toBeGreaterThan(23.9);
    expect(Number(expiry.rows[0].hours)).toBeLessThanOrEqual(24);

    await pool.query(`UPDATE api_keys SET expires_at = now() + interval '1 hour' WHERE id = $1`, [oldKey.id]);
    expect((await customerGet(oldKey.key)).status).toBe(200);
    expect((await customerGet(newKey.key)).status).toBe(200);
    await pool.query(`UPDATE api_keys SET expires_at = now() - interval '1 hour' WHERE id = $1`, [oldKey.id]);
    expect((await customerGet(oldKey.key)).status).toBe(401);
    expect((await customerGet(newKey.key)).status).toBe(200);
  });

  // TEID-92-T4 (Functional): revocation is checked synchronously on the next
  // request, with no cache or propagation window in today's architecture.
  it("TEID-92-T4 rejects a previously used read-only key immediately after revocation", async () => {
    const key = await createKey("read-only");
    expect((await customerGet(key.key)).status).toBe(200);
    expect((await usageGet(key.key)).status).toBe(200);
    const revoked = await call(`${TS_CONSOLE_URL}/api-keys/${key.id}/revoke`, { method: "POST", token: sessionToken });
    expect(revoked.status).toBe(200);
    expect((await customerGet(key.key)).status).toBe(401);
    expect((await usageGet(key.key)).status).toBe(401);
  });

  // TEID-92-T5 (Functional): management metadata is complete and exactly one
  // audit row represents each create, rotate, and revoke action.
  it("TEID-92-T5 exposes lifecycle metadata and records three distinct audits", async () => {
    const original = await createKey("read-only");
    expect((await customerGet(original.key)).status).toBe(200);
    const rotated = await call(`${TS_CONSOLE_URL}/api-keys/${original.id}/rotate`, {
      method: "POST", token: sessionToken, body: {},
    });
    expect(rotated.status).toBe(201);
    const revoked = await call(`${TS_CONSOLE_URL}/api-keys/${rotated.body.id}/revoke`, {
      method: "POST", token: sessionToken,
    });
    expect(revoked.status).toBe(200);

    const detail = await call(`${TS_CONSOLE_URL}/api-keys/${original.id}`, { token: sessionToken });
    expect(detail.body).toMatchObject({ creator_user_id: OWNER_ID, scope: "read-only" });
    expect(new Date(detail.body.created_at).getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(detail.body.last_used_at).not.toBeNull();
    const audits = await withTenant(TENANT_ID, async (client) =>
      (await client.query(
        `SELECT object_id, before, after FROM audit_log
         WHERE object_type = 'ApiKey' AND object_id = ANY($1::text[])
         ORDER BY id`,
        [[original.id, rotated.body.id]],
      )).rows,
    );
    expect(audits).toHaveLength(3);
    expect(audits.filter((row) => row.before === null)).toHaveLength(1);
    expect(audits.some((row) => row.after.status === "expiring" && row.after.rotated_to_id === rotated.body.id)).toBe(true);
    expect(audits.some((row) => row.after.status === "revoked")).toBe(true);
  });

  // TEID-92-T6 (Non-functional, scoped): there are no regional edge nodes
  // yet. Twenty trials prove the real synchronous Postgres check rejects on
  // the first request and stays far inside the documented 60-second SLA.
  it("TEID-92-T6 makes revocation effective immediately in every trial", async () => {
    const elapsed: number[] = [];
    for (let trial = 0; trial < 20; trial++) {
      const key = await createKey("read-only");
      const start = performance.now();
      expect((await call(`${TS_CONSOLE_URL}/api-keys/${key.id}/revoke`, { method: "POST", token: sessionToken })).status).toBe(200);
      const rejected = trial % 2 === 0 ? await customerGet(key.key) : await usageGet(key.key);
      expect(rejected.status).toBe(401);
      elapsed.push(performance.now() - start);
    }
    expect(elapsed.every((duration) => duration < 60_000)).toBe(true);
  });

  // TEID-92-T7 (Non-functional): 1,000 direct fixtures remain fully
  // reachable, without duplicates, through bounded keyset pages.
  it("TEID-92-T7 paginates 1,000 keys without timeout or duplication", async () => {
    const marker = `T7-${randomUUID()}`;
    const inserted = (await pool.query<{ id: string }>(
      `INSERT INTO api_keys (issued_to_tenant_id, key_hash, label, scope, environment, display_hint)
       SELECT $1, encode(sha256(($2 || g)::bytea), 'hex'), $2,
              CASE WHEN g % 3 = 0 THEN 'ingest-only' WHEN g % 3 = 1 THEN 'read-only' ELSE 'admin' END,
              CASE WHEN g % 2 = 0 THEN 'sandbox' ELSE 'production' END,
              'bulk-****' || lpad((g % 10000)::text, 4, '0')
       FROM generate_series(1, 1000) AS g
       RETURNING id`,
      [TENANT_ID, marker],
    )).rows.map((row) => row.id);

    const firstStart = performance.now();
    const first = await call(`${TS_CONSOLE_URL}/api-keys?limit=200`, { token: sessionToken });
    expect(performance.now() - firstStart).toBeLessThan(2_000);
    expect(first.status).toBe(200);
    expect(first.body.data).toHaveLength(200);
    expect(first.body.cursor).toBeTruthy();

    const seen = new Set<string>();
    let page = first.body;
    for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
      for (const row of page.data as Array<{ id: string }>) {
        expect(seen.has(row.id)).toBe(false);
        seen.add(row.id);
      }
      if (!page.cursor) break;
      const next = await call(`${TS_CONSOLE_URL}/api-keys?limit=200&cursor=${page.cursor}`, { token: sessionToken });
      expect(next.status).toBe(200);
      page = next.body;
    }
    for (const id of inserted) expect(seen.has(id), `missing bulk key ${id}`).toBe(true);
  });

  // TEID-92-T8 (Adversarial, scoped): rate limiting does not exist yet; this
  // proves the real requirement that rotation never elevates the old key.
  it("TEID-92-T8 preserves an old key's read-only scope throughout grace", async () => {
    const oldKey = await createKey("read-only");
    expect((await customerGet(oldKey.key)).status).toBe(200);
    expect((await customerPost(oldKey.key)).status).toBe(403);
    const rotated = await call(`${TS_CONSOLE_URL}/api-keys/${oldKey.id}/rotate`, {
      method: "POST", token: sessionToken, body: {},
    });
    expect(rotated.status).toBe(201);
    expect((await customerGet(oldKey.key)).status).toBe(200);
    expect((await customerPost(oldKey.key)).status).toBe(403);
  });

  // TEID-92-T9 (Adversarial): API responses expose no secret/hash and the
  // database contains the expected one-way SHA-256 hash but no plaintext.
  it("TEID-92-T9 never persists or re-exposes recoverable plaintext", async () => {
    const created = await createKey("read-only", "production");
    const detail = await call(`${TS_CONSOLE_URL}/api-keys/${created.id}`, { token: sessionToken });
    const list = await call(`${TS_CONSOLE_URL}/api-keys?limit=200`, { token: sessionToken });
    expect(JSON.stringify(detail.body)).not.toContain(created.key);
    expect(JSON.stringify(list.body)).not.toContain(created.key);
    for (const row of list.body.data) {
      expect(row).not.toHaveProperty("key");
      expect(row).not.toHaveProperty("key_hash");
    }

    const stored = (await pool.query(`SELECT * FROM api_keys WHERE id = $1`, [created.id])).rows[0];
    expect(stored.key_hash).toBe(createHash("sha256").update(created.key).digest("hex"));
    expect(JSON.stringify(stored)).not.toContain(created.key);
    const columns = (await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'api_keys'`,
    )).rows.map((row) => row.column_name);
    expect(columns).toContain("key_hash");
    expect(columns).not.toContain("key");
    expect(columns).not.toContain("plaintext");
  });
});
