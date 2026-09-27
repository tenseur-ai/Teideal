// A standalone stand-in for Google's OIDC identity provider, run as its
// own process (like go-usage/ts-console) so the real ts-console service
// under test can point GOOGLE_JWKS_URL/GOOGLE_ISSUER/GOOGLE_AUDIENCE at it
// over real HTTP from the moment it starts -- proving TEID-91-T1 (Google
// sign-in) and TEID-91-T7 (IdP latency/timeout) through the service's
// actual jose (createRemoteJWKSet + jwtVerify) verification path, not a
// mock of it. /mint and /latency let the test process (a separate
// Node process) drive this server the same way it drives go-usage and
// ts-console: over HTTP, not through shared in-memory state.
import { createServer } from "node:http";
import { generateKeyPair, exportJWK, SignJWT } from "jose";

async function readJsonBody(req: import("node:http").IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

async function main() {
  const port = Number(process.env.FAKE_GOOGLE_PORT ?? 8090);
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const kid = "fake-google-test-key";
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" };

  const issuer = `http://127.0.0.1:${port}`;
  const audience = "teideal-console-test";
  let latencyMs = 0;

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/jwks") {
        if (latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, latencyMs));
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ keys: [jwk] }));
        return;
      }
      if (req.method === "POST" && req.url === "/latency") {
        const body = await readJsonBody(req);
        latencyMs = Number(body.ms) || 0;
        res.end(JSON.stringify({ latencyMs }));
        return;
      }
      if (req.method === "POST" && req.url === "/mint") {
        const body = await readJsonBody(req);
        const idToken = await new SignJWT({ email: body.email })
          .setProtectedHeader({ alg: "RS256", kid })
          .setSubject(body.subject)
          .setIssuer(issuer)
          .setAudience(audience)
          .setIssuedAt()
          .setExpirationTime("5m")
          .sign(privateKey);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ id_token: idToken }));
        return;
      }
      if (req.method === "GET" && req.url === "/healthz") {
        res.end(JSON.stringify({ status: "ok", issuer, audience }));
        return;
      }
      res.statusCode = 404;
      res.end();
    } catch (err) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  });

  server.listen(port, () => {
    console.log(`fake-google: listening on ${issuer} (issuer=${issuer} audience=${audience})`);
  });
}

main();
