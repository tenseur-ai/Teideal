import { ConnectorError } from "./connector.js";

export interface ConnectorHttpClientConfig {
  baseUrl: string;
  requestsPerMinute?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  timeoutMs?: number;
}

export interface ConnectorHttpResponse {
  status: number;
  body: unknown;
}

export interface ConnectorHttpClient {
  get(path: string, headers?: Record<string, string>): Promise<ConnectorHttpResponse>;
}

function positive(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be greater than zero`);
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function isJsonContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
  return mediaType === "application/json" || mediaType.endsWith("+json");
}

function failureDetail(body: unknown, fallback: string): string {
  if (typeof body === "string" && body.trim()) return body.trim().slice(0, 500);
  if (body && typeof body === "object") {
    const error = (body as { error?: unknown }).error;
    if (typeof error === "string" && error.trim()) return error.trim().slice(0, 500);
  }
  return fallback;
}

export function createConnectorHttpClient(config: ConnectorHttpClientConfig): ConnectorHttpClient {
  const maxAttempts = config.maxAttempts ?? 5;
  const baseDelayMs = config.baseDelayMs ?? 1_000;
  const maxDelayMs = config.maxDelayMs ?? 60_000;
  const timeoutMs = config.timeoutMs ?? 30_000;
  positive("maxAttempts", maxAttempts);
  positive("baseDelayMs", baseDelayMs);
  positive("maxDelayMs", maxDelayMs);
  positive("timeoutMs", timeoutMs);
  if (!Number.isInteger(maxAttempts)) throw new Error("maxAttempts must be an integer");

  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  if (!baseUrl) throw new Error("baseUrl is required");

  const requestsPerMinute = config.requestsPerMinute;
  if (requestsPerMinute !== undefined) positive("requestsPerMinute", requestsPerMinute);

  // A one-token bucket preserves the configured rate as a hard upper bound;
  // every physical attempt (including retries) consumes a token.
  const refillPerMs = requestsPerMinute === undefined ? 0 : requestsPerMinute / 60_000;
  let tokens = 1;
  let lastRefillAt = Date.now();
  let limiterTail = Promise.resolve();

  async function acquireToken(): Promise<void> {
    if (requestsPerMinute === undefined) return;
    const previous = limiterTail;
    let release!: () => void;
    limiterTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      while (true) {
        const now = Date.now();
        tokens = Math.min(1, tokens + (now - lastRefillAt) * refillPerMs);
        lastRefillAt = now;
        if (tokens >= 1) {
          tokens -= 1;
          return;
        }
        await sleep(Math.max(1, Math.ceil((1 - tokens) / refillPerMs)));
      }
    } finally {
      release();
    }
  }

  async function attempt(path: string, headers: Record<string, string> | undefined): Promise<ConnectorHttpResponse> {
    await acquireToken();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${baseUrl}${path.startsWith("/") ? path : `/${path}`}`, {
        method: "GET",
        headers,
        signal: controller.signal,
      });
      const text = await response.text();
      let body: unknown = text;
      if (isJsonContentType(response.headers.get("content-type"))) {
        if (!text) {
          body = null;
        } else {
          try {
            body = JSON.parse(text) as unknown;
          } catch {
            throw new ConnectorError(
              `connector returned malformed JSON (HTTP ${response.status})`,
              response.status,
              true,
            );
          }
        }
      }
      if (response.status === 429 || response.status >= 500) {
        throw new ConnectorError(
          `connector request failed with HTTP ${response.status}: ${failureDetail(body, response.statusText || "retryable upstream error")}`,
          response.status,
          true,
        );
      }
      if (response.status >= 400 && response.status < 500) {
        throw new ConnectorError(
          `connector request failed with HTTP ${response.status}: ${failureDetail(body, response.statusText || "request rejected")}`,
          response.status,
          false,
        );
      }
      return { status: response.status, body };
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      const timedOut = controller.signal.aborted;
      const detail = error instanceof Error ? error.message : String(error);
      throw new ConnectorError(
        timedOut ? `connector request timed out after ${timeoutMs}ms` : `connector network error: ${detail}`,
        timedOut ? 408 : 0,
        true,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    async get(path, headers) {
      let lastError: ConnectorError | undefined;
      for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber += 1) {
        try {
          return await attempt(path, headers);
        } catch (error) {
          const connectorError = error instanceof ConnectorError
            ? error
            : new ConnectorError(`connector request failed: ${String(error)}`, 0, true);
          if (!connectorError.retryable) throw connectorError;
          lastError = connectorError;
          if (attemptNumber < maxAttempts) {
            const delayMs = Math.min(baseDelayMs * 2 ** (attemptNumber - 1), maxDelayMs);
            await sleep(delayMs);
          }
        }
      }
      throw new ConnectorError(
        `connector request failed after ${maxAttempts} attempts: ${lastError?.message ?? "unknown error"}`,
        lastError?.statusCode ?? 0,
        false,
      );
    },
  };
}
