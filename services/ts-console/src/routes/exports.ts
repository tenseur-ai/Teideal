import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { recordConfigChangeWithClient } from "../lib/audit.js";
import { withTenant } from "../lib/db.js";
import {
  CONTENT_TYPES,
  EXPORT_FORMATS,
  type ExportFormat,
} from "../lib/exportFormats.js";
import { buildExportFormatDocument } from "../lib/exportSources.js";
import { consoleRoute } from "../lib/roleGuard.js";
import { verifyS3Destination } from "../lib/s3.js";
import { requireSession } from "../lib/sessionAuth.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FORMAT_SET = new Set<string>(EXPORT_FORMATS);
const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_FORMAT_DOC_PATH = path.resolve(here, "../../../../docs/export-format.md");
const DESTINATION_ERROR = "could not verify write access to the configured bucket -- check the role's trust policy and permissions";

interface ExportRow {
  id: string;
  status: "pending" | "running" | "completed" | "failed";
  formats: ExportFormat[];
  range_start: string | null;
  range_end: string | null;
  record_counts: Record<string, number> | null;
  file_paths: Partial<Record<ExportFormat, string>> | null;
  created_at: string;
  completed_at: string | null;
  error_message: string | null;
}

function parseFormats(value: unknown, required: boolean): { formats: ExportFormat[] } | { error: string } {
  if (value === undefined && !required) return { formats: ["csv"] };
  if (!Array.isArray(value) || value.length === 0) {
    return { error: "formats must be a non-empty array containing csv, json, or parquet" };
  }
  if (value.some((format) => typeof format !== "string" || !FORMAT_SET.has(format))) {
    return { error: "formats must contain only csv, json, or parquet" };
  }
  if (new Set(value).size !== value.length) return { error: "formats must not contain duplicates" };
  return { formats: value as ExportFormat[] };
}

function parseRange(body: { range_start?: unknown; range_end?: unknown }):
  | { rangeStart: Date | null; rangeEnd: Date | null }
  | { error: string } {
  const hasStart = body.range_start !== undefined;
  const hasEnd = body.range_end !== undefined;
  if (hasStart !== hasEnd) return { error: "range_start and range_end must be provided together" };
  if (!hasStart) return { rangeStart: null, rangeEnd: null };
  if (typeof body.range_start !== "string" || Number.isNaN(Date.parse(body.range_start))) {
    return { error: "range_start must be a parseable ISO date" };
  }
  if (typeof body.range_end !== "string" || Number.isNaN(Date.parse(body.range_end))) {
    return { error: "range_end must be a parseable ISO date" };
  }
  const rangeStart = new Date(body.range_start);
  const rangeEnd = new Date(body.range_end);
  if (rangeStart >= rangeEnd) return { error: "range_start must be before range_end" };
  return { rangeStart, rangeEnd };
}

