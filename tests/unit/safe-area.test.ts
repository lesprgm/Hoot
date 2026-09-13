import { describe, expect, it } from "vitest";
import { parseMacSafeAreaGeometry, parseSafeAreaTopInset } from "../../src/main/display/SafeArea";

describe("macOS safe-area parsing", () => {
  it("accepts an AppKit top inset", () => {
    expect(parseSafeAreaTopInset("32\n")).toBe(32);
  });

  it("derives the notch center relative to the AppKit screen frame", () => {
    expect(parseMacSafeAreaGeometry('{"topInset":32,"frameX":0,"leftMaxX":646,"rightMinX":825}')).toEqual({
      topInset: 32,
      notchCenterX: 735.5,
      notchLeftX: 646,
      notchRightX: 825,
    });
  });

  it("reports no notch bounds when AppKit exposes no camera gap", () => {
    expect(parseMacSafeAreaGeometry('{"topInset":24,"frameX":0,"leftMaxX":1470,"rightMinX":0}')).toEqual({
      topInset: 24,
      notchCenterX: null,
      notchLeftX: null,
      notchRightX: null,
    });
  });

  it("rejects missing, negative, and implausible values", () => {
    expect(parseSafeAreaTopInset("")).toBeNull();
    expect(parseSafeAreaTopInset("-1")).toBeNull();
    expect(parseSafeAreaTopInset("1000")).toBeNull();
  });
});
