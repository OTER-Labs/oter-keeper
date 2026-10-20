/**
 * Run the enabled jobs, once (`once`) or on their intervals (`run`).
 *
 * A failing work-finder or action is logged and does not stop the other jobs: a keeper that
 * exits on one Gateway hiccup stops keeping anything.
 */

import { resolvedJobConfig, type KeeperConfig } from "./config.ts";
import type { Components } from "./discover.ts";
import type { Gateway } from "./gateway.ts";
import type { StateFile } from "./state.ts";
import type { Executor, Logger, Outcome } from "./tx.ts";
import * as finalize from "./jobs/finalize.ts";
import * as noop from "./jobs/noop.ts";
import * as openReveal from "./jobs/open-reveal.ts";
import * as redeemBonds from "./jobs/redeem-bonds.ts";

export interface JobContext {
  config: KeeperConfig;
  gateway: Gateway;
  components: Components;
  executor: Executor;
  state: StateFile;
  logger: Logger;
}

export interface WorkItem {
  id: string;
  [key: string]: unknown;
}

export interface JobModule {
  findWork(context: JobContext): Promise<WorkItem[]>;
  act(context: JobContext, item: WorkItem): Promise<Outcome>;
}

export interface RegisteredJob extends JobModule {
  name: string;
}

export const JOBS: readonly RegisteredJob[] = [
  { name: "finalize", findWork: finalize.findWork, act: finalize.act },
  { name: "open_reveal", findWork: openReveal.findWork, act: openReveal.act },
  { name: "redeem_own_bonds", findWork: redeemBonds.findWork, act: redeemBonds.act },
  { name: "noop", findWork: noop.findWork, act: noop.act },
];

export interface RunRecord {
  job: string;
  item: string;
  outcome?: Outcome;
  error?: string;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
    signal?.addEventListener("abort", finish, { once: true });
  });
}

export class Runner {
  private readonly context: JobContext;
  private readonly jobs: readonly RegisteredJob[];

  constructor(context: JobContext, jobs: readonly RegisteredJob[] = JOBS) {
    this.context = context;
    this.jobs = jobs;
  }

  /** Every enabled job once, in registry order. */
  async once(): Promise<RunRecord[]> {
    const records: RunRecord[] = [];
    for (const job of this.jobs) {
      if (!resolvedJobConfig(this.context.config, job.name).enabled) continue;
      records.push(...(await this.runJob(job)));
    }
    return records;
  }

  /** The long-running loop. Returns when `signal` aborts. */
  async run(signal?: AbortSignal): Promise<void> {
    const enabled = this.jobs.filter(
      (job) => resolvedJobConfig(this.context.config, job.name).enabled,
    );
    if (enabled.length === 0) {
      this.context.logger.info("no jobs are enabled");
      return;
    }

    const nextRun = new Map<string, number>();
    for (const job of enabled) nextRun.set(job.name, 0);

    while (signal?.aborted !== true) {
      const now = Date.now();
      for (const job of enabled) {
        const due = nextRun.get(job.name) ?? 0;
        if (due > now) continue;
        await this.runJob(job);
        const interval = resolvedJobConfig(this.context.config, job.name).interval_secs;
        nextRun.set(job.name, Date.now() + interval * 1_000);
      }

      const earliest = Math.min(...[...nextRun.values()]);
      const wait = Math.max(0, Math.min(earliest - Date.now(), 1_000));
      await sleep(wait, signal);
    }
  }

  private async runJob(job: RegisteredJob): Promise<RunRecord[]> {
    let work: WorkItem[];
    try {
      work = await job.findWork(this.context);
    } catch (error) {
      this.context.logger.error(`[${job.name}] work-finder failed: ${(error as Error).message}`);
      return [{ job: job.name, item: "-", error: (error as Error).message }];
    }

    const records: RunRecord[] = [];
    for (const item of work) {
      try {
        const outcome = await job.act(this.context, item);
        records.push({ job: job.name, item: item.id, outcome });
      } catch (error) {
        const message = (error as Error).message;
        this.context.logger.error(`[${job.name}] ${item.id} failed: ${message}`);
        records.push({ job: job.name, item: item.id, error: message });
      }
    }
    return records;
  }
}
