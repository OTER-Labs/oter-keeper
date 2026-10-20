/**
 * Find the components a keeper watches from the dApp definition account alone.
 *
 * The account's `claimed_entities` metadata names the entities it vouches for, and each
 * entity's `blueprint_name` says what it is. That is the whole discovery rule: a redeploy
 * updates the ledger, and nobody's config goes stale.
 */

import {
  ConfigError,
  type ExplicitComponents,
  type KeeperConfig,
} from "./config.ts";
import { GatewayError, type Gateway } from "./gateway.ts";

export interface DiscoveredEntity {
  address: string;
  blueprint: string | null;
  dapp_definition: string | null;
}

export interface Components {
  oracle: string | null;
  registry: string | null;
  identifierConsultation: string | null;
  identifierElection: string | null;
  identifierGovernance: string | null;
  identifierYesOrNoQuery: string | null;
  spaceTreasuryHub: string | null;
  spaceTreasury: string | null;
  grantEscrow: string | null;
  distribution: string | null;
  /** Every space treasury named by the config or claimed by the dApp definition. */
  spaceTreasuries: string[];
  /** Every distribution component named by the config or claimed by the dApp definition. */
  distributions: string[];
  /** Every claimed address the Gateway knows, in claimed order. */
  entities: DiscoveredEntity[];
  /** Address to every entry's blueprint name, including blueprints the keeper does not use. */
  byBlueprint: Record<string, string[]>;
  /** The raw claimed list, including addresses the Gateway did not return. */
  claimed: string[];
  /** Claimed addresses the Gateway has never heard of. */
  missing: string[];
  /** Claimed entities whose own dapp_definition names a different account. */
  unlinked: string[];
}

/** Where the watched components came from, for `check`. */
export type ComponentSource = "config" | "discovered";

export interface ResolvedComponents {
  components: Components;
  source: ComponentSource;
}

type ComponentField =
  | "oracle"
  | "registry"
  | "identifierConsultation"
  | "identifierElection"
  | "identifierGovernance"
  | "identifierYesOrNoQuery"
  | "spaceTreasuryHub"
  | "spaceTreasury"
  | "grantEscrow"
  | "distribution";

const BLUEPRINT_FIELDS: Record<string, ComponentField> = {
  OterOracleV1: "oracle",
  ConsultationRegistryV1: "registry",
  OterConsultationRegistryV1: "registry",
  OterIdentifierConsultationV1: "identifierConsultation",
  OterIdentifierElectionV1: "identifierElection",
  OterIdentifierGovernanceV1: "identifierGovernance",
  OterIdentifierYesOrNoQueryV1: "identifierYesOrNoQuery",
  OterSpaceTreasuryHubV1: "spaceTreasuryHub",
  OterSpaceTreasuryV1: "spaceTreasury",
  OterGrantEscrowV1: "grantEscrow",
  OterDistributionV1: "distribution",
};

const DETAILS_BATCH_SIZE = 20;

/** The blueprints each explicit config key may name. More than one is accepted where the
 * deployed blueprint has been renamed without changing what the component is. */
const EXPLICIT_BLUEPRINTS: Record<
  Exclude<keyof ExplicitComponents, "space_treasuries" | "distributions">,
  string[]
> = {
  oracle: ["OterOracleV1"],
  registry: ["OterConsultationRegistryV1", "ConsultationRegistryV1"],
  consultation_identifier: ["OterIdentifierConsultationV1"],
  election_identifier: ["OterIdentifierElectionV1"],
  hub: ["OterSpaceTreasuryHubV1"],
  grant_escrow: ["OterGrantEscrowV1"],
};

const EXPLICIT_ARRAY_BLUEPRINTS: Record<"space_treasuries" | "distributions", string[]> = {
  space_treasuries: ["OterSpaceTreasuryV1"],
  distributions: ["OterDistributionV1"],
};

interface MetadataItem {
  key?: string;
  value?: {
    typed?: unknown;
  };
}

