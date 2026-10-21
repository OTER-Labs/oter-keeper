/**
 * Open vote rounds whose reveal window has started, has committed ballots, and has never been
 * seen open on-ledger.
 *
 * The oracle stamps the epoch a reveal window was first touched. That stamp is what starts the
 * window's live-time floor, and a request with committed ballots cannot be finalized until the
 * floor has been reached. When nobody reveals, this public call supplies the stamp. A round
 * with no commits needs no stamp: the request closes on the deadline alone.
 *
 * The call moves no funds and is idempotent on a stamped round. A refused preview means the
 * round was opened by someone else between the scan and the call; the next pass sees the
 * stamp and stops asking. A reveal period under 375 seconds has no live-time floor, so a round
 * with such a period is left alone: it closes on the deadline and a stamp would cost a fee for
 * nothing.
 */

import { i64 } from "@radixdlt/radix-engine-toolkit";

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

interface RoundFacts {
  vote_reveal_start: number;
  reveal_period: number;
  commits: number;
  opened: boolean;
  /** The earliest state version that still matters if this round is unresolved. */
  anchor: number;
}

interface Scan {
  rounds: Map<number, RoundFacts>;
  /** request id and attempt to the round it was scheduled in. */
  attemptRound: Map<string, number>;
  /** Commits counted before the round they belong to is known. */
  commitsByAttempt: Map<string, number>;
  /** Request and attempt that revealed, which also stamps the round. */
  revealedAttempts: Set<string>;
  lastStateVersion: number;
}

function attemptKey(requestId: string, attempt: number): string {
  return `${requestId}\u0000${attempt}`;
}

function roundOf(scan: Scan, start: number, stateVersion: number): RoundFacts {
  let round = scan.rounds.get(start);
  if (round === undefined) {
    round = {
      vote_reveal_start: start,
      reveal_period: 0,
      commits: 0,
      opened: false,
      anchor: stateVersion,
    };
    scan.rounds.set(start, round);
  }
  round.anchor = Math.min(round.anchor, stateVersion);
  return round;
}

function readEvent(scan: Scan, event: LedgerEvent): void {
  const fields = jsonFields(event.data);

  switch (event.name) {
    case "RequestScheduledForVotingEvent": {
      const requestId = fieldString(fields, "request_id");
      const attempt = fieldNumber(fields, "resolution_attempt");
      const start = fieldNumber(fields, "vote_reveal_start");
      const period = fieldNumber(fields, "vote_reveal_period");
      if (requestId === null || attempt === null || start === null || period === null) {
        break;
      }
      const round = roundOf(scan, start, event.state_version);
      round.reveal_period = Math.max(round.reveal_period, period);
      scan.attemptRound.set(attemptKey(requestId, attempt), start);
      break;
    }
    case "VoteCommittedEvent": {
      const ticket = nestedFields(fields, "vote_ticket");
      if (ticket === null) break;
      const requestId = fieldString(ticket, "request_id");
      const attempt = fieldNumber(ticket, "resolution_attempt");
      if (requestId === null || attempt === null) break;
      const key = attemptKey(requestId, attempt);
      scan.commitsByAttempt.set(key, (scan.commitsByAttempt.get(key) ?? 0) + 1);
      break;
    }
    case "VoteRoundRevealOpenedEvent": {
      const start = fieldNumber(fields, "vote_reveal_start");
      if (start !== null) roundOf(scan, start, event.state_version).opened = true;
      break;
    }
    case "VoteRevealedEvent": {
      // A reveal is itself the on-ledger touch that stamps its round.
      const requestId = fieldString(fields, "request_id");
      const attempt = fieldNumber(fields, "resolution_attempt");
      if (requestId !== null && attempt !== null) {
        scan.revealedAttempts.add(attemptKey(requestId, attempt));
      }
      break;
    }
    default:
      break;
  }
}

export async function findWork(context: JobContext): Promise<WorkItem[]> {
  const oracle = context.components.oracle;
  if (oracle === null) {
    context.logger.info("[open_reveal] no oracle component is configured; nothing to do");
    return [];
  }

  const status = await context.gateway.ledgerStatus();
  const now = nowSeconds();
  const cursorKey = `open_reveal:${oracle}`;
  const from = context.state.cursor(cursorKey) ?? 0;

  const scan: Scan = {
    rounds: new Map(),
    attemptRound: new Map(),
    commitsByAttempt: new Map(),
    revealedAttempts: new Set(),
    lastStateVersion: from,
  };
  for await (const event of streamEvents(context.gateway, oracle, from)) {
    scan.lastStateVersion = Math.max(scan.lastStateVersion, event.state_version);
    readEvent(scan, event);
  }

  // Attribute committed ballots to their rounds now that every schedule has been read.
  for (const [key, count] of scan.commitsByAttempt) {
    const start = scan.attemptRound.get(key);
    if (start === undefined) continue;
    const round = scan.rounds.get(start);
    if (round !== undefined) round.commits += count;
  }
  for (const key of scan.revealedAttempts) {
    const start = scan.attemptRound.get(key);
    if (start === undefined) continue;
    const round = scan.rounds.get(start);
    if (round !== undefined) round.opened = true;
  }

  const work: WorkItem[] = [];
  const pending: RoundFacts[] = [];
  for (const round of scan.rounds.values()) {
    if (round.opened) continue;
    if (now < round.vote_reveal_start) {
      // The commit window is still open, so ballots may yet arrive.
      pending.push(round);
      continue;
    }
    if (round.commits === 0) continue; // Nothing to reveal: the deadline is enough.
    if (minEpochsFor(round.reveal_period) === 0) {
      // A reveal period under 375 seconds carries no live-time floor, so there is no stamp
      // worth paying a fee for: the round closes on its deadline.
      continue;
    }
    pending.push(round);
    work.push({
      id: String(round.vote_reveal_start),
      vote_reveal_start: round.vote_reveal_start,
      reveal_period: round.reveal_period,
      summary: `vote round ${round.vote_reveal_start} (${round.commits} committed ballot(s)) needs its reveal window stamped`,
    });
  }

  // Keep the cursor before the earliest unresolved round so a restart still sees its
  // schedule and commits. Settled and opened rounds need no replay.
  const head = Math.max(status.ledger_state.state_version, scan.lastStateVersion);
  const nextCursor =
    pending.length === 0
      ? head
      : pending.reduce((earliest, round) => Math.min(earliest, round.anchor), head);
  if (nextCursor >= from) context.state.setCursor(cursorKey, nextCursor);

  context.logger.info(
    work.length === 0
      ? "[open_reveal] nothing to open"
      : `[open_reveal] ${work.length} round(s) to open: ${work
          .map((item) => String(item.summary))
          .join("; ")}`,
  );
  return work;
}

export async function act(context: JobContext, item: WorkItem): Promise<Outcome> {
  const oracle = context.components.oracle;
  if (oracle === null) return "failed";
  const revealStart = Number(item.vote_reveal_start);
  const manifest = buildCall(oracle, "open_reveal_window", [i64(revealStart)]);
  return context.executor.run(manifest, `open_reveal ${revealStart}`);
}
