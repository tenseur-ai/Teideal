import Fastify from "fastify";
import { createPool } from "./lib/db.js";
import { requireAuth } from "./lib/auth.js";
import { registerCustomerRoutes } from "./routes/customers.js";
import { registerSecurityRoutes } from "./routes/security.js";
import { registerSupportRoutes } from "./routes/support.js";

export function buildServer() {
  const app = Fastify({ logger: false });
  const pool = createPool(
    process.env.DATABASE_URL ?? "postgres://teideal_app:teideal_app_dev_password@localhost:5432/teideal",
  );
  const adminSecret = process.env.ADMIN_SECRET ?? "dev_admin_secret";

  app.get("/healthz", async () => ({ status: "ok" }));

  registerSecurityRoutes(app, pool, adminSecret);

  app.register(async (scoped) => {
    scoped.addHook("preHandler", requireAuth(pool));
    registerCustomerRoutes(scoped, pool);
    registerSupportRoutes(scoped);
  });

  app.addHook("onClose", async () => {
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
