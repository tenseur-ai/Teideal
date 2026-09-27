import { createServer, type IncomingMessage } from "node:http";

interface FakeState {
  acceptedRoleArns: string[];
  acceptedBuckets: string[];
  failPut: boolean;
  assumeRoleAttempts: number;
  headBucketAttempts: number;
  putAttempts: Array<{ bucket: string; key: string; bytes: number }>;
}

const state: FakeState = {
  acceptedRoleArns: [],
  acceptedBuckets: [],
  failPut: false,
  assumeRoleAttempts: 0,
  headBucketAttempts: 0,
  putAttempts: [],
};

async function body(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function xmlError(res: import("node:http").ServerResponse, status: number, code: string, message: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/xml");
  res.end(`<ErrorResponse><Error><Type>Sender</Type><Code>${code}</Code><Message>${message}</Message></Error><RequestId>fake</RequestId></ErrorResponse>`);
}

function bucketAndKey(url: string): { bucket: string; key: string } {
  const pathname = new URL(url, "http://fake-s3").pathname;
  const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  return { bucket: parts[0] ?? "", key: parts.slice(1).join("/") };
}

const port = Number(process.env.FAKE_S3_PORT ?? 8091);
const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/healthz") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (req.method === "GET" && req.url === "/state") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(state));
      return;
    }
    if (req.method === "POST" && req.url === "/control") {
      const next = JSON.parse((await body(req)).toString("utf8") || "{}") as Partial<FakeState> & { reset?: boolean };
      if (next.reset) {
        state.assumeRoleAttempts = 0;
        state.headBucketAttempts = 0;
        state.putAttempts = [];
      }
      if (next.acceptedRoleArns) state.acceptedRoleArns = next.acceptedRoleArns;
      if (next.acceptedBuckets) state.acceptedBuckets = next.acceptedBuckets;
      if (next.failPut !== undefined) state.failPut = next.failPut;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(state));
      return;
    }

    if (req.method === "POST") {
      const params = new URLSearchParams((await body(req)).toString("utf8"));
      if (params.get("Action") === "AssumeRole") {
        state.assumeRoleAttempts += 1;
        const roleArn = params.get("RoleArn") ?? "";
        if (!state.acceptedRoleArns.includes(roleArn)) {
          xmlError(res, 403, "AccessDenied", "role is not trusted by the fake Teideal account");
          return;
        }
        res.setHeader("Content-Type", "application/xml");
        res.end(`<?xml version="1.0" encoding="UTF-8"?>
<AssumeRoleResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">
  <AssumeRoleResult><Credentials>
    <AccessKeyId>FAKEACCESSKEY</AccessKeyId>
    <SecretAccessKey>fake-secret-key</SecretAccessKey>
    <SessionToken>fake-session-token</SessionToken>
    <Expiration>2099-01-01T00:00:00Z</Expiration>
  </Credentials><AssumedRoleUser><Arn>${roleArn}/teideal</Arn><AssumedRoleId>fake:teideal</AssumedRoleId></AssumedRoleUser></AssumeRoleResult>
  <ResponseMetadata><RequestId>fake</RequestId></ResponseMetadata>
</AssumeRoleResponse>`);
        return;
      }
    }

    if (req.method === "HEAD") {
      state.headBucketAttempts += 1;
      const { bucket } = bucketAndKey(req.url ?? "/");
      if (!state.acceptedBuckets.includes(bucket)) {
        res.statusCode = 403;
        res.end();
        return;
      }
      res.statusCode = 200;
      res.end();
      return;
    }

    if (req.method === "PUT") {
      const { bucket, key } = bucketAndKey(req.url ?? "/");
      const contents = await body(req);
      state.putAttempts.push({ bucket, key, bytes: contents.length });
      if (state.failPut || !state.acceptedBuckets.includes(bucket)) {
        xmlError(res, 503, "ServiceUnavailable", "configured fake PutObject failure");
        return;
      }
      res.statusCode = 200;
      res.setHeader("ETag", '"fake-etag"');
      res.end();
      return;
    }

    res.statusCode = 404;
    res.end();
  } catch (error) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: (error as Error).message }));
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`fake-s3: listening on http://127.0.0.1:${port}`);
});
