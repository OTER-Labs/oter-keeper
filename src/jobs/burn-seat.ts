/**
 * Burn seat badges no holder is entitled to keep.
 *
 * A seat badge is a soulbound resource proof. When a recall marks a seat revoked without a
 * vault to take the badge from, or when a seat's term ends, the badge stays in the holder's
 * account and still satisfies any check that only requires the resource. The public
 * `burn_seat` is the call that destroys it, and nobody calls it by itself.
 *
 * Work is found from the registry's events: a seat is claimed (its badge exists), has no
 * `SeatBurnedEvent`, and is either revoked without a burn or past its term. The badge is
 * soulbound, so it is still in the vault it was claimed into: the holder comes from
 * `SeatClaimedEvent` and the vault is read from the Gateway for that holder and the space's
 * seat resource. When the holder or the vault cannot be found, the seat is reported and left
 * alone; a guessed vault would only fail the call, and a wrong one could touch another seat.
 *
 * A refused preview is ordinary: someone else burned the badge first, or this keeper's clock
 * ran ahead of the ledger's. It is logged and the next pass re-reads the events.
 */

import {
  address,
  str,
  u32,
} from "@radixdlt/radix-engine-toolkit";

import { streamEvents, type LedgerEvent } from "../events.ts";
import {
  fieldBool,
  fieldNumber,
  fieldString,
  findNonFungibleVault,
  jsonFields,
  nowSeconds,
  readSpaceZeroSeatResource,
} from "../oracle.ts";
import type { JobContext, WorkItem } from "../runner.ts";
import { buildCall, type Outcome } from "../tx.ts";

interface SeatFacts {
  election_id: string;
  seat_index: number;
  space_id: number;
  holder: string | null;
  revoked: boolean;
  /** `SeatRevokedEvent.burned`: the badge was destroyed as part of the recall. */
  revokedBurned: boolean;
  burned: boolean;
  /** The earliest state version that still matters if this seat is unresolved. */
  anchor: number;
}

interface SealedTerm {
  term_end: number;
  anchor: number;
}

interface Scan {
  seats: Map<string, SeatFacts>;
  /** space id to the space's seat-badge resource. */
  seatResources: Map<number, string>;
  /** election id to its sealed term, shared by every seat of that election. */
  terms: Map<string, SealedTerm>;
  lastStateVersion: number;
}

function seatKey(electionId: string, seatIndex: number): string {
  return `${electionId}\u0000${seatIndex}`;
}

function seatOf(
  scan: Scan,
  electionId: string,
  seatIndex: number,
  spaceId: number,
  stateVersion: number,
  holder: string | null,
): SeatFacts {
  const key = seatKey(electionId, seatIndex);
  let seat = scan.seats.get(key);
  if (seat === undefined) {
    seat = {
      election_id: electionId,
      seat_index: seatIndex,
      space_id: spaceId,
      holder,
      revoked: false,
      revokedBurned: false,
      burned: false,
      anchor: stateVersion,
    };
    scan.seats.set(key, seat);
  }
  seat.anchor = Math.min(seat.anchor, stateVersion);
  if (holder !== null) seat.holder = holder;
  return seat;
}

function readEvent(scan: Scan, event: LedgerEvent): void {
  const fields = jsonFields(event.data);

  switch (event.name) {
    case "SpaceCreatedEvent": {
      const spaceId = fieldNumber(fields, "space_id");
      const seatResource = fieldString(fields, "seat_resource");
      if (spaceId !== null && seatResource !== null) {
        scan.seatResources.set(spaceId, seatResource);
      }
      break;
    }
    case "ElectionSeatsSealedEvent": {
      const electionId = fieldString(fields, "election_id");
      const termEnd = fieldNumber(fields, "term_end");
      if (electionId === null || termEnd === null) break;
      scan.terms.set(electionId, { term_end: termEnd, anchor: event.state_version });
      break;
    }
    case "SeatClaimedEvent": {
      const electionId = fieldString(fields, "election_id");
      const seatIndex = fieldNumber(fields, "seat_index");
      const spaceId = fieldNumber(fields, "space_id");
      const holder = fieldString(fields, "holder");
      if (electionId === null || seatIndex === null || spaceId === null) break;
      seatOf(scan, electionId, seatIndex, spaceId, event.state_version, holder);
      break;
    }
    case "SeatRevokedEvent": {
      const electionId = fieldString(fields, "election_id");
      const seatIndex = fieldNumber(fields, "seat_index");
      if (electionId === null || seatIndex === null) break;
      const spaceId = fieldNumber(fields, "space_id") ?? 0;
      const seat = seatOf(
        scan,
        electionId,
        seatIndex,
        spaceId,
        event.state_version,
        null,
      );
      seat.revoked = true;
      seat.revokedBurned = fieldBool(fields, "burned") ?? false;
      break;
    }
    case "SeatBurnedEvent": {
      const electionId = fieldString(fields, "election_id");
      const seatIndex = fieldNumber(fields, "seat_index");
      if (electionId === null || seatIndex === null) break;
      const spaceId = fieldNumber(fields, "space_id") ?? 0;
      const seat = seatOf(
        scan,
        electionId,
        seatIndex,
        spaceId,
        event.state_version,
        null,
      );
      seat.burned = true;
      break;
    }
    default:
      break;
  }
}

