import { describe, expect, it, vi } from "vitest";
import { OpenRouterDeepSeekProvider } from "../../src/main/prompt-completion/OpenRouterDeepSeekProvider";
import { FixtureDecoderProvider } from "../../src/main/prompt-completion/FixtureDecoderProvider";
import { DEFAULT_LEXICON } from "../../src/main/prompt-completion/PromptCompletionEngine";
import type { DecoderInput } from "../../src/shared/types";

function decoderInput(): DecoderInput {
  return {
    displayPrompt: "I want you to…",
    explicitSemanticEvidence: [],
    hints: [],
    rejectedSets: [],
    historyDepth: 0,
    userLexicon: DEFAULT_LEXICON,
    optionalContext: {
      activeApp: "Spotify",
      activeAppUrl: null,
      surfaceType: "generic_app",
      visibleReferent: null,
      gazeTargetDescription: null,
      capturedImageDataUrl: "data:image/png;base64,aGk=",
    },
    consecutiveNoneCount: 0,
    clarificationAnswers: [],
    turn: 0,
  };
}

describe("OpenRouterDeepSeekProvider", () => {
  it("requests structured output with latency routing and same-model host failover", async () => {
    const fixture = new FixtureDecoderProvider().generate(decoderInput());
    const request = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(fixture) } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const provider = new OpenRouterDeepSeekProvider("deepseek/deepseek-v4-flash-0731", {
      key: "test-key",
      request,
    });

    const result = await provider.generateCandidates(decoderInput());

    expect(result.candidates.length).toBeGreaterThanOrEqual(4);
    const [, init] = request.mock.calls[0];
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe("deepseek/deepseek-v4-flash-0731");
    expect(body.provider).toEqual({ sort: "latency", allow_fallbacks: true, require_parameters: true });
    expect(body.reasoning).toEqual({ effort: "none", exclude: true });
    expect(body.response_format.type).toBe("json_schema");
    expect(body.messages[1].content).not.toContain("capturedImageDataUrl");
  });

  it("fails explicitly when its key is missing", async () => {
    const provider = new OpenRouterDeepSeekProvider("deepseek/deepseek-v4-flash-0731", { key: "" });
    await expect(provider.generateCandidates(decoderInput())).rejects.toThrow("OPENROUTER_API_KEY");
  });
});
