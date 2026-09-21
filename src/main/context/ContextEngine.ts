import { randomUUID } from "node:crypto";
import type {
  AttentionAnchor,
  ContextAccessState,
  ContextReference,
  ContextSnapshot,
  ContextSourceStatus,
  ContextSourceState,
  SurfaceType,
  WindowContext,
} from "../../shared/types";
import { ActiveWindowEngine } from "./ActiveWindow";
import { ScreenCapturer } from "./capture";
import { MacAccessibilitySource, type SemanticContextSource } from "./semantic";

const ACTIVE_POLL_MS = 500;
const MAX_CONTEXT_TEXT = 240;
const MAX_CONTEXT_URL = 512;

function classifySurface(appName: string, title: string, url: string | null): SurfaceType {
  const hay = `${appName} ${title} ${url ?? ""}`.toLowerCase();
  if (url?.includes("youtube.com") || ["youtube", "netflix", "plex", "spotify"].some((k) => hay.includes(k))) return "media_player";
  if (["gmail", "outlook", "mail", "thunderbird"].some((k) => hay.includes(k)) || url?.includes("mail.") || url?.includes("gmail")) return "email_or_message";
  if (url?.includes("maps") || hay.includes("maps")) return "maps_or_location";
  if (["shopping", "amazon", "ebay", "etsy", "zara", "airbnb"].some((k) => hay.includes(k))) return "shopping_or_product";
  if (["finder", "files", "explorer", "one drive", "onedrive", "dropbox"].some((k) => hay.includes(k))) return "file_or_editor";
  if (["word", "pages", "notion", "obsidian", "notes", "textedit", "sublime", "vscode", "visual studio"].some((k) => hay.includes(k))) return "file_or_editor";
  if (["tiktok", "instagram", "reels", "shorts", "feed"].some((k) => hay.includes(k))) return "vertical_feed";
  if (["calendar", "booking", "checkout", "form"].some((k) => hay.includes(k))) return "form_or_transaction";
  const known = [".txt", ".md", ".pdf", ".doc", ".rtf", "article", "read", "news", "wikipedia", "medium", "blog"].some((k) => hay.includes(k));
  if (known) return "document_or_article";
  if (["safari", "chrome", "firefox", "edge", "arc"].some((k) => hay.includes(k)) && url) return "search_or_results";
  return "generic_app";
}

export interface ContextEngineOptions {
  /** App names or bundle IDs that may be observed during a session. */
  allowedApps?: string[];
  /** Injectable seams keep context policy tests independent of desktop APIs. */
  windowEngine?: Pick<ActiveWindowEngine, "refresh">;
  capturer?: Pick<ScreenCapturer, "captureActiveWindow">;
  semanticSource?: SemanticContextSource;
  now?: () => number;
}

/**
 * Owns the local context snapshot and its access policy.
 *
 * Context is disabled until an agent session is summoned. An empty allowlist
 * approves only the app that was frontmost when the session started. A
 * configured allowlist can approve additional apps by name or bundle ID. The
 * user can approve the whole current session once, which follows app changes
 * without asking for another approval.
 */
export class ContextEngine {
  private windows: Pick<ActiveWindowEngine, "refresh">;
  private capturer: Pick<ScreenCapturer, "captureActiveWindow">;
  private readonly allowedApps: string[];
  private readonly clock: () => number;
  private snapshot: ContextSnapshot | null = null;
  private anchor: AttentionAnchor | null = null;
  private polling = false;
  private sessionEnabled = false;
  private paused = false;
  private sessionId: string | null = null;
  private revision = 0;
  private refreshRequestId = 0;
  private previousWindowKey: string | null = null;
  private approvedApps = new Set<string>();
  private sessionWideApproval = false;
  private listeners = new Set<(snapshot: ContextSnapshot) => void>();
  private captureInFlight: { sessionId: string; windowKey: string; promise: Promise<ContextSnapshot> } | null = null;
  private readonly semanticSource: SemanticContextSource;
  private semanticRequestId = 0;

  constructor(screenWidth: number, screenHeight: number, screenScale: number, options: ContextEngineOptions = {}) {
    this.windows = options.windowEngine ?? new ActiveWindowEngine(screenWidth, screenHeight, screenScale);
    this.capturer = options.capturer ?? new ScreenCapturer();
    this.semanticSource = options.semanticSource ?? new MacAccessibilitySource();
    this.allowedApps = (options.allowedApps ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean);
    this.clock = options.now ?? Date.now;
  }

