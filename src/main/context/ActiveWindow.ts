import type { WindowContext } from "../../shared/types";
import { execFileSync } from "node:child_process";

interface ActiveWindowResult {
  appName: string;
  bundleId?: string;
  windowTitle: string;
  url?: string;
  windowId: number;
  bounds: { x: number; y: number; width: number; height: number };
}

export interface ActiveWindowSource {
  readonly name: string;
  getActive(): Promise<ActiveWindowResult | null>;
}

class GetWindowsSource implements ActiveWindowSource {
  readonly name = "get-windows";
  private mod: { activeWindow: () => Promise<unknown> } | null = null;

  private async loaded(): Promise<boolean> {
    if (this.mod) return true;
    try {
      const m = await import("get-windows");
      this.mod = m as unknown as { activeWindow: () => Promise<unknown> };
      return true;
    } catch {
      return false;
    }
  }

  async getActive(): Promise<ActiveWindowResult | null> {
    if (!(await this.loaded())) return null;
    try {
      const win = await (this.mod!.activeWindow as () => Promise<{
        app?: { name?: string; processId?: string; bundleId?: string };
        title?: string;
        url?: string;
        id?: number;
        bounds?: { x: number; y: number; width: number; height: number };
        screen?: { width: number; height: number };
      }>)();
      if (!win || !win.bounds) return null;
      return {
        appName: win.app?.name ?? "Unknown App",
        bundleId: win.app?.bundleId,
        windowTitle: win.title ?? "",
        url: win.url,
        windowId: win.id ?? 0,
        bounds: win.bounds,
      };
    } catch {
      return null;
    }
  }
}

class OsascriptSource implements ActiveWindowSource {
  readonly name = "osascript";
  async getActive(): Promise<ActiveWindowResult | null> {
    try {
      const out = execFileSync("/usr/bin/osascript", [
        "-e",
        'tell application "System Events" to get name of first application process whose frontmost is true',
      ]);
      const bytes = out as unknown as Uint8Array;
      const appName = Buffer.from(bytes).toString("utf8").trim();
      if (!appName) return null;
      return {
        appName,
        windowTitle: appName,
        windowId: 0,
        bounds: { x: 0, y: 0, width: 0, height: 0 },
      };
    } catch {
      return null;
    }
  }
}

export class ActiveWindowEngine {
  private sources: ActiveWindowSource[];
  active: WindowContext | null = null;
  private screenWidth: number;
  private screenHeight: number;
  private screenScale: number;

  constructor(screenWidth: number, screenHeight: number, screenScale: number) {
    this.screenWidth = screenWidth;
    this.screenHeight = screenHeight;
    this.screenScale = screenScale;
    this.sources = [new GetWindowsSource(), new OsascriptSource()];
  }

  get sourceName(): string {
    return this.sources[0]?.name ?? "none";
  }

  async refresh(): Promise<WindowContext | null> {
    for (const source of this.sources) {
      const raw = await source.getActive();
      if (raw) {
        const bounds = raw.bounds.width > 0 && raw.bounds.height > 0
          ? raw.bounds
          : { x: 0, y: 0, width: Math.round(this.screenWidth), height: Math.round(this.screenHeight) };
        this.active = {
          appName: raw.appName,
          bundleId: raw.bundleId,
          windowTitle: raw.windowTitle,
          url: raw.url,
          windowId: raw.windowId,
          bounds,
          screenWidth: this.screenWidth,
          screenHeight: this.screenHeight,
        };
        return this.active;
      }
    }
    this.active = null;
    return null;
  }

  getActive(): WindowContext | null {
    return this.active;
  }
}
