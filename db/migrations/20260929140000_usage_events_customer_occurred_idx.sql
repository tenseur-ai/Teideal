-- TEID-45: hourly usage bucketing (GROUP BY date_trunc('hour', occurred_at))
-- is dominated by a customer-scoped time range scan. The original
-- (tenant_id, customer_id) index cannot satisfy occurred_at ordering or
-- the hour aggregate without a residual sort/filter of every matching
-- customer row. This composite index is the shape prior stories' query
-- patterns already assumed.
CREATE INDEX IF NOT EXISTS usage_events_tenant_customer_occurred_idx
  ON usage_events (tenant_id, customer_id, occurred_at);
