import assert from "node:assert/strict";
import { test } from "node:test";

import { XRD_RESOURCES } from "../src/config.ts";
import { Gateway, GatewayError } from "../src/gateway.ts";
import { FakeHttp, makeGateway, statusBody } from "./fake-gateway.ts";

test("refuses a gateway on the wrong network and uses the matching fallback", async () => {
  const http = new FakeHttp();
  http.on("https://a.test/status/gateway-status", { body: statusBody("mainnet", 5, 1) });
  http.on("https://b.test/status/gateway-status", { body: statusBody("stokenet", 7, 3) });

  const gateway = new Gateway(["https://a.test", "https://b.test"], "stokenet", {
    fetchImpl: http.fetch,
    retryDelaysMs: [],
  });
  const status = await gateway.status();
  assert.equal(status.ledger_state.network, "stokenet");
  assert.equal(status.ledger_state.state_version, 7);
  assert.equal(status.ledger_state.epoch, 3);
});

test("refuses to start when no gateway serves the configured network", async () => {
  const http = new FakeHttp();
  http.on("/status/gateway-status", { body: statusBody("mainnet") });
  const gateway = makeGateway(http);
  await assert.rejects(gateway.status(), /no configured gateway serves stokenet.*serves mainnet/);
});

test("falls back to the next gateway for a read", async () => {
  const http = new FakeHttp();
  http.on("https://a.test/status/gateway-status", { body: statusBody("stokenet", 7, 3) });
  http.on("https://a.test/state/entity/details", { status: 503, text: "down" });
  http.on("https://b.test/state/entity/details", {
    body: { items: [{ address: "account_tdx_2_x" }], ledger_state: statusBody("stokenet", 7, 3).ledger_state },
  });

  const gateway = new Gateway(["https://a.test", "https://b.test"], "stokenet", {
    fetchImpl: http.fetch,
    retryDelaysMs: [],
  });
  const answer = await gateway.post<{ items: unknown[] }>("/state/entity/details", {});
  assert.equal(answer.items.length, 1);
});

test("refuses an answer from a different state version than requested", async () => {
  const http = new FakeHttp();
  http.on("/status/gateway-status", { body: statusBody("stokenet", 7, 3) });
  http.on("/state/entity/details", {
    body: {
      items: [],
      ledger_state: { network: "stokenet", state_version: 8, epoch: 3 },
    },
  });
  const gateway = makeGateway(http);

  await assert.rejects(
    gateway.post("/state/entity/details", {}, 7),
    /answered at state version 8, but 7 was requested/,
  );
});

test("retries a 429 and then succeeds", async () => {
  const http = new FakeHttp();
  http.on("/status/gateway-status", { body: statusBody() });
  http.on("/state/entity/details", { status: 429, text: "slow down" });
  http.on("/state/entity/details", { body: { items: [], ledger_state: statusBody().ledger_state } });

  const gateway = makeGateway(http, { retryDelaysMs: [0] });
  const answer = await gateway.post<{ items: unknown[] }>("/state/entity/details", {});
  assert.deepEqual(answer.items, []);
  assert.equal(http.count("/state/entity/details"), 2);
});

test("keeps one request in flight", async () => {
  const http = new FakeHttp();
  http.on("/status/gateway-status", { body: statusBody() });
  const slow = async (): Promise<{ body: unknown }> => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { body: { items: [], ledger_state: statusBody().ledger_state } };
  };
  http.on("/state/entity/details", slow);
  http.on("/state/entity/details", slow);

  const gateway = makeGateway(http);
  await gateway.status();
  http.maxInFlight = 0;

  await Promise.all([
    gateway.post("/state/entity/details", { addresses: [] }),
    gateway.post("/state/entity/details", { addresses: [] }),
  ]);
  assert.equal(http.maxInFlight, 1);
});

test("reads the account's XRD balance", async () => {
  const http = new FakeHttp();
  http.on("/status/gateway-status", { body: statusBody() });
  http.on("/state/entity/details", {
    body: {
      items: [
        {
          fungible_resources: {
            items: [
              { resource_address: "resource_tdx_2_other", amount: "5" },
              { resource_address: XRD_RESOURCES.stokenet, amount: "12.5" },
            ],
          },
        },
      ],
      ledger_state: statusBody().ledger_state,
    },
  });
  const gateway = makeGateway(http);
  assert.equal(await gateway.accountXrdBalance("account_tdx_2_x"), "12.5");
});

test("a bad request is not retried or failed over", async () => {
  const http = new FakeHttp();
  http.on("/status/gateway-status", { body: statusBody() });
  http.on("/state/entity/details", { status: 400, text: "bad address" });
  const gateway = makeGateway(http);

  await assert.rejects(
    gateway.post("/state/entity/details", {}),
    (error: unknown) => error instanceof GatewayError && error.status === 400,
  );
  assert.equal(http.count("/state/entity/details"), 1);
});
