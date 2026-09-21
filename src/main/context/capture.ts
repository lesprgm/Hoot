import type { WindowContext } from "../../shared/types";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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

  /**
   * Capture the primary display through the native ScreenCaptureKit helper
   * while excluding the Hoots processes. This is deliberately a separate
   * path from Electron's desktopCapturer: Electron cannot express an
   * application exclusion filter for a display capture.
   *
   * The method rejects on every setup/capture/decoding failure. Callers must
   * not fall back to an unfiltered desktop image because that would put the
   * Hoots overlay back into Astra's visual input.
   */
  async capturePrimaryFiltered(
    targetWidth: number | undefined,
    helperPath: string | null | undefined,
    excludedProcessIds: readonly number[],
  ): Promise<CapturedFrame> {
    if (process.platform !== "darwin") {
      throw new Error("Filtered screen capture requires macOS ScreenCaptureKit.");
    }
    if (!helperPath) {
      throw new Error("Filtered screen capture helper is unavailable. Rebuild Hoots to install ViewScreenCaptureHost.");
    }
    const pids = [...new Set(excludedProcessIds.filter((pid) => Number.isInteger(pid) && pid > 0))];
    if (pids.length === 0) {
      throw new Error("Filtered screen capture has no Hoots process IDs to exclude.");
    }

    let result: { stdout: Buffer; stderr?: Buffer | string };
    try {
      result = await execFileAsync(
        helperPath,
        ["--exclude-pids", pids.join(",")],
        {
          encoding: "buffer",
          timeout: 5_000,
          maxBuffer: 32 * 1024 * 1024,
        },
      ) as unknown as { stdout: Buffer; stderr?: Buffer | string };
    } catch (error) {
      const stderr = typeof error === "object" && error !== null && "stderr" in error
        ? String((error as { stderr?: unknown }).stderr ?? "").trim()
        : "";
      const detail = stderr || (error instanceof Error ? error.message : String(error));
      throw new Error(`Filtered screen capture failed: ${detail}`);
    }

    const png = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? "");
    if (png.length === 0) throw new Error("Filtered screen capture returned an empty image.");
    const { nativeImage } = await import("electron");
    const image = nativeImage.createFromBuffer(png);
    if (image.isEmpty()) throw new Error("Filtered screen capture returned an invalid PNG.");
    const size = image.getSize();
    if (size.width < 1 || size.height < 1) throw new Error("Filtered screen capture returned an invalid image size.");
    return this.frameFromPng(png, size.width, size.height, targetWidth);
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
      // Context capture remains window-scoped when the desktop API fails.
    }
    // Do not broaden a failed context request to a primary-display image. The
    // computer-use executor has its own explicit full-display capture path.
    return null;
  }

}
