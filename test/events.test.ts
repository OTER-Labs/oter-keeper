import assert from "node:assert/strict";
import { test } from "node:test";

import { eventEmitterAddress, streamEvents, type LedgerEvent } from "../src/events.ts";
import { FakeHttp, makeGateway, statusBody } from "./fake-gateway.ts";

function event(name: string, address: string, value = "") {
  return {
    name,
    emitter: { type: "Method", entity: { entity_address: address, is_global: true } },
    data: { fields: [{ field_name: "value", kind: "String", value }] },
  };
}

function transaction(stateVersion: number, events: unknown[]) {
  return {
    state_version: stateVersion,
    intent_hash: `tx-${stateVersion}`,
    confirmed_at: "2026-10-20T00:00:00.000Z",
    receipt: { events },
  };
}

async function collect(stream: AsyncIterable<LedgerEvent>): Promise<LedgerEvent[]> {
  const events: LedgerEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

test("walks pages in order, starting from the requested state version", async () => {
  const http = new FakeHttp();
  http.on("/status/gateway-status", { body: statusBody() });
  http.on("/stream/transactions", {
    body: {
      items: [
        transaction(101, [event("First", "component_tdx_2_a", "1")]),
        transaction(102, [event("Second", "component_tdx_2_a", "2")]),
      ],
      next_cursor: "cursor-1",
    },
  });
  http.on("/stream/transactions", {
    body: { items: [transaction(103, [event("Third", "component_tdx_2_a", "3")])] },
  });

  const events = await collect(streamEvents(makeGateway(http), "component_tdx_2_a", 100));
  assert.deepEqual(
    events.map((entry) => entry.name),
    ["First", "Second", "Third"],
  );
  assert.equal(events[0]?.state_version, 101);
  assert.equal(events[0]?.emitter, "component_tdx_2_a");
  assert.equal(events[0]?.intent_hash, "tx-101");

  const bodies = http.bodies("/stream/transactions");
  assert.deepEqual((bodies[0] as Record<string, unknown>).from_ledger_state, {
    state_version: 100,
  });
  assert.equal((bodies[1] as Record<string, unknown>).cursor, "cursor-1");
  assert.equal((bodies[0] as Record<string, unknown>).order, "Asc");
});

test("skips transactions below the requested state version", async () => {
  const http = new FakeHttp();
  http.on("/status/gateway-status", { body: statusBody() });
  http.on("/stream/transactions", {
    body: {
      items: [
        transaction(90, [event("Old", "component_tdx_2_a")]),
        transaction(120, [event("New", "component_tdx_2_a")]),
      ],
    },
  });

  const events = await collect(streamEvents(makeGateway(http), "component_tdx_2_a", 100));
  assert.deepEqual(events.map((entry) => entry.name), ["New"]);
});

test("refuses a stream that repeats its cursor", async () => {
  const http = new FakeHttp();
  http.on("/status/gateway-status", { body: statusBody() });
  http.on("/stream/transactions", {
    body: { items: [], next_cursor: "same" },
  });
  http.on("/stream/transactions", {
    body: { items: [], next_cursor: "same" },
  });

  await assert.rejects(
    collect(streamEvents(makeGateway(http), "component_tdx_2_a", 0)),
    /repeated cursor same/,
  );
});

test("reads the global emitter from method and function emitters", () => {
  assert.equal(
    eventEmitterAddress({ type: "Method", entity: { entity_address: "component_tdx_2_a" } }),
    "component_tdx_2_a",
  );
  assert.equal(
    eventEmitterAddress({ type: "Function", package_address: "package_tdx_2_p" }),
    "package_tdx_2_p",
  );
  assert.equal(eventEmitterAddress(undefined), null);
});
