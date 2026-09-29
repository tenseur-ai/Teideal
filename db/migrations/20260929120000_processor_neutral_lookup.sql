-- TEID-74: resolving a customer by the stored Stripe reference must stay
-- indexed after the connection is disconnected. Disconnect changes
-- stripe_connections.status only; it does not delete this reference.
CREATE INDEX IF NOT EXISTS stripe_customer_links_stripe_customer_id_idx
  ON stripe_customer_links (stripe_customer_id);
