import { describe, expect, it, vi } from "vitest";
import { FallbackDecoderProvider } from "../../src/main/prompt-completion/FallbackDecoderProvider";
import type { DecoderProvider } from "../../src/main/prompt-completion/CandidateGenerator";
import type { DecoderInput, DecoderResponse } from "../../src/shared/types";

const input = {} as DecoderInput;
const response = {} as DecoderResponse;

function provider(name: string, implementation: Partial<DecoderProvider> = {}): DecoderProvider {
  return {
    name,
    generateCandidates: vi.fn(async () => response),
    generateClarification: vi.fn(async () => ({ spokenQuestion: "Which?", answers: [] })),
    ...implementation,
  };
}

describe("FallbackDecoderProvider", () => {
  it("uses Gemini when the primary candidate request fails", async () => {
    const primary = provider("primary", {
      generateCandidates: vi.fn(async () => { throw new Error("primary unavailable"); }),
    });
    const fallback = provider("gemini-fallback");
    const decoder = new FallbackDecoderProvider(primary, fallback);

    await expect(decoder.generateCandidates(input)).resolves.toBe(response);
    expect(fallback.generateCandidates).toHaveBeenCalledOnce();
  });

  it("does not call Gemini when the primary succeeds", async () => {
    const primary = provider("primary");
    const fallback = provider("gemini-fallback");
    const decoder = new FallbackDecoderProvider(primary, fallback);

    await decoder.generateCandidates(input);

    expect(primary.generateCandidates).toHaveBeenCalledOnce();
    expect(fallback.generateCandidates).not.toHaveBeenCalled();
  });
});
