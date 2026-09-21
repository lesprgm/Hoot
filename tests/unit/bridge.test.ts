import { describe, expect, it } from "vitest";
import { applyMessage, initialViewState } from "../../src/renderer/bridge";
import { isSelectionEnvelope, makeInteractionSnapshot } from "../../src/shared/decisions";
import type { ContextSnapshot, PromptViewState } from "../../src/shared/types";
import type { TaskRecord } from "../../src/shared/task";

describe("renderer interaction snapshot", () => {
  it("treats null prompt, context, and task as authoritative clears", () => {
    const prompt = { sessionId: "session", displayPrompt: "I want you to…", options: [], canBack: false, canMore: true, canExit: true, mode: "predict", speculativeReady: {} } as PromptViewState;
    const context = { access: "active", sessionId: "session", revision: 1 } as ContextSnapshot;
    const task = { taskId: "task", schemaVersion: 1 } as TaskRecord;
    const prior = { ...initialViewState(), prompt, context, task };
    const snapshot = makeInteractionSnapshot({ state: "PASSIVE", busy: false, prompt: null, context: null, task: null, revision: 2 });
    const next = applyMessage(prior, { type: "interaction-snapshot", snapshot });

    expect(next.prompt).toBeNull();
    expect(next.context).toBeNull();
    expect(next.task).toBeNull();
    expect(next.interactionState).toBe("PASSIVE");
  });

  it("rejects the removed raw quadrant selection contract", () => {
    const envelope = {
      interactionId: "interaction",
      sessionId: "session",
      cardSetId: "cards",
      cardId: "card-a",
      expectedRevision: 1,
    };

    expect(isSelectionEnvelope(envelope)).toBe(true);
    expect(isSelectionEnvelope({ ...envelope, quadrant: "A" })).toBe(false);
    expect(isSelectionEnvelope("A")).toBe(false);
  });
});
