/**
 * The dispute watcher: check the tallies OTER asserts and, when one does not verify, report it
 * and (only with bond spending enabled) post a counter-claim before the challenge window closes.
 *
 * The watcher itself always reports. `[jobs.dispute].enabled` gates the one money path: a
 * mismatch is only turned into a `dispute_resolution` when that flag is true, the request's
 * dispute bond is within `max_bond`, the keeper has posted fewer than `max_bonds_per_day`
 * disputes today, and the account would stay above `reserve_floor_xrd`.
 *
 * A document that cannot be fetched, does not parse, names an unsupported version, or whose
 * recomputation ends UNKNOWN is reported and never disputed. A missing document is evidence for
 * a human, not for an automatic bond.
 *
 * A mismatch is only worth a bond when the OUTCOME diverges. A tally hash that differs while the
 * recomputation produces the same outcome is a sloppy assertion, not a wrong one: the vote
 * settles on the outcome, and the oracle refuses a dispute whose counter-claim equals the
 * proposal. Those are reported too.
 *
 * Mirror tallies of the official Radix DAO have no on-ledger hash to challenge, so they are
 * verified and reported only. The votes to read come from the platform API's `/api/official`
 * listing.
 */

import { createHash } from "node:crypto";

import { blake2b } from "@noble/hashes/blake2b";
import {
  ValueKind,
  address,
  array,
  bucket,
  decimal,
  enumeration,
  expression,
  resolveDecimal,
  str,
  u32,
} from "@radixdlt/radix-engine-toolkit";
import {
  GatewayError as TallyGatewayError,
  parseTallyDocument,
  verifyTallyDocument,
  type Difference,
  type GatewayClient,
  type Outcome as VerifyOutcome,
  type TallyDocument,
} from "radix-tally-verify";

import { XRD_RESOURCES, type DisputeJobConfig } from "../config.ts";
import { streamEvents, type LedgerEvent } from "../events.ts";
import { GatewayError, type Gateway } from "../gateway.ts";
import { formatXrd, parseXrd, utcDay } from "../limits.ts";
import {
  fieldEntry,
  fieldNumber,
  fieldString,
  jsonFields,
  nestedFields,
  nowSeconds,
} from "../oracle.ts";
import type { JobContext, WorkItem } from "../runner.ts";
import { buildManifest, type Manifest, type Outcome } from "../tx.ts";

const OUTCOME0_HEX = "0".repeat(64);
const OUTCOME1_HEX = `${"0".repeat(63)}1`;
const DRAW_OR_INVALID_HEX = `7${"f".repeat(63)}`;
const TOO_EARLY_HEX = `8${"0".repeat(63)}`;

type AssertionFamily = "consultation" | "election";

interface AssertionFact {
  key: string;
  family: AssertionFamily;
  identifier: string;
  request_id: string;
  attempt: number;
  consultation_id: string;
  /** The outcome the asserter claimed: `proposed_outcome_hex` or `outcome_hex`. */
  asserted_outcome: string;
  tally_hash: string;
  /** The state version the assertion event was read at. */
  anchor: number;
}

interface RequestTerms {
  bond_resource: string | null;
  disputer_bond_amount: string | null;
  anchor: number;
}

interface AttemptFact {
  disputable_until: number | null;
  disputable_min_epoch: number;
  /** The outcome the on-ledger proposal states; the oracle refuses an equal counter-claim. */
  proposed_outcome: string | null;
  disputed: boolean;
  settled: boolean;
  anchor: number;
}

interface Scan {
  assertions: Map<string, AssertionFact>;
  requests: Map<string, RequestTerms>;
  attempts: Map<string, AttemptFact>;
  highestAttempt: Map<string, number>;
  /** The highest state version read from each stream, for cursor advancement. */
  heads: Map<string, number>;
  lastStateVersion: number;
}

interface Stream {
  key: string;
  emitter: string;
  family: AssertionFamily | null;
}

function attemptKey(requestId: string, attempt: number): string {
  return `${requestId}\u0000${attempt}`;
}

