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
