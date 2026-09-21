import { randomUUID } from "node:crypto";
import { createTaskRecord, reduceTask, type TaskEvent, type TaskRecord } from "../../shared/task";
import type { ContextSnapshot } from "../../shared/types";

/** Single in-memory authority for accepted task meaning and execution state. */
export class TaskStore {
  private currentTask: TaskRecord | null = null;
  private listeners = new Set<(task: TaskRecord | null) => void>();

  current(): TaskRecord | null {
    return this.currentTask ? structuredClone(this.currentTask) : null;
  }

  onChange(listener: (task: TaskRecord | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispatch(event: TaskEvent): TaskRecord | null {
    this.currentTask = reduceTask(this.currentTask, event);
    const snapshot = this.current();
    for (const listener of this.listeners) listener(snapshot);
    return snapshot;
  }

  create(goal: string | null = null): TaskRecord {
    this.currentTask = createTaskRecord(goal, randomUUID());
    if (goal) this.currentTask.revision = 1;
    const snapshot = this.current();
    for (const listener of this.listeners) listener(snapshot);
    return snapshot!;
  }

  discard(): void {
    this.dispatch({ type: "discard" });
  }

  observeContext(snapshot: ContextSnapshot): TaskRecord | null {
    if (!this.currentTask) return null;
    return this.dispatch({ type: "observe_context", snapshot });
  }
}
