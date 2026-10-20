/**
 * Bring the money home: the permissionless calls that close treasuries' open work.
 *
 * A space treasury counts every distribution and grant it has funded until each is settled,
 * and a space with work out cannot be archived. Four calls finish it, and nobody makes them
 * unless a stranger does:
 *
 *   - a distribution's `return_unclaimed`, once its claim window has closed under the
 *     live-time rule (the deadline AND the epoch floor) and it still holds a remainder;
 *   - the treasury's `settle_distribution`, once the component holds nothing;
 *   - the grant escrow's `deliver_fallback` for a treasury with a parked refund, with the
 *     treasury's `collect_grant_refunds` as the pull path when the push is refused (a
 *     treasury that delisted the resource refuses every deposit);
 *   - the treasury's `settle_grant`, once the escrow reports the grant closed.
 *
 * A refused preview is ordinary here: the window is held by the epoch floor, the resource was
 * delisted, or someone else made the call first. It is logged and retried, never an error.
 *
 * Treasuries are found from the hub's stream (`SpaceTreasurySpawnedEvent`, and every
 * treasury's own events ride that stream because each one calls the hub's `touch`) and from
 * `[components]`. Distributions and grants come from the treasuries' creation events, fallback
 * balances and milestone states from the escrow's stream. The cursor is kept before the
 * earliest unresolved creation event so a restart can still rebuild it.
 */

import { address, str } from "@radixdlt/radix-engine-toolkit";

import { streamEvents, type LedgerEvent } from "../events.ts";
import { formatXrd, parseXrd } from "../limits.ts";
import {
  fieldElements,
  fieldNumber,
  fieldString,
  isRecord,
  jsonFields,
  nowSeconds,
  readComponentState,
  readFungibleHoldings,
  type JsonField,
} from "../oracle.ts";
import type { JobContext, WorkItem } from "../runner.ts";
import { buildCall, type Outcome } from "../tx.ts";

type GrantStatus = "open" | "closed";

interface DistributionFacts {
  distribution: string;
  treasury: string | null;
  resource: string | null;
  expiry: number | null;
  expiry_min_epoch: number | null;
  settled: boolean;
  /** Stream address to the earliest state version that still matters for this item. */
  anchors: Map<string, number>;
}

interface GrantFacts {
  grant_id: string;
  treasury: string | null;
  escrow: string | null;
  milestones: number | null;
  statuses: Map<number, GrantStatus>;
  settled: boolean;
  anchors: Map<string, number>;
}

interface FallbackFacts {
  escrow: string;
  recipient: string;
  owed: bigint;
  anchors: Map<string, number>;
}

interface Scan {
  treasuries: Set<string>;
  escrows: Set<string>;
  distributions: Map<string, DistributionFacts>;
  grants: Map<string, GrantFacts>;
  fallbacks: Map<string, FallbackFacts>;
  /** Escrow events seen twice, because the hub stream carries them too. */
  seen: Set<string>;
  /** The highest state version read from each stream. */
  last: Map<string, number>;
}

function distributionOf(scan: Scan, address: string): DistributionFacts {
  let facts = scan.distributions.get(address);
  if (facts === undefined) {
    facts = {
      distribution: address,
      treasury: null,
      resource: null,
      expiry: null,
      expiry_min_epoch: null,
      settled: false,
      anchors: new Map(),
    };
    scan.distributions.set(address, facts);
  }
  return facts;
}

function grantKey(escrow: string | null, grantId: string): string {
  return `${escrow ?? "?"}\u0000${grantId}`;
}

function grantOf(
  scan: Scan,
  escrow: string | null,
  grantId: string,
): GrantFacts {
  const key = grantKey(escrow, grantId);
  let facts = scan.grants.get(key);
  if (facts === undefined) {
    facts = {
      grant_id: grantId,
      treasury: null,
      escrow,
      milestones: null,
      statuses: new Map(),
      settled: false,
      anchors: new Map(),
    };
    scan.grants.set(key, facts);
  }
  return facts;
}

function fallbackOf(
  scan: Scan,
  escrow: string,
  recipient: string,
): FallbackFacts {
  const key = `${escrow}\u0000${recipient}`;
  let facts = scan.fallbacks.get(key);
  if (facts === undefined) {
    facts = { escrow, recipient, owed: 0n, anchors: new Map() };
    scan.fallbacks.set(key, facts);
  }
  return facts;
}

function anchor(
  facts: { anchors: Map<string, number> },
  source: string,
  stateVersion: number,
): void {
  const known = facts.anchors.get(source);
  if (known === undefined || stateVersion < known) facts.anchors.set(source, stateVersion);
}

