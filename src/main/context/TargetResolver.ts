import type { ContextSnapshot, UserLexicon } from "../../shared/types";
import type { ContextLedgerEntry } from "./ContextLedger";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export type ResolvedTargetKind = "app" | "file" | "contact" | "directory" | "bookmark" | "url" | "reference" | "unknown";

export interface ResolvedTarget {
  entityId: string;
  kind: ResolvedTargetKind;
  value: string;
  display: string;
  source: "installed_app" | "recent_file" | "contact" | "directory" | "bookmark" | "context" | "open_world";
  referenceId?: string;
}

export interface TargetResolverOptions {
  installedApps?: Array<{ name: string; bundleId?: string }>;
  recentFiles?: Array<{ path: string; label?: string }>;
  contacts?: Array<{ name: string; id?: string }>;
  directories?: Array<{ path: string; label?: string }>;
  bookmarks?: Array<{ title: string; url: string }>;
  /** Disable local discovery only for isolated tests or a restricted host. */
  autoDiscover?: boolean;
  /** Injectable roots keep discovery deterministic in tests. */
  appDirectories?: string[];
  recentDirectories?: string[];
  maxRecentFiles?: number;
}

/**
 * Resolves a named target against local vocabulary and current context on demand.
 * The resolver is open-world: an empty result means "not observed", never
 * "does not exist".
 */
export class TargetResolver {
  private readonly options: TargetResolverOptions;
  private warmupPromise: Promise<void> | null = null;

  constructor(options: TargetResolverOptions = {}) {
    this.options = {
      ...options,
      installedApps: [...(options.installedApps ?? [])],
      recentFiles: [...(options.recentFiles ?? [])],
      contacts: [...(options.contacts ?? [])],
      directories: [...(options.directories ?? [])],
      bookmarks: [...(options.bookmarks ?? [])],
    };
  }

  /** Warm local indexes without putting filesystem work on a gaze selection. */
  async warmup(): Promise<void> {
    if (this.warmupPromise) return this.warmupPromise;
    this.warmupPromise = this.discoverLocalTargets();
    await this.warmupPromise;
  }

