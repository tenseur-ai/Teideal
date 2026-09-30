import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { evaluateBalanceAlerts } from "../../services/ts-console/src/lib/balanceAlertWorker.js";
import { checkExpiringSoonGrants } from "../../services/ts-console/src/lib/grantWorker.js";
import { evaluateWebhookRetries } from "../../services/ts-console/src/lib/webhookDeliveryWorker.js";
import {
  emitWebhookEvent,
  RETRY_DELAYS_MS,
  signBody,
  verifyWebhookSignature,
} from "../../services/ts-console/src/lib/webhooks.js";
import { pool, withTenant } from "./db.js";
import { FAKE_WEBHOOK_URL, TS_CONSOLE_URL } from "./env.js";
import {
  type CapturedWebhookRequest,
  startFakeWebhookReceiver,
  stopFakeWebhookReceiver,
} from "./fake-webhook-receiver.js";
import { call } from "./http.js";
import { opsSession, TENANT_ID } from "./session.js";

const NOW = new Date("2026-09-30T09:00:00.000Z");
const GRANT_START = "2026-09-01T00:00:00.000Z";

let opsToken: string;

interface Endpoint {
  id: string;
  secret: string;
}

interface StoredDelivery {
  id: string;
  event_id: string;
  status: "pending" | "sent" | "exhausted";
  attempt_count: number;
  first_attempted_at: Date;
}

beforeAll(async () => {
  await startFakeWebhookReceiver();
  opsToken = await opsSession();
  // Claim any crossings left by earlier suites before a webhook endpoint
  // exists, so each cataloged test observes only the grant it creates.
  await withTenant(TENANT_ID, (client) =>
    client.query(`DELETE FROM webhook_endpoints WHERE tenant_id = $1`, [TENANT_ID]),
  );
  await evaluateBalanceAlerts(pool, NOW);
});

afterAll(async () => {
  await stopFakeWebhookReceiver();
  await pool.end();
});

beforeEach(async () => {
  await fetch(`${FAKE_WEBHOOK_URL}/_reset`, { method: "POST" });
  await withTenant(TENANT_ID, (client) =>
    client.query(`DELETE FROM webhook_endpoints WHERE tenant_id = $1`, [TENANT_ID]),
  );
});

