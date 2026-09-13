import type { Clarification, DecoderProvider } from "./CandidateGenerator";
import type { DecoderInput, DecoderResponse } from "../../shared/types";

/** Keeps a configured decoder primary while allowing Gemini to recover live sessions. */
export class FallbackDecoderProvider implements DecoderProvider {
  readonly name: string;

  constructor(
    private readonly primary: DecoderProvider,
    private readonly fallback: DecoderProvider,
  ) {
    this.name = `${primary.name}-with-${fallback.name}-fallback`;
  }

  async warmup(): Promise<void> {
    try {
      await this.primary.warmup?.();
    } catch (error) {
      if (!this.isAvailable(this.fallback)) throw error;
      console.warn(`[decoder] primary warmup failed; Gemini fallback will be used: ${messageOf(error)}`);
    }
  }

  async generateCandidates(input: DecoderInput): Promise<DecoderResponse> {
    try {
      return await this.primary.generateCandidates(input);
    } catch (primaryError) {
      if (!this.isAvailable(this.fallback)) throw primaryError;
      console.warn(`[decoder] primary candidate request failed; trying Gemini fallback: ${messageOf(primaryError)}`);
      return this.fallback.generateCandidates(input);
    }
  }

  async generateClarification(input: DecoderInput): Promise<Clarification> {
    try {
      return await this.primary.generateClarification(input);
    } catch (primaryError) {
      if (!this.isAvailable(this.fallback)) throw primaryError;
      console.warn(`[decoder] primary clarification request failed; trying Gemini fallback: ${messageOf(primaryError)}`);
      return this.fallback.generateClarification(input);
    }
  }

  async repairCandidates(
    input: DecoderInput,
    invalidResponse: DecoderResponse,
    validationErrors: string[],
  ): Promise<DecoderResponse> {
    if (this.primary.repairCandidates) {
      try {
        return await this.primary.repairCandidates(input, invalidResponse, validationErrors);
      } catch (primaryError) {
        if (!this.isAvailable(this.fallback)) throw primaryError;
        console.warn(`[decoder] primary repair failed; trying Gemini fallback: ${messageOf(primaryError)}`);
      }
    }
    return this.fallback.generateCandidates(input);
  }

  private isAvailable(provider: DecoderProvider): boolean {
    return "available" in provider ? Boolean((provider as { available?: boolean }).available) : true;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
