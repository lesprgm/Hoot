import type { InteractionState } from "../../shared/types";

export type MachineTrigger =
  | "boot"
  | "setupRequired"
  | "calibrating"
  | "calibrated"
  | "summonReady"
  | "optionsReady"
  | "decodingStarted"
  | "decodingFinished"
  | "selectOption"
  | "more"
  | "clarifyAnswer"
  | "openFallback"
  | "hintSubmitted"
  | "literalCommit"
  | "back"
  | "exit"
  | "intentReady"
  | "confirmYes"
  | "confirmChange"
  | "confirmRead"
  | "confirmCancel"
  | "executionStarted"
  | "consequentialPending"
  | "approveConsequential"
  | "editConsequential"
  | "cancelConsequential"
  | "interrupt"
  | "steerContinue"
  | "steerBack"
  | "steerChange"
  | "steerStop"
  | "completed"
  | "error"
  | "recoveryRetry"
  | "recoveryBack"
  | "recoveryChoose"
  | "recoveryStop"
  | "gazeLost"
  | "gazeRestored"
  | "force";

const TRANSITIONS: Partial<Record<InteractionState, Partial<Record<MachineTrigger, InteractionState | undefined>>>> = {
  BOOT: {
    setupRequired: "SETUP_REQUIRED",
    calibrating: "CALIBRATING",
    optionsReady: "PASSIVE",
  },
  SETUP_REQUIRED: {
    calibrating: "CALIBRATING",
    optionsReady: "PASSIVE",
  },
  CALIBRATING: {
    calibrating: "CALIBRATING",
    optionsReady: "PASSIVE",
    error: "CALIBRATION_ERROR",
  },
  CALIBRATION_ERROR: {
    calibrating: "CALIBRATING",
    optionsReady: "PASSIVE",
  },
  PASSIVE: {
    summonReady: "AGENT_LOADING",
    error: "ERROR_RECOVERY",
  },
  AGENT_LOADING: {
    optionsReady: "SEMANTIC",
    exit: "PASSIVE",
    error: "ERROR_RECOVERY",
  },
  SEMANTIC: {
    decodingStarted: "DECODING_ALT",
    selectOption: "SEMANTIC",
    more: "SEMANTIC",
    clarifyAnswer: "SEMANTIC",
    intentReady: "INTENT_CONFIRMATION",
    openFallback: "FALLBACK_TEXT",
    back: "SEMANTIC",
    exit: "PASSIVE",
    gazeLost: "SEMANTIC_PAUSED",
    error: "ERROR_RECOVERY",
  },
  DECODING_ALT: {
    decodingFinished: "SEMANTIC",
    exit: "PASSIVE",
    gazeLost: "SEMANTIC_PAUSED",
    error: "ERROR_RECOVERY",
  },
  CLARIFYING: {
    decodingStarted: "DECODING_ALT",
    clarifyAnswer: "SEMANTIC",
    more: "CLARIFYING",
    openFallback: "FALLBACK_TEXT",
    back: "SEMANTIC",
    exit: "PASSIVE",
    gazeLost: "SEMANTIC_PAUSED",
    error: "ERROR_RECOVERY",
  },
  SEMANTIC_PAUSED: {
    gazeRestored: "SEMANTIC",
    exit: "PASSIVE",
  },
  FALLBACK_TEXT: {
    hintSubmitted: "SEMANTIC",
    literalCommit: "INTENT_CONFIRMATION",
    exit: "PASSIVE",
    back: "SEMANTIC",
    gazeLost: "SEMANTIC_PAUSED",
  },
  INTENT_CONFIRMATION: {
    confirmYes: "EXECUTING",
    confirmChange: "SEMANTIC",
    confirmRead: "INTENT_CONFIRMATION",
    confirmCancel: "PASSIVE",
    exit: "PASSIVE",
    gazeLost: "SEMANTIC_PAUSED",
    error: "ERROR_RECOVERY",
  },
  EXECUTING: {
    consequentialPending: "CONSEQUENTIAL_CONFIRMATION",
    interrupt: "EXECUTION_INTERRUPTED",
    completed: "COMPLETE",
    confirmCancel: "PASSIVE",
    error: "ERROR_RECOVERY",
  },
  EXECUTION_INTERRUPTED: {
    steerContinue: "EXECUTING",
    steerBack: "SEMANTIC",
    steerChange: "SEMANTIC",
    steerStop: "PASSIVE",
    interrupt: "EXECUTION_INTERRUPTED",
    error: "ERROR_RECOVERY",
  },
  CONSEQUENTIAL_CONFIRMATION: {
    approveConsequential: "EXECUTING",
    editConsequential: "SEMANTIC",
    cancelConsequential: "PASSIVE",
    interrupt: "EXECUTION_INTERRUPTED",
    error: "ERROR_RECOVERY",
  },
  COMPLETE: {
    optionsReady: "PASSIVE",
  },
  ERROR_RECOVERY: {
    recoveryRetry: "AGENT_LOADING",
    recoveryBack: "SEMANTIC",
    recoveryChoose: "SEMANTIC",
    recoveryStop: "PASSIVE",
  },
  ERROR: {
    recoveryStop: "PASSIVE",
  },
};

export class InteractionStateMachine {
  private _state: InteractionState = "BOOT";
  private pausedFrom: InteractionState | null = null;
  private listeners = new Set<(state: InteractionState) => void>();

  get state(): InteractionState {
    return this._state;
  }

  onState(listener: (state: InteractionState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  transition(trigger: MachineTrigger, opts?: { forceState?: InteractionState }): boolean {
    if (trigger === "force" && opts?.forceState) {
      this.set(opts.forceState);
      return true;
    }
    if (trigger === "gazeLost" && TRANSITIONS[this._state]?.gazeLost) {
      this.pausedFrom = this._state;
    }
    if (trigger === "gazeRestored" && this._state === "SEMANTIC_PAUSED" && this.pausedFrom) {
      const restore = this.pausedFrom;
      this.pausedFrom = null;
      this.set(restore);
      return true;
    }
    const allowed = TRANSITIONS[this._state]?.[trigger];
    if (!allowed) return false;
    this.set(allowed);
    return true;
  }

  can(trigger: MachineTrigger): boolean {
    return Boolean(TRANSITIONS[this._state]?.[trigger]);
  }

  set(value: InteractionState): void {
    if (value === this._state) return;
    if (value !== "SEMANTIC_PAUSED") this.pausedFrom = null;
    this._state = value;
    for (const listener of this.listeners) listener(value);
  }
}
