/**
 * Spending limits, checked before every submit.
 *
 * Amounts are kept in atto-XRD (1e-18 XRD) so a day of small fees cannot drift through
 * floating-point addition. The day is UTC; the ledger is local to this keeper, which is the
 * best a stateless command-line tool can do without an indexer.
 */

import { StateFile } from "./state.ts";

export interface LimitsOptions {
  maxFeePerTx: bigint;
  maxFeePerDay: bigint;
  reserveFloor: bigint;
  now?: () => Date;
}

export interface LimitDecision {
  allowed: boolean;
  reason?: string;
}

const ATTOS_PER_XRD = 10n ** 18n;

function expandExponential(input: string): string {
  if (!/[eE]/.test(input)) return input;
  const [mantissa = "0", exponentText = "0"] = input.split(/[eE]/);
  const exponent = Number(exponentText);
  if (!Number.isInteger(exponent)) return input;
  const negative = mantissa.startsWith("-");
  const unsigned = negative ? mantissa.slice(1) : mantissa;
  const [integer = "0", fraction = ""] = unsigned.split(".");
  const digits = `${integer}${fraction}`;
  const point = integer.length + exponent;
  const expanded =
    point <= 0
      ? `0.${"0".repeat(-point)}${digits}`
      : point >= digits.length
        ? `${digits}${"0".repeat(point - digits.length)}`
        : `${digits.slice(0, point)}.${digits.slice(point)}`;
  return negative ? `-${expanded}` : expanded;
}

/** Parse an XRD amount from a string, number or bigint into atto-XRD. */
export function parseXrd(value: string | number | bigint): bigint {
  if (typeof value === "bigint") return value * ATTOS_PER_XRD;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error("an XRD amount must be a non-negative finite number");
    }
    return parseXrd(expandExponential(value.toString()));
  }

  const cleaned = value.trim();
  if (!/^\d+(\.\d+)?$/.test(cleaned)) {
    throw new Error(`"${value}" is not a non-negative XRD amount`);
  }
  const [integer = "0", fraction = ""] = cleaned.split(".");
  if (fraction.length > 18) {
    throw new Error("an XRD amount has at most 18 decimal places");
  }
  return BigInt(`${integer}${fraction.padEnd(18, "0")}`);
}

/** Format atto-XRD as a plain decimal string with no trailing zeros. */
export function formatXrd(attos: bigint): string {
  if (attos < 0n) throw new Error("an XRD amount cannot be negative");
  const integer = attos / ATTOS_PER_XRD;
  const fraction = (attos % ATTOS_PER_XRD).toString().padStart(18, "0").replace(/0+$/, "");
  return fraction === "" ? integer.toString() : `${integer}.${fraction}`;
}

export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export class Limits {
  private readonly state: StateFile;
  private readonly options: LimitsOptions;
  private readonly now: () => Date;

  constructor(state: StateFile, options: LimitsOptions) {
    this.state = state;
    this.options = options;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Decide whether one transaction at `fee` atto-XRD may be submitted. `balance` is the
   * account's current XRD balance in atto-XRD; when it is omitted the reserve floor cannot
   * be checked and is not enforced here.
   */
  check(fee: bigint, balance?: bigint): LimitDecision {
    if (fee > this.options.maxFeePerTx) {
      return {
        allowed: false,
        reason: `the fee ${formatXrd(fee)} XRD exceeds the per-transaction limit ${formatXrd(this.options.maxFeePerTx)} XRD`,
      };
    }

    const day = utcDay(this.now());
    const spent = this.state.spent(day);
    if (spent + fee > this.options.maxFeePerDay) {
      return {
        allowed: false,
        reason: `the fee ${formatXrd(fee)} XRD would take today's spend to ${formatXrd(spent + fee)} XRD, over the daily limit ${formatXrd(this.options.maxFeePerDay)} XRD`,
      };
    }

    if (balance !== undefined && balance - fee < this.options.reserveFloor) {
      return {
        allowed: false,
        reason: `the fee ${formatXrd(fee)} XRD would leave ${formatXrd(balance - fee)} XRD, under the reserve floor ${formatXrd(this.options.reserveFloor)} XRD`,
      };
    }

    return { allowed: true };
  }

  /** Record a fee as spent. Called only after the Gateway accepted a submit. */
  record(fee: bigint): void {
    this.state.addSpend(utcDay(this.now()), fee);
  }
}
