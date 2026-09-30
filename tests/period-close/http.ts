export interface ApiResponse<T = any> {
  status: number;
  body: T;
  headers: Headers;
  bytes: Buffer;
}

export async function call(
  url: string,
  options: { method?: string; token?: string; apiKey?: string; body?: unknown } = {},
): Promise<ApiResponse> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const credential = options.token ?? options.apiKey;
  if (credential) headers.Authorization = `Bearer ${credential}`;
  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get("content-type") ?? "";
  let body: any = bytes;
  if (contentType.includes("json")) {
    body = bytes.length === 0 ? null : JSON.parse(bytes.toString("utf8"));
  } else if (contentType.startsWith("text/")) {
    body = bytes.toString("utf8");
  }
  return { status: response.status, body, headers: response.headers, bytes };
}
