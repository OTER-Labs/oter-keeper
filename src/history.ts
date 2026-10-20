/**
 * The current UTC day's spending, read back from the account's own committed transactions.
 *
 * The local state file is the keeper's own ledger, but it cannot see a lost file or a second
 * keeper on the same account. At start the keeper therefore reads the account's history from
 * the Gateway for the day, keeps only transactions the account paid for and that call a method
 * this keeper calls, and takes the larger of that figure and its own for each limit.
 *
 * A failed read is not fatal. The local figures are kept, and the run holds back the one money
 * path (a dispute bond) because a count that cannot be checked must not be spent against.
 */

import { GatewayError, type Gateway } from "./gateway.ts";
import { formatXrd, parseXrd, utcDay } from "./limits.ts";
import type { StateFile } from "./state.ts";
import type { Logger } from "./tx.ts";

export class HistoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HistoryError";
  }
}

/** How many pages of the account stream are read before the read is called incomplete. */
export const HISTORY_PAGE_LIMIT = 20;
const DEFAULT_PAGE_SIZE = 100;

/** The methods the keeper itself calls, from the public calls table. */
export const KEEPER_METHODS: readonly string[] = [
  "finalize_request",
  "open_reveal_window",
  "redeem_bond_ticket",
  "dispute_resolution",
  "dispute_election_result",
  "open_vote",
  "burn_seat",
  "settle_distribution",
  "settle_grant",
  "collect_grant_refunds",
  "return_unclaimed",
  "deliver_fallback",
];

const DISPUTE_METHODS: ReadonlySet<string> = new Set([
  "dispute_resolution",
  "dispute_election_result",
]);

const LOCK_FEE_METHOD = "lock_fee";

export interface DayHistory {
  day: string;
  fees: bigint;
  disputes: number;
  /** Committed transactions the read inspected, kept for logging and tests. */
  transactions: number;
  pages: number;
}

export interface HistorySummary {
  ok: boolean;
  day: string;
  localFees: bigint;
  ledgerFees: bigint;
  fees: bigint;
  localDisputes: number;
  ledgerDisputes: number;
  disputes: number;
  error?: string;
}

export interface HistoryOptions {
  now?: () => Date;
  maxPages?: number;
  pageSize?: number;
}

interface StreamItem {
  transaction_status?: string;
  state_version?: number;
  intent_hash?: string;
  fee_paid?: string | number;
  manifest_instructions?: string;
  receipt?: {
    fee_summary?: Record<string, unknown>;
  };
}

interface StreamPage {
  items?: StreamItem[];
  next_cursor?: string | null;
}

interface ManifestCall {
  component: string;
  method: string;
}

/** The `CALL_METHOD Address("...") "method"` pairs in a manifest's instruction string. */
export function manifestCalls(manifest: string): ManifestCall[] {
  const calls: ManifestCall[] = [];
  const pattern = /CALL_METHOD\s+Address\("([^"]+)"\)\s+"([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(manifest)) !== null) {
    calls.push({ component: match[1] as string, method: match[2] as string });
  }
  return calls;
}

function feeOf(item: StreamItem): bigint {
  const paid = item.fee_paid;
  if (typeof paid === "string" && paid.trim() !== "") return parseXrd(paid);
  if (typeof paid === "number" && Number.isFinite(paid)) return parseXrd(paid);

  const summary = item.receipt?.fee_summary;
  if (summary === undefined) return 0n;
  let total = 0n;
  for (const key of [
    "xrd_total_execution_cost",
    "xrd_total_finalization_cost",
    "xrd_total_royalty_cost",
    "xrd_total_storage_cost",
    "xrd_total_tipping_cost",
  ]) {
    const value = summary[key];
    if (typeof value === "string" && value.trim() !== "") total += parseXrd(value);
  }
  return total;
}

function dayStart(day: string): string {
  return `${day}T00:00:00.000Z`;
}

/**
 * Read the account's committed transactions for the UTC day and total the keeper's own kind.
 *
 * A transaction counts only when its manifest pays the lock fee from the account and calls one
 * of `KEEPER_METHODS`. That excludes the account's other activity and transactions another
 * account paid for. Disputes are counted only from transactions that committed successfully,
 * because a failed call posts no bond.
 */
