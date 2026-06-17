import type { ReasoningLogEntry } from "./types";

const DEFAULT_MAX_ENTRIES = 100;

export class ReasoningLogger {
  private readonly maxEntries: number;
  private readonly buffer: ReasoningLogEntry[];

  constructor(maxEntries: number = DEFAULT_MAX_ENTRIES) {
    this.maxEntries = maxEntries;
    this.buffer = [];
  }

  log(entry: ReasoningLogEntry): void {
    this.buffer.push(entry);
    if (this.buffer.length > this.maxEntries) {
      this.buffer.shift();
    }
  }

  getRecent(n?: number): ReasoningLogEntry[] {
    if (n === undefined) {
      return this.buffer.slice();
    }
    return this.buffer.slice(-n);
  }

  clear(): void {
    this.buffer.splice(0, this.buffer.length);
  }
}
