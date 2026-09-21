import { describe, expect, it, vi } from "vitest";
import { OpenRouterDeepSeekProvider, readContent } from "../../src/main/prompt-completion/OpenRouterDeepSeekProvider";
import { FixtureDecoderProvider } from "../../src/main/prompt-completion/FixtureDecoderProvider";
import { DEFAULT_LEXICON } from "../../src/main/prompt-completion/IntentCompositionEngine";
import type { DecoderInput } from "../../src/shared/types";

function decoderInput(): DecoderInput {
  return {
    displayPrompt: "I want you to…",
    explicitSemanticEvidence: [],
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
  it("requests structured output with latency routing and explicit no-fallback policy", async () => {
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
    expect(body.provider).toEqual({ sort: "latency", allow_fallbacks: false, require_parameters: true });
    expect(body.reasoning).toEqual({ effort: "none", exclude: true });
    expect(body.response_format.type).toBe("json_schema");
    expect(body.messages[1].content).not.toContain("capturedImageDataUrl");
  });

  it("fails explicitly when its key is missing", async () => {
    const provider = new OpenRouterDeepSeekProvider("deepseek/deepseek-v4-flash-0731", { key: "" });
    await expect(provider.generateCandidates(decoderInput())).rejects.toThrow("OPENROUTER_API_KEY");
  });

  it("sends a screenshot only when the selected OpenRouter model is vision-capable", async () => {
    const fixture = new FixtureDecoderProvider().generate(decoderInput());
    const request = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(fixture) } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const provider = new OpenRouterDeepSeekProvider("deepseek/deepseek-v4-flash-vision-exp", {
      key: "test-key",
      request,
    });

    await provider.generateCandidates(decoderInput());

    const [, init] = request.mock.calls[0];
    const body = JSON.parse(String(init?.body));
    expect(Array.isArray(body.messages[1].content)).toBe(true);
    expect(body.messages[1].content[1]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,aGk=" },
    });
  });

  it("parses split SSE UTF-8 chunks and requires the terminal marker", async () => {
    const payload = JSON.stringify({ choices: [{ delta: { content: '{"mode":"predict",' } }] });
    const payload2 = JSON.stringify({ choices: [{ delta: { content: '"normalizedPrompt":"ok"}' } }] });
    const chunks = [`data: ${payload.slice(0, 24)}`, `${payload.slice(24)}\n\ndata: ${payload2}\n\n`, "data: [DONE]\n\n"];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    });
    const content = await readContent(new Response(stream, { headers: { "Content-Type": "text/event-stream" } }), { requestId: "test", signal: new AbortController().signal, deadlineAt: Date.now() + 1_000 });

    expect(content).toBe('{"mode":"predict","normalizedPrompt":"ok"}');

    const noTerminal = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${payload}\n\n`));
        controller.close();
      },
    });
    await expect(readContent(new Response(noTerminal, { headers: { "Content-Type": "text/event-stream" } }), { requestId: "test", signal: new AbortController().signal, deadlineAt: Date.now() + 1_000 })).rejects.toThrow("[DONE]");
  });

  it("surfaces in-stream errors and aborts before reading another chunk", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"error":{"message":"rate limited"}}\n\n'));
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    await expect(readContent(new Response(stream, { headers: { "Content-Type": "text/event-stream" } }), { requestId: "test", signal: new AbortController().signal, deadlineAt: Date.now() + 1_000 })).rejects.toThrow("rate limited");

    const abort = new AbortController();
    abort.abort(new Error("cancelled"));
    const empty = new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
    await expect(readContent(new Response(empty, { headers: { "Content-Type": "text/event-stream" } }), { requestId: "test", signal: abort.signal, deadlineAt: Date.now() + 1_000 })).rejects.toThrow("cancelled");
  });
});
