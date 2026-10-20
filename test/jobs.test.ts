import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { PrivateKey } from "@radixdlt/radix-engine-toolkit";

import type { KeeperConfig } from "../src/config.ts";
import type { Components } from "../src/discover.ts";
import { Limits, parseXrd } from "../src/limits.ts";
import { nowSeconds, type JsonField } from "../src/oracle.ts";
import type { JobContext } from "../src/runner.ts";
import { StateFile } from "../src/state.ts";
import { Executor } from "../src/tx.ts";
import * as finalize from "../src/jobs/finalize.ts";
import * as openReveal from "../src/jobs/open-reveal.ts";
import * as redeemBonds from "../src/jobs/redeem-bonds.ts";
import { FakeHttp, makeGateway, statusBody, type Reply } from "./fake-gateway.ts";
import { MemoryLogger, tempDir } from "./helpers.ts";

const ACCOUNT = "account_tdx_2_129x5uj99s5aka9ctqevg3zp8uyz03x6nfy3lghjfne73py0r0w077x";
const OTHER_ACCOUNT = "account_tdx_2_128w4g8w8g60tyg4edfu7pqcdcft5m0v4gmfhew2la3zcymu07rpptn";
const ORACLE = "component_tdx_2_1cz0g28zn8yrypku7643stnrkq9gvejtquvxpwp40pvqhptajn39cxp";
const TICKET_RESOURCE =
  "resource_tdx_2_1n242favr7z7404levdfhkww7sghpsftlqn06wdnzxxewy0mhyw6s0y";
const KEY = new PrivateKey.Ed25519(new Uint8Array(32).fill(0x22));

const CONFIG: KeeperConfig = {
  network: "stokenet",
  dapp_definition: ACCOUNT,
  gateways: ["https://gateway.test"],
  account: ACCOUNT,
  key_env: "TEST_KEY",
  live_submit: false,
  max_fee_xrd_per_tx: 0.1,
  max_fee_xrd_per_day: 1,
  reserve_floor_xrd: 0,
  jobs: {},
};

function components(oracle: string | null = ORACLE): Components {
  return {
    oracle,
    registry: null,
    identifierConsultation: null,
    identifierElection: null,
    identifierGovernance: null,
    identifierYesOrNoQuery: null,
    spaceTreasuryHub: null,
    spaceTreasury: null,
    grantEscrow: null,
    distribution: null,
    spaceTreasuries: [],
    distributions: [],
    entities: [],
    byBlueprint: {},
    claimed: [],
    missing: [],
    unlinked: [],
  };
}

interface ContextOptions {
  epoch?: number;
  liveSubmit?: boolean;
  preview?: Reply;
  oracle?: string | null;
}

function context(http: FakeHttp, options: ContextOptions = {}): JobContext {
  http.on("/status/gateway-status", {
    body: statusBody("stokenet", 100, options.epoch ?? 10),
  });
  if (options.preview !== undefined) http.on("/transaction/preview", options.preview);

  const gateway = makeGateway(http);
  const state = StateFile.load(join(tempDir(), "state.json"));
  const limits = new Limits(state, {
    maxFeePerTx: parseXrd("1"),
    maxFeePerDay: parseXrd("10"),
    reserveFloor: parseXrd("0"),
  });
  const executor = new Executor({
    gateway,
    network: "stokenet",
    account: ACCOUNT,
    privateKey: KEY,
    liveSubmit: options.liveSubmit ?? false,
    maxFeePerTx: parseXrd("0.1"),
    limits,
    balance: async () => parseXrd("100"),
    logger: new MemoryLogger(),
    pollAttempts: 1,
    pollDelayMs: 0,
    randomNonce: () => 42,
  });

  return {
    config: CONFIG,
    gateway,
    components: components(options.oracle === undefined ? ORACLE : options.oracle),
    executor,
    state,
    logger: new MemoryLogger(),
  };
}

function field(name: string, value: unknown, kind = "String"): JsonField {
  return { field_name: name, value, kind };
}

function tuple(name: string, typeName: string, fields: JsonField[]): JsonField {
  return { field_name: name, kind: "Tuple", type_name: typeName, fields };
}

function enumField(name: string, variant: string): JsonField {
  return { field_name: name, kind: "Enum", type_name: "BondStatus", variant_name: variant, fields: [] };
}

function event(name: string, fields: JsonField[]) {
  return {
    name,
    emitter: { type: "Method", entity: { entity_address: ORACLE, is_global: true } },
    data: { kind: "Tuple", type_name: name, fields },
  };
}