async function setReceiverMode(mode: { failure_count?: number; persistent_failure?: boolean }): Promise<void> {
  const response = await fetch(`${FAKE_WEBHOOK_URL}/_mode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(mode),
  });
  expect(response.status).toBe(200);
}

async function capturedRequests(): Promise<CapturedWebhookRequest[]> {
  const response = await fetch(`${FAKE_WEBHOOK_URL}/_requests`);
  return ((await response.json()) as { requests: CapturedWebhookRequest[] }).requests;
}

function header(request: CapturedWebhookRequest, name: string): string {
  const value = request.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

async function createEndpoint(events: string[]): Promise<Endpoint> {
  const response = await call(`${TS_CONSOLE_URL}/webhook-endpoints`, {
    method: "POST",
    token: opsToken,
    body: { url: `${FAKE_WEBHOOK_URL}/webhook`, subscribed_events: events },
  });
  expect(response.status).toBe(201);
  expect(response.body.secret).toMatch(/^[0-9a-f]{64}$/);
  return response.body as Endpoint;
}

async function createCustomer(marker: string): Promise<string> {
  return withTenant(TENANT_ID, async (client) =>
    (await client.query<{ id: string }>(
      `INSERT INTO customers (tenant_id, name, email) VALUES ($1, $2, $3) RETURNING id`,
      [TENANT_ID, marker, `${marker}-${randomUUID()}@webhooks.test`],
    )).rows[0].id,
  );
}

async function createGrant(customerId: string, amount = 1000, expiryDate?: string): Promise<string> {
  const response = await call(`${TS_CONSOLE_URL}/grants`, {
    method: "POST",
    token: opsToken,
    body: {
      customer_id: customerId,
      unit: "USD",
      source: "commit",
      amount,
      start_date: GRANT_START,
      ...(expiryDate ? { expiry_date: expiryDate } : {}),
      drawdown_schedule: "upfront",
      overage_rate: 0,
    },
  });
  expect(response.status).toBe(201);
  return response.body.id as string;
}

async function consumeGrant(grantId: string, amount: number): Promise<void> {
  const response = await call(`${TS_CONSOLE_URL}/grants/${grantId}/consume`, {
    method: "POST",
    token: opsToken,
    body: { amount, as_of: NOW.toISOString() },
  });
  expect(response.status).toBe(200);
}

async function triggerThreshold(percentUsed: number): Promise<string> {
  const customerId = await createCustomer(`teid-48-${randomUUID()}`);
  const grantId = await createGrant(customerId);
  await consumeGrant(grantId, percentUsed * 10);
  await evaluateBalanceAlerts(pool, NOW);
  return grantId;
}

async function deliveryForGrant(grantId: string, eventType: string): Promise<StoredDelivery> {
  return withTenant(TENANT_ID, async (client) =>
    (await client.query<StoredDelivery>(
      `SELECT d.id, e.id AS event_id, d.status, d.attempt_count, d.first_attempted_at
       FROM webhook_deliveries d
       JOIN webhook_events e ON e.id = d.webhook_event_id
       WHERE d.tenant_id = $1 AND e.event_type = $2 AND e.payload->>'grant_id' = $3
       ORDER BY d.created_at DESC LIMIT 1`,
      [TENANT_ID, eventType, grantId],
    )).rows[0],
  );
}

async function attempts(deliveryId: string): Promise<Array<{
  attempt_number: number;
  outcome: string;
  attempted_at: Date;
}>> {
  return withTenant(TENANT_ID, async (client) =>
    (await client.query(
      `SELECT attempt_number, outcome, attempted_at
       FROM webhook_delivery_attempts
       WHERE tenant_id = $1 AND webhook_delivery_id = $2
       ORDER BY attempt_number`,
      [TENANT_ID, deliveryId],
    )).rows,
  );
}

describe("TEID-48 billing webhooks", () => {
  // TEID-48-T1 (Functional): the actual balance-depleted trigger reaches a
  // receiver and its signature validates against the configured secret.
  it("TEID-48-T1 signs a balance-depleted delivery over its exact raw body", async () => {
    const endpoint = await createEndpoint(["balance.depleted"]);
    const grantId = await triggerThreshold(100);

    const requests = await capturedRequests();
    const request = requests.find((item) => JSON.parse(item.body).grant_id === grantId);
    expect(request).toBeDefined();
    expect(header(request!, "x-teideal-event-type")).toBe("balance.depleted");
    expect(JSON.parse(request!.body).grant_id).toBe(grantId);
    expect(verifyWebhookSignature(request!.body, header(request!, "x-teideal-signature"), endpoint.secret)).toBe(true);
  });

  // TEID-48-T2 (Functional): six failures are retried at increasing absolute
  // offsets from the first attempt and the seventh request succeeds at +24h.
  it("TEID-48-T2 retries threshold.reached through the 24-hour offset", async () => {
    await setReceiverMode({ failure_count: 6 });
    await createEndpoint(["threshold.reached"]);
    const grantId = await triggerThreshold(50);
    const delivery = await deliveryForGrant(grantId, "threshold.reached");
    const first = delivery.first_attempted_at;

    for (const offset of RETRY_DELAYS_MS) {
      await evaluateWebhookRetries(pool, new Date(first.getTime() + offset));
    }

    const logged = await attempts(delivery.id);
    expect(logged).toHaveLength(7);
    expect(logged.map((row) => row.outcome)).toEqual([
      "failed", "failed", "failed", "failed", "failed", "failed", "sent",
    ]);
    expect(logged.slice(1).map((row) => row.attempted_at.getTime() - first.getTime())).toEqual([...RETRY_DELAYS_MS]);
    const gaps = logged.slice(1).map((row, index) => row.attempted_at.getTime() - logged[index].attempted_at.getTime());
    expect(gaps.every((gap, index) => index === 0 || gap > gaps[index - 1])).toBe(true);
    expect((await deliveryForGrant(grantId, "threshold.reached")).status).toBe("sent");
  });

  // TEID-48-T3 (Functional): the real advance-expiry check creates a visible
  // attempt log and a manual resend appends a second immutable attempt.
  it("TEID-48-T3 logs and manually resends grant.expiring_soon", async () => {
    await createEndpoint(["grant.expiring_soon"]);
    const customerId = await createCustomer(`teid-48-t3-${randomUUID()}`);
    const grantId = await createGrant(customerId, 1000, "2026-10-03T00:00:00.000Z");
    await checkExpiringSoonGrants(pool, NOW);
    const stored = await deliveryForGrant(grantId, "grant.expiring_soon");

    const listed = await call(`${TS_CONSOLE_URL}/webhook-deliveries?event_type=grant.expiring_soon&limit=500`, { token: opsToken });
    expect(listed.status).toBe(200);
    expect(listed.body.data.some((row: { id: string }) => row.id === stored.id)).toBe(true);
    const detail = await call(`${TS_CONSOLE_URL}/webhook-deliveries/${stored.id}`, { token: opsToken });
    expect(detail.status).toBe(200);
    expect(detail.body.attempts).toHaveLength(1);
    expect(detail.body.attempts[0]).toMatchObject({ attempt_number: 1, outcome: "sent", http_status: 200 });
    expect(detail.body.attempts[0].attempted_at).toEqual(expect.any(String));
    const receiverRequests = await capturedRequests();
    const receiverRequest = receiverRequests.find((request) =>
      header(request, "x-teideal-event-id") === stored.event_id);
    expect(receiverRequest).toBeDefined();
    expect(detail.body.attempts[0].response_body).toBe(receiverRequest!.responseBody);

    const resent = await call(`${TS_CONSOLE_URL}/webhook-deliveries/${stored.id}/resend`, {
      method: "POST", token: opsToken,
    });
    expect(resent.status).toBe(200);
    expect(resent.body.attempts).toHaveLength(2);
  });

  // TEID-48-T4 (Functional): reservation.overrun has no fake detector; the
  // documented synthetic emitter substitution proves retry ID stability.
  it("TEID-48-T4 preserves a reservation.overrun event ID across retry", async () => {
    await setReceiverMode({ failure_count: 1 });
    await createEndpoint(["reservation.overrun"]);
    const dedupKey = `reservation-overrun:${randomUUID()}`;
    await emitWebhookEvent(pool, TENANT_ID, "reservation.overrun", dedupKey, {
      reservation_id: randomUUID(), reserved: 10, used: 12,
    });
    const stored = await withTenant(TENANT_ID, async (client) =>
      (await client.query<StoredDelivery>(
        `SELECT d.id, e.id AS event_id, d.status, d.attempt_count, d.first_attempted_at
         FROM webhook_events e JOIN webhook_deliveries d ON d.webhook_event_id = e.id
         WHERE e.tenant_id = $1 AND e.dedup_key = $2`,
        [TENANT_ID, dedupKey],
      )).rows[0],
    );
    await evaluateWebhookRetries(pool, new Date(stored.first_attempted_at.getTime() + RETRY_DELAYS_MS[0]));

    const requests = await capturedRequests();
    expect(requests).toHaveLength(2);
    expect(requests.map((request) => header(request, "x-teideal-event-id"))).toEqual([
      stored.event_id, stored.event_id,
    ]);
  });

  // TEID-48-T5 (Non-functional): persistent receiver failure exhausts after
  // the +24h attempt, and later worker ticks cannot create an eighth attempt.
  it("TEID-48-T5 exhausts a persistently failing delivery after 24 hours", async () => {
    await setReceiverMode({ persistent_failure: true });
    await createEndpoint(["threshold.reached"]);
    const grantId = await triggerThreshold(50);
    const delivery = await deliveryForGrant(grantId, "threshold.reached");
    const first = delivery.first_attempted_at;
    for (const offset of RETRY_DELAYS_MS) {
      await evaluateWebhookRetries(pool, new Date(first.getTime() + offset));
    }

    const exhausted = await deliveryForGrant(grantId, "threshold.reached");
    expect(exhausted.status).toBe("exhausted");
    expect(exhausted.attempt_count).toBe(7);
    expect(await attempts(delivery.id)).toHaveLength(7);
    await evaluateWebhookRetries(pool, new Date(first.getTime() + 48 * 3_600_000));
    expect(await attempts(delivery.id)).toHaveLength(7);
  });

  // TEID-48-T6 (Non-functional): set-based fixtures exercise filtering and
  // cursor paging across a full 1,000-delivery log without duplicates/gaps.
  it("TEID-48-T6 filters and paginates 1,000 deliveries responsively", async () => {
    const endpoint = await createEndpoint([]);
    const marker = randomUUID();
    await withTenant(TENANT_ID, (client) =>
      client.query(
        `WITH inserted AS (
           INSERT INTO webhook_events (tenant_id, event_type, dedup_key, payload, raw_body)
           SELECT $1,
                  CASE gs % 3 WHEN 0 THEN 'threshold.reached'
                              WHEN 1 THEN 'grant.expired'
                              ELSE 'reconciliation.mismatch' END,
                  $2 || ':' || gs::text,
                  jsonb_build_object('marker', $2, 'ordinal', gs),
                  jsonb_build_object('marker', $2, 'ordinal', gs)::text
           FROM generate_series(1, 1000) AS gs
           RETURNING id, tenant_id, event_type, (payload->>'ordinal')::int AS ordinal
         )
         INSERT INTO webhook_deliveries (
           tenant_id, webhook_event_id, webhook_endpoint_id, status, attempt_count
         )
         SELECT tenant_id, id, $3,
                CASE ordinal % 3 WHEN 0 THEN 'sent' WHEN 1 THEN 'pending' ELSE 'exhausted' END,
                CASE ordinal % 3 WHEN 1 THEN 1 ELSE 0 END
         FROM inserted`,
        [TENANT_ID, marker, endpoint.id],
      ),
    );

    const started = performance.now();
    const filtered = await call(
      `${TS_CONSOLE_URL}/webhook-deliveries?event_type=threshold.reached&status=sent&limit=50`,
      { token: opsToken },
    );
    const differentlyFiltered = await call(
      `${TS_CONSOLE_URL}/webhook-deliveries?event_type=grant.expired&status=pending&limit=50`,
      { token: opsToken },
    );
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(filtered.status).toBe(200);
    expect(filtered.body.data.length).toBeGreaterThan(0);
    expect(filtered.body.data.every((row: { event_type: string; status: string }) =>
      row.event_type === "threshold.reached" && row.status === "sent")).toBe(true);
    expect(differentlyFiltered.body.data.every((row: { event_type: string; status: string }) =>
      row.event_type === "grant.expired" && row.status === "pending")).toBe(true);

    const ids = new Set<string>();
    let cursor: string | null = null;
    do {
      const page = await call(
        `${TS_CONSOLE_URL}/webhook-deliveries?limit=50${cursor ? `&cursor=${cursor}` : ""}`,
        { token: opsToken },
      );
      expect(page.status).toBe(200);
      for (const row of page.body.data as Array<{ id: string }>) {
        expect(ids.has(row.id)).toBe(false);
        ids.add(row.id);
      }
      cursor = page.body.next_cursor;
    } while (cursor);
    expect(ids.size).toBe(1000);
  });

  // TEID-48-T7 (Adversarial): wrong, missing, and body-mismatched signatures
  // all fail the same receiver-side verifier.
  it("TEID-48-T7 rejects forged and tampered signatures", () => {
    const secret = randomUUID();
    const rawBody = JSON.stringify({ amount: 100, event: "balance.depleted" });
    const realSignature = signBody(secret, rawBody);
    expect(verifyWebhookSignature(rawBody, "", secret)).toBe(false);
    expect(verifyWebhookSignature(rawBody, `sha256=${"0".repeat(64)}`, secret)).toBe(false);
    expect(verifyWebhookSignature(`${rawBody} `, realSignature, secret)).toBe(false);
  });

  // TEID-48-T8 (Adversarial): five deliberate manual resends retain the
  // original receiver-facing event ID on all six requests.
  it("TEID-48-T8 keeps one event ID through five rapid manual resends", async () => {
    await createEndpoint(["threshold.reached"]);
    const grantId = await triggerThreshold(50);
    const delivery = await deliveryForGrant(grantId, "threshold.reached");
    for (let index = 0; index < 5; index += 1) {
      const response = await call(`${TS_CONSOLE_URL}/webhook-deliveries/${delivery.id}/resend`, {
        method: "POST", token: opsToken,
      });
      expect(response.status).toBe(200);
    }
    const requests = await capturedRequests();
    expect(requests).toHaveLength(6);
    expect(new Set(requests.map((request) => header(request, "x-teideal-event-id")))).toEqual(
      new Set([delivery.event_id]),
    );
  });
});
