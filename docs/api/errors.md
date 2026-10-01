# Errors and reason values

All JSON failures use `{"error":"human-readable message"}` unless a route
documents a richer body. The message is descriptive rather than a stable
machine identifier; clients must branch on the HTTP status and, where present,
the documented `status` or `reason` value.

| HTTP status | Meaning |
|---|---|
| `400 Bad Request` | Malformed JSON, a missing field, or field validation failure. |
| `401 Unauthorized` | Missing/invalid API key or session, invalid login/MFA, or expired pending login. |
| `403 Forbidden` | Valid principal with insufficient scope/role, or a tenant-hidden object. |
| `404 Not Found` | No visible resource or configuration matches the request. |
| `405 Method Not Allowed` | The target resource is append-only and rejects this method (for example, editing or deleting an audit log entry). |
| `409 Conflict` | State transition, uniqueness, balance, publication, or idempotency conflict. |
| `410 Gone` | A retired path; the JSON body includes `see` with its replacement. |
| `423 Locked` | Password login is temporarily locked after repeated failures. |
| `502 Bad Gateway` | Stripe or an export object store rejected/failed an upstream request. |
| `504 Gateway Timeout` | The Google identity provider timed out. |
| `500 Internal Server Error` | An unexpected storage or processing failure. |

API-key failures may say `missing bearer token`, `invalid api key`, `api key is
revoked or expired`, or `api key scope does not permit this operation`.
Console-session failures may say `missing bearer token`, `invalid or expired
session`, or `this action requires role ...`.

## Usage batch status and reason values

`POST /usage` with an array always returns `207` once the array itself is
valid. Each result has one of these stable `status` values:

- `created`: a new event was stored.
- `duplicate`: the same idempotency key and event content was acknowledged.
- `conflict`: the idempotency key already belongs to different event content;
  `reason` is `idempotency key already used with different event content`.
- `queued_for_review`: a closed-period event became a pending adjustment.
- `error`: the item failed. `reason` is one of `invalid event payload`,
  `customer_id must be a UUID`,
  `event_type must match ^[A-Za-z0-9_.:-]{1,128}$`,
  `quantity must be a non-negative number`,
  `quantity must not exceed 1000000000000 (one trillion)`,
  `idempotency_key is required`,
  `occurred_at must be an RFC3339 timestamp with an explicit UTC offset or Z`,
  `actual_cost must be a non-negative number less than 1000000`,
  `customer not found for this tenant`, or
  `failed to record usage event`.

