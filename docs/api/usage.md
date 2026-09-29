# Usage ingestion, queries, idempotency conflicts, and adjustments

These `go-usage` routes use API keys. Exact batch item status/reason values are
listed in [errors.md](errors.md).

## GET /usage [go-usage]

- **Auth:** `read-only` or `admin` API key.
- **Request:** Optional UUID `customer_id` and boolean `prior_period_adjustments` query filters.
- **Response:** `200 {data:[{id,customer_id,event_type,quantity,idempotency_key,occurred_at,is_prior_period_adjustment}]}`; at most 200.
- **Errors:** `400` invalid filters; `401/403` invalid key/scope; `500` query failure.

```bash
curl "$GO_USAGE_URL/usage?customer_id=$CUSTOMER_ID" -H "authorization: Bearer $API_KEY"
```

## GET /usage/summary [go-usage]

- **Auth:** `read-only` or `admin` API key.
- **Request:** Optional UUID `customer_id`.
- **Response:** `200 {event_count,total_quantity}` using exact decimal aggregation.
- **Errors:** `400` invalid UUID; `401/403` invalid key/scope; `500` aggregation failure.

```bash
curl "$GO_USAGE_URL/usage/summary?customer_id=$CUSTOMER_ID" -H "authorization: Bearer $API_KEY"
```

## POST /usage [go-usage]

- **Auth:** `ingest-only` or `admin` API key.
- **Request:** One event or an array (1–1000). Event fields: UUID `customer_id`, constrained `event_type`, exact non-negative `quantity` up to one trillion, `idempotency_key`, optional RFC3339 `occurred_at` with explicit offset.
- **Response:** Single: `201` created, `200 status=duplicate`, `202 status=queued_for_review`, or `409` content conflict. Batch: `207 {results}` with per-item status/reason.
- **Errors:** `400` malformed/invalid request or batch size; `401/403` invalid key/scope/customer; `409` idempotency conflict; `500` storage failure. See [reason values](errors.md#usage-batch-status-and-reason-values).

```bash
curl -X POST "$GO_USAGE_URL/usage" -H "authorization: Bearer $API_KEY" -H 'content-type: application/json' -d '{"customer_id":"'$CUSTOMER_ID'","event_type":"api.request","quantity":1,"idempotency_key":"example-001"}'
```

## GET /idempotency-conflicts [go-usage]

- **Auth:** `admin` API key.
- **Request:** Optional UUID `customer_id`.
- **Response:** `200 {data}` conflict-review records.
- **Errors:** `400` invalid UUID; `401/403` invalid key/scope; `500` query failure.

```bash
curl "$GO_USAGE_URL/idempotency-conflicts?customer_id=$CUSTOMER_ID" -H "authorization: Bearer $API_KEY"
```

## GET /adjustments [go-usage]

- **Auth:** `admin` API key.
- **Request:** Optional `status` (`pending`, `approved`, `rejected`).
- **Response:** `200 {data}` late-usage adjustment records.
- **Errors:** `400` invalid status; `401/403` invalid key/scope; `500` query failure.

```bash
curl "$GO_USAGE_URL/adjustments?status=pending" -H "authorization: Bearer $API_KEY"
```

## POST /adjustments/{id}/approve [go-usage]

- **Auth:** `admin` API key.
- **Request:** Adjustment UUID; empty body.
- **Response:** `200` approved adjustment and resulting usage-event reference.
- **Errors:** `400` invalid UUID; `401/403` auth; `404` hidden/missing adjustment; `409` not pending; `500` review failure.

```bash
curl -X POST "$GO_USAGE_URL/adjustments/$ADJUSTMENT_ID/approve" -H "authorization: Bearer $API_KEY"
```

## POST /adjustments/{id}/reject [go-usage]

- **Auth:** `admin` API key.
- **Request:** Adjustment UUID; empty body.
- **Response:** `200` rejected adjustment.
- **Errors:** `400` invalid UUID; `401/403` auth; `404` hidden/missing adjustment; `409` not pending; `500` review failure.

```bash
curl -X POST "$GO_USAGE_URL/adjustments/$ADJUSTMENT_ID/reject" -H "authorization: Bearer $API_KEY"
```

