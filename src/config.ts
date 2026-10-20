/**
 * The keeper's one configuration file. Everything a run needs is here except the key bytes,
 * which are read from the source named here and never copied into the config object.
 *
 * The file is deliberately small: the network and the dApp definition account identify the
 * deployment, and the keeper discovers the rest from the account's claimed entities. A
 * redeploy therefore does not leave stale component addresses in anyone's config.
 */

import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import { parse } from "smol-toml";

export type NetworkName = "stokenet" | "mainnet";

export const NETWORK_IDS: Record<NetworkName, number> = {
  stokenet: 2,
  mainnet: 1,
};

export const PUBLIC_GATEWAYS: Record<NetworkName, string> = {
  stokenet: "https://stokenet.radixdlt.com",
  mainnet: "https://mainnet.radixdlt.com",
};

/** The XRD resource on each network, used for the reserve-floor balance read. */
export const XRD_RESOURCES: Record<NetworkName, string> = {
  stokenet: "resource_tdx_2_1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxtfd2jc",
  mainnet: "resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxtfd2jc",
};

export interface JobConfig {
  enabled: boolean;
  interval_secs: number;
}

export interface DisputeJobConfig extends JobConfig {
  max_bond: number;
  max_bonds_per_day: number;
  tally_api?: string;
}

/**
 * Components named by hand instead of discovered from the dApp definition's claimed entities.
 * Every address given here is checked against the Gateway before it is used.
 */
export interface ExplicitComponents {
  oracle?: string;
  registry?: string;
  consultation_identifier?: string;
  election_identifier?: string;
  hub?: string;
  grant_escrow?: string;
  space_treasuries?: string[];
  distributions?: string[];
}

export interface KeeperConfig {
  network: NetworkName;
  /**
   * The dApp definition account discovery reads. Required only when `[components]` is absent:
   * a table that names the components needs no discovery.
   */
  dapp_definition?: string;
  gateways: string[];
  account: string;
  components?: ExplicitComponents;
  key_file?: string;
  key_env?: string;
  live_submit: boolean;
  max_fee_xrd_per_tx: number;
  max_fee_xrd_per_day: number;
  reserve_floor_xrd: number;
  jobs: Record<string, JobConfig | DisputeJobConfig>;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const DEFAULT_LIVENESS_INTERVAL_SECS = 60;
const DEFAULT_DISPUTE_INTERVAL_SECS = 300;
const MAX_GATEWAYS = 4;

function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(table: Record<string, unknown>, key: string): string {
  const value = table[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`\`${key}\` must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(table: Record<string, unknown>, key: string): string | undefined {
  const value = table[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`\`${key}\` must be a non-empty string when present`);
  }
  return value.trim();
}

function requireNumber(table: Record<string, unknown>, key: string): number {
  const value = table[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ConfigError(`\`${key}\` must be a non-negative number`);
  }
  return value;
}

/** The prefix each network's bech32m account addresses carry. */
function accountPrefix(network: NetworkName): string {
  return network === "stokenet" ? "account_tdx_2_" : "account_rdx1";
}

function requireAccountAddress(value: string, key: string, network: NetworkName): string {
  if (!value.startsWith(accountPrefix(network))) {
    throw new ConfigError(
      `\`${key}\` must be a ${network} account address (${accountPrefix(network)}...)`,
    );
  }
  return value;
}

/** The prefix each network's component addresses carry. */
function componentPrefix(network: NetworkName): string {
  return network === "stokenet" ? "component_tdx_2_" : "component_rdx1";
}

function requireComponentAddress(value: string, key: string, network: NetworkName): string {
  if (!value.startsWith(componentPrefix(network))) {
    throw new ConfigError(
      `\`components.${key}\` must be a ${network} component address (${componentPrefix(network)}...)`,
    );
  }
  return value;
}

const COMPONENT_KEYS = [
  "oracle",
  "registry",
  "consultation_identifier",
  "election_identifier",
  "hub",
  "grant_escrow",
  "space_treasuries",
  "distributions",
] as const;

/**
 * `[components]` names the watched components explicitly. Its presence turns discovery off,
 * so a typo in a key must be refused rather than silently ignored.
 */
