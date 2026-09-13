import { describe, expect, it, vi } from "vitest";
import { DwellSelector, GazeSmoother, type HitRegion } from "../../src/renderer/gaze/fixation";

const region = (id: string, dwellMs: number): HitRegion => ({
  id,
  xNorm: 0.1,
  yNorm: 0.1,
  widthNorm: 0.3,
  heightNorm: 0.3,
  dwellMs,
});

function sample(x: number, y: number, t: number, valid = true) {
  return { xNorm: x, yNorm: y, timestampMs: t, valid, quality: 1 };
}

describe("GazeSmoother (EMA)", () => {
  it("returns the raw sample for the first value", () => {
    const s = new GazeSmoother({ alpha: 0.28, invalidGapMs: 250 });
    const out = s.update(sample(0.5, 0.5, 100));
    expect(out.xNorm).toBe(0.5);
  });

  it("interpolates subsequent samples using alpha", () => {
    const s = new GazeSmoother({ alpha: 0.28, invalidGapMs: 250 });
    s.update(sample(0.5, 0.5, 100));
    const out = s.update(sample(0.4, 0.4, 130));
    expect(out.xNorm).toBeCloseTo(0.4 * 0.28 + 0.5 * 0.72, 6);
  });

  it("resets after a gap longer than the invalid window", () => {
    const s = new GazeSmoother({ alpha: 0.28, invalidGapMs: 250 });
    s.update(sample(0.9, 0.9, 100));
    const out = s.update(sample(0.1, 0.1, 100 + 500));
    expect(out.xNorm).toBe(0.1);
  });

  it("invalidates on invalid samples and never carries over", () => {
    const s = new GazeSmoother({ alpha: 0.28, invalidGapMs: 250 });
    s.update(sample(0.9, 0.9, 100));
    s.update(sample(0.9, 0.9, 120, false));
    const out = s.update(sample(0.2, 0.2, 140));
    expect(out.xNorm).toBe(0.2);
  });
});

