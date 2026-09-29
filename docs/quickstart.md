# Teideal quick-start

This guide takes a newly provisioned developer from account access to an API
key, a plan-rate calculation, a durable usage event, and a read-back check.
The runnable walkthrough is the same program CI executes; no hidden setup is
added by the test.

## 1. Sign up or provision a local account

Hosted Teideal accounts are currently provisioned by an operator; there is no
public sign-up API in this release. Ask for a Developer user and your tenant
key. For this repository's local stack, the equivalent one-time provisioning
commands are:

```bash
PSQL_SUPERUSER=postgres bash db/setup-local.sh
PSQL_SUPERUSER=postgres bash db/seed-test-fixtures.sh
PSQL_SUPERUSER=postgres bash db/seed-console-auth-fixtures.sh
```

Start `ts-console` on port 8081 and `go-usage` on port 8082 as described in
the repository README/CI workflow. The local Developer credentials are
`acct_1001`, `developer@acmeco.com`, and `DeveloperPass123!`; they are test
fixtures only and must never be used outside a disposable local environment.

## 2. Run the end-to-end walkthrough

Node 22 or newer is the only client prerequisite. Save the following block as
`quickstart.mjs` and run `node quickstart.mjs`. Set `TS_CONSOLE_URL` and
`GO_USAGE_URL` if the services are not on their default local addresses.

```javascript runnable
const consoleUrl = process.env.TS_CONSOLE_URL ?? "http://127.0.0.1:8081";
const usageUrl = process.env.GO_USAGE_URL ?? "http://127.0.0.1:8082";
const customerId = "00000000-0000-0000-0000-0000000c1001";

async function request(url, { method = "GET", token, body, expected = [200] } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await response.json();
  if (!expected.includes(response.status)) {
    throw new Error(`${method} ${url} returned ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

const login = await request(`${consoleUrl}/auth/login`, {
  method: "POST",
  body: {
    tenant_key: "acct_1001",
    email: "developer@acmeco.com",
    password: "DeveloperPass123!",
  },
});
if (login.status !== "authenticated") throw new Error("Developer login unexpectedly requires MFA");

const createdKey = await request(`${consoleUrl}/api-keys`, {
  method: "POST",
  token: login.session_token,
  body: { scope: "admin", environment: "sandbox", label: `quickstart-${Date.now()}` },
  expected: [201],
});

const priced = await request(`${usageUrl}/money/price`, {
  method: "POST",
  token: createdKey.key,
  body: { currency: "USD", quantity: "2500", unit_price: "0.0008" },
});
if (priced.invoice_amount !== "2.00") throw new Error(`Unexpected rate result: ${JSON.stringify(priced)}`);

const idempotencyKey = `quickstart-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const event = await request(`${usageUrl}/usage`, {
  method: "POST",
  token: createdKey.key,
  body: { customer_id: customerId, event_type: "api.request", quantity: 1, idempotency_key: idempotencyKey },
  expected: [201],
});

const readBack = await request(`${usageUrl}/usage?customer_id=${customerId}`, { token: createdKey.key });
if (!readBack.data.some((item) => item.id === event.id && item.idempotency_key === idempotencyKey)) {
  throw new Error("The accepted event was not queryable by id and idempotency key");
}

console.log(JSON.stringify({ api_key: createdKey.display_hint, rate: priced, event_id: event.id }, null, 2));
```

Expected output contains a masked key, an exact decimal rate result, and the
new event ID:

```json
{
  "api_key": "sk_test_****abcd",
  "rate": { "line_amount": "2", "invoice_amount": "2.00" },
  "event_id": "<uuid>"
}
```

## 3. Production checklist

- Replace the local fixture credentials and customer ID with provisioned
  values; do not embed credentials or plaintext API keys in source control.
- Use a least-privilege `ingest-only` key for event writers and a separate
  `read-only` key for reporting. The single `admin` key above keeps the first
  walkthrough short.
- Persist a unique idempotency key for every logical event and reuse that key
  only when retrying the identical event.
- Use the TypeScript or Python SDK when the client must buffer during network
  failure; both SDKs implement durable local queues.