function parseComponents(
  raw: unknown,
  network: NetworkName,
): ExplicitComponents | undefined {
  if (raw === undefined) return undefined;
  if (!isTable(raw)) {
    throw new ConfigError("`components` must be a table");
  }

  for (const key of Object.keys(raw)) {
    if (!(COMPONENT_KEYS as readonly string[]).includes(key)) {
      throw new ConfigError(`unknown key \`components.${key}\``);
    }
  }

  const components: ExplicitComponents = {};
  for (const key of [
    "oracle",
    "registry",
    "consultation_identifier",
    "election_identifier",
    "hub",
    "grant_escrow",
  ] as const) {
    const value = optionalString(raw, key);
    if (value !== undefined) {
      components[key] = requireComponentAddress(value, key, network);
    }
  }

  for (const key of ["space_treasuries", "distributions"] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
      throw new ConfigError(`\`components.${key}\` must be an array of addresses`);
    }
    components[key] = value.map((entry) =>
      requireComponentAddress(entry, key, network),
    );
  }

  return components;
}

function parseJobs(raw: unknown): Record<string, JobConfig | DisputeJobConfig> {
  if (raw === undefined) return {};
  if (!isTable(raw)) {
    throw new ConfigError("`jobs` must be a table of jobs");
  }

  const jobs: Record<string, JobConfig | DisputeJobConfig> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!isTable(value)) {
      throw new ConfigError(`\`jobs.${name}\` must be a table`);
    }

    const enabled =
      value.enabled === undefined ? name !== "dispute" : value.enabled;
    if (typeof enabled !== "boolean") {
      throw new ConfigError(`\`jobs.${name}.enabled\` must be a boolean`);
    }

    const interval =
      value.interval_secs === undefined
        ? name === "dispute"
          ? DEFAULT_DISPUTE_INTERVAL_SECS
          : DEFAULT_LIVENESS_INTERVAL_SECS
        : value.interval_secs;
    if (typeof interval !== "number" || !Number.isFinite(interval) || interval <= 0) {
      throw new ConfigError(`\`jobs.${name}.interval_secs\` must be a positive number`);
    }

    if (name === "dispute") {
      const maxBond = requireNumber(value, "max_bond");
      const maxBondsPerDay = requireNumber(value, "max_bonds_per_day");
      const tallyApi = optionalString(value, "tally_api");
      jobs[name] = {
        enabled,
        interval_secs: interval,
        max_bond: maxBond,
        max_bonds_per_day: maxBondsPerDay,
        ...(tallyApi === undefined ? {} : { tally_api: tallyApi }),
      };
      continue;
    }

    jobs[name] = { enabled, interval_secs: interval };
  }
  return jobs;
}

/**
 * Read and validate `path`. Relative key paths are resolved against the config file's own
 * directory, so a keeper started from cron finds the same key a keeper started in its
 * checkout does.
 */
