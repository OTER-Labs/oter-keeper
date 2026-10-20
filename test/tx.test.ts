import assert from "node:assert/strict";
import { PrivateKey, str } from "@radixdlt/radix-engine-toolkit";
import { join } from "node:path";
import { test } from "node:test";

import { Limits, parseXrd } from "../src/limits.ts";
import { StateFile } from "../src/state.ts";
import { buildCall, Executor, type Logger } from "../src/tx.ts";
import { FakeHttp, makeGateway, statusBody, type Reply } from "./fake-gateway.ts";
import { MemoryLogger, tempDir } from "./helpers.ts";

const ACCOUNT = "account_tdx_2_129x5uj99s5aka9ctqevg3zp8uyz03x6nfy3lghjfne73py0r0w077x";
const KEY_HEX = "22".repeat(32);
const PRIVATE_KEY = new PrivateKey.Ed25519(
  Uint8Array.from(Buffer.from(KEY_HEX, "hex")),
);

interface ExecutorOptions {
  liveSubmit?: boolean;
  maxFee?: string;
  maxPerTx?: string;
  maxPerDay?: string;
  reserveFloor?: string;
  balance?: string;
  logger?: Logger;
  preview?: Reply;
  submit?: Reply;
  status?: Reply;
}

function executorFor(http: FakeHttp, options: ExecutorOptions = {}): Executor {
  http.on("/status/gateway-status", { body: statusBody("stokenet", 100, 10) });
  http.on(
    "/transaction/preview",
    options.preview ?? { body: { receipt: { status: "Succeeded" } } },
  );
  if (options.submit !== undefined) http.on("/transaction/submit", options.submit);
  if (options.status !== undefined) http.on("/transaction/status", options.status);

  const state = StateFile.load(join(tempDir(), "state.json"));
  const limits = new Limits(state, {
    maxFeePerTx: parseXrd(options.maxPerTx ?? "1"),
    maxFeePerDay: parseXrd(options.maxPerDay ?? "10"),
    reserveFloor: parseXrd(options.reserveFloor ?? "0"),
  });

  return new Executor({
    gateway: makeGateway(http),
    network: "stokenet",
    account: ACCOUNT,
    privateKey: PRIVATE_KEY,
    liveSubmit: options.liveSubmit ?? false,
    maxFeePerTx: parseXrd(options.maxFee ?? "0.1"),
    limits,
    balance: async () => parseXrd(options.balance ?? "100"),
    logger: options.logger ?? new MemoryLogger(),
    pollAttempts: 1,
    pollDelayMs: 0,
    randomNonce: () => 42,
  });
}

function manifest() {
  return buildCall("component_tdx_2_1cpym9e0ht2pv8lnxfq635jaumcmgh5ef0vasukp8qv4a0zsswvahfu", "finalize_request", [
    str("request-1"),
  ]);
}

test("a dry run previews and never submits", async () => {
  const http = new FakeHttp();
  const executor = executorFor(http);
  assert.equal(await executor.run(manifest(), "finalize"), "dry_run");
  assert.equal(http.count("/transaction/preview"), 1);
  assert.equal(http.count("/transaction/submit"), 0);

  const preview = http.bodies("/transaction/preview")[0] as {
    manifest: string;
    signer_public_keys: Array<{ key_hex: string }>;
  };
  assert.match(preview.manifest, /lock_fee/);
  assert.match(preview.manifest, /Decimal\("0.1"\)/);
  assert.match(preview.manifest, /"finalize_request"/);
  assert.equal(
    preview.signer_public_keys[0]?.key_hex,
    Buffer.from(PRIVATE_KEY.publicKeyBytes()).toString("hex"),
  );
});

test("a refused preview is never submitted", async () => {
  const http = new FakeHttp();
  const executor = executorFor(http, {
    liveSubmit: true,
    preview: { body: { receipt: { status: "Failed", error_message: "no such request" } } },
  });
  assert.equal(await executor.run(manifest(), "finalize"), "previewed_refused");
  assert.equal(http.count("/transaction/submit"), 0);
});

