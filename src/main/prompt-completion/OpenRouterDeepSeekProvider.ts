import { apiKey } from "../config";
import {
  CLARIFICATION_RESPONSE_JSON_SCHEMA,
  CLARIFICATION_SYSTEM_PROMPT,
  DECODER_RESPONSE_JSON_SCHEMA,
  DECODER_SYSTEM_PROMPT,
} from "./decoderPrompt";
import { validateClarification, validateDecoderResponse } from "./decoderSchema";
import { DecoderProviderError, type Clarification, type DecoderProvider } from "./DecoderProvider";
import type { DecoderInput, DecoderResponse } from "../../shared/types";
import type { DecoderRequestOptions } from "./DecoderRequestCoordinator";

interface OpenRouterResponse {
  error?: { message?: string };
  choices?: Array<{ message?: { content?: string | null } }>;
}

export interface OpenRouterProviderOptions {
  key?: string;
  request?: typeof fetch;
  /** Override model-capability detection in integrations and tests. */
  sendImages?: boolean;
}

/** OpenRouter chat-completions adapter for the latency-sensitive decoder. */
export class OpenRouterDeepSeekProvider implements DecoderProvider {
  readonly name = "openrouter-deepseek-v4-flash";
  private readonly key: string;
  private readonly request: typeof fetch;
  private readonly sendImages: boolean;

  constructor(private readonly model: string, options: OpenRouterProviderOptions = {}) {
    this.key = options.key ?? apiKey("OPENROUTER_API_KEY");
    this.request = options.request ?? fetch;
    this.sendImages = options.sendImages ?? modelSupportsImages(model);
  }

  get available(): boolean {
    return this.key.length > 0;
  }

  async generateCandidates(input: DecoderInput, options?: DecoderRequestOptions): Promise<DecoderResponse> {
    const parsed = await this.requestJson(
      DECODER_SYSTEM_PROMPT,
      this.buildInput(input),
      "decoder_response",
      DECODER_RESPONSE_JSON_SCHEMA,
      input.optionalContext.capturedImageDataUrl,
      options,
    );
    const validated = validateDecoderResponse(parsed);
    if (!validated.ok) throw new Error(`OpenRouter decoder schema violation: ${validated.errors.join("; ")}`);
    return validated.data;
  }

  async generateClarification(input: DecoderInput, options?: DecoderRequestOptions): Promise<Clarification> {
    const parsed = await this.requestJson(
      CLARIFICATION_SYSTEM_PROMPT,
      this.buildInput(input),
      "decoder_clarification",
      CLARIFICATION_RESPONSE_JSON_SCHEMA,
      input.optionalContext.capturedImageDataUrl,
      options,
    );
    const validated = validateClarification(parsed);
    if (!validated.ok) throw new Error(`OpenRouter clarification schema violation: ${validated.errors.join("; ")}`);
    return validated.data;
  }

  private buildInput(input: DecoderInput): Record<string, unknown> {
    const { capturedImageDataUrl: _capturedImageDataUrl, ...optionalContext } = input.optionalContext;
    return {
      currentPrompt: {
        displayPrompt: input.displayPrompt,
        explicitSemanticEvidence: input.explicitSemanticEvidence,
        rejectedSets: input.rejectedSets,
        historyDepth: input.historyDepth,
        userLexicon: input.userLexicon,
        optionalContext,
        consecutiveNoneCount: input.consecutiveNoneCount,
        clarificationAnswers: input.clarificationAnswers,
        turn: input.turn,
        task: input.task ?? null,
        intentFrame: input.intentFrame ?? null,
      },
    };
  }

