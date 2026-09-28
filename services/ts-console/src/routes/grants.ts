import type { FastifyInstance, FastifyReply } from "fastify";
import type { Pool } from "pg";
import { recordConfigChangeWithClient } from "../lib/audit.js";
import { withTenant } from "../lib/db.js";
import {
  amendCommit,
  consumeGrant,
  customerVisible,
  insertGrant,
  insertGrantTemplate,
  insertIssuedLedger,
  listGrants,
  listLedgerEntries,
  parseAsOf,
  readEligibility,
  readGrant,
  readGrantTemplate,
  validateAmendCommitInput,
  validateConsumeInput,
  validateGrantInput,
  validateLedgerFilters,
  validateTemplateInput,
  validateVoidInput,
  voidGrant,
} from "../lib/grants.js";
import { consoleRoute } from "../lib/roleGuard.js";
import { logBlocked } from "../lib/security.js";
import { requireSession } from "../lib/sessionAuth.js";
import { ROLES } from "../lib/users.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INSUFFICIENT_BALANCE = "insufficient balance";
const VOID_CONFLICT = "grant is not active (already void or expired, or does not exist for this tenant)";
const AMEND_CONFLICT = "grant is not an active commit (already void or expired, or not a commit)";
const CUSTOMER_NOT_VISIBLE = "customer not found for this tenant";

function pageQuery(
  query: { limit?: unknown; cursor?: unknown },
  cursorError: string,
): { error: string } | { limit: number; cursor: string | null } {
  if (query.limit !== undefined && typeof query.limit !== "string") return { error: "limit must be an integer" };
  const requestedLimit = query.limit === undefined ? 50 : Number(query.limit);
  if (!Number.isInteger(requestedLimit) || requestedLimit <= 0) return { error: "limit must be a positive integer" };
  if (query.cursor !== undefined && (typeof query.cursor !== "string" || !UUID_RE.test(query.cursor))) {
    return { error: cursorError };
  }
  return {
    limit: Math.min(requestedLimit, 200),
    cursor: typeof query.cursor === "string" ? query.cursor : null,
  };
}

async function rejectInvisibleCustomer(pool: Pool, tenantId: string, endpoint: string, reply: FastifyReply) {
  await logBlocked(pool, {
    actingTenantId: tenantId,
    endpoint,
    method: "POST",
    detail: "customer_id not visible to caller's tenant",
    resolvedAction: "blocked_customer_not_visible",
  });
  return reply.code(403).send({ error: CUSTOMER_NOT_VISIBLE });
}

