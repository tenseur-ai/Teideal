import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { csvCell } from "../lib/exportFormats.js";
import { GoUsageError } from "../lib/goUsageClient.js";
import {
  PeriodCloseInvoiceSyncError,
  syncPeriodCloseInvoice,
} from "../lib/periodCloseInvoiceSync.js";
import {
  generatePeriodCloseSummary,
  type PeriodCloseSort,
  type PeriodCloseSummaryRow,
} from "../lib/periodCloseSummary.js";
import { consoleRoute } from "../lib/roleGuard.js";
import { requireSession } from "../lib/sessionAuth.js";
import { StripeConnectionClosedError, StripeScopeError } from "../lib/stripeConnect.js";

const PERIOD_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const PERIOD_CLOSE_ROLES = ["Owner", "Billing Admin", "Finance"] as const;
const EXPORT_COLUMNS = [
  "customer_id",
  "customer_name",
  "usage_billed",
  "credits_paid",
  "credits_promotional",
  "credits_commit",
  "credits_goodwill",
  "credits_overage",
  "commit_drawn_down",
  "overage",
  "expired_credits",
  "adjustments",
] as const;

type ExportColumn = (typeof EXPORT_COLUMNS)[number];
type ExportRecord = Record<ExportColumn, string>;

interface PageCursor {
  sort: PeriodCloseSort;
  customer_id: string;
}

