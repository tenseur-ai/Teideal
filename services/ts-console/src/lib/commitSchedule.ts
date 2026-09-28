// Tranche size and release dates for a commit grant. Shared by insertGrant
// and processCommitDrawdowns so the first tranche and every later release
// use the same division and the same UTC anniversary arithmetic.
//
// Amounts are split in fixed-point (12 decimal places). Unconstrained
// NUMERIC has no scale of its own; 12 places is the precision this code
// writes, the last tranche absorbs whatever is left, and the stored sum
// equals the original amount exactly.

export type DrawdownSchedule = "upfront" | "monthly" | "quarterly";

export interface TrancheRequest {
  amount: string | number;
  startDate: Date;
  expiryDate: Date | null;
  drawdownSchedule: DrawdownSchedule;
  trancheIndex: number;
}

export interface TrancheResult {
  trancheAmount: string;
  nextReleaseAt: Date | null;
}

const SCALE = 12;
const SCALE_FACTOR = 10n ** BigInt(SCALE);

export function monthsBetween(start: Date, end: Date): number {
  let months =
    end.getUTCFullYear() * 12 + end.getUTCMonth() - (start.getUTCFullYear() * 12 + start.getUTCMonth());
  const endDay = end.getUTCDate();
  const startDay = start.getUTCDate();
  if (endDay < startDay) {
    months -= 1;
  } else if (endDay === startDay && timeOfDayMs(end) < timeOfDayMs(start)) {
    months -= 1;
  }
  return months;
}

export function addUtcMonths(date: Date, months: number): Date {
  const monthIndex = date.getUTCFullYear() * 12 + date.getUTCMonth() + months;
  const year = Math.floor(monthIndex / 12);
  const month = monthIndex - year * 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(date.getUTCDate(), lastDay);
  return new Date(Date.UTC(
    year,
    month,
    day,
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
    date.getUTCMilliseconds(),
  ));
}

export function trancheCount(start: Date, expiry: Date, schedule: "monthly" | "quarterly"): number {
  const interval = schedule === "monthly" ? 1 : 3;
  const months = monthsBetween(start, expiry);
  return Math.max(1, Math.floor(months / interval) + 1);
}

export function computeNextTranche(request: TrancheRequest): TrancheResult {
  const amount = canonicalAmount(request.amount);
  if (request.drawdownSchedule === "upfront") {
    if (request.trancheIndex !== 0) throw new Error("upfront commit has a single tranche");
    return { trancheAmount: amount, nextReleaseAt: null };
  }
  if (!request.expiryDate) throw new Error("monthly or quarterly commit requires expiry_date");
  const count = trancheCount(request.startDate, request.expiryDate, request.drawdownSchedule);
  if (request.trancheIndex < 0 || request.trancheIndex >= count) {
    throw new Error("tranche index is outside the schedule");
  }
  const interval = request.drawdownSchedule === "monthly" ? 1 : 3;
  const parts = splitAmount(amount, count);
  const trancheAmount = request.trancheIndex === count - 1 ? parts.last : parts.regular;
  const nextReleaseAt = request.trancheIndex === count - 1
    ? null
    : addUtcMonths(request.startDate, interval * (request.trancheIndex + 1));
  return { trancheAmount, nextReleaseAt };
}

function timeOfDayMs(date: Date): number {
  return ((date.getUTCHours() * 60 + date.getUTCMinutes()) * 60 + date.getUTCSeconds()) * 1000
    + date.getUTCMilliseconds();
}

function canonicalAmount(amount: string | number): string {
  if (typeof amount === "number") {
    if (!Number.isFinite(amount)) throw new Error("amount is not finite");
    return Number.isInteger(amount) ? String(amount) : amount.toString();
  }
  return amount;
}

function parseDecimalToScaled(text: string): bigint {
  const negative = text.startsWith("-");
  const raw = negative ? text.slice(1) : text;
  if (!/^\d+(\.\d+)?$/.test(raw)) throw new Error(`amount is not a decimal: ${text}`);
  const [whole, frac = ""] = raw.split(".");
  const fracDigits = (frac + "0".repeat(SCALE)).slice(0, SCALE);
  const scaled = BigInt(whole) * SCALE_FACTOR + BigInt(fracDigits);
  return negative ? -scaled : scaled;
}

function formatScaled(scaled: bigint): string {
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  const digits = abs.toString().padStart(SCALE + 1, "0");
  const whole = digits.slice(0, -SCALE).replace(/^0+(?=\d)/, "");
  const frac = digits.slice(-SCALE).replace(/0+$/, "");
  const text = frac.length > 0 ? `${whole}.${frac}` : whole;
  return negative ? `-${text}` : text;
}

function splitAmount(amount: string, count: number): { regular: string; last: string } {
  const scaled = parseDecimalToScaled(amount);
  const regularScaled = scaled / BigInt(count);
  const lastScaled = scaled - regularScaled * BigInt(count - 1);
  return { regular: formatScaled(regularScaled), last: formatScaled(lastScaled) };
}
