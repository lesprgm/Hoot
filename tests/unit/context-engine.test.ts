import { describe, expect, it, vi } from "vitest";
import { ContextEngine } from "../../src/main/context/ContextEngine";
import type { ContextReference, WindowContext } from "../../src/shared/types";

function windowContext(overrides: Partial<WindowContext> = {}): WindowContext {
  return {
    appName: "Fixture Browser",
    bundleId: "com.example.browser",
    windowTitle: "Example article",
    url: "https://example.test/article",
    windowId: 42,
    bounds: { x: 20, y: 30, width: 900, height: 700 },
    screenWidth: 1470,
    screenHeight: 956,
    ...overrides,
  };
}

describe("ContextEngine access policy", () => {
  it("does not inspect the desktop before a session is enabled", async () => {
    const refresh = vi.fn(async () => windowContext());
    const engine = new ContextEngine(1470, 956, 2, { windowEngine: { refresh } });

    await engine.start();

    expect(refresh).not.toHaveBeenCalled();
    expect(engine.current()).toBeNull();
  });

  it("approves the summoned app, captures only its window, and pauses cleanly", async () => {
    const refresh = vi.fn(async () => windowContext());
    const captureActiveWindow = vi.fn(async () => ({
      dataUrl: "data:image/png;base64,ZmFrZQ==",
      width: 512,
      height: 398,
    }));
    const engine = new ContextEngine(1470, 956, 2, {
      windowEngine: { refresh },
      capturer: { captureActiveWindow },
    });

    const started = await engine.enableSession();
    expect(started.access).toBe("active");
    expect(started.approvedApp).toBe(true);
    expect(started.references.map((reference) => reference.kind)).toEqual(["window", "document"]);

    const captured = await engine.snapshotContext(true);
    expect(captured.capturedImageDataUrl).toContain("data:image/png");
    expect(captured.sources.find((source) => source.kind === "screenshot")?.state).toBe("available");
    expect(captureActiveWindow).toHaveBeenCalledTimes(1);

    const paused = await engine.togglePaused();
    expect(paused.access).toBe("paused");
    expect(paused.capturedImageDataUrl).toBeNull();
    const refreshCount = refresh.mock.calls.length;
    await engine.snapshotContext(true);
    expect(captureActiveWindow).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(refreshCount);

    const resumed = await engine.togglePaused();
    expect(resumed.access).toBe("active");
    expect(refresh).toHaveBeenCalledTimes(refreshCount + 1);
  });

  it("blocks an unapproved app until the user explicitly approves it", async () => {
    const refresh = vi.fn(async () => windowContext({ appName: "Private Editor", bundleId: "com.example.private" }));
    const captureActiveWindow = vi.fn(async () => ({ dataUrl: "data:image/png;base64,ZmFrZQ==", width: 512, height: 398 }));
    const engine = new ContextEngine(1470, 956, 2, {
      allowedApps: ["com.example.browser"],
      windowEngine: { refresh },
      capturer: { captureActiveWindow },
    });

    const blocked = await engine.enableSession();
    expect(blocked.access).toBe("blocked");
    expect(blocked.approvedApp).toBe(false);
    expect(blocked.contextScope).toBe("app");
    await engine.snapshotContext(true);
    expect(captureActiveWindow).not.toHaveBeenCalled();

    const approved = await engine.approveSessionContext();
    expect(approved.access).toBe("active");
    expect(approved.approvedApp).toBe(true);
    expect(approved.contextScope).toBe("session");
  });

  it("follows foreground app changes after one session approval", async () => {
    let current = windowContext();
    const refresh = vi.fn(async () => current);
    const captureActiveWindow = vi.fn(async () => ({ dataUrl: "data:image/png;base64,ZmFrZQ==", width: 512, height: 398 }));
    const engine = new ContextEngine(1470, 956, 2, {
      windowEngine: { refresh },
      capturer: { captureActiveWindow },
    });

    const started = await engine.enableSession();
    expect(started.contextScope).toBe("app");
    current = windowContext({ appName: "Other App", bundleId: "com.example.other" });
    const blocked = await engine.refresh();
    expect(blocked?.access).toBe("blocked");

    const approved = await engine.approveSessionContext();
    expect(approved.access).toBe("active");
    expect(approved.contextScope).toBe("session");
    current = windowContext({ appName: "Third App", bundleId: "com.example.third" });
    const followed = await engine.refresh();
    expect(followed?.access).toBe("active");
    expect(followed?.approvedApp).toBe(true);
  });

  it("clears the snapshot when the session ends", async () => {
    const refresh = vi.fn(async () => windowContext());
    const engine = new ContextEngine(1470, 956, 2, { windowEngine: { refresh } });
    await engine.enableSession();

    const disabled = engine.disableSession();
    expect(disabled.access).toBe("disabled");
    expect(disabled.sessionId).toBeNull();
    expect(disabled.window).toBeNull();
    expect(disabled.references).toEqual([]);
  });

  it("drops a window result that finishes after the session is disabled", async () => {
    let resolveRefresh!: (value: WindowContext) => void;
    const refresh = vi.fn(() => new Promise<WindowContext>((resolve) => { resolveRefresh = resolve; }));
    const engine = new ContextEngine(1470, 956, 2, { windowEngine: { refresh } });
    const changes: string[] = [];
    engine.onChange((snapshot) => changes.push(snapshot.access));

    const enabling = engine.enableSession();
    expect(refresh).toHaveBeenCalledOnce();
    engine.disableSession();
    resolveRefresh(windowContext());
    await enabling;

    expect(engine.current()?.access).toBe("disabled");
    expect(changes).toEqual(["disabled"]);
  });

  it("takes one bounded screenshot when an approved window changes", async () => {
    let current = windowContext();
    const refresh = vi.fn(async () => current);
    const captureActiveWindow = vi.fn(async () => ({
      dataUrl: "data:image/png;base64,ZmFrZQ==",
      width: 512,
      height: 398,
    }));
    const engine = new ContextEngine(1470, 956, 2, {
      windowEngine: { refresh },
      capturer: { captureActiveWindow },
    });

    await engine.enableSession();
    expect(captureActiveWindow).not.toHaveBeenCalled();
    current = windowContext({ windowTitle: "A different document" });
    await engine.refresh();
    await Promise.resolve();

    expect(captureActiveWindow).toHaveBeenCalledOnce();
    expect(engine.current()?.capturedImageDataUrl).toContain("data:image/png");
  });

  it("merges an Accessibility observation into the bounded reference set", async () => {
    const refresh = vi.fn(async () => windowContext({ windowTitle: "Editor" }));
    const focusedElement: ContextReference = {
      id: "ax:editor:text-field",
      kind: "control",
      label: "Prompt field",
      appName: "Fixture Browser",
      source: "accessibility",
      observedAt: 123,
      text: "draft",
    };
    const semanticRead = vi.fn(async () => ({ focusedElement, selectedText: "draft", visibleText: "Editor" }));
    const engine = new ContextEngine(1470, 956, 2, {
      windowEngine: { refresh },
      semanticSource: { name: "test-ax", read: semanticRead },
    });

    await engine.enableSession();
    await Promise.resolve();
    await Promise.resolve();

    const current = engine.current();
    expect(semanticRead).toHaveBeenCalledOnce();
    expect(current?.focusedElement?.id).toBe(focusedElement.id);
    expect(current?.selectedText).toBe("draft");
    expect(current?.references.some((reference) => reference.id === focusedElement.id)).toBe(true);
    expect(current?.sources.find((source) => source.kind === "accessibility")?.state).toBe("available");
  });

  it("publishes a gaze anchor without creating a new context revision", async () => {
    const refresh = vi.fn(async () => windowContext());
    const engine = new ContextEngine(1470, 956, 2, { windowEngine: { refresh } });
    const snapshots: Array<{ revision: number; x: number }> = [];
    engine.onChange((snapshot) => snapshots.push({ revision: snapshot.revision, x: snapshot.attentionAnchor?.screenXNorm ?? -1 }));
    await engine.enableSession();
    const revision = engine.current()?.revision ?? -1;

    engine.setAttentionAnchor({ screenXNorm: 0.25, screenYNorm: 0.75, windowXNorm: 0.2, windowYNorm: 0.8, insideActiveWindow: true });

    expect(engine.current()?.attentionAnchor?.screenXNorm).toBe(0.25);
    expect(engine.current()?.revision).toBe(revision);
    expect(snapshots.at(-1)).toEqual({ revision, x: 0.25 });
  });
});
