-- TEID-42: extend the existing append-only authentication audit log so it
-- can also describe tenant configuration changes and their credential actor.
ALTER TABLE audit_log
  ADD COLUMN object_type TEXT,
  ADD COLUMN object_id TEXT,
  ADD COLUMN customer_id UUID REFERENCES customers(id),
  ADD COLUMN actor_api_key_id UUID REFERENCES api_keys(id),
  ADD COLUMN before JSONB,
  ADD COLUMN after JSONB,
  ADD CONSTRAINT audit_log_actor_check CHECK (
    (actor_user_id IS NOT NULL)::int + (actor_api_key_id IS NOT NULL)::int <= 1
  );

CREATE INDEX audit_log_object_idx ON audit_log (tenant_id, object_type, object_id);
CREATE INDEX audit_log_customer_idx ON audit_log (tenant_id, customer_id) WHERE customer_id IS NOT NULL;
