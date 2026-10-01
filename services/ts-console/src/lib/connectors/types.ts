export interface ConnectorCustomer {
  id: string;
  name: string;
  email: string | null;
  created_at: string;
  external_updated_at: string | null;
  passthrough: Record<string, unknown>;
}

export interface ConnectorPrice {
  id: string;
  product_name: string;
  amount: string;
  currency: string;
  billing_scheme: string;
  interval: string | null;
  product_id: string | null;
  nickname: string | null;
  external_updated_at: string | null;
  passthrough: Record<string, unknown>;
}

export interface ConnectorContract {
  id: string;
  customer_id: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  external_updated_at: string | null;
  passthrough: Record<string, unknown>;
}

export interface ConnectorInvoiceLine {
  id: string;
  invoice_id: string;
  price_id: string | null;
  description: string | null;
  quantity: string;
  unit_amount: string;
  amount: string;
  currency: string;
  period_start: string | null;
  period_end: string | null;
  passthrough: Record<string, unknown>;
}

export interface ConnectorInvoice {
  id: string;
  customer_id: string;
  amount: string;
  currency: string;
  status: string;
  issued_at: string;
  due_at: string | null;
  number: string | null;
  period_start: string | null;
  period_end: string | null;
  subtotal: string | null;
  tax: string | null;
  lines: ConnectorInvoiceLine[];
  external_updated_at: string | null;
  passthrough: Record<string, unknown>;
}

export interface ConnectorCredit {
  id: string;
  customer_id: string;
  amount: string;
  currency: string;
  reason: string | null;
  issued_at: string;
  external_updated_at: string | null;
  passthrough: Record<string, unknown>;
}

export interface ConnectorPayment {
  id: string;
  customer_id: string;
  invoice_id: string | null;
  amount: string;
  currency: string;
  status: string;
  paid_at: string;
  processor_charge_id: string | null;
  external_updated_at: string | null;
  passthrough: Record<string, unknown>;
}

export interface ConnectorRefund {
  id: string;
  payment_id: string;
  amount: string;
  currency: string;
  reason: string | null;
  refunded_at: string;
  processor_refund_id: string | null;
  external_updated_at: string | null;
  passthrough: Record<string, unknown>;
}
