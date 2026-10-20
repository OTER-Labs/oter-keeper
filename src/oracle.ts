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
