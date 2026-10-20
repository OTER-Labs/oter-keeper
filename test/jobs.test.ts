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
import * as burnSeat from "../src/jobs/burn-seat.ts";
import * as openVote from "../src/jobs/open-vote.ts";
import * as settle from "../src/jobs/settle.ts";
import { FakeHttp, makeGateway, statusBody, type Reply } from "./fake-gateway.ts";
import { MemoryLogger, tempDir } from "./helpers.ts";

const ACCOUNT = "account_tdx_2_129x5uj99s5aka9ctqevg3zp8uyz03x6nfy3lghjfne73py0r0w077x";
const OTHER_ACCOUNT = "account_tdx_2_128w4g8w8g60tyg4edfu7pqcdcft5m0v4gmfhew2la3zcymu07rpptn";
const ORACLE = "component_tdx_2_1cz0g28zn8yrypku7643stnrkq9gvejtquvxpwp40pvqhptajn39cxp";
const TICKET_RESOURCE =
  "resource_tdx_2_1n242favr7z7404levdfhkww7sghpsftlqn06wdnzxxewy0mhyw6s0y";
const REGISTRY = ORACLE;
const SEAT_RESOURCE = TICKET_RESOURCE;
const SEAT_VAULT =
  "internal_vault_tdx_2_1nzfsaxa4sdx0l55x05yf9zuz80wt9em092xmzvnj6t8rryvhsu6wat";
const ELECTION = "election1";
const HUB = "component_tdx_2_1cpym9e0ht2pv8lnxfq635jaumcmgh5ef0vasukp8qv4a0zsswvahfu";
const TREASURY =
  "component_tdx_2_1crl2w2l9lcztszdknmmj4zrkc9600yhspej8k8e79wxzl55x35daeg";
const ESCROW = "component_tdx_2_1czvzh4gk7xfdl5dvap0r39tcps3xhqjwthvdyvgedjm2z34q085cux";
const DISTRIBUTION =
  "component_tdx_2_1crgf2lnt8ctx7zmhln7g9e2pw3p5zeyhue4hlrwj0zvmzs7lu3ykpd";
const GRANT = "grant1";
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

