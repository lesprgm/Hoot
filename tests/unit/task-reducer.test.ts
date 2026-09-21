import { describe, expect, it } from "vitest";
import { createTaskRecord, reduceTask } from "../../src/shared/task";

describe("task reducer", () => {
  it("keeps accepted requirements and replaces only the named requirement", () => {
    let task = reduceTask(null, { type: "create", taskId: "task-1", goal: "prepare a demo" });
    expect(task?.goal).toBe("prepare a demo");
    task = reduceTask(task, { type: "add_requirement", name: "target", value: "the current document" });
    task = reduceTask(task, { type: "add_requirement", name: "format", value: "short" });
    const before = task?.revision ?? 0;
    task = reduceTask(task, { type: "replace_requirement", name: "target", value: "the selected paragraph" });
    expect(task?.requirements).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "target", value: "the selected paragraph" }),
      expect.objectContaining({ name: "format", value: "short" }),
    ]));
    expect(task?.revision).toBeGreaterThan(before);
  });

  it("does not advance task revision for observations or proposals", () => {
    const base = createTaskRecord("inspect this");
    const snapshot = {
      access: "active" as const,
      sessionId: "s1",
      revision: 2,
      window: null,
      surfaceType: "unknown" as const,
      attentionAnchor: null,
      capturedImageDataUrl: null,
      capturedWidth: 0,
      capturedHeight: 0,
      capturedAt: null,
      activeAppDisplayName: "None",
      approvedApp: false,
      contextScope: "app" as const,
      sources: [],
      references: [],
      focusedElement: null,
      selectedText: null,
      visibleText: null,
    };
    const observed = reduceTask(base, { type: "observe_context", snapshot });
    const proposed = reduceTask(observed, { type: "add_proposal", operation: "inspect_artifact" });
    expect(observed?.revision).toBe(base.revision);
    expect(proposed?.revision).toBe(base.revision);
    expect(proposed?.proposals).toHaveLength(1);
  });

  it("marks an interrupted task paused on explicit execution state", () => {
    const base = createTaskRecord("work");
    const paused = reduceTask(base, { type: "set_execution", status: "paused", checkpoint: "after click" });
    expect(paused?.execution.status).toBe("paused");
    expect(paused?.execution.checkpoint).toBe("after click");
  });
});
