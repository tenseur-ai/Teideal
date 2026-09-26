import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { FastifyInstance } from "fastify";

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DOC_PATH = path.resolve(here, "../../../../docs/isolation-design.md");

export const SUPPORT_SLA = "Delivered immediately via this self-serve endpoint; requests made through a human support channel are fulfilled within 1 business day.";

// TEID-41-AC4/T4: the isolation design doc must be available to customers
// on request. This is the self-serve path of that request; it requires the
// same tenant auth as every other endpoint (a customer requesting *their
// own* account's copy of the design), and returns the document synchronously.
export function registerSupportRoutes(app: FastifyInstance, docPath: string = process.env.ISOLATION_DOC_PATH ?? DEFAULT_DOC_PATH) {
  app.get("/support/isolation-design-doc", async (req, reply) => {
    const doc = await readFile(docPath, "utf8");
    return reply.send({
      requested_by_tenant: req.principal!.tenantKey,
      sla: SUPPORT_SLA,
      delivered_at: new Date().toISOString(),
      document: doc,
    });
  });
}