function parseAmount(text: string | null): bigint | null {
  if (text === null) return null;
  try {
    return parseXrd(text);
  } catch {
    return null;
  }
}

function milestoneIndexes(fields: readonly JsonField[], name: string): number[] {
  const indexes: number[] = [];
  for (const element of fieldElements(fields, name) ?? []) {
    if (isRecord(element) && typeof element.value === "number") {
      indexes.push(element.value);
    } else if (typeof element === "number" && Number.isInteger(element)) {
      indexes.push(element);
    } else if (typeof element === "string" && /^\d+$/.test(element)) {
      indexes.push(Number(element));
    }
  }
  return indexes;
}

function openMilestones(facts: GrantFacts, count: number | null): void {
  if (count === null) return;
  if (facts.milestones === null) facts.milestones = count;
  for (let index = 0; index < facts.milestones; index += 1) {
    if (!facts.statuses.has(index)) facts.statuses.set(index, "open");
  }
}

function readTreasuryEvent(scan: Scan, event: LedgerEvent, hub: string): void {
  const fields = jsonFields(event.data);

  switch (event.name) {
    case "SpaceTreasurySpawnedEvent": {
      const treasury = fieldString(fields, "treasury");
      if (treasury !== null) scan.treasuries.add(treasury);
      break;
    }
    case "SpaceTreasuryTouchedEvent": {
      const treasury = fieldString(fields, "treasury");
      if (treasury !== null) scan.treasuries.add(treasury);
      break;
    }
    case "SpaceTreasuryDistributionCreatedEvent": {
      const treasury = fieldString(fields, "component_address");
      const distribution = fieldString(fields, "distribution");
      const expiry = fieldNumber(fields, "expiry");
      if (treasury === null || distribution === null || expiry === null) break;
      scan.treasuries.add(treasury);
      const facts = distributionOf(scan, distribution);
      facts.treasury = treasury;
      facts.resource = fieldString(fields, "resource");
      facts.expiry = expiry;
      facts.expiry_min_epoch = fieldNumber(fields, "expiry_min_epoch") ?? 0;
      anchor(facts, hub, event.state_version);
      break;
    }
    case "SpaceTreasuryDistributionSettledEvent": {
      const distribution = fieldString(fields, "distribution");
      if (distribution !== null) distributionOf(scan, distribution).settled = true;
      break;
    }
    case "SpaceTreasuryGrantFundedEvent": {
      const treasury = fieldString(fields, "component_address");
      const escrow = fieldString(fields, "escrow");
      const grantId = fieldString(fields, "grant_id");
      if (treasury === null || escrow === null || grantId === null) break;
      scan.treasuries.add(treasury);
      scan.escrows.add(escrow);
      const facts = grantOf(scan, escrow, grantId);
      facts.treasury = treasury;
      openMilestones(
        facts,
        fieldElements(fields, "milestone_amounts")?.length ?? null,
      );
      anchor(facts, hub, event.state_version);
      break;
    }
    case "SpaceTreasuryGrantSettledEvent": {
      const grantId = fieldString(fields, "grant_id");
      if (grantId === null) break;
      for (const facts of scan.grants.values()) {
        if (facts.grant_id === grantId) facts.settled = true;
      }
      break;
    }
    default: {
      // Every other event whose name starts with `SpaceTreasury` is emitted by a treasury
      // and names it in `component_address`. The hub's own two events are handled above.
      if (
        event.name.startsWith("SpaceTreasury") &&
        !event.name.startsWith("SpaceTreasuryHub")
      ) {
        const treasury = fieldString(fields, "component_address");
        if (treasury !== null) scan.treasuries.add(treasury);
      }
      break;
    }
  }
}

