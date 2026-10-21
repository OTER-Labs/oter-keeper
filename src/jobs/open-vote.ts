/**
 * Open delayed votes whose window has started but which no transaction has touched yet.
 *
 * A vote created with a start delay opens at an instant at which no transaction runs. Its
 * opening is recorded by the first accepted ballot or by the public `open_vote`, and until
 * then its close is only the estimate made at creation: a network halt inside the vote would
 * not be made up for. A vote with no start delay is stamped by its creating transaction and
 * needs nothing.
 *
 * The contract opens voting at `vote_start` AND at the epoch floor recorded beside it, so the
 * job waits for both. It also waits a short grace past `vote_start`, giving the first voter's
 * ballot the chance to stamp the vote for nothing. A vote already stamped, one with a ballot,
 * and one whose window has closed are left alone. A refused preview means someone else got
 * there first; the next pass sees the stamp and stops asking.
 */

import { str } from "@radixdlt/radix-engine-toolkit";

import { streamEvents, type LedgerEvent } from "../events.ts";
import {
  fieldNumber,
  fieldString,
  jsonFields,
  nowSeconds,
} from "../oracle.ts";
import type { JobContext, WorkItem } from "../runner.ts";
import { buildCall, type Outcome } from "../tx.ts";

/** How long past `vote_start` a vote may sit unstamped before the keeper opens it. */
export const OPEN_GRACE_SECONDS = 60;

interface VoteFacts {
  consultation_id: string;
  vote_start: number;
  vote_end: number;
  /** The consultation's creation time: a vote that starts then has no delay. */
  created: number;
  vote_start_min_epoch: number;
  vote_end_min_epoch: number;
  opened: boolean;
  ballots: number;
  /** The earliest state version that still matters if this vote is unresolved. */
  anchor: number;
}

interface Scan {
  votes: Map<string, VoteFacts>;
  lastStateVersion: number;
}

function voteOf(scan: Scan, id: string, stateVersion: number): VoteFacts | undefined {
  const facts = scan.votes.get(id);
  if (facts !== undefined) facts.anchor = Math.min(facts.anchor, stateVersion);
  return facts;
}

function readEvent(scan: Scan, event: LedgerEvent): void {
  const fields = jsonFields(event.data);

  switch (event.name) {
    case "ConsultationCreatedEvent": {
      const id = fieldString(fields, "consultation_id");
      const voteStart = fieldNumber(fields, "vote_start");
      const voteEnd = fieldNumber(fields, "vote_end");
      const created = fieldNumber(fields, "timestamp");
      if (id === null || voteStart === null || voteEnd === null || created === null) break;
      scan.votes.set(id, {
        consultation_id: id,
        vote_start: voteStart,
        vote_end: voteEnd,
        created,
        // A deployment predating the live-time floors carries neither field; its windows
        // close on the clock alone.
        vote_start_min_epoch: fieldNumber(fields, "vote_start_min_epoch") ?? 0,
        vote_end_min_epoch: fieldNumber(fields, "vote_end_min_epoch") ?? 0,
        opened: false,
        ballots: 0,
        anchor: event.state_version,
      });
      break;
    }
    case "VoteOpenedEvent": {
      const id = fieldString(fields, "consultation_id");
      if (id === null) break;
      const facts = voteOf(scan, id, event.state_version);
      if (facts !== undefined) facts.opened = true;
      break;
    }
    case "VoteCastEvent": {
      // The first accepted ballot is itself the observation that opens the vote.
      const id = fieldString(fields, "consultation_id");
      if (id === null) break;
      const facts = voteOf(scan, id, event.state_version);
      if (facts !== undefined) facts.ballots += 1;
      break;
    }
    default:
      break;
  }
}

function delayed(vote: VoteFacts): boolean {
  return vote.vote_start > vote.created;
}

function closed(vote: VoteFacts, now: number, epoch: number): boolean {
  return now >= vote.vote_end && epoch >= vote.vote_end_min_epoch;
}

function resolved(vote: VoteFacts): boolean {
  // An opened vote carries the first ballot's stamp, if any; a vote with no delay was stamped
  // by its creating transaction, whose event the scan has read.
  return vote.opened || vote.ballots > 0 || !delayed(vote);
}

function due(vote: VoteFacts, now: number, epoch: number): boolean {
  return (
    !vote.opened &&
    vote.ballots === 0 &&
    delayed(vote) &&
    now >= vote.vote_start + OPEN_GRACE_SECONDS &&
    !closed(vote, now, epoch) &&
    epoch >= vote.vote_start_min_epoch
  );
}

export async function findWork(context: JobContext): Promise<WorkItem[]> {
  const registry = context.components.registry;
  if (registry === null) {
    context.logger.info("[open_vote] no registry component is configured; nothing to do");
    return [];
  }

  const status = await context.gateway.ledgerStatus();
  const epoch = status.ledger_state.epoch;
  const now = nowSeconds();
  const cursorKey = `open_vote:${registry}`;
  const from = context.state.cursor(cursorKey) ?? 0;

  const scan: Scan = { votes: new Map(), lastStateVersion: from };
  for await (const event of streamEvents(context.gateway, registry, from)) {
    scan.lastStateVersion = Math.max(scan.lastStateVersion, event.state_version);
    readEvent(scan, event);
  }

  const work: WorkItem[] = [];
  const pending: VoteFacts[] = [];
  for (const vote of scan.votes.values()) {
    if (resolved(vote)) continue;
    if (closed(vote, now, epoch)) continue; // Nothing can stamp it now.
    pending.push(vote);
    if (!due(vote, now, epoch)) continue;
    work.push({
      id: vote.consultation_id,
      consultation_id: vote.consultation_id,
      summary: `consultation ${vote.consultation_id} opened at ${vote.vote_start} with no recorded opening`,
    });
  }

  // Keep the cursor before the earliest unresolved vote so a restart still sees its creation.
  // Opened, stamped and closed votes need no replay.
  const head = Math.max(status.ledger_state.state_version, scan.lastStateVersion);
  const nextCursor =
    pending.length === 0
      ? head
      : pending.reduce((earliest, vote) => Math.min(earliest, vote.anchor), head);
  if (nextCursor >= from) context.state.setCursor(cursorKey, nextCursor);

  context.logger.info(
    work.length === 0
      ? "[open_vote] nothing to open"
      : `[open_vote] ${work.length} vote(s) to open: ${work
          .map((item) => String(item.summary))
          .join("; ")}`,
  );
  return work;
}

export async function act(context: JobContext, item: WorkItem): Promise<Outcome> {
  const registry = context.components.registry;
  if (registry === null) return "failed";
  const id = String(item.consultation_id);
  const manifest = buildCall(registry, "open_vote", [str(id)]);
  return context.executor.run(manifest, `open_vote ${id}`);
}
