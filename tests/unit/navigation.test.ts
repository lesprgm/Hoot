import { describe, expect, it, vi } from "vitest";
import { NavigationController } from "../../src/renderer/navigation/NavigationController";

describe("NavigationController", () => {
  it("scrolls once after reading edge dwell and respects cooldown", () => {
    const action = vi.fn();
    const nav = new NavigationController(action);
    nav.setMode("reading");
    nav.update({ xNorm: 0.5, yNorm: 0.9, valid: true, nowMs: 0 });
    nav.update({ xNorm: 0.5, yNorm: 0.9, valid: true, nowMs: 649 });
    expect(action).not.toHaveBeenCalled();
    nav.update({ xNorm: 0.5, yNorm: 0.9, valid: true, nowMs: 650 });
    nav.update({ xNorm: 0.5, yNorm: 0.9, valid: true, nowMs: 800 });
    expect(action).toHaveBeenCalledTimes(1);
    expect(action).toHaveBeenCalledWith({ direction: "next", deltaPx: 320 });
  });

  it("resets on center gaze and supports feed previous navigation", () => {
    const action = vi.fn();
    const nav = new NavigationController(action);
    nav.setMode("vertical_feed");
    nav.update({ xNorm: 0.5, yNorm: 0.1, valid: true, nowMs: 0 });
    nav.update({ xNorm: 0.5, yNorm: 0.5, valid: true, nowMs: 700 });
    nav.update({ xNorm: 0.5, yNorm: 0.1, valid: true, nowMs: 701 });
    nav.update({ xNorm: 0.5, yNorm: 0.1, valid: true, nowMs: 1301 });
    expect(action).toHaveBeenCalledWith({ direction: "previous", deltaPx: 720 });
  });
});
