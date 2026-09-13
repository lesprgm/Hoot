import { describe, expect, it } from "vitest";
import { screenCorners, confirmRegions, windowHalo, pickLayoutMode, shelfRegions, spriteRegion } from "../../src/renderer/overlay/layout";

const SCREEN = { width: 2880, height: 1800 };

describe("notch sprite geometry", () => {
  it("pads the perceived notch for reliable gaze targeting", () => {
    expect(spriteRegion(SCREEN, 38, 1440, 180)).toEqual({ id: "sprite", x: 979, y: 0, width: 922, height: 576 });
  });

  it("uses a generous top-center target when the display has no notch", () => {
    expect(spriteRegion(SCREEN, 38)).toEqual({ id: "sprite", x: 979, y: 0, width: 922, height: 576 });
    expect(spriteRegion(SCREEN, 24).y).toBe(0);
    expect(spriteRegion(SCREEN, 32, 735.5).x).toBe(275);
  });
});

describe("SCREEN_CORNERS geometry", () => {
  const regions = Object.fromEntries(screenCorners(SCREEN).map((r) => [r.id, r]));

  it("places A top-left, B top-right, C bottom-left, D bottom-right", () => {
    expect(regions["A"].x).toBe(0);
    expect(regions["A"].y).toBe(0);
    expect(regions["B"].x + regions["B"].width).toBe(SCREEN.width);
    expect(regions["B"].y).toBe(0);
    expect(regions["C"].x).toBe(0);
    const shelfTop = shelfRegions(SCREEN, 4)[0].y;
    expect(regions["C"].y + regions["C"].height).toBe(shelfTop);
    expect(regions["D"].x + regions["D"].width).toBe(SCREEN.width);
    expect(regions["D"].y + regions["D"].height).toBe(shelfTop);
  });

  it("hit regions are large (>= 25% of each dimension)", () => {
    for (const q of ["A", "B", "C", "D"]) {
      expect(regions[q].width).toBeGreaterThanOrEqual(Math.round(SCREEN.width * 0.29));
      expect(regions[q].height).toBeGreaterThanOrEqual(Math.round(SCREEN.height * 0.27));
    }
  });

  it("does not overlap the utility shelf", () => {
    const shelf = shelfRegions(SCREEN, 4);
    const shelfTop = Math.min(...shelf.map((s) => s.y));
    for (const q of ["A", "B", "C", "D"]) {
      expect(regions[q].y + regions[q].height).toBeLessThanOrEqual(shelfTop + 1);
    }
  });
});

describe("confirmation geometry", () => {
  it("uses the same large gaze targets as semantic choices", () => {
    expect(confirmRegions(SCREEN)).toEqual(screenCorners(SCREEN));
  });
});

describe("WINDOW_HALO geometry", () => {
  it("surrounds a narrow active window with large cards", () => {
    const narrowWindow = { x: 1180, y: 200, width: 500, height: 1100 };
    const cards = Object.fromEntries(windowHalo(SCREEN, narrowWindow).map((r) => [r.id, r]));
    for (const q of ["A", "B", "C", "D"]) {
      expect(cards[q].width).toBeGreaterThanOrEqual(200);
      expect(cards[q].height).toBeGreaterThanOrEqual(80);
      expect(cards[q].x).toBeGreaterThanOrEqual(0);
      expect(cards[q].y).toBeGreaterThanOrEqual(0);
      expect(cards[q].x + cards[q].width).toBeLessThanOrEqual(SCREEN.width);
      expect(cards[q].y + cards[q].height).toBeLessThanOrEqual(SCREEN.height);
    }
    // A is above-left of the window, D below-right
    expect(cards["A"].x + cards["A"].width).toBeLessThanOrEqual(narrowWindow.x);
    expect(cards["D"].y).toBeGreaterThanOrEqual(narrowWindow.y + narrowWindow.height);
  });

  it("keeps cards on-screen for edge windows (clamps positions)", () => {
    const edgeWindow = { x: 0, y: 0, width: 400, height: 900 };
    const cards = windowHalo(SCREEN, edgeWindow);
    for (const c of cards) {
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.y).toBeGreaterThanOrEqual(0);
      expect(c.x + c.width).toBeLessThanOrEqual(SCREEN.width);
      expect(c.y + c.height).toBeLessThanOrEqual(SCREEN.height);
    }
  });
});

describe("layout mode selection", () => {
  it("uses screen_corners for large windows and window_halo for narrow ones", () => {
    expect(pickLayoutMode(SCREEN.width * SCREEN.height * 0.8, SCREEN.width * SCREEN.height)).toBe("screen_corners");
    expect(pickLayoutMode(SCREEN.width * SCREEN.height * 0.2, SCREEN.width * SCREEN.height)).toBe("window_halo");
  });
});
