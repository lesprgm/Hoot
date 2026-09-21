import type { DecoderInput, DecoderResponse } from "../../shared/types";
import type { DecoderRequestOptions } from "./DecoderRequestCoordinator";
import { isDecoderTransportFailure, type Clarification, type DecoderProvider } from "./DecoderProvider";

/**
 * Explicit decoder policy: the OpenRouter DeepSeek primary uses the direct
 * Gemini API only after a typed transport failure. Invalid output,
 * cancellation, timeout, configuration, and validation errors remain visible
 * to the caller.
 */
export class DirectGeminiFallbackProvider implements DecoderProvider {
  readonly name: string;

  constructor(
    private readonly primary: DecoderProvider,
    private readonly fallback: DecoderProvider,
  ) {
    this.name = `${primary.name}+${fallback.name}-transport-fallback`;
  }

  get available(): boolean {
    return this.primary.available !== false;
  }

  async warmup(): Promise<void> {
    await this.primary.warmup?.();
  }

  generateCandidates(input: DecoderInput, options?: DecoderRequestOptions): Promise<DecoderResponse> {
    return this.withFallback(
      "candidates",
      () => this.primary.generateCandidates(input, options),
      () => this.fallback.generateCandidates(input, options),
      options,
    );
  }

  generateClarification(input: DecoderInput, options?: DecoderRequestOptions): Promise<Clarification> {
    return this.withFallback(
      "clarification",
      () => this.primary.generateClarification(input, options),
      () => this.fallback.generateClarification(input, options),
      options,
    );
  }

  private async withFallback<T>(
    kind: string,
    primaryRequest: () => Promise<T>,
    fallbackRequest: () => Promise<T>,
    options?: DecoderRequestOptions,
  ): Promise<T> {
    try {
      return await primaryRequest();
    } catch (error) {
      if (!isDecoderTransportFailure(error) || options?.signal.aborted) throw error;
      console.warn(`[decoder] ${JSON.stringify({ event: "transport_fallback", from: this.primary.name, to: this.fallback.name, kind })}`);
      return fallbackRequest();
    }
  }
}