function stream(events: unknown[], stateVersion = 50): Reply {
  return {
    body: {
      items: [
        {
          state_version: stateVersion,
          intent_hash: `tx-${stateVersion}`,
          confirmed_at: "2026-10-20T00:00:00.000Z",
          receipt: { events },
        },
      ],
      next_cursor: null,
    },
  };
}

function proposal(
  requestId: string,
  deadline: number,
  minEpoch = 0,
  attempt = 1,
): unknown {
  return event("ProposedResolutionChangedEvent", [
    field("request_id", requestId),
    tuple("proposed_resolution", "ProposedRequestResolution", [
      field("outcome", "YES"),
      field("timestamp", deadline - 60),
      field("disputable_until", deadline),
      ...(minEpoch === 0 ? [] : [field("disputable_min_epoch", minEpoch, "U64")]),
    ]),
    field("resolution_attempt", attempt, "U32"),
  ]);
}

function dispute(
  requestId: string,
  revealStart: number,
  revealPeriod: number,
): unknown {
  return event("DisputeResolutionChangedEvent", [
    field("request_id", requestId),
    tuple("dispute_resolution", "DisputeRequestResolution", [
      field("outcome", "NO"),
      field("vote_commit_start", revealStart - 60),
      field("commit_period", 60),
      field("reveal_period", revealPeriod),
      field("vote_reveal_start", revealStart),
    ]),
    field("resolution_attempt", 1, "U32"),
  ]);
}

// ---------------------------------------------------------------------------
// finalize
// ---------------------------------------------------------------------------

test("finalize: an undisputed window past its deadline and epoch is due", async () => {
  const http = new FakeHttp();
  http.on("/stream/transactions", stream([proposal("r1", nowSeconds() - 10, 10)]));
  const ctx = context(http);

  const work = await finalize.findWork(ctx);
  assert.equal(work.length, 1);
  assert.equal(work[0]?.id, "r1");
});

test("finalize: a passed deadline below the epoch floor is not due", async () => {
  const http = new FakeHttp();
  http.on("/stream/transactions", stream([proposal("r1", nowSeconds() - 10, 11)]));
  const ctx = context(http, { epoch: 10 });

  assert.deepEqual(await finalize.findWork(ctx), []);
});

test("finalize: a deadline still in the future is not due", async () => {
  const http = new FakeHttp();
  http.on("/stream/transactions", stream([proposal("r1", nowSeconds() + 600, 0)]));
  const ctx = context(http);

  assert.deepEqual(await finalize.findWork(ctx), []);
});

test("finalize: a finalized request is not worked again", async () => {
  const http = new FakeHttp();
  http.on(
    "/stream/transactions",
    stream([
      proposal("r1", nowSeconds() - 10, 0),
      event("RequestFinalizationEvent", [
        field("request_id", "r1"),
        field("resolution_attempt", 1, "U32"),
      ]),
    ]),
  );
  const ctx = context(http);

  assert.deepEqual(await finalize.findWork(ctx), []);
});

test("finalize: a disputed round without commits closes on the deadline", async () => {
  const http = new FakeHttp();
  http.on(
    "/stream/transactions",
    stream([dispute("r1", nowSeconds() - 600, 180)]),
  );
  const ctx = context(http);

  const work = await finalize.findWork(ctx);
  assert.equal(work.length, 1);
});

test("finalize: a disputed round with commits needs its reveal stamp", async () => {
  const commit = event("VoteCommittedEvent", [
    tuple("vote_ticket", "VoteTicket", [
      field("local_id", "#1#", "NonFungibleLocalId"),
      field("request_id", "r1"),
      field("resolution_attempt", 1, "U32"),
    ]),
  ]);
  const unstamped = new FakeHttp();
  unstamped.on(
    "/stream/transactions",
    stream([dispute("r1", nowSeconds() - 600, 600), commit]),
  );
  assert.deepEqual(await finalize.findWork(context(unstamped)), []);

  const belowFloor = new FakeHttp();
  belowFloor.on(
    "/stream/transactions",
    stream([
      dispute("r1", nowSeconds() - 600, 600),
      commit,
      event("VoteRoundRevealOpenedEvent", [
        field("vote_reveal_start", nowSeconds() - 600, "I64"),
        field("reveal_min_epoch", 11, "U64"),
      ]),
    ]),
  );
  assert.deepEqual(await finalize.findWork(context(belowFloor, { epoch: 10 })), []);

  const atFloor = new FakeHttp();
  atFloor.on(
    "/stream/transactions",
    stream([
      dispute("r1", nowSeconds() - 600, 600),
      commit,
      event("VoteRoundRevealOpenedEvent", [
        field("vote_reveal_start", nowSeconds() - 600, "I64"),
        field("reveal_min_epoch", 10, "U64"),
      ]),
    ]),
  );
  assert.equal((await finalize.findWork(context(atFloor, { epoch: 10 }))).length, 1);
});

