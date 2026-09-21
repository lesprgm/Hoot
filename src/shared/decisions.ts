import type {
  ContextSnapshot,
  DisplayOption,
  InteractionSnapshot,
  InteractionState,
  PromptViewState,
  SelectionEnvelope,
} from "./types";
import type { TaskRecord } from "./task";

/**
 * Operations that a decoder may propose. The host validates every operation
 * against this union and the host's supported operation IDs before accepting it.
 */
export type DecisionOperation =
  | { kind: "set_goal"; goal: string }
  | { kind: "add_requirement"; name: string; value: string }
  | { kind: "replace_requirement"; name: string; value: string }
  | { kind: "select_reference"; referenceId: string; referenceRevision?: string }
  | { kind: "invoke_capability"; capabilityId: string; referenceIds: string[]; arguments: Record<string, string | number | boolean> }
  | { kind: "inspect_artifact"; artifactId: string }
  | { kind: "task_action"; action: "continue" | "review" | "change" | "new" };

/**
 * Convert the compact operation strings emitted by existing decoder adapters
 * into host-owned operations. Unknown strings remain semantic evidence and do
 * not become executable capabilities.
 */
export function parseDecisionOperation(option: Pick<DisplayOption, "operation" | "continuation" | "referenceId" | "referenceRevision">): DecisionOperation | null {
  const raw = (option.operation ?? option.continuation ?? "").trim();
  if (!raw) return null;

  // A future adapter may return the typed operation as JSON while the current
  // adapters use the compact key=value form. Accept both forms at the seam.
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as Partial<DecisionOperation>;
      if (typeof parsed.kind !== "string") return null;
      if (parsed.kind === "set_goal" && typeof parsed.goal === "string") return parsed as DecisionOperation;
      if ((parsed.kind === "add_requirement" || parsed.kind === "replace_requirement") && typeof parsed.name === "string" && typeof parsed.value === "string") return parsed as DecisionOperation;
      if (parsed.kind === "select_reference" && typeof parsed.referenceId === "string") return parsed as DecisionOperation;
      if (parsed.kind === "inspect_artifact" && typeof parsed.artifactId === "string") return parsed as DecisionOperation;
      if (parsed.kind === "task_action" && ["continue", "review", "change", "new"].includes(String(parsed.action))) return parsed as DecisionOperation;
      if (parsed.kind === "invoke_capability" && typeof parsed.capabilityId === "string" && Array.isArray(parsed.referenceIds) && parsed.referenceIds.every((id) => typeof id === "string") && parsed.arguments && typeof parsed.arguments === "object") return parsed as DecisionOperation;
      return null;
    } catch {
      return null;
    }
  }

  const fields = Object.fromEntries(raw.split(";").flatMap((part) => {
    const separator = part.indexOf("=");
    if (separator <= 0) return [];
    return [[part.slice(0, separator).trim().toLowerCase(), part.slice(separator + 1).trim()]];
  }));
  const operation = fields.operation?.toLowerCase();
  if (operation) {
    const argumentsMap: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (key === "operation" || !value) continue;
      argumentsMap[key] = value;
    }
    // Semantic operations are dispatched through the generic computer-use
    // capability. The capability still decides whether the operation is
    // available; this parser never authorizes native actions.
    return {
      kind: "invoke_capability",
      capabilityId: "computer-use",
      referenceIds: option.referenceId ? [option.referenceId] : [],
      arguments: { operation, ...argumentsMap },
    };
  }

  const [kind, remainder] = raw.split(":", 2).map((part) => part.trim());
  if (kind === "set_goal" && remainder) return { kind, goal: remainder };
  if ((kind === "add_requirement" || kind === "replace_requirement") && remainder) {
    const separator = remainder.indexOf("=");
    if (separator > 0) return { kind, name: remainder.slice(0, separator).trim(), value: remainder.slice(separator + 1).trim() };
  }
  if (kind === "select_reference" && (option.referenceId || remainder)) return { kind, referenceId: option.referenceId ?? remainder, referenceRevision: option.referenceRevision };
  if (kind === "inspect_artifact" && remainder) return { kind, artifactId: remainder };
  if (kind === "task_action" && ["continue", "review", "change", "new"].includes(remainder)) return { kind, action: remainder as "continue" | "review" | "change" | "new" };
  return null;
}

/** Validate an operation without granting it execution authority. */
export function isDecisionOperation(value: unknown): value is DecisionOperation {
  if (!value || typeof value !== "object" || typeof (value as { kind?: unknown }).kind !== "string") return false;
  const operation = value as Partial<DecisionOperation>;
  switch (operation.kind) {
    case "set_goal": return typeof operation.goal === "string" && operation.goal.trim().length > 0;
    case "add_requirement":
    case "replace_requirement": return typeof operation.name === "string" && typeof operation.value === "string" && operation.name.trim().length > 0;
    case "select_reference": return typeof operation.referenceId === "string" && operation.referenceId.trim().length > 0;
    case "inspect_artifact": return typeof operation.artifactId === "string" && operation.artifactId.trim().length > 0;
    case "task_action": return ["continue", "review", "change", "new"].includes(operation.action as string);
    case "invoke_capability": return typeof operation.capabilityId === "string" && Array.isArray(operation.referenceIds) && operation.referenceIds.every((id) => typeof id === "string") && !!operation.arguments && typeof operation.arguments === "object";
    default: return false;
  }
}

export function asSelectionEnvelope(
  view: PromptViewState,
  cardId: string,
  interactionId: string,
): SelectionEnvelope | null {
  const option = view.options.find((candidate) => (candidate.cardId ?? candidate.id) === cardId);
  if (!option || !view.cardSetId || view.revision == null) return null;
  return {
    interactionId,
    sessionId: view.sessionId,
    cardSetId: view.cardSetId,
    cardId: option.cardId ?? option.id,
    expectedRevision: view.revision,
  };
}

export function isSelectionEnvelope(value: unknown): value is SelectionEnvelope {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SelectionEnvelope>;
  // The public IPC contract is card identity based. Reject the removed
  // quadrant payload explicitly so stale callers fail at the boundary.
  if ("quadrant" in candidate) return false;
  return typeof candidate.interactionId === "string"
    && typeof candidate.sessionId === "string"
    && typeof candidate.cardSetId === "string"
    && typeof candidate.cardId === "string"
    && Number.isInteger(candidate.expectedRevision);
}

export function makeInteractionSnapshot(args: {
  state: InteractionState;
  busy: boolean;
  prompt: PromptViewState | null;
  context: ContextSnapshot | null;
  task?: TaskRecord | null;
  revision: number;
  interactionId?: string | null;
  error?: string | null;
}): InteractionSnapshot {
  const prompt = args.prompt;
  return {
    sessionId: prompt?.sessionId ?? args.context?.sessionId ?? null,
    interactionId: args.interactionId ?? null,
    revision: args.revision,
    state: args.state,
    busy: args.busy,
    error: args.error ?? null,
    cardSetId: prompt?.cardSetId ?? null,
    prompt,
    context: args.context,
    task: args.task ?? null,
    utilities: {
      back: prompt?.canBack ?? false,
      more: prompt?.canMore ?? false,
      exit: prompt?.canExit ?? false,
    },
  };
}
