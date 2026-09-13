import { apiKey } from "../config";
import {
  CLARIFICATION_RESPONSE_JSON_SCHEMA,
  CLARIFICATION_SYSTEM_PROMPT,
  DECODER_RESPONSE_JSON_SCHEMA,
  DECODER_SYSTEM_PROMPT,
} from "./decoderPrompt";
import { validateClarification, validateDecoderResponse } from "./decoderSchema";
import type { Clarification, DecoderProvider } from "./CandidateGenerator";
import type { DecoderInput, DecoderResponse } from "../../shared/types";

interface OpenRouterResponse {
  error?: { message?: string };
  choices?: Array<{ message?: { content?: string | null } }>;
}

export interface OpenRouterProviderOptions {
  key?: string;
  request?: typeof fetch;
}

/** OpenRouter chat-completions adapter for the latency-sensitive decoder. */
export class OpenRouterDeepSeekProvider implements DecoderProvider {
  readonly name = "openrouter-deepseek-v4-flash";
  private readonly key: string;
  private readonly request: typeof fetch;

  constructor(private readonly model: string, options: OpenRouterProviderOptions = {}) {
    this.key = options.key ?? apiKey("OPENROUTER_API_KEY");
    this.request = options.request ?? fetch;
  }

  get available(): boolean {
    return this.key.length > 0;
  }

  async generateCandidates(input: DecoderInput): Promise<DecoderResponse> {
    const parsed = await this.requestJson(
      DECODER_SYSTEM_PROMPT,
      this.buildInput(input),
      "decoder_response",
      DECODER_RESPONSE_JSON_SCHEMA,
    );
    const validated = validateDecoderResponse(parsed);
    if (!validated.ok) throw new Error(`OpenRouter decoder schema violation: ${validated.errors.join("; ")}`);
    return validated.data;
  }

  async repairCandidates(
    input: DecoderInput,
    invalidResponse: DecoderResponse,
    validationErrors: string[],
  ): Promise<DecoderResponse> {
    const parsed = await this.requestJson(
      `${DECODER_SYSTEM_PROMPT}\n\nCorrect the previous response using the supplied validation errors. Preserve every item of explicit semantic evidence. Return a complete replacement response.`,
      { ...this.buildInput(input), invalidResponse, validationErrors },
      "decoder_response",
      DECODER_RESPONSE_JSON_SCHEMA,
    );
    const validated = validateDecoderResponse(parsed);
    if (!validated.ok) throw new Error(`OpenRouter decoder repair schema violation: ${validated.errors.join("; ")}`);
    return validated.data;
  }

  async generateClarification(input: DecoderInput): Promise<Clarification> {
    const parsed = await this.requestJson(
      CLARIFICATION_SYSTEM_PROMPT,
      this.buildInput(input),
      "decoder_clarification",
      CLARIFICATION_RESPONSE_JSON_SCHEMA,
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
        hints: input.hints,
        rejectedSets: input.rejectedSets,
        historyDepth: input.historyDepth,
        userLexicon: input.userLexicon,
        optionalContext,
        consecutiveNoneCount: input.consecutiveNoneCount,
        clarificationAnswers: input.clarificationAnswers,
        turn: input.turn,
      },
    };
  }

  private async requestJson(
    system: string,
    input: Record<string, unknown>,
    schemaName: string,
    schema: unknown,
  ): Promise<unknown> {
    if (!this.key) throw new Error("OpenRouter decoder requires OPENROUTER_API_KEY.");

    let response: Response;
    try {
      response = await this.request("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.key}`,
          "Content-Type": "application/json",
          "X-OpenRouter-Title": "View",
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: JSON.stringify(input) },
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
            // OpenRouter may retry another host serving this exact model. The
            // request never supplies a fallback model identifier.
            allow_fallbacks: true,
            require_parameters: true,
          },
        }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`OpenRouter decoder request failed: ${message}`);
    }

    const payload = await response.json().catch(() => null) as OpenRouterResponse | null;
    if (!response.ok) {
      throw new Error(`OpenRouter decoder failed (${response.status}): ${payload?.error?.message ?? response.statusText}`);
    }
    const content = payload?.choices?.[0]?.message?.content;
    if (!content) throw new Error("OpenRouter decoder returned empty content.");
    try {
      return JSON.parse(content);
    } catch {
      throw new Error("OpenRouter decoder returned invalid JSON.");
    }
  }
}
