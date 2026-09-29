import {
  resolveEffectiveOrder,
  sortGrantsForDraw,
  type ConsumptionLine,
  type ConsumptionSource,
  type DrawableGrant,
} from "./consumptionOrder.js";

export interface ReplayableConsumeInput {
  id: string;
  customerId: string;
  occurredAt: Date;
  amount: number;
  unit: string;
}

export interface ReplayedConsumption {
  id: string;
  customer_id: string;
  requested_amount: number;
  unit: string;
  occurred_at: string;
  lines: ConsumptionLine[];
}

export interface ReplayGrantBalance {
  grant_id: string;
  source_category: ConsumptionSource;
  remaining_amount: number;
}

export interface ReplayTotals {
  commit_amount: number;
  overage_amount: number;
  overage_amount_due: number;
}

export interface ReplayResult {
  consumptions: ReplayedConsumption[];
  grants: ReplayGrantBalance[];
  totals: ReplayTotals;
}

function compareEvents(left: ReplayableConsumeInput, right: ReplayableConsumeInput): number {
  const occurred = left.occurredAt.getTime() - right.occurredAt.getTime();
  if (occurred !== 0) return occurred;
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

/**
 * Recomputes consumption from a caller-provided starting grant snapshot.
 *
 * Events are ordered by occurred_at and then by their immutable usage-event
 * id. The UUID tie-break makes an exact timestamp tie repeatable without
 * changing the live endpoint's lock-winner behavior.
 */
export function replayConsumption(
  events: readonly ReplayableConsumeInput[],
  startingGrants: readonly DrawableGrant[],
  override: readonly ConsumptionSource[] | null = null,
  planOrder: readonly ConsumptionSource[] | null = null,
): ReplayResult {
  const orderedEvents = [...events].sort(compareEvents);
  const grants = startingGrants.map((grant) => ({ ...grant }));
  const consumptions: ReplayedConsumption[] = [];
  const totals: ReplayTotals = { commit_amount: 0, overage_amount: 0, overage_amount_due: 0 };

  for (const event of orderedEvents) {
    const eligibleGrants = grants.filter((grant) => grant.remaining_amount > 0);
    const eligibleSources = new Set(eligibleGrants.map((grant) => grant.source));
    const order = resolveEffectiveOrder(override, planOrder, eligibleSources);
    const sortedGrants = sortGrantsForDraw(eligibleGrants, order);
    const lines: ConsumptionLine[] = [];
    let needed = event.amount;
    let lastCommitOverageRate: number | null = null;

    for (const grant of sortedGrants) {
      if (needed <= 0) break;
      const take = Math.min(needed, grant.remaining_amount);
      if (!(take > 0)) continue;
      grant.remaining_amount -= take;
      needed -= take;
      if (grant.source === "commit") {
        lastCommitOverageRate = grant.overage_rate;
        totals.commit_amount += take;
      }
      lines.push({ grant_id: grant.id, source_category: grant.source, amount: take });
    }

    if (needed > 0) {
      const overage: ConsumptionLine = { grant_id: null, source_category: "overage", amount: needed };
      const overageAmountDue = lastCommitOverageRate === null ? null : needed * lastCommitOverageRate;
      if (overageAmountDue !== null) {
        overage.overage_amount_due = overageAmountDue;
        totals.overage_amount_due += overageAmountDue;
      }
      totals.overage_amount += needed;
      lines.push(overage);
    }

    consumptions.push({
      id: event.id,
      customer_id: event.customerId,
      requested_amount: event.amount,
      unit: event.unit,
      occurred_at: event.occurredAt.toISOString(),
      lines,
    });
  }

  return {
    consumptions,
    grants: grants
      .map((grant) => ({
        grant_id: grant.id,
        source_category: grant.source,
        remaining_amount: grant.remaining_amount,
      }))
      .sort((left, right) => left.grant_id.localeCompare(right.grant_id)),
    totals,
  };
}
