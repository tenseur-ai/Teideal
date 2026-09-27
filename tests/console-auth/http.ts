export interface ApiResponse<T = any> {
  status: number;
  body: T;
}

export async function call(
  url: string,
  opts: { method?: string; apiKey?: string; adminKey?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<ApiResponse> {
  const headers: Record<string, string> = { ...opts.headers };
  // Fastify's default JSON body parser rejects a request that declares
  // application/json but sends no body at all (400, before any
  // preHandler runs) -- so this header is only set when there is a body.
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;
  if (opts.adminKey) headers["X-Internal-Admin-Key"] = opts.adminKey;

  const res = await fetch(url, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let body: any = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // leave as raw text
  }
  return { status: res.status, body };
}
