import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pool, superuserPool, withTenant } from "./db.js";
import { TS_CONSOLE_URL } from "./env.js";
import { call } from "./http.js";
import { API_KEY, OWNER_ID, TENANT_ID, ownerSession } from "./session.js";

const CSV_HEADER = [
  "id",
  "occurred_at",
  "actor_user_id",
  "actor_api_key_id",
  "customer_id",
  "object_type",
  "object_id",
  "event_type",
  "before",
  "after",
];

afterAll(async () => {
  await Promise.all([pool.end(), superuserPool.end()]);
});

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        index++;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      cell = "";
    } else cell += char;
  }
  if (cell || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

async function currentMaxAuditId(): Promise<string> {
  return withTenant(TENANT_ID, async (client) => {
    const { rows } = await client.query<{ id: string }>(`SELECT COALESCE(max(id), 0)::text AS id FROM audit_log`);
    return rows[0].id;
  });
}

describe("TEID-42 audit log", () => {
  // TEID-42-T1 (Functional): a real Owner-controlled numeric setting change
  // records the human actor, timestamp, and exact before/after values.
  it("TEID-42-T1 records an attributed tenant-settings change", async () => {
    const token = await ownerSession();
    const baselineId = await currentMaxAuditId();
    const original = await withTenant(TENANT_ID, async (client) =>
      (await client.query<{ idle_timeout_minutes: number }>(
        `SELECT idle_timeout_minutes FROM tenant_settings WHERE tenant_id = $1`,
        [TENANT_ID],
      )).rows[0].idle_timeout_minutes,
    );

    try {
      const establish = await call(`${TS_CONSOLE_URL}/tenant-settings`, {
        method: "PATCH",
        token,
        body: { idle_timeout_minutes: 5000 },
      });
      const change = await call(`${TS_CONSOLE_URL}/tenant-settings`, {
        method: "PATCH",
        token,
        body: { idle_timeout_minutes: 7500 },
      });
      expect(establish.status).toBe(200);
      expect(change.status).toBe(200);

      const rows = await withTenant(TENANT_ID, async (client) =>
        (await client.query(
          `SELECT actor_user_id, actor_api_key_id, occurred_at, before, after
           FROM audit_log
           WHERE id > $1 AND object_type = 'TenantSettings'
           ORDER BY id`,
          [baselineId],
        )).rows,
      );
      expect(rows).toHaveLength(2);
      expect(rows[1].actor_user_id).toBe(OWNER_ID);
      expect(rows[1].actor_api_key_id).toBeNull();
      expect(rows[1].before.idle_timeout_minutes).toBe(5000);
      expect(rows[1].after.idle_timeout_minutes).toBe(7500);
      expect(new Date(rows[1].occurred_at).getTime()).toBeGreaterThan(Date.now() - 60_000);
    } finally {
      await superuserPool.query(
        `DELETE FROM audit_log WHERE tenant_id = $1 AND id > $2 AND object_type = 'TenantSettings'`,
        [TENANT_ID, baselineId],
      );
      await superuserPool.query(`UPDATE tenant_settings SET idle_timeout_minutes = $1 WHERE tenant_id = $2`, [original, TENANT_ID]);
    }
  });

  // TEID-42-T2 (Functional): explicit mutation routes reject attempts and
  // leave the target entry byte-for-byte unchanged.
  it("TEID-42-T2 rejects API edits and deletion without changing the row", async () => {
    const token = await ownerSession();
    const marker = `T2-${randomUUID()}`;
    const id = await withTenant(TENANT_ID, async (client) =>
      (await client.query<{ id: string }>(
        `INSERT INTO audit_log (tenant_id, actor_user_id, event_type, object_type, object_id, before, after)
         VALUES ($1, $2, 'config_change', $3, 'target', '{"value":"before"}', '{"value":"after"}')
         RETURNING id`,
        [TENANT_ID, OWNER_ID, marker],
      )).rows[0].id,
    );

    try {
      const listBefore = await call(`${TS_CONSOLE_URL}/audit-log?object_type=${encodeURIComponent(marker)}`, { token });
      expect(listBefore.status).toBe(200);
      expect(listBefore.body.data).toHaveLength(1);
      const snapshot = JSON.stringify(listBefore.body.data[0]);

      const patch = await call(`${TS_CONSOLE_URL}/audit-log/${id}`, { method: "PATCH", token, body: { event_type: "tampered" } });
      const remove = await call(`${TS_CONSOLE_URL}/audit-log/${id}`, { method: "DELETE", token });
      expect(patch.status).toBe(405);
      expect(remove.status).toBe(405);
      expect(patch.body.error).toMatch(/append-only/);
      expect(remove.body.error).toMatch(/append-only/);

      const listAfter = await call(`${TS_CONSOLE_URL}/audit-log?object_type=${encodeURIComponent(marker)}`, { token });
      expect(JSON.stringify(listAfter.body.data[0])).toBe(snapshot);
    } finally {
      await superuserPool.query(`DELETE FROM audit_log WHERE id = $1`, [id]);
    }
  });

  // TEID-42-T3 (Functional): all person/object/date filters are ANDed and
  // the streamed export has the specified headers and correctly escaped JSON.
  it("TEID-42-T3 exports only rows matching every requested filter", async () => {
    const token = await ownerSession();
    const marker = `T3-${randomUUID()}`;
    const otherActor = "00000000-0000-0000-0000-0000a0001004";
    const inRangeA = new Date(Date.now() - 5 * 86_400_000).toISOString();
    const inRangeB = new Date(Date.now() - 10 * 86_400_000).toISOString();
    const outOfRange = new Date(Date.now() - 60 * 86_400_000).toISOString();

    await withTenant(TENANT_ID, async (client) => {
      await client.query(
        `INSERT INTO audit_log
           (tenant_id, occurred_at, actor_user_id, event_type, object_type, object_id, before, after)
         VALUES
           ($1, $2, $3, 'config_change', $4, 'match-a', $9::jsonb, $10::jsonb),
           ($1, $5, $3, 'config_change', $4, 'match-b', '{}', '{}'),
           ($1, $2, $6, 'config_change', $4, 'wrong-actor', '{}', '{}'),
           ($1, $2, $3, 'config_change', $7, 'wrong-type', '{}', '{}'),
           ($1, $8, $3, 'config_change', $4, 'wrong-date', '{}', '{}')`,
        [
          TENANT_ID,
          inRangeA,
          OWNER_ID,
          marker,
          inRangeB,
          otherActor,
          `${marker}-other`,
          outOfRange,
          JSON.stringify({ name: "old, value" }),
          JSON.stringify({ name: 'new "value"' }),
        ],
      );
    });

    try {
      const from = new Date(Date.now() - 30 * 86_400_000).toISOString();
      const to = new Date().toISOString();
      const params = new URLSearchParams({ actor_user_id: OWNER_ID, object_type: marker, from, to });
      const exported = await call(`${TS_CONSOLE_URL}/audit-log/export.csv?${params}`, { token });
      expect(exported.status).toBe(200);
      const parsed = parseCsv(exported.body as string);
      expect(parsed[0]).toEqual(CSV_HEADER);
      expect(parsed.slice(1)).toHaveLength(2);
      const objects = parsed.slice(1).map((row) => Object.fromEntries(CSV_HEADER.map((header, index) => [header, row[index]])));
      expect(objects.map((row) => row.object_id).sort()).toEqual(["match-a", "match-b"]);
      for (const row of objects) {
        expect(row.actor_user_id).toBe(OWNER_ID);
        expect(row.object_type).toBe(marker);
        expect(new Date(row.occurred_at).getTime()).toBeGreaterThanOrEqual(new Date(from).getTime());
        expect(new Date(row.occurred_at).getTime()).toBeLessThanOrEqual(new Date(to).getTime());
      }
      expect(JSON.parse(objects.find((row) => row.object_id === "match-a")!.before)).toEqual({ name: "old, value" });

      const malformed = await call(`${TS_CONSOLE_URL}/audit-log?from=definitely-not-a-date`, { token });
      expect(malformed.status).toBe(400);
    } finally {
      await superuserPool.query(`DELETE FROM audit_log WHERE object_type IN ($1, $2)`, [marker, `${marker}-other`]);
    }
  });

  // TEID-42-T4 (Non-functional): the real HTTP stream exports 1.2 million
  // rows for one customer end-to-end within the 60-second budget.
  it("TEID-42-T4 streams a two-year 1.2M-row customer export in under 60 seconds", async () => {
    const token = await ownerSession();
    const customerId = randomUUID();
    const marker = `T4-${randomUUID()}`;
    const rowCount = 1_200_000;

    try {
      await superuserPool.query(
        `INSERT INTO customers (id, tenant_id, name, email) VALUES ($1, $2, $3, $4)`,
        [customerId, TENANT_ID, marker, `${marker}@example.test`],
      );
      await superuserPool.query(
        `INSERT INTO audit_log
           (tenant_id, occurred_at, customer_id, event_type, object_type, object_id, before, after)
         SELECT $1,
                now() - interval '2 years' + ((g - 1)::double precision / ($4 - 1)) * interval '2 years',
                $2, 'config_change', $3, g::text, '{"value":1}', '{"value":2}'
         FROM generate_series(1, $4) AS g`,
        [TENANT_ID, customerId, marker, rowCount],
      );

      const start = performance.now();
      const response = await fetch(`${TS_CONSOLE_URL}/audit-log/export.csv?customer_id=${customerId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/csv");
      expect(response.headers.get("content-disposition")).toBe('attachment; filename="audit-log.csv"');

      let newlineCount = 0;
      if (!response.body) throw new Error("CSV response had no stream body");
      for await (const chunk of response.body) {
        for (const byte of chunk) if (byte === 10) newlineCount++;
      }
      const elapsedMs = performance.now() - start;
      expect(newlineCount).toBe(rowCount + 1);
      expect(elapsedMs).toBeLessThan(60_000);
    } finally {
      await superuserPool.query(`DELETE FROM audit_log WHERE object_type = $1`, [marker]);
      await superuserPool.query(`DELETE FROM customers WHERE id = $1`, [customerId]);
    }
  }, 120_000);

  // TEID-42-T5 (Non-functional): 10,000 successful customer PATCH requests
  // produce exactly one API-key-attributed audit event apiece.
  it("TEID-42-T5 records exactly 10,000 audits for 10,000 configuration changes", async () => {
    const marker = `T5-${randomUUID()}`;
    const count = 10_000;
    let customerIds: string[] = [];
    try {
      customerIds = await withTenant(TENANT_ID, async (client) =>
        (await client.query<{ id: string }>(
          `INSERT INTO customers (tenant_id, name, email)
           SELECT $1, $2 || '-' || g, $2 || '-' || g || '@example.test'
           FROM generate_series(1, $3) AS g
           RETURNING id`,
          [TENANT_ID, marker, count],
        )).rows.map((row) => row.id),
      );

      const concurrency = 75;
      for (let offset = 0; offset < customerIds.length; offset += concurrency) {
        const batch = customerIds.slice(offset, offset + concurrency);
        const responses = await Promise.all(batch.map((id, index) =>
          call(`${TS_CONSOLE_URL}/customers/${id}`, {
            method: "PATCH",
            token: API_KEY,
            body: { name: `${marker}-updated-${offset + index}` },
          }),
        ));
        for (const response of responses) expect(response.status).toBe(200);
      }

      const result = await withTenant(TENANT_ID, async (client) =>
        (await client.query<{ total: number; api_key_actors: number; user_actors: number }>(
          `SELECT count(*)::int AS total,
                  count(actor_api_key_id)::int AS api_key_actors,
                  count(actor_user_id)::int AS user_actors
           FROM audit_log
           WHERE object_type = 'Customer' AND object_id = ANY($1::text[])`,
          [customerIds],
        )).rows[0],
      );
      expect(result).toEqual({ total: count, api_key_actors: count, user_actors: 0 });
    } finally {
      if (customerIds.length > 0) {
        await superuserPool.query(`DELETE FROM audit_log WHERE customer_id = ANY($1::uuid[])`, [customerIds]);
        await superuserPool.query(`DELETE FROM customers WHERE id = ANY($1::uuid[])`, [customerIds]);
      }
    }
  }, 120_000);

  // TEID-42-T6 (Adversarial): a compromised application/service credential
  // cannot UPDATE or DELETE an audit row directly in PostgreSQL.
  it("TEID-42-T6 enforces append-only permissions at the database boundary", async () => {
    const marker = `T6-${randomUUID()}`;
    const id = await withTenant(TENANT_ID, async (client) =>
      (await client.query<{ id: string }>(
        `INSERT INTO audit_log (tenant_id, actor_user_id, event_type, object_type, object_id, before, after)
         VALUES ($1, $2, 'config_change', $3, 'target', '{}', '{}') RETURNING id`,
        [TENANT_ID, OWNER_ID, marker],
      )).rows[0].id,
    );

    try {
      const expectPermissionDenied = async (sql: string) => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query("SELECT set_config('app.tenant_id', $1, true)", [TENANT_ID]);
          await expect(client.query(sql, [id])).rejects.toMatchObject({ code: "42501" });
        } finally {
          await client.query("ROLLBACK").catch(() => undefined);
          client.release();
        }
      };
      await expectPermissionDenied(`UPDATE audit_log SET event_type = 'tampered' WHERE id = $1`);
      await expectPermissionDenied(`DELETE FROM audit_log WHERE id = $1`);
      const unchanged = await withTenant(TENANT_ID, async (client) =>
        (await client.query(`SELECT event_type, object_type, object_id, before, after FROM audit_log WHERE id = $1`, [id])).rows[0],
      );
      expect(unchanged).toEqual({ event_type: "config_change", object_type: marker, object_id: "target", before: {}, after: {} });
    } finally {
      await superuserPool.query(`DELETE FROM audit_log WHERE id = $1`, [id]);
    }
  });

  // TEID-42-T7 (Adversarial): row locking serializes conflicting settings
  // updates while preserving two distinct, correctly chained audit entries.
  it("TEID-42-T7 captures two concurrent conflicting updates in processing order", async () => {
    const [firstSession, secondSession] = await Promise.all([ownerSession(), ownerSession()]);
    const baselineId = await currentMaxAuditId();
    const original = await withTenant(TENANT_ID, async (client) =>
      (await client.query<{ idle_timeout_minutes: number }>(
        `SELECT idle_timeout_minutes FROM tenant_settings WHERE tenant_id = $1`, [TENANT_ID],
      )).rows[0].idle_timeout_minutes,
    );
    const requested = [8101, 8102];

    try {
      const responses = await Promise.all([
        call(`${TS_CONSOLE_URL}/tenant-settings`, { method: "PATCH", token: firstSession, body: { idle_timeout_minutes: requested[0] } }),
        call(`${TS_CONSOLE_URL}/tenant-settings`, { method: "PATCH", token: secondSession, body: { idle_timeout_minutes: requested[1] } }),
      ]);
      expect(responses.map((response) => response.status)).toEqual([200, 200]);

      const rows = await withTenant(TENANT_ID, async (client) =>
        (await client.query(
          `SELECT id, occurred_at, before, after
           FROM audit_log
           WHERE id > $1 AND object_type = 'TenantSettings' AND actor_user_id = $2
           ORDER BY occurred_at, id`,
          [baselineId, OWNER_ID],
        )).rows,
      );
      expect(rows).toHaveLength(2);
      expect(new Date(rows[0].occurred_at).getTime()).not.toBe(new Date(rows[1].occurred_at).getTime());
      expect(rows[0].before.idle_timeout_minutes).toBe(original);
      expect(requested).toContain(rows[0].after.idle_timeout_minutes);
      expect(rows[1].before.idle_timeout_minutes).toBe(rows[0].after.idle_timeout_minutes);
      expect(rows[1].after.idle_timeout_minutes).toBe(requested.find((value) => value !== rows[0].after.idle_timeout_minutes));
    } finally {
      await superuserPool.query(
        `DELETE FROM audit_log WHERE tenant_id = $1 AND id > $2 AND object_type = 'TenantSettings'`,
        [TENANT_ID, baselineId],
      );
      await superuserPool.query(`UPDATE tenant_settings SET idle_timeout_minutes = $1 WHERE tenant_id = $2`, [original, TENANT_ID]);
    }
  });
});