  resolve(query: string, context?: ContextSnapshot | null, ledger: ContextLedgerEntry[] = [], lexicon?: UserLexicon): ResolvedTarget[] {
    const normalized = normalize(query);
    if (!normalized) return [];
    const results: ResolvedTarget[] = [];
    const add = (target: ResolvedTarget) => {
      if (!results.some((candidate) => candidate.entityId === target.entityId)) results.push(target);
    };

    for (const app of this.options.installedApps ?? []) {
      if (matches(normalized, app.name)) add({ entityId: app.bundleId ?? `app:${normalize(app.name)}`, kind: "app", value: app.name, display: app.name, source: "installed_app" });
    }
    for (const app of lexicon?.apps ?? []) {
      if (matches(normalized, app)) add({ entityId: `app:${normalize(app)}`, kind: "app", value: app, display: app, source: "installed_app" });
    }
    for (const file of this.options.recentFiles ?? []) {
      if (matches(normalized, file.label ?? file.path)) add({ entityId: `file:${file.path}`, kind: "file", value: file.path, display: file.label ?? file.path, source: "recent_file" });
    }
    for (const contact of this.options.contacts ?? []) {
      if (matches(normalized, contact.name)) add({ entityId: contact.id ?? `contact:${normalize(contact.name)}`, kind: "contact", value: contact.name, display: contact.name, source: "contact" });
    }
    for (const contact of lexicon?.people ?? []) {
      if (matches(normalized, contact)) add({ entityId: `contact:${normalize(contact)}`, kind: "contact", value: contact, display: contact, source: "contact" });
    }
    for (const directory of this.options.directories ?? []) {
      if (matches(normalized, directory.label ?? directory.path)) add({ entityId: `directory:${directory.path}`, kind: "directory", value: directory.path, display: directory.label ?? directory.path, source: "directory" });
    }
    for (const bookmark of this.options.bookmarks ?? []) {
      if (matches(normalized, bookmark.title) || normalize(bookmark.url).includes(normalized)) add({ entityId: `bookmark:${bookmark.url}`, kind: "bookmark", value: bookmark.url, display: bookmark.title, source: "bookmark" });
    }
    for (const entry of ledger) {
      if (matches(normalized, entry.label) || (entry.url ? normalize(entry.url).includes(normalized) : false)) add({
        entityId: entry.referenceId ?? entry.id,
        kind: mapKind(entry.kind),
        value: entry.url ?? entry.label,
        display: entry.label,
        source: "context",
        referenceId: entry.referenceId ?? entry.id,
      });
    }
    if (context?.window && (matches(normalized, context.window.appName) || matches(normalized, context.window.windowTitle))) {
      add({
        entityId: `window:${context.window.bundleId ?? context.window.appName}`,
        kind: "reference",
        value: context.window.url ?? context.window.windowTitle,
        display: context.window.windowTitle || context.window.appName,
        source: "context",
      });
    }
    // URLs are valid open-world targets even when no local index contains them.
    if (/^https?:\/\//i.test(query.trim())) add({ entityId: `url:${query.trim()}`, kind: "url", value: query.trim(), display: query.trim(), source: "open_world" });
    return results;
  }

  resolveOne(query: string, context?: ContextSnapshot | null, ledger: ContextLedgerEntry[] = [], lexicon?: UserLexicon): ResolvedTarget | null {
    return this.resolve(query, context, ledger, lexicon)[0] ?? null;
  }

  private async discoverLocalTargets(): Promise<void> {
    if (this.options.autoDiscover === false) return;
    const hasInjectedRoots = Boolean(this.options.appDirectories || this.options.recentDirectories);
    if (process.platform !== "darwin" && !hasInjectedRoots) return;
    const appDirectories = this.options.appDirectories ?? [
      "/Applications",
      "/System/Applications",
      join(homedir(), "Applications"),
    ];
    const recentDirectories = this.options.recentDirectories ?? [
      join(homedir(), "Desktop"),
      join(homedir(), "Documents"),
      join(homedir(), "Downloads"),
    ];
    const [apps, files] = await Promise.all([
      discoverApplications(appDirectories),
      discoverRecentFiles(recentDirectories, this.options.maxRecentFiles ?? 64),
    ]);
    this.options.installedApps = mergeByKey(this.options.installedApps ?? [], apps, (item) => normalize(item.name));
    this.options.recentFiles = mergeByKey(this.options.recentFiles ?? [], files, (item) => item.path);
    const directories = recentDirectories.map((path) => ({ path, label: basename(path) })).filter((item) => item.label);
    this.options.directories = mergeByKey(this.options.directories ?? [], directories, (item) => item.path);
  }
}

async function discoverApplications(directories: string[]): Promise<Array<{ name: string; bundleId?: string }>> {
  const discovered: Array<{ name: string; bundleId?: string }> = [];
  for (const directory of directories) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || !entry.name.endsWith(".app")) continue;
      const name = entry.name.slice(0, -4).trim();
      if (name) discovered.push({ name });
    }
  }
  return discovered;
}

async function discoverRecentFiles(directories: string[], maxFiles: number): Promise<Array<{ path: string; label?: string }>> {
  const files: Array<{ path: string; label: string; modifiedAt: number }> = [];
  for (const directory of directories) await collectFiles(directory, 1, files);
  files.sort((a, b) => b.modifiedAt - a.modifiedAt);
  return files.slice(0, Math.max(1, maxFiles)).map(({ path, label }) => ({ path, label }));
}

async function collectFiles(directory: string, depth: number, output: Array<{ path: string; label: string; modifiedAt: number }>): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory() && depth > 0) {
      await collectFiles(path, depth - 1, output);
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      const details = await stat(path);
      output.push({ path, label: entry.name, modifiedAt: details.mtimeMs });
    } catch {
      // A file can disappear between directory enumeration and stat.
    }
  }
}

function mergeByKey<T>(existing: T[], discovered: T[], key: (value: T) => string): T[] {
  const result = [...existing];
  const keys = new Set(existing.map(key));
  for (const value of discovered) {
    const normalized = key(value);
    if (keys.has(normalized)) continue;
    keys.add(normalized);
    result.push(value);
  }
  return result;
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function matches(query: string, candidate: string): boolean {
  const normalized = normalize(candidate);
  return normalized === query || normalized.includes(query) || query.includes(normalized);
}

function mapKind(kind: ContextLedgerEntry["kind"]): ResolvedTargetKind {
  if (kind === "app") return "app";
  if (kind === "document") return "file";
  if (kind === "control" || kind === "selection" || kind === "window") return "reference";
  return "unknown";
}