test("finalize: a dry run previews and never submits", async () => {
  const http = new FakeHttp();
  http.on("/stream/transactions", stream([proposal("r1", nowSeconds() - 10, 0)]));
  http.on("/transaction/preview", { body: { receipt: { status: "Succeeded" } } });
  const ctx = context(http);

  const [item] = await finalize.findWork(ctx);
  assert.notEqual(item, undefined);
  assert.equal(await finalize.act(ctx, item!), "dry_run");
  assert.equal(http.count("/transaction/preview"), 1);
  assert.equal(http.count("/transaction/submit"), 0);
});

test("finalize: a refused preview is not an error", async () => {
  const http = new FakeHttp();
  http.on("/transaction/preview", {
    body: { receipt: { status: "Failed", error_message: "already finalized" } },
  });
  const ctx = context(http, { liveSubmit: true });
  const item = { id: "r1", request_id: "r1" };

  assert.equal(await finalize.act(ctx, item), "previewed_refused");
  assert.equal(http.count("/transaction/submit"), 0);
  assert.deepEqual((ctx.logger as MemoryLogger).errorMessages, []);
});

// ---------------------------------------------------------------------------
// open_reveal
// ---------------------------------------------------------------------------

function schedule(start: number, period = 180): unknown {
  return event("RequestScheduledForVotingEvent", [
    field("request_id", "r1"),
    field("resolution_attempt", 1, "U32"),
    field("vote_commit_start", start - 60, "I64"),
    field("vote_commit_period", 60, "I64"),
    field("vote_reveal_start", start, "I64"),
    field("vote_reveal_period", period, "I64"),
  ]);
}

function commit(): unknown {
  return event("VoteCommittedEvent", [
    tuple("vote_ticket", "VoteTicket", [
      field("local_id", "#1#", "NonFungibleLocalId"),
      field("request_id", "r1"),
      field("resolution_attempt", 1, "U32"),
    ]),
  ]);
}

test("open_reveal: a started round with commits and no stamp is due", async () => {
  const http = new FakeHttp();
  http.on(
    "/stream/transactions",
    stream([schedule(nowSeconds() - 10), commit()]),
  );
  const ctx = context(http);

  const work = await openReveal.findWork(ctx);
  assert.equal(work.length, 1);
  assert.equal(work[0]?.vote_reveal_start, nowSeconds() - 10);
});

test("open_reveal: rounds without commits, before the start, or already stamped are skipped", async () => {
  const noCommits = new FakeHttp();
  noCommits.on("/stream/transactions", stream([schedule(nowSeconds() - 10)]));
  assert.deepEqual(await openReveal.findWork(context(noCommits)), []);

  const future = new FakeHttp();
  future.on(
    "/stream/transactions",
    stream([schedule(nowSeconds() + 600), commit()]),
  );
  assert.deepEqual(await openReveal.findWork(context(future)), []);

  const stamped = new FakeHttp();
  stamped.on(
    "/stream/transactions",
    stream([
      schedule(nowSeconds() - 10),
      commit(),
      event("VoteRoundRevealOpenedEvent", [
        field("vote_reveal_start", nowSeconds() - 10, "I64"),
        field("reveal_min_epoch", 10, "U64"),
      ]),
    ]),
  );
  assert.deepEqual(await openReveal.findWork(context(stamped)), []);
});

test("open_reveal: a dry run never submits and a refused preview is not an error", async () => {
  const http = new FakeHttp();
  http.on("/stream/transactions", stream([schedule(nowSeconds() - 10), commit()]));
  http.on("/transaction/preview", { body: { receipt: { status: "Succeeded" } } });
  const ctx = context(http);

  const [item] = await openReveal.findWork(ctx);
  assert.equal(await openReveal.act(ctx, item!), "dry_run");
  assert.equal(http.count("/transaction/submit"), 0);

  const refused = new FakeHttp();
  refused.on("/transaction/preview", {
    body: { receipt: { status: "Failed", error_message: "round already open" } },
  });
  const refusedCtx = context(refused, { liveSubmit: true });
  assert.equal(
    await openReveal.act(refusedCtx, { id: "1", vote_reveal_start: nowSeconds() - 10 }),
    "previewed_refused",
  );
  assert.equal(refused.count("/transaction/submit"), 0);
  assert.deepEqual((refusedCtx.logger as MemoryLogger).errorMessages, []);
});

