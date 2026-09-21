/**
 * Typed intent state shared by the decoder, card ranker, task compiler, and
 * executor boundary.  The decoder can propose values, but provenance decides
 * which value is authoritative.
 */

export type EvidenceSource =
  | "user_explicit"
  | "user_selected"
  | "resolved_entity"
  | "foreground_context"
  | "recent_context"
  | "background_context"
  | "model_inference";

export interface SemanticValue<T = unknown> {
  value: T;
  source: EvidenceSource;
  evidenceRef?: string;
  turn?: number;
}

export interface EntityValue extends SemanticValue<string> {
  entityId?: string;
  kind?: string;
  display?: string;
}

export interface AuthoredFragment {
  text: string;
  semanticFragment: string;
  source: EvidenceSource;
  turn: number;
}

export interface EvidenceRef {
  id: string;
  kind: "selection" | "context" | "model";
  source: EvidenceSource;
  observedAt: number;
  revision?: number | string;
}

export interface UnresolvedIntentSlot {
  name: string;
  description: string;
  required?: boolean;
}

export type IntentFrameState =
  | "forming"
  | "needs_clarification"
  | "semantically_complete"
  | "ready_for_execution";

/** A model proposal can contain arbitrary fields; the host gives them meaning. */
export type IntentPatchValue = string | number | boolean | null | { value: string; kind?: string; entityId?: string; display?: string };
export type IntentPatch = Record<string, IntentPatchValue | IntentPatchValue[]>;

export interface IntentFrame {
  /** Canonical values are stored in fields so new capabilities do not require a type migration. */
  fields: Record<string, SemanticValue<IntentPatchValue>[]>;
  authoredFragments: AuthoredFragment[];
  evidence: EvidenceRef[];
  unresolvedSlots: UnresolvedIntentSlot[];
  rejectedHypotheses: string[];
  state: IntentFrameState;
  goal?: SemanticValue<string>;
  action?: SemanticValue<string>;
  target?: EntityValue;
  destination?: EntityValue;
  content?: SemanticValue<string>;
}

const SOURCE_AUTHORITY: Record<EvidenceSource, number> = {
  model_inference: 1,
  background_context: 2,
  recent_context: 3,
  foreground_context: 4,
  resolved_entity: 5,
  user_selected: 6,
  user_explicit: 7,
};

export function authorityOf(source: EvidenceSource): number {
  return SOURCE_AUTHORITY[source];
}

export function createIntentFrame(): IntentFrame {
  return {
    fields: {},
    authoredFragments: [],
    evidence: [],
    unresolvedSlots: [],
    rejectedHypotheses: [],
    state: "forming",
  };
}

export function cloneIntentFrame(frame: IntentFrame): IntentFrame {
  return {
    ...frame,
    fields: Object.fromEntries(Object.entries(frame.fields).map(([key, values]) => [key, values.map((value) => ({ ...value }))])),
    authoredFragments: frame.authoredFragments.map((fragment) => ({ ...fragment })),
    evidence: frame.evidence.map((evidence) => ({ ...evidence })),
    unresolvedSlots: frame.unresolvedSlots.map((slot) => ({ ...slot })),
    rejectedHypotheses: [...frame.rejectedHypotheses],
    goal: frame.goal ? { ...frame.goal } : undefined,
    action: frame.action ? { ...frame.action } : undefined,
    target: frame.target ? { ...frame.target } : undefined,
    destination: frame.destination ? { ...frame.destination } : undefined,
    content: frame.content ? { ...frame.content } : undefined,
  };
}

/**
 * Applies one machine-facing semantic fragment.  The fragment is provenance
 * data, not natural-language text, so paraphrasing cannot erase its meaning.
 */
