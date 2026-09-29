import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";
import { recordConfigChangeWithClient } from "../lib/audit.js";
import { withTenant } from "../lib/db.js";
import { consoleRoute } from "../lib/roleGuard.js";
import { requireSession } from "../lib/sessionAuth.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;
const BILLING_ROLES = ["Owner", "Billing Admin"] as const;

type Scope = "plan" | "customer";

interface ThresholdInput {
  thresholdPcts: number[];
  operatorEmails: string[];
  slackWebhookUrl: string | null;
  notifyCustomer: boolean;
  customerEmail: string | null;
}

interface ThresholdRow {
  id: string;
  scope: Scope;
  scope_id: string;
  threshold_pcts: Array<number | string>;
  operator_emails: string[];
  slack_webhook_url: string | null;
  notify_customer: boolean;
  customer_email: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface FailureRow {
  id: string;
  customer_id: string;
  customer_name: string | null;
  grant_id: string;
  threshold_pct: number | string;
  period_start: string;
  sent_at: Date | string;
  delivery_status: unknown;
}

function asRecord(body: unknown): Record<string, unknown> {
  if (body !== null && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
  return {};
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "23505";
}

function readScope(query: unknown): { error: string } | { scope: Scope; scopeId: string } {
  const record = asRecord(query);
  if (record.scope !== "plan" && record.scope !== "customer") {
    return { error: "scope must be plan or customer" };
  }
  if (typeof record.scope_id !== "string" || !UUID_RE.test(record.scope_id)) {
    return { error: "scope_id must be a UUID" };
  }
  return { scope: record.scope, scopeId: record.scope_id };
}

function validateThresholds(value: unknown): { error: string } | { value: number[] } {
  if (!Array.isArray(value)) {
    return { error: "threshold_pcts must be an array of integers greater than 0 and less than or equal to 100" };
  }
  const pcts: number[] = [];
  for (const entry of value) {
    if (typeof entry !== "number" || !Number.isInteger(entry) || entry <= 0 || entry > 100) {
      return { error: "threshold_pcts must each be an integer greater than 0 and less than or equal to 100" };
    }
    pcts.push(entry);
  }
  return { value: pcts };
}

function validateEmails(value: unknown, field: string): { error: string } | { value: string[] } {
  if (value === undefined) return { value: [] };
  if (!Array.isArray(value)) return { error: `${field} must be an array of email addresses` };
  const emails: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !EMAIL_RE.test(entry)) {
      return { error: `${field} must be an array of email addresses` };
    }
    emails.push(entry);
  }
  return { value: emails };
}

function validateOptionalEmail(value: unknown, field: string): { error: string } | { value: string | null } {
  if (value === undefined || value === null || value === "") return { value: null };
  if (typeof value !== "string" || !EMAIL_RE.test(value)) return { error: `${field} must be an email address` };
  return { value };
}

function validateSlackUrl(value: unknown): { error: string } | { value: string | null } {
  if (value === undefined || value === null || value === "") return { value: null };
  if (typeof value !== "string") return { error: "slack_webhook_url must be an http(s) URL" };
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { error: "slack_webhook_url must be an http(s) URL" };
    }
    return { value };
  } catch {
    return { error: "slack_webhook_url must be an http(s) URL" };
  }
}

function validateInput(body: unknown): { error: string } | ThresholdInput {
  const record = asRecord(body);
  const thresholdPcts = validateThresholds(record.threshold_pcts);
  if ("error" in thresholdPcts) return thresholdPcts;
  const operatorEmails = validateEmails(record.operator_emails, "operator_emails");
  if ("error" in operatorEmails) return operatorEmails;
  const slackWebhookUrl = validateSlackUrl(record.slack_webhook_url);
  if ("error" in slackWebhookUrl) return slackWebhookUrl;
  if (record.notify_customer !== undefined && typeof record.notify_customer !== "boolean") {
    return { error: "notify_customer must be a boolean" };
  }
  const notifyCustomer = record.notify_customer === true;
  const customerEmail = validateOptionalEmail(record.customer_email, "customer_email");
  if ("error" in customerEmail) return customerEmail;
  if (notifyCustomer && customerEmail.value === null) {
    return { error: "customer_email is required when notify_customer is true" };
  }
  return {
    thresholdPcts: thresholdPcts.value,
    operatorEmails: operatorEmails.value,
    slackWebhookUrl: slackWebhookUrl.value,
    notifyCustomer,
    customerEmail: customerEmail.value,
  };
}

