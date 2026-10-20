import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { loadConfig } from "../src/config.ts";
import { Runner, type JobContext, type RegisteredJob } from "../src/runner.ts";
import { StateFile } from "../src/state.ts";
import { MemoryLogger, tempDir, writeTempFile } from "./helpers.ts";

function context(): JobContext {
  const path = writeTempFile(
    "keeper.toml",
    `
network = "stokenet"
dapp_definition = "account_tdx_2_129x5uj99s5aka9ctqevg3zp8uyz03x6nfy3lghjfne73py0r0w077x"
account = "account_tdx_2_129x5uj99s5aka9ctqevg3zp8uyz03x6nfy3lghjfne73py0r0w077x"
key_env = "TEST_KEY"
max_fee_xrd_per_tx = 0.1
max_fee_xrd_per_day = 1.0
reserve_floor_xrd = 0

[jobs.probe]
enabled = true
interval_secs = 60

[jobs.off]
enabled = false
interval_secs = 60
`,
  );
  return {
    config: loadConfig(path),
    gateway: {} as JobContext["gateway"],
    components: {} as JobContext["components"],
    executor: {} as JobContext["executor"],
    state: StateFile.load(join(tempDir(), "state.json")),
    logger: new MemoryLogger(),
  };
}

test("once runs only enabled jobs", async () => {
  let probe = 0;
  let off = 0;
  const jobs: RegisteredJob[] = [
    {
      name: "probe",
      findWork: async () => [{ id: "a" }],
      act: async () => {
        probe += 1;
        return "dry_run";
      },
    },
    {
      name: "off",
      findWork: async () => {
        off += 1;
        return [];
      },
      act: async () => "dry_run",
    },
  ];

  const records = await new Runner(context(), jobs).once();
  assert.equal(probe, 1);
  assert.equal(off, 0);
  assert.deepEqual(records, [{ job: "probe", item: "a", outcome: "dry_run" }]);
});

test("a failing job does not stop the next one", async () => {
  let second = 0;
  const jobs: RegisteredJob[] = [
    {
      name: "probe",
      findWork: async () => {
        throw new Error("gateway gap");
      },
      act: async () => "dry_run",
    },
    {
      name: "off",
      findWork: async () => [{ id: "b" }],
      act: async () => {
        second += 1;
        return "dry_run";
      },
    },
  ];

  // `off` is disabled in the config; enable it here so the second job actually runs.
  const ctx = context();
  ctx.config.jobs.off = { enabled: true, interval_secs: 60 };
  const records = await new Runner(ctx, jobs).once();
  assert.equal(second, 1);
  assert.equal(records.length, 2);
  assert.match(records[0]?.error ?? "", /gateway gap/);
});
