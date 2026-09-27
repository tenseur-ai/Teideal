import type { Pool, PoolClient } from "pg";

export const EXPORT_BATCH_SIZE = 10_000;

export const USAGE_EVENT_COLUMNS = [
  "id",
  "customer_id",
  "event_type",
  "quantity",
  "idempotency_key",
  "occurred_at",
  "created_at",
] as const;

export const CUSTOMER_COLUMNS = ["id", "name", "email", "created_at", "updated_at"] as const;

export const TENANT_SETTINGS_COLUMNS = [
  "require_mfa_all_roles",
  "idle_timeout_minutes",
  "sso_enabled",
  "updated_at",
] as const;

export const USER_COLUMNS = ["id", "email", "role", "mfa_enrolled", "created_at"] as const;

export const API_KEY_COLUMNS = [
  "id",
  "display_hint",
  "scope",
  "environment",
  "label",
  "creator_user_id",
  "created_at",
  "last_used_at",
  "status",
] as const;

export const EXPORT_SOURCE_COLUMNS = {
  usage_events: USAGE_EVENT_COLUMNS,
  customers: CUSTOMER_COLUMNS,
  tenant_settings: TENANT_SETTINGS_COLUMNS,
  users: USER_COLUMNS,
  api_keys: API_KEY_COLUMNS,
} as const;

export type ExportCategory = keyof typeof EXPORT_SOURCE_COLUMNS;
export type ExportRecord = Record<string, unknown>;

export interface ExportRange {
  rangeStart: Date | null;
  rangeEnd: Date | null;
}

interface SourceDefinition {
  category: ExportCategory;
  select: string;
  table: string;
  tenantColumn: "tenant_id" | "issued_to_tenant_id";
  timeColumn: "occurred_at" | "created_at" | "updated_at";
  orderColumn: string | null;
}

const SOURCES: readonly SourceDefinition[] = [
  {
    category: "usage_events",
    select: USAGE_EVENT_COLUMNS.join(", "),
    table: "usage_events",
    tenantColumn: "tenant_id",
    timeColumn: "occurred_at",
    orderColumn: "id",
  },
  {
    category: "customers",
    select: CUSTOMER_COLUMNS.join(", "),
    table: "customers",
    tenantColumn: "tenant_id",
    timeColumn: "created_at",
    orderColumn: "id",
  },
  {
    category: "tenant_settings",
    select: TENANT_SETTINGS_COLUMNS.join(", "),
    table: "tenant_settings",
    tenantColumn: "tenant_id",
    timeColumn: "updated_at",
    orderColumn: null,
  },
  {
    category: "users",
    select: "id, email, role, mfa_enrolled_at IS NOT NULL AS mfa_enrolled, created_at",
    table: "users",
    tenantColumn: "tenant_id",
    timeColumn: "created_at",
    orderColumn: "id",
  },
  {
    category: "api_keys",
    select: `id, display_hint, scope, environment, label, creator_user_id, created_at, last_used_at,
      CASE
        WHEN revoked_at IS NOT NULL THEN 'revoked'
        WHEN expires_at IS NOT NULL AND expires_at <= now() THEN 'expired'
        ELSE 'active'
      END AS status`,
    table: "api_keys",
    tenantColumn: "issued_to_tenant_id",
    timeColumn: "created_at",
    orderColumn: "id",
  },
];

export type ExportStreamItem =
  | { type: "category"; category: ExportCategory; columns: readonly string[] }
  | { type: "row"; category: ExportCategory; columns: readonly string[]; record: ExportRecord };

async function* sourceRows(
  client: PoolClient,
  tenantId: string,
  source: SourceDefinition,
  range: ExportRange,
): AsyncGenerator<ExportRecord> {
  let cursor: { time: unknown; order: unknown } | undefined;
  do {
    const values: unknown[] = [tenantId];
    const where = [`${source.tenantColumn} = $1`];
    if (range.rangeStart) {
      values.push(range.rangeStart);
      where.push(`${source.timeColumn} >= $${values.length}`);
    }
    if (range.rangeEnd) {
      values.push(range.rangeEnd);
      where.push(`${source.timeColumn} < $${values.length}`);
    }
    if (cursor && source.orderColumn) {
      values.push(cursor.time, cursor.order);
      where.push(`(${source.timeColumn}, ${source.orderColumn}) > ($${values.length - 1}, $${values.length})`);
    }
    values.push(EXPORT_BATCH_SIZE);
    const order = source.orderColumn
      ? `${source.timeColumn}, ${source.orderColumn}`
      : source.timeColumn;
    const rows = (await client.query<ExportRecord>(
      `SELECT ${source.select}
       FROM ${source.table}
       WHERE ${where.join(" AND ")}
       ORDER BY ${order}
       LIMIT $${values.length}`,
      values,
    )).rows;
    for (const row of rows) yield row;
    if (!source.orderColumn || rows.length < EXPORT_BATCH_SIZE) return;
    const last = rows[rows.length - 1];
    cursor = { time: last[source.timeColumn], order: last[source.orderColumn] };
  } while (true);
}

// A single transaction supplies every requested renderer from one snapshot of
// the source rows. In particular, CSV/JSON/Parquet cannot disagree merely
// because data was inserted while a long export was being written.
export async function* streamExportSources(
  pool: Pool,
  tenantId: string,
  range: ExportRange,
): AsyncGenerator<ExportStreamItem> {
  const client = await pool.connect();
  let open = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    open = true;
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    for (const source of SOURCES) {
      const columns = EXPORT_SOURCE_COLUMNS[source.category];
      yield { type: "category", category: source.category, columns };
      for await (const record of sourceRows(client, tenantId, source, range)) {
        yield { type: "row", category: source.category, columns, record };
      }
    }
    await client.query("COMMIT");
    open = false;
  } catch (error) {
    if (open) await client.query("ROLLBACK");
    open = false;
    throw error;
  } finally {
    if (open) await client.query("ROLLBACK");
    client.release();
  }
}

export function buildExportFormatDocument(): string {
  const sections = Object.entries(EXPORT_SOURCE_COLUMNS).map(([category, columns]) => {
    const rows = columns.map((column) => `| \`${column}\` |`).join("\n");
    return `## ${category}\n\n| Column |\n|---|\n${rows}`;
  });
  return `# Teideal full-export format

Each export contains all currently available tenant-owned usage and
configuration data. Usage events are the ledger source at this build stage.

Date ranges use a half-open interval: the start is inclusive and the end is
exclusive. Usage events filter on \`occurred_at\`; every other category filters
on \`created_at\`, except tenant settings, which filters on \`updated_at\`.

## File formats

- CSV is UTF-8. Each category starts with a \`# <category>\` line, followed by
  the exact header listed below, its records, and a blank separator line.
- JSON is newline-delimited JSON (JSON Lines), not a JSON array. Each line is
  an object with \`category\` and \`record\`; \`record\` contains exactly the
  category columns listed below.
- Parquet is a streaming columnar file with UTF-8 \`category\` and
  \`record_json\` columns. \`record_json\` contains exactly the category columns
  listed below.

${sections.join("\n\n")}

## grants

Grants are not yet available. No grants table exists at this build stage, so
there are no grant records or columns to export.

## Performance validation

The automated CI load test uses 50,000 usage events with a 120-second budget
by default. Before a release that changes the export path, a dedicated
performance/staging run sets \`EXPORT_LOAD_TEST_EVENTS=50000000\` and validates
the full-history export against the production target of completion within 24
hours.
`;
}
