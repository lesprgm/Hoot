import { describe, expect, it, vi } from "vitest";
import type { DecoderInput, DecoderResponse } from "../../src/shared/types";
import { DecoderProviderError, type DecoderProvider } from "../../src/main/prompt-completion/DecoderProvider";
import { DirectGeminiFallbackProvider } from "../../src/main/prompt-completion/DirectGeminiFallbackProvider";

const input: DecoderInput = {
  displayPrompt: "I want you to…",
  explicitSemanticEvidence: [],
  rejectedSets: [],
  historyDepth: 0,
  userLexicon: { people: [], places: [], apps: [], recurringPhrases: [], customVocabulary: [] },
  optionalContext: {
    activeApp: null,
    activeAppUrl: null,
    surfaceType: null,
    visibleReferent: null,
    gazeTargetDescription: null,
    capturedImageDataUrl: null,
  },
  consecutiveNoneCount: 0,
  clarificationAnswers: [],
  turn: 0,
};

const response: DecoderResponse = {
  mode: "predict",
  normalizedPrompt: "I want you to…",
  promptIsExecutable: false,
  openSlots: [],
  candidates: [],
};

function provider(generateCandidates: DecoderProvider["generateCandidates"]): DecoderProvider {
  return {
    name: "test-provider",
    generateCandidates,
    generateClarification: vi.fn(async () => ({ spokenQuestion: "Which?", answers: [] })),
  };
}

describe("DirectGeminiFallbackProvider", () => {
  it("uses the direct Gemini provider only after a typed OpenRouter transport failure", async () => {
    const primary = provider(vi.fn(async () => {
      throw new DecoderProviderError("openrouter", "transport", "upstream unavailable");
    }));
    const fallback = provider(vi.fn(async () => response));
    const combined = new DirectGeminiFallbackProvider(primary, fallback);

    await expect(combined.generateCandidates(input)).resolves.toBe(response);
    expect(primary.generateCandidates).toHaveBeenCalledOnce();
    expect(fallback.generateCandidates).toHaveBeenCalledOnce();
  });

  it("does not hide protocol or validation failures", async () => {
    const error = new DecoderProviderError("openrouter", "protocol", "invalid JSON");
    const primary = provider(vi.fn(async () => { throw error; }));
    const fallback = provider(vi.fn(async () => response));
    const combined = new DirectGeminiFallbackProvider(primary, fallback);

    await expect(combined.generateCandidates(input)).rejects.toBe(error);
    expect(fallback.generateCandidates).not.toHaveBeenCalled();
  });

  it("does not start fallback work after cancellation", async () => {
    const primary = provider(vi.fn(async () => {
      throw new DecoderProviderError("openrouter", "transport", "connection reset");
    }));
    const fallback = provider(vi.fn(async () => response));
    const combined = new DirectGeminiFallbackProvider(primary, fallback);
    const controller = new AbortController();
    controller.abort();

    await expect(combined.generateCandidates(input, {
      requestId: "request",
      signal: controller.signal,
      deadlineAt: Date.now() + 1_000,
    })).rejects.toThrow("connection reset");
    expect(fallback.generateCandidates).not.toHaveBeenCalled();
  });
});
