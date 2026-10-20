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

interface StateData {
  version: 1;
  cursors: Record<string, number>;
  /** Day (UTC, YYYY-MM-DD) to atto-XRD spent that day, as a decimal string. */
  fees: Record<string, string>;
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

  return { version: 1, cursors, fees };
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
      return new StateFile(path, { version: 1, cursors: {}, fees: {} });
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

  save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
    renameSync(temporary, this.path);
  }
}
