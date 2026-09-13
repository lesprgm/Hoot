import type { AttentionAnchor, ContextSnapshot, SurfaceType } from "../../shared/types";
import { ActiveWindowEngine } from "./ActiveWindow";
import { ScreenCapturer } from "./capture";

const ACTIVE_POLL_MS = 500;

function classifySurface(appName: string, title: string, url: string | null): SurfaceType {
  const hay = `${appName} ${title} ${url ?? ""}`.toLowerCase();
  if (url?.includes("youtube.com") || ["youtube", "netflix", "plex", "spotify"].some((k) => hay.includes(k))) return "media_player";
  if (["gmail", "outlook", "mail", "thunderbird"].some((k) => hay.includes(k)) || url?.includes("mail.") || url?.includes("gmail")) return "email_or_message";
  if (url?.includes("maps") || hay.includes("maps")) return "maps_or_location";
  if (["shopping", "amazon", "ebay", "etsy", "zara", "airbnb"].some((k) => hay.includes(k))) return "shopping_or_product";
  if (["finder", "files", "explorer", "one drive", "onedrive", "dropbox"].some((k) => hay.includes(k))) return "file_or_editor";
  if (["word", "pages", "notion", "obsidian", "notes", "textedit", "sublime", "vscode", "visual studio"].some((k) => hay.includes(k))) return "file_or_editor";
  if (["tiktok", "instagram", "reels", "shorts", "feed"].some((k) => hay.includes(k))) return "vertical_feed";
  if (["calendar", "booking", "checkout", "checkout", "form"].some((k) => hay.includes(k))) return "form_or_transaction";
  const known = [".txt", ".md", ".pdf", ".doc", ".rtf", "article", "read", "news", "wikipedia", "medium", "blog"].some((k) => hay.includes(k));
  if (known) return "document_or_article";
  if (["safari", "chrome", "firefox", "edge", "arc"].some((k) => hay.includes(k)) && url) return "search_or_results";
  return "generic_app";
}

export class ContextEngine {
  private windows: ActiveWindowEngine;
  private capturer = new ScreenCapturer();
  private snapshot: ContextSnapshot | null = null;
  private anchor: AttentionAnchor | null = null;
  private polling = false;

  constructor(screenWidth: number, screenHeight: number, screenScale: number) {
    this.windows = new ActiveWindowEngine(screenWidth, screenHeight, screenScale);
  }

  async start(): Promise<void> {
    await this.refresh();
  }

  startPolling(): void {
    if (this.polling) return;
    this.polling = true;
    void this.executeLoop();
  }

  stopPolling(): void {
    this.polling = false;
  }

  private async executeLoop(): Promise<void> {
    while (this.polling) {
      await this.wait(ACTIVE_POLL_MS);
      if (!this.polling) return;
      try {
        await this.refresh();
      } catch {
        // Context is advisory. A transient desktop API failure must not
        // reject the background loop or interrupt calibration/live gaze.
      }
    }
  }

  private wait(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  async refresh(): Promise<void> {
    const window = await this.windows.refresh();
    if (!window) return;
    const surfaceType = classifySurface(window.appName, window.windowTitle, window.url ?? null);
    this.snapshot = {
      window,
      surfaceType,
      attentionAnchor: this.anchor,
      capturedImageDataUrl: null,
      capturedWidth: 0,
      capturedHeight: 0,
      capturedAt: null,
      activeAppDisplayName: window.appName,
    };
  }

  setAttentionAnchor(anchor: AttentionAnchor): void {
    this.anchor = anchor;
    if (this.snapshot) this.snapshot.attentionAnchor = anchor;
  }

  async snapshotContext(withCapture: boolean): Promise<ContextSnapshot> {
    // Polling already keeps this metadata current. Reusing it avoids another
    // active-window query on the summon critical path and prevents the overlay
    // itself from replacing the app that the user was viewing.
    if (!this.snapshot) await this.refresh();
    let snap = this.snapshot;
    if (!snap) {
      snap = {
        window: null,
        surfaceType: "unknown",
        attentionAnchor: this.anchor,
        capturedImageDataUrl: null,
        capturedWidth: 0,
        capturedHeight: 0,
        capturedAt: null,
        activeAppDisplayName: "None",
      };
      this.snapshot = snap;
    }
    if (withCapture) {
      const frame = snap.window
        ? await this.capturer.captureActiveWindow(snap.window, 512)
        : await this.capturer.capturePrimary(512);
      if (frame) {
        snap = { ...snap, capturedImageDataUrl: frame.dataUrl, capturedWidth: frame.width, capturedHeight: frame.height, capturedAt: Date.now() };
        this.snapshot = snap;
      }
    }
    return snap;
  }

  current(): ContextSnapshot | null {
    return this.snapshot;
  }

  get activeAppPretty(): string {
    return this.snapshot?.window?.appName ?? "None";
  }
}