interface EntityDetailsItem {
  address?: string;
  details?: {
    blueprint_name?: string | null;
  };
  metadata?: {
    items?: MetadataItem[];
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function metadataValue(item: EntityDetailsItem, key: string): unknown {
  const metadata = item.metadata?.items?.find((entry) => entry.key === key);
  if (metadata === undefined) return undefined;
  return isRecord(metadata.value) ? metadata.value.typed : undefined;
}

/**
 * `claimed_entities` is a String metadata holding a JSON array on most deployments; newer
 * Gateway versions may render it as a typed StringArray. Both shapes are accepted, and a
 * malformed value is treated as "nothing claimed" rather than as a fatal error: discovery
 * must never take the keeper down before its safety checks have run.
 */
export function parseClaimedEntities(value: unknown): string[] {
  if (!isRecord(value)) return [];

  let candidates: unknown;
  if (Array.isArray(value.values)) {
    candidates = value.values;
  } else if (typeof value.value === "string") {
    try {
      candidates = JSON.parse(value.value) as unknown;
    } catch {
      return [];
    }
  } else {
    return [];
  }

  if (!Array.isArray(candidates)) return [];
  return candidates.filter(
    (entry): entry is string => typeof entry === "string" && entry.trim() !== "",
  );
}

function parseDappDefinition(value: unknown): string | null {
  if (!isRecord(value)) return null;
  if (typeof value.value === "string" && value.value.startsWith("account_")) {
    return value.value;
  }
  if (Array.isArray(value.values)) {
    const first = value.values.find(
      (entry): entry is string => typeof entry === "string" && entry.startsWith("account_"),
    );
    return first ?? null;
  }
  return null;
}

async function entityDetails(
  gateway: Gateway,
  addresses: string[],
  explicitMetadata: string[] = ["dapp_definition"],
): Promise<EntityDetailsItem[]> {
  if (addresses.length === 0) return [];
  const answer = await gateway.post<{ items?: EntityDetailsItem[] }>(
    "/state/entity/details",
    {
      addresses,
      aggregation_level: "Global",
      opt_ins: { explicit_metadata: explicitMetadata },
    },
  );
  return answer.items ?? [];
}

export async function discoverComponents(
  gateway: Gateway,
  dappDefinition: string,
): Promise<Components> {
  const [account] = await entityDetails(gateway, [dappDefinition], ["claimed_entities"]);
  if (account === undefined) {
    throw new GatewayError(
      `the gateway does not know dApp definition account ${dappDefinition}`,
    );
  }
  const claimed = parseClaimedEntities(metadataValue(account, "claimed_entities"));
  const uniqueClaimed = [...new Set(claimed)];

  const entities: DiscoveredEntity[] = [];
  const found = new Set<string>();
  for (let offset = 0; offset < uniqueClaimed.length; offset += DETAILS_BATCH_SIZE) {
    const batch = uniqueClaimed.slice(offset, offset + DETAILS_BATCH_SIZE);
    const items = await entityDetails(gateway, batch);
    for (const item of items) {
      if (item.address === undefined) continue;
      found.add(item.address);
      entities.push({
        address: item.address,
        blueprint: item.details?.blueprint_name ?? null,
        dapp_definition: parseDappDefinition(metadataValue(item, "dapp_definition")),
      });
    }
  }

  // A claimed address is only useful when the component names the same account as its own
  // dApp definition. An absent backlink is tolerated (older deployments may not set one); a
  // backlink to a different account is not, because the two-way link is what makes the
  // claim meaningful.
  const linked = entities.filter(
    (entity) =>
      entity.dapp_definition === null || entity.dapp_definition === dappDefinition,
  );

  const byBlueprint: Record<string, string[]> = {};
  for (const entity of linked) {
    if (entity.blueprint === null) continue;
    (byBlueprint[entity.blueprint] ??= []).push(entity.address);
  }

  const components: Components = {
    oracle: null,
    registry: null,
    identifierConsultation: null,
    identifierElection: null,
    identifierGovernance: null,
    identifierYesOrNoQuery: null,
    spaceTreasuryHub: null,
    spaceTreasury: null,
    grantEscrow: null,
    distribution: null,
    spaceTreasuries: byBlueprint["OterSpaceTreasuryV1"] ?? [],
    distributions: byBlueprint["OterDistributionV1"] ?? [],
    entities,
    byBlueprint,
    claimed: uniqueClaimed,
    missing: uniqueClaimed.filter((address) => !found.has(address)),
    unlinked: entities
      .filter(
        (entity) =>
          entity.dapp_definition !== null && entity.dapp_definition !== dappDefinition,
      )
      .map((entity) => entity.address),
  };

  for (const entity of linked) {
    if (entity.blueprint === null) continue;
    const field = BLUEPRINT_FIELDS[entity.blueprint];
    if (field !== undefined && components[field] === null) {
      components[field] = entity.address;
    }
  }

  return components;
}

interface ExplicitEntry {
  key: keyof ExplicitComponents;
  address: string;
  blueprints: string[];
}

function explicitEntries(explicit: ExplicitComponents): ExplicitEntry[] {
  const entries: ExplicitEntry[] = [];
  for (const [key, blueprints] of Object.entries(EXPLICIT_BLUEPRINTS) as Array<
    [keyof typeof EXPLICIT_BLUEPRINTS, string[]]
  >) {
    const address = explicit[key];
    if (address !== undefined) entries.push({ key, address, blueprints });
  }
  for (const [key, blueprints] of Object.entries(EXPLICIT_ARRAY_BLUEPRINTS) as Array<
    [keyof typeof EXPLICIT_ARRAY_BLUEPRINTS, string[]]
  >) {
    for (const address of explicit[key] ?? []) {
      entries.push({ key, address, blueprints });
    }
  }
  return entries;
}

/**
 * Use the `[components]` table as given, after asking the Gateway for each address's blueprint.
 * Discovery is not consulted at all: a table that names the components is the operator saying
 * they know the deployment.
 */
export async function explicitComponents(
  gateway: Gateway,
  explicit: ExplicitComponents,
): Promise<Components> {
  const entries = explicitEntries(explicit);
  const addresses = [...new Set(entries.map((entry) => entry.address))];

  const blueprintByAddress = new Map<string, string>();
  for (let offset = 0; offset < addresses.length; offset += DETAILS_BATCH_SIZE) {
    const batch = addresses.slice(offset, offset + DETAILS_BATCH_SIZE);
    for (const item of await entityDetails(gateway, batch)) {
      if (item.address === undefined) continue;
      const blueprint = item.details?.blueprint_name;
      if (typeof blueprint === "string" && blueprint !== "") {
        blueprintByAddress.set(item.address, blueprint);
      }
    }
  }

  for (const entry of entries) {
    const blueprint = blueprintByAddress.get(entry.address);
    if (blueprint === undefined) {
      throw new ConfigError(
        `\`components.${entry.key}\` names ${entry.address}, which the gateway does not know`,
      );
    }
    if (!entry.blueprints.includes(blueprint)) {
      throw new ConfigError(
        `\`components.${entry.key}\` names ${entry.address}, but its blueprint is ${blueprint}`,
      );
    }
  }

  const byBlueprint: Record<string, string[]> = {};
  const entities: DiscoveredEntity[] = [];
  for (const address of addresses) {
    const blueprint = blueprintByAddress.get(address) ?? null;
    if (blueprint !== null) (byBlueprint[blueprint] ??= []).push(address);
    entities.push({ address, blueprint, dapp_definition: null });
  }

  const components: Components = {
    oracle: null,
    registry: null,
    identifierConsultation: null,
    identifierElection: null,
    identifierGovernance: null,
    identifierYesOrNoQuery: null,
    spaceTreasuryHub: null,
    spaceTreasury: null,
    grantEscrow: null,
    distribution: null,
    spaceTreasuries: [...new Set(explicit.space_treasuries ?? [])],
    distributions: [...new Set(explicit.distributions ?? [])],
    entities,
    byBlueprint,
    claimed: addresses,
    missing: [],
    unlinked: [],
  };

  if (explicit.oracle !== undefined) components.oracle = explicit.oracle;
  if (explicit.registry !== undefined) components.registry = explicit.registry;
  if (explicit.consultation_identifier !== undefined) {
    components.identifierConsultation = explicit.consultation_identifier;
  }
  if (explicit.election_identifier !== undefined) {
    components.identifierElection = explicit.election_identifier;
  }
  if (explicit.hub !== undefined) components.spaceTreasuryHub = explicit.hub;
  if (explicit.grant_escrow !== undefined) components.grantEscrow = explicit.grant_escrow;
  components.spaceTreasury = components.spaceTreasuries[0] ?? null;
  components.distribution = components.distributions[0] ?? null;

  return components;
}

/** Resolve the watched components, explicit table first, discovery only when it is absent. */
export async function resolveComponents(
  gateway: Gateway,
  config: KeeperConfig,
): Promise<ResolvedComponents> {
  if (config.components !== undefined) {
    return {
      components: await explicitComponents(gateway, config.components),
      source: "config",
    };
  }
  return {
    components: await discoverComponents(gateway, config.dapp_definition),
    source: "discovered",
  };
}
