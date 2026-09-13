import { describe, expect, it } from "vitest";
import { shouldSpeakSemanticSelection, spokenSelectionFeedback } from "../../src/main/state/InteractionController";

describe("selection speech", () => {
  it("turns compact card labels into short spoken confirmations", () => {
    expect(spokenSelectionFeedback("FIND / LEARN…")).toBe("Okay — find or learn.");
    expect(spokenSelectionFeedback("  MORE   CHOICES ")).toBe("Okay — more choices.");
    expect(spokenSelectionFeedback("…")).toBe("Okay.");
  });

  it("waits until the second semantic selection before speaking", () => {
    expect(shouldSpeakSemanticSelection(1)).toBe(false);
    expect(shouldSpeakSemanticSelection(2)).toBe(true);
    expect(shouldSpeakSemanticSelection(3)).toBe(true);
  });
});
