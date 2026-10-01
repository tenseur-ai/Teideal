function prefer(name: string, fallback: string): string {
  if (!process.env[name]) process.env[name] = fallback;
  return process.env[name]!;
}

export const DATABASE_URL = prefer(
  "DATABASE_URL",
  "postgres://teideal_app:teideal_app_dev_password@127.0.0.1:5432/teideal",
);
export const SUPERUSER_DATABASE_URL = prefer(
  "SUPERUSER_DATABASE_URL",
  "postgres://postgres:postgres@127.0.0.1:5432/teideal",
);
export const TS_CONSOLE_URL = prefer("TS_CONSOLE_URL", "http://127.0.0.1:8081");
export const TENANT_ID = "00000000-0000-0000-0000-000000001001";
