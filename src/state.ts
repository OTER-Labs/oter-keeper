/**
 * The keeper's small local state file: one cursor per watched emitter and the daily fee
 * ledger. Losing a cursor only costs a longer first pass; losing the fee ledger would let a
 * keeper overspend, so a state file that cannot be read is an error rather than a fresh
 * start.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const DEFAULT_STATE_PATH = ".oter-keeper/state.json";

export class StateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateError";
  }
}

export interface MirrorRecord {
  /** A hash of the document body as it was served, so a new body is re-verified. */
  hash: string;
  /** The verifier's outcome kind: match, figures, serialization, unknown or malformed. */
  outcome: string;
  /** The UTC day the outcome was last reported, so a repeat is at most once a day. */
  day: string;
}

interface StateData {
  version: 1;
  cursors: Record<string, number>;
  /** Day (UTC, YYYY-MM-DD) to atto-XRD spent that day, as a decimal string. */
  fees: Record<string, string>;
  /** Day (UTC, YYYY-MM-DD) to disputes submitted that day. */
  disputes: Record<string, number>;
  /** The last verified document per official vote, keyed by `<kind>:<official_id>`. */
  mirrors: Record<string, MirrorRecord>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseData(text: string, path: string): StateData {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new StateError(
      `state file ${path} is not valid JSON; remove it to rebuild the cursor and fee ledger`,
    );
  }
  if (!isRecord(raw)) {
    throw new StateError(`state file ${path} does not contain an object`);
  }

  const cursors: Record<string, number> = {};
  if (isRecord(raw.cursors)) {
    for (const [emitter, value] of Object.entries(raw.cursors)) {
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
        throw new StateError(`state file ${path} has an invalid cursor for ${emitter}`);
      }
      cursors[emitter] = value;
    }
  }

  const fees: Record<string, string> = {};
  if (isRecord(raw.fees)) {
    for (const [day, value] of Object.entries(raw.fees)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || typeof value !== "string" || !/^\d+$/.test(value)) {
        throw new StateError(`state file ${path} has an invalid fee entry`);
      }
      fees[day] = value;
    }
  }

  const disputes: Record<string, number> = {};
  if (isRecord(raw.disputes)) {
    for (const [day, value] of Object.entries(raw.disputes)) {
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
        typeof value !== "number" ||
        !Number.isInteger(value) ||
        value < 0
      ) {
        throw new StateError(`state file ${path} has an invalid dispute entry`);
      }
      disputes[day] = value;
    }
  }

  const mirrors: Record<string, MirrorRecord> = {};
  if (isRecord(raw.mirrors)) {
    for (const [key, value] of Object.entries(raw.mirrors)) {
      if (!isRecord(value)) {
        throw new StateError(`state file ${path} has an invalid mirror entry for ${key}`);
      }
      const { hash, outcome, day } = value;
      if (
        typeof hash !== "string" ||
        hash === "" ||
        typeof outcome !== "string" ||
        outcome === "" ||
        typeof day !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(day)
      ) {
        throw new StateError(`state file ${path} has an invalid mirror entry for ${key}`);
      }
      mirrors[key] = { hash, outcome, day };
    }
  }

  return { version: 1, cursors, fees, disputes, mirrors };
}

export class StateFile {
  readonly path: string;
  private data: StateData;

  private constructor(path: string, data: StateData) {
    this.path = path;
    this.data = data;
  }

  static load(path: string = DEFAULT_STATE_PATH): StateFile {
    if (!existsSync(path)) {
      return new StateFile(path, {
        version: 1,
        cursors: {},
        fees: {},
        disputes: {},
        mirrors: {},
      });
    }
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "unknown error";
      throw new StateError(`cannot read state file ${path} (${code})`);
    }
    return new StateFile(path, parseData(text, path));
  }

  /** The next state version to read from this emitter, or null when it was never read. */
  cursor(emitter: string): number | null {
    return this.data.cursors[emitter] ?? null;
  }

  setCursor(emitter: string, stateVersion: number): void {
    if (!Number.isInteger(stateVersion) || stateVersion < 0) {
      throw new StateError(`refusing an invalid cursor ${stateVersion} for ${emitter}`);
    }
    this.data.cursors[emitter] = stateVersion;
    this.save();
  }

  /** Atto-XRD already recorded as spent on `day` (UTC, YYYY-MM-DD). */
  spent(day: string): bigint {
    return BigInt(this.data.fees[day] ?? "0");
  }

  addSpend(day: string, attos: bigint): void {
    if (attos < 0n) throw new StateError("a spend cannot be negative");
    this.data.fees[day] = (this.spent(day) + attos).toString();
    this.save();
  }

  /**
   * Raise the day's spend to at least `attos`, never lowering it. The start-up history read
   * uses this so the local ledger and the account's own history agree on the larger figure.
   */
  raiseSpend(day: string, attos: bigint): void {
    if (attos < 0n) throw new StateError("a spend cannot be negative");
    if (attos <= this.spent(day)) return;
    this.data.fees[day] = attos.toString();
    this.save();
  }

  /** Disputes submitted on `day` (UTC, YYYY-MM-DD). */
  disputesToday(day: string): number {
    return this.data.disputes[day] ?? 0;
  }

  /** Record one dispute as submitted. A bond posted outside this keeper is not counted. */
  addDispute(day: string): void {
    this.data.disputes[day] = this.disputesToday(day) + 1;
    this.save();
  }

  /** Raise the day's dispute count to at least `count`, never lowering it. */
  raiseDisputes(day: string, count: number): void {
    if (!Number.isInteger(count) || count < 0) {
      throw new StateError("a dispute count must be a non-negative integer");
    }
    if (count <= this.disputesToday(day)) return;
    this.data.disputes[day] = count;
    this.save();
  }

  /** The last verified document for one official vote, or null when it was never verified. */
  mirror(key: string): MirrorRecord | null {
    return this.data.mirrors[key] ?? null;
  }

  setMirror(key: string, record: MirrorRecord): void {
    this.data.mirrors[key] = record;
    this.save();
  }

  save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
    renameSync(temporary, this.path);
  }
}
