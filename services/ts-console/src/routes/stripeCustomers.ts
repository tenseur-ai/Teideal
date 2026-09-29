import type { FastifyInstance, FastifyReply } from "fastify";
import type { Pool, PoolClient } from "pg";
import { recordConfigChangeWithClient } from "../lib/audit.js";
import { withTenant } from "../lib/db.js";
import { consoleRoute } from "../lib/roleGuard.js";
import { requireSession } from "../lib/sessionAuth.js";
import {
  readUsableAccessToken,
  StripeConnectionClosedError,
  StripeScopeError,
} from "../lib/stripeConnect.js";
import {
  createStripeCustomer,
  listStripeCustomers,
  StripeApiError,
  type StripeCustomer,
} from "../lib/stripeCustomers.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLES = ["Owner", "Billing Admin"] as const;
const ALREADY_LINKED = "customer is already linked to a Stripe customer";
const BATCH_SIZE = 100;

interface ConnectionUse {
  id: string;
  scope: string;
  accessToken: string;
}

interface LinkRow {
  id: string;
  tenant_id: string;
  customer_id: string;
  stripe_customer_id: string;
  matched_by: string;
  created_at: Date | string;
}

interface CandidateRow {
  id: string;
  tenant_id: string;
  stripe_customer_id: string;
  stripe_name: string | null;
  stripe_email: string | null;
  status: string;
  detected_at: Date | string;
  resolved_at: Date | string | null;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "23505";
}

function stripeFailure(err: unknown, reply: FastifyReply) {
  if (err instanceof StripeScopeError) return reply.code(403).send({ error: err.message });
  if (err instanceof StripeConnectionClosedError) return reply.code(400).send({ error: err.message });
  if (err instanceof StripeApiError) return reply.code(502).send({ error: err.message });
  return null;
}

async function loadConnectedConnection(pool: Pool, tenantId: string): Promise<ConnectionUse | null> {
  return withTenant(pool, tenantId, async (client) => {
    const row = (await client.query<{ id: string; scope: string }>(
      `SELECT id, scope FROM stripe_connections
       WHERE status = 'connected'
       ORDER BY connected_at DESC
       LIMIT 1`,
    )).rows[0];
    if (!row) return null;
    const accessToken = await readUsableAccessToken(client, row.id);
    return { id: row.id, scope: row.scope, accessToken };
  });
}

async function matchBatch(
  client: PoolClient,
  tenantId: string,
  batch: StripeCustomer[],
): Promise<{ linked: number; candidates: number }> {
  if (batch.length === 0) return { linked: 0, candidates: 0 };

  const ids = batch.map((row) => row.id);
  const already = new Set(
    (await client.query<{ stripe_customer_id: string }>(
      `SELECT stripe_customer_id FROM stripe_customer_links WHERE stripe_customer_id = ANY($1::text[])`,
      [ids],
    )).rows.map((row) => row.stripe_customer_id),
  );

  const emails = [...new Set(
    batch
      .filter((row) => !already.has(row.id) && row.email)
      .map((row) => row.email!.toLowerCase()),
  )];

  const byEmail = new Map<string, string[]>();
  if (emails.length > 0) {
    const matches = (await client.query<{ id: string; email: string }>(
      `SELECT c.id, c.email
       FROM customers c
       LEFT JOIN stripe_customer_links l ON l.customer_id = c.id
       WHERE l.id IS NULL AND lower(c.email) = ANY($1::text[])`,
      [emails],
    )).rows;
    for (const row of matches) {
      const key = row.email.toLowerCase();
      const list = byEmail.get(key) ?? [];
      list.push(row.id);
      byEmail.set(key, list);
    }
  }

  const assigned = new Set<string>();
  const links: { customerId: string; stripeId: string }[] = [];
  const candidates: StripeCustomer[] = [];
  for (const stripeCustomer of batch) {
    if (already.has(stripeCustomer.id)) continue;
    const email = stripeCustomer.email?.toLowerCase() ?? "";
    const available = (email ? (byEmail.get(email) ?? []) : []).filter((id) => !assigned.has(id));
    if (email && available.length === 1) {
      assigned.add(available[0]);
      links.push({ customerId: available[0], stripeId: stripeCustomer.id });
    } else {
      candidates.push(stripeCustomer);
    }
  }

  let linked = 0;
  if (links.length > 0) {
    const inserted = await client.query(
      `INSERT INTO stripe_customer_links (tenant_id, customer_id, stripe_customer_id, matched_by)
       SELECT $1, x.customer_id, x.stripe_customer_id, 'email'
       FROM unnest($2::uuid[], $3::text[]) AS x(customer_id, stripe_customer_id)
       ON CONFLICT (customer_id) DO NOTHING
       RETURNING id`,
      [tenantId, links.map((row) => row.customerId), links.map((row) => row.stripeId)],
    );
    linked = inserted.rowCount ?? 0;
  }

  let candidateCount = 0;
  if (candidates.length > 0) {
    const upserted = await client.query(
      `INSERT INTO stripe_customer_match_candidates (
         tenant_id, stripe_customer_id, stripe_name, stripe_email, status
       )
       SELECT $1, x.sid, x.sname, x.semail, 'pending'
       FROM unnest($2::text[], $3::text[], $4::text[]) AS x(sid, sname, semail)
       ON CONFLICT (tenant_id, stripe_customer_id) WHERE status = 'pending'
       DO UPDATE SET
         stripe_name = EXCLUDED.stripe_name,
         stripe_email = EXCLUDED.stripe_email
       RETURNING id`,
      [
        tenantId,
        candidates.map((row) => row.id),
        candidates.map((row) => row.name),
        candidates.map((row) => row.email),
      ],
    );
    candidateCount = upserted.rowCount ?? 0;
  }

  return { linked, candidates: candidateCount };
}