function components(
  oracle: string | null = ORACLE,
  registry: string | null = null,
): Components {
  return {
    oracle,
    registry,
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
  registry?: string | null;
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
    components: components(
      options.oracle === undefined ? ORACLE : options.oracle,
      options.registry === undefined ? null : options.registry,
    ),
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

function arrayField(name: string, elements: unknown[]): JsonField {
  return { field_name: name, kind: "Array", type_name: "Decimal", elements };
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

function schedule(start: number, period = 600): unknown {
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

test("open_reveal: a reveal period under 375 seconds needs no stamp and is skipped", async () => {
  const http = new FakeHttp();
  http.on(
    "/stream/transactions",
    stream([schedule(nowSeconds() - 10, 300), commit()]),
  );
  const ctx = context(http);

  assert.deepEqual(await openReveal.findWork(ctx), []);
  assert.ok(
    (ctx.logger as MemoryLogger).infoMessages.includes("[open_reveal] nothing to open"),
  );
});

// ---------------------------------------------------------------------------
// open_vote
// ---------------------------------------------------------------------------

function consultation(
  id: string,
  voteStart: number,
  voteEnd: number,
  created: number,
  startMinEpoch = 0,
  endMinEpoch = 0,
): unknown {
  return event("ConsultationCreatedEvent", [
    field("consultation_id", id),
    field("vote_start", voteStart, "I64"),
    field("vote_end", voteEnd, "I64"),
    field("timestamp", created, "I64"),
    field("vote_start_min_epoch", startMinEpoch, "U64"),
    field("vote_end_min_epoch", endMinEpoch, "U64"),
  ]);
}

function voteOpened(id: string): unknown {
  return event("VoteOpenedEvent", [
    field("consultation_id", id),
    field("vote_open_epoch", 10, "U64"),
    field("vote_end_min_epoch", 10, "U64"),
    field("timestamp", nowSeconds() - 5, "I64"),
  ]);
}

function voteCast(id: string): unknown {
  return event("VoteCastEvent", [
    field("consultation_id", id),
    field("account", ACCOUNT, "Reference"),
    field("selection", [], "Array"),
  ]);
}

function voteContext(http: FakeHttp, options: ContextOptions = {}): JobContext {
  return context(http, { registry: REGISTRY, ...options });
}

test("open_vote: a delayed vote past the grace, the clock and the floor is due", async () => {
  const now = nowSeconds();
  const http = new FakeHttp();
  http.on(
    "/stream/transactions",
    stream([consultation("c1", now - 600, now + 3_600, now - 86_400, 10, 20)]),
  );

  const work = await openVote.findWork(voteContext(http));
  assert.equal(work.length, 1);
  assert.equal(work[0]?.id, "c1");
  assert.equal(work[0]?.consultation_id, "c1");
});

test("open_vote: a vote held by its start floor is not due", async () => {
  const now = nowSeconds();
  const http = new FakeHttp();
  http.on(
    "/stream/transactions",
    stream([consultation("c1", now - 600, now + 3_600, now - 86_400, 11)]),
  );

  assert.deepEqual(await openVote.findWork(voteContext(http, { epoch: 10 })), []);
});

test("open_vote: a vote within its grace period is not due", async () => {
  const now = nowSeconds();
  const http = new FakeHttp();
  http.on(
    "/stream/transactions",
    stream([consultation("c1", now - 30, now + 3_600, now - 86_400)]),
  );

  assert.deepEqual(await openVote.findWork(voteContext(http)), []);
});

test("open_vote: a vote whose opening is recorded is not due", async () => {
  const now = nowSeconds();
  const http = new FakeHttp();
  http.on(
    "/stream/transactions",
    stream([
      consultation("c1", now - 600, now + 3_600, now - 86_400),
      voteOpened("c1"),
    ]),
  );

  assert.deepEqual(await openVote.findWork(voteContext(http)), []);
});

test("open_vote: a vote that already has a ballot is not due", async () => {
  const now = nowSeconds();
  const http = new FakeHttp();
  http.on(
    "/stream/transactions",
    stream([
      consultation("c1", now - 600, now + 3_600, now - 86_400),
      voteCast("c1"),
    ]),
  );

  assert.deepEqual(await openVote.findWork(voteContext(http)), []);
});

test("open_vote: a vote closed under the live-time rule is not due", async () => {
  const now = nowSeconds();
  const http = new FakeHttp();
  http.on(
    "/stream/transactions",
    stream([consultation("c1", now - 600, now - 10, now - 86_400, 0, 10)]),
  );

  assert.deepEqual(await openVote.findWork(voteContext(http, { epoch: 10 })), []);
});

test("open_vote: a vote with no start delay needs nothing", async () => {
  const now = nowSeconds();
  const http = new FakeHttp();
  http.on(
    "/stream/transactions",
    stream([consultation("c1", now - 600, now + 3_600, now - 600)]),
  );

  assert.deepEqual(await openVote.findWork(voteContext(http)), []);
});

test("open_vote: a dry run previews open_vote and never submits", async () => {
  const now = nowSeconds();
  const http = new FakeHttp();
  http.on(
    "/stream/transactions",
    stream([consultation("c1", now - 600, now + 3_600, now - 86_400)]),
  );
  http.on("/transaction/preview", { body: { receipt: { status: "Succeeded" } } });
  const ctx = voteContext(http);

  const [item] = await openVote.findWork(ctx);
  assert.notEqual(item, undefined);
  assert.equal(await openVote.act(ctx, item!), "dry_run");
  const preview = http.bodies("/transaction/preview")[0] as { manifest: string };
  assert.match(preview.manifest, /open_vote/);
  assert.ok(preview.manifest.includes("c1"));
  assert.equal(http.count("/transaction/submit"), 0);
});

// ---------------------------------------------------------------------------
// burn_seat
// ---------------------------------------------------------------------------

function spaceCreated(spaceId = 7): unknown {
  return event("SpaceCreatedEvent", [
    field("space_id", spaceId, "U32"),
    field("seat_resource", SEAT_RESOURCE, "Reference"),
  ]);
}

function seatsSealed(termEnd: number, electionId = ELECTION): unknown {
  return event("ElectionSeatsSealedEvent", [
    field("election_id", electionId),
    field("space_id", 7, "U32"),
    field("term_end", termEnd, "I64"),
  ]);
}

function seatClaimed(holder = OTHER_ACCOUNT, seatIndex = 0, spaceId = 7): unknown {
  return event("SeatClaimedEvent", [
    field("election_id", ELECTION),
    field("seat_index", seatIndex, "U32"),
    field("holder", holder, "Reference"),
    field("local_id", "<election1_0>"),
    field("space_id", spaceId, "U32"),
  ]);
}

function seatRevoked(burned: boolean, seatIndex = 0, spaceId = 7): unknown {
  return event("SeatRevokedEvent", [
    field("election_id", ELECTION),
    field("seat_index", seatIndex, "U32"),
    field("space_id", spaceId, "U32"),
    field("recall_consultation_id", "recall1"),
    field("burned", burned, "Bool"),
  ]);
}

function seatBurned(seatIndex = 0): unknown {
  return event("SeatBurnedEvent", [
    field("election_id", ELECTION),
    field("seat_index", seatIndex, "U32"),
    field("space_id", 7, "U32"),
    field("local_id", "<election1_0>"),
  ]);
}

function vaultReply(vault: string | null): Reply {
  return {
    body: { items: vault === null ? [] : [{ vault_address: vault }], next_cursor: null },
  };
}

function burnContext(http: FakeHttp, options: ContextOptions = {}): JobContext {
  return context(http, { registry: REGISTRY, ...options });
}

test("burn_seat: a revoked seat with an unburned badge is due", async () => {
  const now = nowSeconds();
  const http = new FakeHttp();
  http.on(
    "/stream/transactions",
    stream([
      spaceCreated(),
      seatsSealed(now + 86_400),
      seatClaimed(),
      seatRevoked(false),
    ]),
  );
  http.on("/state/entity/page/non-fungible-vaults", vaultReply(SEAT_VAULT));

  const work = await burnSeat.findWork(burnContext(http));
  assert.equal(work.length, 1);
  assert.equal(work[0]?.id, `${ELECTION}:0`);
  assert.equal(work[0]?.holder_vault, SEAT_VAULT);
});

test("burn_seat: a seat past its term is due", async () => {
  const now = nowSeconds();
  const http = new FakeHttp();
  http.on(
    "/stream/transactions",
    stream([spaceCreated(), seatsSealed(now - 1), seatClaimed()]),
  );
  http.on("/state/entity/page/non-fungible-vaults", vaultReply(SEAT_VAULT));

  const work = await burnSeat.findWork(burnContext(http));
  assert.equal(work.length, 1);
});

test("burn_seat: a seat already burned is not due", async () => {
  const now = nowSeconds();
  const http = new FakeHttp();
  http.on(
    "/stream/transactions",
    stream([
      spaceCreated(),
      seatsSealed(now - 1),
      seatClaimed(),
      seatBurned(),
    ]),
  );

  assert.deepEqual(await burnSeat.findWork(burnContext(http)), []);
});

test("burn_seat: a revocation that burned the badge needs no call", async () => {
  const now = nowSeconds();
  const http = new FakeHttp();
  http.on(
    "/stream/transactions",
    stream([
      spaceCreated(),
      seatsSealed(now + 86_400),
      seatClaimed(),
      seatRevoked(true),
    ]),
  );

  assert.deepEqual(await burnSeat.findWork(burnContext(http)), []);
});

test("burn_seat: a holder with no vault is reported and skipped", async () => {
  const now = nowSeconds();
  const http = new FakeHttp();
  http.on(
    "/stream/transactions",
    stream([
      spaceCreated(),
      seatsSealed(now + 86_400),
      seatClaimed(),
      seatRevoked(false),
    ]),
  );
  http.on("/state/entity/page/non-fungible-vaults", vaultReply(null));
  const ctx = burnContext(http);

  assert.deepEqual(await burnSeat.findWork(ctx), []);
  assert.ok(
    (ctx.logger as MemoryLogger).warnMessages.some((message) =>
      message.includes("holds no vault"),
    ),
  );
});

test("burn_seat: a dry run previews burn_seat with the holder vault and never submits", async () => {
  const now = nowSeconds();
  const http = new FakeHttp();
  http.on(
    "/stream/transactions",
    stream([
      spaceCreated(),
      seatsSealed(now + 86_400),
      seatClaimed(),
      seatRevoked(false),
    ]),
  );
  http.on("/state/entity/page/non-fungible-vaults", vaultReply(SEAT_VAULT));
  http.on("/transaction/preview", { body: { receipt: { status: "Succeeded" } } });
  const ctx = burnContext(http);

  const [item] = await burnSeat.findWork(ctx);
  assert.notEqual(item, undefined);
  assert.equal(await burnSeat.act(ctx, item!), "dry_run");
  const preview = http.bodies("/transaction/preview")[0] as { manifest: string };
  assert.match(preview.manifest, /burn_seat/);
  assert.ok(preview.manifest.includes(ELECTION));
  assert.ok(preview.manifest.includes(SEAT_VAULT));
  assert.equal(http.count("/transaction/submit"), 0);
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

// ---------------------------------------------------------------------------
// settle
// ---------------------------------------------------------------------------

function distributionCreated(
  distribution = DISTRIBUTION,
  treasury = TREASURY,
  expiry = nowSeconds() - 100,
  minEpoch = 0,
): unknown {
  return event("SpaceTreasuryDistributionCreatedEvent", [
    field("component_address", treasury),
    field("request_id", "request1"),
    field("distribution", distribution),
    field("resource", SEAT_RESOURCE, "Reference"),
    field("expiry", expiry, "I64"),
    field("expiry_min_epoch", minEpoch, "U64"),
  ]);
}

function distributionSettled(distribution = DISTRIBUTION): unknown {
  return event("SpaceTreasuryDistributionSettledEvent", [
    field("component_address", TREASURY),
    field("distribution", distribution),
    field("open_distributions", 0, "U32"),
  ]);
}

function grantFunded(
  treasury = TREASURY,
  escrow = ESCROW,
  grantId = GRANT,
  milestoneCount = 2,
): unknown {
  return event("SpaceTreasuryGrantFundedEvent", [
    field("component_address", treasury),
    field("request_id", "request1"),
    field("escrow", escrow),
    field("grant_id", grantId),
    field("resource", SEAT_RESOURCE, "Reference"),
    field("amount", "2"),
    field("grantee", OTHER_ACCOUNT, "Reference"),
    field("title", "a grant"),
    arrayField("milestone_amounts", Array.from({ length: milestoneCount }, () => "1")),
  ]);
}

function grantSettled(escrow = ESCROW, grantId = GRANT): unknown {
  return event("SpaceTreasuryGrantSettledEvent", [
    field("component_address", TREASURY),
    field("escrow", escrow),
    field("grant_id", grantId),
    field("open_grants", 0, "U32"),
  ]);
}

function milestoneSettled(index: number, result = "Released"): unknown {
  return event("MilestoneSettledEvent", [
    field("grant_id", GRANT),
    field("milestone_index", index, "U32"),
    field("request_id", `request-${index}`),
    field("outcome_hex", "01"),
    field("result", result),
    field("amount", "1"),
  ]);
}

function fallbackAccrued(
  recipient = TREASURY,
  totalOwed = "5",
  amount = "5",
): unknown {
  return event("FallbackAccruedEvent", [
    field("grant_id", GRANT),
    field("account", recipient, "Reference"),
    field("amount", amount),
    field("total_owed", totalOwed),
  ]);
}

function fallbackClaimed(recipient = TREASURY, amount = "5"): unknown {
  return event("FallbackClaimedEvent", [
    field("account", recipient, "Reference"),
    field("amount", amount),
  ]);
}

function fungibleVaults(amounts: string[]): Reply {
  return {
    body: {
      items: [
        {
          fungible_resources: {
            total_count: amounts.length,
            items: amounts.map((amount) => ({
              resource_address: SEAT_RESOURCE,
              amount,
              aggregation_level: "Global",
            })),
          },
        },
      ],
    },
  };
}

function settleContext(http: FakeHttp, options: ContextOptions = {}): JobContext {
  const ctx = context(http, options);
  ctx.components.spaceTreasuryHub = HUB;
  return ctx;
}

test("settle: return_unclaimed is not due while the epoch floor still holds the window", async () => {
  const http = new FakeHttp();
  http.on("/stream/transactions", stream([distributionCreated(DISTRIBUTION, TREASURY, nowSeconds() - 100, 20)]));
  http.on("/state/entity/details", fungibleVaults(["5"]));
  const ctx = settleContext(http, { epoch: 10 });

  assert.deepEqual(await settle.findWork(ctx), []);
});

test("settle: return_unclaimed is due once the deadline and the epoch floor are met", async () => {
  const http = new FakeHttp();
  http.on("/stream/transactions", stream([distributionCreated(DISTRIBUTION, TREASURY, nowSeconds() - 100, 20)]));
  http.on("/state/entity/details", fungibleVaults(["5"]));
  http.on("/transaction/preview", { body: { receipt: { status: "Succeeded" } } });
  const ctx = settleContext(http, { epoch: 20 });

  const [item] = await settle.findWork(ctx);
  assert.equal(item?.kind, "return_unclaimed");
  assert.equal(await settle.act(ctx, item!), "dry_run");
  const preview = http.bodies("/transaction/preview")[0] as { manifest: string };
  assert.match(preview.manifest, /return_unclaimed/);
  assert.ok(preview.manifest.includes(DISTRIBUTION));
});

test("settle: settle_distribution is due only when the distribution holds nothing", async () => {
  const http = new FakeHttp();
  http.on("/stream/transactions", stream([distributionCreated()]));
  http.on("/state/entity/details", fungibleVaults(["0"]));
  http.on("/transaction/preview", { body: { receipt: { status: "Succeeded" } } });
  const ctx = settleContext(http, { epoch: 20 });

  const work = await settle.findWork(ctx);
  assert.deepEqual(
    work.map((item) => item.kind),
    ["settle_distribution"],
  );
  assert.equal(await settle.act(ctx, work[0]!), "dry_run");
  const preview = http.bodies("/transaction/preview")[0] as { manifest: string };
  assert.match(preview.manifest, /settle_distribution/);
  assert.ok(preview.manifest.includes(TREASURY));
  assert.ok(preview.manifest.includes(DISTRIBUTION));
});

test("settle: a distribution holding funds is not settled even after its window", async () => {
  const http = new FakeHttp();
  http.on("/stream/transactions", stream([distributionCreated()]));
  http.on("/state/entity/details", fungibleVaults(["1"]));
  const ctx = settleContext(http, { epoch: 20 });

  const [item] = await settle.findWork(ctx);
  assert.equal(item?.kind, "return_unclaimed");
  assert.equal(http.count("/transaction/preview"), 0);
});

test("settle: a refused deliver_fallback falls back to collect_grant_refunds", async () => {
  const http = new FakeHttp();
  http.on("/stream/transactions", stream([fallbackAccrued()]));
  http.on("/transaction/preview", {
    body: { receipt: { status: "Failed", error_message: "Resource is not listed in this treasury" } },
  });
  http.on("/transaction/preview", { body: { receipt: { status: "Succeeded" } } });
  const ctx = context(http);
  ctx.components.grantEscrow = ESCROW;
  ctx.components.spaceTreasuries = [TREASURY];

  const [item] = await settle.findWork(ctx);
  assert.equal(item?.kind, "deliver_fallback");
  assert.equal(await settle.act(ctx, item!), "dry_run");

  assert.equal(http.count("/transaction/preview"), 2);
  const previews = http.bodies("/transaction/preview") as Array<{ manifest: string }>;
  assert.match(previews[0]!.manifest, /deliver_fallback/);
  assert.ok(previews[0]!.manifest.includes(TREASURY));
  assert.match(previews[1]!.manifest, /collect_grant_refunds/);
  assert.equal(http.count("/transaction/submit"), 0);
});

test("settle: settle_grant waits until the escrow reports every milestone closed", async () => {
  const http = new FakeHttp();
  http.on("/stream/transactions", stream([grantFunded()]));
  http.on("/stream/transactions", stream([milestoneSettled(0)]));
  const ctx = settleContext(http);
  ctx.components.grantEscrow = ESCROW;

  assert.deepEqual(await settle.findWork(ctx), []);
});

test("settle: settle_grant is due once the escrow reports the grant closed", async () => {
  const http = new FakeHttp();
  http.on("/stream/transactions", stream([grantFunded()]));
  http.on("/stream/transactions", stream([milestoneSettled(0), milestoneSettled(1)]));
  http.on("/transaction/preview", { body: { receipt: { status: "Succeeded" } } });
  const ctx = settleContext(http);
  ctx.components.grantEscrow = ESCROW;

  const [item] = await settle.findWork(ctx);
  assert.equal(item?.kind, "settle_grant");
  assert.equal(await settle.act(ctx, item!), "dry_run");
  const preview = http.bodies("/transaction/preview")[0] as { manifest: string };
  assert.match(preview.manifest, /settle_grant/);
  assert.ok(preview.manifest.includes(GRANT));
  assert.ok(preview.manifest.includes(TREASURY));
});

test("settle: an already settled distribution or grant is not due again", async () => {
  const http = new FakeHttp();
  http.on(
    "/stream/transactions",
    stream([
      distributionCreated(),
      distributionSettled(),
      grantFunded(),
      grantSettled(),
    ]),
  );
  http.on("/stream/transactions", stream([]));
  const ctx = settleContext(http);

  assert.deepEqual(await settle.findWork(ctx), []);
  assert.equal(http.count("/state/entity/details"), 0);
});

test("settle: a refused return (the resource was delisted) is retried, not an error", async () => {
  const http = new FakeHttp();
  http.on("/stream/transactions", stream([distributionCreated()]));
  http.on("/stream/transactions", stream([distributionCreated()]));
  http.on("/state/entity/details", fungibleVaults(["5"]));
  http.on("/state/entity/details", fungibleVaults(["5"]));
  http.on("/transaction/preview", {
    body: { receipt: { status: "Failed", error_message: "Resource is not listed in this treasury" } },
  });
  const ctx = settleContext(http, { epoch: 20 });

  const [first] = await settle.findWork(ctx);
  assert.equal(await settle.act(ctx, first!), "previewed_refused");
  assert.deepEqual((ctx.logger as MemoryLogger).errorMessages, []);

  const [second] = await settle.findWork(ctx);
  assert.equal(second?.kind, "return_unclaimed");
});

test("burn_seat: space 0's seat resource is read from the registry state, not its creation event", async () => {
  const http = new FakeHttp();
  // Space 0's creation event is package-emitted and never appears on the registry stream.
  http.on(
    "/stream/transactions",
    stream([seatClaimed(OTHER_ACCOUNT, 0, 0), seatRevoked(false, 0, 0)]),
  );
  http.on("/state/entity/details", {
    body: {
      items: [
        {
          address: REGISTRY,
          details: {
            blueprint_name: "ConsultationRegistryV1",
            state: {
              fields: [
                field("spaces", "internal_keyvaluestore_tdx_2_1kzuv86tt4r0rk5jr0jcu2pfgxp2m8vyjgqn0se97gpr8xwtgylh6j4", "Own"),
              ],
            },
          },
        },
      ],
    },
  });
  http.on("/state/key-value-store/data", {
    body: {
      entries: [
        {
          value: {
            programmatic_json: {
              kind: "Tuple",
              type_name: "Space",
              fields: [field("space_id", 0, "U32"), field("seat_resource", SEAT_RESOURCE, "Reference")],
            },
          },
        },
      ],
    },
  });
  http.on("/state/entity/page/non-fungible-vaults", vaultReply(SEAT_VAULT));
  http.on("/transaction/preview", { body: { receipt: { status: "Succeeded" } } });
  const ctx = burnContext(http);

  const work = await burnSeat.findWork(ctx);
  assert.deepEqual(
    work.map((item) => item.id),
    [`${ELECTION}:0`],
  );
  assert.equal(await burnSeat.act(ctx, work[0]!), "dry_run");
  const preview = http.bodies("/transaction/preview")[0] as { manifest: string };
  assert.match(preview.manifest, /burn_seat/);
  assert.ok(preview.manifest.includes(ELECTION));
  assert.ok(preview.manifest.includes(SEAT_VAULT));

  const read = http.bodies("/state/key-value-store/data")[0] as {
    key_value_store_address: string;
    keys: Array<{ key_hex: string }>;
  };
  assert.equal(read.keys[0]!.key_hex, "5c0900000000");
});
