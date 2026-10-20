import assert from "node:assert/strict";
import { test } from "node:test";

import { ConfigError, loadConfig } from "../src/config.ts";
import { explicitComponents, resolveComponents } from "../src/discover.ts";
import { FakeHttp, makeGateway, statusBody } from "./fake-gateway.ts";
import { writeTempFile } from "./helpers.ts";

const ACCOUNT = "account_tdx_2_129x5uj99s5aka9ctqevg3zp8uyz03x6nfy3lghjfne73py0r0w077x";
const ORACLE = "component_tdx_2_1cporacle";
const REGISTRY = "component_tdx_2_1cpregistry";
const HUB = "component_tdx_2_1cphub";
const TREASURY_A = "component_tdx_2_1cptreasurya";
const TREASURY_B = "component_tdx_2_1cptreasuryb";
const DISTRIBUTION = "component_tdx_2_1cpdistribution";

function configText(extra: string): string {
  return `
network = "stokenet"
dapp_definition = "${ACCOUNT}"
account = "${ACCOUNT}"
key_env = "TEST_KEY"
max_fee_xrd_per_tx = 0.1
max_fee_xrd_per_day = 1.0
reserve_floor_xrd = 0
${extra}
`;
}

function configTextWithoutDapp(extra: string): string {
  return configText(extra).replace(`dapp_definition = "${ACCOUNT}"\n`, "");
}

function detailsReply(
  entries: Array<[string, string]>,
): { body: unknown } {
  return {
    body: {
      items: entries.map(([address, blueprint]) => ({
        address,
        details: { blueprint_name: blueprint },
      })),
    },
  };
}

test("loads an explicit [components] table as given", () => {
  const path = writeTempFile(
    "explicit.toml",
    configText(`
[components]
oracle = "${ORACLE}"
registry = "${REGISTRY}"
hub = "${HUB}"
space_treasuries = ["${TREASURY_A}", "${TREASURY_B}"]
distributions = ["${DISTRIBUTION}"]
`),
  );
  const config = loadConfig(path);
  assert.equal(config.components?.oracle, ORACLE);
  assert.equal(config.components?.registry, REGISTRY);
  assert.deepEqual(config.components?.space_treasuries, [TREASURY_A, TREASURY_B]);
});

test("a [components] table is enough without a dapp_definition", () => {
  const path = writeTempFile(
    "components-only.toml",
    configTextWithoutDapp(`
[components]
oracle = "${ORACLE}"
registry = "${REGISTRY}"
`),
  );
  const config = loadConfig(path);
  assert.equal(config.dapp_definition, undefined);
  assert.equal(config.components?.oracle, ORACLE);
  assert.equal(config.components?.registry, REGISTRY);
});

test("refuses a config with neither dapp_definition nor [components]", () => {
  const path = writeTempFile("neither.toml", configTextWithoutDapp(""));
  assert.throws(
    () => loadConfig(path),
    /`dapp_definition` is required when there is no `\[components\]` table/,
  );
});

test("refuses an unknown [components] key and an address from another network", () => {
  const unknown = writeTempFile(
    "unknown.toml",
    configText(`[components]\noarcle = "${ORACLE}"`),
  );
  assert.throws(() => loadConfig(unknown), /unknown key `components.oarcle`/);

  const wrongNetwork = writeTempFile(
    "wrong.toml",
    configText(`[components]\noracle = "component_rdx1abc"`),
  );
  assert.throws(() => loadConfig(wrongNetwork), /must be a stokenet component address/);
});

test("an explicit table is used without any claimed-entities discovery", async () => {
  const http = new FakeHttp();
  http.on("/status/gateway-status", { body: statusBody() });
  http.on(
    "/state/entity/details",
    detailsReply([
      [ORACLE, "OterOracleV1"],
      [REGISTRY, "OterConsultationRegistryV1"],
      [HUB, "OterSpaceTreasuryHubV1"],
      [TREASURY_A, "OterSpaceTreasuryV1"],
      [TREASURY_B, "OterSpaceTreasuryV1"],
      [DISTRIBUTION, "OterDistributionV1"],
    ]),
  );
  const path = writeTempFile(
    "explicit.toml",
    configText(`
[components]
oracle = "${ORACLE}"
registry = "${REGISTRY}"
hub = "${HUB}"
space_treasuries = ["${TREASURY_A}", "${TREASURY_B}"]
distributions = ["${DISTRIBUTION}"]
`),
  );

  const resolved = await resolveComponents(makeGateway(http), loadConfig(path));
  assert.equal(resolved.source, "config");
  assert.equal(resolved.components.oracle, ORACLE);
  assert.equal(resolved.components.spaceTreasuryHub, HUB);
  assert.deepEqual(resolved.components.spaceTreasuries, [TREASURY_A, TREASURY_B]);
  assert.equal(resolved.components.spaceTreasury, TREASURY_A);
  assert.equal(resolved.components.distribution, DISTRIBUTION);

  // Discovery would have asked the dApp definition for its claimed entities; it did not.
  for (const body of http.bodies("/state/entity/details")) {
    const optIns = (body as { opt_ins?: { explicit_metadata?: string[] } }).opt_ins;
    assert.equal(
      optIns?.explicit_metadata?.includes("claimed_entities") ?? false,
      false,
    );
  }
});

test("an explicit address is refused when its blueprint is not the expected one", async () => {
  const http = new FakeHttp();
  http.on("/status/gateway-status", { body: statusBody() });
  http.on("/state/entity/details", detailsReply([[ORACLE, "Account"]]));

  await assert.rejects(
    explicitComponents(makeGateway(http), { oracle: ORACLE }),
    (error: unknown) =>
      error instanceof ConfigError &&
      /components\.oracle/.test(error.message) &&
      /Account/.test(error.message),
  );
});

test("discovery runs when the table is absent", async () => {
  const http = new FakeHttp();
  http.on("/status/gateway-status", { body: statusBody() });
  http.on("/state/entity/details", {
    body: {
      items: [
        {
          address: ACCOUNT,
          metadata: {
            items: [
              { key: "claimed_entities", value: { typed: { values: [ORACLE] } } },
            ],
          },
        },
      ],
    },
  });
  http.on("/state/entity/details", detailsReply([[ORACLE, "OterOracleV1"]]));

  const path = writeTempFile("discovered.toml", configText(""));
  const resolved = await resolveComponents(makeGateway(http), loadConfig(path));
  assert.equal(resolved.source, "discovered");
  assert.equal(resolved.components.oracle, ORACLE);
});
