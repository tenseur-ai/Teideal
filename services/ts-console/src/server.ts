import Fastify from "fastify";
import { createPool } from "./lib/db.js";
import { requireAuth } from "./lib/auth.js";
import { registerCustomerRoutes } from "./routes/customers.js";
import { registerSecurityRoutes } from "./routes/security.js";
import { registerSupportRoutes } from "./routes/support.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerTenantSettingsRoutes } from "./routes/tenantSettings.js";
import { sweepExpiredSessions } from "./lib/sessions.js";

const SESSION_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export function buildServer() {
  const app = Fastify({ logger: false });
  const pool = createPool(
    process.env.DATABASE_URL ?? "postgres://teideal_app:teideal_app_dev_password@localhost:5432/teideal",
  );
  const adminSecret = process.env.ADMIN_SECRET ?? "dev_admin_secret";

  app.get("/healthz", async () => ({ status: "ok" }));

  registerSecurityRoutes(app, pool, adminSecret);
  registerAuthRoutes(app, pool);
  registerTenantSettingsRoutes(app, pool);

  app.register(async (scoped) => {
    scoped.addHook("preHandler", requireAuth(pool));
    registerCustomerRoutes(scoped, pool);
    registerSupportRoutes(scoped);
  });

  // TEID-91-T6: idle-expired sessions are reclaimed on a timer in
  // production; tests call sweepExpiredSessions directly instead so they
  // can measure it under a controlled load without waiting on this timer.
  let sweepTimer: NodeJS.Timeout | undefined;
  if (process.env.NODE_ENV !== "test") {
    sweepTimer = setInterval(() => {
      sweepExpiredSessions(pool).catch((err) => console.error("session sweep failed:", err));
    }, SESSION_SWEEP_INTERVAL_MS);
  }

  app.addHook("onClose", async () => {
    if (sweepTimer) clearInterval(sweepTimer);
    await pool.end();
  });

  return app;
}

if (process.env.NODE_ENV !== "test") {
  const app = buildServer();
  const port = Number(process.env.PORT ?? 8081);
  app.listen({ port, host: "0.0.0.0" }, (err, address) => {
    if (err) {
      console.error(err);
      process.exit(1);
    }
    console.log(`ts-console: listening on ${address}`);
  });
}