export function registerGrantRoutes(app: FastifyInstance, pool: Pool) {
  app.register(async (scoped) => {
    scoped.addHook("preHandler", requireSession(pool));

    consoleRoute(scoped, "post", "/grants", { role: ["Owner", "Billing Admin"] }, async (req, reply) => {
      const parsed = validateGrantInput(req.body);
      if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
      const { tenantId, userId } = req.consolePrincipal!;
      const created = await withTenant(pool, tenantId, async (client) => {
        if (!(await customerVisible(client, parsed.customer_id))) return null;
        const inserted = await insertGrant(client, tenantId, userId, parsed);
        await insertIssuedLedger(client, tenantId, inserted.id, inserted.issuedAmount);
        const grant = await readGrant(client, tenantId, inserted.id);
        if (!grant) throw new Error("inserted grant was not readable");
        await recordConfigChangeWithClient(client, tenantId, { userId }, {
          objectType: "Grant",
          objectId: inserted.id,
          customerId: parsed.customer_id,
          before: null,
          after: grant,
        });
        return grant;
      });
      if (!created) {
        await rejectInvisibleCustomer(pool, tenantId, "/grants", reply);
        return;
      }
      return reply.code(201).send(created);
    });

    consoleRoute(scoped, "get", "/grants", { role: [...ROLES] }, async (req, reply) => {
      const page = pageQuery(req.query as { limit?: unknown; cursor?: unknown }, "cursor must be a valid grant id");
      if ("error" in page) return reply.code(400).send({ error: page.error });
      const tenantId = req.consolePrincipal!.tenantId;
      const rows = await withTenant(pool, tenantId, (client) =>
        listGrants(client, tenantId, page.cursor, page.limit + 1),
      );
      const hasMore = rows.length > page.limit;
      const data = hasMore ? rows.slice(0, page.limit) : rows;
      return reply.send({ data, cursor: hasMore ? data[data.length - 1].id : null });
    });

    consoleRoute(scoped, "get", "/grants/:id", { role: [...ROLES] }, async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!UUID_RE.test(id)) return reply.code(400).send({ error: "id must be a UUID" });
      const tenantId = req.consolePrincipal!.tenantId;
      const grant = await withTenant(pool, tenantId, (client) => readGrant(client, tenantId, id));
      if (!grant) return reply.code(404).send({ error: "grant not found" });
      return reply.send(grant);
    });

    consoleRoute(scoped, "get", "/grants/:id/eligibility", { role: [...ROLES] }, async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!UUID_RE.test(id)) return reply.code(400).send({ error: "id must be a UUID" });
      const asOf = parseAsOf((req.query as { as_of?: unknown }).as_of);
      if ("error" in asOf) return reply.code(400).send({ error: asOf.error });
      const tenantId = req.consolePrincipal!.tenantId;
      const eligibility = await withTenant(pool, tenantId, (client) =>
        readEligibility(client, tenantId, id, asOf.value),
      );
      if (!eligibility) return reply.code(404).send({ error: "grant not found" });
      return reply.send(eligibility);
    });

    consoleRoute(scoped, "post", "/grants/:id/consume", { role: ["Owner", "Billing Admin"] }, async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!UUID_RE.test(id)) return reply.code(400).send({ error: "id must be a UUID" });
      const parsed = validateConsumeInput(req.body);
      if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
      const { tenantId, userId } = req.consolePrincipal!;
      const consumed = await withTenant(pool, tenantId, async (client) => {
        const grant = await consumeGrant(client, tenantId, id, parsed.amount, parsed.as_of);
        if (!grant) return null;
        await recordConfigChangeWithClient(client, tenantId, { userId }, {
          objectType: "Grant",
          objectId: id,
          customerId: grant.customer_id,
          before: { remaining_amount: grant.remaining_amount + parsed.amount, status: "active" },
          after: { remaining_amount: grant.remaining_amount, status: grant.status },
        });
        return grant;
      });
      if (!consumed) return reply.code(409).send({ error: INSUFFICIENT_BALANCE });
      return reply.send(consumed);
    });

    consoleRoute(scoped, "post", "/grants/:id/void", { role: ["Owner", "Billing Admin"] }, async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!UUID_RE.test(id)) return reply.code(400).send({ error: "id must be a UUID" });
      const parsed = validateVoidInput(req.body);
      if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
      const { tenantId, userId } = req.consolePrincipal!;
      const voided = await withTenant(pool, tenantId, async (client) => {
        const grant = await voidGrant(client, tenantId, id, parsed.reason);
        if (!grant) return null;
        await recordConfigChangeWithClient(client, tenantId, { userId }, {
          objectType: "Grant",
          objectId: id,
          customerId: grant.customer_id,
          before: { status: "active" },
          after: { status: "void", reason: parsed.reason },
        });
        return grant;
      });
      if (!voided) return reply.code(409).send({ error: VOID_CONFLICT });
      return reply.send(voided);
    });

    consoleRoute(scoped, "patch", "/grants/:id/amend", { role: ["Owner", "Billing Admin"] }, async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!UUID_RE.test(id)) return reply.code(400).send({ error: "id must be a UUID" });
      const parsed = validateAmendCommitInput(req.body);
      if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
      const { tenantId, userId } = req.consolePrincipal!;
      const outcome = await withTenant(pool, tenantId, async (client) => {
        const existing = await readGrant(client, tenantId, id);
        if (!existing) return { kind: "missing" as const };
        if (existing.status !== "active" || existing.source !== "commit") return { kind: "conflict" as const };
        if (parsed.expiry_date && parsed.expiry_date.getTime() <= new Date(existing.start_date).getTime()) {
          return { kind: "invalid" as const, error: "expiry_date must be after start_date" };
        }
        const amended = await amendCommit(client, tenantId, id, parsed);
        if (!amended) return { kind: "conflict" as const };
        await recordConfigChangeWithClient(client, tenantId, { userId }, {
          objectType: "Grant",
          objectId: id,
          customerId: amended.after.customer_id,
          before: amended.before,
          after: amended.after,
          reason: parsed.reason,
        });
        return { kind: "ok" as const, grant: amended.after };
      });
      if (outcome.kind === "missing") return reply.code(404).send({ error: "grant not found" });
      if (outcome.kind === "invalid") return reply.code(400).send({ error: outcome.error });
      if (outcome.kind === "conflict") return reply.code(409).send({ error: AMEND_CONFLICT });
      return reply.send(outcome.grant);
    });

    consoleRoute(scoped, "post", "/grant-templates", { role: ["Owner", "Billing Admin"] }, async (req, reply) => {
      const parsed = validateTemplateInput(req.body);
      if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
      const { tenantId, userId } = req.consolePrincipal!;
      const created = await withTenant(pool, tenantId, async (client) => {
        if (!(await customerVisible(client, parsed.customer_id))) return null;
        const id = await insertGrantTemplate(client, tenantId, userId, parsed);
        const template = await readGrantTemplate(client, tenantId, id);
        if (!template) throw new Error("inserted grant template was not readable");
        await recordConfigChangeWithClient(client, tenantId, { userId }, {
          objectType: "RecurringGrantTemplate",
          objectId: id,
          customerId: parsed.customer_id,
          before: null,
          after: template,
        });
        return template;
      });
      if (!created) {
        await rejectInvisibleCustomer(pool, tenantId, "/grant-templates", reply);
        return;
      }
      return reply.code(201).send(created);
    });

    consoleRoute(scoped, "get", "/grant-ledger-entries", { role: [...ROLES] }, async (req, reply) => {
      const query = req.query as {
        grant_id?: unknown;
        customer_id?: unknown;
        from?: unknown;
        to?: unknown;
        entry_type?: unknown;
        source?: unknown;
        limit?: unknown;
        cursor?: unknown;
      };
      const filters = validateLedgerFilters(query);
      if ("error" in filters) return reply.code(400).send({ error: filters.error });
      const page = pageQuery(query, "cursor must be a valid ledger entry id");
      if ("error" in page) return reply.code(400).send({ error: page.error });
      const tenantId = req.consolePrincipal!.tenantId;
      const rows = await withTenant(pool, tenantId, (client) =>
        listLedgerEntries(client, tenantId, filters, page.cursor, page.limit + 1),
      );
      const hasMore = rows.length > page.limit;
      const data = hasMore ? rows.slice(0, page.limit) : rows;
      return reply.send({ data, cursor: hasMore ? data[data.length - 1].id : null });
    });
  });
}
