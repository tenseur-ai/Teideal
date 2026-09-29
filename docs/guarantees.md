# Service guarantees and their verification

## Exactly-once ingestion

For a tenant, an idempotency key identifies one logical usage event. Retrying
identical content returns the original event as `duplicate`; reusing the key
for different content returns `409` and records a reviewable conflict. The
database unique constraint is the final concurrency boundary.

Verified by `tests/idempotency/idempotency.test.ts` (the TEID-31 duplicate,
conflict, retention, and concurrent-insert suite) and
`tests/usage-ingestion/functional-adversarial.test.ts` (the ingestion
idempotency-key and durability cases).

## Ordering

Usage events preserve their caller-supplied occurrence time. Replay-sensitive
consumption is deterministic because the replay engine sorts by
`(occurred_at, id)` before applying draws, independent of arrival order.

Verified by `tests/replay-consistency/replay-consistency.test.ts` (the TEID-35
same-result-regardless-of-arrival-order suite) and
`tests/consumption-order/consumption-order.test.ts` (source precedence and
stable draw ordering).

## Degraded mode

The core HTTP services reject an unavailable dependency rather than claiming
an event was stored. The TypeScript SDK journals events as append-only NDJSON,
and the Python SDK buffers them in SQLite, before transmission; queued events
survive client restart and flush after connectivity returns.

Verified end to end by `tests/sdk-integration/sdk-integration.test.ts` (offline
buffering, restart recovery, and retry behavior), with package-level behavior
covered by `sdks/typescript/test/client.test.ts` and
`sdks/python/tests/test_client.py`.

