import { TeidealClient } from "teideal-node";

const [, , baseUrl, apiKey, customerId, bufferPath] = process.argv;
const client = new TeidealClient(baseUrl, apiKey, console, bufferPath, {
  retryBackoffs: [0, 0],
  flushInterval: 3_600_000,
  requestTimeout: 60_000,
});
for (let index = 0; index < 3; index += 1) {
  void client.sendEvent(customerId, `sdk.node.crash.${index}`, 1).catch(() => undefined);
}
setInterval(() => undefined, 1_000);