  private async requestJson(
    system: string,
    input: Record<string, unknown>,
    schemaName: string,
    schema: unknown,
    imageDataUrl: string | null = null,
    options?: DecoderRequestOptions,
  ): Promise<unknown> {
    if (!this.key) throw new DecoderProviderError(this.name, "configuration", "OpenRouter decoder requires OPENROUTER_API_KEY.");

    const userText = JSON.stringify(input);
    const userContent = this.sendImages && imageDataUrl
      ? [
          { type: "text", text: userText },
          { type: "image_url", image_url: { url: imageDataUrl } },
        ]
      : userText;
    let response: Response;
    try {
      response = await this.request("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.key}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          "X-OpenRouter-Title": "View",
        },
        signal: options?.signal,
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: userContent },
          ],
          temperature: 0.2,
          max_tokens: 2_048,
          reasoning: { effort: "none", exclude: true },
          response_format: {
            type: "json_schema",
            json_schema: { name: schemaName, strict: true, schema },
          },
          provider: {
            sort: "latency",
            // A provider failure must remain visible to the interaction
            // controller; do not silently route this request to another host.
            allow_fallbacks: false,
            require_parameters: true,
          },
          // Streaming lets the coordinator observe first content and cancel
          // obsolete work. The parser still buffers one complete JSON decision
          // before validation or display.
          stream: true,
        }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new DecoderProviderError(this.name, "transport", `OpenRouter decoder request failed: ${message}`, { cause: error });
    }

    if (!response.ok) {
      const payload = await response.json().catch(() => null) as OpenRouterResponse | null;
      const message = `OpenRouter decoder failed (${response.status}): ${payload?.error?.message ?? response.statusText}`;
      if (response.status === 408 || response.status === 429 || response.status >= 500) {
        throw new DecoderProviderError(this.name, "transport", message);
      }
      throw new DecoderProviderError(this.name, "protocol", message);
    }
    const content = await readContent(response, options, this.name);
    if (!content) throw new Error("OpenRouter decoder returned empty content.");
    try {
      return JSON.parse(content);
    } catch {
      throw new Error("OpenRouter decoder returned invalid JSON.");
    }
  }
}

export async function readContent(
  response: Response,
  options?: DecoderRequestOptions,
  providerName = "openrouter-deepseek-v4-flash",
): Promise<string | null> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!response.body || !contentType.includes("text/event-stream")) {
    const payload = await response.json().catch(() => null) as OpenRouterResponse | null;
    const content = payload?.choices?.[0]?.message?.content ?? null;
    return content;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let sawDone = false;
  try {
    while (true) {
      if (options?.signal.aborted) throw options.signal.reason ?? new Error("Decoder stream cancelled.");
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        if (data === "[DONE]") {
          sawDone = true;
          continue;
        }
        let event: { choices?: Array<{ delta?: { content?: string | null }; message?: { content?: string | null } }>; error?: { message?: string } };
        try { event = JSON.parse(data) as typeof event; } catch { continue; }
        if (event.error) throw new DecoderProviderError(providerName, "transport", event.error.message ?? "OpenRouter stream error");
        const delta = event.choices?.[0]?.delta?.content ?? event.choices?.[0]?.message?.content;
        if (delta) {
          content += delta;
        }
      }
    }
    buffer += decoder.decode();
    if (buffer.startsWith("data:")) {
      const data = buffer.slice(5).trim();
      if (data === "[DONE]") {
        sawDone = true;
      } else if (data) {
        try {
          const event = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string | null } }> };
          content += event.choices?.[0]?.delta?.content ?? "";
        } catch {
          // A trailing partial event is treated as an incomplete stream.
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  if (!sawDone) throw new DecoderProviderError(providerName, "transport", "OpenRouter decoder stream ended before [DONE].");
  return content || null;
}

function modelSupportsImages(model: string): boolean {
  const normalized = model.toLowerCase();
  // OpenRouter exposes image capability per model. The configured DeepSeek V4
  // Flash text model intentionally stays text-only; vision variants and other
  // common multimodal slugs opt into the multipart message shape.
  return normalized.includes("vision")
    || normalized.includes("-vl")
    || normalized.includes("gemini")
    || normalized.includes("claude")
    || normalized.includes("gpt-");
}
