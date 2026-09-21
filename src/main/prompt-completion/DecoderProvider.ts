import type { DecoderInput, DecoderResponse } from "../../shared/types";
import type { DecoderRequestOptions } from "./DecoderRequestCoordinator";

export type Clarification = NonNullable<DecoderResponse["clarification"]>;

export type DecoderFailureKind = "transport" | "configuration" | "protocol" | "validation";

/** A provider error with enough provenance for the explicit fallback policy. */
export class DecoderProviderError extends Error {
  readonly name = "DecoderProviderError";

  constructor(
    readonly provider: string,
    readonly kind: DecoderFailureKind,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export function isDecoderTransportFailure(error: unknown): error is DecoderProviderError {
  return error instanceof DecoderProviderError && error.kind === "transport";
}

/** Provider boundary used by the prompt engine and all decoder adapters. */
export interface DecoderProvider {
  readonly name: string;
  readonly available?: boolean;
  warmup?(): Promise<void>;
  generateCandidates(input: DecoderInput, options?: DecoderRequestOptions): Promise<DecoderResponse>;
  generateClarification(input: DecoderInput, options?: DecoderRequestOptions): Promise<Clarification>;
}
