import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Logger } from "../src/tx.ts";

export function tempDir(prefix = "oter-keeper-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function writeTempFile(name: string, contents: string): string {
  const path = join(tempDir(), name);
  writeFileSync(path, contents, "utf8");
  return path;
}

export class MemoryLogger implements Logger {
  readonly infoMessages: string[] = [];
  readonly warnMessages: string[] = [];
  readonly errorMessages: string[] = [];

  info(message: string): void {
    this.infoMessages.push(message);
  }

  warn(message: string): void {
    this.warnMessages.push(message);
  }

  error(message: string): void {
    this.errorMessages.push(message);
  }

  get all(): string[] {
    return [...this.infoMessages, ...this.warnMessages, ...this.errorMessages];
  }
}
