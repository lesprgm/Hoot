import type { ContextLedgerEntry } from "../context/ContextLedger";
import { TargetResolver } from "../context/TargetResolver";
import type { IntentFrame, IntentPatch, IntentPatchValue } from "../../shared/intent";
import type { DecoderInput, DisplayOption, QuadrantId, RawCandidate } from "../../shared/types";

const QUADRANTS: QuadrantId[] = ["A", "B", "C", "D"];

export interface CandidateRankerInput {
  candidates: RawCandidate[];
  frame: IntentFrame;
  decoderInput?: DecoderInput;
  context?: ContextLedgerEntry[];
  resolver?: TargetResolver;
}

export interface CandidateRankerResult {
  display: DisplayOption[];
  ranked: RawCandidate[];
  rejected: Array<{ id: string; reason: string }>;
}

/**
 * Turns a decoder hypothesis pool into the four gaze cards. The ranker uses
 * deterministic evidence and diversity rules; modelScore is not a probability
 * and never overrides an explicit user value.
 */
export class CandidateRanker {
  rank(input: CandidateRankerInput): CandidateRankerResult {
    const resolver = input.resolver ?? new TargetResolver();
    const context = input.context ?? [];
    const rejected: Array<{ id: string; reason: string }> = [];
    const unique: RawCandidate[] = [];
    const seenSemantic = new Set<string>();
    const rejectedLabels = new Set((input.decoderInput?.rejectedSets ?? []).flatMap((set) => set.labels).map(normalizeLabel));

    for (const candidate of input.candidates) {
      if (rejectedLabels.has(normalizeLabel(candidate.label))) {
        rejected.push({ id: candidate.id, reason: "label was rejected in an earlier set" });
        continue;
      }
      const contradiction = explicitContradiction(candidate, input.frame);
      if (contradiction) {
        rejected.push({ id: candidate.id, reason: contradiction });
        continue;
      }
      const semanticKey = semanticIdentity(candidate);
      if (seenSemantic.has(semanticKey)) {
        rejected.push({ id: candidate.id, reason: "duplicate semantic hypothesis" });
        continue;
      }
      seenSemantic.add(semanticKey);
      unique.push(candidate);
    }

    const ordered = unique
      .map((candidate, index) => ({ candidate, index, contextBoost: contextRelevance(candidate, context, resolver, input.decoderInput) }))
      .sort((a, b) => b.contextBoost - a.contextBoost || a.index - b.index)
      .map((item) => item.candidate);

    const selected: RawCandidate[] = [];
    const groups = new Set<string>();
    for (const candidate of ordered) {
      const group = candidate.semanticGroup.trim().toLowerCase() || "ungrouped";
      if (groups.has(group) && selected.length < 4) continue;
      selected.push(candidate);
      groups.add(group);
      if (selected.length === 4) break;
    }
    // If all hypotheses share a group, fill remaining slots after the first pass.
    for (const candidate of ordered) {
      if (selected.length === 4) break;
      if (!selected.some((item) => item.id === candidate.id)) selected.push(candidate);
    }

    const display = selected.slice(0, 4).map((candidate, index) => {
      const resolvedReference = resolvedReferenceId(candidate, resolver, context, input.decoderInput);
      return {
        id: candidate.id,
        cardId: candidate.id,
        quadrant: QUADRANTS[index],
        label: candidate.label,
        resultingPrompt: candidate.resultingPrompt,
        type: candidate.type,
        semanticGroup: candidate.semanticGroup,
        continuation: candidate.continuation,
        operation: candidate.operation ?? candidate.continuation,
        referenceId: candidate.referenceId ?? resolvedReference,
        referenceRevision: candidate.referenceRevision,
        contextRevision: input.decoderInput?.optionalContext.contextRevision,
        intentPatch: candidate.intentPatch,
      };
    });
    return { display, ranked: ordered, rejected };
  }
}

function resolvedReferenceId(candidate: RawCandidate, resolver: TargetResolver, context: ContextLedgerEntry[], input?: DecoderInput): string | undefined {
  const patch = candidate.intentPatch ?? parsePatch(candidate.continuation);
  const target = patch.target;
  if (typeof target !== "string") return undefined;
  const resolved = resolver.resolveOne(target, null, context, input?.userLexicon);
  return resolved?.referenceId ?? resolved?.entityId;
}

function explicitContradiction(candidate: RawCandidate, frame: IntentFrame): string | null {
  const patch = candidate.intentPatch ?? parsePatch(candidate.continuation);
  for (const key of ["action", "target", "destination", "recipient", "service", "operation"]) {
    const value = patch[key];
    if (value === undefined) continue;
    const accepted = frame.fields[key]?.filter((item) => item.source === "user_selected" || item.source === "user_explicit") ?? [];
    if (accepted.length === 0) continue;
    // Multiple actions form an ordered task (for example find → summarize →
    // email), so a new action is additive rather than a contradiction.
    if (key === "action") continue;
    const values = Array.isArray(value) ? value : [value];
    const same = values.some((item) => item !== null && String(typeof item === "object" ? item.value : item).toLowerCase() === String(accepted[accepted.length - 1].value).toLowerCase());
    // Repeating a selected value is safe. A different value in a host-owned
    // field would rewrite user intent, so the hypothesis is rejected.
    if (!same && key !== "operation") return `contradicts explicit ${key}`;
  }
  return null;
}

function semanticIdentity(candidate: RawCandidate): string {
  if (candidate.intentPatch) return normalizePatch(candidate.intentPatch);
  const continuation = candidate.continuation.trim().toLowerCase();
  return `${candidate.semanticGroup.trim().toLowerCase()}|${continuation || candidate.resultingPrompt.trim().toLowerCase()}`;
}

function normalizePatch(patch: IntentPatch): string {
  return Object.keys(patch).sort().map((key) => `${key}=${valueString(patch[key])}`).join(";").toLowerCase();
}

function valueString(value: IntentPatchValue | IntentPatchValue[]): string {
  return (Array.isArray(value) ? value : [value]).map((item) => typeof item === "object" && item !== null ? item.value : String(item)).join(",");
}

function parsePatch(continuation: string): IntentPatch {
  const patch: IntentPatch = {};
  for (const part of continuation.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const key = part.slice(0, separator).trim().toLowerCase();
    const value = part.slice(separator + 1).trim();
    if (key && value) patch[key] = value;
  }
  return patch;
}

function contextRelevance(candidate: RawCandidate, context: ContextLedgerEntry[], resolver: TargetResolver, input?: DecoderInput): number {
  let score = 0;
  if (candidate.referenceId && context.some((entry) => entry.referenceId === candidate.referenceId || entry.id === candidate.referenceId)) score += 3;
  const patch = candidate.intentPatch ?? parsePatch(candidate.continuation);
  const target = patch.target;
  if (typeof target === "string" && resolver.resolveOne(target, undefined, context, input?.userLexicon)) score += 2;
  const hay = `${candidate.label} ${candidate.resultingPrompt}`.toLowerCase();
  if (context.some((entry) => hay.includes(entry.label.toLowerCase()) || (entry.appName ? hay.includes(entry.appName.toLowerCase()) : false))) score += 1;
  return score;
}

function normalizeLabel(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ");
}
