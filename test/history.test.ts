import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { PrivateKey } from "@radixdlt/radix-engine-toolkit";

import {
  HISTORY_PAGE_LIMIT,
  HistoryError,
  loadDayHistory,
  readAccountHistory,
} from "../src/history.ts";
import { Limits, parseXrd, utcDay } from "../src/limits.ts";
import { StateFile } from "../src/state.ts";
import { Executor, buildCall } from "../src/tx.ts";
import {
  FakeHttp,
  makeGateway,
  statusBody,
  type ReplySource,
} from "./fake-gateway.ts";
import { MemoryLogger, tempDir } from "./helpers.ts";

const ACCOUNT = "account_tdx_2_129x5uj99s5aka9ctqevg3zp8uyz03x6nfy3lghjfne73py0r0w077x";
const OTHER_ACCOUNT = "account_tdx_2_128w4g8w8g60tyg4edfu7pqcdcft5m0v4gmfhew2la3zcymu07rpptn";
const ORACLE = "component_tdx_2_1cz0g28zn8yrypku7643stnrkq9gvejtquvxpwp40pvqhptajn39cxp";
const KEY = new PrivateKey.Ed25519(new Uint8Array(32).fill(0x33));
const DAY = new Date("2026-10-20T12:00:00.000Z");

function manifest(
  method: string,
  options: { payer?: string; component?: string } = {},
): string {
  return [
    "CALL_METHOD",
    `    Address("${options.payer ?? ACCOUNT}")`,
    '    "lock_fee"',
    '    Decimal("0.1")',
    ";",
    "CALL_METHOD",
    `    Address("${options.component ?? ORACLE}")`,
    `    "${method}"`,
    ";",
  ].join("\n");
}

function transaction(
  fee: string,
  method: string,
  options: {
    payer?: string;
    component?: string;
    status?: string;
  } = {},
): Record<string, unknown> {
  return {
    transaction_status: options.status ?? "CommittedSuccess",
    state_version: 1,
    intent_hash: "tx-1",
    fee_paid: fee,
    manifest_instructions: manifest(method, options),
  };
}

function streamPage(items: unknown[], next: string | null = null): { body: unknown } {
  return { body: { items, next_cursor: next } };
}

function historyContext(
  items: unknown[],
  page?: ReplySource,
  withDefaultPage = true,
): {
  http: FakeHttp;
  state: StateFile;
  logger: MemoryLogger;
  gateway: ReturnType<typeof makeGateway>;
} {
  const http = new FakeHttp();
  http.on("/status/gateway-status", { body: statusBody() });
  if (withDefaultPage) http.on("/stream/transactions", page ?? streamPage(items));
  return {
    http,
    state: StateFile.load(join(tempDir(), "state.json")),
    logger: new MemoryLogger(),
    gateway: makeGateway(http),
  };
}

test("history: reads the day's keeper transactions from the account stream", async () => {
  const context = historyContext([
    transaction("0.2", "finalize_request"),
    transaction("0.3", "dispute_resolution"),
  ]);

  const history = await readAccountHistory(context.gateway, ACCOUNT, { now: () => DAY });

  assert.equal(history.day, "2026-10-20");
  assert.equal(history.fees, parseXrd("0.5"));
  assert.equal(history.disputes, 1);
  assert.equal(history.transactions, 2);
  assert.equal(history.pages, 1);

  const [body] = context.http.bodies("/stream/transactions");
  const request = body as Record<string, unknown>;
  assert.deepEqual(request.affected_global_entities_filter, [ACCOUNT]);
  assert.deepEqual(request.from_ledger_state, {
    timestamp: "2026-10-20T00:00:00.000Z",
  });
  const optIns = request.opt_ins as Record<string, unknown>;
  assert.equal(optIns.manifest_instructions, true);
  assert.equal(optIns.receipt_fee_summary, true);
});

test("history: other kinds and another payer are not counted", async () => {
  const context = historyContext([
    transaction("1", "transfer"),
    transaction("1", "finalize_request", { payer: OTHER_ACCOUNT }),
    transaction("0.2", "dispute_resolution"),
  ]);

  const history = await readAccountHistory(context.gateway, ACCOUNT, { now: () => DAY });

  assert.equal(history.fees, parseXrd("0.2"));
  assert.equal(history.disputes, 1);
  assert.equal(history.transactions, 1);
});

