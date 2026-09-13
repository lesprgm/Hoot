import type { DecoderResponseShape, RawCandidateShape, DecoderInputShape } from "./decoderSchema";
import type { DisplayOptionType } from "../../shared/types";
import { requiresLexicalPreservation } from "./SemanticIntent";

const FILLER_WORDS = new Set(["the", "a", "an", "to", "and", "please", "can you", "can", "for", "of", "in", "on"]);

interface EvidenceRequirement {
  term: string;
  alternatives: readonly string[];
}

export interface ValidationReport {
  valid: boolean;
  errors: string[];
  flaggedIntroducing: string[];
  candidates: RawCandidateShape[];
}

function words(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function evidenceRequirements(semanticEvidence: string[]): EvidenceRequirement[] {
  const out = new Map<string, EvidenceRequirement>();
  for (const e of semanticEvidence) {
    // Evidence is machine-facing, e.g. "action=find" or "recipient=Daniel":
    // the KEY is metadata; only the VALUE carries user meaning to preserve.
    if (!requiresLexicalPreservation(e)) continue;
    const valuePart = e;
    for (const part of valuePart.split(/[,;]/).map((p) => p.trim())) {
      if (!part) continue;
      if (part.startsWith("<") && part.endsWith(">")) continue;
      for (const w of words(part)) {
        if (w.length < 3 || FILLER_WORDS.has(w)) continue;
        out.set(w, { term: w, alternatives: [w] });
      }
    }
  }
  return Array.from(out.values());
}

function lexicallyContained(prompt: string, alternatives: readonly string[]): boolean {
  const promptLower = prompt.toLowerCase();
  const promptWords = words(promptLower);
  return alternatives.some((term) => (
    promptWords.includes(term) || (term.length >= 5 && promptLower.includes(term))
  ));
}

export class CandidateValidator {
  validate(input: DecoderInputShape, response: DecoderResponseShape): ValidationReport {
    const errors: string[] = [];
    const flagged: string[] = [];
    const requirements = evidenceRequirements(input.explicitSemanticEvidence);
    const kept: RawCandidateShape[] = [];

    for (const requirement of requirements) {
      if (!lexicallyContained(response.normalizedPrompt, requirement.alternatives)) {
        errors.push(`normalizedPrompt lost evidence: "${requirement.term}"`);
      }
    }

    const ids = new Set<string>();

    for (const candidate of response.candidates) {
      const candidateErrors: string[] = [];
      const wordsInLabel = words(candidate.label);
      if (wordsInLabel.length > 7) candidateErrors.push(`label too long: "${candidate.label}"`);
      if (!candidate.label.trim()) candidateErrors.push("empty label");
      if (!candidate.resultingPrompt.trim()) candidateErrors.push("empty resultingPrompt");
      // `continuation` is machine-facing evidence and may contain compact
      // identifiers or URLs that are longer than the visible prompt text.
      // Evidence preservation below validates the user-facing result.
      if (!Number.isFinite(candidate.modelScore) || candidate.modelScore < 0 || candidate.modelScore > 1) {
        candidateErrors.push("modelScore out of range");
      }
      if (ids.has(candidate.id)) candidateErrors.push(`duplicate candidate id: "${candidate.id}"`);
      ids.add(candidate.id);
      for (const requirement of requirements) {
        if (!lexicallyContained(candidate.resultingPrompt, requirement.alternatives)) {
          candidateErrors.push(`resultingPrompt lost evidence: "${requirement.term}"`);
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
