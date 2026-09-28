import Fastify from "fastify";
import { pathToFileURL } from "node:url";
import { createPool } from "./lib/db.js";
import { requireAuth } from "./lib/auth.js";
import { registerCustomerRoutes } from "./routes/customers.js";
import { registerSecurityRoutes } from "./routes/security.js";
import { registerSupportRoutes } from "./routes/support.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerTenantSettingsRoutes } from "./routes/tenantSettings.js";
import { registerAuditLogRoutes } from "./routes/auditLog.js";
import { registerApiKeyRoutes } from "./routes/apiKeys.js";
import { registerPlanRoutes } from "./routes/plans.js";
import { registerGrantRoutes } from "./routes/grants.js";
import { registerConsumptionOrderRoutes } from "./routes/consumptionOrder.js";
import { registerConsumptionRoutes } from "./routes/consumption.js";
import { registerUserRoutes } from "./routes/users.js";
import { sweepExpiredSessions } from "./lib/sessions.js";
import { processPendingExports, processScheduledExports } from "./lib/exportWorker.js";
import { processCommitDrawdowns, processExpiredGrants, processRecurringGrants } from "./lib/grantWorker.js";
import { registerExportFormatRoute, registerExportRoutes } from "./routes/exports.js";
import { registerStripeConnectRoutes } from "./routes/stripeConnect.js";
import { assertStripeConfig, StripeConfigError } from "./lib/stripeConnect.js";

const SESSION_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const EXPORT_WORKER_INTERVAL_MS = 60 * 1000;
const GRANT_WORKER_INTERVAL_MS = 60 * 1000;
const COMMIT_DRAWDOWN_INTERVAL_MS = 60 * 1000;

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
  registerAuditLogRoutes(app, pool);
  registerApiKeyRoutes(app, pool);
  registerPlanRoutes(app, pool);
  registerGrantRoutes(app, pool);
  registerConsumptionOrderRoutes(app, pool);
  registerConsumptionRoutes(app, pool);
  registerUserRoutes(app, pool);
  registerExportRoutes(app, pool);
  registerStripeConnectRoutes(app, pool);

  registerCustomerRoutes(app, pool);

  app.register(async (scoped) => {
    scoped.addHook("preHandler", requireAuth(pool));
    registerSupportRoutes(scoped);
    registerExportFormatRoute(scoped);
  });

  // TEID-91-T6: idle-expired sessions are reclaimed on a timer in
  // production; tests call sweepExpiredSessions directly instead so they
  // can measure it under a controlled load without waiting on this timer.
  let sweepTimer: NodeJS.Timeout | undefined;
  let exportTimer: NodeJS.Timeout | undefined;
  let grantTimer: NodeJS.Timeout | undefined;
  let commitTimer: NodeJS.Timeout | undefined;
  if (process.env.NODE_ENV !== "test") {
    sweepTimer = setInterval(() => {
      sweepExpiredSessions(pool).catch((err) => console.error("session sweep failed:", err));
    }, SESSION_SWEEP_INTERVAL_MS);
    exportTimer = setInterval(() => {
      Promise.all([processPendingExports(pool), processScheduledExports(pool)])
        .catch((err) => console.error("export worker failed:", err));
    }, EXPORT_WORKER_INTERVAL_MS);
    // Tests call processRecurringGrants / processExpiredGrants directly so
    // they can pass a fixed instant. Issuance is idempotent per period, so
    // this timer cannot double-issue when it overlaps a manual run.
    grantTimer = setInterval(() => {
      Promise.all([processRecurringGrants(pool), processExpiredGrants(pool)])
        .catch((err) => console.error("grant worker failed:", err));
    }, GRANT_WORKER_INTERVAL_MS);
    // Tests call processCommitDrawdowns directly with a fixed instant.
    commitTimer = setInterval(() => {
      processCommitDrawdowns(pool).catch((err) => console.error("commit drawdown worker failed:", err));
    }, COMMIT_DRAWDOWN_INTERVAL_MS);
  }

  app.addHook("onClose", async () => {
    if (sweepTimer) clearInterval(sweepTimer);
    if (exportTimer) clearInterval(exportTimer);
    if (grantTimer) clearInterval(grantTimer);
    if (commitTimer) clearInterval(commitTimer);
    await pool.end();
  });

  return app;
}

// Importing buildServer from a test must not bind a port, while executing the
// compiled entrypoint with NODE_ENV=test still needs to start the HTTP server;
// NODE_ENV only controls the background timers above.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assertStripeConfig();
  } catch (err) {
    const statusCode = err instanceof StripeConfigError ? err.statusCode : 400;
    const message = err instanceof Error ? err.message : String(err);
    console.error(`ts-console: startup rejected (${statusCode}): ${message}`);
    process.exit(1);
  }
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
