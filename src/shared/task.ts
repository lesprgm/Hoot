import type { ContextReference, ContextSnapshot } from "./types";

export type TaskExecutionStatus =
  | "not_started"
  | "running"
  | "pause_requested"
  | "paused"
  | "awaiting_user"
  | "completed"
  | "failed"
  | "stopped";

export type TaskInteractionMode = "compose" | "task_actions" | "clarify" | "review" | "waiting" | "error";
export type TaskProvenance = "user_selected" | "observed" | "model_proposed";

export interface TaskRequirement {
  name: string;
  value: string;
  provenance: TaskProvenance;
  evidence?: string;
  revision: number;
}

export interface TaskReference {
  objectId: string;
  source: ContextReference["source"];
  locator: string;
  objectRevision?: string;
  observedAt: number;
  label: string;
}

export interface TaskArtifact {
  artifactId: string;
  revision: string;
  observation: string;
  verification: "unverified" | "observed" | "verified" | "user_accepted";
}

export interface TaskRecord {
  schemaVersion: 1;
  taskId: string;
  revision: number;
  goal: string | null;
  requirements: TaskRequirement[];
  references: TaskReference[];
  unansweredQuestions: string[];
  proposals: Array<{ operation: string; provenance: "model_proposed"; createdAt: number }>;
  artifacts: TaskArtifact[];
  execution: {
    status: TaskExecutionStatus;
    activeOperationId: string | null;
    checkpoint: string | null;
    pendingDecision: string | null;
  };
  interactionMode: TaskInteractionMode;
  updatedAt: number;
}

export type TaskEvent =
  | { type: "create"; taskId?: string; goal?: string | null; provenance?: TaskProvenance }
  | { type: "set_goal"; goal: string; provenance?: TaskProvenance; evidence?: string }
  | { type: "add_requirement"; name: string; value: string; provenance?: TaskProvenance; evidence?: string }
  | { type: "replace_requirement"; name: string; value: string; provenance?: TaskProvenance; evidence?: string }
  | { type: "select_reference"; reference: TaskReference }
  | { type: "observe_context"; snapshot: ContextSnapshot }
  | { type: "set_execution"; status: TaskExecutionStatus; operationId?: string | null; checkpoint?: string | null; pendingDecision?: string | null }
  | { type: "add_proposal"; operation: string }
  | { type: "artifact"; artifact: TaskArtifact }
  | { type: "discard" };

export function createTaskRecord(goal: string | null = null, taskId?: string): TaskRecord {
  const now = Date.now();
  return {
    schemaVersion: 1,
    taskId: taskId ?? cryptoRandomId(),
    revision: 0,
    goal,
    requirements: [],
    references: [],
    unansweredQuestions: [],
    proposals: [],
    artifacts: [],
    execution: { status: "not_started", activeOperationId: null, checkpoint: null, pendingDecision: null },
    interactionMode: goal ? "task_actions" : "compose",
    updatedAt: now,
  };
}

export function reduceTask(previous: TaskRecord | null, event: TaskEvent): TaskRecord | null {
  if (event.type === "discard") return null;
  let task = previous ?? createTaskRecord(null);
  const acceptedChange = event.type !== "observe_context" && event.type !== "add_proposal" && event.type !== "set_execution";
  if (event.type === "create") {
    task = createTaskRecord(event.goal ?? null, event.taskId);
    if (event.goal) task.proposals = event.provenance === "model_proposed" ? [{ operation: "set_goal", provenance: "model_proposed" as const, createdAt: Date.now() }] : [];
  } else if (event.type === "set_goal") {
    task.goal = event.goal;
    task.interactionMode = "task_actions";
  } else if (event.type === "add_requirement") {
    task.requirements = [...task.requirements, { name: event.name, value: event.value, provenance: event.provenance ?? "user_selected", evidence: event.evidence, revision: task.revision + 1 }];
  } else if (event.type === "replace_requirement") {
    const index = task.requirements.findIndex((requirement) => requirement.name === event.name);
    const next = { name: event.name, value: event.value, provenance: event.provenance ?? "user_selected", evidence: event.evidence, revision: task.revision + 1 };
    task.requirements = index < 0 ? [...task.requirements, next] : task.requirements.map((requirement, i) => i === index ? next : requirement);
  } else if (event.type === "select_reference") {
    task.references = task.references.some((reference) => reference.objectId === event.reference.objectId)
      ? task.references.map((reference) => reference.objectId === event.reference.objectId ? event.reference : reference)
      : [...task.references, event.reference];
  } else if (event.type === "observe_context") {
    task.references = mergeContextReferences(task.references, event.snapshot);
  } else if (event.type === "set_execution") {
    task.execution = {
      status: event.status,
      activeOperationId: event.operationId ?? task.execution.activeOperationId,
      checkpoint: event.checkpoint ?? task.execution.checkpoint,
      pendingDecision: event.pendingDecision ?? task.execution.pendingDecision,
    };
    task.interactionMode = event.status === "awaiting_user" ? "review" : event.status === "failed" ? "error" : task.interactionMode;
  } else if (event.type === "add_proposal") {
    task.proposals = [...task.proposals, { operation: event.operation, provenance: "model_proposed" as const, createdAt: Date.now() }].slice(-12);
  } else if (event.type === "artifact") {
    task.artifacts = [...task.artifacts.filter((artifact) => artifact.artifactId !== event.artifact.artifactId), event.artifact];
  }
  if (acceptedChange) task.revision += 1;
  task.updatedAt = Date.now();
  return task;
}

function mergeContextReferences(existing: TaskReference[], snapshot: ContextSnapshot): TaskReference[] {
  const incoming = snapshot.references.map((reference) => ({
    objectId: reference.id,
    source: reference.source,
    locator: reference.url ?? reference.id,
    objectRevision: reference.revision,
    observedAt: reference.observedAt,
    label: reference.label,
  }));
  const byId = new Map(existing.map((reference) => [reference.objectId, reference]));
  for (const reference of incoming) byId.set(reference.objectId, reference);
  return [...byId.values()].slice(-16);
}

function cryptoRandomId(): string {
  const globalCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return globalCrypto?.randomUUID?.() ?? `task_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}
