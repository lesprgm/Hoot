import type { GazeSample } from "../../shared/types";

export interface CalibrationViewport {
  width: number;
  height: number;
  scale: number;
}

export function currentCalibrationViewport(): CalibrationViewport {
  return { width: window.innerWidth, height: window.innerHeight, scale: window.devicePixelRatio };
}

export function sameCalibrationViewport(a: CalibrationViewport, b: CalibrationViewport): boolean {
  return a.width === b.width && a.height === b.height && a.scale === b.scale;
}

/** Check held-out targets; the validation frames never train the tracker. */
export function assessCalibrationTarget(samples: GazeSample[], target: [number, number]) {
  const valid = samples.filter((s) => s.valid && Number.isFinite(s.xNorm) && Number.isFinite(s.yNorm));
  const errors = valid.map(s => Math.hypot(s.xNorm - target[0], s.yNorm - target[1])).sort((a, b) => a - b);
  const correctSamples = errors.filter(error => error <= 0.25).length;
  return {
    samples: samples.length,
    validSamples: valid.length,
    correctSamples,
    passed: valid.length >= 5 && correctSamples / Math.max(1, samples.length) >= 0.7,
    rmse: errors.length ? Math.sqrt(errors.reduce((sum, error) => sum + error * error, 0) / errors.length) : null,
    p95Error: errors.length ? errors[Math.min(errors.length - 1, Math.ceil(errors.length * 0.95) - 1)] : null,
  };
}

export function passesCalibrationTarget(samples: GazeSample[], target: [number, number]): boolean {
  return assessCalibrationTarget(samples, target).passed;
}

export class CalibrationFailedError extends Error {}

export function currentLiveSample(sample: GazeSample | null, calibrated: CalibrationViewport | null, viewport: CalibrationViewport, nowMs: number): GazeSample | null {
  if (!calibrated || !sameCalibrationViewport(calibrated, viewport) || !sample?.valid
    || !Number.isFinite(sample.xNorm) || !Number.isFinite(sample.yNorm)
    || nowMs - sample.timestampMs > 750 || sample.timestampMs > nowMs) return null;
  return sample;
}