/** A Decimal field, which the Gateway renders as a string but a test may give as a number. */
function decimalText(fields: readonly { field_name?: string; value?: unknown }[], name: string): string | null {
  const value = fieldEntry(fields, name)?.value;
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function emptyScan(): Scan {
  return {
    assertions: new Map(),
    requests: new Map(),
    attempts: new Map(),
    highestAttempt: new Map(),
    heads: new Map(),
    lastStateVersion: 0,
  };
}

function attemptFact(scan: Scan, key: string): AttemptFact {
  let fact = scan.attempts.get(key);
  if (fact === undefined) {
    fact = {
      disputable_until: null,
      disputable_min_epoch: 0,
      proposed_outcome: null,
      disputed: false,
      settled: false,
      anchor: 0,
    };
    scan.attempts.set(key, fact);
  }
  return fact;
}

/** The identifier streams, in the order their assertions are evaluated. */
function streamsFor(context: JobContext): Stream[] {
  const streams: Stream[] = [];
  const oracle = context.components.oracle;
  if (oracle !== null) {
    streams.push({ key: `dispute:oracle:${oracle}`, emitter: oracle, family: null });
  }
  const consultation = context.components.identifierConsultation;
  if (consultation !== null) {
    streams.push({
      key: `dispute:identifier:${consultation}`,
      emitter: consultation,
      family: "consultation",
    });
  }
  const election = context.components.identifierElection;
  if (election !== null) {
    streams.push({
      key: `dispute:identifier:${election}`,
      emitter: election,
      family: "election",
    });
  }
  return streams;
}

function readAssertion(scan: Scan, stream: Stream, event: LedgerEvent): void {
  const expected =
    stream.family === "consultation" ? "TallyAssertedEvent" : "ElectionResultAssertedEvent";
  if (stream.family === null || event.name !== expected) return;

  const fields = jsonFields(event.data);
  const requestId = fieldString(fields, "request_id");
  const attempt = fieldNumber(fields, "resolution_attempt");
  const consultationId = fieldString(fields, "consultation_id");
  const tallyHash = fieldString(fields, "tally_hash");
  const assertedOutcome = fieldString(
    fields,
    stream.family === "consultation" ? "proposed_outcome_hex" : "outcome_hex",
  );
  if (
    requestId === null ||
    attempt === null ||
    consultationId === null ||
    tallyHash === null ||
    assertedOutcome === null
  ) {
    return;
  }

  const key = attemptKey(requestId, attempt);
  if (scan.assertions.has(key)) return;
  scan.assertions.set(key, {
    key,
    family: stream.family,
    identifier: stream.emitter,
    request_id: requestId,
    attempt,
    consultation_id: consultationId,
    asserted_outcome: assertedOutcome.toLowerCase(),
    tally_hash: tallyHash,
    anchor: event.state_version,
  });
}

function readOracle(scan: Scan, event: LedgerEvent): void {
  const fields = jsonFields(event.data);
  const requestId = fieldString(fields, "request_id");

  switch (event.name) {
    case "RequestPostedEvent": {
      if (requestId === null) return;
      const data = nestedFields(fields, "request_data");
      if (data === null) return;
      const existing = scan.requests.get(requestId);
      const bondResource = fieldString(data, "bond_resource");
      const bondAmount = decimalText(data, "disputer_bond_amount");
      scan.requests.set(requestId, {
        bond_resource: bondResource,
        disputer_bond_amount: bondAmount,
        anchor: Math.min(existing?.anchor ?? event.state_version, event.state_version),
      });
      return;
    }
    case "ProposedResolutionChangedEvent": {
      const attempt = fieldNumber(fields, "resolution_attempt");
      const proposed = nestedFields(fields, "proposed_resolution");
      if (requestId === null || attempt === null || proposed === null) return;
      const until = fieldNumber(proposed, "disputable_until");
      if (until === null) return;
      const fact = attemptFact(scan, attemptKey(requestId, attempt));
      fact.disputable_until = until;
      // An older deployment carries no floor; its window closes on the deadline alone.
      fact.disputable_min_epoch = fieldNumber(proposed, "disputable_min_epoch") ?? 0;
      fact.proposed_outcome = fieldString(proposed, "outcome")?.toLowerCase() ?? null;
      fact.anchor = fact.anchor === 0 ? event.state_version : Math.min(fact.anchor, event.state_version);
      const known = scan.highestAttempt.get(requestId) ?? 0;
      if (attempt > known) scan.highestAttempt.set(requestId, attempt);
      return;
    }
    case "DisputeResolutionChangedEvent": {
      const attempt = fieldNumber(fields, "resolution_attempt");
      if (requestId === null || attempt === null) return;
      attemptFact(scan, attemptKey(requestId, attempt)).disputed = true;
      return;
    }
    case "RequestFinalizationEvent":
    case "RequestSettledEvent": {
      const attempt = fieldNumber(fields, "resolution_attempt");
      if (requestId === null || attempt === null) return;
      attemptFact(scan, attemptKey(requestId, attempt)).settled = true;
      return;
    }
    case "RequestIncreasedAttemptEvent": {
      if (requestId === null) return;
      const next = fieldNumber(fields, "new_resolution_attempt");
      if (next === null) return;
      scan.highestAttempt.set(
        requestId,
        Math.max(scan.highestAttempt.get(requestId) ?? 0, next),
      );
      return;
    }
    default:
      return;
  }
}

async function scanStreams(context: JobContext, streams: Stream[]): Promise<Scan> {
  const scan = emptyScan();
  for (const stream of streams) {
    const from = context.state.cursor(stream.key) ?? 0;
    scan.heads.set(stream.key, from);
    for await (const event of streamEvents(context.gateway, stream.emitter, from)) {
      scan.lastStateVersion = Math.max(scan.lastStateVersion, event.state_version);
      scan.heads.set(
        stream.key,
        Math.max(scan.heads.get(stream.key) ?? 0, event.state_version),
      );
      if (stream.family === null) readOracle(scan, event);
      else readAssertion(scan, stream, event);
    }
  }
  return scan;
}

/** A client for the Gateway slice `radix-tally-verify` reads. */
function tallyGateway(gateway: Gateway): GatewayClient {
  const post = async (
    path: string,
    body: unknown,
    stateVersion?: number,
  ): Promise<unknown> => {
    try {
      return await gateway.post(path, body, stateVersion);
    } catch (error) {
      if (error instanceof GatewayError) {
        throw new TallyGatewayError(error.message, error.status);
      }
      throw error;
    }
  };

  return {
    entityDetails: (addresses, stateVersion, opts) => {
      const body: Record<string, unknown> = {
        addresses,
        at_ledger_state: { state_version: stateVersion },
      };
      if (opts.global) body["aggregation_level"] = "Global";
      if (opts.explicitMetadata.length > 0) {
        body["opt_ins"] = { explicit_metadata: opts.explicitMetadata };
      }
      return post("/state/entity/details", body, stateVersion);
    },
    entityFungiblesPage: (address, cursor, stateVersion) =>
      post(
        "/state/entity/page/fungibles",
        {
          address,
          cursor,
          aggregation_level: "Global",
          at_ledger_state: { state_version: stateVersion },
        },
        stateVersion,
      ),
    validatorsList: (stateVersion, cursor) => {
      const body: Record<string, unknown> = {
        at_ledger_state: { state_version: stateVersion },
      };
      if (cursor !== null) body["cursor"] = cursor;
      return post("/state/validators/list", body, stateVersion);
    },
    entityDetailsAtTimestamp: async (address, timestampIso) => {
      const answer = await post("/state/entity/details", {
        addresses: [address],
        at_ledger_state: { timestamp: timestampIso },
      });
      const ledger = (answer as { ledger_state?: { proposer_round_timestamp?: unknown } })
        .ledger_state;
      const at = typeof ledger?.proposer_round_timestamp === "string"
        ? Date.parse(ledger.proposer_round_timestamp)
        : NaN;
      if (Number.isFinite(at) && at > Date.parse(timestampIso)) {
        throw new TallyGatewayError(
          `gateway answered at ${String(ledger?.proposer_round_timestamp)}, later than the requested ${timestampIso}`,
        );
      }
      return answer;
    },
    entityDetailsVault: (addresses, stateVersion) =>
      post(
        "/state/entity/details",
        {
          addresses,
          aggregation_level: "Vault",
          at_ledger_state: { state_version: stateVersion },
        },
        stateVersion,
      ),
    entityNonFungiblesPage: (address, cursor, stateVersion) => {
      const body: Record<string, unknown> = {
        address,
        aggregation_level: "Vault",
        opt_ins: { non_fungible_include_nfids: true },
        at_ledger_state: { state_version: stateVersion },
      };
      if (cursor !== null) body["cursor"] = cursor;
      return post("/state/entity/page/non-fungibles", body, stateVersion);
    },
    entityNonFungiblesAmountsPage: (address, cursor, stateVersion) => {
      const body: Record<string, unknown> = {
        address,
        aggregation_level: "Global",
        at_ledger_state: { state_version: stateVersion },
      };
      if (cursor !== null) body["cursor"] = cursor;
      return post("/state/entity/page/non-fungibles", body, stateVersion);
    },
    entityNonFungibleVaultsPage: (address, resource, cursor, stateVersion) =>
      post(
        "/state/entity/page/non-fungible-vaults",
        {
          address,
          resource_address: resource,
          cursor,
          opt_ins: { non_fungible_include_nfids: true },
          at_ledger_state: { state_version: stateVersion },
        },
        stateVersion,
      ),
    entityNonFungibleVaultIdsPage: (address, resource, vaultAddress, cursor, stateVersion) =>
      post(
        "/state/entity/page/non-fungible-vault/ids",
        {
          address,
          resource_address: resource,
          vault_address: vaultAddress,
          cursor,
          at_ledger_state: { state_version: stateVersion },
        },
        stateVersion,
      ),
    nonFungibleData: (resource, ids, stateVersion) =>
      post(
        "/state/non-fungible/data",
        {
          resource_address: resource,
          non_fungible_ids: ids,
          at_ledger_state: { state_version: stateVersion },
        },
        stateVersion,
      ),
    keyValueStoreKeys: (kvsAddress, cursor, stateVersion) => {
      const body: Record<string, unknown> = {
        key_value_store_address: kvsAddress,
        at_ledger_state: { state_version: stateVersion },
      };
      if (cursor !== null) body["cursor"] = cursor;
      return post("/state/key-value-store/keys", body, stateVersion);
    },
    keyValueStoreData: (kvsAddress, keys, stateVersion) =>
      post(
        "/state/key-value-store/data",
        {
          key_value_store_address: kvsAddress,
          keys,
          at_ledger_state: { state_version: stateVersion },
        },
        stateVersion,
      ),
  };
}

/** The winner-set encoding: each seated index as 4-byte BIG-ENDIAN, in seating order,
 * blake2b-256, lowercase hex — the election identifier's `encode_winner_set`. */
export function encodeWinnerSet(winners: readonly number[]): string {
  const bytes = new Uint8Array(winners.length * 4);
  for (let index = 0; index < winners.length; index += 1) {
    const value = winners[index] as number;
    const offset = index * 4;
    bytes[offset] = (value >>> 24) & 0xff;
    bytes[offset + 1] = (value >>> 16) & 0xff;
    bytes[offset + 2] = (value >>> 8) & 0xff;
    bytes[offset + 3] = value & 0xff;
  }
  return Buffer.from(blake2b(bytes, { dkLen: 32 })).toString("hex");
}

function winnerList(text: string): number[] | null | undefined {
  if (text === "null") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  if (!parsed.every((value) => Number.isInteger(value) && Number(value) >= 0)) {
    return undefined;
  }
  return parsed.map((value) => Number(value));
}

function differenceOf(outcome: VerifyOutcome, field: string): Difference | undefined {
  return outcome.kind === "figures"
    ? outcome.differences.find((difference) => difference.field === field)
    : undefined;
}

interface CounterOutcome {
  hex: string;
  /** For an election, the allocation behind `hex`; null is the DrawOrInvalid escape. */
  winners: number[] | null;
}

/**
 * The outcome the recomputation supports, as the 64-hex value the identifier compares, or null
 * when the verification found no outcome divergence (or none can be derived).
 */
function recomputedOutcome(
  family: AssertionFamily,
  outcome: VerifyOutcome,
  doc: TallyDocument | null,
): CounterOutcome | null {
  if (outcome.kind === "match" || outcome.kind === "unknown" || outcome.kind === "malformed") {
    return null;
  }

  if (family === "consultation") {
    let approved: string | undefined;
    if (outcome.kind === "figures") {
      approved = differenceOf(outcome, "approved")?.recomputed;
    } else if (doc?.approved !== null && doc?.approved !== undefined) {
      approved = String(doc.approved);
    }
    if (approved === undefined) return null;
    return {
      hex: approved === "true" ? OUTCOME1_HEX : OUTCOME0_HEX,
      winners: null,
    };
  }

  let winnersText: string | undefined;
  if (outcome.kind === "figures") {
    winnersText = differenceOf(outcome, "winners")?.recomputed;
  } else if (doc?.winners !== null && doc?.winners !== undefined) {
    winnersText = `[${doc.winners.join(",")}]`;
  }
  if (winnersText === undefined) return null;
  const winners = winnerList(winnersText);
  if (winners === undefined) return null;
  return {
    hex: winners === null ? DRAW_OR_INVALID_HEX : encodeWinnerSet(winners),
    winners,
  };
}

function consultationVariant(outcomeHex: string): number | null {
  switch (outcomeHex) {
    case OUTCOME0_HEX:
      return 0;
    case OUTCOME1_HEX:
      return 1;
    case DRAW_OR_INVALID_HEX:
      return 2;
    case TOO_EARLY_HEX:
      return 3;
    default:
      return null;
  }
}

async function fetchText(url: string, fetchImpl: typeof fetch): Promise<string> {
  const response = await fetchImpl(url, {
    method: "GET",
    headers: { accept: "application/json", "user-agent": "oter-keeper/0.1.0" },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  if (response.status === 202) {
    throw new Error("the platform is still computing this tally (HTTP 202)");
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}`);
  }
  return text;
}

async function fetchJson(url: string, fetchImpl: typeof fetch): Promise<unknown> {
  const text = await fetchText(url, fetchImpl);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`the answer from ${url} is not JSON`);
  }
}

/** A stable fingerprint of the document as served, so an unchanged body is not re-verified. */
export function documentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function storedOutcome(outcome: string): string {
  switch (outcome) {
    case "figures":
    case "serialization":
      return "MISMATCH (unchanged document, reported once today)";
    case "unknown":
      return "UNKNOWN (unchanged document, reported once today)";
    case "malformed":
      return "cannot verify (unchanged document, reported once today)";
    default:
      return `${outcome} (unchanged document, reported once today)`;
  }
}

function describe(outcome: VerifyOutcome): string {
  switch (outcome.kind) {
    case "match":
      return outcome.hashChecked ? "MATCH" : "MATCH (no on-ledger hash)";
    case "figures": {
      const first = outcome.differences[0];
      const detail =
        first === undefined
          ? "figure disagreement"
          : `${first.field}: document ${first.document}, recomputed ${first.recomputed}`;
      return `MISMATCH: ${outcome.differences.length} figure difference(s); ${detail}`;
    }
    case "serialization":
      return `MISMATCH: ${outcome.detail}`;
    case "unknown":
      return `UNKNOWN: ${outcome.reason}`;
    case "malformed":
      return `cannot verify: ${outcome.reason}`;
  }
}

export function consultationDisputeManifest(
  account: string,
  identifier: string,
  bondResource: string,
  bondAmount: string,
  requestId: string,
  variant: number,
): Manifest {
  return buildManifest((builder) =>
    builder
      .callMethod(account, "withdraw", [address(bondResource), decimal(bondAmount)])
      .takeFromWorktop(bondResource, resolveDecimal(bondAmount), (next, bondBucket) =>
        next.callMethod(identifier, "dispute_resolution", [
          str(requestId),
          enumeration(variant),
          bucket(bondBucket),
        ]),
      )
      .callMethod(account, "try_deposit_batch_or_abort", [
        expression("EntireWorktop"),
        enumeration(0),
      ]),
  );
}

export function electionDisputeManifest(
  account: string,
  identifier: string,
  bondResource: string,
  bondAmount: string,
  requestId: string,
  winners: number[] | null,
): Manifest {
  const counter =
    winners === null
      ? enumeration(1)
      : enumeration(0, array(ValueKind.U32, ...winners.map((winner) => u32(winner))));
  return buildManifest((builder) =>
    builder
      .callMethod(account, "withdraw", [address(bondResource), decimal(bondAmount)])
      .takeFromWorktop(bondResource, resolveDecimal(bondAmount), (next, bondBucket) =>
        next.callMethod(identifier, "dispute_election_result", [
          str(requestId),
          counter,
          bucket(bondBucket),
        ]),
      )
      .callMethod(account, "try_deposit_batch_or_abort", [
        expression("EntireWorktop"),
        enumeration(0),
      ]),
  );
}

interface MirrorRow {
  kind: string;
  official_id: string | number;
}

function mirrorRows(listing: unknown): MirrorRow[] {
  if (!Array.isArray(listing)) return [];
  const rows: MirrorRow[] = [];
  for (const entry of listing) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    const kind = row.kind;
    const id = row.official_id;
    if (typeof kind !== "string") continue;
    if (typeof id !== "string" && typeof id !== "number") continue;
    rows.push({ kind, official_id: id });
  }
  return rows;
}

async function checkMirrors(
  context: JobContext,
  api: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  let listing: unknown;
  try {
    listing = await fetchJson(`${api}/api/official`, fetchImpl);
  } catch (error) {
    context.logger.warn(
      `[dispute] official vote listing unavailable: ${(error as Error).message}`,
    );
    return;
  }

  const client = tallyGateway(context.gateway);
  const xrd = XRD_RESOURCES[context.config.network];
  const day = utcDay(new Date());
  for (const row of mirrorRows(listing)) {
    const id = String(row.official_id);
    const kind = encodeURIComponent(row.kind);
    const stateKey = `mirror:${kind}:${id}`;

    let text: string;
    try {
      text = await fetchText(`${api}/api/official/${kind}/${encodeURIComponent(id)}/tally`, fetchImpl);
    } catch (error) {
      context.logger.warn(
        `[dispute] mirror ${row.kind} ${id}: tally unavailable: ${(error as Error).message}`,
      );
      continue;
    }
    const hash = documentHash(text);

    // An unchanged document is not verified again. A MATCH was reported once; a MISMATCH or
    // UNKNOWN may be repeated, but at most once per UTC day, because nothing about it changed.
    const cached = context.state.mirror(stateKey);
    if (cached !== null && cached.hash === hash) {
      if (cached.outcome === "match" || cached.day === day) continue;
      context.logger.warn(`[dispute] mirror ${row.kind} ${id}: ${storedOutcome(cached.outcome)}`);
      context.state.setMirror(stateKey, { ...cached, day });
      continue;
    }

    let document: unknown;
    try {
      document = JSON.parse(text) as unknown;
    } catch {
      context.logger.warn(
        `[dispute] mirror ${row.kind} ${id}: tally unavailable: the answer is not JSON`,
      );
      continue;
    }

    let outcome: VerifyOutcome;
    try {
      // No on-ledger hash exists for an official vote, so only the figures are checked.
      outcome = await verifyTallyDocument(document, null, client, xrd);
    } catch (error) {
      context.logger.warn(
        `[dispute] mirror ${row.kind} ${id}: verification failed: ${(error as Error).message}`,
      );
      continue;
    }

    context.state.setMirror(stateKey, { hash, outcome: outcome.kind, day });
    const message = `[dispute] mirror ${row.kind} ${id}: ${describe(outcome)}`;
    if (outcome.kind === "match") context.logger.info(message);
    else context.logger.warn(message);
  }
}

export async function findWork(context: JobContext): Promise<WorkItem[]> {
  const config = context.config;
  const disputeConfig = config.jobs["dispute"] as DisputeJobConfig | undefined;
  const enabled = disputeConfig?.enabled === true;
  context.logger.info(
    enabled
      ? "[dispute] disputes are on (a verified mismatch may post a bond)"
      : "[dispute] disputes are off; mismatches are reported only",
  );

  const api = disputeConfig?.tally_api?.replace(/\/+$/, "") ?? null;
  const fetchImpl = context.fetchImpl ?? fetch;
  if (api === null) {
    context.logger.info(
      "[dispute] no tally_api is configured; asserted tallies cannot be checked",
    );
  }

  const streams = streamsFor(context);
  const scan = streams.length === 0 ? emptyScan() : await scanStreams(context, streams);
  const status = await context.gateway.status();
  const now = nowSeconds();
  const epoch = status.ledger_state.epoch;
  const day = utcDay(new Date());
  const xrd = XRD_RESOURCES[config.network];
  const client = tallyGateway(context.gateway);

  const work: WorkItem[] = [];
  for (const assertion of scan.assertions.values()) {
    const attempt = scan.attempts.get(assertion.key);
    if (attempt?.disputed === true || attempt?.settled === true) continue;
    const highest = scan.highestAttempt.get(assertion.request_id) ?? assertion.attempt;
    if (assertion.attempt < highest) continue;

    if (attempt === undefined || attempt.disputable_until === null) {
      context.logger.warn(
        `[dispute] request ${assertion.request_id} attempt ${assertion.attempt}: no proposal seen; not disputing`,
      );
      continue;
    }
    if (now >= attempt.disputable_until && epoch >= attempt.disputable_min_epoch) {
      context.logger.info(
        `[dispute] request ${assertion.request_id} attempt ${assertion.attempt}: dispute window closed`,
      );
      continue;
    }

    const label = `${assertion.family} ${assertion.consultation_id} request ${assertion.request_id}`;
    if (api === null) {
      context.logger.warn(`[dispute] ${label}: no tally_api to fetch the document from`);
      continue;
    }

    let document: unknown;
    try {
      document = await fetchJson(
        `${api}/api/consultation/${encodeURIComponent(assertion.consultation_id)}/tally`,
        fetchImpl,
      );
    } catch (error) {
      context.logger.warn(
        `[dispute] ${label}: tally document unavailable: ${(error as Error).message}`,
      );
      continue;
    }

    let outcome: VerifyOutcome;
    try {
      outcome = await verifyTallyDocument(document, assertion.tally_hash, client, xrd);
    } catch (error) {
      context.logger.warn(`[dispute] ${label}: verification failed: ${(error as Error).message}`);
      continue;
    }

    let doc: TallyDocument | null = null;
    try {
      ({ doc } = parseTallyDocument(document));
    } catch {
      doc = null;
    }

    const report = `[dispute] ${label}: ${describe(outcome)}`;
    if (outcome.kind === "match") {
      context.logger.info(report);
      continue;
    }
    context.logger.warn(report);
    if (outcome.kind !== "figures" && outcome.kind !== "serialization") continue;

    const counter = recomputedOutcome(assertion.family, outcome, doc);
    if (counter === null) {
      context.logger.warn(
        `[dispute] ${label}: the claim differs, but not on the outcome; a bond would buy no ruling`,
      );
      continue;
    }
    const counterHex = counter.hex;
    if (counterHex === attempt.proposed_outcome) {
      context.logger.warn(
        `[dispute] ${label}: hash differs, but the recomputed outcome equals the on-ledger proposal; the oracle would refuse the dispute`,
      );
      continue;
    }

    const terms = scan.requests.get(assertion.request_id);
    if (terms === undefined || terms.bond_resource === null || terms.disputer_bond_amount === null) {
      context.logger.warn(`[dispute] ${label}: the request's bond terms were not seen; not disputing`);
      continue;
    }

    let bond: bigint;
    try {
      bond = parseXrd(terms.disputer_bond_amount);
    } catch (error) {
      context.logger.warn(
        `[dispute] ${label}: the dispute bond is not an XRD amount (${(error as Error).message}); not disputing`,
      );
      continue;
    }

    if (!enabled || disputeConfig === undefined) {
      context.logger.warn(`[dispute] ${label}: disputes are off; not posting a ${formatXrd(bond)} bond`);
      continue;
    }
    if (context.history?.ok === false) {
      context.logger.warn(
        `[dispute] ${label}: today's account history could not be read at start; disputes are report-only for this run`,
      );
      continue;
    }
    const maxBond = parseXrd(disputeConfig.max_bond);
    if (bond > maxBond) {
      context.logger.warn(
        `[dispute] ${label}: the ${formatXrd(bond)} XRD bond exceeds max_bond ${formatXrd(maxBond)} XRD; not disputing`,
      );
      continue;
    }
    const postedToday = context.state.disputesToday(day);
    if (postedToday >= disputeConfig.max_bonds_per_day) {
      context.logger.warn(
        `[dispute] ${label}: ${postedToday} dispute(s) already posted today, at max_bonds_per_day ${disputeConfig.max_bonds_per_day}; not disputing`,
      );
      continue;
    }

    let balance: bigint;
    try {
      balance = parseXrd(await context.gateway.accountXrdBalance(config.account));
    } catch (error) {
      context.logger.warn(
        `[dispute] ${label}: cannot read the account balance (${(error as Error).message}); not disputing`,
      );
      continue;
    }
    const floor = parseXrd(config.reserve_floor_xrd);
    const remaining =
      terms.bond_resource === xrd ? balance - bond : balance;
    if (remaining < floor) {
      const left = remaining < 0n ? "a negative balance" : `${formatXrd(remaining)} XRD`;
      context.logger.warn(
        `[dispute] ${label}: the bond would leave ${left}, under the reserve floor ${formatXrd(floor)} XRD; not disputing`,
      );
      continue;
    }

    let counterVariant: number | null = null;
    let counterWinners: number[] | null = null;
    if (assertion.family === "consultation") {
      counterVariant = consultationVariant(counterHex);
      if (counterVariant === null) {
        context.logger.warn(
          `[dispute] ${label}: recomputed outcome ${counterHex} is not a disputable verdict`,
        );
        continue;
      }
    } else {
      counterWinners = counter.winners;
    }

    work.push({
      id: `${assertion.request_id}:${assertion.attempt}`,
      request_id: assertion.request_id,
      attempt: assertion.attempt,
      family: assertion.family,
      identifier: assertion.identifier,
      consultation_id: assertion.consultation_id,
      bond_resource: terms.bond_resource,
      bond_amount: terms.disputer_bond_amount,
      outcome_hex: counterHex,
      counter_variant: counterVariant,
      counter_winners: counterWinners,
      anchor_identifier: assertion.anchor,
      anchor_oracle: terms.anchor,
      summary: `${label}: MISMATCH, ${formatXrd(bond)} XRD bond, counter-claim ${counterHex}`,
    });
  }

  // Keep each stream's cursor before the earliest fact an unresolved dispute needs. Once every
  // item is settled or reported, the cursor may move to the head.
  for (const stream of streams) {
    const from = context.state.cursor(stream.key) ?? 0;
    const anchors = work
      .map((item) =>
        stream.family === null ? Number(item.anchor_oracle) : Number(item.anchor_identifier),
      )
      .filter((anchor) => Number.isFinite(anchor) && anchor >= 0);
    const head = Math.max(status.ledger_state.state_version, scan.heads.get(stream.key) ?? 0);
    const next = anchors.length === 0 ? head : Math.min(...anchors);
    if (next >= from) context.state.setCursor(stream.key, next);
  }

  if (api !== null) await checkMirrors(context, api, fetchImpl);

  context.logger.info(
    work.length === 0
      ? "[dispute] nothing to dispute"
      : `[dispute] ${work.length} dispute(s) due: ${work
          .map((item) => String(item.summary))
          .join("; ")}`,
  );
  return work;
}

export async function act(context: JobContext, item: WorkItem): Promise<Outcome> {
  const family = String(item.family);
  const requestId = String(item.request_id);
  const bondResource = String(item.bond_resource);
  const bondAmount = String(item.bond_amount);
  const identifier = String(item.identifier);

  let manifest: Manifest;
  if (family === "election") {
    manifest = electionDisputeManifest(
      context.config.account,
      identifier,
      bondResource,
      bondAmount,
      requestId,
      item.counter_winners as number[] | null,
    );
  } else {
    manifest = consultationDisputeManifest(
      context.config.account,
      identifier,
      bondResource,
      bondAmount,
      requestId,
      Number(item.counter_variant),
    );
  }

  const outcome = await context.executor.run(manifest, `dispute ${requestId}`);
  if (outcome === "submitted" || outcome === "committed") {
    context.state.addDispute(utcDay(new Date()));
  }
  return outcome;
}