function shapeThreshold(row: ThresholdRow) {
  return {
    id: row.id,
    scope: row.scope,
    scope_id: row.scope_id,
    threshold_pcts: row.threshold_pcts.map((pct) => Number(pct)),
    operator_emails: row.operator_emails,
    slack_webhook_url: row.slack_webhook_url,
    notify_customer: row.notify_customer,
    customer_email: row.customer_email,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

const THRESHOLD_RETURNING = `
  id, scope, scope_id, threshold_pcts, operator_emails, slack_webhook_url,
  notify_customer, customer_email, created_at, updated_at`;

async function readThreshold(client: PoolClient, tenantId: string, scope: Scope, scopeId: string): Promise<ThresholdRow | null> {
  const { rows } = await client.query<ThresholdRow>(
    `SELECT ${THRESHOLD_RETURNING}
     FROM billing_alert_thresholds
     WHERE tenant_id = $1 AND scope = $2 AND scope_id = $3`,
    [tenantId, scope, scopeId],
  );
  return rows[0] ?? null;
}

async function scopeExists(client: PoolClient, tenantId: string, scope: Scope, scopeId: string): Promise<boolean> {
  const table = scope === "plan" ? "plans" : "customers";
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM ${table} WHERE tenant_id = $1 AND id = $2`,
    [tenantId, scopeId],
  );
  return rows.length > 0;
}

export function registerBillingAlertRoutes(app: FastifyInstance, pool: Pool): void {
  app.register(async (scoped) => {
    scoped.addHook("preHandler", requireSession(pool));

    consoleRoute(scoped, "get", "/billing-alert-thresholds/delivery-failures", { role: [...BILLING_ROLES] }, async (req, reply) => {
      const tenantId = req.consolePrincipal!.tenantId;
      const rows = await withTenant(pool, tenantId, async (client) =>
        (await client.query<FailureRow>(
          `SELECT s.id, s.customer_id, c.name AS customer_name, s.grant_id,
                  s.threshold_pct::int AS threshold_pct, s.period_start::text AS period_start,
                  s.sent_at, s.delivery_status
           FROM billing_alert_sent s
           LEFT JOIN customers c ON c.id = s.customer_id AND c.tenant_id = s.tenant_id
           WHERE s.tenant_id = $1
             AND (
               s.delivery_status->>'operator_email' = 'failed'
               OR s.delivery_status->>'slack' = 'failed'
               OR s.delivery_status->>'customer_email' = 'failed'
             )
           ORDER BY s.sent_at DESC, s.id`,
          [tenantId],
        )).rows,
      );
      return reply.send({
        data: rows.map((row) => ({
          id: row.id,
          customer_id: row.customer_id,
          customer_name: row.customer_name,
          grant_id: row.grant_id,
          threshold_pct: Number(row.threshold_pct),
          period_start: row.period_start,
          sent_at: toIso(row.sent_at),
          delivery_status: row.delivery_status,
        })),
      });
    });

    consoleRoute(scoped, "get", "/billing-alert-thresholds", { role: [...BILLING_ROLES] }, async (req, reply) => {
      const parsed = readScope(req.query);
      if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
      const tenantId = req.consolePrincipal!.tenantId;
      const row = await withTenant(pool, tenantId, (client) => readThreshold(client, tenantId, parsed.scope, parsed.scopeId));
      if (!row) return reply.code(404).send({ error: "billing alert thresholds not found" });
      return reply.send(shapeThreshold(row));
    });

    consoleRoute(scoped, "put", "/billing-alert-thresholds", { role: [...BILLING_ROLES] }, async (req, reply) => {
      const parsedScope = readScope(req.query);
      if ("error" in parsedScope) return reply.code(400).send({ error: parsedScope.error });
      const parsed = validateInput(req.body);
      if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
      const { tenantId, userId } = req.consolePrincipal!;
      try {
        const saved = await withTenant(pool, tenantId, async (client) => {
          if (!(await scopeExists(client, tenantId, parsedScope.scope, parsedScope.scopeId))) return null;
          const before = await readThreshold(client, tenantId, parsedScope.scope, parsedScope.scopeId);
          const { rows } = await client.query<ThresholdRow>(
            `INSERT INTO billing_alert_thresholds (
               tenant_id, scope, scope_id, threshold_pcts, operator_emails,
               slack_webhook_url, notify_customer, customer_email
             ) VALUES ($1, $2, $3, $4::smallint[], $5::text[], $6, $7, $8)
             ON CONFLICT (tenant_id, scope, scope_id) DO UPDATE SET
               threshold_pcts = EXCLUDED.threshold_pcts,
               operator_emails = EXCLUDED.operator_emails,
               slack_webhook_url = EXCLUDED.slack_webhook_url,
               notify_customer = EXCLUDED.notify_customer,
               customer_email = EXCLUDED.customer_email,
               updated_at = now()
             RETURNING ${THRESHOLD_RETURNING}`,
            [
              tenantId,
              parsedScope.scope,
              parsedScope.scopeId,
              parsed.thresholdPcts,
              parsed.operatorEmails,
              parsed.slackWebhookUrl,
              parsed.notifyCustomer,
              parsed.customerEmail,
            ],
          );
          const after = shapeThreshold(rows[0]);
          await recordConfigChangeWithClient(client, tenantId, { userId }, {
            objectType: "BillingAlertThreshold",
            objectId: after.id,
            customerId: parsedScope.scope === "customer" ? parsedScope.scopeId : null,
            before: before ? shapeThreshold(before) : null,
            after,
          });
          return after;
        });
        if (!saved) {
          const noun = parsedScope.scope === "plan" ? "plan" : "customer";
          return reply.code(404).send({ error: `${noun} not found` });
        }
        return reply.send(saved);
      } catch (error) {
        if (isUniqueViolation(error)) {
          return reply.code(400).send({ error: "billing alert thresholds already exist for this scope" });
        }
        throw error;
      }
    });
  });
}