export function loadConfig(path: string): KeeperConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown error";
    throw new ConfigError(`cannot read config ${path} (${code})`);
  }

  let table: Record<string, unknown>;
  try {
    const parsed = parse(text);
    if (!isTable(parsed)) {
      throw new ConfigError("the config file must contain a table");
    }
    table = parsed;
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(`cannot parse config ${path}: ${(error as Error).message}`);
  }

  const network = requireString(table, "network");
  if (network !== "stokenet" && network !== "mainnet") {
    throw new ConfigError('`network` must be "stokenet" or "mainnet"');
  }

  const components = parseComponents(table.components, network);

  let dappDefinition: string | undefined;
  if (table.dapp_definition === undefined) {
    if (components === undefined) {
      throw new ConfigError(
        "`dapp_definition` is required when there is no `[components]` table: discovery reads its claimed entities",
      );
    }
  } else {
    dappDefinition = requireAccountAddress(
      requireString(table, "dapp_definition"),
      "dapp_definition",
      network,
    );
  }

  const account = requireAccountAddress(
    requireString(table, "account"),
    "account",
    network,
  );

  const rawGateways = table.gateways;
  let gateways: string[];
  if (rawGateways === undefined) {
    gateways = [PUBLIC_GATEWAYS[network]];
  } else {
    if (
      !Array.isArray(rawGateways) ||
      rawGateways.length === 0 ||
      rawGateways.some((url) => typeof url !== "string" || !/^https?:\/\//.test(url))
    ) {
      throw new ConfigError("`gateways` must be a non-empty array of http(s) URLs");
    }
    if (rawGateways.length > MAX_GATEWAYS) {
      throw new ConfigError(`\`gateways\` accepts at most ${MAX_GATEWAYS} entries`);
    }
    gateways = rawGateways.map((url) => (url as string).replace(/\/+$/, ""));
  }

  const keyFileRaw = optionalString(table, "key_file");
  const keyEnv = optionalString(table, "key_env");
  if ((keyFileRaw === undefined) === (keyEnv === undefined)) {
    throw new ConfigError("exactly one of `key_file` or `key_env` must be set");
  }
  if (keyEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyEnv)) {
    throw new ConfigError("`key_env` must be an environment variable name");
  }
  const keyFile =
    keyFileRaw === undefined
      ? undefined
      : isAbsolute(keyFileRaw)
        ? keyFileRaw
        : resolve(dirname(path), keyFileRaw);

  const liveSubmit = table.live_submit ?? false;
  if (typeof liveSubmit !== "boolean") {
    throw new ConfigError("`live_submit` must be a boolean");
  }

  const maxFeePerTx = requireNumber(table, "max_fee_xrd_per_tx");
  const maxFeePerDay = requireNumber(table, "max_fee_xrd_per_day");
  const reserveFloor = requireNumber(table, "reserve_floor_xrd");
  if (maxFeePerDay < maxFeePerTx) {
    throw new ConfigError(
      "`max_fee_xrd_per_day` must be at least `max_fee_xrd_per_tx`",
    );
  }

  const jobs = parseJobs(table.jobs);

  return {
    network,
    ...(dappDefinition === undefined ? {} : { dapp_definition: dappDefinition }),
    gateways,
    account,
    ...(components === undefined ? {} : { components }),
    ...(keyFile === undefined ? {} : { key_file: keyFile }),
    ...(keyEnv === undefined ? {} : { key_env: keyEnv }),
    live_submit: liveSubmit,
    max_fee_xrd_per_tx: maxFeePerTx,
    max_fee_xrd_per_day: maxFeePerDay,
    reserve_floor_xrd: reserveFloor,
    jobs,
  };
}

/** The interval a job runs at: its configured value, or the default for its kind. */
export function resolvedJobConfig(config: KeeperConfig, name: string): JobConfig {
  const configured = config.jobs[name];
  if (configured !== undefined) return configured;
  if (name === "dispute") {
    return { enabled: false, interval_secs: DEFAULT_DISPUTE_INTERVAL_SECS };
  }
  return { enabled: true, interval_secs: DEFAULT_LIVENESS_INTERVAL_SECS };
}

/**
 * Read the signing key from the source the config names. The bytes are returned to the caller
 * and never logged. Error messages name the source, not its contents, so a malformed key
 * cannot leak into a terminal, a log file or a crash report.
 */
export function loadKey(
  config: KeeperConfig,
  env: NodeJS.ProcessEnv = process.env,
): Uint8Array {
  let hex: string;

  if (config.key_file !== undefined) {
    try {
      hex = readFileSync(config.key_file, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "unknown error";
      throw new ConfigError(`cannot read key file ${config.key_file} (${code})`);
    }
  } else if (config.key_env !== undefined) {
    const value = env[config.key_env];
    if (value === undefined || value.trim() === "") {
      throw new ConfigError(`key environment variable ${config.key_env} is not set`);
    }
    hex = value;
  } else {
    throw new ConfigError("no key source is configured");
  }

  const cleaned = hex.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(cleaned)) {
    throw new ConfigError(
      "the signing key must be 32 bytes of hex (64 hex characters); its value is not shown",
    );
  }
  return Uint8Array.from(Buffer.from(cleaned, "hex"));
}

/** A description of where the key will come from, safe to print. */
export function keySource(config: KeeperConfig): string {
  if (config.key_file !== undefined) return `file ${config.key_file}`;
  if (config.key_env !== undefined) return `environment variable ${config.key_env}`;
  return "none configured";
}
