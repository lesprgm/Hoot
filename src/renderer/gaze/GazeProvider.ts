import type { GazeSample } from "../../shared/types";

export interface GazeProvider {
  readonly name: string;
  initialize(): Promise<void>;
  calibrate(): Promise<{ ok: boolean; message: string }>;
  start(onSample: (sample: GazeSample) => void): Promise<void>;
  stop(): Promise<void>;
  dispose(): Promise<void>;
  isCalibrationRestored?(): boolean;
  isCalibrationVerified?(): boolean;
}

export class UnavailableGazeProvider implements GazeProvider {
  readonly name = "unavailable";
  reason = "provider could not be loaded";
  async initialize(): Promise<void> {}
  async calibrate() {
    return { ok: false, message: this.reason };
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async dispose(): Promise<void> {}
}
