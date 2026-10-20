/**
 * Find the components a keeper watches from the dApp definition account alone.
 *
 * The account's `claimed_entities` metadata names the entities it vouches for, and each
 * entity's `blueprint_name` says what it is. That is the whole discovery rule: a redeploy
 * updates the ledger, and nobody's config goes stale.
 */

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