function readEscrowEvent(scan: Scan, event: LedgerEvent, escrow: string): void {
  const fields = jsonFields(event.data);
  const grantId = fieldString(fields, "grant_id");
  // The hub stream carries the escrow events of every treasury call too; process each once.
  const identity = `${event.state_version}:${event.name}:${grantId ?? ""}:${
    fieldString(fields, "account") ?? fieldString(fields, "milestone_index") ?? ""
  }`;

  switch (event.name) {
    case "GrantCreatedEvent": {
      if (grantId === null) break;
      const facts = grantOf(scan, escrow, grantId);
      const funder = fieldString(fields, "funder");
      if (funder !== null) {
        facts.treasury = funder;
        if (funder.startsWith("component_")) scan.treasuries.add(funder);
      }
      openMilestones(
        facts,
        fieldElements(fields, "milestone_amounts")?.length ?? null,
      );
      anchor(facts, escrow, event.state_version);
      break;
    }
    case "MilestoneReleaseRequestedEvent":
    case "MilestoneDeliverableSubmittedEvent": {
      if (grantId === null) break;
      const index = fieldNumber(fields, "milestone_index");
      if (index === null) break;
      const facts = grantOf(scan, escrow, grantId);
      facts.statuses.set(index, "open");
      anchor(facts, escrow, event.state_version);
      break;
    }
    case "MilestoneSettledEvent": {
      if (grantId === null) break;
      const index = fieldNumber(fields, "milestone_index");
      if (index === null) break;
      const facts = grantOf(scan, escrow, grantId);
      facts.statuses.set(
        index,
        fieldString(fields, "result") === "Reopened" ? "open" : "closed",
      );
      anchor(facts, escrow, event.state_version);
      break;
    }
    case "GrantCancelledEvent": {
      if (grantId === null) break;
      const facts = grantOf(scan, escrow, grantId);
      for (const index of milestoneIndexes(fields, "cancelled_indices")) {
        facts.statuses.set(index, "closed");
      }
      anchor(facts, escrow, event.state_version);
      break;
    }
    case "FallbackAccruedEvent": {
      if (scan.seen.has(identity)) break;
      scan.seen.add(identity);
      const recipient = fieldString(fields, "account");
      const owed = parseAmount(fieldString(fields, "total_owed"));
      if (recipient === null || owed === null) break;
      const facts = fallbackOf(scan, escrow, recipient);
      facts.owed = owed;
      anchor(facts, escrow, event.state_version);
      break;
    }
    case "FallbackClaimedEvent": {
      if (scan.seen.has(identity)) break;
      scan.seen.add(identity);
      const recipient = fieldString(fields, "account");
      const claimed = parseAmount(fieldString(fields, "amount"));
      if (recipient === null || claimed === null) break;
      const facts = fallbackOf(scan, escrow, recipient);
      facts.owed = facts.owed > claimed ? facts.owed - claimed : 0n;
      break;
    }
    default:
      break;
  }
}

function readEvent(
  scan: Scan,
  event: LedgerEvent,
  source: string,
  hub: string | null,
): void {
  if (source === hub) {
    readTreasuryEvent(scan, event, source);
  } else {
    readEscrowEvent(scan, event, source);
    // A hub stream also carries the escrow events of the same transaction.
    readTreasuryEvent(scan, event, source);
  }
}

function holdsFunds(amounts: readonly string[]): boolean {
  return amounts.some((amount) => /[1-9]/.test(amount));
}

async function distributionItems(
  context: JobContext,
  facts: DistributionFacts,
  now: number,
  epoch: number,
): Promise<WorkItem[]> {
  if (facts.settled) return [];

  let holdings: Awaited<ReturnType<typeof readFungibleHoldings>>;
  try {
    holdings = await readFungibleHoldings(context.gateway, facts.distribution);
  } catch (error) {
    context.logger.warn(
      `[settle] distribution ${facts.distribution}: could not read its balance: ${
        (error as Error).message
      }`,
    );
    return [];
  }

  const mine =
    facts.resource === null
      ? holdings
      : holdings.filter((holding) => holding.resource === facts.resource);
  if (facts.resource === null && mine.length > 0) {
    facts.resource = mine[0]!.resource;
  }

  if (!holdsFunds(mine.map((holding) => holding.amount))) {
    if (facts.treasury === null) {
      context.logger.warn(
        `[settle] distribution ${facts.distribution} holds nothing, but the treasury that funded it is unknown; skipping`,
      );
      return [];
    }
    return [
      {
        id: `settle_distribution:${facts.distribution}`,
        kind: "settle_distribution",
        treasury: facts.treasury,
        distribution: facts.distribution,
        summary: `distribution ${facts.distribution} holds nothing; settle it on treasury ${facts.treasury}`,
      },
    ];
  }

  if (facts.expiry === null || facts.expiry_min_epoch === null) {
    context.logger.warn(
      `[settle] distribution ${facts.distribution}: its claim window is unknown; skipping`,
    );
    return [];
  }
  if (now < facts.expiry || epoch < facts.expiry_min_epoch) return [];

  return [
    {
      id: `return_unclaimed:${facts.distribution}`,
      kind: "return_unclaimed",
      treasury: facts.treasury,
      distribution: facts.distribution,
      summary: `distribution ${facts.distribution}: claim window closed, return the remainder`,
    },
  ];
}

