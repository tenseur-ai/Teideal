export interface ApiResponse<T = any> {
  status: number;
  body: T;
}

export async function call<T = any>(
  url: string,
  options: { method?: string; token?: string; body?: unknown } = {},
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = {};
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let body: unknown = text;
  try { body = text ? JSON.parse(text) as unknown : null; } catch { /* retain text */ }
  return { status: response.status, body: body as T };
}
