import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { resolveApiKey } from "../lib/auth.js";
import { withTenant } from "../lib/db.js";
import {
  GoUsageError,
  getLedgerTransactionDetail,
  listAdjustments,
  listLedgerTransactions,
  listReservations,
  listUsageBuckets,
  listUsageEvents,
  type AdjustmentRow,
  type LedgerTransactionRow,
  type ReservationRow,
  type UsageBucket,
  type UsageEvent,
} from "../lib/goUsageClient.js";
import { customerVisible } from "../lib/grants.js";
import { CONSOLE_ROUTE_AUDIT } from "../lib/roleGuard.js";
import { logBlocked } from "../lib/security.js";
import { requireSession } from "../lib/sessionAuth.js";
import { ROLES } from "../lib/users.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const LARGE_BUCKET_INLINE_LIMIT = 50;

type TimelineType = "grant" | "usage_bucket" | "reservation" | "adjustment" | "charge" | "config_change";

interface TimelineEntry {
  type: TimelineType;
  occurred_at: string;
  id: string;
  [key: string]: unknown;
}

interface TimelineCursor {
  t: string;
  k: string;
}

interface GrantLedgerRow {
  id: string;
  grant_id: string;
  entry_type: string;
  amount: string;
  reason: string | null;
  occurred_at: Date;
}

interface AuditRow {
  id: string;
  occurred_at: Date;
  event_type: string;
  object_type: string | null;
  object_id: string | null;
  actor_api_key_id: string | null;
  before: unknown;
  after: unknown;
}

function authorizationHeader(req: FastifyRequest): string | undefined {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ") || header.length <= "Bearer ".length) return undefined;
  return header;
}

function requireTimelineAuth(pool: Pool) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const header = authorizationHeader(req);
    if (!header) {
      return reply.code(401).send({ error: "missing or malformed Authorization header" });
    }
    const token = header.slice("Bearer ".length).trim();
    const apiPrincipal = await resolveApiKey(pool, token);
    if (apiPrincipal) {
      if (apiPrincipal.scope !== "read-only" && apiPrincipal.scope !== "admin") {
        return reply.code(403).send({ error: "api key scope does not permit this operation" });
      }
      req.principal = apiPrincipal;
      return;
    }
    return requireSession(pool)(req, reply);
  };
}

function tenantIdOf(req: FastifyRequest): string {
  return req.consolePrincipal?.tenantId ?? req.principal!.tenantId;
}

function scopedCustomerId(req: FastifyRequest): string | null {
  return req.principal?.customerId ?? null;
}

function parseLimit(raw: unknown): { error: string } | { limit: number } {
  if (raw === undefined) return { limit: DEFAULT_LIMIT };
  if (typeof raw !== "string") return { error: "limit must be a positive integer" };
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return { error: "limit must be a positive integer" };
  return { limit: Math.min(n, MAX_LIMIT) };
}

function parseOptionalTime(raw: unknown, name: string): { error: string } | { value?: string } {
  if (raw === undefined) return {};
  if (typeof raw !== "string") return { error: `${name} must be an RFC3339 timestamp` };
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return { value: `${raw}T00:00:00.000Z` };
  }
  const ts = Date.parse(raw);
  if (Number.isNaN(ts)) return { error: `${name} must be an RFC3339 timestamp` };
  return { value: new Date(ts).toISOString() };
}

function encodeCursor(occurredAt: string, key: string): string {
  const payload: TimelineCursor = { t: occurredAt, k: key };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function decodeCursor(raw: unknown): { error: string } | { cursor: TimelineCursor | null } {
  if (raw === undefined) return { cursor: null };
  if (typeof raw !== "string") return { error: "cursor is invalid" };
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as TimelineCursor;
    if (typeof parsed.t !== "string" || typeof parsed.k !== "string") return { error: "cursor is invalid" };
    return { cursor: parsed };
  } catch {
    return { error: "cursor is invalid" };
  }
}

function entryKey(entry: TimelineEntry): string {
  return `${entry.type}:${entry.id}`;
}

