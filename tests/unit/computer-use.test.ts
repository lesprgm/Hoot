import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAIComputerUseExecutor, parseCompletionSummary } from "../../src/main/executor/OpenAIComputerUseExecutor";

const keyboardMocks = vi.hoisted(() => ({
  pressKey: vi.fn(async () => {}),
  releaseKey: vi.fn(async () => {}),
}));

vi.mock("@nut-tree-fork/nut-js", () => ({
  Key: { LeftCmd: 107, Space: 116 },
  keyboard: keyboardMocks,
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("OpenAI Computer Use availability", () => {
  it("requires a non-blank OPENAI_API_KEY without contacting OpenAI", () => {
    vi.stubEnv("OPENAI_API_KEY", "   ");
    expect(new OpenAIComputerUseExecutor("gpt-6-astra", 1470, 956).available).toBe(false);

    vi.stubEnv("OPENAI_API_KEY", "test-key");
    expect(new OpenAIComputerUseExecutor("gpt-6-astra", 1470, 956).available).toBe(true);
  });

  it("fails before screen capture when the key is missing", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const executor = new OpenAIComputerUseExecutor("gpt-6-astra", 1470, 956);

    await expect(executor.start(
      { taskId: "test-task", naturalLanguagePrompt: "inspect the current screen", startedAt: Date.now(), mode: "live" },
      {
        onEvent: () => {},
        requestConsequentialConfirmation: async () => false,
        requestSteering: async () => "stop",
        onComplete: () => {},
      },
    )).rejects.toThrow("OpenAI executor requires OPENAI_API_KEY");
  });

  it("releases a shortcut in the same natural order used to press it", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    const executor = new OpenAIComputerUseExecutor("gpt-6-astra", 1470, 956);
    const performLocal = (executor as unknown as {
      performLocal(action: { type: "keypress"; keys: string[] }): Promise<void>;
    }).performLocal.bind(executor);

    await performLocal({ type: "keypress", keys: ["CMD", "SPACE"] });

    expect(keyboardMocks.pressKey).toHaveBeenCalledWith(107, 116);
    expect(keyboardMocks.releaseKey).toHaveBeenCalledWith(107, 116);
  });

  it("requires an explicit completion status", () => {
    expect(parseCompletionSummary("SUCCESS: Calculator is visibly open.")).toEqual({
      status: "success",
      summary: "Calculator is visibly open.",
    });
    expect(parseCompletionSummary("FAILED: Calculator is not visible.")).toEqual({
      status: "failed",
      summary: "Calculator is not visible.",
    });
    expect(() => parseCompletionSummary("Calculator is open.")).toThrow("expected SUCCESS: or FAILED:");
  });
});
