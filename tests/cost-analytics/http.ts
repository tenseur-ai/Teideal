export async function call(
  url: string,
  opts: { method?: string; token?: string; apiKey?: string; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";

  const response = await fetch(url, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  const text = await response.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }

  return { status: response.status, body };
}
