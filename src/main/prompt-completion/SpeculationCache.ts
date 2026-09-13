import { createHash } from "node:crypto";
import type { DecoderResponseShape } from "./decoderSchema";
import type { DisplayOption } from "../../shared/types";

export interface SpeculativeState {
  response: DecoderResponseShape;
  display: DisplayOption[];
  createdAt: number;
  forKey: string;
}

const TTL_MS = 20_000;

export class SpeculationCache {
  private entries = new Map<string, SpeculativeState>();

  constructor(readonly enabled: boolean = true) {}

  static key(parts: Array<string | number>): string {
    return createHash("sha256").update(parts.join("|")).digest("hex");
  }

  invalidateIf(part: string): void {
    for (const [key] of this.entries) {
      if (key.includes(part)) this.entries.delete(key);
    }
  }

  invalidateAll(): void {
    this.entries.clear();
  }

  set(scope: string, slot: string, state: SpeculativeState): void {
    if (!this.enabled) return;
    this.entries.set(`${scope}::${slot}`, state);
  }

  take(scope: string, slot: string): SpeculativeState | null {
    if (!this.enabled) return null;
    const key = `${scope}::${slot}`;
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (Date.now() - entry.createdAt > TTL_MS) {
      this.entries.delete(key);
      return null;
    }
    this.entries.delete(key);
    return entry;
  }

  has(scope: string, slot: string): boolean {
    const entry = this.entries.get(`${scope}::${slot}`);
    return entry !== undefined && Date.now() - entry.createdAt <= TTL_MS;
  }

  get size(): number {
    return this.entries.size;
  }
}