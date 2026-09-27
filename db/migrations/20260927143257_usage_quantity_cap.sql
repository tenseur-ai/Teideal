-- TEID-95: defense-in-depth cap matching the app-level one-trillion
-- quantity limit (AC2). App validation in usage.go is what actually
-- rejects an over-cap request; this is a database-level backstop.
ALTER TABLE usage_events
  ADD CONSTRAINT usage_events_quantity_max CHECK (quantity <= 1000000000000);