describe("DwellSelector", () => {
  it("commits after the dwell duration for a stable gaze", () => {
    const commits: string[] = [];
    const ds = new DwellSelector((c) => commits.push(c.regionId), 180, 0.7);
    const regions = [region("A", 300)];
    ds.update(regions, sample(0.15, 0.15, 0), 0);
    ds.update(regions, sample(0.15, 0.15, 100), 200);
    ds.update(regions, sample(0.15, 0.15, 200), 300);
    ds.update(regions, sample(0.15, 0.15, 320), 400);
    expect(commits).toContain("A");
  });

  it("advances from the render clock when the provider repeats a stable sample", () => {
    const commits: string[] = [];
    const ds = new DwellSelector((c) => commits.push(c.regionId), 180, 0.7);
    const regions = [region("sprite", 300)];
    const stable = sample(0.15, 0.15, 100);
    ds.update(regions, stable, 1_000);
    ds.update(regions, stable, 1_150);
    expect(ds.progress(regions, stable, 1_150)?.progress01).toBe(0.5);
    ds.update(regions, stable, 1_300);
    expect(commits).toEqual(["sprite"]);
  });

  it("freezes focus progress across a brief invalid camera sample", () => {
    const commits: string[] = [];
    const ds = new DwellSelector((c) => commits.push(c.regionId), 180, 0.7, 180);
    const regions = [region("A", 300)];
    const gaze = sample(0.15, 0.15, 0);
    ds.update(regions, gaze, 0);
    ds.update(regions, gaze, 100);
    ds.update(regions, null, 120);

    expect(ds.progress(regions, null, 160)?.progress01).toBeCloseTo(0.4);

    ds.update(regions, gaze, 200);
    expect(ds.progress(regions, gaze, 200)?.progress01).toBeCloseTo(0.4);
    expect(commits).toEqual([]);
    ds.update(regions, gaze, 380);
    expect(commits).toEqual(["A"]);
  });

  it("clears focus after a sustained invalid camera interval", () => {
    const ds = new DwellSelector(() => {}, 180, 0.7, 180);
    const regions = [region("A", 300)];
    ds.update(regions, sample(0.15, 0.15, 0), 0);
    ds.update(regions, null, 100);
    ds.update(regions, null, 300);

    expect(ds.progress(regions, null, 300)).toBeNull();
  });

  it("resets progress when gaze exits before commit", () => {
    const commits: string[] = [];
    const ds = new DwellSelector((c) => commits.push(c.regionId), 180, 0.7);
    const regions = [region("A", 300)];
    ds.update(regions, sample(0.15, 0.15, 0), 0);
    ds.update(regions, sample(0.15, 0.15, 100), 200);
    ds.update(regions, sample(0.9, 0.9, 150), 250); // leaves before 300ms
    ds.update(regions, sample(0.15, 0.15, 200), 300);
    ds.update(regions, sample(0.15, 0.15, 300), 400);
    // only the second continuous dwell can commit, and it is still < 300ms after re-entry
    expect(commits).not.toContain("A");
  });

  it("enforces leave-to-rearm: no double commit from one long stare", () => {
    const commits: string[] = [];
    const ds = new DwellSelector((c) => commits.push(c.regionId), 180, 0.7);
    const regions = [region("A", 300)];
    ds.update(regions, sample(0.15, 0.15, 0), 0);
    ds.update(regions, sample(0.15, 0.15, 300), 300);
    ds.update(regions, sample(0.15, 0.15, 350), 400);
    ds.update(regions, sample(0.15, 0.15, 400), 500);
    expect(commits.filter((c) => c === "A")).toHaveLength(1);
  });

  it("rearms after looking at empty space before returning to the same region", () => {
    const commits: string[] = [];
    const ds = new DwellSelector((c) => commits.push(c.regionId), 180, 0.7);
    const regions = [region("A", 300)];
    ds.update(regions, sample(0.15, 0.15, 0), 0);
    ds.update(regions, sample(0.15, 0.15, 300), 300);
    ds.update(regions, sample(0.9, 0.9, 350), 350);
    ds.update(regions, sample(0.9, 0.9, 550), 550);
    ds.update(regions, sample(0.15, 0.15, 600), 600);
    ds.update(regions, sample(0.15, 0.15, 900), 900);

    expect(commits).toEqual(["A", "A"]);
  });

  it("rearms across a sustained invalid gaze gap", () => {
    const commits: string[] = [];
    const ds = new DwellSelector((c) => commits.push(c.regionId), 180, 0.7);
    const regions = [region("A", 300)];
    ds.update(regions, sample(0.15, 0.15, 0), 0);
    ds.update(regions, sample(0.15, 0.15, 300), 300);
    ds.update(regions, null, 350);
    ds.update(regions, null, 550);
    ds.update(regions, sample(0.15, 0.15, 600), 600);
    ds.update(regions, sample(0.15, 0.15, 900), 900);

    expect(commits).toEqual(["A", "A"]);
  });

  it("does not carry completed progress into a new screen with the same region id", () => {
    const ds = new DwellSelector(() => {}, 180, 0.7);
    const regions = [region("A", 300)];
    const gaze = sample(0.15, 0.15, 0);
    ds.update(regions, gaze, 0);
    ds.update(regions, gaze, 300);

    expect(ds.progress(regions, gaze, 320)).toBeNull();
  });

  it("requires the majority of samples to be inside the region (ratio gate)", () => {
    const commits: string[] = [];
    const ds = new DwellSelector((c) => commits.push(c.regionId), 180, 0.7);
    const regions = [region("A", 300)];
    // sample inside region but mostly hovering only slightly outside the region box
    const noisy = [0.42, 0.45, 0.99, 0.15, 0.15, 0.15, 0.15, 0.15];
    let t = 0;
    for (const jitter of noisy) {
      ds.update(regions, sample(0.15, jitter, t), t);
      t += 50;
    }
    expect(commits).not.toContain("A");
  });

  it("does not accumulate separate glances into one dwell", () => {
    const commits: string[] = [];
    const ds = new DwellSelector((c) => commits.push(c.regionId), 180, 0.7);
    const regions = [region("A", 400)];
    ds.update(regions, sample(0.15, 0.15, 0), 0);
    ds.update(regions, sample(0.9, 0.9, 100), 100);
    ds.update(regions, sample(0.15, 0.15, 150), 240);
    ds.update(regions, sample(0.9, 0.9, 200), 300);
    ds.update(regions, sample(0.15, 0.15, 250), 400);
    expect(commits).not.toContain("A");
  });

  it("commits after three separated looks within the look window", () => {
    const commits: string[] = [];
    const ds = new DwellSelector((c) => commits.push(c.regionId), 180, 0.7);
    const regions = [region("A", 5_000)];
    const look = (start: number) => {
      ds.update(regions, sample(0.15, 0.15, start), start);
      ds.update(regions, sample(0.15, 0.15, start + 70), start + 70);
      ds.update(regions, sample(0.9, 0.9, start + 150), start + 150);
    };

    look(0);
    look(250);
    look(500);

    expect(commits).toEqual(["A"]);
  });

  it("accumulates brief successive lower-card gaze bursts", () => {
    const commits: string[] = [];
    const ds = new DwellSelector((c) => commits.push(c.regionId), 180, 0.7);
    const regions = [region("C", 2_500)];

    for (const start of [0, 230, 460]) {
      ds.update(regions, sample(0.15, 0.15, start), start);
      ds.update(regions, sample(0.15, 0.15, start + 65), start + 65);
      ds.update(regions, sample(0.15, 0.8, start + 135), start + 135);
    }

    expect(commits).toEqual(["C"]);
  });

  it("does not count looks after the look window expires", () => {
    const commits: string[] = [];
    const ds = new DwellSelector((c) => commits.push(c.regionId), 180, 0.7);
    const regions = [region("A", 5_000)];
    const look = (start: number) => {
      ds.update(regions, sample(0.15, 0.15, start), start);
      ds.update(regions, sample(0.15, 0.15, start + 150), start + 150);
      ds.update(regions, sample(0.9, 0.9, start + 270), start + 270);
    };

    look(0);
    look(400);
    look(2_800);

    expect(commits).not.toContain("A");
  });
});
