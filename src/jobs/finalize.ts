/**
 * Finalize requests whose window has closed.
 *
 * A proposal is finalizable once its dispute deadline has passed AND the network has reached
 * the consensus epoch stamped beside that deadline: a ledger halt moves the clock without
 * moving the epoch, and a window nobody could act in must not close on the clock alone.
 *
 * A disputed request is finalizable once its vote round's reveal deadline has passed. The
 * round's reveal window carries the same live-time floor, counted from the epoch the window
 * was first seen open on-ledger. A round with committed ballots and no stamp yet is not
 * finalizable; opening it is the open_reveal job's work. A request with no committed ballots
 * has nothing to reveal and closes on the deadline alone.
 *
 * A preview refused by the Engine means the request was finalized by someone else, or the
 * window is not closed yet. It is logged and retried on the next pass.
 */

import { str } from "@radixdlt/radix-engine-toolkit";

import { streamEvents, type LedgerEvent } from "../events.ts";
import {
  fieldNumber,
  fieldString,
  jsonFields,
  minEpochsFor,
  nestedFields,
  nowSeconds,
  type JsonField,
} from "../oracle.ts";
import type { JobContext, WorkItem } from "../runner.ts";
import { buildCall, type Outcome } from "../tx.ts";

interface ProposalFacts {
  disputable_until: number;
  disputable_min_epoch: number;
}

interface DisputeFacts {
  vote_reveal_start: number;
  reveal_period: number;
}

interface AttemptFacts {
  request_id: string;
  attempt: number;
  proposal: ProposalFacts | null;
  dispute: DisputeFacts | null;
  commits: number;
  finalized: boolean;
  superseded: boolean;
  /** The earliest state version that still matters if this attempt is unresolved. */
  anchor: number;
}

interface Scan {
  attempts: Map<string, AttemptFacts>;
  /** vote_reveal_start to the reveal floor's earliest close epoch. */
  revealStamps: Map<number, number>;
  lastStateVersion: number;
}

function attemptKey(requestId: string, attempt: number): string {
  return `${requestId}\u0000${attempt}`;
}

function attemptOf(
  scan: Scan,
  requestId: string,
  attempt: number,
  stateVersion: number,
): AttemptFacts {
  const key = attemptKey(requestId, attempt);
  let facts = scan.attempts.get(key);
  if (facts === undefined) {
    facts = {
      request_id: requestId,
      attempt,
      proposal: null,
      dispute: null,
      commits: 0,
      finalized: false,
      superseded: false,
      anchor: stateVersion,
    };
    scan.attempts.set(key, facts);
  }
  facts.anchor = Math.min(facts.anchor, stateVersion);
  return facts;
}

function readProposal(scan: Scan, event: LedgerEvent, fields: JsonField[]): void {
  const proposed = nestedFields(fields, "proposed_resolution");
  if (proposed === null) return;
  const requestId = fieldString(fields, "request_id");
  const attempt = fieldNumber(fields, "resolution_attempt");
  const deadline = fieldNumber(proposed, "disputable_until");
  if (requestId === null || attempt === null || deadline === null) return;

  const facts = attemptOf(scan, requestId, attempt, event.state_version);
  facts.proposal = {
    disputable_until: deadline,
    // A deployment predating the live-time floor carries no such field; its windows close
    // on the deadline alone.
    disputable_min_epoch: fieldNumber(proposed, "disputable_min_epoch") ?? 0,
  };
}

function readEvent(scan: Scan, event: LedgerEvent): void {
  const fields = jsonFields(event.data);
  const requestId = fieldString(fields, "request_id");
  const attempt = fieldNumber(fields, "resolution_attempt");

  switch (event.name) {
    case "ProposedResolutionChangedEvent": {
      readProposal(scan, event, fields);
      break;
    }
    case "DisputeResolutionChangedEvent": {
      const dispute = nestedFields(fields, "dispute_resolution");
      if (requestId === null || attempt === null || dispute === null) break;
      const revealStart = fieldNumber(dispute, "vote_reveal_start");
      const revealPeriod = fieldNumber(dispute, "reveal_period");
      if (revealStart === null || revealPeriod === null) break;
      const facts = attemptOf(scan, requestId, attempt, event.state_version);
      facts.dispute = {
        vote_reveal_start: revealStart,
        reveal_period: revealPeriod,
      };
      break;
    }
    case "RequestScheduledForVotingEvent": {
      // The schedule proves the round exists; the attempt itself is anchored by its
      // proposal, which always precedes the schedule.
      break;
    }
    case "VoteCommittedEvent": {
      const ticket = nestedFields(fields, "vote_ticket");
      if (ticket === null) break;
      const ticketRequest = fieldString(ticket, "request_id");
      const ticketAttempt = fieldNumber(ticket, "resolution_attempt");
      if (ticketRequest === null || ticketAttempt === null) break;
      const facts = attemptOf(scan, ticketRequest, ticketAttempt, event.state_version);
      facts.commits += 1;
      break;
    }
    case "VoteRoundRevealOpenedEvent": {
      const start = fieldNumber(fields, "vote_reveal_start");
      const minEpoch = fieldNumber(fields, "reveal_min_epoch");
      if (start !== null && minEpoch !== null) {
        scan.revealStamps.set(start, minEpoch);
      }
      break;
    }
    case "RequestFinalizationEvent":
    case "RequestSettledEvent": {
      if (requestId === null || attempt === null) break;
      const facts = attemptOf(scan, requestId, attempt, event.state_version);
      facts.finalized = true;
      break;
    }
    case "RequestIncreasedAttemptEvent": {
      if (requestId === null) break;
      const next = fieldNumber(fields, "new_resolution_attempt");
      if (next === null) break;
      for (const facts of scan.attempts.values()) {
        if (facts.request_id === requestId && facts.attempt < next) {
          facts.superseded = true;
        }
      }
      break;
    }
    default:
      break;
  }
}

