import { describe, expect, it } from "vitest";
import { assessCalibrationTarget, currentLiveSample, passesCalibrationTarget } from "../../src/renderer/gaze/calibration";
import type { GazeSample } from "../../src/shared/types";

const viewport = { width: 1470, height: 956, scale: 2 };
const sample: GazeSample = { xNorm: 0.2, yNorm: 0.2, timestampMs: 1000, valid: true };

describe("live calibration gate", () => {
  it("rejects gaze before calibration, after resizing, and after a camera stall", () => {
    expect(currentLiveSample(sample, null, viewport, 1010)).toBeNull();
    expect(currentLiveSample(sample, viewport, { ...viewport, width: 1920 }, 1010)).toBeNull();
    expect(currentLiveSample(sample, viewport, { ...viewport, scale: 1 }, 1010)).toBeNull();
    expect(currentLiveSample(sample, viewport, viewport, 2000)).toBeNull();
    expect(currentLiveSample(sample, viewport, viewport, 1010)).toBe(sample);
  });

  it("rejects non-finite and explicitly invalid predictions", () => {
    expect(currentLiveSample({ ...sample, valid: false }, viewport, viewport, 1010)).toBeNull();
    expect(currentLiveSample({ ...sample, xNorm: NaN }, viewport, viewport, 1010)).toBeNull();
  });

  it("fails left-target validation when gaze stays on the right or near center", () => {
    expect(passesCalibrationTarget(Array(10).fill({ ...sample, xNorm: 0.8 }), [0.2, 0.2])).toBe(false);
    expect(passesCalibrationTarget(Array(10).fill({ ...sample, xNorm: 0.49, yNorm: 0.49 }), [0.2, 0.2])).toBe(false);
    expect(passesCalibrationTarget(Array(10).fill(sample), [0.2, 0.2])).toBe(true);
  });

  it("does not pass an accuracy check using a few good frames among face-loss frames", () => {
    expect(passesCalibrationTarget(Array(4).fill(sample), [0.2, 0.2])).toBe(false);
    expect(passesCalibrationTarget([...Array(5).fill(sample), ...Array(5).fill({ ...sample, valid: false })], [0.2, 0.2])).toBe(false);
  });

  it("reports numerical error without weakening the accuracy gate", () => {
    const assessment = assessCalibrationTarget([
      ...Array(7).fill(sample),
      ...Array(2).fill({ ...sample, xNorm: 0.5, yNorm: 0.6 }),
      { ...sample, valid: false },
    ], [0.2, 0.2]);
    expect(assessment).toMatchObject({ samples: 10, validSamples: 9, correctSamples: 7, passed: true });
    expect(assessment.rmse).toBeCloseTo(Math.sqrt(0.5 / 9));
    expect(assessment.p95Error).toBeCloseTo(0.5);
    expect(assessCalibrationTarget([], [0.2, 0.2])).toMatchObject({ passed: false, rmse: null, p95Error: null });
  });
});
