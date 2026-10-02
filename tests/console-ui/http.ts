export interface ApiResponse<T = unknown> { status: number; body: T; raw: string; }

export async function call<T = unknown>(url: string, options: { method?: string; token?: string; body?: unknown } = {}): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = {};
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(url, { method: options.method ?? "GET", headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  const raw = await response.text();
  let parsed: unknown = raw;
  try { parsed = raw ? JSON.parse(raw) : null; } catch { /* retain raw */ }
  return { status: response.status, body: parsed as T, raw };
}