function due(
  facts: AttemptFacts,
  now: number,
  epoch: number,
  revealStamps: Map<number, number>,
): boolean {
  if (facts.dispute !== null) {
    const { vote_reveal_start, reveal_period } = facts.dispute;
    if (now < vote_reveal_start + reveal_period) return false;
    if (facts.commits === 0) return true;

    const floor = revealStamps.get(vote_reveal_start);
    if (floor === undefined) {
      // The contract refuses a request whose round has committed ballots and has never been
      // seen open, unless the round's window is too short to carry a floor. Opening the
      // round is the open_reveal job's work.
      return minEpochsFor(reveal_period) === 0;
    }
    return epoch >= floor;
  }

  if (facts.proposal !== null) {
    return (
      now >= facts.proposal.disputable_until &&
      epoch >= facts.proposal.disputable_min_epoch
    );
  }
  return false;
}

export async function findWork(context: JobContext): Promise<WorkItem[]> {
  const oracle = context.components.oracle;
  if (oracle === null) {
    context.logger.info("[finalize] no oracle component is configured; nothing to do");
    return [];
  }

  const status = await context.gateway.status();
  const epoch = status.ledger_state.epoch;
  const now = nowSeconds();
  const cursorKey = `finalize:${oracle}`;
  const from = context.state.cursor(cursorKey) ?? 0;

  const scan: Scan = {
    attempts: new Map(),
    revealStamps: new Map(),
    lastStateVersion: from,
  };
  for await (const event of streamEvents(context.gateway, oracle, from)) {
    scan.lastStateVersion = Math.max(scan.lastStateVersion, event.state_version);
    readEvent(scan, event);
  }

  const highestAttempt = new Map<string, number>();
  for (const facts of scan.attempts.values()) {
    const known = highestAttempt.get(facts.request_id) ?? 0;
    if (facts.attempt > known) highestAttempt.set(facts.request_id, facts.attempt);
  }

  const active = [...scan.attempts.values()].filter(
    (facts) =>
      !facts.finalized &&
      !facts.superseded &&
      facts.attempt === highestAttempt.get(facts.request_id) &&
      (facts.proposal !== null || facts.dispute !== null),
  );

  const work: WorkItem[] = [];
  for (const facts of active) {
    if (!due(facts, now, epoch, scan.revealStamps)) continue;
    const summary =
      facts.dispute === null
        ? `request ${facts.request_id}, attempt ${facts.attempt}, undisputed window closed`
        : `request ${facts.request_id}, attempt ${facts.attempt}, vote round ${facts.dispute.vote_reveal_start} closed`;
    work.push({
      id: facts.request_id,
      request_id: facts.request_id,
      attempt: facts.attempt,
      summary,
    });
  }

  // Keep the cursor before the earliest unresolved attempt so a restart still sees it. Once
  // every attempt is settled or superseded the cursor may move to the head.
  const head = Math.max(status.ledger_state.state_version, scan.lastStateVersion);
  const nextCursor =
    active.length === 0
      ? head
      : active.reduce((earliest, facts) => Math.min(earliest, facts.anchor), head);
  if (nextCursor >= from) context.state.setCursor(cursorKey, nextCursor);

  context.logger.info(
    work.length === 0
      ? "[finalize] nothing is due"
      : `[finalize] ${work.length} request(s) due: ${work
          .map((item) => String(item.summary))
          .join("; ")}`,
  );
  return work;
}

export async function act(context: JobContext, item: WorkItem): Promise<Outcome> {
  const oracle = context.components.oracle;
  if (oracle === null) return "failed";
  const requestId = String(item.request_id);
  const manifest = buildCall(oracle, "finalize_request", [str(requestId)]);
  return context.executor.run(manifest, `finalize ${requestId}`);
}
