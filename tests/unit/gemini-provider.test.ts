import { describe, expect, it, vi } from "vitest";
import {
  GeminiFlashLiteProvider,
  GEMINI_CLARIFICATION_RESPONSE_SCHEMA,
  GEMINI_DECODER_RESPONSE_SCHEMA,
  type GeminiCreateParams,
  type GeminiInteraction,
  type GeminiInteractionClient,
  type GeminiContent,
} from "../../src/main/prompt-completion/GeminiFlashLiteProvider";
import { FixtureDecoderProvider } from "../../src/main/prompt-completion/FixtureDecoderProvider";
import {
  CLARIFICATION_SYSTEM_PROMPT,
  DECODER_SYSTEM_PROMPT,
} from "../../src/main/prompt-completion/decoderPrompt";
import { DEFAULT_LEXICON } from "../../src/main/prompt-completion/PromptCompletionEngine";
import type { DecoderInput } from "../../src/shared/types";

function inputWithImage(capturedImageDataUrl: string | null = null): DecoderInput {
  return {
    displayPrompt: "I want you to…",
    explicitSemanticEvidence: [],
    hints: [],
    rejectedSets: [],
    historyDepth: 0,
    userLexicon: DEFAULT_LEXICON,
    optionalContext: {
      activeApp: "Fixture Browser",
      activeAppUrl: "fixture://home",
      surfaceType: "generic_app",
      visibleReferent: null,
      gazeTargetDescription: null,
      capturedImageDataUrl,
    },
    consecutiveNoneCount: 0,
    clarificationAnswers: [],
    turn: 0,
  };
}

function fakeClient(response: GeminiInteraction) {
  const create = vi.fn(async (_params: GeminiCreateParams): Promise<GeminiInteraction> => response);
  return { client: { interactions: { create } } as GeminiInteractionClient, create };
}

describe("GeminiFlashLiteProvider", () => {
  it("sends a structured multimodal Interactions request and validates candidates", async () => {
    const fixtureResponse = new FixtureDecoderProvider().generate(inputWithImage());
    const { client, create } = fakeClient({ output_text: JSON.stringify(fixtureResponse) });
    const provider = new GeminiFlashLiteProvider("gemini-3.5-flash", { key: "test-key", client });

    const response = await provider.generateCandidates(inputWithImage("data:image/png;base64,aGk="));

    expect(provider.available).toBe(true);
    expect(response.candidates.length).toBeGreaterThanOrEqual(4);
    expect(create).toHaveBeenCalledTimes(1);
    const params = create.mock.calls[0][0];
    expect(params.model).toBe("gemini-3.5-flash");
    expect(params.system_instruction).toBe(DECODER_SYSTEM_PROMPT);
    expect(params.generation_config).toEqual({
      thinking_level: "minimal",
      max_output_tokens: 2048,
    });
    expect(params.response_format).toEqual({
      type: "text",
      mime_type: "application/json",
      schema: GEMINI_DECODER_RESPONSE_SCHEMA,
    });
    expect(Array.isArray(params.input)).toBe(true);
    const parts = params.input as GeminiContent[];
    expect(parts[0]).toEqual({ type: "image", mime_type: "image/png", data: "aGk=" });
    const textPart = parts.find((part): part is { type: "text"; text: string } => part.type === "text");
    expect(textPart?.text).toContain('"displayPrompt":"I want you to…"');
    expect(textPart?.text).not.toContain("capturedImageDataUrl");
  });

  it("accepts model output from an interaction step when output_text is absent", async () => {
    const fixtureResponse = new FixtureDecoderProvider().generate(inputWithImage());
    const { client } = fakeClient({
      steps: [{ type: "model_output", content: [{ type: "text", text: `\n\n${JSON.stringify(fixtureResponse)}\n` }] }],
    });
    const provider = new GeminiFlashLiteProvider("gemini-3.5-flash", { key: "test-key", client });

    const response = await provider.generateCandidates(inputWithImage());

    expect(response.normalizedPrompt).toBe("I want you to…");
  });

  it("uses the structured clarification seam without a repair request", async () => {
    const fixture = new FixtureDecoderProvider();
    const clarification = await fixture.generateClarification(inputWithImage());
    const first = fakeClient({ output_text: JSON.stringify(clarification) });
    const provider = new GeminiFlashLiteProvider("gemini-3.5-flash", { key: "test-key", client: first.client });

    const result = await provider.generateClarification(inputWithImage());

    expect(result.answers).toHaveLength(4);
    expect(first.create.mock.calls[0][0].system_instruction).toBe(CLARIFICATION_SYSTEM_PROMPT);
    expect(first.create.mock.calls[0][0].response_format).toEqual({
      type: "text",
      mime_type: "application/json",
      schema: GEMINI_CLARIFICATION_RESPONSE_SCHEMA,
    });

    expect(first.create).toHaveBeenCalledTimes(1);
  });

  it("fails clearly without a Gemini API key or when output violates the local schema", async () => {
    const missingKey = new GeminiFlashLiteProvider("gemini-3.5-flash", { key: "" });
    await expect(missingKey.generateCandidates(inputWithImage())).rejects.toThrow("GEMINI_API_KEY");

    const { client } = fakeClient({ output_text: JSON.stringify({ mode: "predict" }) });
    const invalid = new GeminiFlashLiteProvider("gemini-3.5-flash", { key: "test-key", client });
    await expect(invalid.generateCandidates(inputWithImage())).rejects.toThrow("decoder schema violation");
  });
});
