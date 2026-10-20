import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  ConfigError,
  loadConfig,
  loadKey,
  resolvedJobConfig,
} from "../src/config.ts";
import { tempDir, writeTempFile } from "./helpers.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/keeper.toml", import.meta.url));
const STOKENET_ACCOUNT = "account_tdx_2_129x5uj99s5aka9ctqevg3zp8uyz03x6nfy3lghjfne73py0r0w077x";
const MAINNET_ACCOUNT = "account_rdx12yu55zy3cx3lx3xjkp9f2vzp2ye2mql5vzhxvq0tks74d5hcp0xkvs";

function baseConfig(extra: string): string {
  return `
network = "stokenet"
dapp_definition = "${STOKENET_ACCOUNT}"
account = "${STOKENET_ACCOUNT}"
key_env = "TEST_KEY"
max_fee_xrd_per_tx = 0.1
max_fee_xrd_per_day = 1.0
reserve_floor_xrd = 0.5
${extra}
`;
}

test("loads the checked-in fixture", () => {
  const config = loadConfig(FIXTURE);
  assert.equal(config.network, "stokenet");
  assert.equal(config.account, STOKENET_ACCOUNT);
  assert.equal(config.live_submit, false);
  assert.deepEqual(config.gateways, ["https://stokenet.radixdlt.com"]);
  assert.equal(config.jobs.noop?.enabled, true);
});

test("defaults live_submit to false, gateways to the public one and jobs to enabled", () => {
  const path = writeTempFile("keeper.toml", baseConfig(""));
  const config = loadConfig(path);
  assert.equal(config.live_submit, false);
  assert.deepEqual(config.gateways, ["https://stokenet.radixdlt.com"]);
  assert.equal(resolvedJobConfig(config, "noop").enabled, true);
  assert.equal(resolvedJobConfig(config, "noop").interval_secs, 60);
  assert.equal(resolvedJobConfig(config, "dispute").enabled, false);
  assert.equal(resolvedJobConfig(config, "dispute").interval_secs, 300);
});

test("requires exactly one key source", () => {
  const missing = writeTempFile(
    "missing.toml",
    baseConfig("").replace('key_env = "TEST_KEY"', ""),
  );
  assert.throws(() => loadConfig(missing), /exactly one of `key_file` or `key_env`/);

  const both = writeTempFile(
    "both.toml",
    baseConfig("key_file = \"key.hex\""),
  );
  assert.throws(() => loadConfig(both), /exactly one of `key_file` or `key_env`/);
});

test("refuses an account from the wrong network", () => {
  const path = writeTempFile(
    "wrong-network.toml",
    baseConfig("").replace(`account = "${STOKENET_ACCOUNT}"`, `account = "${MAINNET_ACCOUNT}"`),
  );
  assert.throws(() => loadConfig(path), /must be a stokenet account address/);
});

test("resolves a relative key file against the config directory and loads it", () => {
  const dir = tempDir();
  const keyHex = "11".repeat(32);
  writeFileSync(join(dir, "keeper-key.hex"), `${keyHex}\n`, "utf8");
  const path = join(dir, "keeper.toml");
  writeFileSync(
    path,
    baseConfig("").replace('key_env = "TEST_KEY"', 'key_file = "keeper-key.hex"'),
    "utf8",
  );

  const config = loadConfig(path);
  assert.equal(config.key_file, join(dir, "keeper-key.hex"));
  const key = loadKey(config, {});
  assert.equal(key.length, 32);
  assert.equal(Buffer.from(key).toString("hex"), keyHex);
});

test("a missing or malformed key is refused without echoing it", () => {
  const dir = tempDir();
  const missingPath = join(dir, "keeper.toml");
  writeFileSync(
    missingPath,
    baseConfig("").replace('key_env = "TEST_KEY"', 'key_file = "absent.hex"'),
    "utf8",
  );
  assert.throws(() => loadKey(loadConfig(missingPath), {}), /cannot read key file/);

  const malformed = "not-a-real-key-but-long-enough-to-look-one";
  const path = writeTempFile(
    "malformed.toml",
    baseConfig("").replace('key_env = "TEST_KEY"', 'key_env = "MALFORMED_KEY"'),
  );
  const config = loadConfig(path);
  assert.throws(
    () => loadKey(config, { MALFORMED_KEY: malformed }),
    (error: unknown) =>
      error instanceof ConfigError &&
      /32 bytes of hex/.test(error.message) &&
      !error.message.includes(malformed),
  );
});

test("refuses a key environment variable that is not set", () => {
  const path = writeTempFile("env.toml", baseConfig(""));
  assert.throws(
    () => loadKey(loadConfig(path), {}),
    /key environment variable TEST_KEY is not set/,
  );
});

test("refuses a daily cap below the per-transaction cap", () => {
  const path = writeTempFile(
    "caps.toml",
    baseConfig("").replace("max_fee_xrd_per_day = 1.0", "max_fee_xrd_per_day = 0.01"),
  );
  assert.throws(() => loadConfig(path), /at least `max_fee_xrd_per_tx`/);
});

test("refuses more than three fallbacks", () => {
  const path = writeTempFile(
    "gateways.toml",
    baseConfig(
      'gateways = ["https://a.test", "https://b.test", "https://c.test", "https://d.test", "https://e.test"]',
    ),
  );
  assert.throws(() => loadConfig(path), /at most 4 entries/);
});
