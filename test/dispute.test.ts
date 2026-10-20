import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { PrivateKey } from "@radixdlt/radix-engine-toolkit";

import { XRD_RESOURCES, type KeeperConfig } from "../src/config.ts";
import type { Components } from "../src/discover.ts";
import { loadDayHistory } from "../src/history.ts";
import { Limits, parseXrd, utcDay } from "../src/limits.ts";
import { nowSeconds, type JsonField } from "../src/oracle.ts";
import type { JobContext } from "../src/runner.ts";
import { StateFile } from "../src/state.ts";
import { Executor } from "../src/tx.ts";
import * as dispute from "../src/jobs/dispute.ts";
import {
  FakeHttp,
  makeGateway,
  statusBody,
  type Reply,
  type ReplySource,
} from "./fake-gateway.ts";
import { MemoryLogger, tempDir } from "./helpers.ts";

const ACCOUNT = "account_tdx_2_129x5uj99s5aka9ctqevg3zp8uyz03x6nfy3lghjfne73py0r0w077x";
const OTHER_ACCOUNT = "account_tdx_2_128w4g8w8g60tyg4edfu7pqcdcft5m0v4gmfhew2la3zcymu07rpptn";
const ORACLE = "component_tdx_2_1cz0g28zn8yrypku7643stnrkq9gvejtquvxpwp40pvqhptajn39cxp";
const CONSULTATION_IDENTIFIER =
  "component_tdx_2_1crgf2lnt8ctx7zmhln7g9e2pw3p5zeyhue4hlrwj0zvmzs7lu3ykpd";
const ELECTION_IDENTIFIER =
  "component_tdx_2_1cpym9e0ht2pv8lnxfq635jaumcmgh5ef0vasukp8qv4a0zsswvahfu";
const BOND_RESOURCE = XRD_RESOURCES.stokenet;
const TALLY_API = "https://api.test";
const KEY = new PrivateKey.Ed25519(new Uint8Array(32).fill(0x22));

const OUTCOME0 = "0".repeat(64);
const OUTCOME1 = `${"0".repeat(63)}1`;
const DRAW_OR_INVALID = `7${"f".repeat(63)}`;

/** The canonical hash of MATCH_DOCUMENT, produced by `radix-tally-verify --hash-only`. */
const MATCH_HASH = "4cf1175a826af58d7fd8025d73960f1adfa9188992eadc380a687d6462c89da2";
const WRONG_HASH = "f".repeat(64);

function baseDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tally_doc_version: 22,
    excluded_accounts: [],
    consultation_id: "c1",
    kind: "Binding",
    options: ["Reject", "Approve"],
    snapshot_state_version: 100,
    weight_sources: { native_pools: { mode: "all" } },
    votes: [],
    totals: ["0", "0"],
    total_weight: "0",
    abstain_weight: "0",
    voter_count: 0,
    quorum: "100",
    approval_threshold_pc: "50",
    min_affirmative_support: "10",
    min_unique_voters: 0,
    quorum_met: false,
    mas_met: false,
    seats: 0,
    approved: false,
    approve_weight: "0",
    reject_weight: "0",
    ...overrides,
  };
}

const MATCH_DOCUMENT = baseDocument();
const MISMATCH_DOCUMENT = baseDocument({ approved: true });

function field(name: string, value: unknown, kind = "String"): JsonField {
  return { field_name: name, value, kind };
}

function tuple(name: string, fields: JsonField[]): JsonField {
  return { field_name: name, kind: "Tuple", type_name: name, fields };
}

function event(name: string, emitter: string, fields: JsonField[]) {
  return {
    name,
    emitter: { type: "Method", entity: { entity_address: emitter, is_global: true } },
    data: { kind: "Tuple", type_name: name, fields },
  };
}

function requestPosted(bondAmount = "5"): unknown {
  return event("RequestPostedEvent", ORACLE, [
    field("request_id", "r1"),
    tuple("request_data", [
      field("bond_resource", BOND_RESOURCE, "ResourceAddress"),
      field("disputer_bond_amount", bondAmount, "Decimal"),
    ]),
  ]);
}