export function registerExportRoutes(app: FastifyInstance, pool: Pool): void {
  app.register(async (scoped) => {
    scoped.addHook("preHandler", requireSession(pool));

    consoleRoute(scoped, "post", "/exports", { role: ["Owner"] }, async (req, reply) => {
      const body = (req.body ?? {}) as { formats?: unknown; range_start?: unknown; range_end?: unknown };
      const parsedFormats = parseFormats(body.formats, true);
      if ("error" in parsedFormats) return reply.code(400).send({ error: parsedFormats.error });
      const parsedRange = parseRange(body);
      if ("error" in parsedRange) return reply.code(400).send({ error: parsedRange.error });
      const { tenantId, userId } = req.consolePrincipal!;
      const row = await withTenant(pool, tenantId, async (client) =>
        (await client.query<{ id: string; status: string }>(
          `INSERT INTO exports
             (tenant_id, requested_by_user_id, range_start, range_end, formats, status)
           VALUES ($1, $2, $3, $4, $5, 'pending')
           RETURNING id, status`,
          [tenantId, userId, parsedRange.rangeStart, parsedRange.rangeEnd, parsedFormats.formats],
        )).rows[0],
      );
      return reply.code(202).send(row);
    });

    consoleRoute(scoped, "get", "/exports/:id", { role: ["Owner"] }, async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!UUID_RE.test(id)) return reply.code(400).send({ error: "id must be a UUID" });
      const tenantId = req.consolePrincipal!.tenantId;
      const row = await withTenant(pool, tenantId, async (client) =>
        (await client.query<ExportRow>(
          `SELECT id, status, formats, range_start, range_end, record_counts,
                  created_at, completed_at, error_message
           FROM exports WHERE id = $1 AND tenant_id = $2`,
          [id, tenantId],
        )).rows[0] ?? null,
      );
      if (!row) return reply.code(403).send({ error: "export not found for this tenant" });
      return reply.send(row);
    });

    consoleRoute(scoped, "get", "/exports/:id/download", { role: ["Owner"] }, async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!UUID_RE.test(id)) return reply.code(400).send({ error: "id must be a UUID" });
      const query = req.query as { format?: unknown };
      if (typeof query.format !== "string" || !FORMAT_SET.has(query.format)) {
        return reply.code(400).send({ error: "format must be csv, json, or parquet" });
      }
      const format = query.format as ExportFormat;
      const tenantId = req.consolePrincipal!.tenantId;
      const row = await withTenant(pool, tenantId, async (client) =>
        (await client.query<ExportRow>(
          `SELECT id, status, formats, file_paths FROM exports
           WHERE id = $1 AND tenant_id = $2`,
          [id, tenantId],
        )).rows[0] ?? null,
      );
      if (!row) return reply.code(403).send({ error: "export not found for this tenant" });
      if (!row.formats.includes(format)) return reply.code(400).send({ error: "format was not requested for this export" });
      if (row.status !== "completed") return reply.code(409).send({ error: "export is not completed" });
      const filePath = row.file_paths?.[format];
      if (!filePath) return reply.code(409).send({ error: "export file is unavailable" });
      reply.type(CONTENT_TYPES[format]);
      reply.header("Content-Disposition", `attachment; filename="${id}.${format}"`);
      return reply.send(createReadStream(filePath));
    });

    consoleRoute(scoped, "post", "/export-schedules", { role: ["Owner"] }, async (req, reply) => {
      const body = (req.body ?? {}) as {
        s3_bucket?: unknown;
        s3_prefix?: unknown;
        s3_region?: unknown;
        role_arn?: unknown;
        formats?: unknown;
      };
      for (const field of ["s3_bucket", "s3_region", "role_arn"] as const) {
        if (typeof body[field] !== "string" || !body[field].trim()) {
          return reply.code(400).send({ error: `${field} is required` });
        }
      }
      if (body.s3_prefix !== undefined && typeof body.s3_prefix !== "string") {
        return reply.code(400).send({ error: "s3_prefix must be a string" });
      }
      const parsedFormats = parseFormats(body.formats, false);
      if ("error" in parsedFormats) return reply.code(400).send({ error: parsedFormats.error });
      const bucket = (body.s3_bucket as string).trim();
      const region = (body.s3_region as string).trim();
      const roleArn = (body.role_arn as string).trim();
      const prefix = (body.s3_prefix as string | undefined) ?? "";
      try {
        await verifyS3Destination(region, roleArn, bucket);
      } catch {
        return reply.code(400).send({ error: DESTINATION_ERROR });
      }

      const { tenantId, userId } = req.consolePrincipal!;
      const row = await withTenant(pool, tenantId, async (client) => {
        const created = (await client.query(
          `INSERT INTO export_schedules
             (tenant_id, created_by_user_id, s3_bucket, s3_prefix, s3_region, role_arn, formats)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, s3_bucket, s3_prefix, s3_region, role_arn, formats,
                     enabled, last_run_at, last_run_status, consecutive_failures, created_at`,
          [tenantId, userId, bucket, prefix, region, roleArn, parsedFormats.formats],
        )).rows[0];
        await recordConfigChangeWithClient(client, tenantId, { userId }, {
          objectType: "ExportSchedule",
          objectId: created.id,
          before: null,
          after: { s3_bucket: bucket, s3_prefix: prefix, s3_region: region, role_arn: roleArn, formats: parsedFormats.formats },
        });
        return created;
      });
      return reply.code(201).send(row);
    });

    consoleRoute(scoped, "get", "/export-schedules", { role: ["Owner"] }, async (req, reply) => {
      const tenantId = req.consolePrincipal!.tenantId;
      const rows = await withTenant(pool, tenantId, async (client) =>
        (await client.query(
          `SELECT id, s3_bucket, s3_prefix, s3_region, role_arn, formats,
                  enabled, last_run_at, last_run_status, consecutive_failures, created_at
           FROM export_schedules
           WHERE tenant_id = $1
           ORDER BY created_at, id`,
          [tenantId],
        )).rows,
      );
      return reply.send({ data: rows });
    });
  });
}

// Registered beneath the existing API-key-authenticated support scope in
// server.ts, matching /support/isolation-design-doc rather than console
// session authentication.
export function registerExportFormatRoute(
  app: FastifyInstance,
  docPath: string = process.env.EXPORT_FORMAT_DOC_PATH ?? DEFAULT_FORMAT_DOC_PATH,
): void {
  app.get("/support/export-format-doc", async (req, reply) => {
    // Normalized to "\n" regardless of how this file was checked out on the
    // host filesystem (Git checks it out with CRLF on Windows via
    // core.autocrlf), so the response a consumer parses is deterministic
    // across hosts, not dependent on which OS happened to serve it.
    const document = (await readFile(docPath, "utf8")).replace(/\r\n/g, "\n");
    const generated = buildExportFormatDocument();
    if (document !== generated) {
      throw new Error("docs/export-format.md is out of sync with exportSources.ts");
    }
    return reply.send({
      requested_by_tenant: req.principal!.tenantKey,
      delivered_at: new Date().toISOString(),
      document,
    });
  });
}
