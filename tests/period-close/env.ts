export const TS_CONSOLE_URL = process.env.TS_CONSOLE_URL ?? "http://127.0.0.1:8081";
export const GO_USAGE_URL = process.env.GO_USAGE_URL ?? "http://127.0.0.1:8082";
export const DATABASE_URL = process.env.DATABASE_URL ??
  "postgres://teideal_app:teideal_app_dev_password@127.0.0.1:5432/teideal";
export const SUPERUSER_DATABASE_URL = process.env.SUPERUSER_DATABASE_URL ??
  "postgres://postgres:postgres@127.0.0.1:5432/teideal";
export const TENANT_ID = "00000000-0000-0000-0000-000000001001";
export const API_KEY = "devkey_1001";
