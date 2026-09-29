// Defaults match the CI ts-console start step, same pattern as
// tests/stripe-connect/env.ts.
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
export const FAKE_STRIPE_URL = prefer("FAKE_STRIPE_URL", "http://127.0.0.1:8092");
export const STRIPE_TOKEN_ENCRYPTION_KEY = prefer(
  "STRIPE_TOKEN_ENCRYPTION_KEY",
  "02DWhpwMvIIHYMC/Z73W+qfHPlGd/gBN3riv9zqXQmY=",
);
prefer("STRIPE_CONNECT_BASE_URL", FAKE_STRIPE_URL);
prefer("STRIPE_API_BASE_URL", FAKE_STRIPE_URL);
prefer("STRIPE_CONNECT_CLIENT_ID", "ca_test_teideal");
prefer("STRIPE_CONNECT_CLIENT_SECRET", "sk_test_teideal_connect_secret");
prefer("STRIPE_CONNECT_REDIRECT_URI", "http://127.0.0.1:8081/stripe/connect/oauth/return");

export const TENANT_ID = "00000000-0000-0000-0000-000000001001";
