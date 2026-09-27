// Matches db/seed-console-auth-fixtures.sh exactly.
export const TENANT_KEY = "acct_1001";

export const OWNER = { email: "owner@acmeco.com", password: "OwnerPass123!", mfaSecret: "JBSWY3DPEHPK3PXP", role: "Owner" };
export const BILLING = { email: "billing@acmeco.com", password: "BillingPass123!", mfaSecret: "KRSXG5CTMVRXEZLU", role: "Billing Admin" };
export const FINANCE = { email: "finance@acmeco.com", password: "FinancePass123!", role: "Finance" };
export const SUPPORT = { email: "support@acmeco.com", password: "SupportPass123!", role: "Support" };
