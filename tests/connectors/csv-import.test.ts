import { afterAll, describe, expect, it } from "vitest";
import { pool, withTenant } from "./db.js";
import { TENANT_ID, TS_CONSOLE_URL } from "./env.js";
import { billingSession } from "./session.js";

async function uploadCsv(token: string, csv: string) {
  const form = new FormData();
  form.append("file", new Blob([csv], { type: "text/csv" }), "invoices.csv");
  const response = await fetch(`${TS_CONSOLE_URL}/connectors/csv-import/invoices`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  return {
    status: response.status,
    body: await response.json() as {
      csv_import_id: string;
      total: number;
      accepted: number;
      quarantined: number;
    },
  };
}

afterAll(async () => {
  await withTenant(TENANT_ID, async (client) => {
    await client.query("DELETE FROM connectors WHERE connector_type = 'csv_import' AND display_name = 'CSV invoice imports'");
  });
  await pool.end();
});

describe("TEID-65 CSV invoice importer", () => {
  it("TEID-65-T1 accepts a generated 5,000-row invoice CSV through the documented multipart API", async () => {
    const token = await billingSession();
    const header = "invoice_id,customer_id,amount,currency,status,issued_at,source";
    const rows = Array.from({ length: 5_000 }, (_, index) =>
      `csv_t1_${index},cus_t1_${index},${index}.25,usd,open,2026-09-01T00:00:00.000Z,batch-t1`);
    const response = await uploadCsv(token, [header, ...rows].join("\n"));
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ total: 5_000, accepted: 5_000, quarantined: 0 });
    expect(response.body.csv_import_id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("TEID-65-T9 quarantines duplicates, missing values, and invalid decimal strings without corrupting valid rows", async () => {
    const token = await billingSession();
    const csv = [
      "invoice_id,customer_id,amount,currency,status,issued_at,note",
      "csv_t9_a,cus_a,10.25,usd,open,2026-09-02T00:00:00.000Z,first",
      "csv_t9_b,cus_b,-2.50,eur,paid,2026-09-02T00:00:00.000Z,second",
      "csv_t9_a,cus_c,3.00,usd,open,2026-09-02T00:00:00.000Z,duplicate",
      "csv_t9_missing,cus_d,4.00,usd,,2026-09-02T00:00:00.000Z,missing status",
      "csv_t9_money,cus_e,4.2.1,usd,open,2026-09-02T00:00:00.000Z,bad amount",
    ].join("\n");
    const response = await uploadCsv(token, csv);
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ total: 5, accepted: 2, quarantined: 3 });

    const stored = await withTenant(TENANT_ID, async (client) => {
      const records = (await client.query<{ external_id: string; data: Record<string, unknown> }>(
        `SELECT external_id, data FROM connector_records
         WHERE entity_type = 'invoice' AND external_id LIKE 'csv_t9_%'
         ORDER BY external_id`,
      )).rows;
      const rejected = (await client.query<{ reason: string }>(
        `SELECT reason FROM csv_import_quarantine WHERE import_id = $1 ORDER BY row_number`,
        [response.body.csv_import_id],
      )).rows;
      return { records, rejected };
    });
    expect(stored.records.map((row) => row.external_id)).toEqual(["csv_t9_a", "csv_t9_b"]);
    expect(stored.records[0].data).toMatchObject({ amount: "10.25", passthrough: { note: "first" } });
    expect(stored.rejected.map((row) => row.reason)).toEqual([
      "duplicate invoice_id in this file",
      "missing required values: status",
      "amount must be a decimal string",
    ]);
  });
});
