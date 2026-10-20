/**
 * Reads and small parsers shared by the oracle jobs.
 *
 * The Gateway renders event data, component state and non-fungible data as programmatic JSON:
 * a list of named fields, each carrying its kind and, for a nested value, its own fields. The
 * helpers here read only the named fields the jobs need, so an added field elsewhere in a
 * struct does not break them.
 */

import { GatewayError, type Gateway } from "./gateway.ts";

export interface JsonField {
  field_name?: string;
  kind?: string;
  type_name?: string;
  variant_name?: string;
  value?: unknown;
  fields?: unknown[];
  /** The elements of an Array value. */
  elements?: unknown[];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The fields of a programmatic JSON tuple, whether given directly or wrapped. */
export function jsonFields(value: unknown): JsonField[] {
  if (!isRecord(value)) return [];
  if (Array.isArray(value.fields)) return value.fields as JsonField[];
  const nested = value.programmatic_json;
  if (isRecord(nested) && Array.isArray(nested.fields)) {
    return nested.fields as JsonField[];
  }
  return [];
}

export function fieldEntry(
  fields: readonly JsonField[],
  name: string,
): JsonField | undefined {
  return fields.find((field) => field.field_name === name);
}

export function fieldString(
  fields: readonly JsonField[],
  name: string,
): string | null {
  const value = fieldEntry(fields, name)?.value;
  return typeof value === "string" ? value : null;
}

/** A number rendered either as a JSON number or as a decimal string. */
export function fieldNumber(
  fields: readonly JsonField[],
  name: string,
): number | null {
  const value = fieldEntry(fields, name)?.value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function fieldBool(
  fields: readonly JsonField[],
  name: string,
): boolean | null {
  const value = fieldEntry(fields, name)?.value;
  return typeof value === "boolean" ? value : null;
}

/** The inner fields of a nested tuple field. */
export function nestedFields(
  fields: readonly JsonField[],
  name: string,
): JsonField[] | null {
  const inner = fieldEntry(fields, name)?.fields;
  return Array.isArray(inner) ? (inner as JsonField[]) : null;
}

/** The variant name of an enum field, such as a bond status. */
export function enumVariant(
  fields: readonly JsonField[],
  name: string,
): string | null {
  const variant = fieldEntry(fields, name)?.variant_name;
  return typeof variant === "string" ? variant : null;
}

/** The elements of an array field, such as a list of milestone amounts. */
export function fieldElements(
  fields: readonly JsonField[],
  name: string,
): unknown[] | null {
  const elements = fieldEntry(fields, name)?.elements;
  return Array.isArray(elements) ? elements : null;
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1_000);
}

/**
 * The protocol's live-time floor for a window of `seconds`: one epoch is expected every 300
 * seconds, and a window must also see 80 percent of its length in epochs before it may close.
 * A window shorter than 375 seconds therefore has no floor.
 */
export function minEpochsFor(seconds: number): number {
  return seconds <= 0 ? 0 : Math.floor(seconds / 375);
}

interface EntityDetailsAnswer {
  items?: Array<{
    address?: string;
    details?: {
      blueprint_name?: string | null;
      state?: { fields?: JsonField[] };
    };
  }>;
}

/** The state fields of one component. */
export async function readComponentState(
  gateway: Gateway,
  address: string,
): Promise<JsonField[]> {
  const answer = await gateway.post<EntityDetailsAnswer>("/state/entity/details", {
    addresses: [address],
  });
  const item = answer.items?.[0];
  if (item === undefined) {
    throw new GatewayError(`the gateway does not know component ${address}`);
  }
  return Array.isArray(item.details?.state?.fields)
    ? (item.details?.state?.fields as JsonField[])
    : [];
}

export async function readComponentField(
  gateway: Gateway,
  address: string,
  name: string,
): Promise<string | null> {
  return fieldString(await readComponentState(gateway, address), name);
}

interface KeyValueStoreDataAnswer {
  entries?: Array<{
    value?: { programmatic_json?: unknown };
  }>;
}

/**
 * The SBOR key hex of a u32 key-value-store key: the `5c` payload prefix, the `09` U32 value
 * kind, then the four little-endian bytes.
 */
export function u32KeyHex(value: number): string {
  let hex = "";
  let rest = value >>> 0;
  for (let index = 0; index < 4; index += 1) {
    hex += (rest & 0xff).toString(16).padStart(2, "0");
    rest >>>= 8;
  }
  return `5c09${hex}`;
}

/** The fields behind one key of a key-value store, or null for a missing key. */
export async function readKeyValueStoreFields(
  gateway: Gateway,
  store: string,
  keyHex: string,
): Promise<JsonField[] | null> {
  const answer = await gateway.post<KeyValueStoreDataAnswer>(
    "/state/key-value-store/data",
    {
      key_value_store_address: store,
      keys: [{ key_hex: keyHex }],
    },
  );
  const entry = answer.entries?.[0];
  if (entry?.value === undefined) return null;
  const fields = jsonFields(entry.value.programmatic_json);
  return fields.length === 0 ? null : fields;
}

/**
 * Space 0's seat-badge resource, read from the registry's own `spaces` key-value store.
 *
 * Space 0 is written by the registry's `new`, so its creation event is emitted by the package
 * and is not on the component's event stream. The state is the only place it can be read.
 */
export async function readSpaceZeroSeatResource(
  gateway: Gateway,
  registry: string,
): Promise<string | null> {
  const spaces = await readComponentField(gateway, registry, "spaces");
  if (spaces === null) return null;
  const fields = await readKeyValueStoreFields(gateway, spaces, u32KeyHex(0));
  return fields === null ? null : fieldString(fields, "seat_resource");
}

interface FungibleHolding {
  resource: string;
  amount: string;
}

interface EntityFungiblesAnswer {
  items?: Array<{
    fungible_resources?: {
      items?: Array<{
        resource_address?: string;
        amount?: string;
        vaults?: {
          items?: Array<{ amount?: string }>;
        };
      }>;
    };
  }>;
}

/**
 * The fungible balances of a global entity, one entry per resource and vault. The Gateway's
 * details endpoint answers a component's holdings aggregated by resource by default; a
 * distribution's remainder and a treasury's parked-refund vaults are both read this way.
 */
export async function readFungibleHoldings(
  gateway: Gateway,
  holder: string,
): Promise<FungibleHolding[]> {
  let answer: EntityFungiblesAnswer;
  try {
    answer = await gateway.post<EntityFungiblesAnswer>("/state/entity/details", {
      addresses: [holder],
    });
  } catch (error) {
    if (error instanceof GatewayError && error.status === 404) return [];
    throw error;
  }

  const holdings: FungibleHolding[] = [];
  for (const item of answer.items?.[0]?.fungible_resources?.items ?? []) {
    const resource = item.resource_address;
    if (typeof resource !== "string") continue;
    if (typeof item.amount === "string") {
      holdings.push({ resource, amount: item.amount });
      continue;
    }
    for (const vault of item.vaults?.items ?? []) {
      if (typeof vault.amount === "string") {
        holdings.push({ resource, amount: vault.amount });
      }
    }
  }
  return holdings;
}

interface NonFungiblePage {
  items?: Array<{
    resource_address?: string;
    vaults?: {
      items?: Array<{
        vault_address?: string;
        items?: unknown[];
        next_cursor?: string | null;
      }>;
    };
  }>;
  next_cursor?: string | null;
}

interface VaultIdPage {
  items?: unknown[];
  next_cursor?: string | null;
}

const MAX_PAGES = 20;

async function vaultIds(
  gateway: Gateway,
  account: string,
  resource: string,
  vault: string,
  firstCursor: string,
): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = firstCursor;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const answer: VaultIdPage = await gateway.post<VaultIdPage>(
      "/state/entity/page/non-fungible-vault/ids",
      {
        address: account,
        resource_address: resource,
        vault_address: vault,
        cursor,
      },
    );
    for (const id of answer.items ?? []) {
      if (typeof id === "string") ids.push(id);
    }
    const next: string | null | undefined = answer.next_cursor;
    if (next === undefined || next === null || next === "") return ids;
    if (next === cursor) {
      throw new GatewayError(`the gateway repeated a non-fungible cursor for ${vault}`);
    }
    cursor = next;
  }
  throw new GatewayError(`the gateway returned too many pages of ids for ${vault}`);
}

