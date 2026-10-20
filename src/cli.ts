#!/usr/bin/env node
/**
 * `oter-keeper run|once|check --config keeper.toml`.
 *
 * `check` validates the file and prints what each job would do. It is allowed to run without
 * a key and without a reachable Gateway, because its job is to tell the operator what is
 * wrong; `run` and `once` refuse both.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { PrivateKey } from "@radixdlt/radix-engine-toolkit";

import {
  ConfigError,
  loadConfig,
  loadKey,
  keySource,
  resolvedJobConfig,
  type KeeperConfig,
} from "./config.ts";
import {
  resolveComponents,
  type ComponentSource,
  type Components,
} from "./discover.ts";
import { Gateway, GatewayError, type GatewayStatus } from "./gateway.ts";
import { Limits, parseXrd } from "./limits.ts";
import { JOBS, Runner, type JobContext } from "./runner.ts";
import { StateFile, StateError } from "./state.ts";
import { consoleLogger, Executor } from "./tx.ts";

const USAGE = `Usage: oter-keeper <run|once|check> [--config keeper.toml]

  run    keep running the enabled jobs on their intervals
  once   run the enabled jobs once and exit
  check  validate the config, report the key source and discover the components

Dry run is the default: no transaction is submitted unless the config sets
live_submit = true and every spending limit allows it.`;

function printComponents(components: Components, source: ComponentSource): void {
  const origin =
    source === "config"
      ? "explicit (config [components] table)"
      : "discovered from the dApp definition account";
  if (components.entities.length === 0) {
    consoleLogger.info(`components: ${origin}: none`);
    return;
  }
  consoleLogger.info(`components: ${origin}: ${components.entities.length} known`);
  for (const entity of components.entities) {
    const blueprint = entity.blueprint ?? "unknown blueprint";
    const link =
      entity.dapp_definition === null
        ? ""
        : ` (dapp_definition ${entity.dapp_definition})`;
    consoleLogger.info(`  ${blueprint} ${entity.address}${link}`);
  }
  if (components.missing.length > 0) {
    consoleLogger.info(`  missing from the Gateway: ${components.missing.join(", ")}`);
  }
  if (components.unlinked.length > 0) {
    consoleLogger.info(
      `  unlinked (dapp_definition names another account): ${components.unlinked.join(", ")}`,
    );
  }
}

function printJobs(config: KeeperConfig): void {
  const names = [...new Set([...JOBS.map((job) => job.name), ...Object.keys(config.jobs)])];
  consoleLogger.info("jobs:");
  for (const name of names) {
    const job = resolvedJobConfig(config, name);
    const state = job.enabled ? "enabled" : "disabled";
    consoleLogger.info(`  ${name}: ${state}, every ${job.interval_secs}s`);
  }
}

/** `check` only asks each job what it would do; no transaction is built or signed. */
const CHECK_EXECUTOR = {
  run: async (): Promise<never> => {
    throw new Error("check never submits a transaction");
  },
} as unknown as Executor;

async function printWork(
  config: KeeperConfig,
  gateway: Gateway,
  components: Components,
): Promise<void> {
  const statePath = join(
    mkdtempSync(join(tmpdir(), "oter-keeper-check-")),
    "state.json",
  );
  const context: JobContext = {
    config,
    gateway,
    components,
    executor: CHECK_EXECUTOR,
    state: StateFile.load(statePath),
    logger: consoleLogger,
  };

  consoleLogger.info("would do (nothing is built or submitted):");
  for (const job of JOBS) {
    if (!resolvedJobConfig(config, job.name).enabled) {
      consoleLogger.info(`  ${job.name}: disabled`);
      continue;
    }
    try {
      const work = await job.findWork(context);
      if (work.length === 0) {
        consoleLogger.info(`  ${job.name}: no work`);
        continue;
      }
      consoleLogger.info(`  ${job.name}: ${work.length} item(s)`);
      for (const item of work.slice(0, 5)) {
        consoleLogger.info(`    ${String(item.summary ?? item.id)}`);
      }
      if (work.length > 5) {
        consoleLogger.info(`    ... and ${work.length - 5} more`);
      }
    } catch (error) {
      if (error instanceof GatewayError) {
        consoleLogger.info(`  ${job.name}: unavailable (${error.message})`);
        continue;
      }
      throw error;
    }
  }
}

function describeKey(config: KeeperConfig, env: NodeJS.ProcessEnv): string {
  try {
    loadKey(config, env);
    return `available (${keySource(config)})`;
  } catch (error) {
    return `not available: ${(error as Error).message}`;
  }
}

