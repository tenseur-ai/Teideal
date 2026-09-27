import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";
import { withTenant } from "./db.js";
import {
  CONTENT_TYPES,
  writeExportFiles,
  type ExportFormat,
  type WrittenExport,
} from "./exportFormats.js";
import { sendEmail } from "./notify.js";
import { uploadExportFiles } from "./s3.js";

interface ExportJob {
  id: string;
  tenant_id: string;
  formats: ExportFormat[];
  range_start: Date | null;
  range_end: Date | null;
}

interface ExportSchedule {
  id: string;
  tenant_id: string;
  s3_bucket: string;
  s3_prefix: string;
  s3_region: string;
  role_arn: string;
  formats: ExportFormat[];
}

async function tenantIds(pool: Pool): Promise<string[]> {
  return (await pool.query<{ id: string }>("SELECT id FROM tenants ORDER BY id")).rows.map((row) => row.id);
}

async function claimPendingExport(pool: Pool, tenantId: string): Promise<ExportJob | null> {
  return withTenant(pool, tenantId, async (client) => {
    const pending = (await client.query<ExportJob>(
      `SELECT id, tenant_id, formats, range_start, range_end
       FROM exports
       WHERE tenant_id = $1 AND status = 'pending'
       ORDER BY created_at, id
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
      [tenantId],
    )).rows[0];
    if (!pending) return null;
    await client.query(
      `UPDATE exports SET status = 'running', error_message = NULL
       WHERE id = $1 AND tenant_id = $2`,
      [pending.id, tenantId],
    );
    return pending;
  });
}

async function completeExport(pool: Pool, job: ExportJob, written: WrittenExport): Promise<void> {
  await withTenant(pool, job.tenant_id, async (client) => {
    await client.query(
      `UPDATE exports
       SET status = 'completed', record_counts = $3::jsonb,
           file_paths = $4::jsonb, completed_at = now(), error_message = NULL
       WHERE id = $1 AND tenant_id = $2`,
      [job.id, job.tenant_id, JSON.stringify(written.recordCounts), JSON.stringify(written.filePaths)],
    );
  });
}

async function failExport(pool: Pool, job: ExportJob, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await withTenant(pool, job.tenant_id, async (client) => {
    await client.query(
      `UPDATE exports
       SET status = 'failed', error_message = $3, completed_at = now()
       WHERE id = $1 AND tenant_id = $2`,
      [job.id, job.tenant_id, message],
    );
  });
}

export async function processPendingExports(pool: Pool): Promise<number> {
  let processed = 0;
  for (const tenantId of await tenantIds(pool)) {
    while (true) {
      const job = await claimPendingExport(pool, tenantId);
      if (!job) break;
      try {
        const written = await writeExportFiles(pool, tenantId, job.id, job.formats, {
          rangeStart: job.range_start,
          rangeEnd: job.range_end,
        });
        await completeExport(pool, job, written);
        processed += 1;
      } catch (error) {
        await failExport(pool, job, error);
        throw error;
      }
    }
  }
  return processed;
}

function objectKey(prefix: string, filePath: string): string {
  const cleanPrefix = prefix.replace(/^\/+|\/+$/g, "");
  return cleanPrefix ? `${cleanPrefix}/${path.basename(filePath)}` : path.basename(filePath);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function deliverWithRetries(
  schedule: ExportSchedule,
  written: WrittenExport,
  retryDelaysMs: readonly number[],
): Promise<void> {
  const objects = Object.entries(written.filePaths).map(([format, filePath]) => ({
    key: objectKey(schedule.s3_prefix, filePath as string),
    filePath: filePath as string,
    contentType: CONTENT_TYPES[format as ExportFormat],
  }));
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await uploadExportFiles(schedule.s3_region, schedule.role_arn, schedule.s3_bucket, objects);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await delay(retryDelaysMs[attempt] ?? 0);
    }
  }
  throw lastError;
}

async function dueSchedules(pool: Pool, tenantId: string, now: Date): Promise<ExportSchedule[]> {
  return withTenant(pool, tenantId, async (client) =>
    (await client.query<ExportSchedule>(
      `SELECT id, tenant_id, s3_bucket, s3_prefix, s3_region, role_arn, formats
       FROM export_schedules
       WHERE tenant_id = $1 AND enabled = true
         AND (last_run_at IS NULL OR last_run_at < $2::timestamptz - interval '1 day')
       ORDER BY created_at, id`,
      [tenantId, now],
    )).rows,
  );
}

async function markScheduleRun(
  pool: Pool,
  schedule: ExportSchedule,
  now: Date,
  status: "succeeded" | "failed",
): Promise<void> {
  await withTenant(pool, schedule.tenant_id, async (client) => {
    await client.query(
      `UPDATE export_schedules
       SET last_run_at = $3,
           last_run_status = $4,
           consecutive_failures = CASE WHEN $4 = 'succeeded' THEN 0 ELSE consecutive_failures + 1 END
       WHERE id = $1 AND tenant_id = $2`,
      [schedule.id, schedule.tenant_id, now, status],
    );
  });
}

async function alertOwners(pool: Pool, schedule: ExportSchedule, error: unknown): Promise<void> {
  const owners = await withTenant(pool, schedule.tenant_id, async (client) =>
    (await client.query<{ email: string }>(
      `SELECT email FROM users WHERE tenant_id = $1 AND role = 'Owner' ORDER BY id`,
      [schedule.tenant_id],
    )).rows,
  );
  const detail = error instanceof Error ? error.message : String(error);
  for (const owner of owners) {
    await sendEmail(
      pool,
      schedule.tenant_id,
      owner.email,
      `Scheduled export ${schedule.id} failed`,
      `Scheduled export ${schedule.id} could not be delivered to s3://${schedule.s3_bucket}/${schedule.s3_prefix} after 3 attempts: ${detail}`,
    );
  }
}

export async function processScheduledExports(
  pool: Pool,
  now = new Date(),
  retryDelaysMs: readonly number[] = [1_000, 5_000],
): Promise<number> {
  let processed = 0;
  for (const tenantId of await tenantIds(pool)) {
    for (const schedule of await dueSchedules(pool, tenantId, now)) {
      let written: WrittenExport | undefined;
      try {
        const scratchId = `${schedule.id}-${now.getTime()}-${randomUUID()}`;
        written = await writeExportFiles(pool, tenantId, scratchId, schedule.formats, {
          rangeStart: null,
          rangeEnd: null,
        });
        await deliverWithRetries(schedule, written, retryDelaysMs);
        await markScheduleRun(pool, schedule, now, "succeeded");
      } catch (error) {
        await markScheduleRun(pool, schedule, now, "failed");
        await alertOwners(pool, schedule, error);
      } finally {
        if (written) {
          await Promise.allSettled(Object.values(written.filePaths).map((filePath) => rm(filePath as string, { force: true })));
        }
      }
      processed += 1;
    }
  }
  return processed;
}
