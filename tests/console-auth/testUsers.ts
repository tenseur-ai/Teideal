import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { withTenant } from "./db.js";
import { TENANT_KEY } from "./fixtures.js";

const TENANT1_ID = "00000000-0000-0000-0000-000000001001";

export interface DisposableUser {
  id: string;
  tenantKey: string;
  email: string;
  password: string;
}

// Most TEID-91 tests mutate account state (lockouts, MFA enrollment, idle
// timeouts) that would corrupt other tests if they shared the seeded
// fixture users. Each test that mutates state gets its own throwaway
// account instead; only read-mostly checks reuse the seeded Owner/Billing
// Admin fixtures (which stay in a known-good state).
export async function createDisposableUser(role: "Owner" | "Billing Admin" | "Finance" | "Support" | "Developer"): Promise<DisposableUser> {
  const id = randomUUID();
  const email = `test-${id}@acmeco.com`;
  const password = `Passw0rd!${id.slice(0, 8)}`;
  const passwordHash = await bcrypt.hash(password, 10);

  await withTenant(TENANT1_ID, async (client) => {
    await client.query(
      `INSERT INTO users (id, tenant_id, email, password_hash, role) VALUES ($1, $2, $3, $4, $5)`,
      [id, TENANT1_ID, email, passwordHash, role],
    );
  });

  return { id, tenantKey: TENANT_KEY, email, password };
}

// Sets MFA directly for tests that need an already-enrolled disposable
// user without re-proving the enrollment flow itself (covered by
// mfa-enrollment.test.ts).
export async function enrollMfaDirectly(userId: string, secretBase32: string): Promise<void> {
  await withTenant(TENANT1_ID, async (client) => {
    await client.query(`UPDATE users SET mfa_secret = $1, mfa_enrolled_at = now() WHERE id = $2`, [secretBase32, userId]);
  });
}
