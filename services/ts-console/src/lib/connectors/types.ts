export interface ConnectorCustomer {
  id: string;
  name: string;
  email: string | null;
  created_at: string;
}

export interface ConnectorPrice {
  id: string;
  product_name: string;
  amount: string;
  currency: string;
  billing_scheme: string;
}

export interface ConnectorContract {
  id: string;
  customer_id: string;
  status: string;
  started_at: string;
  ended_at: string | null;
}

export interface ConnectorInvoice {
  id: string;
  customer_id: string;
  amount: string;
  currency: string;
  status: string;
  issued_at: string;
  due_at: string | null;
}

export interface ConnectorCredit {
  id: string;
  customer_id: string;
  amount: string;
  currency: string;
  reason: string | null;
  issued_at: string;
}

export interface ConnectorPayment {
  id: string;
  customer_id: string;
  invoice_id: string | null;
  amount: string;
  currency: string;
  status: string;
  paid_at: string;
}

export interface ConnectorRefund {
  id: string;
  payment_id: string;
  amount: string;
  currency: string;
  reason: string | null;
  refunded_at: string;
}