function grantClosed(facts: GrantFacts): boolean {
  if (facts.milestones === null) return false;
  for (let index = 0; index < facts.milestones; index += 1) {
    if (facts.statuses.get(index) !== "closed") return false;
  }
  return true;
}

function grantItems(facts: GrantFacts): WorkItem[] {
  if (facts.settled || facts.treasury === null || !grantClosed(facts)) return [];
  return [
    {
      id: `settle_grant:${facts.grant_id}`,
      kind: "settle_grant",
      treasury: facts.treasury,
      grant_id: facts.grant_id,
      escrow: facts.escrow,
      summary: `grant ${facts.grant_id} is closed on the escrow; settle it on treasury ${facts.treasury}`,
    },
  ];
}

function fallbackItems(
  context: JobContext,
  scan: Scan,
): WorkItem[] {
  const items: WorkItem[] = [];
  for (const facts of scan.fallbacks.values()) {
    if (facts.owed <= 0n) continue;
    if (!scan.treasuries.has(facts.recipient)) {
      context.logger.info(
        `[settle] escrow ${facts.escrow}: ${formatXrd(facts.owed)} is parked for ${
          facts.recipient
        }, which is not a watched treasury; leaving it to its owner`,
      );
      continue;
    }
    items.push({
      id: `deliver_fallback:${facts.escrow}:${facts.recipient}`,
      kind: "deliver_fallback",
      treasury: facts.recipient,
      escrow: facts.escrow,
      recipient: facts.recipient,
      summary: `escrow ${facts.escrow}: ${formatXrd(
        facts.owed,
      )} parked for treasury ${facts.recipient}`,
    });
  }
  return items;
}

function unresolvedAnchors(
  scan: Scan,
  source: string,
): number | undefined {
  let earliest: number | undefined;
  const consider = (facts: { anchors: Map<string, number> }): void => {
    const value = facts.anchors.get(source);
    if (value === undefined) return;
    if (earliest === undefined || value < earliest) earliest = value;
  };

  for (const facts of scan.distributions.values()) {
    if (!facts.settled) consider(facts);
  }
  for (const facts of scan.grants.values()) {
    if (!facts.settled) consider(facts);
  }
  for (const facts of scan.fallbacks.values()) {
    if (facts.owed > 0n) consider(facts);
  }
  return earliest;
}

function advanceCursor(
  context: JobContext,
  key: string,
  from: number,
  source: string,
  scan: Scan,
  head: number,
): void {
  const earliest = unresolvedAnchors(scan, source);
  const last = Math.max(head, scan.last.get(source) ?? from);
  const next = earliest === undefined ? last : Math.min(earliest, last);
  if (next >= from) context.state.setCursor(key, next);
}

async function readConfigDistributions(
  context: JobContext,
  scan: Scan,
): Promise<void> {
  for (const addressValue of context.components.distributions) {
    const facts = distributionOf(scan, addressValue);
    if (
      facts.expiry !== null &&
      facts.expiry_min_epoch !== null &&
      facts.treasury !== null
    ) {
      continue;
    }
    try {
      const fields = await readComponentState(context.gateway, addressValue);
      if (facts.treasury === null) {
        const funder = fieldString(fields, "funder");
        if (funder !== null && funder.startsWith("component_")) {
          facts.treasury = funder;
        }
      }
      if (facts.expiry === null) facts.expiry = fieldNumber(fields, "expiry");
      if (facts.expiry_min_epoch === null) {
        facts.expiry_min_epoch = fieldNumber(fields, "expiry_min_epoch");
      }
    } catch (error) {
      context.logger.warn(
        `[settle] distribution ${addressValue}: could not read its state: ${
          (error as Error).message
        }`,
      );
    }
  }
}

