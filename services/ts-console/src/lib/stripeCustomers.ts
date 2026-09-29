// TEID-38: Stripe Customers API (list + create). Connect token handling
// stays in stripeConnect.ts; this module is the HTTP surface for /v1/customers.
import { assertWriteScope, loadStripeEnv, StripeScopeError } from "./stripeConnect.js";

const DEFAULT_API_BASE_URL = "https://api.stripe.com";
const PAGE_SIZE = 100;

export class StripeApiError extends Error {
  readonly statusCode = 502;
  constructor(message: string) {
    super(message);
    this.name = "StripeApiError";
  }
}

export interface StripeCustomer {
  id: string;
  name: string | null;
  email: string | null;
}

export function stripeApiBaseUrl(): string {
  return (process.env.STRIPE_API_BASE_URL ?? DEFAULT_API_BASE_URL).replace(/\/+$/, "");
}

function parseCustomer(value: unknown): StripeCustomer | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as { id?: unknown; name?: unknown; email?: unknown };
  if (typeof row.id !== "string" || row.id.length === 0) return null;
  return {
    id: row.id,
    name: typeof row.name === "string" ? row.name : null,
    email: typeof row.email === "string" ? row.email : null,
  };
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function listStripeCustomers(
  accessToken: string,
  opts: { email?: string } = {},
): Promise<StripeCustomer[]> {
  loadStripeEnv();
  const base = stripeApiBaseUrl();
  const out: StripeCustomer[] = [];
  let startingAfter: string | undefined;
  for (;;) {
    const url = new URL(`${base}/v1/customers`);
    url.searchParams.set("limit", String(PAGE_SIZE));
    if (opts.email) url.searchParams.set("email", opts.email);
    if (startingAfter) url.searchParams.set("starting_after", startingAfter);
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const payload = await readJson(response);
    if (!response.ok) {
      throw new StripeApiError("stripe list customers failed");
    }
    const body = payload as { data?: unknown; has_more?: unknown } | null;
    const data = Array.isArray(body?.data) ? body.data : [];
    for (const row of data) {
      const customer = parseCustomer(row);
      if (customer) out.push(customer);
    }
    if (body?.has_more !== true || data.length === 0) break;
    const last = parseCustomer(data[data.length - 1]);
    if (!last) break;
    startingAfter = last.id;
  }
  return out;
}

export async function createStripeCustomer(
  accessToken: string,
  customer: { name: string; email: string },
  connection: { scope: string },
): Promise<StripeCustomer> {
  loadStripeEnv();
  assertWriteScope(connection);
  const response = await fetch(`${stripeApiBaseUrl()}/v1/customers`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ name: customer.name, email: customer.email }),
  });
  const payload = await readJson(response);
  if (response.status === 403) {
    throw new StripeScopeError();
  }
  if (!response.ok) {
    throw new StripeApiError("stripe create customer failed");
  }
  const created = parseCustomer(payload);
  if (!created) throw new StripeApiError("stripe create customer returned no id");
  return created;
}