test("a fee over the per-transaction limit is not submitted", async () => {
  const http = new FakeHttp();
  const executor = executorFor(http, { liveSubmit: true, maxPerTx: "0.01" });
  assert.equal(await executor.run(manifest(), "finalize"), "over_limit");
  assert.equal(http.count("/transaction/preview"), 1);
  assert.equal(http.count("/transaction/submit"), 0);
});

test("a fee that would cross the daily limit is not submitted", async () => {
  const http = new FakeHttp();
  http.on("/status/gateway-status", { body: statusBody("stokenet", 100, 10) });
  http.on("/transaction/preview", { body: { receipt: { status: "Succeeded" } } });

  const state = StateFile.load(join(tempDir(), "state.json"));
  const limits = new Limits(state, {
    maxFeePerTx: parseXrd("1"),
    maxFeePerDay: parseXrd("1"),
    reserveFloor: parseXrd("0"),
  });
  limits.record(parseXrd("0.95"));

  const blocked = new Executor({
    gateway: makeGateway(http),
    network: "stokenet",
    account: ACCOUNT,
    privateKey: PRIVATE_KEY,
    liveSubmit: true,
    maxFeePerTx: parseXrd("0.1"),
    limits,
    balance: async () => parseXrd("100"),
    logger: new MemoryLogger(),
    pollAttempts: 1,
    pollDelayMs: 0,
    randomNonce: () => 42,
  });
  assert.equal(await blocked.run(manifest(), "finalize"), "over_limit");
  assert.equal(http.count("/transaction/submit"), 0);
});

test("a fee that would leave the account under the reserve floor is not submitted", async () => {
  const http = new FakeHttp();
  const executor = executorFor(http, {
    liveSubmit: true,
    balance: "5.05",
    reserveFloor: "5",
  });
  assert.equal(await executor.run(manifest(), "finalize"), "over_limit");
  assert.equal(http.count("/transaction/submit"), 0);
});

test("a live submit is signed, sent, polled and recorded as committed", async () => {
  const http = new FakeHttp();
  const logger = new MemoryLogger();
  const executor = executorFor(http, {
    liveSubmit: true,
    logger,
    submit: { body: { duplicate: false } },
    status: { body: { intent_status: "CommittedSuccess", status: "CommittedSuccess" } },
  });

  assert.equal(await executor.run(manifest(), "finalize"), "committed");
  assert.equal(http.count("/transaction/submit"), 1);
  assert.equal(http.count("/transaction/status"), 1);

  const submitted = http.bodies("/transaction/submit")[0] as {
    notarized_transaction_hex: string;
  };
  assert.match(submitted.notarized_transaction_hex, /^[0-9a-f]+$/);
  assert.ok(logger.all.some((message) => message.includes("committed")));
});

test("a committed failure is reported as failed", async () => {
  const http = new FakeHttp();
  const executor = executorFor(http, {
    liveSubmit: true,
    submit: { body: {} },
    status: {
      body: {
        intent_status: "CommittedFailure",
        status: "CommittedFailure",
        error_message: "engine refused",
      },
    },
  });
  assert.equal(await executor.run(manifest(), "finalize"), "failed");
});

test("the private key never appears in a log line", async () => {
  const http = new FakeHttp();
  const logger = new MemoryLogger();
  const executor = executorFor(http, {
    liveSubmit: true,
    logger,
    submit: { body: {} },
    status: { body: { intent_status: "CommittedSuccess" } },
  });

  await executor.run(manifest(), "finalize");
  const joined = logger.all.join("\n");
  assert.ok(!joined.includes(KEY_HEX));
  assert.ok(!joined.includes(KEY_HEX.toUpperCase()));
  assert.ok(joined.includes("submitted"));
});