async function check(configPath: string, env: NodeJS.ProcessEnv): Promise<number> {
  const config = loadConfig(configPath);
  consoleLogger.info(
    `dry run: ${config.live_submit ? "no (live_submit = true)" : "yes (live_submit = false)"}`,
  );
  consoleLogger.info(`config: ${configPath}`);
  consoleLogger.info(`network: ${config.network}`);
  consoleLogger.info(`account: ${config.account}`);
  consoleLogger.info(`dapp definition: ${config.dapp_definition}`);
  consoleLogger.info(`key: ${describeKey(config, env)}`);

  const gateway = new Gateway(config.gateways, config.network);
  let status: GatewayStatus;
  try {
    status = await gateway.status();
  } catch (error) {
    if (error instanceof GatewayError) {
      consoleLogger.info(`no network: ${error.message}`);
      printJobs(config);
      return 0;
    }
    throw error;
  }

  consoleLogger.info(
    `gateway: ${config.gateways[0]} (${status.ledger_state.network}, state version ${status.ledger_state.state_version}, epoch ${status.ledger_state.epoch})`,
  );

  let components: Components | null = null;
  try {
    const resolved = await resolveComponents(gateway, config);
    components = resolved.components;
    printComponents(resolved.components, resolved.source);
  } catch (error) {
    if (error instanceof GatewayError) {
      consoleLogger.info(`discovery failed: ${error.message}`);
    } else {
      throw error;
    }
  }

  if (components !== null) {
    await printWork(config, gateway, components);
  }
  printJobs(config);
  return 0;
}

async function runKeeper(
  command: "run" | "once",
  configPath: string,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const config = loadConfig(configPath);
  consoleLogger.info(
    `dry run: ${config.live_submit ? "no (live_submit = true)" : "yes (live_submit = false)"}`,
  );

  const key = loadKey(config, env);
  const gateway = new Gateway(config.gateways, config.network);
  const status = await gateway.status();
  consoleLogger.info(
    `network: ${config.network}, state version ${status.ledger_state.state_version}, epoch ${status.ledger_state.epoch}`,
  );

  const resolved = await resolveComponents(gateway, config);
  printComponents(resolved.components, resolved.source);

  const state = StateFile.load();
  const limits = new Limits(state, {
    maxFeePerTx: parseXrd(config.max_fee_xrd_per_tx),
    maxFeePerDay: parseXrd(config.max_fee_xrd_per_day),
    reserveFloor: parseXrd(config.reserve_floor_xrd),
  });
  const executor = new Executor({
    gateway,
    network: config.network,
    account: config.account,
    privateKey: new PrivateKey.Ed25519(key),
    liveSubmit: config.live_submit,
    maxFeePerTx: parseXrd(config.max_fee_xrd_per_tx),
    limits,
    logger: consoleLogger,
  });

  const runner = new Runner({
    config,
    gateway,
    components: resolved.components,
    executor,
    state,
    logger: consoleLogger,
  });

  if (command === "once") {
    const records = await runner.once();
    const failures = records.filter((record) => record.error !== undefined);
    consoleLogger.info(`done: ${records.length} item(s), ${failures.length} failure(s)`);
    return failures.length === 0 ? 0 : 1;
  }

  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await runner.run(controller.signal);
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
  consoleLogger.info("stopped");
  return 0;
}

export async function main(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        config: { type: "string", short: "c", default: "keeper.toml" },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (error) {
    consoleLogger.error((error as Error).message);
    consoleLogger.error(USAGE);
    return 2;
  }

  const { values, positionals } = parsed;
  if (values.help === true || positionals.length === 0) {
    consoleLogger.info(USAGE);
    return positionals.length === 0 && values.help !== true ? 2 : 0;
  }

  const command = positionals[0];
  const configPath = values.config as string;

  try {
    if (command === "check") return await check(configPath, env);
    if (command === "run" || command === "once") {
      return await runKeeper(command, configPath, env);
    }
    consoleLogger.error(`unknown command: ${String(command)}`);
    consoleLogger.error(USAGE);
    return 2;
  } catch (error) {
    if (error instanceof ConfigError) {
      consoleLogger.error(`config error: ${error.message}`);
      return 2;
    }
    if (error instanceof StateError) {
      consoleLogger.error(`state error: ${error.message}`);
      return 1;
    }
    if (error instanceof GatewayError) {
      consoleLogger.error(`gateway error: ${error.message}`);
      return 1;
    }
    consoleLogger.error(`error: ${(error as Error).message}`);
    return 1;
  }
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  fileURLToPath(import.meta.url) === resolve(invokedPath)
) {
  main().then((code) => {
    process.exitCode = code;
  });
}
