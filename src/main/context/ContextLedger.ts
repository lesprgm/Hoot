import type { ContextReference, ContextSnapshot } from "../../shared/types";
import type { EvidenceSource } from "../../shared/intent";

export interface ContextLedgerEntry {
  id: string;
  source: Extract<EvidenceSource, "foreground_context" | "recent_context" | "background_context">;
  kind: ContextReference["kind"] | "app" | "text";
  label: string;
  appName: string | null;
  url?: string;
  text?: string;
  referenceId?: string;
  observedAt: number;
  revision: number;
}

export interface ContextLedgerDigest {
  sessionId: string | null;
  revision: number;
  active: boolean;
  /** The ledger is open-world: this list is evidence, never an allowlist. */
  observations: ContextLedgerEntry[];
}

/**
 * Stores a small, session-scoped history of weak context observations.
 * ContextEngine controls permission and capture; this class only normalizes
 * observations for decoder input and never claims that absent data is false.
 */
export class ContextLedger {
  private entries: ContextLedgerEntry[] = [];
  private sessionId: string | null = null;
  private revision = 0;
  private active = false;

  constructor(private readonly maxEntries = 24) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new Error("ContextLedger maxEntries must be positive");
  }

  enable(sessionId: string | null): void {
    this.sessionId = sessionId;
    this.entries = [];
    this.revision = 0;
    this.active = true;
  }

  disable(): void {
    this.sessionId = null;
    this.entries = [];
    this.revision += 1;
    this.active = false;
  }

  pause(): void {
    this.active = false;
  }

  resume(sessionId = this.sessionId): void {
    this.sessionId = sessionId;
    this.active = true;
  }

  record(snapshot: ContextSnapshot | null): ContextLedgerDigest {
    if (!this.active || !snapshot || snapshot.access !== "active") return this.digest();
    this.sessionId = snapshot.sessionId;
    this.revision = Math.max(this.revision, snapshot.revision);
    const observedAt = Date.now();
    const next: ContextLedgerEntry[] = [];
    if (snapshot.window) {
      next.push({
        id: `app:${snapshot.window.bundleId ?? snapshot.window.appName}`,
        source: "foreground_context",
        kind: "app",
        label: snapshot.window.windowTitle || snapshot.window.appName,
        appName: snapshot.window.appName,
        url: snapshot.window.url,
        observedAt,
        revision: snapshot.revision,
      });
    }
    for (const reference of snapshot.references) next.push(referenceEntry(reference, snapshot.revision));
    if (snapshot.focusedElement) next.push(referenceEntry(snapshot.focusedElement, snapshot.revision));
    if (snapshot.selectedText) next.push({
      id: `selected:${snapshot.revision}`,
      source: "foreground_context",
      kind: "text",
      label: snapshot.selectedText.slice(0, 240),
      appName: snapshot.window?.appName ?? null,
      text: snapshot.selectedText.slice(0, 2000),
      observedAt,
      revision: snapshot.revision,
    });
    if (snapshot.visibleText) next.push({
      id: `visible:${snapshot.revision}`,
      source: "foreground_context",
      kind: "text",
      label: snapshot.visibleText.slice(0, 240),
      appName: snapshot.window?.appName ?? null,
      text: snapshot.visibleText.slice(0, 2000),
      observedAt,
      revision: snapshot.revision,
    });
    for (const entry of next) this.upsert(entry);
    return this.digest();
  }

  addObservation(entry: Omit<ContextLedgerEntry, "revision"> & { revision?: number }): void {
    if (!this.active) return;
    this.upsert({ ...entry, revision: entry.revision ?? this.revision });
  }

  digest(): ContextLedgerDigest {
    return {
      sessionId: this.sessionId,
      revision: this.revision,
      active: this.active,
      observations: this.entries.map((entry) => ({ ...entry })),
    };
  }

  references(): ContextLedgerEntry[] {
    return this.entries.map((entry) => ({ ...entry }));
  }

  clear(): void {
    this.entries = [];
  }

  private upsert(entry: ContextLedgerEntry): void {
    const existing = this.entries.findIndex((candidate) => candidate.id === entry.id);
    if (existing >= 0) this.entries.splice(existing, 1);
    this.entries.push({ ...entry, label: entry.label.trim().slice(0, 240) });
    if (this.entries.length > this.maxEntries) this.entries.splice(0, this.entries.length - this.maxEntries);
  }
}

function referenceEntry(reference: ContextReference, revision: number): ContextLedgerEntry {
  return {
    id: reference.id,
    source: reference.source === "active_window" || reference.source === "accessibility" || reference.source === "browser" ? "foreground_context" : "recent_context",
    kind: reference.kind,
    label: reference.label,
    appName: reference.appName,
    url: reference.url,
    text: reference.text,
    referenceId: reference.id,
    observedAt: reference.observedAt,
    revision,
  };
}
