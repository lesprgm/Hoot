import type { ScreenRect, WindowContext } from "../../shared/types";

export interface CapturedFrame {
  dataUrl: string;
  width: number;
  height: number;
}

type SharpOp = {
  extract(options: { left: number; top: number; width: number; height: number }): SharpOp;
  resize(options: { width: number }): SharpOp;
  png(): SharpOp;
  toBuffer(): Promise<Buffer>;
};
type SharpFn = (input: Uint8Array | string) => SharpOp;

async function loadSharp(): Promise<SharpFn | null> {
  try {
    const mod = (await import("sharp")) as unknown as { default?: SharpFn };
    return mod.default ?? null;
  } catch {
    return null;
  }
}

/** Captures the real primary display through Electron's supported API. */
export class ScreenCapturer {
  private async frameFromPng(png: Buffer, width: number, height: number, targetWidth?: number): Promise<CapturedFrame> {
    if (!targetWidth || targetWidth >= width) {
      return { dataUrl: `data:image/png;base64,${png.toString("base64")}`, width, height };
    }
    const sharp = await loadSharp();
    if (!sharp) return { dataUrl: `data:image/png;base64,${png.toString("base64")}`, width, height };
    const resized = await sharp(png).resize({ width: targetWidth }).png().toBuffer();
    return {
      dataUrl: `data:image/png;base64,${resized.toString("base64")}`,
      width: targetWidth,
      height: Math.round(height * (targetWidth / width)),
    };
  }

  async capturePrimary(targetWidth?: number): Promise<CapturedFrame | null> {
    try {
      const { desktopCapturer, screen } = await import("electron");
      const display = screen.getPrimaryDisplay();
      const captureWidth = Math.max(1, Math.round(display.size.width));
      const captureHeight = Math.max(1, Math.round(display.size.height));
      const sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width: captureWidth, height: captureHeight },
        fetchWindowIcons: false,
      });
      const source = sources.find((item) => item.display_id === String(display.id)) ?? sources[0];
      if (!source || source.thumbnail.isEmpty()) return null;
      const png = source.thumbnail.toPNG();
      const size = source.thumbnail.getSize();
      return this.frameFromPng(png, size.width, size.height, targetWidth);
    } catch {
      return null;
    }
  }

  async captureActiveWindow(window: WindowContext, targetWidth = 512): Promise<CapturedFrame | null> {
    try {
      const { desktopCapturer, screen } = await import("electron");
      const display = screen.getDisplayMatching(window.bounds);
      const sources = await desktopCapturer.getSources({
        types: ["window"],
        thumbnailSize: { width: display.bounds.width, height: display.bounds.height },
        fetchWindowIcons: false,
      });
      const byId = window.windowId > 0
        ? sources.find((source) => source.id.startsWith(`window:${window.windowId}:`))
        : undefined;
      const byTitle = sources.find((source) => source.name === window.windowTitle || source.name === window.appName);
      const source = byId ?? byTitle;
      if (source && !source.thumbnail.isEmpty()) {
        const size = source.thumbnail.getSize();
        return this.frameFromPng(source.thumbnail.toPNG(), size.width, size.height, targetWidth);
      }
    } catch {
      // The primary-display crop below is the required fallback.
    }
    return this.cropToWindow(window.bounds, targetWidth);
  }

  async cropToWindow(bounds: ScreenRect, targetWidth = 512): Promise<CapturedFrame | null> {
    const full = await this.capturePrimary();
    if (!full || bounds.width <= 0 || bounds.height <= 0) return full;
    const sharp = await loadSharp();
    if (!sharp) return full;
    try {
      const { screen } = await import("electron");
      const display = screen.getPrimaryDisplay();
      const scaleX = full.width / display.bounds.width;
      const scaleY = full.height / display.bounds.height;
      const left = Math.max(0, Math.min(full.width - 1, Math.round((bounds.x - display.bounds.x) * scaleX)));
      const top = Math.max(0, Math.min(full.height - 1, Math.round((bounds.y - display.bounds.y) * scaleY)));
      const width = Math.max(1, Math.min(full.width - left, Math.round(bounds.width * scaleX)));
      const height = Math.max(1, Math.min(full.height - top, Math.round(bounds.height * scaleY)));
      const base64 = full.dataUrl.split(",")[1] ?? full.dataUrl;
      const cropped = await sharp(Buffer.from(base64, "base64"))
        .extract({ left, top, width, height })
        .resize({ width: targetWidth })
        .png()
        .toBuffer();
      return {
        dataUrl: `data:image/png;base64,${cropped.toString("base64")}`,
        width: targetWidth,
        height: Math.round(height * (targetWidth / width)),
      };
    } catch {
      return full;
    }
  }
}