  /** Startup does not inspect the desktop. A session must explicitly enable context. */
  async start(): Promise<void> {
    if (this.sessionEnabled && !this.paused) await this.refresh();
  }

  startPolling(): void {
    if (this.polling) return;
    this.polling = true;
    void this.executeLoop();
  }

  stopPolling(): void {
    this.polling = false;
  }

  onChange(listener: (snapshot: ContextSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async enableSession(): Promise<ContextSnapshot> {
    this.sessionEnabled = true;
    this.paused = false;
    this.sessionId = randomUUID();
    this.revision = 0;
    this.previousWindowKey = null;
    this.approvedApps.clear();
    this.sessionWideApproval = false;
    this.captureInFlight = null;
    this.snapshot = null;
    try {
      await this.refresh(true);
    } catch (error) {
      this.disableSession();
      throw error;
    }
    return this.snapshot ?? this.activeSnapshot(null, "active", false, this.clock());
  }

  disableSession(): ContextSnapshot {
    this.sessionEnabled = false;
    this.paused = false;
    this.sessionId = null;
    this.refreshRequestId += 1;
    this.semanticRequestId += 1;
    this.approvedApps.clear();
    this.sessionWideApproval = false;
    this.previousWindowKey = null;
    this.captureInFlight = null;
    this.anchor = null;
    this.revision += 1;
    this.snapshot = this.disabledSnapshot();
    this.emit(this.snapshot);
    return this.snapshot;
  }

  async togglePaused(): Promise<ContextSnapshot> {
    if (!this.sessionEnabled) return this.snapshot ?? this.disabledSnapshot();
    if (this.paused) {
      this.paused = false;
      await this.refresh();
      return this.snapshot ?? this.activeSnapshot(null, "active", false, this.clock());
    }
    this.paused = true;
    this.refreshRequestId += 1;
    this.semanticRequestId += 1;
    this.revision += 1;
    this.snapshot = this.snapshot ? this.pausedSnapshot(this.snapshot) : this.activeSnapshot(null, "paused", false, this.clock());
    this.emit(this.snapshot);
    return this.snapshot;
  }

  async approveSessionContext(): Promise<ContextSnapshot> {
    if (!this.sessionEnabled) return this.snapshot ?? this.disabledSnapshot();
    this.sessionWideApproval = true;
    this.paused = false;
    await this.refresh();
    return this.snapshot ?? this.activeSnapshot(null, "active", false, this.clock());
  }

  isSessionEnabled(): boolean {
    return this.sessionEnabled;
  }

  isPaused(): boolean {
    return this.paused;
  }

  private async executeLoop(): Promise<void> {
    while (this.polling) {
      await this.wait(ACTIVE_POLL_MS);
      if (!this.polling) return;
      if (!this.sessionEnabled || this.paused) continue;
      try {
        await this.refresh();
      } catch (error) {
        console.warn(`[context] ${JSON.stringify({ event: "refresh_failed", message: error instanceof Error ? error.message : String(error) })}`);
      }
    }
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async refresh(approveInitialApp = false): Promise<ContextSnapshot | null> {
    if (!this.sessionEnabled || this.paused) return this.snapshot;
    const refreshRequestId = ++this.refreshRequestId;
    const refreshSessionId = this.sessionId;
    const observedAt = this.clock();
    const window = await this.windows.refresh();
    // A desktop query can outlive a pause, exit, or a newly summoned session.
    // Never publish a result that belongs to the previous access decision.
    if (!this.sessionEnabled || this.paused || this.sessionId !== refreshSessionId || this.refreshRequestId !== refreshRequestId) return this.snapshot;
    if (!window) {
      const hadSnapshot = this.snapshot !== null;
      const changed = !hadSnapshot || this.previousWindowKey !== null || this.snapshot?.window !== null || this.snapshot?.access !== "active";
      this.previousWindowKey = null;
      if (changed) this.revision += 1;
      this.snapshot = this.activeSnapshot(null, "active", false, observedAt);
      if (changed) this.emit(this.snapshot);
      return this.snapshot;
    }

    const key = windowKey(window);
    if (approveInitialApp && this.allowedApps.length === 0) this.approvedApps.add(appKey(window));
    const approved = this.sessionWideApproval || this.isAllowed(window) || this.approvedApps.has(appKey(window));
    const access: ContextAccessState = approved ? "active" : "blocked";
    const contextScope = this.sessionWideApproval || (approved && this.allowedApps.length > 0) ? "session" : "app";
    const changed = key !== this.previousWindowKey
      || this.snapshot?.access !== access
      || this.snapshot?.approvedApp !== approved
      || this.snapshot?.contextScope !== contextScope;
    if (changed) this.revision += 1;
    this.previousWindowKey = key;
    const prior = this.snapshot;
    const sameWindow = prior?.window != null && windowKey(prior.window) === key;
    this.snapshot = {
      access,
      sessionId: this.sessionId,
      revision: this.revision,
      window,
      surfaceType: classifySurface(window.appName, window.windowTitle, window.url ?? null),
      attentionAnchor: this.anchor,
      capturedImageDataUrl: sameWindow ? prior.capturedImageDataUrl : null,
      capturedWidth: sameWindow ? prior.capturedWidth : 0,
      capturedHeight: sameWindow ? prior.capturedHeight : 0,
      capturedAt: sameWindow ? prior.capturedAt : null,
      activeAppDisplayName: window.appName,
      approvedApp: approved,
      contextScope,
      sources: sourceStatuses(window, access, sameWindow ? prior.capturedAt : null, observedAt),
      references: buildReferences(window, observedAt),
      focusedElement: null,
      selectedText: null,
      visibleText: null,
    };
    if (changed || !prior) {
      this.emit(this.snapshot);
      if (approved) this.scheduleSemanticRead(this.snapshot);
      // The initial session capture is requested by the controller after the
      // root view is published. Later app/window changes get one bounded
      // window capture so cards can refresh visual context without becoming a
      // continuous screen recorder.
      if (!approveInitialApp && approved) this.scheduleWindowCapture();
    }
    return this.snapshot;
  }

  setAttentionAnchor(anchor: AttentionAnchor): void {
    this.anchor = anchor;
    if (!this.snapshot || this.snapshot.access !== "active") return;
    const previous = this.snapshot.attentionAnchor;
    const changed = !previous
      || previous.screenXNorm !== anchor.screenXNorm
      || previous.screenYNorm !== anchor.screenYNorm
      || previous.windowXNorm !== anchor.windowXNorm
      || previous.windowYNorm !== anchor.windowYNorm
      || previous.insideActiveWindow !== anchor.insideActiveWindow;
    if (!changed) return;
    // The anchor is useful context for the next intentional transition, but it
    // is not a new object revision. Emit it without incrementing revision so a
    // card remains valid while the user's gaze moves across the approved app.
    this.snapshot = { ...this.snapshot, attentionAnchor: anchor };
    this.emit(this.snapshot);
  }

  async snapshotContext(withCapture: boolean): Promise<ContextSnapshot> {
    if (!this.sessionEnabled || this.paused) return this.snapshot ?? this.disabledSnapshot();
    if (!this.snapshot) await this.refresh();
    let snap = this.snapshot ?? this.activeSnapshot(null, "active", false, this.clock());
    if (!withCapture || snap.access !== "active" || !snap.window) return snap;

    // Context capture is deliberately window-scoped. The executor has a
    // separate primary-display capture path for computer-use screenshots.
    const captureSessionId = this.sessionId;
    const captureWindowKey = windowKey(snap.window);
    if (!captureSessionId) return snap;
    const existing = this.captureInFlight;
    if (existing && existing.sessionId === captureSessionId && existing.windowKey === captureWindowKey) return existing.promise;
    const promise = this.captureWindowSnapshot(snap, captureSessionId, captureWindowKey);
    this.captureInFlight = { sessionId: captureSessionId, windowKey: captureWindowKey, promise };
    void promise.then(
      () => { if (this.captureInFlight?.promise === promise) this.captureInFlight = null; },
      () => { if (this.captureInFlight?.promise === promise) this.captureInFlight = null; },
    );
    return promise;
  }

  private async captureWindowSnapshot(snap: ContextSnapshot, captureSessionId: string | null, captureWindowKey: string): Promise<ContextSnapshot> {
    if (!captureSessionId || !snap.window) return snap;
    let frame: Awaited<ReturnType<ScreenCapturer["captureActiveWindow"]>> = null;
    let captureError: string | undefined;
    try {
      frame = await this.capturer.captureActiveWindow(snap.window, 512);
    } catch (error) {
      captureError = error instanceof Error ? error.message : String(error);
    }
    if (!this.sessionEnabled || this.paused || this.sessionId !== captureSessionId || this.previousWindowKey !== captureWindowKey) {
      return this.snapshot ?? this.disabledSnapshot();
    }
    const capturedAt = this.clock();
    if (frame) {
      this.revision += 1;
      snap = {
        ...snap,
        revision: this.revision,
        capturedImageDataUrl: frame.dataUrl,
        capturedWidth: frame.width,
        capturedHeight: frame.height,
        capturedAt,
        sources: sourceStatuses(snap.window, snap.access, capturedAt, capturedAt),
      };
    } else {
      snap = {
        ...snap,
        capturedImageDataUrl: null,
        capturedWidth: 0,
        capturedHeight: 0,
        capturedAt: null,
        sources: sourceStatuses(snap.window, snap.access, null, capturedAt, captureError
          ? `Window screenshot failed: ${captureError}`
          : "Window screenshot unavailable; no broader display capture was attempted."),
      };
    }
    this.snapshot = snap;
    this.emit(snap);
    if (snap.access === "active") this.scheduleSemanticRead(snap);
    return snap;
  }

  private scheduleSemanticRead(snapshot: ContextSnapshot): void {
    if (!snapshot.window || snapshot.access !== "active" || !this.sessionId) return;
    const requestId = ++this.semanticRequestId;
    const sessionId = this.sessionId;
    const key = windowKey(snapshot.window);
    void this.semanticSource.read(snapshot.window).then((observation) => {
      if (!this.sessionEnabled || this.paused || this.sessionId !== sessionId || this.previousWindowKey !== key || requestId !== this.semanticRequestId || !this.snapshot) return;
      this.revision += 1;
      const accessibilityAvailable = Boolean(observation.focusedElement || observation.selectedText || observation.visibleText);
      const sources = this.snapshot.sources.map((source) => source.kind === "accessibility"
        ? { ...source, state: accessibilityAvailable ? "available" as const : "unavailable" as const, observedAt: accessibilityAvailable ? this.clock() : null, detail: accessibilityAvailable ? "Focused element/value from macOS Accessibility." : "The active app did not expose a focused element or value." }
        : source);
      const references = observation.focusedElement
        ? [...this.snapshot.references.filter((reference) => reference.id !== observation.focusedElement?.id), observation.focusedElement].slice(-8)
        : this.snapshot.references;
      this.snapshot = { ...this.snapshot, revision: this.revision, references, focusedElement: observation.focusedElement, selectedText: observation.selectedText, visibleText: observation.visibleText, sources };
      this.emit(this.snapshot);
    }).catch((error) => {
      if (!this.snapshot || this.sessionId !== sessionId || this.previousWindowKey !== key) return;
      const sources = this.snapshot.sources.map((source) => source.kind === "accessibility" ? { ...source, state: "unavailable" as const, detail: `Accessibility query failed: ${error instanceof Error ? error.message : String(error)}` } : source);
      this.snapshot = { ...this.snapshot, sources };
      this.emit(this.snapshot);
    });
  }

  private scheduleWindowCapture(): void {
    const snapshot = this.snapshot;
    const sessionId = this.sessionId;
    const window = snapshot?.window;
    if (!snapshot || snapshot.access !== "active" || !sessionId || !window) return;
    const key = windowKey(window);
    if (this.captureInFlight?.sessionId === sessionId && this.captureInFlight.windowKey === key) return;
    void this.snapshotContext(true).catch((error) => {
      console.warn(`[context] ${JSON.stringify({ event: "capture_failed", message: error instanceof Error ? error.message : String(error) })}`);
    });
  }

  current(): ContextSnapshot | null {
    return this.snapshot;
  }

  get activeAppPretty(): string {
    return this.snapshot?.access === "disabled" ? "None" : this.snapshot?.window?.appName ?? "None";
  }

  private isAllowed(window: WindowContext): boolean {
    if (this.allowedApps.length === 0) return false;
    if (this.allowedApps.includes("*")) return true;
    const appName = window.appName.trim().toLowerCase();
    const bundleId = window.bundleId?.trim().toLowerCase() ?? "";
    return this.allowedApps.includes(appName) || (bundleId.length > 0 && this.allowedApps.includes(bundleId));
  }

  private activeSnapshot(window: WindowContext | null, access: ContextAccessState, approvedApp: boolean, observedAt: number): ContextSnapshot {
    return {
      access,
      sessionId: this.sessionId,
      revision: this.revision,
      window,
      surfaceType: window ? classifySurface(window.appName, window.windowTitle, window.url ?? null) : "unknown",
      attentionAnchor: this.anchor,
      capturedImageDataUrl: null,
      capturedWidth: 0,
      capturedHeight: 0,
      capturedAt: null,
      activeAppDisplayName: window?.appName ?? "None",
      approvedApp,
      contextScope: this.sessionWideApproval || (approvedApp && this.allowedApps.length > 0) ? "session" : "app",
      sources: sourceStatuses(window, access, null, observedAt),
      references: window ? buildReferences(window, observedAt) : [],
      focusedElement: null,
      selectedText: null,
      visibleText: null,
    };
  }

  private pausedSnapshot(snapshot: ContextSnapshot): ContextSnapshot {
    return {
      ...snapshot,
      access: "paused",
      capturedImageDataUrl: null,
      capturedWidth: 0,
      capturedHeight: 0,
      capturedAt: null,
      revision: this.revision,
      sources: snapshot.sources.map((source) => ({ ...source, state: "paused", observedAt: null })),
    };
  }

  private disabledSnapshot(): ContextSnapshot {
    return {
      access: "disabled",
      sessionId: null,
      revision: this.revision,
      window: null,
      surfaceType: "unknown",
      attentionAnchor: null,
      capturedImageDataUrl: null,
      capturedWidth: 0,
      capturedHeight: 0,
      capturedAt: null,
      activeAppDisplayName: "None",
      approvedApp: false,
      contextScope: "app",
      sources: sourceStatuses(null, "disabled", null, null, "Context is disabled outside an active agent session."),
      references: [],
      focusedElement: null,
      selectedText: null,
      visibleText: null,
    };
  }

  private emit(snapshot: ContextSnapshot): void {
    for (const listener of this.listeners) listener(snapshot);
  }
}

function appKey(window: WindowContext): string {
  const app = (window.bundleId ?? window.appName).trim().toLowerCase();
  return app;
}

function windowKey(window: WindowContext): string {
  const bounds = window.bounds;
  return `${appKey(window)}|${window.windowId}|${window.windowTitle.trim().toLowerCase()}|${url(window.url ?? "")}|${bounds.x},${bounds.y},${bounds.width},${bounds.height}`;
}

function text(value: string, max = MAX_CONTEXT_TEXT): string {
  return value.trim().slice(0, max);
}

function url(value: string): string {
  return value.trim().slice(0, MAX_CONTEXT_URL);
}

function buildReferences(window: WindowContext, observedAt: number): ContextReference[] {
  const references: ContextReference[] = [{
    id: `window:${windowKey(window)}`,
    kind: "window",
    label: text(window.windowTitle || window.appName),
    appName: text(window.appName),
    source: "active_window",
    observedAt,
    bounds: window.bounds,
  }];
  if (window.url?.trim()) {
    references.push({
      id: `document:${url(window.url)}`,
      kind: "document",
      label: text(window.windowTitle || window.url),
      appName: text(window.appName),
      source: "browser",
      observedAt,
      url: url(window.url),
    });
  }
  return references;
}

function sourceStatuses(
  window: WindowContext | null,
  access: ContextAccessState,
  capturedAt: number | null,
  observedAt: number | null,
  screenshotDetail?: string,
): ContextSourceStatus[] {
  if (access === "disabled") {
    return [
      { kind: "active_window", state: "not_requested", observedAt: null },
      { kind: "accessibility", state: "not_requested", observedAt: null },
      { kind: "browser", state: "not_requested", observedAt: null },
      { kind: "screenshot", state: "not_requested", observedAt: null },
      { kind: "task", state: "not_requested", observedAt: null },
    ];
  }
  if (access === "paused") {
    const kinds: ContextSourceStatus["kind"][] = ["active_window", "accessibility", "browser", "screenshot", "task"];
    return kinds.map((kind) => ({
      kind,
      state: "paused" as ContextSourceState,
      observedAt: null,
    }));
  }
  return [
    {
      kind: "active_window",
      state: window ? "available" : "unavailable",
      observedAt,
      detail: window ? "Frontmost app and window metadata." : "No frontmost app/window metadata was returned.",
    },
    {
      kind: "accessibility",
      state: "not_requested",
      observedAt: null,
      detail: "One bounded focused-element query runs after an approved window change.",
    },
    {
      kind: "browser",
      state: window?.url ? "available" : "not_requested",
      observedAt: window?.url ? observedAt : null,
      detail: window?.url ? "URL/title metadata only; DOM content is not connected yet." : "The active-window provider did not expose a browser URL.",
    },
    {
      kind: "screenshot",
      state: capturedAt !== null ? "available" : screenshotDetail ? "unavailable" : "not_requested",
      observedAt: capturedAt,
      detail: screenshotDetail ?? (capturedAt !== null ? "Window-scoped screenshot." : "Capture has not been requested."),
    },
    {
      kind: "task",
      state: "not_requested",
      observedAt: null,
      detail: "The current task and accepted evidence are added by prompt completion.",
    },
  ];
}