export function calendarMonthBounds(period: string): { periodStart: string; periodEnd: string } | null {
  const match = PERIOD_RE.exec(period);
  if (!match || match[1] === "0000") return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  if (nextYear > 9999) return null;
  return {
    periodStart: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01T00:00:00.000Z`,
    periodEnd: `${String(nextYear).padStart(4, "0")}-${String(nextMonth).padStart(2, "0")}-01T00:00:00.000Z`,
  };
}

function parseLimit(raw: unknown): { error: string } | { limit: number } {
  if (raw === undefined) return { limit: DEFAULT_LIMIT };
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return { error: "limit must be a positive integer" };
  const limit = Number(raw);
  if (!Number.isSafeInteger(limit) || limit <= 0) return { error: "limit must be a positive integer" };
  return { limit: Math.min(limit, MAX_LIMIT) };
}

function encodeCursor(sort: PeriodCloseSort, customerId: string): string {
  return Buffer.from(JSON.stringify({ sort, customer_id: customerId } satisfies PageCursor)).toString("base64url");
}

function decodeCursor(raw: unknown, sort: PeriodCloseSort): { error: string } | { customerId: string | null } {
  if (raw === undefined) return { customerId: null };
  if (typeof raw !== "string") return { error: "cursor is invalid" };
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as PageCursor;
    if (parsed.sort !== sort || typeof parsed.customer_id !== "string" || parsed.customer_id.length === 0) {
      return { error: "cursor is invalid" };
    }
    return { customerId: parsed.customer_id };
  } catch {
    return { error: "cursor is invalid" };
  }
}

function exportRecord(row: PeriodCloseSummaryRow): ExportRecord {
  return {
    customer_id: row.customer_id,
    customer_name: row.customer_name,
    usage_billed: row.usage_billed,
    credits_paid: row.credits_consumed_by_source.paid,
    credits_promotional: row.credits_consumed_by_source.promotional,
    credits_commit: row.credits_consumed_by_source.commit,
    credits_goodwill: row.credits_consumed_by_source.goodwill,
    credits_overage: row.credits_consumed_by_source.overage,
    commit_drawn_down: row.commit_drawn_down,
    overage: row.overage,
    expired_credits: row.expired_credits,
    adjustments: row.adjustments,
  };
}

export function renderPeriodCloseCsv(rows: readonly PeriodCloseSummaryRow[]): string {
  const header = EXPORT_COLUMNS.join(",");
  const body = rows.map((row) => {
    const record = exportRecord(row);
    return EXPORT_COLUMNS.map((column) => csvCell(record[column])).join(",");
  });
  return `${[header, ...body].join("\n")}\n`;
}

export async function renderPeriodCloseXlsx(rows: readonly PeriodCloseSummaryRow[]): Promise<Buffer> {
  // Keep the renderer lazy so JSON/CSV requests do not load the comparatively
  // large workbook implementation.
  const exceljsModuleName = "exceljs";
  const exceljs = await import(exceljsModuleName);
  const ExcelJS = exceljs.default ?? exceljs;
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Period close");
  worksheet.addRow([...EXPORT_COLUMNS]);
  for (const row of rows) {
    const record = exportRecord(row);
    // Decimal amounts deliberately remain strings so Excel does not round
    // values through IEEE-754 and the CSV/XLSX figures stay identical.
    worksheet.addRow(EXPORT_COLUMNS.map((column) => record[column]));
  }
  worksheet.getRow(1).font = { bold: true };
  worksheet.views = [{ state: "frozen", ySplit: 1 }];
  const output = await workbook.xlsx.writeBuffer();
  return Buffer.isBuffer(output) ? output : Buffer.from(output);
}

export function registerPeriodCloseRoutes(app: FastifyInstance, pool: Pool): void {
  app.register(async (scoped) => {
    scoped.addHook("preHandler", requireSession(pool));

    consoleRoute(scoped, "get", "/period-close-summary", { role: [...PERIOD_CLOSE_ROLES] }, async (req, reply) => {
      const query = req.query as Record<string, unknown>;
      if (typeof query.period !== "string") {
        return reply.code(400).send({ error: "period must be in YYYY-MM format" });
      }
      const bounds = calendarMonthBounds(query.period);
      if (!bounds) return reply.code(400).send({ error: "period must be in YYYY-MM format" });
      if (query.search !== undefined && typeof query.search !== "string") {
        return reply.code(400).send({ error: "search must be a string" });
      }
      const sort: PeriodCloseSort = query.sort === undefined ? "name" : query.sort as PeriodCloseSort;
      if (sort !== "name" && sort !== "usage_billed") {
        return reply.code(400).send({ error: "sort must be name or usage_billed" });
      }
      const format = query.format === undefined ? "json" : query.format;
      if (format !== "json" && format !== "csv" && format !== "xlsx") {
        return reply.code(400).send({ error: "format must be json, csv, or xlsx" });
      }
      const authorization = req.headers.authorization!;

      try {
        // This is the only computation path. JSON pagination and both file
        // renderers consume this same live, merged row array.
        const rows = await generatePeriodCloseSummary({
          pool,
          tenantId: req.consolePrincipal!.tenantId,
          authorization,
          periodStart: bounds.periodStart,
          periodEnd: bounds.periodEnd,
          search: query.search as string | undefined,
          sort,
        });

        if (format === "csv") {
          reply.header("Content-Disposition", `attachment; filename="period-close-${query.period}.csv"`);
          return reply.type("text/csv; charset=utf-8").send(renderPeriodCloseCsv(rows));
        }
        if (format === "xlsx") {
          reply.header("Content-Disposition", `attachment; filename="period-close-${query.period}.xlsx"`);
          return reply
            .type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
            .send(await renderPeriodCloseXlsx(rows));
        }

        const limit = parseLimit(query.limit);
        if ("error" in limit) return reply.code(400).send({ error: limit.error });
        const cursor = decodeCursor(query.cursor, sort);
        if ("error" in cursor) return reply.code(400).send({ error: cursor.error });
        let offset = 0;
        if (cursor.customerId !== null) {
          const cursorIndex = rows.findIndex((row) => row.customer_id === cursor.customerId);
          if (cursorIndex < 0) return reply.code(400).send({ error: "cursor is invalid" });
          offset = cursorIndex + 1;
        }
        const page = rows.slice(offset, offset + limit.limit);
        const hasMore = offset + page.length < rows.length;
        return reply.send({
          data: page,
          next_cursor: hasMore && page.length > 0 ? encodeCursor(sort, page[page.length - 1].customer_id) : null,
        });
      } catch (error) {
        if (error instanceof GoUsageError) {
          if (error.statusCode === 401 || error.statusCode === 403) {
            return reply.code(error.statusCode).send(error.body ?? { error: "usage service authorization failed" });
          }
          return reply.code(502).send({ error: "usage service request failed" });
        }
        if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
          return reply.code(504).send({ error: "usage service request timed out" });
        }
        throw error;
      }
    });

    consoleRoute(scoped, "post", "/period-close/:customerId/stripe-sync", { role: [...PERIOD_CLOSE_ROLES] }, async (req, reply) => {
      const customerId = (req.params as { customerId: string }).customerId;
      if (!UUID_RE.test(customerId)) return reply.code(400).send({ error: "customerId must be a UUID" });
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.period_start !== "string" || Number.isNaN(Date.parse(body.period_start))) {
        return reply.code(400).send({ error: "period_start must be an RFC3339 timestamp" });
      }
      if (typeof body.period_end !== "string" || Number.isNaN(Date.parse(body.period_end))) {
        return reply.code(400).send({ error: "period_end must be an RFC3339 timestamp" });
      }
      if (Date.parse(body.period_start) >= Date.parse(body.period_end)) {
        return reply.code(400).send({ error: "period_start must be before period_end" });
      }
      try {
        const result = await syncPeriodCloseInvoice({
          pool,
          tenantId: req.consolePrincipal!.tenantId,
          customerId,
          periodStart: new Date(body.period_start).toISOString(),
          periodEnd: new Date(body.period_end).toISOString(),
        });
        if (result.alreadySynced) {
          return reply.code(200).send({ data: result.lineItems });
        }
        return reply.code(202).send({
          attempt_id: result.attemptId,
          status: result.status,
          error_message: result.errorMessage,
        });
      } catch (error) {
        if (error instanceof PeriodCloseInvoiceSyncError) {
          return reply.code(error.statusCode).send({ error: error.message });
        }
        if (error instanceof StripeScopeError) return reply.code(403).send({ error: error.message });
        if (error instanceof StripeConnectionClosedError) return reply.code(400).send({ error: error.message });
        throw error;
      }
    });
  });
}
