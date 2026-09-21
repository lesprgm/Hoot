import { describe, expect, it } from "vitest";
import { chooseInteractionPolicy } from "../../src/main/task/InteractionPolicy";
import { createTaskRecord } from "../../src/shared/task";

describe("interaction policy", () => {
  it("keeps the current cards while a decoder request is pending", () => {
    expect(chooseInteractionPolicy({ task: null, current: null, busy: true })).toMatchObject({ kind: "compose", keepCurrentCards: true });
  });

  it("does not expose task-aware mode until the rollout flag is enabled", () => {
    const task = createTaskRecord("review the document");
    expect(chooseInteractionPolicy({ task, current: null, busy: false, taskAwareEnabled: false }).kind).toBe("compose");
    expect(chooseInteractionPolicy({ task, current: null, busy: false, taskAwareEnabled: true }).kind).toBe("task_actions");
  });

  it("prioritizes a pending user decision", () => {
    const task = { ...createTaskRecord("send the message"), execution: { status: "awaiting_user" as const, activeOperationId: "op", checkpoint: null, pendingDecision: "send" } };
    expect(chooseInteractionPolicy({ task, current: null, busy: false, taskAwareEnabled: true }).kind).toBe("review");
  });
});
