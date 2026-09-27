export const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://teideal_app:teideal_app_dev_password@127.0.0.1:5432/teideal";
export const TS_CONSOLE_URL = process.env.TS_CONSOLE_URL ?? "http://127.0.0.1:8081";
export const ADMIN_SECRET = process.env.ADMIN_SECRET ?? "dev_admin_secret";
