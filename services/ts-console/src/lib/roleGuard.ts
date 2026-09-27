import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { Role } from "./users.js";

export type ConsoleAuth = { role: Role[] } | { selfService: true };

// Populated in registration order by the routes actually mounted in the app.
export const CONSOLE_ROUTE_AUDIT: { method: string; url: string; auth: ConsoleAuth }[] = [];

function guard(auth: ConsoleAuth) {
  if ("selfService" in auth) return async () => {};
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const role = req.consolePrincipal!.role;
    if (!auth.role.includes(role)) {
      return reply.code(403).send({
        error: `this action requires role ${auth.role.join(" or ")}; your role is ${role}`,
      });
    }
  };
}

export function consoleRoute(
  scoped: FastifyInstance,
  method: "get" | "post" | "put" | "patch" | "delete",
  url: string,
  auth: ConsoleAuth,
  handler: (req: FastifyRequest, reply: FastifyReply) => unknown,
): void {
  CONSOLE_ROUTE_AUDIT.push({ method, url, auth });
  scoped[method](url, { preHandler: guard(auth) }, handler);
}
