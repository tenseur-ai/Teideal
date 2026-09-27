import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";
import { withTenant } from "../lib/db.js";
import { requireSession } from "../lib/sessionAuth.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXPORT_BATCH_SIZE = 10_000;
const CSV_COLUMNS = [
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
] as const;

interface AuditFilterQuery {
  actor_user_id?: unknown;
  customer_id?: unknown;
  object_type?: unknown;
  from?: unknown;
  to?: unknown;
}

interface AuditFilters {
  actorUserId?: string;
  customerId?: string;
  objectType?: string;
  from?: string;
  to?: string;
}

interface AuditRow {
  id: string;
  occurred_at: Date;
  actor_user_id: string | null;
  actor_api_key_id: string | null;
  customer_id: string | null;
  object_type: string | null;
  object_id: string | null;
  event_type: string;
  before: unknown;
  after: unknown;
  detail?: unknown;
}

function parseFilters(query: AuditFilterQuery): { filters: AuditFilters } | { error: string } {
  for (const key of ["actor_user_id", "customer_id", "object_type", "from", "to"] as const) {
    if (query[key] !== undefined && typeof query[key] !== "string") {
      return { error: `${key} must be a string` };
    }
  }

  if (query.actor_user_id !== undefined && !UUID_RE.test(query.actor_user_id as string)) {
    return { error: "actor_user_id must be a UUID" };
  }
  if (query.customer_id !== undefined && !UUID_RE.test(query.customer_id as string)) {
    return { error: "customer_id must be a UUID" };
  }

  const parseDate = (name: "from" | "to", value: unknown): string | undefined => {
    if (value === undefined) return undefined;
    const timestamp = Date.parse(value as string);
    if (Number.isNaN(timestamp)) return undefined;
    return new Date(timestamp).toISOString();
  };
  const from = parseDate("from", query.from);
  const to = parseDate("to", query.to);
  if (query.from !== undefined && from === undefined) return { error: "from must be a parseable ISO date" };
  if (query.to !== undefined && to === undefined) return { error: "to must be a parseable ISO date" };
  if (from && to && from > to) return { error: "from must not be later than to" };

  return {
    filters: {
      actorUserId: query.actor_user_id as string | undefined,
      customerId: query.customer_id as string | undefined,
      objectType: query.object_type as string | undefined,
      from,
      to,
    },
  };
}

function filteredQuery(
  filters: AuditFilters,
  options: { limit: number; cursor?: { occurredAt: Date; id: string }; includeDetail?: boolean },
): { text: string; values: unknown[] } {
  const values: unknown[] = [];
  const where: string[] = [];
  const add = (clause: string, value: unknown) => {
    values.push(value);
    where.push(clause.replace("?", `$${values.length}`));
  };

  if (filters.actorUserId) add("actor_user_id = ?", filters.actorUserId);
  if (filters.customerId) add("customer_id = ?", filters.customerId);
  if (filters.objectType) add("object_type = ?", filters.objectType);
  if (filters.from) add("occurred_at >= ?", filters.from);
  if (filters.to) add("occurred_at <= ?", filters.to);
  if (options.cursor) {
    values.push(options.cursor.occurredAt, options.cursor.id);
    where.push(`(occurred_at, id) < ($${values.length - 1}, $${values.length})`);
  }
  values.push(options.limit);

  const detail = options.includeDetail ? ", detail" : "";
  return {
    text: `SELECT ${CSV_COLUMNS.join(", ")}${detail}
           FROM audit_log
           ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
           ORDER BY occurred_at DESC, id DESC
           LIMIT $${values.length}`,
    values,
  };
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text: string;
  if (value instanceof Date) text = value.toISOString();
  else if (typeof value === "object") text = JSON.stringify(value);
  else text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csvLine(row: AuditRow): string {
  return `${CSV_COLUMNS.map((column) => csvCell(row[column])).join(",")}\n`;
}

async function* exportRows(pool: Pool, tenantId: string, filters: AuditFilters): AsyncGenerator<string> {
  const client: PoolClient = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query("BEGIN");
    transactionOpen = true;
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);

    yield `${CSV_COLUMNS.join(",")}\n`;
    let cursor: { occurredAt: Date; id: string } | undefined;
    while (true) {
      const query = filteredQuery(filters, { limit: EXPORT_BATCH_SIZE, cursor });
      const { rows } = await client.query<AuditRow>(query.text, query.values);
      if (rows.length === 0) break;
      yield rows.map(csvLine).join("");
      if (rows.length < EXPORT_BATCH_SIZE) break;
      const last = rows[rows.length - 1];
      cursor = { occurredAt: last.occurred_at, id: last.id };
    }

    await client.query("COMMIT");
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) {
      await client.query("ROLLBACK");
      transactionOpen = false;
    }
    throw error;
  } finally {
    if (transactionOpen) await client.query("ROLLBACK");
    client.release();
  }
}

export function registerAuditLogRoutes(app: FastifyInstance, pool: Pool) {
  app.register(async (scoped) => {
    scoped.addHook("preHandler", requireSession(pool));

    scoped.get("/audit-log", async (req, reply) => {
      const parsed = parseFilters(req.query as AuditFilterQuery);
      if ("error" in parsed) return reply.code(400).send({ error: parsed.error });

      const rows = await withTenant(pool, req.consolePrincipal!.tenantId, async (client) => {
        const query = filteredQuery(parsed.filters, { limit: 500, includeDetail: true });
        return (await client.query<AuditRow>(query.text, query.values)).rows;
      });
      return reply.send({ data: rows });
    });

    scoped.get("/audit-log/export.csv", async (req, reply) => {
      const parsed = parseFilters(req.query as AuditFilterQuery);
      if ("error" in parsed) return reply.code(400).send({ error: parsed.error });

      reply.type("text/csv");
      reply.header("Content-Disposition", 'attachment; filename="audit-log.csv"');
      return reply.send(Readable.from(exportRows(pool, req.consolePrincipal!.tenantId, parsed.filters)));
    });

    const immutable = (_req: unknown, reply: { code: (status: number) => { send: (body: unknown) => unknown } }) =>
      reply.code(405).send({ error: "the audit log is append-only and cannot be edited or deleted" });
    scoped.patch("/audit-log/:id", immutable);
    scoped.delete("/audit-log/:id", immutable);
  });
}
