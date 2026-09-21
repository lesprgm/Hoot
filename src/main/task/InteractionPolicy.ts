import type { DecisionKind } from "../../shared/types";
import type { TaskRecord } from "../../shared/task";
import type { PromptViewState } from "../../shared/types";

export interface InteractionPolicyInput {
  task: TaskRecord | null;
  current: PromptViewState | null;
  busy: boolean;
  taskAwareEnabled?: boolean;
}

export interface InteractionPolicyResult {
  kind: DecisionKind;
  reason: string;
  keepCurrentCards: boolean;
}

/** Pure policy for deciding which card family may be shown next. */
export function chooseInteractionPolicy(input: InteractionPolicyInput): InteractionPolicyResult {
  if (input.busy) return { kind: "compose", reason: "A bounded decoder request is pending.", keepCurrentCards: true };
  if (input.task?.execution.status === "awaiting_user") return { kind: "review", reason: "The task needs a user decision.", keepCurrentCards: false };
  if (input.taskAwareEnabled && input.task?.goal) return { kind: "task_actions", reason: "The accepted task has a goal.", keepCurrentCards: false };
  if (input.current?.mode === "clarify") return { kind: "clarify", reason: "The previous option sets were rejected.", keepCurrentCards: false };
  return { kind: "compose", reason: "No accepted task goal exists.", keepCurrentCards: false };
}