function cmpEntries(a: TimelineEntry, b: TimelineEntry): number {
  const at = Date.parse(a.occurred_at);
  const bt = Date.parse(b.occurred_at);
  if (bt !== at) return bt - at;
  return entryKey(b).localeCompare(entryKey(a));
}

function afterCursor(entry: TimelineEntry, cursor: TimelineCursor): boolean {
  const entryMs = Date.parse(entry.occurred_at);
  const cursorMs = Date.parse(cursor.t);
  if (entryMs < cursorMs) return true;
  if (entryMs > cursorMs) return false;
  return entryKey(entry) < cursor.k;
}

function hourEnd(hourIso: string): string {
  return new Date(Date.parse(hourIso) + 60 * 60 * 1000).toISOString();
}

function metricMatches(eventType: string, metric: string | undefined): boolean {
  if (!metric) return true;
  return eventType === metric || eventType.startsWith(`${metric}.`);
}

async function resolveTeamCustomer(
  client: PoolClient,
  rootId: string,
  team: string | undefined,
): Promise<string | null> {
  if (!team) return rootId;
  const { rows } = await client.query<{ id: string }>(
    `WITH RECURSIVE tree AS (
       SELECT id, parent_customer_id, name FROM customers WHERE id = $1
       UNION ALL
       SELECT c.id, c.parent_customer_id, c.name
       FROM customers c
       JOIN tree ON c.parent_customer_id = tree.id
     )
     SELECT id FROM tree
     WHERE id::text = $2 OR lower(name) = lower($2)
     ORDER BY id
     LIMIT 1`,
    [rootId, team],
  );
  return rows[0]?.id ?? null;
}

async function loadGrants(
  client: PoolClient,
  customerId: string,
  since?: string,
  until?: string,
): Promise<TimelineEntry[]> {
  const { rows } = await client.query<GrantLedgerRow>(
    `SELECT e.id, e.grant_id, e.entry_type, e.amount::text AS amount, e.reason, e.occurred_at
     FROM grant_ledger_entries e
     JOIN grants g ON g.id = e.grant_id
     WHERE g.customer_id = $1
       AND ($2::timestamptz IS NULL OR e.occurred_at >= $2)
       AND ($3::timestamptz IS NULL OR e.occurred_at < $3)
     ORDER BY e.occurred_at DESC, e.id DESC`,
    [customerId, since ?? null, until ?? null],
  );
  return rows.map((row) => ({
    type: "grant" as const,
    occurred_at: new Date(row.occurred_at).toISOString(),
    id: row.id,
    grant_id: row.grant_id,
    entry_type: row.entry_type,
    amount: Number(row.amount),
    reason: row.reason,
  }));
}

async function loadConfigChanges(
  client: PoolClient,
  customerId: string,
  since: string | undefined,
  until: string | undefined,
  apiKeyId: string | undefined,
): Promise<TimelineEntry[]> {
  const { rows } = await client.query<AuditRow>(
    `SELECT id::text AS id, occurred_at, event_type, object_type, object_id, actor_api_key_id, before, after
     FROM audit_log
     WHERE customer_id = $1
       AND ($2::timestamptz IS NULL OR occurred_at >= $2)
       AND ($3::timestamptz IS NULL OR occurred_at < $3)
       AND ($4::uuid IS NULL OR actor_api_key_id = $4)
     ORDER BY occurred_at DESC, id DESC`,
    [customerId, since ?? null, until ?? null, apiKeyId ?? null],
  );
  return rows.map((row) => ({
    type: "config_change" as const,
    occurred_at: new Date(row.occurred_at).toISOString(),
    id: row.id,
    event_type: row.event_type,
    object_type: row.object_type,
    object_id: row.object_id,
    actor_api_key_id: row.actor_api_key_id,
    before: row.before,
    after: row.after,
    category: "Configuration",
  }));
}

function usageBucketEntry(bucket: UsageBucket, events: UsageEvent[] | undefined): TimelineEntry {
  const hour = new Date(bucket.hour).toISOString();
  const count = Number(bucket.count);
  const entry: TimelineEntry = {
    type: "usage_bucket",
    occurred_at: hour,
    id: `${hour}|${bucket.event_type}`,
    hour,
    event_type: bucket.event_type,
    count,
    total_quantity: bucket.total_quantity,
    expandable: true,
    category: "Usage",
  };
  if (events && count <= LARGE_BUCKET_INLINE_LIMIT) {
    entry.events = events;
  }
  return entry;
}

