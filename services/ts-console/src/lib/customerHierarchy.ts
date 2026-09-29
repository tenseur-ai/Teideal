import type { PoolClient } from "pg";
import { recordConfigChangeWithClient } from "./audit.js";

export type BalanceMode = "pooled" | "isolated";

export type HierarchyLimitResult =
  | { ok: true }
  | { ok: false; governingCustomerId: string; available: number };

export type HierarchyMoveFailure = "customer_not_found" | "parent_not_found" | "cycle";

export class HierarchyMoveError extends Error {
  readonly reason: HierarchyMoveFailure;

  constructor(reason: HierarchyMoveFailure) {
    super(reason);
    this.name = "HierarchyMoveError";
    this.reason = reason;
  }
}

export interface CustomerTreeKey {
  id: string;
  label: string;
  display_hint: string;
  scope: string;
  environment: string;
}

export interface CustomerTreeNode {
  id: string;
  name: string;
  balance_mode: BalanceMode;
  children: CustomerTreeNode[];
  api_keys: CustomerTreeKey[];
}

interface FlatCustomer {
  id: string;
  parent_customer_id: string | null;
  name: string;
  balance_mode: BalanceMode;
}

interface TreeKeyRow extends CustomerTreeKey {
  customer_id: string;
}

interface LimitRow {
  chain_length: string;
  customer_id: string | null;
  available: string | null;
}

// Walks upward while the current node is pooled. The first isolated node is
// the debit target. The schema forces the root to be isolated, so the walk
// always ends.
const RESOLVE_SQL = `
  WITH RECURSIVE chain AS (
    SELECT id, parent_customer_id, balance_mode, 0 AS depth, ARRAY[id] AS path
    FROM customers
    WHERE id = $1 AND tenant_id = $2
    UNION ALL
    SELECT c.id, c.parent_customer_id, c.balance_mode, chain.depth + 1, chain.path || c.id
    FROM customers c
    JOIN chain ON c.id = chain.parent_customer_id
    WHERE chain.balance_mode = 'pooled'
      AND c.tenant_id = $2
      AND NOT (c.id = ANY(chain.path))
  )
  SELECT id
  FROM chain
  WHERE balance_mode = 'isolated' OR parent_customer_id IS NULL
  ORDER BY depth
  LIMIT 1
`;

// One recursive read of the whole ancestor chain, then each grant-bearing
// node's remaining total. The minimum below `amount` governs. The path array
// stops a corrupt cycle from looping; moves reject cycles before they exist.
const CHECK_SQL = `
  WITH RECURSIVE chain AS (
    SELECT id, parent_customer_id, balance_mode, 0 AS depth, ARRAY[id] AS path
    FROM customers
    WHERE id = $1 AND tenant_id = $2
    UNION ALL
    SELECT c.id, c.parent_customer_id, c.balance_mode, chain.depth + 1, chain.path || c.id
    FROM customers c
    JOIN chain ON c.id = chain.parent_customer_id
    WHERE c.tenant_id = $2
      AND NOT (c.id = ANY(chain.path))
  ),
  balances AS (
    SELECT chain.id AS customer_id,
           chain.depth,
           SUM(g.remaining_amount) AS available
    FROM chain
    JOIN grants g
      ON g.customer_id = chain.id
     AND g.tenant_id = $2
     AND g.status = 'active'
     AND g.start_date <= $3::timestamptz
     AND (g.expiry_date IS NULL OR g.expiry_date > $3::timestamptz)
    GROUP BY chain.id, chain.depth
  ),
  limiting AS (
    SELECT customer_id, available
    FROM balances
    WHERE available < $4::numeric
    ORDER BY available ASC, depth ASC
    LIMIT 1
  )
  SELECT (SELECT COUNT(*) FROM chain)::text AS chain_length,
         limiting.customer_id,
         limiting.available::text AS available
  FROM (SELECT 1) AS seed
  LEFT JOIN limiting ON true
`;

const TREE_SQL = `
  WITH RECURSIVE subtree AS (
    SELECT id, parent_customer_id, name, balance_mode, 0 AS depth, ARRAY[id] AS path
    FROM customers
    WHERE id = $1 AND tenant_id = $2
    UNION ALL
    SELECT c.id, c.parent_customer_id, c.name, c.balance_mode, subtree.depth + 1, subtree.path || c.id
    FROM customers c
    JOIN subtree ON c.parent_customer_id = subtree.id
    WHERE c.tenant_id = $2
      AND NOT (c.id = ANY(subtree.path))
  )
  SELECT id, parent_customer_id, name, balance_mode
  FROM subtree
  ORDER BY depth, name, id
`;

export async function customerIsNested(
  client: PoolClient,
  tenantId: string,
  customerId: string,
): Promise<boolean> {
  const { rows } = await client.query<{ nested: boolean }>(
    `SELECT parent_customer_id IS NOT NULL AS nested
     FROM customers
     WHERE id = $1 AND tenant_id = $2`,
    [customerId, tenantId],
  );
  return rows[0]?.nested === true;
}

export async function resolveBillingCustomerId(
  client: PoolClient,
  tenantId: string,
  customerId: string,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>({
    name: "teid22_resolve_billing_customer",
    text: RESOLVE_SQL,
    values: [customerId, tenantId],
  });
  if (!rows[0]) throw new Error("customer not found for hierarchy resolution");
  return rows[0].id;
}

