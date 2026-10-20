import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { formatXrd, Limits, parseXrd, utcDay } from "../src/limits.ts";
import { StateFile, StateError } from "../src/state.ts";
import { tempDir } from "./helpers.ts";

const DAY = new Date("2026-10-20T12:00:00.000Z");

test("parses and formats XRD amounts exactly", () => {
  const cases = ["0", "0.1", "1", "123.456789012345678", "0.000000000000000001"];
  for (const value of cases) {
    assert.equal(formatXrd(parseXrd(value)), value === "0" ? "0" : value.replace(/^0+(?=\d)/, ""));
  }
  assert.equal(parseXrd("0.1"), 100_000_000_000_000_000n);
  assert.equal(parseXrd(1e-7), 100_000_000_000n);
  assert.equal(parseXrd("1.000000000000000001"), 1_000_000_000_000_000_001n);
  assert.throws(() => parseXrd("1.0000000000000000001"), /at most 18 decimal places/);
  assert.throws(() => parseXrd("-1"), /not a non-negative XRD amount/);
});

test("refuses a fee over the per-transaction limit", () => {
  const state = StateFile.load(join(tempDir(), "state.json"));
  const limits = new Limits(state, {
    maxFeePerTx: parseXrd("0.1"),
    maxFeePerDay: parseXrd("1"),
    reserveFloor: parseXrd("0"),
    now: () => DAY,
  });

  assert.equal(limits.check(parseXrd("0.1")).allowed, true);
  const decision = limits.check(parseXrd("0.2"));
  assert.equal(decision.allowed, false);
  assert.match(decision.reason ?? "", /per-transaction limit/);
});

test("refuses a fee that would cross the daily limit, and keeps the ledger", () => {
  const path = join(tempDir(), "state.json");
  const state = StateFile.load(path);
  const limits = new Limits(state, {
    maxFeePerTx: parseXrd("1"),
    maxFeePerDay: parseXrd("0.25"),
    reserveFloor: parseXrd("0"),
    now: () => DAY,
  });

  limits.record(parseXrd("0.2"));
  const decision = limits.check(parseXrd("0.1"));
  assert.equal(decision.allowed, false);
  assert.match(decision.reason ?? "", /daily limit/);

  const reloaded = StateFile.load(path);
  assert.equal(reloaded.spent(utcDay(DAY)), parseXrd("0.2"));
});

test("the daily ledger rolls over at UTC midnight", () => {
  let now = DAY;
  const state = StateFile.load(join(tempDir(), "state.json"));
  const limits = new Limits(state, {
    maxFeePerTx: parseXrd("1"),
    maxFeePerDay: parseXrd("0.25"),
    reserveFloor: parseXrd("0"),
    now: () => now,
  });

  limits.record(parseXrd("0.2"));
  now = new Date("2026-10-21T00:00:01.000Z");
  assert.equal(limits.check(parseXrd("0.2")).allowed, true);
});

test("refuses a fee that would leave the account under the reserve floor", () => {
  const state = StateFile.load(join(tempDir(), "state.json"));
  const limits = new Limits(state, {
    maxFeePerTx: parseXrd("1"),
    maxFeePerDay: parseXrd("10"),
    reserveFloor: parseXrd("5"),
    now: () => DAY,
  });

  assert.equal(limits.check(parseXrd("1"), parseXrd("6")).allowed, true);
  const decision = limits.check(parseXrd("1"), parseXrd("5.5"));
  assert.equal(decision.allowed, false);
  assert.match(decision.reason ?? "", /reserve floor/);
});

test("cursors persist per emitter", () => {
  const path = join(tempDir(), "state.json");
  const state = StateFile.load(path);
  assert.equal(state.cursor("component_tdx_2_a"), null);
  state.setCursor("component_tdx_2_a", 123);

  const reloaded = StateFile.load(path);
  assert.equal(reloaded.cursor("component_tdx_2_a"), 123);
  assert.equal(reloaded.cursor("component_tdx_2_b"), null);
});

test("a corrupt state file is refused rather than treated as empty", () => {
  const path = join(tempDir(), "state.json");
  writeFileSync(path, "{not json", "utf8");
  assert.throws(() => StateFile.load(path), StateError);
});
