import { TS_CONSOLE_URL } from "./env.js";
import { call } from "./http.js";

export async function passwordSession(email: string, password: string): Promise<string> {
  const response = await call(`${TS_CONSOLE_URL}/auth/login`, {
    method: "POST",
    body: { tenant_key: "acct_1001", email, password },
  });
  if (response.status !== 200 || response.body.status !== "authenticated") {
    throw new Error(`login failed for ${email}: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return response.body.session_token;
}

export function financeSession(): Promise<string> {
  return passwordSession("finance@acmeco.com", "FinancePass123!");
}

export function supportSession(): Promise<string> {
  return passwordSession("support@acmeco.com", "SupportPass123!");
}
