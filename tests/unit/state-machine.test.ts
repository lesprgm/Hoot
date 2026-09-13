import { describe, expect, it } from "vitest";
import { InteractionStateMachine } from "../../src/main/state/StateMachine";

describe("InteractionStateMachine", () => {
  it("follows the summon → semantic → confirmation → executing → passive path", () => {
    const m = new InteractionStateMachine();
    expect(m.state).toBe("BOOT");
    expect(m.transition("setupRequired")).toBe(true);
    expect(m.state).toBe("SETUP_REQUIRED");
    expect(m.transition("optionsReady")).toBe(true);
    expect(m.state).toBe("PASSIVE");

    expect(m.transition("summonReady")).toBe(true);
    expect(m.state).toBe("AGENT_LOADING");
    expect(m.transition("optionsReady")).toBe(true);
    expect(m.state).toBe("SEMANTIC");

    expect(m.transition("selectOption")).toBe(true);
    expect(m.state).toBe("SEMANTIC");
    expect(m.transition("intentReady")).toBe(true);
    expect(m.state).toBe("INTENT_CONFIRMATION");

    expect(m.transition("confirmYes")).toBe(true);
    expect(m.state).toBe("EXECUTING");
    expect(m.transition("consequentialPending")).toBe(true);
    expect(m.state).toBe("CONSEQUENTIAL_CONFIRMATION");
    expect(m.transition("approveConsequential")).toBe(true);
    expect(m.state).toBe("EXECUTING");
    expect(m.transition("completed")).toBe(true);
    expect(m.state).toBe("COMPLETE");
    expect(m.transition("optionsReady")).toBe(true);
    expect(m.state).toBe("PASSIVE");
  });

  it("rejects invalid transitions for the current state", () => {
    const m = new InteractionStateMachine();
    m.set("PASSIVE");
    expect(m.transition("gazeLost")).toBe(false);
    expect(m.transition("steerContinue")).toBe(false);
    expect(m.transition("consequentialPending")).toBe(false);
    expect(m.state).toBe("PASSIVE");
  });

  it("two NONE events do not exit semantic mode", () => {
    const m = new InteractionStateMachine();
    m.set("SEMANTIC");
    expect(m.transition("more")).toBe(true);
    expect(m.transition("more")).toBe(true);
    expect(m.state).toBe("SEMANTIC");
  });

  it("EXIT from semantic returns to PASSIVE (no confirmation trap)", () => {
    const m = new InteractionStateMachine();
    m.set("SEMANTIC");
    expect(m.transition("exit")).toBe(true);
    expect(m.state).toBe("PASSIVE");
  });

  it("gaze loss pauses and never exits", () => {
    const m = new InteractionStateMachine();
    m.set("SEMANTIC");
    expect(m.transition("gazeLost")).toBe(true);
    expect(m.state).toBe("SEMANTIC_PAUSED");
    expect(m.transition("selectOption")).toBe(false);
    expect(m.transition("gazeRestored")).toBe(true);
    expect(m.state).toBe("SEMANTIC");
  });

  it("restores the exact state that gaze loss paused", () => {
    const m = new InteractionStateMachine();
    m.set("INTENT_CONFIRMATION");
    expect(m.transition("gazeLost")).toBe(true);
    expect(m.state).toBe("SEMANTIC_PAUSED");
    expect(m.transition("gazeRestored")).toBe(true);
    expect(m.state).toBe("INTENT_CONFIRMATION");
  });

  it("notch dwell during EXECUTING interrupts immediately", () => {
    const m = new InteractionStateMachine();
    m.set("EXECUTING");
    expect(m.transition("interrupt")).toBe(true);
    expect(m.state).toBe("EXECUTION_INTERRUPTED");
  });

  it("locks semantic input while the decoder is running", () => {
    const m = new InteractionStateMachine();
    m.set("SEMANTIC");
    expect(m.transition("decodingStarted")).toBe(true);
    expect(m.state).toBe("DECODING_ALT");
    expect(m.transition("selectOption")).toBe(false);
    expect(m.transition("more")).toBe(false);
    expect(m.transition("back")).toBe(false);
    expect(m.transition("decodingFinished")).toBe(true);
    expect(m.state).toBe("SEMANTIC");
  });

  it("routes recovery and steering corrections back to semantic composition", () => {
    const m = new InteractionStateMachine();
    m.set("ERROR_RECOVERY");
    expect(m.transition("recoveryBack")).toBe(true);
    expect(m.state).toBe("SEMANTIC");
    m.set("ERROR_RECOVERY");
    expect(m.transition("recoveryChoose")).toBe(true);
    expect(m.state).toBe("SEMANTIC");
    m.set("EXECUTION_INTERRUPTED");
    expect(m.transition("steerChange")).toBe(true);
    expect(m.state).toBe("SEMANTIC");
    m.set("CONSEQUENTIAL_CONFIRMATION");
    expect(m.transition("editConsequential")).toBe(true);
    expect(m.state).toBe("SEMANTIC");
  });
});
