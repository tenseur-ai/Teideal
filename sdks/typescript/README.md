# teideal-node

Official TypeScript/Node SDK for durable, idempotent Teideal usage events.

```ts
import { TeidealClient } from "teideal-node";
const client = new TeidealClient("https://usage.example.com", "api-key");
const result = await client.sendEvent("customer-uuid", "api.request", 1);
```

Events are written to an append-only NDJSON journal before transmission.
