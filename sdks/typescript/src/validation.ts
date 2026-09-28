import { TeidealValidationError } from "./errors.js";

const EVENT_TYPE = /^[A-Za-z0-9_.:-]{1,128}$/;
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RAW_UUID = /^[0-9a-f]{32}$/i;
const MAX_QUANTITY = 1_000_000_000_000;

export function validateEvent(customerId: string, eventType: string, quantity: number): void {
  if (!isUuid(customerId)) {
    throw new TeidealValidationError("customer_id must be a UUID");
  }
  if (!EVENT_TYPE.test(eventType)) {
    throw new TeidealValidationError("event_type must match ^[A-Za-z0-9_.:-]{1,128}$");
  }
  if (typeof quantity !== "number" || !Number.isFinite(quantity)) {
    throw new TeidealValidationError("quantity must be a finite number");
  }
  if (quantity < 0) {
    throw new TeidealValidationError("quantity must be a non-negative number");
  }
  if (quantity > MAX_QUANTITY) {
    throw new TeidealValidationError("quantity must not exceed 1000000000000 (one trillion)");
  }
}

function isUuid(value: string): boolean {
  if (typeof value !== "string") return false;
  if (CANONICAL_UUID.test(value) || RAW_UUID.test(value)) return true;
  if (value.startsWith("{") && value.endsWith("}")) return CANONICAL_UUID.test(value.slice(1, -1));
  if (value.toLowerCase().startsWith("urn:uuid:")) return CANONICAL_UUID.test(value.slice(9));
  return false;
}
