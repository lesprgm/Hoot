import type { ConsequentialState, ExecutedTask, ExecutorEvent, SteeringState } from "../../shared/types";
import type { IntentConfirmationState } from "../../shared/types";

export type ExecutorAction =
  | { type: "click"; x: number; y: number }
  | { type: "double_click"; x: number; y: number }
  | { type: "drag"; from: { x: number; y: number }; to: { x: number; y: number } }
  | { type: "scroll"; x: number; y: number; dx: number; dy: number }
  | { type: "type"; text: string }
  | { type: "key"; shortcut: string[] }
  | { type: "wait"; ms: number };

export interface ConsequentialProbe {
  (summary: string): Promise<boolean>;
}

export interface ExecutorCallbacks {
  onEvent(e: ExecutorEvent): void;
  requestConsequentialConfirmation(state: ConsequentialState): Promise<boolean>;
  requestConsequentialChoice?(state: ConsequentialState): Promise<"approve" | "change" | "cancel">;
  requestSteering(task: ExecutedTask, statusText: string): Promise<"continue" | "stop" | "change">;
  onComplete(task: ExecutedTask, summary: string): void;
}

export interface ExecutorProvider {
  readonly name: string;
  readonly mode: "live";
  readonly available: boolean;
  start(task: ExecutedTask, callbacks: ExecutorCallbacks): Promise<void>;
  interrupt(): Promise<void>;
  stop(): Promise<void>;
}

export const CONSEQUENTIAL_CHOICES = [
  { id: "approve" as const, label: "APPROVE" },
  { id: "change" as const, label: "CHANGE" },
  { id: "read" as const, label: "READ / EXPLAIN" },
  { id: "cancel" as const, label: "CANCEL" },
];

export function isConsequentialIntent(intent: string): boolean {
  const words = intent.toLowerCase().split(/[^a-z]+/);
  const actionWords = words.filter((w) => w.length > 0);
  const consequential = ["send", "email", "post", "submit", "delete", "purchase", "buy", "order", "pay", "transfer", "cancel", "book", "confirm", "approve", "archive", "overwrite", "update", "reset", "change", "deactivate", "remove"];
  return actionWords.some((w) => consequential.includes(w));
}

export function labelConsequentialAction(intent: string): string {
  const words = intent.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  if (words.includes("send") || words.includes("email")) return `Send: "${shorten(intent, 90)}"`;
  if (words.includes("delete") || words.includes("remove") || words.includes("archive")) return `Delete/Archive: "${shorten(intent, 90)}"`;
  if (words.includes("buy") || words.includes("purchase") || words.includes("order") || words.includes("pay")) return `Purchase/Payment: "${shorten(intent, 90)}"`;
  if (words.includes("post") || words.includes("submit") || words.includes("publish")) return `Post/Submit: "${shorten(intent, 90)}"`;
  if (words.includes("book") || words.includes("confirm") || words.includes("approve")) return `Confirm: "${shorten(intent, 90)}"`;
  return `External action: "${shorten(intent, 90)}"`;
}

function shorten(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}
