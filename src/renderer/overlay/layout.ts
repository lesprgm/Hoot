import type { OverlayLayout, ScreenRect } from "../../shared/types";

export interface OverlaySurface {
  width: number;
  height: number;
}

export interface PlacedRegion {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  overlapped?: boolean;
}

export function screenCorners(surface: OverlaySurface): PlacedRegion[] {
  const { width, height } = surface;
  const shelfTop = height - Math.round(height * 0.12);
  const cardHeight = Math.round(height * 0.32);
  const lowerTop = shelfTop - cardHeight;
  return [
    { id: "A", x: 0, y: 0, width: Math.round(width * 0.34), height: cardHeight },
    { id: "B", x: Math.round(width * 0.66), y: 0, width: Math.round(width * 0.34), height: cardHeight },
    { id: "C", x: 0, y: lowerTop, width: Math.round(width * 0.34), height: cardHeight },
    { id: "D", x: Math.round(width * 0.66), y: lowerTop, width: Math.round(width * 0.34), height: cardHeight },
  ];
}

export function windowHalo(surface: OverlaySurface, windowBounds: ScreenRect): PlacedRegion[] {
  const { width: W, height: H } = surface;
  const cardW = Math.min(Math.max(Math.round(W * 0.19), 250), 390);
  const cardH = Math.min(Math.max(Math.round(H * 0.12), 105), 165);
  const gap = 18;

  const placements: Array<{ id: string; x: number; y: number }> = [
    { id: "A", x: windowBounds.x - cardW - gap, y: windowBounds.y - cardH - gap },
    { id: "B", x: windowBounds.x + windowBounds.width + gap, y: windowBounds.y - cardH - gap },
    { id: "C", x: windowBounds.x - cardW - gap, y: windowBounds.y + windowBounds.height + gap },
    { id: "D", x: windowBounds.x + windowBounds.width + gap, y: windowBounds.y + windowBounds.height + gap },
  ];

  const result: PlacedRegion[] = [];
  for (const p of placements) {
    let x = clamp(p.x, 0, Math.max(0, W - cardW));
    let y = clamp(p.y, 0, Math.max(0, H - cardH));
    const overlapped = x < windowBounds.x + windowBounds.width && x + cardW > windowBounds.x && y < windowBounds.y + windowBounds.height && y + cardH > windowBounds.y;
    result.push({ id: p.id, x, y, width: cardW, height: cardH, overlapped });
  }
  return result;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function layoutFor(layout: OverlayLayout, surface: OverlaySurface): PlacedRegion[] {
  if (layout.kind === "screen_corners") return screenCorners(surface);
  return windowHalo(surface, layout.windowBounds);
}

export function pickLayoutMode(surfaceArea: number, screenArea: number): OverlayLayout["kind"] {
  return surfaceArea / screenArea >= 0.55 ? "screen_corners" : "window_halo";
}

export function shelfRegions(surface: OverlaySurface, zonesCount: number = 4): PlacedRegion[] {
  const { width, height } = surface;
  const shelfH = Math.round(height * 0.12);
  const top = height - shelfH;
  const zoneW = Math.round(width / zonesCount);
  const out: PlacedRegion[] = [];
  for (let i = 0; i < zonesCount; i++) {
    out.push({ id: `shelf_${i}`, x: i * zoneW, y: top, width: zoneW, height: shelfH });
  }
  return out;
}

export function spriteRegion(surface: OverlaySurface, notchHeight: number = 38, notchCenterX: number = surface.width / 2, notchWidth?: number): PlacedRegion {
  const hasNotch = notchWidth != null && notchWidth > 0;
  // Match the top cards' vertical tolerance and use the center gap between
  // them. The visual sprite remains 50px wide, but the camera does not need
  // to resolve that small target precisely before summon or interruption.
  const width = Math.max(
    hasNotch ? Math.round(notchWidth) + 96 : 180,
    Math.round(surface.width * 0.32),
  );
  const height = Math.max(
    hasNotch ? notchHeight + 104 : 96,
    Math.round(surface.height * 0.32),
  );
  return {
    id: "sprite",
    x: Math.round(notchCenterX - width / 2),
    y: 0,
    width,
    height,
  };
}

export function promptBufferRegion(surface: OverlaySurface): PlacedRegion {
  const width = Math.min(720, Math.round(surface.width * 0.55));
  return { id: "prompt", x: Math.round((surface.width - width) / 2), y: 112, width, height: 120 };
}

export function confirmRegions(surface: OverlaySurface): PlacedRegion[] {
  // Confirmation is a decision state, not a smaller interaction mode. Reuse
  // the semantic card geometry so gaze targets keep the same size and
  // position across the transition.
  return screenCorners(surface);
}