export async function checkHierarchyLimits(
  client: PoolClient,
  tenantId: string,
  customerId: string,
  amount: number,
  asOf: Date,
): Promise<HierarchyLimitResult> {
  const { rows } = await client.query<LimitRow>({
    name: "teid22_check_hierarchy_limits",
    text: CHECK_SQL,
    values: [customerId, tenantId, asOf, String(amount)],
  });
  const row = rows[0];
  if (!row || Number(row.chain_length) === 0) {
    throw new Error("customer not found for hierarchy limit check");
  }
  if (!row.customer_id || row.available === null) return { ok: true };
  return {
    ok: false,
    governingCustomerId: row.customer_id,
    available: Number(row.available),
  };
}

// Same predicate and ORDER BY id as lockEligibleGrants. Taking that lock
// before the ceiling read makes a concurrent debit wait, so the check sees
// the remaining balance the unmodified draw will use. Zero-remaining grants
// are not locked there either; they still count as a zero in the ceiling sum.
export async function lockBillingGrants(
  client: PoolClient,
  tenantId: string,
  billingCustomerId: string,
  asOf: Date,
): Promise<void> {
  await client.query(
    `SELECT id
     FROM grants
     WHERE customer_id = $1
       AND tenant_id = $2
       AND status = 'active'
       AND start_date <= $3::timestamptz
       AND (expiry_date IS NULL OR expiry_date > $3::timestamptz)
       AND remaining_amount > 0
     ORDER BY id
     FOR UPDATE`,
    [billingCustomerId, tenantId, asOf],
  );
}

export async function moveCustomer(
  client: PoolClient,
  tenantId: string,
  customerId: string,
  newParentCustomerId: string,
  userId: string,
): Promise<void> {
  const current = await client.query<{ parent_customer_id: string | null }>(
    `SELECT parent_customer_id
     FROM customers
     WHERE id = $1 AND tenant_id = $2
     FOR UPDATE`,
    [customerId, tenantId],
  );
  if (!current.rows[0]) throw new HierarchyMoveError("customer_not_found");

  const cycle = await client.query<{ parent_visible: boolean; cycle: boolean }>(
    `WITH RECURSIVE ancestors AS (
       SELECT id, parent_customer_id, ARRAY[id] AS path
       FROM customers
       WHERE id = $1 AND tenant_id = $2
       UNION ALL
       SELECT c.id, c.parent_customer_id, ancestors.path || c.id
       FROM customers c
       JOIN ancestors ON c.id = ancestors.parent_customer_id
       WHERE c.tenant_id = $2
         AND NOT (c.id = ANY(ancestors.path))
     )
     SELECT
       EXISTS (SELECT 1 FROM customers WHERE id = $1 AND tenant_id = $2) AS parent_visible,
       EXISTS (SELECT 1 FROM ancestors WHERE id = $3) AS cycle`,
    [newParentCustomerId, tenantId, customerId],
  );
  const verdict = cycle.rows[0];
  if (!verdict?.parent_visible) throw new HierarchyMoveError("parent_not_found");
  if (verdict.cycle) throw new HierarchyMoveError("cycle");

  const oldParent = current.rows[0].parent_customer_id;
  await client.query(
    `UPDATE customers
     SET parent_customer_id = $3, updated_at = now()
     WHERE id = $1 AND tenant_id = $2`,
    [customerId, tenantId, newParentCustomerId],
  );
  await client.query(
    `INSERT INTO customer_hierarchy_moves (
       tenant_id, customer_id, old_parent_customer_id, new_parent_customer_id, moved_by_user_id
     ) VALUES ($1, $2, $3, $4, $5)`,
    [tenantId, customerId, oldParent, newParentCustomerId, userId],
  );
  await recordConfigChangeWithClient(client, tenantId, { userId }, {
    objectType: "Customer",
    objectId: customerId,
    customerId,
    before: { parent_customer_id: oldParent },
    after: { parent_customer_id: newParentCustomerId },
  });
}

export async function readCustomerTree(
  client: PoolClient,
  tenantId: string,
  rootId: string,
): Promise<CustomerTreeNode | null> {
  const nodes = await client.query<FlatCustomer>(TREE_SQL, [rootId, tenantId]);
  if (nodes.rows.length === 0) return null;

  const ids = nodes.rows.map((row) => row.id);
  const keys = await client.query<TreeKeyRow>(
    `SELECT id, label, display_hint, scope, environment, customer_id
     FROM api_keys
     WHERE issued_to_tenant_id = $1 AND customer_id = ANY($2::uuid[])
     ORDER BY id`,
    [tenantId, ids],
  );

  const byId = new Map<string, CustomerTreeNode>();
  for (const row of nodes.rows) {
    byId.set(row.id, {
      id: row.id,
      name: row.name,
      balance_mode: row.balance_mode,
      children: [],
      api_keys: [],
    });
  }
  for (const key of keys.rows) {
    byId.get(key.customer_id)?.api_keys.push({
      id: key.id,
      label: key.label,
      display_hint: key.display_hint,
      scope: key.scope,
      environment: key.environment,
    });
  }

  let root: CustomerTreeNode | null = null;
  for (const row of nodes.rows) {
    const node = byId.get(row.id);
    if (!node) continue;
    if (row.id === rootId) {
      root = node;
      continue;
    }
    if (row.parent_customer_id) byId.get(row.parent_customer_id)?.children.push(node);
  }
  return root;
}
