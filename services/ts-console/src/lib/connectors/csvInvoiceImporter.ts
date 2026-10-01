import type { Pool } from "pg";
import { withTenant } from "../db.js";

const REQUIRED_COLUMNS = ["invoice_id", "customer_id", "amount", "currency", "status", "issued_at"] as const;
const DECIMAL_STRING = /^-?\d+(?:\.\d+)?$/;

export class CsvInvoiceImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvInvoiceImportError";
  }
}

export interface CsvInvoiceImportResult {
  csv_import_id: string;
  total: number;
  accepted: number;
  quarantined: number;
}

interface ParsedRow {
  rowNumber: number;
  raw: Record<string, string>;
  reason: string | null;
  invoice: Record<string, unknown> | null;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.endsWith("\r") ? field.slice(0, -1) : field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  if (quoted) throw new CsvInvoiceImportError("CSV contains an unterminated quoted field");
  if (field.length > 0 || row.length > 0) {
    row.push(field.endsWith("\r") ? field.slice(0, -1) : field);
    rows.push(row);
  }
  return rows;
}

function analyze(csvText: string): ParsedRow[] {
  const parsed = parseCsv(csvText);
  if (parsed.length === 0) throw new CsvInvoiceImportError("CSV header row is required");
  const headers = parsed[0].map((header) => header.trim());
  const missingHeaders = REQUIRED_COLUMNS.filter((column) => !headers.includes(column));
  const seenInvoiceIds = new Set<string>();
  const rows: ParsedRow[] = [];
  for (let index = 1; index < parsed.length; index += 1) {
    const values = parsed[index];
    if (values.every((value) => value === "")) continue;
    const raw = Object.fromEntries(headers.map((header, column) => [header || `column_${column + 1}`, values[column] ?? ""]));
    const reasons: string[] = [];
    if (missingHeaders.length > 0) reasons.push(`missing required columns: ${missingHeaders.join(", ")}`);
    const missingValues = REQUIRED_COLUMNS.filter((column) => !raw[column]?.trim());
    if (missingValues.length > 0) reasons.push(`missing required values: ${missingValues.join(", ")}`);
    const invoiceId = raw.invoice_id?.trim() ?? "";
    if (invoiceId && seenInvoiceIds.has(invoiceId)) reasons.push("duplicate invoice_id in this file");
    if (invoiceId) seenInvoiceIds.add(invoiceId);
    const amount = raw.amount?.trim() ?? "";
    if (amount && !DECIMAL_STRING.test(amount)) reasons.push("amount must be a decimal string");

    const passthrough = Object.fromEntries(
      Object.entries(raw).filter(([key]) => !(REQUIRED_COLUMNS as readonly string[]).includes(key)),
    );
    rows.push({
      rowNumber: index + 1,
      raw,
      reason: reasons.length > 0 ? reasons.join("; ") : null,
      invoice: reasons.length > 0 ? null : {
        id: invoiceId,
        customer_id: raw.customer_id.trim(),
        amount,
        currency: raw.currency.trim().toUpperCase(),
        status: raw.status.trim(),
        issued_at: raw.issued_at.trim(),
        due_at: null,
        number: null,
        period_start: null,
        period_end: null,
        subtotal: null,
        tax: null,
        lines: [],
        external_updated_at: null,
        passthrough,
      },
    });
  }
  return rows;
}

export async function parseAndImportInvoiceCsv(
  pool: Pool,
  tenantId: string,
  connectorId: string,
  csvText: string,
): Promise<CsvInvoiceImportResult> {
  const rows = analyze(csvText);
  const accepted = rows.filter((row) => row.invoice !== null);
  const quarantined = rows.filter((row) => row.invoice === null);

  return withTenant(pool, tenantId, async (client) => {
    const connector = (await client.query<{ id: string }>(
      `SELECT id FROM connectors
       WHERE id = $1 AND tenant_id = $2 AND connector_type = 'csv_import' AND status = 'connected'`,
      [connectorId, tenantId],
    )).rows[0];
    if (!connector) throw new Error("CSV import connector not found");

    const importId = (await client.query<{ id: string }>(
      `INSERT INTO csv_imports (
         tenant_id, connector_id, filename, total_rows, accepted_rows, quarantined_rows
       ) VALUES ($1, $2, 'invoices.csv', $3, $4, $5)
       RETURNING id`,
      [tenantId, connectorId, rows.length, accepted.length, quarantined.length],
    )).rows[0].id;

    if (accepted.length > 0) {
      await client.query(
        `INSERT INTO connector_records (tenant_id, connector_id, entity_type, external_id, data)
         SELECT $1, $2, 'invoice', records.external_id, records.data
         FROM unnest($3::text[], $4::jsonb[]) AS records(external_id, data)
         ON CONFLICT (connector_id, entity_type, external_id)
         DO UPDATE SET data = excluded.data, synced_at = now()`,
        [
          tenantId,
          connectorId,
          accepted.map((row) => row.invoice!.id),
          accepted.map((row) => JSON.stringify(row.invoice)),
        ],
      );
    }
    if (quarantined.length > 0) {
      await client.query(
        `INSERT INTO csv_import_quarantine (tenant_id, import_id, row_number, raw_row, reason)
         SELECT $1, $2, rejected.row_number, rejected.raw_row, rejected.reason
         FROM unnest($3::int[], $4::jsonb[], $5::text[])
              AS rejected(row_number, raw_row, reason)`,
        [
          tenantId,
          importId,
          quarantined.map((row) => row.rowNumber),
          quarantined.map((row) => JSON.stringify(row.raw)),
          quarantined.map((row) => row.reason!),
        ],
      );
    }
    return {
      csv_import_id: importId,
      total: rows.length,
      accepted: accepted.length,
      quarantined: quarantined.length,
    };
  });
}
