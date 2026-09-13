import type OpenAI from "openai";
import type { ResponseInput, ResponseInputMessageContentList } from "openai/resources/responses/responses";
import { apiKey } from "../config";
import { CLARIFICATION_RESPONSE_JSON_SCHEMA, CLARIFICATION_SYSTEM_PROMPT, DECODER_RESPONSE_JSON_SCHEMA, DECODER_SYSTEM_PROMPT } from "./decoderPrompt";
import { validateClarification, validateDecoderResponse } from "./decoderSchema";
import type { DecoderInput, DecoderResponse } from "../../shared/types";

export type Clarification = NonNullable<DecoderResponse["clarification"]>;

export interface DecoderProvider {
  readonly name: string;
  warmup?(): Promise<void>;
  generateCandidates(input: DecoderInput): Promise<DecoderResponse>;
  repairCandidates?(
    input: DecoderInput,
    invalidResponse: DecoderResponse,
    validationErrors: string[]
  ): Promise<DecoderResponse>;
  generateClarification(input: DecoderInput): Promise<Clarification>;
}

export class OpenAILunaProvider {
  readonly name = "openai-luna";
  private client: OpenAI | null = null;
  private key: string;
  private model: string;

  constructor(model: string) {
    this.model = model;
    this.key = apiKey("OPENAI_API_KEY");
  }

  get available(): boolean {
    return this.key.length > 0;
  }

  private buildInput(input: DecoderInput) {
    const { capturedImageDataUrl: _capturedImageDataUrl, ...optionalContext } = input.optionalContext;
    return {
      currentPrompt: { displayPrompt: input.displayPrompt, explicitSemanticEvidence: input.explicitSemanticEvidence, hints: input.hints, rejectedSets: input.rejectedSets, historyDepth: input.historyDepth, userLexicon: input.userLexicon, optionalContext, consecutiveNoneCount: input.consecutiveNoneCount, clarificationAnswers: input.clarificationAnswers, turn: input.turn },
    };
  }

  private buildApiInput(input: DecoderInput): ResponseInput {
    const content: ResponseInputMessageContentList = [
      { type: "input_text", text: JSON.stringify(this.buildInput(input)) },
    ];
    if (input.optionalContext.capturedImageDataUrl) {
      content.push({ type: "input_image", image_url: input.optionalContext.capturedImageDataUrl, detail: "low" });
    }
    return [{ role: "user", content }];
  }

  private async getClient(): Promise<OpenAI> {
    if (!this.key) throw new Error("OpenAI decoder requires OPENAI_API_KEY.");
    if (!this.client) {
      const { default: OpenAIClient } = await import("openai");
      this.client = new OpenAIClient({ apiKey: this.key });
    }
    return this.client;
  }

  async generateCandidates(input: DecoderInput): Promise<DecoderResponse> {
    return this.requestCandidates(DECODER_SYSTEM_PROMPT, this.buildApiInput(input));
  }

  async repairCandidates(
    input: DecoderInput,
    invalidResponse: DecoderResponse,
    validationErrors: string[]
  ): Promise<DecoderResponse> {
    const repairInput: ResponseInput = [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: JSON.stringify({
              ...this.buildInput(input),
              invalidResponse,
              validationErrors,
            }),
          },
        ],
      },
    ];
    return this.requestCandidates(
      `${DECODER_SYSTEM_PROMPT}\n\nThe previous response failed local validation. Correct every listed error while preserving all explicit semantic evidence. Return a complete replacement response.`,
      repairInput
    );
  }

  private async requestCandidates(instructions: string, input: ResponseInput): Promise<DecoderResponse> {
    const client = await this.getClient();
    try {
      const response = await client.responses.create({
        model: this.model,
        tools: [],
        temperature: 0.4,
        reasoning: { effort: "none" },
        instructions,
        input,
        text: {
          format: {
            type: "json_schema",
            name: "decoder_response",
            schema: DECODER_RESPONSE_JSON_SCHEMA,
            strict: true,
          },
        },
      });
      const text = response.output_text;
      if (!text) throw new Error("empty decoder output_text");
      const parsed = crossParse(text);
      const validated = validateDecoderResponse(parsed);
      if (!validated.ok) {
        throw new Error(`decoder schema violation: ${validated.errors.join("; ")}`);
      }
      return normalized(validated.data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`OpenAI decoder failed: ${message}`);
    }
  }

  async generateClarification(input: DecoderInput): Promise<Clarification> {
    const client = await this.getClient();
    try {
      const response = await client.responses.create({
        model: this.model,
        tools: [],
        temperature: 0.4,
        reasoning: { effort: "none" },
        instructions: CLARIFICATION_SYSTEM_PROMPT,
        input: this.buildApiInput(input),
        text: {
          format: {
            type: "json_schema",
            name: "decoder_clarification",
            schema: CLARIFICATION_RESPONSE_JSON_SCHEMA,
            strict: true,
          },
        },
      });
      if (!response.output_text) throw new Error("empty clarification output_text");
      const validated = validateClarification(crossParse(response.output_text));
      if (!validated.ok) {
        throw new Error(`clarification schema violation: ${validated.errors.join("; ")}`);
      }
      return validated.data;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`OpenAI clarification failed: ${message}`);
    }
  }
}

function crossParse(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const target = fenced ? fenced[1] : trimmed;
  const start = target.indexOf("{");
  const end = target.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(target.slice(start, end + 1));
    } catch {
      // fall through
    }
  }
  try {
    return JSON.parse(target);
  } catch {
    throw new Error("unparseable decoder output");
  }
}

function normalized(data: DecoderResponse): DecoderResponse {
  return {
    mode: data.mode,
    normalizedPrompt: data.normalizedPrompt,
    promptIsExecutable: data.promptIsExecutable,
    openSlots: data.openSlots,
    candidates: data.candidates,
    clarification: data.clarification,
  };
}
