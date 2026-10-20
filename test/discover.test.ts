import assert from "node:assert/strict";
import { test } from "node:test";

import { discoverComponents, parseClaimedEntities } from "../src/discover.ts";
import { FakeHttp, makeGateway, statusBody } from "./fake-gateway.ts";

const DAPP = "account_tdx_2_129x5uj99s5aka9ctqevg3zp8uyz03x6nfy3lghjfne73py0r0w077x";
const ORACLE = "component_tdx_2_1cpym9e0ht2pv8lnxfq635jaumcmgh5ef0vasukp8qv4a0zsswvahfu";
const REGISTRY = "component_tdx_2_1czvzh4gk7xfdl5dvap0r39tcps3xhqjwthvdyvgedjm2z34q085cux";
const HUB = "component_tdx_2_1crl2w2l9lcztszdknmmj4zrkc9600yhspej8k8e79wxzl55x35daeg";

function component(address: string, blueprint: string, dappDefinition: string | null = DAPP) {
  return {
    address,
    details: { blueprint_name: blueprint },
    metadata: {
      items:
        dappDefinition === null
          ? []
          : [
              {
                key: "dapp_definition",
                value: { typed: { type: "GlobalAddress", value: dappDefinition } },
              },
            ],
    },
  };
}

function accountWith(claimed: unknown): unknown {
  return {
    address: DAPP,
    details: { type: "Component", blueprint_name: "Account" },
    metadata: { items: [{ key: "claimed_entities", value: { typed: claimed } }] },
  };
}

test("maps claimed entities by blueprint name and keeps the raw list", async () => {
  const http = new FakeHttp();
  http.on("/status/gateway-status", { body: statusBody() });
  http.on("/state/entity/details", {
    body: { items: [accountWith({ type: "StringArray", values: [ORACLE, REGISTRY, HUB] })] },
  });
  http.on("/state/entity/details", {
    body: {
      items: [
        component(ORACLE, "OterOracleV1"),
        component(REGISTRY, "ConsultationRegistryV1"),
        component(HUB, "OterSpaceTreasuryHubV1"),
      ],
    },
  });

  const components = await discoverComponents(makeGateway(http), DAPP);
  assert.equal(components.oracle, ORACLE);
  assert.equal(components.registry, REGISTRY);
  assert.equal(components.spaceTreasuryHub, HUB);
  assert.deepEqual(components.byBlueprint.OterOracleV1, [ORACLE]);
  assert.deepEqual(components.claimed, [ORACLE, REGISTRY, HUB]);
  assert.deepEqual(components.missing, []);
  assert.equal(components.entities[0]?.dapp_definition, DAPP);
});

test("accepts claimed_entities rendered as a JSON string", () => {
  assert.deepEqual(parseClaimedEntities({ type: "String", value: JSON.stringify([ORACLE]) }), [
    ORACLE,
  ]);
  assert.deepEqual(parseClaimedEntities({ type: "String", value: "not json" }), []);
  assert.deepEqual(parseClaimedEntities(undefined), []);
});

test("an account with no claimed_entities discovers nothing", async () => {
  const http = new FakeHttp();
  http.on("/status/gateway-status", { body: statusBody() });
  http.on("/state/entity/details", {
    body: { items: [{ address: DAPP, details: { type: "Component" }, metadata: { items: [] } }] },
  });

  const components = await discoverComponents(makeGateway(http), DAPP);
  assert.deepEqual(components.entities, []);
  assert.equal(components.oracle, null);
  assert.deepEqual(components.claimed, []);
});

test("refuses a dApp definition account the Gateway does not know", async () => {
  const http = new FakeHttp();
  http.on("/status/gateway-status", { body: statusBody() });
  http.on("/state/entity/details", { body: { items: [] } });

  await assert.rejects(
    discoverComponents(makeGateway(http), DAPP),
    /does not know dApp definition account/,
  );
});

test("reports claimed addresses the Gateway does not know and batches the detail reads", async () => {
  const claimed = Array.from({ length: 21 }, (_, index) => `component_tdx_2_test${index}`);
  const firstBatch = claimed.slice(0, 20).map((address) => component(address, "OterOracleV1"));

  const http = new FakeHttp();
  http.on("/status/gateway-status", { body: statusBody() });
  http.on("/state/entity/details", {
    body: { items: [accountWith({ type: "StringArray", values: claimed })] },
  });
  http.on("/state/entity/details", { body: { items: firstBatch } });
  http.on("/state/entity/details", { body: { items: [] } });

  const components = await discoverComponents(makeGateway(http), DAPP);
  assert.equal(components.entities.length, 20);
  assert.deepEqual(components.missing, [claimed[20]]);
  assert.equal(http.count("/state/entity/details"), 3);
});

test("ignores claimed entities whose dapp_definition link is elsewhere", async () => {
  const http = new FakeHttp();
  http.on("/status/gateway-status", { body: statusBody() });
  http.on("/state/entity/details", {
    body: { items: [accountWith({ type: "StringArray", values: [ORACLE] })] },
  });
  http.on("/state/entity/details", {
    body: { items: [component(ORACLE, "OterOracleV1", "account_tdx_2_someoneelse")] },
  });

  const components = await discoverComponents(makeGateway(http), DAPP);
  assert.equal(components.oracle, null);
  assert.deepEqual(components.byBlueprint, {});
  assert.deepEqual(components.unlinked, [ORACLE]);
  assert.equal(components.entities[0]?.dapp_definition, "account_tdx_2_someoneelse");
});
