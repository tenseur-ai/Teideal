import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const GO_USAGE_URL = process.env.GO_USAGE_URL ?? "http://127.0.0.1:8082";
export const DATABASE_URL = process.env.DATABASE_URL ??
  "postgres://teideal_app:teideal_app_dev_password@127.0.0.1:5432/teideal";
export const SUPERUSER_DATABASE_URL = process.env.SUPERUSER_DATABASE_URL ??
  "postgres://postgres:postgres@127.0.0.1:5432/teideal";
export const ONCALL_ALERT_WEBHOOK_URL = process.env.ONCALL_ALERT_WEBHOOK_URL ??
  "http://127.0.0.1:8092/alerts";

export interface TenantFixture {
  id: string;
  externalKey: string;
  apiKey: string;
  customerId: string;
}

export interface Fixtures {
  tenant1: TenantFixture;
  tenant2: TenantFixture;
}

const defaults: Fixtures = {
  tenant1: {
    id: "00000000-0000-0000-0000-000000001001",
    externalKey: "acct_1001",
    apiKey: "devkey_1001",
    customerId: "00000000-0000-0000-0000-0000000c1001",
  },
  tenant2: {
    id: "00000000-0000-0000-0000-000000001002",
    externalKey: "acct_1002",
    apiKey: "devkey_1002",
    customerId: "00000000-0000-0000-0000-0000000c1002",
  },
};

export function loadFixtures(): Fixtures {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const fixturePath = path.join(here, "../cross-tenant/.fixtures.json");
  return existsSync(fixturePath)
    ? JSON.parse(readFileSync(fixturePath, "utf8")) as Fixtures
    : defaults;
}