export async function findWork(context: JobContext): Promise<WorkItem[]> {
  const hub = context.components.spaceTreasuryHub;
  const scan: Scan = {
    treasuries: new Set(context.components.spaceTreasuries),
    escrows: new Set(
      context.components.grantEscrow === null
        ? []
        : [context.components.grantEscrow],
    ),
    distributions: new Map(),
    grants: new Map(),
    fallbacks: new Map(),
    seen: new Set(),
    last: new Map(),
  };
  if (context.components.spaceTreasury !== null) {
    scan.treasuries.add(context.components.spaceTreasury);
  }

  const status = await context.gateway.status();
  const now = nowSeconds();
  const epoch = status.ledger_state.epoch;

  if (hub !== null) {
    const cursorKey = `settle:hub:${hub}`;
    const from = context.state.cursor(cursorKey) ?? 0;
    for await (const event of streamEvents(context.gateway, hub, from)) {
      scan.last.set(hub, Math.max(scan.last.get(hub) ?? from, event.state_version));
      readEvent(scan, event, hub, hub);
    }
    advanceCursor(
      context,
      cursorKey,
      from,
      hub,
      scan,
      status.ledger_state.state_version,
    );
  }

  // Escrows named by the config or by a grant funding event, read from their own stream.
  const escrows = [...scan.escrows].sort();
  for (const escrow of escrows) {
    const cursorKey = `settle:escrow:${escrow}`;
    const from = context.state.cursor(cursorKey) ?? 0;
    for await (const event of streamEvents(context.gateway, escrow, from)) {
      scan.last.set(
        escrow,
        Math.max(scan.last.get(escrow) ?? from, event.state_version),
      );
      readEvent(scan, event, escrow, hub);
    }
    advanceCursor(
      context,
      cursorKey,
      from,
      escrow,
      scan,
      status.ledger_state.state_version,
    );
  }

  await readConfigDistributions(context, scan);

  // One pass per treasury, in the order the calls must go: returns, distribution settlements,
  // parked refunds, then grant settlements.
  const byTreasury = new Map<string, WorkItem[]>();
  const unassigned: WorkItem[] = [];
  const push = (treasury: string | null, item: WorkItem): void => {
    if (treasury === null) {
      unassigned.push(item);
      return;
    }
    const items = byTreasury.get(treasury) ?? [];
    items.push(item);
    byTreasury.set(treasury, items);
  };

  const distributions = [...scan.distributions.values()].sort((a, b) =>
    a.distribution.localeCompare(b.distribution),
  );
  const returns: WorkItem[] = [];
  const settlements: WorkItem[] = [];
  for (const facts of distributions) {
    const items = await distributionItems(context, facts, now, epoch);
    for (const item of items) {
      if (String(item.kind) === "return_unclaimed") returns.push(item);
      else settlements.push(item);
    }
  }
  // The return opens the window's remainder; the settlement follows only once the component
  // holds nothing, so every return comes before every distribution settlement in the pass.
  for (const item of [...returns, ...settlements]) {
    push(item.treasury === null ? null : String(item.treasury), item);
  }
  for (const item of fallbackItems(context, scan)) {
    push(String(item.treasury), item);
  }
  for (const facts of [...scan.grants.values()].sort((a, b) =>
    a.grant_id.localeCompare(b.grant_id),
  )) {
    for (const item of grantItems(facts)) push(String(item.treasury), item);
  }

  const order = [
    ...new Set([...scan.treasuries, ...byTreasury.keys()]),
  ].sort();
  const work: WorkItem[] = [];
  for (const treasury of order) work.push(...(byTreasury.get(treasury) ?? []));
  work.push(...unassigned);

  context.logger.info(
    work.length === 0
      ? "[settle] nothing is due"
      : `[settle] ${work.length} call(s) due: ${work
          .map((item) => String(item.summary))
          .join("; ")}`,
  );
  return work;
}

export async function act(context: JobContext, item: WorkItem): Promise<Outcome> {
  const kind = String(item.kind);

  if (kind === "return_unclaimed") {
    const distribution = String(item.distribution);
    return context.executor.run(
      buildCall(distribution, "return_unclaimed", []),
      `return_unclaimed ${distribution}`,
    );
  }

  if (kind === "settle_distribution") {
    const treasury = String(item.treasury);
    const distribution = String(item.distribution);
    return context.executor.run(
      buildCall(treasury, "settle_distribution", [address(distribution)]),
      `settle_distribution ${distribution} on ${treasury}`,
    );
  }

  if (kind === "deliver_fallback") {
    const escrow = String(item.escrow);
    const treasury = String(item.treasury);
    const recipient = String(item.recipient);
    const outcome = await context.executor.run(
      buildCall(escrow, "deliver_fallback", [address(recipient)]),
      `deliver_fallback ${recipient} on ${escrow}`,
    );
    if (outcome !== "previewed_refused") return outcome;
    context.logger.info(
      `[settle] deliver_fallback to ${recipient} was refused (the treasury may have delisted the resource); pulling it home with collect_grant_refunds`,
    );
    return context.executor.run(
      buildCall(treasury, "collect_grant_refunds", []),
      `collect_grant_refunds ${treasury}`,
    );
  }

  if (kind === "settle_grant") {
    const treasury = String(item.treasury);
    const grantId = String(item.grant_id);
    return context.executor.run(
      buildCall(treasury, "settle_grant", [str(grantId)]),
      `settle_grant ${grantId} on ${treasury}`,
    );
  }

  context.logger.warn(`[settle] unknown work kind ${kind}`);
  return "failed";
}
