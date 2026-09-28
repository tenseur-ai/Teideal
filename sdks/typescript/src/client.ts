import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { NdjsonBuffer, type BufferedEvent, type UsagePayload } from "./buffer.js";
import { TeidealError } from "./errors.js";
import { validateEvent } from "./validation.js";

export const DEFAULT_BUFFER_PATH = join(homedir(), ".teideal", "buffer.ndjson");
export const DEFAULT_RETRY_BACKOFFS = [100, 300] as const;
export const DEFAULT_FLUSH_INTERVAL = 30_000;
export const DEFAULT_REQUEST_TIMEOUT = 5_000;

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface ClientOptions {
  retryBackoffs?: readonly [number, number];
  flushInterval?: number;
  requestTimeout?: number;
  compactionThreshold?: number;
}

export interface SendResult {
  id: string;
  customerId?: string;
  eventType?: string;
  quantity?: number;
  idempotencyKey: string;
  occurredAt?: string;
  duplicate: boolean;
}

export interface FlushResult {
  attempted: number;
  sent: number;
  failed: number;
}

type ApiBody = Record<string, unknown>;

export class TeidealClient {
  baseUrl: string;
  readonly apiKey: string;
  readonly logger: Logger;
  readonly retryBackoffs: readonly [number, number];
  readonly flushInterval: number;
  readonly requestTimeout: number;
  private readonly buffer: NdjsonBuffer;
  private timer?: NodeJS.Timeout;
  private flushing = false;
  private closed = false;

  constructor(
    baseUrl: string,
    apiKey: string,
    logger: Logger = console,
    bufferPath: string = DEFAULT_BUFFER_PATH,
    options: ClientOptions = {},
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
    this.logger = logger;
    this.retryBackoffs = options.retryBackoffs ?? DEFAULT_RETRY_BACKOFFS;
    this.flushInterval = options.flushInterval ?? DEFAULT_FLUSH_INTERVAL;
    this.requestTimeout = options.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT;
    this.buffer = new NdjsonBuffer(bufferPath, options.compactionThreshold);
    if (this.buffer.hasPending()) queueMicrotask(() => void this.flush());
  }

  async sendEvent(
    customerId: string,
    eventType: string,
    quantity: number,
    occurredAt?: Date | string,
  ): Promise<SendResult> {
    const { idempotencyKey, payload } = this.prepareEvent(customerId, eventType, quantity, occurredAt);
    return this.sendPersisted(idempotencyKey, payload);
  }

  sendEventBestEffort(
    customerId: string,
    eventType: string,
    quantity: number,
    occurredAt?: Date | string,
  ): void {
    try {
      const { idempotencyKey, payload } = this.prepareEvent(customerId, eventType, quantity, occurredAt);
      void this.sendPersisted(idempotencyKey, payload).catch((error: unknown) => {
        this.logger.error("Teideal best-effort send failed", error);
      });
    } catch (error) {
      this.logger.error("Teideal best-effort queue failed", error);
    }
  }

  private prepareEvent(
    customerId: string,
    eventType: string,
    quantity: number,
    occurredAt?: Date | string,
  ): { idempotencyKey: string; payload: UsagePayload } {
    validateEvent(customerId, eventType, quantity);
    const idempotencyKey = randomUUID();
    const payload: UsagePayload = {
      customer_id: customerId,
      event_type: eventType,
      quantity,
      idempotency_key: idempotencyKey,
    };
    if (occurredAt !== undefined) payload.occurred_at = occurredAt instanceof Date ? occurredAt.toISOString() : occurredAt;
    this.buffer.persist(idempotencyKey, payload);
    return { idempotencyKey, payload };
  }

  private async sendPersisted(idempotencyKey: string, payload: UsagePayload): Promise<SendResult> {
    try {
      const result = await this.deliver(idempotencyKey, payload);
      this.buffer.markSent(idempotencyKey);
      return result;
    } catch (error) {
      if (this.buffer.hasPending()) this.scheduleFlush(this.flushInterval);
      throw error;
    }
  }

