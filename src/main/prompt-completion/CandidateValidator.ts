import type { DecoderResponseShape, RawCandidateShape, DecoderInputShape } from "./decoderSchema";
import type { DecoderInput, DecoderResponse } from "../../shared/types";
import type { IntentFrame, IntentPatch } from "../../shared/intent";

export interface ValidationReport {
  valid: boolean;
  errors: string[];
  flaggedIntroducing: string[];
  candidates: RawCandidateShape[];
}

/**
 * Validates the decoder's typed envelope before host-side ranking. The
 * validator intentionally does not compare generated wording with evidence.
 */
export class CandidateValidator {
  validateSemantic(
    input: DecoderInput | DecoderInputShape,
    response: DecoderResponse | DecoderResponseShape,
    frame: IntentFrame,
  ): ValidationReport {
    const errors: string[] = [];
    const flagged: string[] = [];
    const kept: RawCandidateShape[] = [];
    const ids = new Set<string>();

    for (const candidate of response.candidates) {
      const candidateErrors: string[] = [];
      if (!candidate.id.trim()) candidateErrors.push("empty candidate id");
      if (!candidate.label.trim()) candidateErrors.push("empty label");
      if (wordCount(candidate.label) > 7) candidateErrors.push(`label too long: "${candidate.label}"`);
      if (!candidate.resultingPrompt.trim()) candidateErrors.push("empty resultingPrompt");
      if (!Number.isFinite(candidate.modelScore) || candidate.modelScore < 0 || candidate.modelScore > 1) candidateErrors.push("modelScore out of range");
      if (ids.has(candidate.id)) candidateErrors.push(`duplicate candidate id: "${candidate.id}"`);
      ids.add(candidate.id);
      if (candidate.intentPatch !== undefined && !validPatch(candidate.intentPatch as IntentPatch)) candidateErrors.push(`invalid intentPatch: "${candidate.id}"`);
      if (candidateErrors.length === 0) kept.push(candidate);
      else errors.push(...candidateErrors);
      if (candidate.introducesNewMeaning) flagged.push(`model proposed new meaning for "${candidate.label}"`);
    }

    if (kept.length === 0) errors.push("decoder returned no usable semantic hypotheses");
    // These values are available for typed constraints in future capability
    // validators. They must not reintroduce lexical evidence checks.
    void input;
    void frame;
    return { valid: errors.length === 0, errors, flaggedIntroducing: flagged, candidates: kept };
  }
}

function wordCount(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

function validPatch(patch: IntentPatch): boolean {
  return Object.entries(patch).every(([key, value]) => {
    if (!key.trim() || key.length > 80) return false;
    const values = Array.isArray(value) ? value : [value];
    return values.every((item) => {
      if (item === null || typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
        return typeof item !== "string" || item.length <= 400;
      }
      return typeof item === "object" && typeof item.value === "string" && item.value.length <= 400;
    });
  });
}
