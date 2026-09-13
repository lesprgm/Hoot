import type { GazeSample } from "../../shared/types";

export interface HitRegion {
  id: string;
  xNorm: number;
  yNorm: number;
  widthNorm: number;
  heightNorm: number;
  dwellMs: number;
}

export interface SmoothingOptions {
  alpha: number;
  invalidGapMs: number;
}

export class GazeSmoother {
  private last: GazeSample | null = null;
  private lastValidAt = 0;

  constructor(private options: SmoothingOptions) {}

  update(raw: GazeSample): GazeSample {
    if (!raw.valid) {
      this.last = null;
      return raw;
    }
    if (!this.last || raw.timestampMs - this.lastValidAt > this.options.invalidGapMs) {
      this.last = raw;
      this.lastValidAt = raw.timestampMs;
      return raw;
    }
    const a = this.options.alpha;
    const smoothed: GazeSample = {
      xNorm: a * raw.xNorm + (1 - a) * this.last.xNorm,
      yNorm: a * raw.yNorm + (1 - a) * this.last.yNorm,
      timestampMs: raw.timestampMs,
      valid: true,
      quality: raw.quality,
    };
    this.last = smoothed;
    this.lastValidAt = raw.timestampMs;
    return smoothed;
  }

  reset(): void {
    this.last = null;
  }
}

export interface DwellCommit {
  regionId: string;
  dwellMs: number;
}

export interface DwellProgress {
  regionId: string;
  progress01: number;
}

export class DwellSelector {
  private entered = new Map<string, { at: number; hits: number; total: number }>();
  private currentRegionId: string | null = null;
  private committedRegionId: string | null = null;
  private leftCommittedAt: number | null = null;

  constructor(
    private onCommit: (commit: DwellCommit) => void,
    private rearmMs = 180,
    private minInRegionRatio = 0.7
  ) {}

  update(regions: HitRegion[], sample: GazeSample | null, nowMs: number): void {
    if (!sample || !sample.valid) {
      if (this.committedRegionId && this.leftCommittedAt === null) this.leftCommittedAt = nowMs;
      this.currentRegionId = null;
      return;
    }
    let inside: HitRegion | null = null;
    for (const region of regions) {
      if (
        sample.xNorm >= region.xNorm &&
        sample.xNorm <= region.xNorm + region.widthNorm &&
        sample.yNorm >= region.yNorm &&
        sample.yNorm <= region.yNorm + region.heightNorm
      ) {
        inside = region;
        break;
      }
    }
    const previous = this.currentRegionId;
    if (!inside) {
      this.currentRegionId = null;
      if (previous) this.entered.delete(previous);
      if (this.committedRegionId && this.leftCommittedAt === null) this.leftCommittedAt = nowMs;
      return;
    }

    if (this.committedRegionId) {
      if (inside.id === this.committedRegionId) {
        this.leftCommittedAt = null;
      } else {
        this.leftCommittedAt ??= nowMs;
        if (nowMs - this.leftCommittedAt >= this.rearmMs) {
          this.committedRegionId = null;
          this.leftCommittedAt = null;
        }
      }
    }
    this.currentRegionId = inside.id;
    const state = this.entered.get(inside.id) ?? { at: nowMs, hits: 0, total: 0 };
    if (previous !== inside.id) {
      state.at = nowMs;
      state.hits = 0;
      state.total = 0;
    }
    state.total += 1;
    if (sampleInside(sample, inside)) state.hits += 1;
    this.entered.set(inside.id, state);

    const dwelled = nowMs - state.at;
    if (dwelled >= inside.dwellMs && this.committedRegionId !== inside.id && state.total > 0) {
      const ratio = state.hits / state.total;
      if (ratio >= this.minInRegionRatio) {
        this.committedRegionId = inside.id;
        this.leftCommittedAt = null;
        this.onCommit({ regionId: inside.id, dwellMs: dwelled });
      }
    }
  }

  progress(regions: HitRegion[], sample: GazeSample | null, nowMs: number = sample?.timestampMs ?? 0): DwellProgress | null {
    if (!sample || !sample.valid || !this.currentRegionId) return null;
    const state = this.entered.get(this.currentRegionId);
    if (!state) return null;
    const region = regions.find((r) => r.id === this.currentRegionId);
    if (!region) return null;
    return {
      regionId: this.currentRegionId,
      progress01: Math.min(1, Math.max(0, (nowMs - state.at) / region.dwellMs)),
    };
  }

  isInside(id: string): boolean {
    return this.currentRegionId === id;
  }

  reset(): void {
    this.entered.clear();
    this.currentRegionId = null;
    this.committedRegionId = null;
    this.leftCommittedAt = null;
  }
}

function sampleInside(sample: GazeSample, region: HitRegion): boolean {
  return (
    sample.xNorm >= region.xNorm &&
    sample.xNorm <= region.xNorm + region.widthNorm &&
    sample.yNorm >= region.yNorm &&
    sample.yNorm <= region.yNorm + region.heightNorm
  );
}