  async flush(): Promise<FlushResult> {
    if (this.flushing) return { attempted: 0, sent: 0, failed: 0 };
    this.flushing = true;
    let attempted = 0;
    let sent = 0;
    let failed = 0;
    try {
      const pending = this.buffer.pending();
      if (pending.length) this.logger.info("Teideal buffer flush started", { pending: pending.length });
      for (const event of pending) {
        attempted += 1;
        try {
          await this.deliverBuffered(event);
          sent += 1;
          this.logger.info("Teideal buffer flush sent event", { idempotencyKey: event.idempotencyKey });
        } catch (error) {
          failed += 1;
          this.logger.error("Teideal buffer flush retained event", { idempotencyKey: event.idempotencyKey, error });
        }
      }
      return { attempted, sent, failed };
    } finally {
      this.flushing = false;
      if (!this.closed && this.buffer.hasPending()) this.scheduleFlush(this.flushInterval);
    }
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private async deliverBuffered(event: BufferedEvent): Promise<SendResult> {
    try {
      const result = await this.deliver(event.idempotencyKey, event.payload);
      this.buffer.markSent(event.idempotencyKey);
      return result;
    } catch (error) {
      if (error instanceof TeidealError && error.statusCode !== undefined && error.statusCode < 500) {
        this.buffer.markSent(event.idempotencyKey);
      }
      throw error;
    }
  }

  private async deliver(idempotencyKey: string, payload: UsagePayload): Promise<SendResult> {
    let lastError: TeidealError | undefined;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      this.buffer.incrementAttempts(idempotencyKey);
      try {
        const response = await fetch(`${this.baseUrl}/usage`, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(this.requestTimeout),
        });
        const body = await this.readBody(response);
        if (response.status === 200 || response.status === 201) {
          return this.toResult(body, payload, response.status === 200);
        }
        const error = this.responseError(response.status, body);
        if (response.status < 500) {
          this.buffer.markSent(idempotencyKey);
          throw error;
        }
        lastError = error;
      } catch (error) {
        if (error instanceof TeidealError && error.statusCode !== undefined && error.statusCode < 500) throw error;
        lastError = error instanceof TeidealError
          ? error
          : new TeidealError(`network error: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
      if (attempt < 3) {
        const delay = this.retryBackoffs[attempt - 1];
        this.logger.warn("Teideal send retry attempt", { attempt: attempt + 1, maxAttempts: 3, idempotencyKey, error: lastError });
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw lastError ?? new TeidealError("Teideal delivery failed");
  }

  private async readBody(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!text) return undefined;
    try { return JSON.parse(text) as unknown; } catch { return text; }
  }

  private responseError(statusCode: number, response: unknown): TeidealError {
    const message = this.isApiBody(response) && typeof response.error === "string"
      ? response.error
      : `Teideal returned HTTP ${statusCode}`;
    return new TeidealError(message, { statusCode, response });
  }

  private toResult(response: unknown, payload: UsagePayload, duplicate: boolean): SendResult {
    if (!this.isApiBody(response) || typeof response.id !== "string") {
      throw new TeidealError("Teideal returned an invalid success response", { statusCode: 200, response });
    }
    return {
      id: response.id,
      customerId: typeof response.customer_id === "string" ? response.customer_id : undefined,
      eventType: typeof response.event_type === "string" ? response.event_type : undefined,
      quantity: typeof response.quantity === "number" ? response.quantity : undefined,
      idempotencyKey: typeof response.idempotency_key === "string" ? response.idempotency_key : payload.idempotency_key,
      occurredAt: typeof response.occurred_at === "string" ? response.occurred_at : undefined,
      duplicate,
    };
  }

  private isApiBody(value: unknown): value is ApiBody {
    return typeof value === "object" && value !== null;
  }

  private scheduleFlush(delay: number): void {
    if (this.closed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, delay);
    this.timer.unref();
  }
}
