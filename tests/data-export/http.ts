export interface ApiResponse<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

export async function call(
  url: string,
  options: { method?: string; token?: string; body?: unknown } = {},
): Promise<ApiResponse> {
  const headers: Record<string, string> = {};
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let parsed: any = text;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* raw text */ }
  return { status: response.status, body: parsed, headers: response.headers };
}

export async function download(url: string, token: string): Promise<{ status: number; bytes: Buffer; headers: Headers }> {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  return { status: response.status, bytes: Buffer.from(await response.arrayBuffer()), headers: response.headers };
}

