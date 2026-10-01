import type { PoolClient } from "pg";

export interface CostRate {
  id: string;
  tenant_id: string;
  model: string;
  metric: string;
  rate_per_unit: string;
  unit_size: number;
  effective_from: string;
  created_at: string;
}

export interface CreateCostRateInput {
  model: string;
  metric: string;
  rate_per_unit: number;
  unit_size: number;
  effective_from: string;
}

export function validateCostRateInput(input: unknown): { error: string } | CreateCostRateInput {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { error: "request body must be an object" };
  }
  const obj = input as Record<string, unknown>;

  if (typeof obj.model !== "string" || obj.model.trim() === "") {
    return { error: "model must be a non-empty string" };
  }
  if (typeof obj.metric !== "string" || obj.metric.trim() === "") {
    return { error: "metric must be a non-empty string" };
  }

  let ratePerUnit: number;
  if (typeof obj.rate_per_unit === "number") {
    ratePerUnit = obj.rate_per_unit;
  } else if (typeof obj.rate_per_unit === "string" && obj.rate_per_unit.trim() !== "") {
    ratePerUnit = Number(obj.rate_per_unit);
  } else {
    return { error: "rate_per_unit must be a non-negative number" };
  }
  if (!Number.isFinite(ratePerUnit) || ratePerUnit < 0) {
    return { error: "rate_per_unit must be a non-negative number" };
  }

  let unitSize = 1;
  if (obj.unit_size !== undefined && obj.unit_size !== null) {
    if (typeof obj.unit_size === "number") {
      unitSize = obj.unit_size;
    } else if (typeof obj.unit_size === "string" && obj.unit_size.trim() !== "") {
      unitSize = Number(obj.unit_size);
    } else {
      return { error: "unit_size must be a positive integer" };
    }
    if (!Number.isInteger(unitSize) || unitSize <= 0) {
      return { error: "unit_size must be a positive integer" };
    }
  }

  if (typeof obj.effective_from !== "string" || obj.effective_from.trim() === "") {
    return { error: "effective_from must be a valid ISO timestamp string" };
  }
  const parsedDate = new Date(obj.effective_from);
  if (Number.isNaN(parsedDate.getTime())) {
    return { error: "effective_from must be a valid ISO timestamp string" };
  }

  return {
    model: obj.model.trim(),
    metric: obj.metric.trim(),
    rate_per_unit: ratePerUnit,
    unit_size: unitSize,
    effective_from: parsedDate.toISOString(),
  };
}

export async function insertCostRate(
  client: PoolClient,
  tenantId: string,
  input: CreateCostRateInput,
): Promise<{ kind: "created"; rate: CostRate } | { kind: "conflict" }> {
  try {
    const res = await client.query<CostRate>(
      `INSERT INTO cost_rates (tenant_id, model, metric, rate_per_unit, unit_size, effective_from)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, tenant_id, model, metric, rate_per_unit::text, unit_size, effective_from, created_at`,
      [tenantId, input.model, input.metric, input.rate_per_unit, input.unit_size, input.effective_from],
    );
    return { kind: "created", rate: res.rows[0] };
  } catch (err: unknown) {
    if (typeof err === "object" && err !== null && "code" in err && err.code === "23505") {
      return { kind: "conflict" };
    }
    throw err;
  }
}

export async function listCostRates(
  client: PoolClient,
  tenantId: string,
  filter?: { model?: string; metric?: string },
): Promise<CostRate[]> {
  const params: unknown[] = [tenantId];
  let query = `SELECT id, tenant_id, model, metric, rate_per_unit::text, unit_size, effective_from, created_at
               FROM cost_rates
               WHERE tenant_id = $1`;

  if (filter?.model) {
    params.push(filter.model);
    query += ` AND model = $${params.length}`;
  }
  if (filter?.metric) {
    params.push(filter.metric);
    query += ` AND metric = $${params.length}`;
  }

  query += ` ORDER BY effective_from DESC, created_at DESC`;

  const res = await client.query<CostRate>(query, params);
  return res.rows;
}

export interface ResolveEventCostInput {
  model?: string | null;
  event_type?: string;
  quantity?: number | string;
  actual_cost?: number | string | null;
  occurred_at?: string | Date;
}

// Cost is always returned as a decimal string -- this codebase never
// converts a money amount to a JS `number` (the whole reason TEID-94/95
// exist is to eliminate exactly this class of float-precision bug). Both
// the actual_cost override and the rate-table lookup push their
// arithmetic into Postgres NUMERIC, which is exact decimal, not float64.
export async function resolveEventCost(
  client: PoolClient,
  tenantId: string,
  event: ResolveEventCostInput,
): Promise<string | null> {
  // AC2 / T2: If event carries an explicit actual_cost, use it directly.
  if (event.actual_cost !== undefined && event.actual_cost !== null && event.actual_cost !== "") {
    try {
      const normalized = await client.query<{ cost: string }>(
        `SELECT $1::numeric::text AS cost`,
        [String(event.actual_cost)],
      );
      return normalized.rows[0].cost;
    } catch {
      return null;
    }
  }

  if (!event.model || !event.event_type || !event.occurred_at) {
    return null;
  }

  const occurredAtDate = typeof event.occurred_at === "string" ? new Date(event.occurred_at) : event.occurred_at;
  if (Number.isNaN(occurredAtDate.getTime())) {
    return null;
  }

  const quantity = event.quantity ?? 1;
  const res = await client.query<{ cost: string }>(
    `SELECT (rate_per_unit * $4::numeric / unit_size)::text AS cost
     FROM cost_rates
     WHERE tenant_id = $1 AND model = $2 AND metric = $3 AND effective_from <= $5
     ORDER BY effective_from DESC
     LIMIT 1`,
    [tenantId, event.model, event.event_type, String(quantity), occurredAtDate.toISOString()],
  );

  if (res.rows.length === 0) {
    return null;
  }
  return res.rows[0].cost;
}
