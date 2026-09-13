import type { GazeSample } from "../../shared/types";
import { GazeProvider } from "./GazeProvider";

export class SimulatedGazeProvider implements GazeProvider {
  readonly name = "simulated";
  private sample: GazeSample | null = null;
  private frozen = false;
  private started = false;
  private animationFrame: number | null = null;
  private consumer: ((sample: GazeSample) => void) | null = null;

  private readonly onMouseMove = (event: MouseEvent): void => {
    if (this.frozen || !this.consumer) return;
    const width = globalThis.innerWidth;
    const height = globalThis.innerHeight;
    if (width === 0 || height === 0) return;
    this.sample = {
      xNorm: event.clientX / width,
      yNorm: event.clientY / height,
      timestampMs: performance.now(),
      valid: true,
      quality: 1,
    };
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Shift") this.frozen = true;
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    if (event.key === "Shift") this.frozen = false;
  };

  private readonly onMouseLeave = (): void => {
    if (!this.sample || !this.consumer) return;
    this.sample = { ...this.sample, valid: false, timestampMs: performance.now() };
    this.consumer(this.sample);
  };

  async initialize(): Promise<void> {}

  async calibrate() {
    return { ok: true, message: "Simulated calibration passed: mouse acts as gaze." };
  }

  async start(onSample: (sample: GazeSample) => void): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.consumer = onSample;
    globalThis.addEventListener("mousemove", this.onMouseMove);
    globalThis.addEventListener("keydown", this.onKeyDown);
    globalThis.addEventListener("keyup", this.onKeyUp);
    globalThis.addEventListener("mouseleave", this.onMouseLeave);
    const tick = (now: number): void => {
      if (!this.started) return;
      if (this.sample && this.consumer) {
        this.sample = { ...this.sample, timestampMs: now };
        this.consumer(this.sample);
      }
      this.animationFrame = requestAnimationFrame(tick);
    };
    this.animationFrame = requestAnimationFrame(tick);
  }

  async stop(): Promise<void> {
    globalThis.removeEventListener("mousemove", this.onMouseMove);
    globalThis.removeEventListener("keydown", this.onKeyDown);
    globalThis.removeEventListener("keyup", this.onKeyUp);
    globalThis.removeEventListener("mouseleave", this.onMouseLeave);
    if (this.animationFrame !== null) cancelAnimationFrame(this.animationFrame);
    this.animationFrame = null;
    this.consumer = null;
    this.started = false;
  }

  async dispose(): Promise<void> {
    await this.stop();
  }
}
