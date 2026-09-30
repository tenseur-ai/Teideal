import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildServer } from "../../services/ts-console/src/server.js";

export type ServiceName = "ts-console" | "go-usage";

export interface ApiRoute {
  service: ServiceName;
  method: string;
  path: string;
}

export interface CoverageResult {
  actual: ApiRoute[];
  documented: ApiRoute[];
  undocumented: string[];
  stale: string[];
  malformed: string[];
  missingErrorCodes: string[];
  missingReasonValues: string[];
}

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const documentedRouteHeading = /^## (GET|POST|PUT|PATCH|DELETE) (`?)(\/[^`\s]+)\2 \[(ts-console|go-usage)\]$/gm;
const requiredFields = ["Auth", "Request", "Response", "Errors"];

function key(route: ApiRoute): string {
  return `${route.service} ${route.method} ${route.path}`;
}

function sortRoutes(routes: ApiRoute[]): ApiRoute[] {
  return [...routes].sort((left, right) => key(left).localeCompare(key(right)));
}

export async function registeredRoutes(): Promise<ApiRoute[]> {
  const routes: ApiRoute[] = [];
  const app = buildServer({
    onRoute(route) {
      // Internal service-to-service endpoints are not part of the public API
      // reference. Their static-admin-key contract is documented in code,
      // not exposed as a tenant-facing route.
      if (route.url.startsWith("/internal/")) return;
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      for (const methodValue of methods) {
        const method = String(methodValue).toUpperCase();
        if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) continue;
        routes.push({ service: "ts-console", method, path: route.url });
      }
    },
  });

  try {
    await app.ready();
  } finally {
    await app.close();
  }

  const goMain = await readFile(path.join(repoRoot, "services/go-usage/cmd/server/main.go"), "utf8");
  const goPattern = /mux\.Handle(?:Func)?\(\s*"(GET|POST|PUT|PATCH|DELETE)\s+([^"\s]+)"/g;
  for (const match of goMain.matchAll(goPattern)) {
    routes.push({ service: "go-usage", method: match[1], path: match[2] });
  }

  const unique = new Map(routes.map((route) => [key(route), route]));
  return sortRoutes([...unique.values()]);
}

export async function documentedRoutes(): Promise<{ routes: ApiRoute[]; malformed: string[] }> {
  const files = (await readdir(here))
    .filter((name) => name.endsWith(".md"))
    .sort();
  const routes: ApiRoute[] = [];
  const malformed: string[] = [];

  for (const file of files) {
    const markdown = await readFile(path.join(here, file), "utf8");
    const matches = [...markdown.matchAll(documentedRouteHeading)];
    for (let index = 0; index < matches.length; index += 1) {
      const match = matches[index];
      const route: ApiRoute = {
        method: match[1],
        path: match[3],
        service: match[4] as ServiceName,
      };
      routes.push(route);
      const sectionStart = (match.index ?? 0) + match[0].length;
      const sectionEnd = index + 1 < matches.length ? matches[index + 1].index : markdown.length;
      const section = markdown.slice(sectionStart, sectionEnd);
      for (const field of requiredFields) {
        if (!section.includes(`**${field}:**`)) malformed.push(`${file}: ${key(route)} is missing ${field}`);
      }
      if (!/```[a-zA-Z0-9_-]+(?: runnable)?\r?\n[\s\S]+?```/.test(section)) {
        malformed.push(`${file}: ${key(route)} is missing a worked example block`);
      }
    }
  }

  const duplicates = routes
    .map(key)
    .filter((routeKey, index, all) => all.indexOf(routeKey) !== index);
  malformed.push(...duplicates.map((routeKey) => `duplicate documented route: ${routeKey}`));
  return { routes: sortRoutes(routes), malformed };
}

export async function checkCoverage(): Promise<CoverageResult> {
  const actual = await registeredRoutes();
  const docs = await documentedRoutes();
  const errorsDoc = await readFile(path.join(here, "errors.md"), "utf8");
  const tsSources = await Promise.all([
    path.join(repoRoot, "services/ts-console/src/server.ts"),
    path.join(repoRoot, "services/ts-console/src/lib/deprecatedRoutes.ts"),
    ...(await readdir(path.join(repoRoot, "services/ts-console/src/routes"))).map((file) =>
      path.join(repoRoot, "services/ts-console/src/routes", file),
    ),
  ].map((file) => readFile(file, "utf8")));
  const errorCodes = new Set<string>();
  for (const source of tsSources) {
    for (const match of source.matchAll(/reply\.code\((\d{3})\)/g)) {
      if (Number(match[1]) >= 400) errorCodes.add(match[1]);
    }
  }
  const goMainAndHandlers = await Promise.all([
    path.join(repoRoot, "services/go-usage/cmd/server/main.go"),
    ...(await readdir(path.join(repoRoot, "services/go-usage/internal/api"))).filter((file) => file.endsWith(".go")).map((file) =>
      path.join(repoRoot, "services/go-usage/internal/api", file),
    ),
  ].map((file) => readFile(file, "utf8")));
  const goErrorCodes: Record<string, string> = {
    BadRequest: "400", Unauthorized: "401", Forbidden: "403", NotFound: "404",
    MethodNotAllowed: "405", Conflict: "409", Gone: "410", InternalServerError: "500",
    BadGateway: "502", GatewayTimeout: "504",
  };
  for (const source of goMainAndHandlers) {
    for (const match of source.matchAll(/http\.Status([A-Za-z]+)/g)) {
      const code = goErrorCodes[match[1]];
      if (code) errorCodes.add(code);
    }
  }
  const usageSource = await readFile(path.join(repoRoot, "services/go-usage/internal/api/usage.go"), "utf8");
  const reasonValues = new Set(
    [...usageSource.matchAll(/(?:Status|Reason):\s*"([^"]+)"/g)].map((match) => match[1]),
  );
  const actualKeys = new Set(actual.map(key));
  const documentedKeys = new Set(docs.routes.map(key));
  return {
    actual,
    documented: docs.routes,
    undocumented: [...actualKeys].filter((routeKey) => !documentedKeys.has(routeKey)),
    stale: [...documentedKeys].filter((routeKey) => !actualKeys.has(routeKey)),
    malformed: docs.malformed,
    missingErrorCodes: [...errorCodes].sort().filter((code) => !errorsDoc.includes(code)),
    missingReasonValues: [...reasonValues].sort().filter((value) => !errorsDoc.includes(`\`${value}\``)),
  };
}

async function main(): Promise<void> {
  const result = await checkCoverage();
  if (result.undocumented.length || result.stale.length || result.malformed.length || result.missingErrorCodes.length || result.missingReasonValues.length) {
    if (result.undocumented.length) console.error("Undocumented routes:\n" + result.undocumented.join("\n"));
    if (result.stale.length) console.error("Stale documented routes:\n" + result.stale.join("\n"));
    if (result.malformed.length) console.error("Malformed documentation:\n" + result.malformed.join("\n"));
    if (result.missingErrorCodes.length) console.error("Undocumented error status codes:\n" + result.missingErrorCodes.join("\n"));
    if (result.missingReasonValues.length) console.error("Undocumented reason/status values:\n" + result.missingReasonValues.join("\n"));
    process.exitCode = 1;
    return;
  }
  console.log(`API documentation covers all ${result.actual.length} registered routes.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
