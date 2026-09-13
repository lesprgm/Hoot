import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const SAFE_AREA_SCRIPT = [
  'ObjC.import("AppKit")',
  "const activeScreen = $.NSScreen.mainScreen",
  "const leftArea = activeScreen && activeScreen.auxiliaryTopLeftArea",
  "const rightArea = activeScreen && activeScreen.auxiliaryTopRightArea",
  "activeScreen ? JSON.stringify({ topInset: Number(activeScreen.safeAreaInsets.top), frameX: Number(activeScreen.frame.origin.x), leftMaxX: Number(leftArea.origin.x + leftArea.size.width), rightMinX: Number(rightArea.origin.x) }) : \"\"",
].join("; ");

export interface MacSafeAreaGeometry {
  topInset: number;
  notchCenterX: number | null;
  notchLeftX: number | null;
  notchRightX: number | null;
}

export function parseSafeAreaTopInset(output: string): number | null {
  const value = Number.parseFloat(output.trim());
  return Number.isFinite(value) && value >= 0 && value <= 256 ? value : null;
}

export function parseMacSafeAreaGeometry(output: string): MacSafeAreaGeometry | null {
  try {
    const value = JSON.parse(output) as { topInset?: unknown; frameX?: unknown; leftMaxX?: unknown; rightMinX?: unknown };
    const topInset = typeof value.topInset === "number" ? value.topInset : Number.NaN;
    if (!Number.isFinite(topInset) || topInset < 0 || topInset > 256) return null;
    const hasNotchGap = typeof value.leftMaxX === "number"
      && typeof value.rightMinX === "number"
      && value.rightMinX > value.leftMaxX;
    const frameX = typeof value.frameX === "number" ? value.frameX : 0;
    const notchLeftX = hasNotchGap ? (value.leftMaxX as number) - frameX : null;
    const notchRightX = hasNotchGap ? (value.rightMinX as number) - frameX : null;
    return {
      topInset,
      notchCenterX: notchLeftX != null && notchRightX != null ? (notchLeftX + notchRightX) / 2 : null,
      notchLeftX,
      notchRightX,
    };
  } catch {
    return null;
  }
}

/** Reads the physical camera/notch safe-area inset reported by AppKit. */
export async function readMacSafeAreaGeometry(): Promise<MacSafeAreaGeometry | null> {
  if (process.platform !== "darwin") return null;
  try {
    const result = await execFileAsync("/usr/bin/osascript", ["-l", "JavaScript", "-e", SAFE_AREA_SCRIPT], {
      encoding: "utf8",
      timeout: 2_000,
    });
    return parseMacSafeAreaGeometry(result.stdout);
  } catch {
    return null;
  }
}

export async function readMacSafeAreaTopInset(): Promise<number | null> {
  return (await readMacSafeAreaGeometry())?.topInset ?? null;
}
