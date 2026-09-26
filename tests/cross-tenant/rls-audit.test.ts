// TEID-41-T1 (Functional): audit every tenant-scoped table for row-level
// security. "Tenant-scoped" is determined structurally -- any table with a
// column literally named tenant_id -- rather than from a hand-maintained
// list, so a future table that adds tenant_id without RLS is caught here
// automatically instead of silently shipping unprotected.
import { describe, expect, it, afterAll } from "vitest";
import pg from "pg";
import { DATABASE_URL } from "./env.js";

const pool = new pg.Pool({ connectionString: DATABASE_URL });
afterAll(() => pool.end());

interface AuditRow {
  relname: string;
  relrowsecurity: boolean;
  relforcerowsecurity: boolean;
  policy_count: number;
}

describe("TEID-41-T1: RLS policy audit", () => {
  it("every table with a tenant_id column has RLS enabled, forced, and at least one policy", async () => {
    const { rows } = await pool.query<AuditRow>(`
      SELECT c.relname,
             c.relrowsecurity,
             c.relforcerowsecurity,
             (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS policy_count
      FROM pg_class c
      JOIN information_schema.columns col
        ON col.table_schema = 'public' AND col.table_name = c.relname AND col.column_name = 'tenant_id'
      WHERE c.relkind = 'r'
      GROUP BY c.relname, c.relrowsecurity, c.relforcerowsecurity
      ORDER BY c.relname
    `);

    // Guard against a vacuously-passing audit: we know these two exist today.
    const names = rows.map((r) => r.relname);
    expect(names).toContain("customers");
    expect(names).toContain("usage_events");

    for (const row of rows) {
      expect(row.relrowsecurity, `${row.relname} must have RLS enabled`).toBe(true);
      expect(row.relforcerowsecurity, `${row.relname} must FORCE RLS (so even the table owner is subject to it)`).toBe(true);
      expect(row.policy_count, `${row.relname} must have at least one RLS policy`).toBeGreaterThan(0);
    }
  });

  it("every RLS policy on a tenant-scoped table filters on tenant_id in both USING and WITH CHECK", async () => {
    const { rows } = await pool.query<{ tablename: string; qual: string | null; with_check: string | null }>(`
      SELECT tablename, qual, with_check
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename IN (
          SELECT DISTINCT table_name FROM information_schema.columns
          WHERE table_schema = 'public' AND column_name = 'tenant_id'
        )
    `);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.qual, `${row.tablename} policy USING clause`).toMatch(/tenant_id/);
      expect(row.with_check, `${row.tablename} policy WITH CHECK clause`).toMatch(/tenant_id/);
    }
  });
});
