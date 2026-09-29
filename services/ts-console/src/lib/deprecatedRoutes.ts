import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Retired request paths mapped to their current route or documentation URL.
 *
 * Production starts empty because Teideal has not retired an API path yet.
 * Tests may install a synthetic entry and must remove it after use.
 */
export const deprecatedRoutes: Record<string, string> = {};

export async function rejectDeprecatedRoute(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const path = req.url.split("?", 1)[0];
  const see = deprecatedRoutes[path];
  if (see !== undefined) {
    await reply.code(410).send({ error: "this path is deprecated", see });
  }
}
