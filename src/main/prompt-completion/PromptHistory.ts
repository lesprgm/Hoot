import type { DisplayOption, ExplicitEvidence } from "../../shared/types";
import type { RawCandidateShape } from "./decoderSchema";
import type { IntentFrame } from "../../shared/intent";

export interface PromptNode {
  nodeId: string;
  displayPrompt: string;
  explicitEvidence: ExplicitEvidence[];
  rawCandidates: RawCandidateShape[];
  displayedCandidates: DisplayOption[];
  rejectedCandidateIds: string[];
  mode: "predict" | "clarify";
  clarificationQuestion: string | null;
  noneCount: number;
  turn: number;
  rejectedSetsCopy: Array<{ labels: string[]; turn: number }>;
  clarifications: Array<{ question: string; answer: string }>;
  frame?: IntentFrame;
}

export class PromptHistory {
  private stack: PromptNode[] = [];

  get depth(): number {
    return this.stack.length;
  }

  push(node: PromptNode): void {
    this.stack.push(cloneNode(node));
  }

  pop(): PromptNode | null {
    const node = this.stack.pop();
    return node ? cloneNode(node) : null;
  }

  clear(): void {
    this.stack = [];
  }
}

export function cloneNode(node: PromptNode): PromptNode {
  return {
    ...node,
    explicitEvidence: node.explicitEvidence.map((e) => ({ ...e })),
    rawCandidates: node.rawCandidates.map((r) => ({ ...r })),
    displayedCandidates: node.displayedCandidates.map((o) => ({ ...o })),
    rejectedCandidateIds: [...node.rejectedCandidateIds],
    rejectedSetsCopy: node.rejectedSetsCopy.map((r) => ({ labels: [...r.labels], turn: r.turn })),
    clarifications: node.clarifications.map((c) => ({ ...c })),
    frame: node.frame ? structuredClone(node.frame) : undefined,
  };
}
