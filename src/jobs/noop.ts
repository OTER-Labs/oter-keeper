/**
 * The placeholder job. It finds no work and acts on nothing; the core tests use it to prove
 * the runner wiring without depending on a contract that a later task adds.
 */

import type { JobContext, WorkItem } from "../runner.ts";
import type { Outcome } from "../tx.ts";

export async function findWork(_context: JobContext): Promise<WorkItem[]> {
  return [];
}

export async function act(_context: JobContext, _item: WorkItem): Promise<Outcome> {
  return "dry_run";
}
