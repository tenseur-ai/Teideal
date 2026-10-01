# TEID-48 implementation notes

The specification says not to document `POST /internal/webhook-events`, but
`docs/api/check-coverage.ts` previously treated every registered Fastify route
as public and had no internal-route exclusion. Leaving it unchanged would make
the required documentation coverage test demand the exact documentation the
specification prohibits.

The conservative resolution is to exclude the existing `/internal/*`
namespace from the public API coverage inventory. All seven new tenant-facing
routes remain covered and documented in `docs/api/webhooks.md`; only the
admin-key-gated service-to-service endpoint is omitted.

The retry test contract also advances a supplied logical `now` through the six
retry offsets and checks recorded attempt timestamps. `attemptDelivery` accepts
an optional attempt instant (defaulting to the real current time), and
`evaluateWebhookRetries` passes its supplied `now`. Production and manual
resend behavior remain real-time, while deterministic worker tests record the
logical scheduler instant.