/**
 * The local ids of one non-fungible resource held by one account. The caller passes the
 * account it means to act for; no other account is read.
 */
export async function listAccountNonFungibles(
  gateway: Gateway,
  account: string,
  resource: string,
): Promise<string[]> {
  const ids = new Set<string>();
  let cursor: string | null = null;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const body: Record<string, unknown> = {
      address: account,
      aggregation_level: "Vault",
      opt_ins: { non_fungible_include_nfids: true },
    };
    if (cursor !== null) body.cursor = cursor;

    let answer: NonFungiblePage;
    try {
      answer = await gateway.post<NonFungiblePage>(
        "/state/entity/page/non-fungibles",
        body,
      );
    } catch (error) {
      // An account the ledger has never seen holds nothing.
      if (error instanceof GatewayError && error.status === 404) return [...ids];
      throw error;
    }

    for (const item of answer.items ?? []) {
      if (item.resource_address !== resource) continue;
      for (const vault of item.vaults?.items ?? []) {
        for (const id of vault.items ?? []) {
          if (typeof id === "string") ids.add(id);
        }
        if (
          typeof vault.vault_address === "string" &&
          typeof vault.next_cursor === "string" &&
          vault.next_cursor !== ""
        ) {
          for (const id of await vaultIds(
            gateway,
            account,
            resource,
            vault.vault_address,
            vault.next_cursor,
          )) {
            ids.add(id);
          }
        }
      }
    }

    const next = answer.next_cursor;
    if (next === undefined || next === null || next === "") return [...ids];
    if (next === cursor) {
      throw new GatewayError(
        `the gateway repeated a non-fungible page cursor for ${account}`,
      );
    }
    cursor = next;
  }

  throw new GatewayError(`the gateway returned too many non-fungible pages for ${account}`);
}

