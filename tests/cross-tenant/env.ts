import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://teideal_app:teideal_app_dev_password@127.0.0.1:5432/teideal";
export const TS_CONSOLE_URL = process.env.TS_CONSOLE_URL ?? "http://127.0.0.1:8081";
export const GO_USAGE_URL = process.env.GO_USAGE_URL ?? "http://127.0.0.1:8082";
export const ADMIN_SECRET = process.env.ADMIN_SECRET ?? "dev_admin_secret";

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

const here = path.dirname(fileURLToPath(import.meta.url));

export function loadFixtures(): Fixtures {
  const raw = readFileSync(path.join(here, ".fixtures.json"), "utf8");
  return JSON.parse(raw) as Fixtures;
}
