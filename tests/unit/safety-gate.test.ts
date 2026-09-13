import { describe, expect, it } from "vitest";
import { isConsequentialIntent, labelConsequentialAction } from "../../src/main/executor/ExecutorProvider";

describe("consequential action gate", () => {
  it("classifies send/delete/purchase intents as consequential", () => {
    expect(isConsequentialIntent("Email Daniel the summary")).toBe(true);
    expect(isConsequentialIntent("Delete the old file")).toBe(true);
    expect(isConsequentialIntent("Buy two tickets")).toBe(true);
    expect(isConsequentialIntent("Find a file I downloaded")).toBe(false);
    expect(isConsequentialIntent("Explain this paragraph")).toBe(false);
  });

  it("labels the pending action clearly", () => {
    const label = labelConsequentialAction("Email the summary to Daniel");
    expect(label.toLowerCase()).toContain("send");
  });
});