interface NonFungibleVaultPage {
  items?: Array<{ vault_address?: string }>;
}

/**
 * The internal address of the vault in which `holder` keeps `resource`, or null when it holds
 * no vault of it. An account keeps at most one vault per resource; a component holder may keep
 * more, and the first is returned. An entity the ledger has never seen holds nothing.
 */
export async function findNonFungibleVault(
  gateway: Gateway,
  holder: string,
  resource: string,
): Promise<string | null> {
  let answer: NonFungibleVaultPage;
  try {
    answer = await gateway.post<NonFungibleVaultPage>(
      "/state/entity/page/non-fungible-vaults",
      { address: holder, resource_address: resource },
    );
  } catch (error) {
    if (error instanceof GatewayError && error.status === 404) return null;
    throw error;
  }
  for (const item of answer.items ?? []) {
    const vault = item.vault_address;
    if (typeof vault === "string" && vault.startsWith("internal_vault_")) return vault;
  }
  return null;
}

interface NonFungibleDataAnswer {
  non_fungible_ids?: Array<{
    non_fungible_id?: string;
    data?: { programmatic_json?: unknown };
  }>;
}

/** The data fields of named non-fungible ids, keyed by id. A burned id has no entry. */
export async function readNonFungibleData(
  gateway: Gateway,
  resource: string,
  ids: readonly string[],
): Promise<Map<string, JsonField[]>> {
  const data = new Map<string, JsonField[]>();
  for (let offset = 0; offset < ids.length; offset += 20) {
    const chunk = ids.slice(offset, offset + 20);
    const answer = await gateway.post<NonFungibleDataAnswer>(
      "/state/non-fungible/data",
      { resource_address: resource, non_fungible_ids: chunk },
    );
    for (const item of answer.non_fungible_ids ?? []) {
      if (typeof item.non_fungible_id !== "string") continue;
      if (item.data === undefined) continue;
      data.set(item.non_fungible_id, jsonFields(item.data.programmatic_json));
    }
  }
  return data;
}
