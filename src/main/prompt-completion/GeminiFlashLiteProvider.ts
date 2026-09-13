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

/** Gemini structured output currently rejects minItems/maxItems; Zod remains the enforcement point. */
export const GEMINI_DECODER_RESPONSE_SCHEMA = stripArrayBounds(DECODER_RESPONSE_JSON_SCHEMA);
export const GEMINI_CLARIFICATION_RESPONSE_SCHEMA = stripArrayBounds(CLARIFICATION_RESPONSE_JSON_SCHEMA);

/** The text and image content blocks accepted by Gemini's Interactions API. */
export type GeminiContent =
  | { type: "text"; text: string }
  | { type: "image"; data?: string; mime_type?: string; uri?: string };

export interface GeminiCreateParams {
  model: string;
  input: string | GeminiContent[];
  system_instruction?: string;
  response_format?: unknown;
  generation_config?: {
    thinking_level?: "minimal" | "low" | "medium" | "high";
    max_output_tokens?: number;
  };
}

export interface GeminiInteraction {
  output_text?: string;
  steps?: unknown[];
}

/** Small seam that keeps unit tests offline and avoids coupling the engine to SDK internals. */
export interface GeminiInteractionClient {
  interactions: {
    create(params: GeminiCreateParams): Promise<GeminiInteraction>;
  };
}

export interface GeminiFlashLiteProviderOptions {
  /** Override the environment key in tests or an embedding application. */
  key?: string;
  /** Inject a fake Interactions client for deterministic tests. */
  client?: GeminiInteractionClient;
}

/**
 * Gemini decoder adapter for the Flash model family.
 *
 * The adapter uses the current Interactions API, requests JSON structured output,
 * and keeps the existing local Zod and semantic validation gates in place.
 */
export class GeminiFlashLiteProvider implements DecoderProvider {
  readonly name = "gemini-flash";
  private readonly model: string;
  private readonly key: string;
  private client: GeminiInteractionClient | null;
  private clientPromise: Promise<GeminiInteractionClient> | null = null;

  constructor(model: string, options: GeminiFlashLiteProviderOptions = {}) {
    this.model = model;
    this.key = options.key ?? apiKey("GEMINI_API_KEY");
    this.client = options.client ?? null;
  }

  get available(): boolean {
    return this.key.length > 0;
  }

  async warmup(): Promise<void> {
    await this.getClient();
  }

  async generateCandidates(input: DecoderInput): Promise<DecoderResponse> {
    try {
      const parsed = await this.requestJson(
        DECODER_SYSTEM_PROMPT,
        this.buildApiInput(input),
        GEMINI_DECODER_RESPONSE_SCHEMA,
      );
      const validated = validateDecoderResponse(parsed);
      if (!validated.ok) {
        throw new Error(`decoder schema violation: ${validated.errors.join("; ")}`);
      }
      return validated.data;
    } catch (error) {
      throw this.wrapError("decoder", error);
    }
  }

  async generateClarification(input: DecoderInput): Promise<Clarification> {
    try {
      const parsed = await this.requestJson(
        CLARIFICATION_SYSTEM_PROMPT,
        this.buildApiInput(input),
        GEMINI_CLARIFICATION_RESPONSE_SCHEMA,
      );
      const validated = validateClarification(parsed);
      if (!validated.ok) {
        throw new Error(`clarification schema violation: ${validated.errors.join("; ")}`);
      }
      return validated.data;
    } catch (error) {
      throw this.wrapError("clarification", error);
    }
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

  private buildApiInput(input: DecoderInput): GeminiContent[] {
    const content: GeminiContent[] = [];
    const image = imageContent(input.optionalContext.capturedImageDataUrl);
    if (image) content.push(image);
    content.push({
      type: "text",
      text: JSON.stringify(this.buildInput(input)),
    });
    return content;
  }

  private async getClient(): Promise<GeminiInteractionClient> {
    if (!this.key) throw new Error("Gemini decoder requires GEMINI_API_KEY.");
    if (this.client) return this.client;
    if (!this.clientPromise) {
      this.clientPromise = import("@google/genai").then(({ GoogleGenAI }) => {
        const client = new GoogleGenAI({ apiKey: this.key }) as unknown as GeminiInteractionClient;
        this.client = client;
        return client;
      });
    }
    return this.clientPromise;
  }

  private async requestJson(
    instructions: string,
    input: GeminiContent[],
    schema: unknown,
  ): Promise<unknown> {
    const client = await this.getClient();
    const interaction = await client.interactions.create({
      model: this.model,
      system_instruction: instructions,
      input,
      generation_config: {
        // Semantic continuation is a low-reasoning, latency-sensitive task.
        // Gemini 3.5 Flash otherwise defaults to medium thinking.
        thinking_level: "minimal",
        max_output_tokens: 2048,
      },
      response_format: {
        type: "text",
        mime_type: "application/json",
        schema,
      },
    });
    const output = extractOutputText(interaction);
    if (!output) throw new Error("empty interaction output_text");
    return parseJsonObject(output);
  }

  private wrapError(label: string, error: unknown): Error {
    const message = error instanceof Error ? error.message : String(error);
    return new Error(`Gemini ${label} failed: ${message}`);
  }
}

function imageContent(dataUrl: string | null): GeminiContent | null {
  if (!dataUrl) return null;
  const dataMatch = dataUrl.match(/^data:([^;,]+)(?:;[^,]*)*;base64,([\s\S]*)$/i);
  if (dataMatch) {
    return { type: "image", mime_type: dataMatch[1], data: dataMatch[2] };
  }
  if (/^https?:\/\//i.test(dataUrl)) return { type: "image", uri: dataUrl };
  return null;
}

function stripArrayBounds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripArrayBounds);
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "minItems" || key === "maxItems") continue;
    result[key] = stripArrayBounds(child);
  }
  return result;
}

function extractOutputText(interaction: GeminiInteraction): string | null {
  if (typeof interaction.output_text === "string" && interaction.output_text.trim()) {
    return interaction.output_text;
  }

  for (const step of interaction.steps ?? []) {
    if (!step || typeof step !== "object") continue;
    const content = (step as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const text = (block as { text?: unknown }).text;
      if (typeof text === "string" && text.trim()) return text;
    }
  }
  return null;
}

function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const target = fenced ? fenced[1] : trimmed;
  const start = target.indexOf("{");
  const end = target.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(target.slice(start, end + 1));
    } catch {
      // Fall through to the complete payload so the caller gets one stable error.
    }
  }
  try {
    return JSON.parse(target);
  } catch {
    throw new Error("unparseable interaction output");
  }
}