function proposal(
  deadline = nowSeconds() + 600,
  minEpoch = 0,
  outcome = OUTCOME1,
): unknown {
  return event("ProposedResolutionChangedEvent", ORACLE, [
    field("request_id", "r1"),
    tuple("proposed_resolution", [
      field("outcome", outcome),
      field("disputable_until", deadline, "I64"),
      field("disputable_min_epoch", minEpoch, "U64"),
    ]),
    field("resolution_attempt", 1, "U32"),
  ]);
}

function tallyAssertion(outcomeHex: string, hash = WRONG_HASH): unknown {
  return event("TallyAssertedEvent", CONSULTATION_IDENTIFIER, [
    field("request_id", "r1"),
    field("resolution_attempt", 1, "U32"),
    field("consultation_id", "c1"),
    field("proposed_outcome_hex", outcomeHex),
    field("tally_hash", hash),
  ]);
}

function electionAssertion(outcomeHex: string, hash = WRONG_HASH): unknown {
  return event("ElectionResultAssertedEvent", ELECTION_IDENTIFIER, [
    field("request_id", "r1"),
    field("resolution_attempt", 1, "U32"),
    field("consultation_id", "c1"),
    field("outcome_hex", outcomeHex),
    field("tally_hash", hash),
  ]);
}

interface ContextOptions {
  enabled?: boolean;
  maxBond?: number;
  maxBondsPerDay?: number;
  reserveFloor?: number;
  balance?: string;
  epoch?: number;
  liveSubmit?: boolean;
  official?: ReplySource;
  entityDetails?: ReplySource;
  historyTxs?: unknown[];
  historyFailure?: boolean;
}

function historyTransaction(fee: string, method: string): Record<string, unknown> {
  return {
    transaction_status: "CommittedSuccess",
    state_version: 1,
    intent_hash: `tx-${method}`,
    fee_paid: fee,
    manifest_instructions: [
      "CALL_METHOD",
      `    Address("${ACCOUNT}")`,
      '    "lock_fee"',
      `    Decimal("${fee}")`,
      ";",
      "CALL_METHOD",
      `    Address("${CONSULTATION_IDENTIFIER}")`,
      `    "${method}"`,
      ";",
    ].join("\n"),
  };
}

