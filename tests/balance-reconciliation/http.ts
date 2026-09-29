export interface ApiResponse<T = any> {
  status: number;
  body: T;
}

export async function call(
  url: string,
  opts: { method?: string; apiKey?: string; body?: unknown } = {},
): Promise<ApiResponse> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;
  const response = await fetch(url, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await response.text();
  let body: any = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Preserve non-JSON failures for useful assertions.
  }
  return { status: response.status, body };
}