// ---------------------------------------------------------------------------
// redeem_own_bonds
// ---------------------------------------------------------------------------

function oracleStateReply(): Reply {
  return {
    body: {
      items: [
        {
          address: ORACLE,
          details: {
            blueprint_name: "OterOracleV1",
            state: { fields: [field("bond_ticket_resource", TICKET_RESOURCE, "Reference")] },
          },
        },
      ],
    },
  };
}

function holdingsReply(address: string, ids: string[]): Reply {
  return {
    body: {
      items: [
        {
          resource_address: TICKET_RESOURCE,
          vaults: {
            items: [{ vault_address: "internal_vault_tdx_2_1vault", items: ids }],
          },
        },
      ],
      next_cursor: null,
      address,
    },
  };
}

function ticketReply(statuses: Record<string, string>): Reply {
  return {
    body: {
      non_fungible_ids: Object.entries(statuses).map(([id, status]) => ({
        non_fungible_id: id,
        data: {
          programmatic_json: {
            kind: "Tuple",
            type_name: "BondTicket",
            fields: [
              field("local_id", id, "NonFungibleLocalId"),
              field("request_id", "r1"),
              enumField("bond_status", status),
              field("withdrawable_amount", "10", "Decimal"),
            ],
          },
        },
      })),
    },
  };
}

function registerTicketReads(http: FakeHttp, statuses: Record<string, string>): void {
  http.on("/state/entity/details", oracleStateReply());
  http.on(
    "/state/entity/page/non-fungibles",
    holdingsReply(ACCOUNT, Object.keys(statuses)),
  );
  http.on("/state/non-fungible/data", ticketReply(statuses));
  http.on("/transaction/preview", { body: { receipt: { status: "Succeeded" } } });
}

test("redeem_own_bonds: only finalized tickets of the configured account are selected", async () => {
  const http = new FakeHttp();
  registerTicketReads(http, { "#1#": "Rewarded", "#2#": "RequestNotSettled" });
  const ctx = context(http);

  const work = await redeemBonds.findWork(ctx);
  assert.deepEqual(
    work.map((item) => item.id),
    ["#1#"],
  );

  // Every holdings read names the configured account, never another holder.
  for (const body of http.bodies("/state/entity/page/non-fungibles")) {
    assert.equal((body as { address: string }).address, ACCOUNT);
  }
});

test("redeem_own_bonds: the manifest withdraws from that account, redeems and deposits back", async () => {
  const http = new FakeHttp();
  registerTicketReads(http, { "#1#": "Slashed" });
  const ctx = context(http);

  const [item] = await redeemBonds.findWork(ctx);
  assert.notEqual(item, undefined);
  assert.equal(await redeemBonds.act(ctx, item!), "dry_run");

  const preview = http.bodies("/transaction/preview")[0] as { manifest: string };
  assert.match(preview.manifest, /withdraw_non_fungibles/);
  assert.match(preview.manifest, /redeem_bond_ticket/);
  assert.match(preview.manifest, /try_deposit_batch_or_abort/);
  assert.ok(preview.manifest.includes(ACCOUNT));
  assert.ok(!preview.manifest.includes(OTHER_ACCOUNT));
  assert.equal(http.count("/transaction/submit"), 0);
});

test("redeem_own_bonds: a refused preview is not an error", async () => {
  const http = new FakeHttp();
  http.on("/state/entity/details", oracleStateReply());
  http.on("/state/entity/page/non-fungibles", holdingsReply(ACCOUNT, ["#1#"]));
  http.on("/state/non-fungible/data", ticketReply({ "#1#": "Rewarded" }));
  http.on("/transaction/preview", {
    body: { receipt: { status: "Failed", error_message: "ticket already redeemed" } },
  });
  const ctx = context(http, { liveSubmit: true });

  const [item] = await redeemBonds.findWork(ctx);
  assert.equal(await redeemBonds.act(ctx, item!), "previewed_refused");
  assert.equal(http.count("/transaction/submit"), 0);
  assert.deepEqual((ctx.logger as MemoryLogger).errorMessages, []);
});

test("redeem_own_bonds: nothing is read for another account when the account holds none", async () => {
  const http = new FakeHttp();
  http.on("/state/entity/details", oracleStateReply());
  http.on("/state/entity/page/non-fungibles", holdingsReply(ACCOUNT, []));
  const ctx = context(http);

  assert.deepEqual(await redeemBonds.findWork(ctx), []);
  assert.equal(http.count("/state/non-fungible/data"), 0);
  for (const body of http.bodies("/state/entity/page/non-fungibles")) {
    assert.equal((body as { address: string }).address, ACCOUNT);
  }
});
