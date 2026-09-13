import type { DecoderResponseShape, RawCandidateShape, DecoderInputShape } from "./decoderSchema";
import type { DisplayOptionType } from "../../shared/types";

const FILLER_WORDS = new Set(["the", "a", "an", "to", "and", "please", "can you", "can", "for", "of", "in", "on"]);

export interface ValidationReport {
  valid: boolean;
  errors: string[];
  flaggedIntroducing: string[];
  candidates: RawCandidateShape[];
}

function words(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function evidenceTerms(semanticEvidence: string[]): string[] {
  const out = new Set<string>();
  for (const e of semanticEvidence) {
    // Evidence is machine-facing, e.g. "action=find" or "recipient=Daniel":
    // the KEY is metadata; only the VALUE carries user meaning to preserve.
    const valuePart = e.includes("=") ? e.slice(e.indexOf("=") + 1) : e;
    for (const part of valuePart.split(/[,;]/).map((p) => p.trim())) {
      if (!part) continue;
      if (part.startsWith("<") && part.endsWith(">")) continue;
      for (const w of words(part)) {
        if (w.length < 3 || FILLER_WORDS.has(w)) continue;
        out.add(w);
      }
    }
  }
  return Array.from(out);
}

function lexicallyContained(prompt: string, term: string): boolean {
  const promptLower = prompt.toLowerCase();
  if (words(promptLower).includes(term)) return true;
  return term.length >= 5 && promptLower.includes(term);
}

export class CandidateValidator {
  validate(input: DecoderInputShape, response: DecoderResponseShape): ValidationReport {
    const errors: string[] = [];
    const flagged: string[] = [];
    const terms = evidenceTerms(input.explicitSemanticEvidence);
    const kept: RawCandidateShape[] = [];

    for (const term of terms) {
      if (!lexicallyContained(response.normalizedPrompt, term)) {
        errors.push(`normalizedPrompt lost evidence: "${term}"`);
      }
    }

    const ids = new Set<string>();

    for (const candidate of response.candidates) {
      const candidateErrors: string[] = [];
      const wordsInLabel = words(candidate.label);
      if (wordsInLabel.length > 7) candidateErrors.push(`label too long: "${candidate.label}"`);
      if (!candidate.label.trim()) candidateErrors.push("empty label");
      if (!candidate.resultingPrompt.trim()) candidateErrors.push("empty resultingPrompt");
      if (candidate.resultingPrompt.trim().length < candidate.continuation.length) {
        candidateErrors.push("resultingPrompt shorter than continuation");
      }
      if (!Number.isFinite(candidate.modelScore) || candidate.modelScore < 0 || candidate.modelScore > 1) {
        candidateErrors.push("modelScore out of range");
      }
      if (ids.has(candidate.id)) candidateErrors.push(`duplicate candidate id: "${candidate.id}"`);
      ids.add(candidate.id);
      for (const term of terms) {
        if (!lexicallyContained(candidate.resultingPrompt, term)) {
          candidateErrors.push(`resultingPrompt lost evidence: "${term}"`);
          break;
        }
      }
      if (candidateErrors.length === 0) kept.push(candidate);
      else errors.push(...candidateErrors);
    }

    const knownNames = new Set<string>(
      [...input.userLexicon.people, ...input.userLexicon.places, ...input.userLexicon.apps, ...input.userLexicon.customVocabulary].map((n) => n.toLowerCase())
    );
    const evidenceText = input.explicitSemanticEvidence.join(" ").toLowerCase();
    const hintText = input.hints.map((h) => h.text).join(" ").toLowerCase();
    const knownSlots = new Set(["find", "search", "create", "write", "open", "use", "send", "tell", "email", "play", "summarize", "summarise", "explain", "save", "download", "delete", "move", "cancel", "schedule", "stop", "start", "pause", "continue", "export", "print", "copy", "translate", "transcribe", "remember"]);

    for (const candidate of response.candidates) {
      const prompt = candidate.resultingPrompt.toLowerCase();
      for (const w of words(candidate.resultingPrompt)) {
        const clean = w.replace(/[^a-z]/g, "");
        if (clean.length < 4) continue;
        if (knownSlots.has(clean) || knownNames.has(clean) || knownNames.size === 0) continue;
        const inEvidence = evidenceText.includes(clean) || hintText.includes(clean);
        const inLabels = response.candidates.some((c) => c.label.toLowerCase() === clean || c.label.toLowerCase().includes(clean));
        if (!inEvidence && !inLabels) {
          flagged.push(`candidate "${candidate.label}" introduces unselected meaning "${clean}"`);
          break;
        }
      }
      if (candidate.introducesNewMeaning && !flagged.some((f) => f.includes(candidate.label))) {
        flagged.push(`flagged intents for "${candidate.label}"`);
      }
    }

    return {
      valid: kept.length >= 4 && errors.length === 0,
      errors,
      flaggedIntroducing: flagged,
      candidates: kept,
    };
  }
}

export function optionTypeFor(candidate: RawCandidateShape): DisplayOptionType {
  return candidate.type;
}
