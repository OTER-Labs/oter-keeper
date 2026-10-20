/**
 * Redeem bond tickets held by the configured account once their request is finalized.
 *
 * The tickets are found by reading that one account's non-fungible holdings of the oracle's
 * bond-ticket resource; no other account is read. A ticket's own data says whether it is
 * still waiting on its request or has a final status, and the contract accepts only the final
 * ones. Holding the ticket is the whole authorization, so it is withdrawn from the account,
 * handed to the oracle, and the returned bond is deposited back into the same account.
 */

import {
  address,
  array,
  bucket,
  enumeration,
  expression,
  nonFungibleLocalId,
  ValueKind,
} from "@radixdlt/radix-engine-toolkit";

import {
  enumVariant,
  fieldString,
  listAccountNonFungibles,
  readComponentField,
  readNonFungibleData,
} from "../oracle.ts";
import type { JobContext, WorkItem } from "../runner.ts";
import { buildManifest, type Manifest, type Outcome } from "../tx.ts";

/** The statuses the redemption method accepts; every other status is still waiting. */
const FINALIZED_STATUSES = new Set([
  "Rewarded",
  "Slashed",
  "QuorumNotMet",
  "ConsensusNotMet",
  "InvalidVote",
]);

/** Withdraw one ticket, redeem it, and deposit whatever comes back into the same account. */
export function redeemManifest(
  account: string,
  oracle: string,
  ticketResource: string,
  localId: string,
): Manifest {
  return buildManifest((builder) =>
    builder
      .callMethod(account, "withdraw_non_fungibles", [
        address(ticketResource),
        array(ValueKind.NonFungibleLocalId, nonFungibleLocalId(localId)),
      ])
      .takeNonFungiblesFromWorktop(ticketResource, [localId], (next, ticketBucket) =>
        next.callMethod(oracle, "redeem_bond_ticket", [bucket(ticketBucket)]),
      )
      .callMethod(account, "try_deposit_batch_or_abort", [
        expression("EntireWorktop"),
        enumeration(0),
      ]),
  );
}

export async function findWork(context: JobContext): Promise<WorkItem[]> {
  const oracle = context.components.oracle;
  if (oracle === null) {
    context.logger.info("[redeem_own_bonds] no oracle component is configured; nothing to do");
    return [];
  }

  const ticketResource = await readComponentField(
    context.gateway,
    oracle,
    "bond_ticket_resource",
  );
  if (ticketResource === null) {
    context.logger.info(
      "[redeem_own_bonds] the oracle state does not name a bond-ticket resource; nothing to do",
    );
    return [];
  }

  const ids = await listAccountNonFungibles(
    context.gateway,
    context.config.account,
    ticketResource,
  );
  if (ids.length === 0) {
    context.logger.info("[redeem_own_bonds] the configured account holds no bond tickets");
    return [];
  }

  const data = await readNonFungibleData(context.gateway, ticketResource, ids);
  const work: WorkItem[] = [];
  for (const id of ids) {
    const fields = data.get(id);
    if (fields === undefined) continue; // Burned since the holdings were read.
    const status = enumVariant(fields, "bond_status");
    if (status === null || !FINALIZED_STATUSES.has(status)) continue;
    const requestId = fieldString(fields, "request_id") ?? "unknown request";
    work.push({
      id,
      local_id: id,
      ticket_resource: ticketResource,
      bond_status: status,
      request_id: requestId,
      summary: `ticket ${id} (${status}) for request ${requestId}`,
    });
  }

  context.logger.info(
    work.length === 0
      ? "[redeem_own_bonds] no finalized ticket is held by the configured account"
      : `[redeem_own_bonds] ${work.length} ticket(s) to redeem: ${work
          .map((item) => String(item.summary))
          .join("; ")}`,
  );
  return work;
}

export async function act(context: JobContext, item: WorkItem): Promise<Outcome> {
  const oracle = context.components.oracle;
  if (oracle === null) return "failed";
  const localId = String(item.local_id);
  const manifest = redeemManifest(
    context.config.account,
    oracle,
    String(item.ticket_resource),
    localId,
  );
  return context.executor.run(manifest, `redeem_own_bonds ${localId}`);
}