function reservationEntry(row: ReservationRow): TimelineEntry {
  return {
    type: "reservation",
    occurred_at: new Date(row.created_at).toISOString(),
    id: row.id,
    reservation_id: row.id,
    usage_event_id: row.usage_event_id,
  };
}

function adjustmentEntry(row: AdjustmentRow, metric?: string): TimelineEntry | null {
  if (!metricMatches(row.event_type, metric)) return null;
  return {
    type: "adjustment",
    occurred_at: new Date(row.occurred_at).toISOString(),
    id: row.id,
    adjustment_id: row.id,
    event_type: row.event_type,
    quantity: row.quantity,
    status: row.status,
    reviewed_at: row.reviewed_at,
  };
}

function chargeEntry(row: LedgerTransactionRow): TimelineEntry {
  return {
    type: "charge",
    occurred_at: new Date(row.created_at).toISOString(),
    id: row.id,
    transaction_id: row.id,
    usage_event_id: row.usage_event_id,
    description: row.description,
    category: "Charges",
  };
}

export function registerTimelineRoutes(app: FastifyInstance, pool: Pool) {
  app.register(async (scoped) => {
    scoped.addHook("preHandler", requireTimelineAuth(pool));

    const urls = [
      { method: "get" as const, url: "/customers/:id/timeline" },
      { method: "get" as const, url: "/customers/:id/timeline/usage-bucket" },
      { method: "get" as const, url: "/customers/:id/timeline/charges/:transactionId" },
    ];
    for (const route of urls) {
      CONSOLE_ROUTE_AUDIT.push({ method: route.method, url: route.url, auth: { role: [...ROLES] } });
    }

    scoped.get("/customers/:id/timeline", async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!UUID_RE.test(id)) return reply.code(400).send({ error: "id must be a UUID" });
      const tenantId = tenantIdOf(req);
      const scopedId = scopedCustomerId(req);
      if (scopedId && scopedId !== id) {
        await logBlocked(pool, {
          actingTenantId: tenantId,
          endpoint: "/customers/:id/timeline",
          method: "GET",
          detail: "customer_id not visible to caller's tenant",
          resolvedAction: "blocked_customer_not_visible",
        });
        return reply.code(403).send({ error: "not found for this tenant" });
      }

      const query = req.query as Record<string, unknown>;
      const limit = parseLimit(query.limit);
      if ("error" in limit) return reply.code(400).send({ error: limit.error });
      const since = parseOptionalTime(query.since, "since");
      if ("error" in since) return reply.code(400).send({ error: since.error });
      const until = parseOptionalTime(query.until, "until");
      if ("error" in until) return reply.code(400).send({ error: until.error });
      if (since.value && until.value && since.value > until.value) {
        return reply.code(400).send({ error: "since must not be later than until" });
      }
      const cursor = decodeCursor(query.cursor);
      if ("error" in cursor) return reply.code(400).send({ error: cursor.error });
      const metric = typeof query.metric === "string" ? query.metric : undefined;
      const team = typeof query.team === "string" ? query.team : undefined;
      const apiKeyId = typeof query.api_key_id === "string" ? query.api_key_id : undefined;
      if (apiKeyId && !UUID_RE.test(apiKeyId)) return reply.code(400).send({ error: "api_key_id must be a UUID" });
      // model is accepted for AC2 compatibility; usage_events has no model column
      // so it does not narrow any entry type (see NOTES-TEID-45.md).
      if (query.model !== undefined && typeof query.model !== "string") {
        return reply.code(400).send({ error: "model must be a string" });
      }

      const authorization = authorizationHeader(req)!;
      const range = { since: since.value, until: until.value, metric };

      try {
        const local = await withTenant(pool, tenantId, async (client) => {
          if (!(await customerVisible(client, id))) return { missing: true as const };
          const sourceCustomerId = await resolveTeamCustomer(client, id, team);
          if (!sourceCustomerId) return { missing: false as const, sourceCustomerId: null, grants: [], config: [] };
          const [grants, config] = await Promise.all([
            loadGrants(client, sourceCustomerId, range.since, range.until),
            loadConfigChanges(client, sourceCustomerId, range.since, range.until, apiKeyId),
          ]);
          return { missing: false as const, sourceCustomerId, grants, config };
        });

        if (local.missing) {
          await logBlocked(pool, {
            actingTenantId: tenantId,
            endpoint: "/customers/:id/timeline",
            method: "GET",
            detail: `requested customer id ${id} not visible to this tenant`,
            resolvedAction: "blocked_customer_not_visible",
          });
          return reply.code(403).send({ error: "not found for this tenant" });
        }
        if (!local.sourceCustomerId) {
          return reply.send({ entries: [], next_cursor: null });
        }

        const sourceId = local.sourceCustomerId;
        const [buckets, reservations, charges, adjustments] = await Promise.all([
          listUsageBuckets(authorization, sourceId, { ...range, limit: 10_000 }),
          listReservations(authorization, sourceId, { ...range, limit: 500 }),
          listLedgerTransactions(authorization, sourceId, { ...range, limit: 500 }),
          listAdjustments(authorization, sourceId, { ...range, limit: 500 }),
        ]);

        const smallHours = buckets.data.filter((b) => Number(b.count) <= LARGE_BUCKET_INLINE_LIMIT);
        const inlineEvents = new Map<string, UsageEvent[]>();
        if (smallHours.length > 0 && smallHours.length <= 20) {
          await Promise.all(
            smallHours.map(async (bucket) => {
              const hour = new Date(bucket.hour).toISOString();
              const listed = await listUsageEvents(authorization, sourceId, {
                since: hour,
                until: hourEnd(hour),
                eventType: bucket.event_type,
                limit: LARGE_BUCKET_INLINE_LIMIT,
              });
              inlineEvents.set(`${hour}|${bucket.event_type}`, listed.data);
            }),
          );
        }

        const entries: TimelineEntry[] = [
          ...local.grants,
          ...local.config,
          ...buckets.data.map((bucket) => {
            const hour = new Date(bucket.hour).toISOString();
            return usageBucketEntry(bucket, inlineEvents.get(`${hour}|${bucket.event_type}`));
          }),
          ...reservations.data.map(reservationEntry),
          ...adjustments.data.map((row) => adjustmentEntry(row, metric)).filter((row): row is TimelineEntry => row !== null),
          ...charges.data.map(chargeEntry),
        ];

        entries.sort(cmpEntries);
        const filtered = cursor.cursor ? entries.filter((entry) => afterCursor(entry, cursor.cursor!)) : entries;
        const page = filtered.slice(0, limit.limit + 1);
        const hasMore = page.length > limit.limit;
        const visible = hasMore ? page.slice(0, limit.limit) : page;
        const nextCursor =
          hasMore && visible.length > 0
            ? encodeCursor(visible[visible.length - 1].occurred_at, entryKey(visible[visible.length - 1]))
            : null;
        return reply.send({ entries: visible, next_cursor: nextCursor });
      } catch (err) {
        if (err instanceof GoUsageError) {
          if (err.statusCode === 401 || err.statusCode === 403) {
            return reply.code(err.statusCode).send(err.body ?? { error: "not found for this tenant" });
          }
          return reply.code(502).send({ error: "usage service request failed" });
        }
        if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
          return reply.code(504).send({ error: "usage service request timed out" });
        }
        throw err;
      }
    });

    scoped.get("/customers/:id/timeline/usage-bucket", async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!UUID_RE.test(id)) return reply.code(400).send({ error: "id must be a UUID" });
      const query = req.query as { hour?: unknown; event_type?: unknown; cursor?: unknown; limit?: unknown };
      if (typeof query.hour !== "string") return reply.code(400).send({ error: "hour is required" });
      const hour = parseOptionalTime(query.hour, "hour");
      if ("error" in hour) return reply.code(400).send({ error: hour.error });
      if (!hour.value) return reply.code(400).send({ error: "hour is required" });
      if (typeof query.event_type !== "string" || query.event_type.length === 0) {
        return reply.code(400).send({ error: "event_type is required" });
      }
      const limit = parseLimit(query.limit);
      if ("error" in limit) return reply.code(400).send({ error: limit.error });
      const tenantId = tenantIdOf(req);
      const scopedId = scopedCustomerId(req);
      if (scopedId && scopedId !== id) {
        await logBlocked(pool, {
          actingTenantId: tenantId,
          endpoint: "/customers/:id/timeline/usage-bucket",
          method: "GET",
          detail: "customer_id not visible to caller's tenant",
          resolvedAction: "blocked_customer_not_visible",
        });
        return reply.code(403).send({ error: "not found for this tenant" });
      }

      const visible = await withTenant(pool, tenantId, (client) => customerVisible(client, id));
      if (!visible) {
        await logBlocked(pool, {
          actingTenantId: tenantId,
          endpoint: "/customers/:id/timeline/usage-bucket",
          method: "GET",
          detail: `requested customer id ${id} not visible to this tenant`,
          resolvedAction: "blocked_customer_not_visible",
        });
        return reply.code(403).send({ error: "not found for this tenant" });
      }

      try {
        const listed = await listUsageEvents(authorizationHeader(req)!, id, {
          since: hour.value,
          until: hourEnd(hour.value),
          eventType: query.event_type,
          limit: limit.limit,
          cursor: typeof query.cursor === "string" ? query.cursor : undefined,
        });
        const events = listed.data.filter((event) => event.event_type === query.event_type);
        return reply.send({
          hour: new Date(hour.value).toISOString(),
          event_type: query.event_type,
          events,
          next_cursor: listed.cursor,
        });
      } catch (err) {
        if (err instanceof GoUsageError) {
          return reply.code(502).send({ error: "usage service request failed" });
        }
        throw err;
      }
    });

    scoped.get("/customers/:id/timeline/charges/:transactionId", async (req, reply) => {
      const { id, transactionId } = req.params as { id: string; transactionId: string };
      if (!UUID_RE.test(id) || !UUID_RE.test(transactionId)) {
        return reply.code(400).send({ error: "id must be a UUID" });
      }
      const tenantId = tenantIdOf(req);
      const scopedId = scopedCustomerId(req);
      if (scopedId && scopedId !== id) {
        await logBlocked(pool, {
          actingTenantId: tenantId,
          endpoint: "/customers/:id/timeline/charges/:transactionId",
          method: "GET",
          detail: "customer_id not visible to caller's tenant",
          resolvedAction: "blocked_customer_not_visible",
        });
        return reply.code(403).send({ error: "not found for this tenant" });
      }
      const visible = await withTenant(pool, tenantId, (client) => customerVisible(client, id));
      if (!visible) {
        await logBlocked(pool, {
          actingTenantId: tenantId,
          endpoint: "/customers/:id/timeline/charges/:transactionId",
          method: "GET",
          detail: `requested customer id ${id} not visible to this tenant`,
          resolvedAction: "blocked_customer_not_visible",
        });
        return reply.code(403).send({ error: "not found for this tenant" });
      }

      const { status, body } = await getLedgerTransactionDetail(authorizationHeader(req)!, transactionId);
      if (status === 403 || status === 404) {
        return reply.code(status).send(body ?? { error: "not found for this tenant" });
      }
      if (status !== 200 || typeof body !== "object" || body === null) {
        return reply.code(502).send({ error: "usage service request failed" });
      }
      const detail = body as { customer_id?: unknown };
      if (detail.customer_id !== id) {
        await logBlocked(pool, {
          actingTenantId: tenantId,
          endpoint: "/customers/:id/timeline/charges/:transactionId",
          method: "GET",
          detail: "customer_id not visible to caller's tenant",
          resolvedAction: "blocked_customer_not_visible",
        });
        return reply.code(403).send({ error: "not found for this tenant" });
      }
      return reply.send(body);
    });
  });
}