test("history: a failed dispute transaction is a fee but not a posted dispute", async () => {
  const context = historyContext([
    transaction("0.1", "dispute_resolution", { status: "CommittedFailure" }),
  ]);

  const history = await readAccountHistory(context.gateway, ACCOUNT, { now: () => DAY });

  assert.equal(history.fees, parseXrd("0.1"));
  assert.equal(history.disputes, 0);
});

test("history: the ledger figure raises the local spend and stops a run at the fee limit", async () => {
  const context = historyContext([transaction("0.6", "finalize_request")]);
  context.http.on("/transaction/preview", {
    body: { receipt: { status: "Succeeded" } },
  });

  const summary = await loadDayHistory(
    context.state,
    context.gateway,
    ACCOUNT,
    context.logger,
    { now: () => DAY },
  );

  assert.equal(summary.ok, true);
  assert.equal(summary.localFees, 0n);
  assert.equal(summary.ledgerFees, parseXrd("0.6"));
  assert.equal(summary.fees, parseXrd("0.6"));
  assert.equal(context.state.spent(utcDay(DAY)), parseXrd("0.6"));
  assert.ok(
    context.logger.infoMessages.some((message) =>
      /fees today: local 0, ledger 0.6, using 0.6/.test(message),
    ),
  );

  const limits = new Limits(context.state, {
    maxFeePerTx: parseXrd("0.1"),
    maxFeePerDay: parseXrd("0.5"),
    reserveFloor: 0n,
    now: () => DAY,
  });
  const decision = limits.check(parseXrd("0.1"));
  assert.equal(decision.allowed, false);
  assert.match(decision.reason ?? "", /daily limit/);

  const executor = new Executor({
    gateway: context.gateway,
    network: "stokenet",
    account: ACCOUNT,
    privateKey: KEY,
    liveSubmit: true,
    maxFeePerTx: parseXrd("0.1"),
    limits,
    balance: async () => parseXrd("100"),
    logger: context.logger,
    pollAttempts: 1,
    pollDelayMs: 0,
    randomNonce: () => 42,
  });
  const outcome = await executor.run(buildCall(ORACLE, "finalize_request", []), "limit");
  assert.equal(outcome, "over_limit");
  assert.equal(context.http.count("/transaction/submit"), 0);
});

test("history: the local figure stands when it is the larger one", async () => {
  const context = historyContext([transaction("0.1", "finalize_request")]);
  context.state.addSpend(utcDay(DAY), parseXrd("0.4"));

  const summary = await loadDayHistory(
    context.state,
    context.gateway,
    ACCOUNT,
    context.logger,
    { now: () => DAY },
  );

  assert.equal(summary.fees, parseXrd("0.4"));
  assert.equal(context.state.spent(utcDay(DAY)), parseXrd("0.4"));
});

test("history: a failed read keeps the local figures and marks disputes report-only", async () => {
  const context = historyContext([], { status: 500, body: { error: "down" } });
  context.state.addSpend(utcDay(DAY), parseXrd("0.3"));
  context.state.addDispute(utcDay(DAY));

  const summary = await loadDayHistory(
    context.state,
    context.gateway,
    ACCOUNT,
    context.logger,
    { now: () => DAY },
  );

  assert.equal(summary.ok, false);
  assert.equal(summary.fees, parseXrd("0.3"));
  assert.equal(summary.disputes, 1);
  assert.equal(context.state.spent(utcDay(DAY)), parseXrd("0.3"));
  assert.ok(
    context.logger.warnMessages.some((message) => /report-only for this run/.test(message)),
  );
});

test("history: hitting the page cap counts as a failed read", async () => {
  const context = historyContext([], undefined, false);
  for (let page = 0; page < HISTORY_PAGE_LIMIT; page += 1) {
    context.http.on("/stream/transactions", streamPage([], `cursor-${page}`));
  }

  await assert.rejects(
    () => readAccountHistory(context.gateway, ACCOUNT, { now: () => DAY }),
    HistoryError,
  );

  for (let page = 0; page < HISTORY_PAGE_LIMIT; page += 1) {
    context.http.on("/stream/transactions", streamPage([], `again-${page}`));
  }
  const summary = await loadDayHistory(
    context.state,
    context.gateway,
    ACCOUNT,
    context.logger,
    { now: () => DAY },
  );
  assert.equal(summary.ok, false);
  assert.match(summary.error ?? "", /did not end/);
});
