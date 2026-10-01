# TEID-59 implementation notes

## Scope

TEID-59-T5 is intentionally not implemented. It covers Phase-2 entitlement,
reserve, settle, and degraded-cache behavior whose service endpoints and
TEID-27 contract do not exist yet. The implemented catalog is T1-T4 and T6-T9.

## Conservative resolutions

The specification says `send_event` returns after retries are exhausted, but
does not give a failure-shaped `SendResult`; it also defines the best-effort
variant as catching network and non-2xx exceptions. The SDKs therefore raise
or reject with `TeidealError` after retry exhaustion, while retaining the
durable event for automatic flush. The best-effort methods catch and log that
error as required.

The retry section names 400, 403, and 409 as terminal, while saying the only
retryable HTTP outcomes are 5xx. The service can also produce other 4xx
responses (notably 401). Both SDKs conservatively treat every 4xx response as
terminal and never retry it; 400/403/409 retain their specifically documented
behavior.

The T4 guidance requires changing an offline client's endpoint to the restored
service, but the constructor surface does not define a separate endpoint
setter. `base_url` / `baseUrl` is therefore writable, while credentials and
buffer configuration remain fixed.

## Test map

- T1-T4, T6, and T8: `tests/sdk-integration/sdk-integration.test.ts`
- T2, T7, and T9 package-level behavior: `sdks/python/tests/test_client.py`
  and `sdks/typescript/test/client.test.ts`
- T2 network-failure test double: `tests/sdk-integration/flaky-proxy.ts`

T2 is covered at both levels: deterministic mocked HTTP in each package and a
real `go-usage` path through the flaky proxy in the integration suite.