export function applySemanticFragment(
  frame: IntentFrame,
  fragment: string,
  source: EvidenceSource,
  turn: number,
  authoredText = fragment,
  evidenceRef?: string,
): IntentFrame {
  const next = cloneIntentFrame(frame);
  next.authoredFragments.push({ text: authoredText, semanticFragment: fragment, source, turn });
  next.evidence.push({ id: evidenceRef ?? `evidence:${turn}:${next.evidence.length}`, kind: "selection", source, observedAt: Date.now() });

  for (const rawPart of fragment.split(";")) {
    const part = rawPart.trim();
    if (!part) continue;
    const separator = part.indexOf("=");
    if (separator < 1) {
      if (part.toLowerCase() === "this") setField(next, "this", "true", source, turn, evidenceRef);
      continue;
    }
    const key = part.slice(0, separator).trim().toLowerCase();
    const rawValue = part.slice(separator + 1).trim();
    if (!key || !rawValue || (rawValue.startsWith("<") && rawValue.endsWith(">"))) continue;
    setField(next, key, rawValue, source, turn, evidenceRef);
  }
  next.state = deriveFrameState(next);
  return next;
}

/** Applies a structured proposal without trusting model wording. */
export function applyIntentPatch(
  frame: IntentFrame,
  patch: IntentPatch,
  source: EvidenceSource = "model_inference",
  turn = 0,
  evidenceRef?: string,
): IntentFrame {
  const next = cloneIntentFrame(frame);
  for (const [key, value] of Object.entries(patch)) {
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (item === null || item === "") continue;
      const stringValue = typeof item === "object" ? item.value : String(item);
      setField(next, key.toLowerCase(), stringValue, source, turn, evidenceRef, typeof item === "object" ? item : undefined);
    }
  }
  next.state = deriveFrameState(next);
  return next;
}

export function fieldValues(frame: IntentFrame, key: string): SemanticValue<IntentPatchValue>[] {
  return frame.fields[key.toLowerCase()] ?? [];
}

export function authoritativeValue(frame: IntentFrame, key: string): SemanticValue<IntentPatchValue> | undefined {
  return fieldValues(frame, key).slice().sort((a, b) => authorityOf(b.source) - authorityOf(a.source))[0];
}

export function deriveFrameState(frame: IntentFrame): IntentFrameState {
  if (frame.unresolvedSlots.some((slot) => slot.required !== false)) return "needs_clarification";
  const hasAction = Boolean(frame.action?.value || fieldValues(frame, "operation").length || fieldValues(frame, "action").length);
  if (!hasAction) return "forming";
  return "semantically_complete";
}

function setField(
  frame: IntentFrame,
  key: string,
  value: string,
  source: EvidenceSource,
  turn: number,
  evidenceRef?: string,
  entity?: { value: string; kind?: string; entityId?: string; display?: string },
): void {
  const current = frame.fields[key] ?? [];
  const duplicate = current.some((candidate) => String(candidate.value).toLowerCase() === value.toLowerCase() && candidate.source === source);
  if (!duplicate) current.push({ value, source, turn, evidenceRef });
  frame.fields[key] = current.slice(-16);

  const top = authoritativeValue(frame, key);
  if (key === "action" && top) frame.action = { value: String(top.value), source: top.source, turn: top.turn, evidenceRef: top.evidenceRef };
  if (key === "content" && top) frame.content = { value: String(top.value), source: top.source, turn: top.turn, evidenceRef: top.evidenceRef };
  if (key === "goal" && top) frame.goal = { value: String(top.value), source: top.source, turn: top.turn, evidenceRef: top.evidenceRef };
  if (key === "target" && top) frame.target = entityValue(top, entity);
  if (key === "destination" && top) frame.destination = entityValue(top, entity);
}

function entityValue(value: SemanticValue<IntentPatchValue>, entity?: { value: string; kind?: string; entityId?: string; display?: string }): EntityValue {
  return {
    value: String(value.value),
    source: value.source,
    turn: value.turn,
    evidenceRef: value.evidenceRef,
    kind: entity?.kind,
    entityId: entity?.entityId,
    display: entity?.display ?? String(value.value),
  };
}
