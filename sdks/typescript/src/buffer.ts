import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface UsagePayload {
  customer_id: string;
  event_type: string;
  quantity: number;
  idempotency_key: string;
  occurred_at?: string;
}

export interface BufferedEvent {
  idempotencyKey: string;
  payload: UsagePayload;
  attempts: number;
  createdAt: string;
  sentAt: string | null;
}

export class NdjsonBuffer {
  private readonly index = new Map<string, BufferedEvent>();
  private sentSinceCompaction = 0;

  constructor(readonly path: string, readonly compactionThreshold = 32) {
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path)) writeFileSync(path, "", { encoding: "utf8", flag: "wx" });
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      const event = JSON.parse(line) as BufferedEvent;
      this.index.set(event.idempotencyKey, event);
    }
  }

  persist(idempotencyKey: string, payload: UsagePayload): void {
    if (this.index.has(idempotencyKey)) return;
    const event: BufferedEvent = {
      idempotencyKey,
      payload,
      attempts: 0,
      createdAt: new Date().toISOString(),
      sentAt: null,
    };
    appendFileSync(this.path, `${JSON.stringify(event)}\n`, "utf8");
    this.index.set(idempotencyKey, event);
  }

  pending(): BufferedEvent[] {
    return [...this.index.values()]
      .filter((event) => event.sentAt === null)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  incrementAttempts(idempotencyKey: string): void {
    const event = this.index.get(idempotencyKey);
    if (event) event.attempts += 1;
  }

  markSent(idempotencyKey: string): void {
    const event = this.index.get(idempotencyKey);
    if (!event || event.sentAt !== null) return;
    event.sentAt = new Date().toISOString();
    appendFileSync(this.path, `${JSON.stringify(event)}\n`, "utf8");
    this.sentSinceCompaction += 1;
    if (this.sentSinceCompaction >= this.compactionThreshold) this.compact();
  }

  hasPending(): boolean {
    return [...this.index.values()].some((event) => event.sentAt === null);
  }

  compact(): void {
    const pending = this.pending();
    const temporary = `${this.path}.tmp-${process.pid}-${Date.now()}`;
    const body = pending.map((event) => JSON.stringify(event)).join("\n");
    writeFileSync(temporary, body ? `${body}\n` : "", { encoding: "utf8", flag: "wx" });
    renameSync(temporary, this.path);
    this.index.clear();
    for (const event of pending) this.index.set(event.idempotencyKey, event);
    this.sentSinceCompaction = 0;
  }
}
