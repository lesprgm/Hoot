export type DispatchGateState = "open" | "pause_requested" | "closed";

export interface ActionLedgerEntry {
  actionIndex: number;
  actionType: string;
  state: "started" | "completed" | "uncertain";
  startedAt: number;
  completedAt?: number;
}

/** Local execution gate shared by Astra turns and native desktop dispatch. */
export class AstraSession {
  readonly taskId: string;
  private gate: DispatchGateState = "open";
  private nextActionIndex = 0;
  private readonly ledgerEntries: ActionLedgerEntry[] = [];

  constructor(taskId: string) {
    this.taskId = taskId;
  }

  state(): DispatchGateState {
    return this.gate;
  }

  canDispatch(): boolean {
    return this.gate === "open";
  }

  requestPause(): void {
    if (this.gate === "open") this.gate = "pause_requested";
  }

  resume(): void {
    if (this.gate !== "closed") this.gate = "open";
  }

  close(): void {
    this.gate = "closed";
  }

  beginAction(actionType: string): ActionLedgerEntry | null {
    if (!this.canDispatch()) return null;
    const entry: ActionLedgerEntry = { actionIndex: this.nextActionIndex++, actionType, state: "started", startedAt: Date.now() };
    this.ledgerEntries.push(entry);
    return entry;
  }

  completeAction(entry: ActionLedgerEntry): void {
    if (entry.state !== "started") return;
    entry.state = "completed";
    entry.completedAt = Date.now();
  }

  markUncertain(entry: ActionLedgerEntry): void {
    if (entry.state === "started") entry.state = "uncertain";
  }

  ledger(): ActionLedgerEntry[] {
    return this.ledgerEntries.map((entry) => ({ ...entry }));
  }
}

