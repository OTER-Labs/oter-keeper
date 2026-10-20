/**
 * Read a component's own event stream from the Gateway.
 *
 * `event_global_emitters_filter` is the stream OTER's indexers read: it finds a transaction
 * whenever the watched component emitted, whichever account paid for it. Receipt events are
 * opted in, because the events are the point. Pages are walked in ascending state version so
 * a caller that stops early has still seen a prefix it can resume from.
 */

import type { Gateway } from "./gateway.ts";
import { GatewayError } from "./gateway.ts";

export interface LedgerEvent {
  state_version: number;
  intent_hash: string | null;
  confirmed_at: string | null;
  name: string;
  /** The global entity that emitted, when the Gateway names one. */
  emitter: string | null;
  /** The event's programmatic JSON (`{ fields: [...] }` on the v1 Gateway). */
  data: unknown;
  /** The raw receipt event, for fields this wrapper does not name. */
  raw: unknown;
}

interface StreamPage {
  items?: Array<{
    state_version?: number;
    intent_hash?: string;
    confirmed_at?: string;
    receipt?: {
      events?: unknown[];
    };
  }>;
  next_cursor?: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function eventEmitterAddress(emitter: unknown): string | null {
  if (!isRecord(emitter)) return null;
  if (isRecord(emitter.entity) && typeof emitter.entity.entity_address === "string") {
    return emitter.entity.entity_address;
  }
  if (typeof emitter.package_address === "string") return emitter.package_address;
  return null;
}

export async function* streamEvents(
  gateway: Gateway,
  emitter: string,
  fromStateVersion: number,
): AsyncIterable<LedgerEvent> {
  let cursor: string | null = null;
  const seenCursors = new Set<string>();

  for (;;) {
    const body: Record<string, unknown> = {
      event_global_emitters_filter: [emitter],
      order: "Asc",
      limit_per_page: 100,
      opt_ins: { receipt_events: true },
    };
    if (cursor === null) {
      // Ledger state versions start at 1; the Gateway answers an empty page for 0, which
      // would silently skip the beginning of a component's history.
      body.from_ledger_state = { state_version: Math.max(1, fromStateVersion) };
    } else {
      body.cursor = cursor;
    }

    const page = await gateway.post<StreamPage>("/stream/transactions", body);
    for (const item of page.items ?? []) {
      const stateVersion = item.state_version;
      if (typeof stateVersion !== "number" || stateVersion < fromStateVersion) continue;
      for (const raw of item.receipt?.events ?? []) {
        if (!isRecord(raw) || typeof raw.name !== "string") continue;
        yield {
          state_version: stateVersion,
          intent_hash: item.intent_hash ?? null,
          confirmed_at: item.confirmed_at ?? null,
          name: raw.name,
          emitter: eventEmitterAddress(raw.emitter),
          data: raw.data,
          raw,
        };
      }
    }

    const next = page.next_cursor;
    if (next === undefined || next === null || next === "") return;
    if (seenCursors.has(next)) {
      throw new GatewayError(`the event stream repeated cursor ${next}`);
    }
    seenCursors.add(next);
    cursor = next;
  }
}