export async function readAccountHistory(
  gateway: Gateway,
  account: string,
  options: HistoryOptions = {},
): Promise<DayHistory> {
  const day = utcDay((options.now ?? (() => new Date()))());
  const maxPages = options.maxPages ?? HISTORY_PAGE_LIMIT;
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(maxPages) || maxPages <= 0) {
    throw new HistoryError("the history page cap must be a positive integer");
  }

  let fees = 0n;
  let disputes = 0;
  let transactions = 0;
  let pages = 0;
  let cursor: string | null = null;

  for (;;) {
    const body: Record<string, unknown> = {
      affected_global_entities_filter: [account],
      order: "Asc",
      limit_per_page: pageSize,
      opt_ins: {
        manifest_instructions: true,
        receipt_fee_summary: true,
        receipt_fee_source: true,
      },
    };
    if (cursor === null) {
      body["from_ledger_state"] = { timestamp: dayStart(day) };
    } else {
      body["cursor"] = cursor;
    }

    const page = await gateway.post<StreamPage>("/stream/transactions", body);
    pages += 1;

    for (const item of page.items ?? []) {
      const manifest = item.manifest_instructions;
      if (typeof manifest !== "string" || manifest === "") {
        // A user transaction always has a manifest. A Gateway that leaves it out would make
        // every figure read as zero, so the read fails rather than undercount.
        throw new HistoryError(
          "the Gateway returned a transaction without its manifest; treating today's figures as unread",
        );
      }

      const calls = manifestCalls(manifest);
      const paidByAccount = calls.some(
        (call) => call.method === LOCK_FEE_METHOD && call.component === account,
      );
      if (!paidByAccount) continue;

      const called = new Set(calls.map((call) => call.method));
      if (!KEEPER_METHODS.some((method) => called.has(method))) continue;

      transactions += 1;
      fees += feeOf(item);
      const succeeded =
        item.transaction_status === undefined || item.transaction_status === "CommittedSuccess";
      if (succeeded && [...DISPUTE_METHODS].some((method) => called.has(method))) {
        disputes += 1;
      }
    }

    const next = page.next_cursor;
    if (next === undefined || next === null || next === "") {
      return { day, fees, disputes, transactions, pages };
    }
    if (pages >= maxPages) {
      throw new HistoryError(
        `the account history did not end within ${maxPages} page(s); treating today's figures as unread`,
      );
    }
    cursor = next;
  }
}

/**
 * Read the day's history, raise the local figures to at least the ledger's, and log both.
 * `persist: false` reports the figures without writing the local ledger (`check` uses this).
 */
export async function loadDayHistory(
  state: StateFile,
  gateway: Gateway,
  account: string,
  logger: Logger,
  options: HistoryOptions & { persist?: boolean } = {},
): Promise<HistorySummary> {
  const day = utcDay((options.now ?? (() => new Date()))());
  const localFees = state.spent(day);
  const localDisputes = state.disputesToday(day);

  let ledger: DayHistory;
  try {
    ledger = await readAccountHistory(gateway, account, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const prefix =
      error instanceof GatewayError || error instanceof HistoryError
        ? "history read failed"
        : "history read failed unexpectedly";
    logger.warn(
      `${prefix}: ${message}; keeping the local figures, and disputes are report-only for this run`,
    );
    return {
      ok: false,
      day,
      localFees,
      ledgerFees: 0n,
      fees: localFees,
      localDisputes,
      ledgerDisputes: 0,
      disputes: localDisputes,
      error: message,
    };
  }

  const fees = ledger.fees > localFees ? ledger.fees : localFees;
  const disputes = Math.max(ledger.disputes, localDisputes);
  if (options.persist !== false) {
    state.raiseSpend(day, ledger.fees);
    state.raiseDisputes(day, ledger.disputes);
  }

  logger.info(
    `fees today: local ${formatXrd(localFees)}, ledger ${formatXrd(ledger.fees)}, using ${formatXrd(fees)}`,
  );
  logger.info(
    `disputes today: local ${localDisputes}, ledger ${ledger.disputes}, using ${disputes}`,
  );
  return {
    ok: true,
    day,
    localFees,
    ledgerFees: ledger.fees,
    fees,
    localDisputes,
    ledgerDisputes: ledger.disputes,
    disputes,
  };
}
