import { describe, expect, it } from "vitest";
import { spokenSelectionFeedback } from "../../src/main/state/InteractionController";

describe("selection speech", () => {
  it("turns compact card labels into short spoken confirmations", () => {
    expect(spokenSelectionFeedback("FIND / LEARN…")).toBe("find or learn selected.");
    expect(spokenSelectionFeedback("  MORE   CHOICES ")).toBe("more choices selected.");
    expect(spokenSelectionFeedback("…")).toBe("Selection accepted.");
  });
});
