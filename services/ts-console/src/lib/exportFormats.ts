import { mkdir, open, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";
import {
  streamExportSources,
  type ExportCategory,
  type ExportRange,
  type ExportRecord,
} from "./exportSources.js";

export const EXPORT_FORMATS = ["csv", "json", "parquet"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const CONTENT_TYPES: Record<ExportFormat, string> = {
  csv: "text/csv",
  json: "application/x-ndjson",
  parquet: "application/octet-stream",
};

export function exportStorageDir(): string {
  return process.env.EXPORT_STORAGE_DIR ?? "/tmp/teideal-exports";
}

function normalizedRecord(columns: readonly string[], record: ExportRecord): ExportRecord {
  return Object.fromEntries(columns.map((column) => [column, record[column]]));
}

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text: string;
  if (value instanceof Date) text = value.toISOString();
  else if (typeof value === "object") text = JSON.stringify(value);
  else text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

interface FormatWriter {
  startCategory(category: ExportCategory, columns: readonly string[]): Promise<void>;
  append(category: ExportCategory, columns: readonly string[], record: ExportRecord): Promise<void>;
  close(): Promise<void>;
}

class BufferedTextFile {
  private readonly chunks: string[] = [];
  private bufferedBytes = 0;

  constructor(private readonly file: FileHandle) {}

  async append(text: string): Promise<void> {
    this.chunks.push(text);
    this.bufferedBytes += Buffer.byteLength(text);
    if (this.bufferedBytes >= 1024 * 1024) await this.flush();
  }

  async flush(): Promise<void> {
    if (this.chunks.length === 0) return;
    const text = this.chunks.join("");
    this.chunks.length = 0;
    this.bufferedBytes = 0;
    await this.file.write(text);
  }

  async close(): Promise<void> {
    await this.flush();
    await this.file.close();
  }
}

class CsvWriter implements FormatWriter {
  private firstCategory = true;
  private readonly output: BufferedTextFile;

  constructor(file: FileHandle) {
    this.output = new BufferedTextFile(file);
  }

  async startCategory(category: ExportCategory, columns: readonly string[]): Promise<void> {
    const separator = this.firstCategory ? "" : "\n";
    this.firstCategory = false;
    await this.output.append(`${separator}# ${category}\n${columns.join(",")}\n`);
  }

  async append(_category: ExportCategory, columns: readonly string[], record: ExportRecord): Promise<void> {
    await this.output.append(`${columns.map((column) => csvCell(record[column])).join(",")}\n`);
  }

  async close(): Promise<void> {
    await this.output.close();
  }
}

class JsonLinesWriter implements FormatWriter {
  private readonly output: BufferedTextFile;

  constructor(file: FileHandle) {
    this.output = new BufferedTextFile(file);
  }

  async startCategory(): Promise<void> {}

  async append(category: ExportCategory, columns: readonly string[], record: ExportRecord): Promise<void> {
    await this.output.append(`${JSON.stringify({ category, record: normalizedRecord(columns, record) })}\n`);
  }

  async close(): Promise<void> {
    await this.output.close();
  }
}

class ParquetExportWriter implements FormatWriter {
  private constructor(private readonly writer: {
    setRowGroupSize(size: number): void;
    appendRow(row: Record<string, unknown>): Promise<void>;
    close(): Promise<void>;
  }) {}

  static async create(filePath: string): Promise<ParquetExportWriter> {
    // Loaded only when Parquet was requested, so a packaging problem in this
    // optional renderer cannot stop CSV/JSON routes or the whole server from
    // starting.
    const module = await import("@dsnp/parquetjs");
    const parquet = module.default ?? module;
    const schema = new parquet.ParquetSchema({
      category: { type: "UTF8" },
      record_json: { type: "UTF8" },
    });
    const writer = await parquet.ParquetWriter.openFile(schema, filePath);
    writer.setRowGroupSize(8192);
    return new ParquetExportWriter(writer);
  }

  async startCategory(): Promise<void> {}

  async append(category: ExportCategory, columns: readonly string[], record: ExportRecord): Promise<void> {
    await this.writer.appendRow({
      category,
      record_json: JSON.stringify(normalizedRecord(columns, record)),
    });
  }

  async close(): Promise<void> {
    await this.writer.close();
  }
}

export interface WrittenExport {
  filePaths: Partial<Record<ExportFormat, string>>;
  recordCounts: Record<string, number>;
}

export async function writeExportFiles(
  pool: Pool,
  tenantId: string,
  exportId: string,
  formats: readonly ExportFormat[],
  range: ExportRange,
  storageDir = exportStorageDir(),
): Promise<WrittenExport> {
  await mkdir(storageDir, { recursive: true });
  const filePaths: Partial<Record<ExportFormat, string>> = {};
  const writers = new Map<ExportFormat, FormatWriter>();
  const createdPaths: string[] = [];
  try {
    for (const format of formats) {
      const filePath = path.join(storageDir, `${exportId}.${format}`);
      filePaths[format] = filePath;
      createdPaths.push(filePath);
      if (format === "csv") writers.set(format, new CsvWriter(await open(filePath, "w")));
      else if (format === "json") writers.set(format, new JsonLinesWriter(await open(filePath, "w")));
      else writers.set(format, await ParquetExportWriter.create(filePath));
    }

    const recordCounts: Record<string, number> = { grants: 0 };
    for await (const item of streamExportSources(pool, tenantId, range)) {
      if (item.type === "category") {
        recordCounts[item.category] = 0;
        await Promise.all([...writers.values()].map((writer) => writer.startCategory(item.category, item.columns)));
      } else {
        recordCounts[item.category] += 1;
        await Promise.all([...writers.values()].map((writer) => writer.append(item.category, item.columns, item.record)));
      }
    }
    await Promise.all([...writers.values()].map((writer) => writer.close()));
    writers.clear();
    return { filePaths, recordCounts };
  } catch (error) {
    await Promise.allSettled([...writers.values()].map((writer) => writer.close()));
    await Promise.allSettled(createdPaths.map((filePath) => rm(filePath, { force: true })));
    throw error;
  }
}