export function registerStripeCustomerRoutes(app: FastifyInstance, pool: Pool) {
  app.register(async (scoped) => {
    scoped.addHook("preHandler", requireSession(pool));

    consoleRoute(scoped, "post", "/stripe/customers/sync", { role: [...ROLES] }, async (req, reply) => {
      const { tenantId } = req.consolePrincipal!;
      let connection: ConnectionUse | null;
      try {
        connection = await loadConnectedConnection(pool, tenantId);
      } catch (err) {
        const failure = stripeFailure(err, reply);
        if (failure) return failure;
        throw err;
      }
      if (!connection) return reply.code(400).send({ error: "no connected stripe account" });

      let listed: StripeCustomer[];
      try {
        listed = await listStripeCustomers(connection.accessToken);
      } catch (err) {
        const failure = stripeFailure(err, reply);
        if (failure) return failure;
        throw err;
      }

      let linked = 0;
      let candidates = 0;
      for (let i = 0; i < listed.length; i += BATCH_SIZE) {
        const batch = listed.slice(i, i + BATCH_SIZE);
        const result = await withTenant(pool, tenantId, (client) => matchBatch(client, tenantId, batch));
        linked += result.linked;
        candidates += result.candidates;
      }
      return reply.send({ linked, candidates });
    });

    consoleRoute(scoped, "get", "/stripe/customers/match-candidates", { role: [...ROLES] }, async (req, reply) => {
      const { tenantId } = req.consolePrincipal!;
      const rows = await withTenant(pool, tenantId, async (client) =>
        (await client.query<CandidateRow>(
          `SELECT * FROM stripe_customer_match_candidates WHERE status = 'pending' ORDER BY detected_at`,
        )).rows,
      );
      return reply.send({ data: rows });
    });

    consoleRoute(scoped, "post", "/stripe/customers/:customerId/link-stripe", { role: [...ROLES] }, async (req, reply) => {
      const { customerId } = req.params as { customerId: string };
      if (!UUID_RE.test(customerId)) return reply.code(400).send({ error: "customerId must be a UUID" });
      const body = (req.body ?? {}) as {
        stripe_customer_id?: unknown;
        create_new?: unknown;
        name?: unknown;
        email?: unknown;
      };
      const { tenantId } = req.consolePrincipal!;

      let connection: ConnectionUse | null;
      try {
        connection = await loadConnectedConnection(pool, tenantId);
      } catch (err) {
        const failure = stripeFailure(err, reply);
        if (failure) return failure;
        throw err;
      }
      if (!connection) return reply.code(400).send({ error: "no connected stripe account" });

      let stripeCustomerId: string;
      if (body.create_new === true) {
        if (typeof body.name !== "string" || !body.name.trim() || typeof body.email !== "string" || !body.email.trim()) {
          return reply.code(400).send({ error: "name and email are required" });
        }
        try {
          const created = await createStripeCustomer(
            connection.accessToken,
            { name: body.name.trim(), email: body.email.trim() },
            { scope: connection.scope },
          );
          stripeCustomerId = created.id;
        } catch (err) {
          const failure = stripeFailure(err, reply);
          if (failure) return failure;
          throw err;
        }
      } else if (typeof body.stripe_customer_id === "string" && body.stripe_customer_id.length > 0) {
        let listed: StripeCustomer[];
        try {
          listed = await listStripeCustomers(connection.accessToken);
        } catch (err) {
          const failure = stripeFailure(err, reply);
          if (failure) return failure;
          throw err;
        }
        const found = listed.find((row) => row.id === body.stripe_customer_id);
        if (!found) return reply.code(400).send({ error: "stripe customer not found" });
        stripeCustomerId = found.id;
      } else {
        return reply.code(400).send({ error: "stripe_customer_id or create_new is required" });
      }

      try {
        const result = await withTenant(pool, tenantId, async (client) => {
          const customer = (await client.query<{ id: string }>(
            `SELECT id FROM customers WHERE id = $1 FOR UPDATE`,
            [customerId],
          )).rows[0];
          if (!customer) return { kind: "missing" as const };
          const inserted = await client.query<LinkRow>(
            `INSERT INTO stripe_customer_links (tenant_id, customer_id, stripe_customer_id, matched_by)
             VALUES ($1, $2, $3, 'manual_create_in_stripe')
             ON CONFLICT (customer_id) DO NOTHING
             RETURNING id, tenant_id, customer_id, stripe_customer_id, matched_by, created_at`,
            [tenantId, customerId, stripeCustomerId],
          );
          if (!inserted.rows[0]) return { kind: "conflict" as const };
          return { kind: "created" as const, row: inserted.rows[0] };
        });
        if (result.kind === "missing") return reply.code(404).send({ error: "customer not found" });
        if (result.kind === "conflict") return reply.code(409).send({ error: ALREADY_LINKED });
        return reply.code(201).send(result.row);
      } catch (err) {
        if (isUniqueViolation(err)) return reply.code(409).send({ error: ALREADY_LINKED });
        throw err;
      }
    });

    consoleRoute(scoped, "post", "/stripe/candidates/:id/create-in-teideal", { role: [...ROLES] }, async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!UUID_RE.test(id)) return reply.code(400).send({ error: "id must be a UUID" });
      const { tenantId, userId } = req.consolePrincipal!;
      const created = await withTenant(pool, tenantId, async (client) => {
        const candidate = (await client.query<CandidateRow>(
          `SELECT * FROM stripe_customer_match_candidates WHERE id = $1 AND status = 'pending' FOR UPDATE`,
          [id],
        )).rows[0];
        if (!candidate) return null;
        if (!candidate.stripe_email) return { kind: "invalid" as const };
        const name = candidate.stripe_name && candidate.stripe_name.trim().length > 0
          ? candidate.stripe_name
          : candidate.stripe_email;
        const customer = (await client.query<{ id: string; name: string; email: string }>(
          `INSERT INTO customers (tenant_id, name, email) VALUES ($1, $2, $3) RETURNING id, name, email`,
          [tenantId, name, candidate.stripe_email],
        )).rows[0];
        const link = (await client.query<LinkRow>(
          `INSERT INTO stripe_customer_links (tenant_id, customer_id, stripe_customer_id, matched_by)
           VALUES ($1, $2, $3, 'manual_create_in_teideal')
           RETURNING id, tenant_id, customer_id, stripe_customer_id, matched_by, created_at`,
          [tenantId, customer.id, candidate.stripe_customer_id],
        )).rows[0];
        await client.query(
          `UPDATE stripe_customer_match_candidates
           SET status = 'resolved', resolved_at = now()
           WHERE id = $1`,
          [id],
        );
        await recordConfigChangeWithClient(client, tenantId, { userId }, {
          objectType: "Customer",
          objectId: customer.id,
          customerId: customer.id,
          before: null,
          after: { name: customer.name, email: customer.email },
        });
        return { kind: "created" as const, customer, link };
      });
      if (!created) return reply.code(404).send({ error: "match candidate not found" });
      if (created.kind === "invalid") {
        return reply.code(400).send({ error: "match candidate is missing an email" });
      }
      return reply.code(201).send({ customer: created.customer, link: created.link });
    });
  });
}
