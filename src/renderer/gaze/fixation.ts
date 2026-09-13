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
  private entered = new Map<string, {
    at: number;
    hits: number;
    total: number;
    entryTimes: number[];
    entryQualified: boolean;
    entryEligible: boolean;
    lastExitAt: number | null;
  }>();
  private currentRegionId: string | null = null;
  private committedRegionId: string | null = null;
  private leftCommittedAt: number | null = null;
  private invalidSince: number | null = null;

  // A brief return to the same target counts as one intentional look. This
  // supports users whose eyelid position makes lower-screen gaze arrive in
  // short bursts. Three bursts are still required, so one passing glance does
  // not activate a control. Durations are time-based rather than frame-based.
  private readonly lookEntryMs = 60;
  private readonly lookWindowMs = 2_500;
  private readonly lookSeparationMs = 70;
  private readonly requiredLooks = 3;
  private readonly lookInRegionRatio = 0.75;

  constructor(
    private onCommit: (commit: DwellCommit) => void,
    private rearmMs = 180,
    private minInRegionRatio = 0.7,
    private invalidGraceMs = 180,
  ) {}

  update(regions: HitRegion[], sample: GazeSample | null, nowMs: number): void {
    if (!sample || !sample.valid) {
      this.invalidSince ??= nowMs;
      if (nowMs - this.invalidSince < this.invalidGraceMs) return;
      if (this.currentRegionId) this.markExit(this.currentRegionId, nowMs);
      if (this.committedRegionId) this.leftCommittedAt ??= this.invalidSince;
      this.updateRearm(nowMs);
      this.currentRegionId = null;
      this.pruneEntries(nowMs);
      return;
    }
    const invalidGapMs = this.invalidSince === null ? 0 : nowMs - this.invalidSince;
    const resumedWithinGrace = invalidGapMs > 0 && invalidGapMs < this.invalidGraceMs;
    this.invalidSince = null;
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
    if (previous && previous !== inside?.id) this.markExit(previous, nowMs);
    if (!inside) {
      this.currentRegionId = null;
      this.updateRearm(nowMs);
      this.pruneEntries(nowMs);
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
    const state = this.entered.get(inside.id) ?? {
      at: nowMs,
      hits: 0,
      total: 0,
      entryTimes: [],
      entryQualified: false,
      entryEligible: true,
      lastExitAt: null,
    };
    if (resumedWithinGrace && previous === inside.id) state.at += invalidGapMs;
    if (previous !== inside.id) {
      state.at = nowMs;
      state.hits = 0;
      state.total = 0;
      state.entryQualified = false;
      state.entryEligible = state.lastExitAt === null || nowMs - state.lastExitAt >= this.lookSeparationMs;
    }
    state.total += 1;
    if (sampleInside(sample, inside)) state.hits += 1;
    this.entered.set(inside.id, state);
    this.pruneEntries(nowMs);

    const dwelled = nowMs - state.at;
    const ratio = state.total > 0 ? state.hits / state.total : 0;
    if (!state.entryQualified && state.entryEligible && dwelled >= this.lookEntryMs && ratio >= this.lookInRegionRatio) {
      state.entryTimes.push(nowMs);
      state.entryQualified = true;
    }

    const continuousDwell = dwelled >= inside.dwellMs && ratio >= this.minInRegionRatio;
    const repeatedLooks = state.entryTimes.length >= this.requiredLooks;
    if (this.committedRegionId !== inside.id && (continuousDwell || repeatedLooks)) {
      this.committedRegionId = inside.id;
      this.leftCommittedAt = null;
      this.onCommit({ regionId: inside.id, dwellMs: dwelled });
      state.entryTimes = [];
    }
  }

  private markExit(regionId: string, nowMs: number): void {
    const state = this.entered.get(regionId);
    if (!state) return;
    state.lastExitAt = nowMs;
    state.entryQualified = false;
  }

  private updateRearm(nowMs: number): void {
    if (!this.committedRegionId) return;
    this.leftCommittedAt ??= nowMs;
    if (nowMs - this.leftCommittedAt >= this.rearmMs) {
      this.committedRegionId = null;
      this.leftCommittedAt = null;
    }
  }

  private pruneEntries(nowMs: number): void {
    for (const state of this.entered.values()) {
      state.entryTimes = state.entryTimes.filter((at) => nowMs - at <= this.lookWindowMs);
    }
  }

  progress(regions: HitRegion[], sample: GazeSample | null, nowMs: number = sample?.timestampMs ?? 0): DwellProgress | null {
    if (!this.currentRegionId) return null;
    const withinInvalidGrace = (!sample || !sample.valid)
      && this.invalidSince !== null
      && nowMs - this.invalidSince < this.invalidGraceMs;
    if ((!sample || !sample.valid) && !withinInvalidGrace) return null;
    // The next screen can reuse an A/B/C/D region id. Do not render the old
    // completed dwell on that new screen while leave-to-rearm remains active.
    if (this.currentRegionId === this.committedRegionId) return null;
    const state = this.entered.get(this.currentRegionId);
    if (!state) return null;
    const region = regions.find((r) => r.id === this.currentRegionId);
    if (!region) return null;
    const progressAt = withinInvalidGrace ? this.invalidSince! : nowMs;
    const dwellProgress = (progressAt - state.at) / region.dwellMs;
    const currentLookProgress = state.entryQualified
      ? 0
      : Math.min(1, Math.max(0, (progressAt - state.at) / this.lookEntryMs));
    const repeatedLookProgress = (state.entryTimes.length + currentLookProgress) / this.requiredLooks;
    return {
      regionId: this.currentRegionId,
      progress01: Math.min(1, Math.max(0, Math.max(dwellProgress, repeatedLookProgress))),
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
    this.invalidSince = null;
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
