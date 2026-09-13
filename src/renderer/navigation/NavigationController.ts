export type NavigationMode = "reading" | "vertical_feed" | null;

export interface NavigationSample {
  xNorm: number;
  yNorm: number;
  valid: boolean;
  nowMs: number;
}

export interface NavigationAction {
  direction: "next" | "previous";
  deltaPx: number;
}

/** Stateful edge-dwell navigation. The center and notch are intentionally inert. */
export class NavigationController {
  private mode: NavigationMode = null;
  private edge: "top" | "bottom" | null = null;
  private edgeSince = 0;
  private lastAction = -Infinity;
  private edgeArmed = true;

  constructor(private readonly onAction: (action: NavigationAction) => void) {}

  get activeMode(): NavigationMode { return this.mode; }

  setMode(mode: NavigationMode): void {
    this.mode = mode;
    this.resetDwell();
  }

  toggle(mode: Exclude<NavigationMode, null>): void {
    this.setMode(this.mode === mode ? null : mode);
  }

  update(sample: NavigationSample): void {
    if (!this.mode || !sample.valid) {
      this.resetDwell();
      this.edgeArmed = true;
      return;
    }
    const edge = sample.yNorm <= (this.mode === "reading" ? 0.15 : 0.18)
      ? "top"
      : sample.yNorm >= (this.mode === "reading" ? 0.78 : 0.82) ? "bottom" : null;
    if (!edge) {
      this.resetDwell();
      this.edgeArmed = true;
      return;
    }
    if (!this.edgeArmed) return;
    if (edge !== this.edge) { this.edge = edge; this.edgeSince = sample.nowMs; return; }
    const dwellMs = this.mode === "reading" ? (edge === "bottom" ? 650 : 700) : 600;
    if (sample.nowMs - this.edgeSince < dwellMs || sample.nowMs - this.lastAction < 550) return;
    this.lastAction = sample.nowMs;
    this.edgeArmed = false;
    this.resetDwell();
    this.onAction({ direction: edge === "bottom" ? "next" : "previous", deltaPx: this.mode === "reading" ? 320 : 720 });
  }

  private resetDwell(): void { this.edge = null; this.edgeSince = 0; }
}