function components(withElection = false): Components {
  return {
    oracle: ORACLE,
    registry: null,
    identifierConsultation: CONSULTATION_IDENTIFIER,
    identifierElection: withElection ? ELECTION_IDENTIFIER : null,
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

interface TestContext extends JobContext {
  logger: MemoryLogger;
}

function context(
  http: FakeHttp,
  events: Record<string, unknown[]>,
  options: ContextOptions = {},
): TestContext {
  const stateVersion = 50;
  http.on("/status/gateway-status", {
    body: statusBody("stokenet", 100, options.epoch ?? 10),
  });
  http.always("/stream/transactions", (request) => {
    const body = request.body as {
      event_global_emitters_filter?: string[];
      affected_global_entities_filter?: string[];
    };
    if (body.affected_global_entities_filter !== undefined) {
      if (options.historyFailure === true) {
        return { status: 500, body: { error: "gateway gap" } };
      }
      return {
        body: { items: options.historyTxs ?? [], next_cursor: null },
      };
    }
    const emitter = body.event_global_emitters_filter?.[0] ?? "";
    const emitterEvents = events[emitter] ?? [];
    return {
      body: {
        items: [
          {
            state_version: stateVersion,
            intent_hash: `tx-${stateVersion}`,
            confirmed_at: "2026-10-20T00:00:00.000Z",
            receipt: { events: emitterEvents },
          },
        ],
        next_cursor: null,
      },
    };
  });
  http.on(
    "/state/entity/details",
    options.entityDetails ??
      ((request) => {
        const body = request.body as { at_ledger_state?: unknown };
        if (body.at_ledger_state !== undefined) {
          return { status: 400, body: { error: "no historical state" } };
        }
        return {
          body: {
            items: [
              {
                fungible_resources: {
                  items: [
                    { resource_address: BOND_RESOURCE, amount: options.balance ?? "100" },
                  ],
                },
              },
            ],
          },
        };
      }),
  );
  http.always("/api/official", options.official ?? { body: [] });
  http.on("/transaction/preview", { body: { receipt: { status: "Succeeded" } } });

  const config: KeeperConfig = {
    network: "stokenet",
    gateways: ["https://gateway.test"],
    account: ACCOUNT,
    key_env: "TEST_KEY",
    live_submit: options.liveSubmit ?? false,
    max_fee_xrd_per_tx: 0.1,
    max_fee_xrd_per_day: 1,
    reserve_floor_xrd: options.reserveFloor ?? 0,
    jobs: {
      dispute: {
        enabled: options.enabled ?? false,
        interval_secs: 300,
        max_bond: options.maxBond ?? 10,
        max_bonds_per_day: options.maxBondsPerDay ?? 2,
        tally_api: TALLY_API,
      },
    },
  };

  const gateway = makeGateway(http);
  const state = StateFile.load(join(tempDir(), "state.json"));
  const executor = new Executor({
    gateway,
    network: "stokenet",
    account: ACCOUNT,
    privateKey: KEY,
    liveSubmit: options.liveSubmit ?? false,
    maxFeePerTx: parseXrd("0.1"),
    limits: new Limits(state, {
      maxFeePerTx: parseXrd("1"),
      maxFeePerDay: parseXrd("10"),
      reserveFloor: parseXrd("0"),
    }),
    balance: async () => parseXrd(options.balance ?? "100"),
    logger: new MemoryLogger(),
    pollAttempts: 1,
    pollDelayMs: 0,
    randomNonce: () => 42,
  });

  return {
    config,
    gateway,
    components: components(),
    executor,
    state,
    logger: new MemoryLogger(),
    fetchImpl: http.fetch,
  };
}

function tallyReply(document: unknown): Reply {
  return { body: document };
}

function manifestOf(http: FakeHttp): string {
  const [body] = http.bodies("/transaction/preview");
  return String((body as { manifest?: unknown } | undefined)?.manifest ?? "");
}

test("dispute: disputes are off in the first log line", async () => {
  const http = new FakeHttp();
  const ctx = context(http, { [ORACLE]: [requestPosted(), proposal()], [CONSULTATION_IDENTIFIER]: [tallyAssertion(OUTCOME0)] });
  http.on("/api/consultation/c1/tally", tallyReply(MATCH_DOCUMENT));

  await dispute.findWork(ctx);
  assert.match(ctx.logger.infoMessages[0] ?? "", /disputes are off/);
});

test("dispute: a matching document does nothing", async () => {
  const http = new FakeHttp();
  const ctx = context(http, {
    [ORACLE]: [requestPosted(), proposal()],
    [CONSULTATION_IDENTIFIER]: [tallyAssertion(OUTCOME0, MATCH_HASH)],
  });
  http.on("/api/consultation/c1/tally", tallyReply(MATCH_DOCUMENT));

  const work = await dispute.findWork(ctx);
  assert.deepEqual(work, []);
  assert.ok(ctx.logger.infoMessages.some((message) => /MATCH/.test(message)));
});

test("dispute: a mismatch with disputes off only reports", async () => {
  const http = new FakeHttp();
  const ctx = context(http, {
    [ORACLE]: [requestPosted(), proposal()],
    [CONSULTATION_IDENTIFIER]: [tallyAssertion(OUTCOME1)],
  });
  http.on("/api/consultation/c1/tally", tallyReply(MISMATCH_DOCUMENT));

  const work = await dispute.findWork(ctx);
  assert.deepEqual(work, []);
  assert.ok(ctx.logger.warnMessages.some((message) => /MISMATCH/.test(message)));
  assert.ok(ctx.logger.warnMessages.some((message) => /disputes are off/.test(message)));
});

test("dispute: a mismatch with disputes on builds the counter-claim", async () => {
  const http = new FakeHttp();
  const ctx = context(
    http,
    {
      [ORACLE]: [requestPosted(), proposal()],
      [CONSULTATION_IDENTIFIER]: [tallyAssertion(OUTCOME1)],
    },
    { enabled: true },
  );
  http.on("/api/consultation/c1/tally", tallyReply(MISMATCH_DOCUMENT));

  const work = await dispute.findWork(ctx);
  assert.equal(work.length, 1);
  assert.equal(work[0]?.request_id, "r1");
  assert.equal(work[0]?.counter_variant, 0);

  assert.equal(await dispute.act(ctx, work[0]!), "dry_run");
  const manifest = manifestOf(http);
  assert.match(manifest, /dispute_resolution/);
  assert.ok(manifest.includes(ACCOUNT), "the bond comes from the configured account");
  assert.ok(manifest.includes(BOND_RESOURCE));
  assert.ok(!manifest.includes(OTHER_ACCOUNT), "no other account appears");
});

test("dispute: a hash-only mismatch with the same outcome is not disputed", async () => {
  const http = new FakeHttp();
  // The proposal and the assertion agree on Outcome0; only the document hash differs.
  const ctx = context(
    http,
    {
      [ORACLE]: [requestPosted(), proposal(nowSeconds() + 600, 0, OUTCOME0)],
      [CONSULTATION_IDENTIFIER]: [tallyAssertion(OUTCOME0)],
    },
    { enabled: true },
  );
  http.on("/api/consultation/c1/tally", tallyReply(MATCH_DOCUMENT));

  assert.deepEqual(await dispute.findWork(ctx), []);
  assert.ok(
    ctx.logger.warnMessages.some((message) => /equals the on-ledger proposal/.test(message)),
  );
});

test("dispute: a bond over max_bond is not posted", async () => {
  const http = new FakeHttp();
  const ctx = context(
    http,
    {
      [ORACLE]: [requestPosted("5"), proposal()],
      [CONSULTATION_IDENTIFIER]: [tallyAssertion(OUTCOME1)],
    },
    { enabled: true, maxBond: 1 },
  );
  http.on("/api/consultation/c1/tally", tallyReply(MISMATCH_DOCUMENT));

  assert.deepEqual(await dispute.findWork(ctx), []);
  assert.ok(ctx.logger.warnMessages.some((message) => /max_bond/.test(message)));
});

test("dispute: the daily count stops a further bond", async () => {
  const http = new FakeHttp();
  const ctx = context(
    http,
    {
      [ORACLE]: [requestPosted(), proposal()],
      [CONSULTATION_IDENTIFIER]: [tallyAssertion(OUTCOME1)],
    },
    { enabled: true, maxBondsPerDay: 2 },
  );
  http.on("/api/consultation/c1/tally", tallyReply(MISMATCH_DOCUMENT));
  ctx.state.addDispute(utcDay(new Date()));
  ctx.state.addDispute(utcDay(new Date()));

  assert.deepEqual(await dispute.findWork(ctx), []);
  assert.ok(ctx.logger.warnMessages.some((message) => /max_bonds_per_day/.test(message)));
});

test("dispute: the reserve floor stops the bond", async () => {
  const http = new FakeHttp();
  const ctx = context(
    http,
    {
      [ORACLE]: [requestPosted("5"), proposal()],
      [CONSULTATION_IDENTIFIER]: [tallyAssertion(OUTCOME1)],
    },
    { enabled: true, balance: "3", reserveFloor: 10 },
  );
  http.on("/api/consultation/c1/tally", tallyReply(MISMATCH_DOCUMENT));

  assert.deepEqual(await dispute.findWork(ctx), []);
  assert.ok(ctx.logger.warnMessages.some((message) => /reserve floor/.test(message)));
});

test("dispute: a closed window is skipped without fetching the document", async () => {
  const http = new FakeHttp();
  const ctx = context(http, {
    [ORACLE]: [requestPosted(), proposal(nowSeconds() - 10, 0)],
    [CONSULTATION_IDENTIFIER]: [tallyAssertion(OUTCOME1)],
  });
  http.on("/api/consultation/c1/tally", tallyReply(MISMATCH_DOCUMENT));

  assert.deepEqual(await dispute.findWork(ctx), []);
  assert.equal(http.count("/api/consultation/c1/tally"), 0);
});

test("dispute: an already disputed attempt is skipped", async () => {
  const http = new FakeHttp();
  const ctx = context(http, {
    [ORACLE]: [
      requestPosted(),
      proposal(),
      event("DisputeResolutionChangedEvent", ORACLE, [
        field("request_id", "r1"),
        field("resolution_attempt", 1, "U32"),
      ]),
    ],
    [CONSULTATION_IDENTIFIER]: [tallyAssertion(OUTCOME1)],
  });
  http.on("/api/consultation/c1/tally", tallyReply(MISMATCH_DOCUMENT));

  assert.deepEqual(await dispute.findWork(ctx), []);
  assert.equal(http.count("/api/consultation/c1/tally"), 0);
});

test("dispute: an already settled attempt is skipped", async () => {
  const http = new FakeHttp();
  const ctx = context(http, {
    [ORACLE]: [
      requestPosted(),
      proposal(),
      event("RequestSettledEvent", ORACLE, [
        field("request_id", "r1"),
        field("resolution_attempt", 1, "U32"),
      ]),
    ],
    [CONSULTATION_IDENTIFIER]: [tallyAssertion(OUTCOME1)],
  });
  http.on("/api/consultation/c1/tally", tallyReply(MISMATCH_DOCUMENT));

  assert.deepEqual(await dispute.findWork(ctx), []);
});

test("dispute: UNKNOWN is reported and never disputed", async () => {
  const http = new FakeHttp();
  const voted = baseDocument({
    votes: [{ account: OTHER_ACCOUNT, selection: [1], weight: "0" }],
  });
  const ctx = context(
    http,
    {
      [ORACLE]: [requestPosted(), proposal()],
      [CONSULTATION_IDENTIFIER]: [tallyAssertion(OUTCOME1)],
    },
    {
      enabled: true,
      // Verification's pinned historical read fails; the balance read is not reached.
      entityDetails: { status: 500, body: { error: "gateway gap" } },
    },
  );
  http.on("/api/consultation/c1/tally", tallyReply(voted));

  assert.deepEqual(await dispute.findWork(ctx), []);
  assert.ok(ctx.logger.warnMessages.some((message) => /UNKNOWN/.test(message)));
});

test("dispute: a fetch failure is reported and never disputed", async () => {
  const http = new FakeHttp();
  const ctx = context(
    http,
    {
      [ORACLE]: [requestPosted(), proposal()],
      [CONSULTATION_IDENTIFIER]: [tallyAssertion(OUTCOME1)],
    },
    { enabled: true },
  );
  http.on("/api/consultation/c1/tally", { status: 503, body: { error: "down" } });

  assert.deepEqual(await dispute.findWork(ctx), []);
  assert.ok(ctx.logger.warnMessages.some((message) => /unavailable/.test(message)));
});

test("dispute: a document the verifier cannot parse is reported only", async () => {
  const http = new FakeHttp();
  const ctx = context(
    http,
    {
      [ORACLE]: [requestPosted(), proposal()],
      [CONSULTATION_IDENTIFIER]: [tallyAssertion(OUTCOME1)],
    },
    { enabled: true },
  );
  http.on("/api/consultation/c1/tally", tallyReply({ version: 1 }));

  assert.deepEqual(await dispute.findWork(ctx), []);
  assert.ok(ctx.logger.warnMessages.some((message) => /cannot verify/.test(message)));
});

test("dispute: an election mismatch builds the winner counter-claim", async () => {
  const http = new FakeHttp();
  const electionDocument = baseDocument({
    kind: "Election",
    options: ["A", "B"],
    seats: 1,
    seat_rule: "Plurality",
    winners: [1],
  });
  const ctx = context(
    http,
    {
      [ORACLE]: [requestPosted(), proposal()],
      [ELECTION_IDENTIFIER]: [electionAssertion(dispute.encodeWinnerSet([1]))],
    },
    { enabled: true },
  );
  ctx.components = components(true);
  http.on("/api/consultation/c1/tally", tallyReply(electionDocument));

  const work = await dispute.findWork(ctx);
  assert.equal(work.length, 1);
  assert.equal(work[0]?.family, "election");
  assert.equal(work[0]?.outcome_hex, DRAW_OR_INVALID);

  assert.equal(await dispute.act(ctx, work[0]!), "dry_run");
  const manifest = manifestOf(http);
  assert.match(manifest, /dispute_election_result/);
  assert.match(manifest, /Enum<1u8>/);
});

test("dispute: the ledger's dispute count reaches max_bonds_per_day and stops a mismatch", async () => {
  const http = new FakeHttp();
  const ctx = context(
    http,
    {
      [ORACLE]: [requestPosted(), proposal()],
      [CONSULTATION_IDENTIFIER]: [tallyAssertion(OUTCOME1)],
    },
    {
      enabled: true,
      maxBondsPerDay: 2,
      historyTxs: [
        historyTransaction("0.1", "dispute_resolution"),
        historyTransaction("0.1", "dispute_election_result"),
      ],
    },
  );
  http.on("/api/consultation/c1/tally", tallyReply(MISMATCH_DOCUMENT));

  const summary = await loadDayHistory(ctx.state, ctx.gateway, ACCOUNT, ctx.logger);
  assert.equal(summary.ok, true);
  assert.equal(ctx.state.disputesToday(utcDay(new Date())), 2);

  assert.deepEqual(await dispute.findWork(ctx), []);
  assert.ok(ctx.logger.warnMessages.some((message) => /max_bonds_per_day/.test(message)));
});

test("dispute: a failed history read leaves disputes report-only for the run", async () => {
  const http = new FakeHttp();
  const ctx = context(
    http,
    {
      [ORACLE]: [requestPosted(), proposal()],
      [CONSULTATION_IDENTIFIER]: [tallyAssertion(OUTCOME1)],
    },
    { enabled: true, historyFailure: true },
  );
  http.on("/api/consultation/c1/tally", tallyReply(MISMATCH_DOCUMENT));

  ctx.history = await loadDayHistory(ctx.state, ctx.gateway, ACCOUNT, ctx.logger);
  assert.equal(ctx.history.ok, false);
  assert.ok(ctx.logger.warnMessages.some((message) => /history read failed/.test(message)));

  assert.deepEqual(await dispute.findWork(ctx), []);
  assert.ok(
    ctx.logger.warnMessages.some((message) =>
      /report-only for this run/.test(message),
    ),
  );
});

test("dispute: an unchanged mirror MATCH is not verified again, and a new body is", async () => {
  const http = new FakeHttp();
  const ctx = context(
    http,
    { [ORACLE]: [requestPosted(), proposal()] },
    {
      enabled: true,
      official: { body: [{ kind: "proposal", official_id: 7 }] },
    },
  );
  http.always("/api/official/proposal/7/tally", tallyReply(MATCH_DOCUMENT));

  const matches = (): number =>
    ctx.logger.infoMessages.filter((message) => /mirror proposal 7: MATCH/.test(message))
      .length;

  await dispute.findWork(ctx);
  assert.equal(matches(), 1);
  assert.equal(ctx.state.mirror("mirror:proposal:7")?.outcome, "match");

  await dispute.findWork(ctx);
  assert.equal(matches(), 1, "an unchanged document is not verified or reported again");

  http.always("/api/official/proposal/7/tally", tallyReply(MISMATCH_DOCUMENT));
  await dispute.findWork(ctx);
  assert.ok(
    ctx.logger.warnMessages.some((message) => /mirror proposal 7: MISMATCH/.test(message)),
  );
  assert.equal(ctx.state.mirror("mirror:proposal:7")?.outcome, "figures");
});

test("dispute: a mirror mismatch is reported and never builds a transaction", async () => {
  const http = new FakeHttp();
  const ctx = context(
    http,
    { [ORACLE]: [requestPosted(), proposal()] },
    {
      enabled: true,
      official: {
        body: [{ kind: "proposal", official_id: 7, verdict: { oter: {}, official: {} } }],
      },
    },
  );
  http.on("/api/official/proposal/7/tally", tallyReply(MISMATCH_DOCUMENT));

  assert.deepEqual(await dispute.findWork(ctx), []);
  assert.equal(http.count("/transaction/preview"), 0);
  assert.ok(ctx.logger.warnMessages.some((message) => /mirror proposal 7: MISMATCH/.test(message)));
});