export async function findWork(context: JobContext): Promise<WorkItem[]> {
  const registry = context.components.registry;
  if (registry === null) {
    context.logger.info("[burn_seat] no registry component is configured; nothing to do");
    return [];
  }

  const status = await context.gateway.status();
  const now = nowSeconds();
  const cursorKey = `burn_seat:${registry}`;
  const from = context.state.cursor(cursorKey) ?? 0;

  const scan: Scan = {
    seats: new Map(),
    seatResources: new Map(),
    terms: new Map(),
    lastStateVersion: from,
  };
  for await (const event of streamEvents(context.gateway, registry, from)) {
    scan.lastStateVersion = Math.max(scan.lastStateVersion, event.state_version);
    readEvent(scan, event);
  }

  // Space 0 is written by the registry's `new`, so its creation event is package-emitted
  // and never rides the component's stream. Its seat resource lives in the registry's own
  // `spaces` key-value store; without this read a space 0 seat could never be burned.
  const spaceZeroNeedsResource = [...scan.seats.values()].some(
    (seat) => seat.space_id === 0 && !scan.seatResources.has(0),
  );
  if (spaceZeroNeedsResource) {
    try {
      const seatResource = await readSpaceZeroSeatResource(context.gateway, registry);
      if (seatResource !== null) scan.seatResources.set(0, seatResource);
    } catch (error) {
      context.logger.warn(
        `[burn_seat] could not read space 0's seat resource from the registry state: ${
          (error as Error).message
        }`,
      );
    }
  }

  const work: WorkItem[] = [];
  const pending: SeatFacts[] = [];

  for (const seat of scan.seats.values()) {
    const term = scan.terms.get(seat.election_id);
    if (term !== undefined) seat.anchor = Math.min(seat.anchor, term.anchor);

    if (seat.burned || seat.revokedBurned) continue; // The badge is already gone.
    const termEnded = term !== undefined && now >= term.term_end;
    if (!seat.revoked && !termEnded) {
      // Still held: its term may end later, so keep its history reachable.
      pending.push(seat);
      continue;
    }

    const label = `${seat.election_id} seat ${seat.seat_index}`;
    const seatResource = scan.seatResources.get(seat.space_id);
    if (seatResource === undefined) {
      context.logger.warn(
        `[burn_seat] ${label}: the seat resource of space ${seat.space_id} is unknown; skipping`,
      );
      continue;
    }
    if (seat.holder === null) {
      context.logger.warn(`[burn_seat] ${label}: the seat has no recorded holder; skipping`);
      continue;
    }
    const holderVault = await findNonFungibleVault(
      context.gateway,
      seat.holder,
      seatResource,
    );
    if (holderVault === null) {
      context.logger.warn(
        `[burn_seat] ${label}: holder ${seat.holder} holds no vault of ${seatResource}; skipping`,
      );
      continue;
    }

    work.push({
      id: `${seat.election_id}:${seat.seat_index}`,
      election_id: seat.election_id,
      seat_index: seat.seat_index,
      holder: seat.holder,
      holder_vault: holderVault,
      summary: `${label}: ${
        seat.revoked ? "revoked" : "term ended"
      }, badge held by ${seat.holder}`,
    });
    // Until a SeatBurnedEvent is read, keep this seat's history in the scan window.
    pending.push(seat);
  }

  // Keep the cursor before the earliest unresolved seat. Burned seats and revoked-with-burn
  // seats need no replay.
  const head = Math.max(status.ledger_state.state_version, scan.lastStateVersion);
  const nextCursor =
    pending.length === 0
      ? head
      : pending.reduce((earliest, seat) => Math.min(earliest, seat.anchor), head);
  if (nextCursor >= from) context.state.setCursor(cursorKey, nextCursor);

  context.logger.info(
    work.length === 0
      ? "[burn_seat] nothing to burn"
      : `[burn_seat] ${work.length} seat badge(s) to burn: ${work
          .map((item) => String(item.summary))
          .join("; ")}`,
  );
  return work;
}

export async function act(context: JobContext, item: WorkItem): Promise<Outcome> {
  const registry = context.components.registry;
  if (registry === null) return "failed";
  const electionId = String(item.election_id);
  const seatIndex = Number(item.seat_index);
  const holderVault = String(item.holder_vault);
  const manifest = buildCall(registry, "burn_seat", [
    str(electionId),
    u32(seatIndex),
    address(holderVault),
  ]);
  return context.executor.run(manifest, `burn_seat ${electionId} seat ${seatIndex}`);
}
