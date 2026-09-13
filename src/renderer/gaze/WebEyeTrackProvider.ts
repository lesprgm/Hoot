import type { CalibrationSample } from "@realeye-io/webcam-eyetracker-light-open";
import type { GazeSample } from "../../shared/types";
import type { GazeProvider } from "./GazeProvider";
import { calibrationOperation } from "./CalibrationOperation";
import { currentCalibrationViewport, sameCalibrationViewport, passesCalibrationTarget, assessCalibrationTarget, type CalibrationViewport } from "./calibration";

type WebEyeTrackResult = {
  normPog: [number, number];
  timestamp: number;
  gazeState: string;
};

type PatchedWebcamClient = {
  stopWebcam(): void;
  getVideoSettings(): MediaTrackSettings | null;
};

type PatchedWebEyeTrackProxy = {
  onReady: (calibrationRestored: boolean) => void;
  onError: (phase: string, message: string) => void;
  onGazeResults: (result: WebEyeTrackResult) => void;
  onCalibrationPoint: (adapted: boolean, normX: number, normY: number) => void;
  onCalibrationApplied: (adapted: boolean, fitRmse: number | null) => void;
  onCalibrationPointBegun: () => void;
  onCalibrationSaved: (calibrationKey: string) => void;
  calibrate(normX: number, normY: number): void;
  applyCalibration(): void;
  beginCalibrationPoint(): void;
  saveCalibration(calibrationKey: string): void;
  destroy(): void;
};

type PatchedWebEyeTrackModule = {
  WebcamClient: new (videoElementId: string) => PatchedWebcamClient;
  WebEyeTrackProxy: new (
    webcam: PatchedWebcamClient,
    options: {
      modelUrl: string;
      wasmPath: string;
      faceModelUrl: string;
      calibrationKey?: string;
      adaptOnClick: boolean;
      maxPoints: number;
    },
  ) => PatchedWebEyeTrackProxy;
};

type RealEyeTracker = {
  initialize(): Promise<void>;
  calibrate(samples: CalibrationSample[]): void;
  detectFace(image: ImageData): { confidence?: number } | null;
  predictWithDetection(image: ImageData, detection: object): { x: number; y: number };
  dispose(): void;
};

const WEBEYE_CALIBRATION_POINTS: Array<[number, number]> = [
  [0.5, 0.5],
  [0.1, 0.1], [0.9, 0.1],
  [0.1, 0.9], [0.9, 0.9],
];
const VERIFICATION_POINTS: Array<[number, number]> = [
  [0.2, 0.2], [0.8, 0.2], [0.2, 0.8], [0.8, 0.8],
];

let patchedModulePromise: Promise<PatchedWebEyeTrackModule> | null = null;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { window.clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    const abort = () => { cleanup(); reject(new DOMException("Calibration cancelled.", "AbortError")); };
    const timer = window.setTimeout(() => { cleanup(); resolve(); }, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function calibrationLog(event: string, details: Record<string, unknown> = {}): void {
  console.info(`[calibration] ${JSON.stringify({ at: new Date().toISOString(), provider: "webeyetrack", event, ...details })}`);
}

function publicAsset(relativePath: string): string {
  return new URL(relativePath, document.baseURI).toString();
}

const CALIBRATION_META_KEY = "view.calibration.profile.v3";
type CalibrationMetadata = CalibrationViewport & { camera: { deviceId: string; width: number; height: number }; verified?: boolean };
function savedCalibrationMetadata(): CalibrationMetadata | null {
  try {
    return JSON.parse(localStorage.getItem(CALIBRATION_META_KEY) ?? "null") as CalibrationMetadata | null;
  } catch { return null; }
}
export function hasMatchingCalibrationViewport(allowUnverified = false): boolean {
  const saved = savedCalibrationMetadata();
  return Boolean(saved?.camera && (saved.verified !== false || allowUnverified) && sameCalibrationViewport(saved, currentCalibrationViewport()));
}

function cameraVideo(): HTMLVideoElement {
  const video = document.getElementById("gaze-camera") as HTMLVideoElement | null;
  if (!video) throw new Error("The gaze camera element is missing.");
  return video;
}

async function waitForVideoReady(video: HTMLVideoElement, timeoutMs = 10_000, signal?: AbortSignal, failure: () => Error | null = () => null): Promise<void> {
  const started = performance.now();
  for (;;) {
    signal?.throwIfAborted();
    const error = failure();
    if (error) throw error;
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0 && video.videoHeight > 0) return;
    if (performance.now() - started >= timeoutMs) throw new Error("Camera video did not provide a frame with nonzero dimensions.");
    await delay(100, signal);
  }
}

async function loadPatchedWebEyeTrack(): Promise<PatchedWebEyeTrackModule> {
  if (patchedModulePromise) return patchedModulePromise;
  patchedModulePromise = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>("script[data-patched-webeyetrack]");
    const script = existing ?? document.createElement("script");
    const finish = (): void => {
      const globals = window as unknown as Partial<PatchedWebEyeTrackModule>;
      if (typeof globals.WebcamClient !== "function" || typeof globals.WebEyeTrackProxy !== "function") {
        reject(new Error("The patched WebEyeTrack bundle did not expose its browser API."));
        return;
      }
      resolve({ WebcamClient: globals.WebcamClient, WebEyeTrackProxy: globals.WebEyeTrackProxy });
    };
    script.addEventListener("load", finish, { once: true });
    script.addEventListener("error", () => {
      // A failed script element never emits another load event. Remove it so
      // a later activation can create a real retry instead of waiting forever.
      script.remove();
      reject(new Error("The patched WebEyeTrack bundle failed to load."));
    }, { once: true });
    if (!existing) {
      script.dataset.patchedWebeyetrack = "";
      script.src = publicAsset("./webeyetrack/webeyetrack.js");
      script.async = true;
      document.head.appendChild(script);
    } else if (typeof (window as unknown as Partial<PatchedWebEyeTrackModule>).WebcamClient === "function") {
      finish();
    }
  });
  try {
    return await patchedModulePromise;
  } catch (error) {
    patchedModulePromise = null;
    throw error;
  }
}

function createCalibrationLayer(): {
  layer: HTMLDivElement;
  instruction: HTMLDivElement;
  target: HTMLButtonElement;
} {
  const layer = document.createElement("div");
  layer.className = "calibration-layer";
  const instruction = document.createElement("div");
  instruction.className = "calibration-instruction";
  const target = document.createElement("button");
  target.className = "calibration-target";
  target.setAttribute("aria-label", "calibration target");
  layer.append(instruction, target);
  document.body.appendChild(layer);
  return { layer, instruction, target };
}

function positionTarget(target: HTMLButtonElement, point: [number, number]): void {
  target.style.left = `${point[0] * 100}%`;
  target.style.top = `${point[1] * 100}%`;
}

function waitForTargetClick(target: HTMLButtonElement, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { target.onclick = null; signal.removeEventListener("abort", abort); };
    const abort = () => { cleanup(); reject(new DOMException("Calibration cancelled.", "AbortError")); };
    target.disabled = false;
    target.onclick = () => { target.disabled = true; cleanup(); resolve(); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

function calibrationSession(controller: AbortController) {
  const ui = createCalibrationLayer();
  const viewport = currentCalibrationViewport();
  const checkViewport = () => {
    if (!sameCalibrationViewport(viewport, currentCalibrationViewport())) {
      throw new Error("Display resolution or scaling changed. Start calibration again.");
    }
    controller.signal.throwIfAborted();
  };
  const cancel = (event: KeyboardEvent) => { if (event.key === "Escape") controller.abort(); };
  const abort = () => ui.layer.remove();
  window.addEventListener("keydown", cancel);
  controller.signal.addEventListener("abort", abort, { once: true });
  return {
    ...ui,
    waitForClick: async () => { checkViewport(); await waitForTargetClick(ui.target, controller.signal); checkViewport(); },
    checkViewport,
    close: () => { ui.layer.remove(); window.removeEventListener("keydown", cancel); controller.signal.removeEventListener("abort", abort); },
    description: `${viewport.width} × ${viewport.height} · ${viewport.scale}× display scale`,
  };
}

function captureVideoFrame(video: HTMLVideoElement, canvas: HTMLCanvasElement): ImageData | null {
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.videoWidth === 0 || video.videoHeight === 0) return null;
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  try {
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return context.getImageData(0, 0, canvas.width, canvas.height);
  } catch {
    return null;
  }
}

export class WebEyeTrackProvider implements GazeProvider {
  readonly name = "webeyetrack-patched-otree-et";
  private calibrationAbort = new AbortController();
  private calibrated = false;
  private calibrationRestored = false;
  private calibrationVerified = false;
  private readonly calibrationKey = "view-webeyetrack-v3";
  private workerError: Error | null = null;
  private readonly sessionId = crypto.randomUUID();
  private webcam: PatchedWebcamClient | null = null;
  private proxy: PatchedWebEyeTrackProxy | null = null;
  private consumer: ((sample: GazeSample) => void) | null = null;
  private ready: Promise<void> | null = null;
  private latestSample: GazeSample | null = null;
  private recentSamples: GazeSample[] = [];
  private lastFrameTimestamp: number | null = null;
  private resolveFirstResult: (() => void) | null = null;

  constructor(private readonly forceCalibration = false, private readonly allowUnverifiedGaze = false) {}

  private log(event: string, details: Record<string, unknown> = {}): void {
    calibrationLog(event, { sessionId: this.sessionId, ...details });
  }

  async initialize(): Promise<void> {
    this.log("initialize_started", { viewport: currentCalibrationViewport(), algorithm: "affine-v3", forceCalibration: this.forceCalibration });
    this.calibrationAbort = new AbortController();
    this.calibrated = false;
    this.calibrationRestored = false;
    this.calibrationVerified = false;
    this.workerError = null;
    const module = await loadPatchedWebEyeTrack();
    this.calibrationAbort.signal.throwIfAborted();
    const video = cameraVideo();
    this.webcam = new module.WebcamClient(video.id);
    this.ready = calibrationOperation<void>(this.calibrationAbort.signal, "WebEyeTrack model initialization", 30_000, (resolve, reject) => {
      const proxy = new module.WebEyeTrackProxy(this.webcam!, {
        modelUrl: publicAsset("./web/model.json"),
        wasmPath: publicAsset("./mediapipe/wasm"),
        faceModelUrl: publicAsset("./mediapipe/face_landmarker.task"),
        calibrationKey: !this.forceCalibration && hasMatchingCalibrationViewport(this.allowUnverifiedGaze) ? this.calibrationKey : undefined,
        adaptOnClick: false,
        maxPoints: WEBEYE_CALIBRATION_POINTS.length,
      });
      this.proxy = proxy;
      proxy.onReady = (restored) => {
        this.calibrationRestored = restored && hasMatchingCalibrationViewport(this.allowUnverifiedGaze);
        this.calibrationVerified = this.calibrationRestored && savedCalibrationMetadata()?.verified !== false;
        this.calibrated = this.calibrationRestored;
        this.log("models_ready", { storedModelFound: restored, calibrationRestored: this.calibrationRestored });
        resolve();
      };
      proxy.onError = (phase, message) => {
        this.workerError = new Error(`WebEyeTrack ${phase} failed: ${message}`);
        this.log("provider_error", { phase, message });
        reject(this.workerError);
      };
      proxy.onGazeResults = (result) => this.handleResult(result);
      return () => { proxy.onReady = () => {}; };
    });
    await this.ready;
    // WebEyeTrackProxy starts WebcamClient only after its worker reports ready.
    // Waiting before constructing the proxy deadlocks camera startup.
    await waitForVideoReady(video, 10_000, this.calibrationAbort.signal, () => this.workerError);
    if (this.calibrationRestored) {
      const saved = savedCalibrationMetadata();
      const current = this.cameraMetadata();
      if (!saved || saved.camera.deviceId !== current.deviceId || saved.camera.width !== current.width || saved.camera.height !== current.height) {
        throw new Error("The camera or its resolution changed. Choose Recalibrate to save a new calibration.");
      }
    }
    await this.request<void>("First camera gaze frame", 15_000, resolve => {
      if (this.lastFrameTimestamp !== null) resolve();
      else this.resolveFirstResult = resolve;
      return () => { this.resolveFirstResult = null; };
    }, () => {});
    this.log("camera_first_gaze_frame");
  }

  private cameraMetadata(): CalibrationMetadata["camera"] {
    const settings = this.webcam?.getVideoSettings();
    if (!settings?.deviceId || !settings.width || !settings.height) throw new Error("Camera identity or resolution is unavailable.");
    return { deviceId: settings.deviceId, width: settings.width, height: settings.height };
  }

  isCalibrationRestored(): boolean { return this.calibrationRestored; }
  isCalibrationVerified(): boolean { return this.calibrationVerified; }

  private handleResult(result: WebEyeTrackResult): void {
    if (result.timestamp === this.lastFrameTimestamp) return;
    this.lastFrameTimestamp = result.timestamp;
    this.resolveFirstResult?.();
    this.resolveFirstResult = null;
    const valid = result.gazeState === "open" && Array.isArray(result.normPog) && result.normPog.length >= 2
      && Number.isFinite(result.normPog[0]) && Number.isFinite(result.normPog[1]);
    const sample: GazeSample = {
      xNorm: valid ? clamp01(result.normPog[0] + 0.5) : 0,
      yNorm: valid ? clamp01(result.normPog[1] + 0.5) : 0,
      timestampMs: performance.now(),
      valid,
      quality: valid ? 1 : 0,
    };
    this.latestSample = sample;
    this.recentSamples.push(sample);
    const cutoff = sample.timestampMs - 3_000;
    while (this.recentSamples[0]?.timestampMs < cutoff) this.recentSamples.shift();
    this.consumer?.(sample);
  }

  private async waitForFreshValidSamples(afterMs: number, minimum = 1, timeoutMs = 1_500, minimumSpanMs = 0): Promise<boolean> {
    const started = performance.now();
    while (performance.now() - started < timeoutMs) {
      this.calibrationAbort.signal.throwIfAborted();
      if (this.workerError) throw this.workerError;
      const samples = this.recentSamples.filter(sample => sample.valid && sample.timestampMs >= afterMs);
      if (samples.length >= minimum && samples[samples.length - 1].timestampMs - samples[0].timestampMs >= minimumSpanMs) return true;
      await delay(25, this.calibrationAbort.signal);
    }
    return false;
  }

  private request<T>(label: string, timeoutMs: number, subscribe: (resolve: (value: T) => void) => () => void, send: () => void): Promise<T> {
    const proxy = this.proxy;
    if (!proxy) return Promise.reject(new Error("WebEyeTrack is stopped."));
    if (this.workerError) return Promise.reject(this.workerError);
    return calibrationOperation<T>(this.calibrationAbort.signal, label, timeoutMs, (resolve, reject) => {
      const previousError = proxy.onError;
      const onError = (phase: string, message: string) => {
        previousError(phase, message);
        reject(new Error(`WebEyeTrack ${phase} failed: ${message}`));
      };
      proxy.onError = onError;
      const unsubscribe = subscribe(resolve);
      try { send(); } catch (error) { reject(error instanceof Error ? error : new Error(String(error))); }
      return () => { unsubscribe(); if (proxy.onError === onError) proxy.onError = previousError; };
    });
  }

  private async collectAt(point: [number, number]): Promise<boolean> {
    if (!this.proxy) return false;
    const proxy = this.proxy;
    // Reset the worker first, then collect three fresh valid frames. This keeps
    // frames from the previous target out of the final calibration batch.
    await this.request<void>("Calibration frame reset", 2_000, resolve => {
      proxy.onCalibrationPointBegun = () => resolve();
      return () => { proxy.onCalibrationPointBegun = () => {}; };
    }, () => proxy.beginCalibrationPoint());
    const captureStartedAt = performance.now();
    if (!(await this.waitForFreshValidSamples(captureStartedAt, 3, 1_500, 250))) {
      this.log("training_frame_batch_timeout", {
        validFrames: this.recentSamples.filter((sample) => sample.valid && sample.timestampMs >= captureStartedAt).length,
        timeoutMs: 1_500,
      });
      return false;
    }
    const collected = await this.request<boolean>("Calibration frame collection", 2_000, resolve => {
      proxy.onCalibrationPoint = (adapted, x, y) => {
        if (Math.abs(x - (point[0] - 0.5)) < 1e-6 && Math.abs(y - (point[1] - 0.5)) < 1e-6) {
          resolve(adapted);
        }
      };
      return () => { proxy.onCalibrationPoint = () => {}; };
    }, () => proxy.calibrate(point[0] - 0.5, point[1] - 0.5));
    this.log("training_frames_collected", { collected, durationMs: Math.round(performance.now() - captureStartedAt) });
    return collected;
  }

  private async applyCalibrationBatch(): Promise<boolean> {
    if (!this.proxy) return false;
    const proxy = this.proxy;
    this.log("calibration_fit_started", { targets: WEBEYE_CALIBRATION_POINTS.length, framesPerTarget: 3, algorithm: "affine-v3" });
    const startedAt = performance.now();
    return this.request<boolean>("Calibration fit", 5_000, resolve => {
      proxy.onCalibrationApplied = (adapted, fitRmse) => {
        this.log("calibration_fit_completed", { adapted, fitRmse, durationMs: Math.round(performance.now() - startedAt) });
        resolve(adapted);
      };
      return () => { proxy.onCalibrationApplied = () => {}; };
    }, () => proxy.applyCalibration());
  }

  async calibrate(): Promise<{ ok: boolean; message: string }> {
    if (!this.proxy || !this.ready) return { ok: false, message: "WebEyeTrack did not initialize." };
    await this.ready;
    this.log("calibration_started", { trainingTargets: WEBEYE_CALIBRATION_POINTS.length, verificationTargets: this.allowUnverifiedGaze ? 0 : VERIFICATION_POINTS.length, allowUnverifiedGaze: this.allowUnverifiedGaze });
    this.calibrated = false;
    const session = calibrationSession(this.calibrationAbort);
    const { instruction, target } = session;
    try {
      for (let index = 0; index < WEBEYE_CALIBRATION_POINTS.length; index++) {
        const point = WEBEYE_CALIBRATION_POINTS[index];
        positionTarget(target, point);
        let adapted = false;
        let attempts = 0;
        while (!adapted) {
          instruction.textContent = `Look at dot ${index + 1} of ${WEBEYE_CALIBRATION_POINTS.length}, then click it. Keep looking until it moves. ${session.description} · Esc to cancel`;
          await session.waitForClick();
          this.log("training_target_clicked", { target: index + 1, attempt: attempts + 1 });
          instruction.textContent = "Capturing gaze…";
          adapted = await this.collectAt(point);
          attempts += 1;
          this.log("training_target_result", { target: index + 1, attempt: attempts, collected: adapted });
          if (!adapted && attempts >= 3) throw new Error(`WebEyeTrack could not capture calibration target ${index + 1} after three attempts.`);
          if (!adapted) instruction.textContent = "No face was detected. Hold still and click the same target again.";
        }
        await delay(180, this.calibrationAbort.signal);
      }

      instruction.textContent = "Applying your five-point calibration…";
      if (!(await this.applyCalibrationBatch())) {
        throw new Error("WebEyeTrack could not apply the collected calibration frames.");
      }
      session.checkViewport();

      let passed = true;
      const failedTargets: number[] = [];
      for (let index = 0; index < (this.allowUnverifiedGaze ? 0 : VERIFICATION_POINTS.length); index++) {
        const point = VERIFICATION_POINTS[index];
        positionTarget(target, point);
        instruction.textContent = `Accuracy check ${index + 1} of ${VERIFICATION_POINTS.length}: look at the dot, then click and keep looking until it moves.`;
        await session.waitForClick();
        instruction.textContent = "Keep looking at the dot…";
        // Exclude the saccade and filter settling immediately after a click.
        await delay(300, this.calibrationAbort.signal);
        const startedAt = performance.now();
        await delay(1200, this.calibrationAbort.signal);
        if (this.workerError) throw this.workerError;
        const samples = this.recentSamples.filter((sample) => sample.timestampMs >= startedAt);
        const assessment = assessCalibrationTarget(samples, point);
        this.log("verification_target_result", { target: index + 1, ...assessment });
        if (!assessment.passed) { passed = false; failedTargets.push(index); }
      }
      session.checkViewport();
      const accepted = passed || this.allowUnverifiedGaze;
      const verified = passed && !this.allowUnverifiedGaze;
      if (accepted && this.proxy) {
        const metadata: CalibrationMetadata = { ...currentCalibrationViewport(), camera: this.cameraMetadata(), verified };
        const proxy = this.proxy;
        await this.request<void>("Calibration save", 10_000, resolve => {
          proxy.onCalibrationSaved = key => { if (key === this.calibrationKey) resolve(); };
          return () => { proxy.onCalibrationSaved = () => {}; };
        }, () => proxy.saveCalibration(this.calibrationKey));
        session.checkViewport();
        localStorage.setItem(CALIBRATION_META_KEY, JSON.stringify(metadata));
        this.log("calibration_saved", { verified });
      }
      this.calibrated = accepted;
      this.calibrationVerified = verified;
      this.latestSample = null;
      this.recentSamples = [];
      const positions = ["top-left", "top-right", "bottom-left", "bottom-right"];
      const failed = failedTargets.map(index => positions[index]).join(", ");
      this.log(verified ? "calibration_passed" : accepted ? "calibration_accepted_unverified" : "calibration_failed", { failedTargets: failedTargets.map((index) => index + 1) });
      return accepted
        ? { ok: true, message: verified ? "WebEyeTrack calibration and quadrant verification passed." : "Five-point screen mapping saved. Accuracy checks were skipped by explicit demo mode." }
        : { ok: false, message: `Accuracy checks failed at ${failed}. Gaze remains disabled. Error measurements are in the calibration log.` };
    } finally {
      session.close();
    }
  }

  async start(onSample: (sample: GazeSample) => void): Promise<void> {
    if (!this.calibrated) throw new Error("Complete eye calibration and verification before starting live gaze.");
    if (!(await this.waitForFreshValidSamples(performance.now()))) throw new Error("No fresh eye sample after calibration. Gaze remains disabled.");
    this.calibrationAbort.signal.throwIfAborted();
    this.consumer = onSample;
    this.log("gaze_active", { restored: this.calibrationRestored });
  }

  async stop(): Promise<void> {
    this.calibrationAbort.abort();
    this.calibrated = false;
    this.consumer = null;
    this.proxy?.destroy();
    this.webcam?.stopWebcam();
    // WebcamClient detaches only the stream it owns. An old provider must not
    // clear a shared video element after a newer provider has acquired it.
    this.proxy = null;
    this.webcam = null;
    this.ready = null;
    this.resolveFirstResult = null;
    this.latestSample = null;
    this.recentSamples = [];
    this.lastFrameTimestamp = null;
  }

  async dispose(): Promise<void> {
    await this.stop();
  }
}

export class RealEyeProvider implements GazeProvider {
  readonly name = "realeye";
  private calibrationAbort = new AbortController();
  private calibrated = false;
  private tracker: RealEyeTracker | null = null;
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private frameCanvas = document.createElement("canvas");
  private animationFrame: number | null = null;
  private lastVideoTime = -1;
  private predicting = false;

  async initialize(): Promise<void> {
    this.calibrationAbort = new AbortController();
    this.calibrated = false;
    const { WebcamETLight } = await import("@realeye-io/webcam-eyetracker-light-open");
    this.video = cameraVideo();
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" },
      audio: false,
    });
    this.video.srcObject = this.stream;
    await this.video.play();
    await waitForVideoReady(this.video);
    this.tracker = new WebcamETLight({
      delegate: "CPU",
      runningMode: "VIDEO",
      faceDetectorMode: "landmarker",
      modelPath: publicAsset("./mediapipe/face_landmarker.task"),
      wasmPath: publicAsset("./realeye/wasm"),
    }) as RealEyeTracker;
    await this.tracker.initialize();
  }

  async calibrate(): Promise<{ ok: boolean; message: string }> {
    if (!this.tracker || !this.video) return { ok: false, message: "RealEye did not initialize." };
    const { getCalibrationPoints, getRecommendedPattern } = await import("@realeye-io/webcam-eyetracker-light-open");
    const points = getCalibrationPoints(getRecommendedPattern()).map((point) => [point.x, point.y] as [number, number]);
    const samples: CalibrationSample[] = [];
    const session = calibrationSession(this.calibrationAbort);
    const { instruction, target } = session;
    try {
      for (let index = 0; index < points.length; index++) {
        const point = points[index];
        positionTarget(target, point);
        let accepted = false;
        for (let attempt = 0; attempt < 3 && !accepted; attempt++) {
          instruction.textContent = `${attempt ? "No face was captured. Try again. " : ""}Look at dot ${index + 1} of ${points.length}, then click it. ${session.description} · Esc to cancel`;
          await session.waitForClick();
          const videoTime = this.video.currentTime;
          const started = performance.now();
          while (this.video.currentTime === videoTime && performance.now() - started < 1500) {
            await delay(33);
            session.checkViewport();
          }
          const image = this.video.currentTime !== videoTime ? captureVideoFrame(this.video, this.frameCanvas) : null;
          if (image && this.tracker.detectFace(image)) {
            samples.push({ image, gazeX: point[0] * window.innerWidth, gazeY: point[1] * window.innerHeight });
            accepted = true;
          }
        }
        if (!accepted) throw new Error(`No face at calibration target ${index + 1} after three attempts.`);
      }
      session.checkViewport();
      this.tracker.calibrate(samples);
      for (let index = 0; index < VERIFICATION_POINTS.length; index++) {
        const point = VERIFICATION_POINTS[index];
        positionTarget(target, point);
        instruction.textContent = `Accuracy check ${index + 1} of 4: look at the dot, then click and keep looking.`;
        await session.waitForClick();
        const started = performance.now();
        const verification: GazeSample[] = [];
        while (performance.now() - started < 700) {
          const sample = this.predictSample();
          if (sample) verification.push(sample);
          await delay(33);
        }
        if (!passesCalibrationTarget(verification, point)) throw new Error(`The ${point[0] < 0.5 ? "left" : "right"} accuracy check failed. Gaze remains disabled.`);
      }
      session.checkViewport();
      this.calibrated = true;
      return { ok: true, message: `RealEye ${points.length}-point calibration and four accuracy checks passed.` };
    } catch (error) {
      return { ok: false, message: `RealEye calibration failed: ${(error as Error).message}` };
    } finally {
      session.close();
    }
  }

  async start(onSample: (sample: GazeSample) => void): Promise<void> {
    if (!this.tracker || !this.video || !this.calibrated) throw new Error("Complete RealEye calibration and verification before starting gaze.");
    const tick = (): void => {
      this.animationFrame = requestAnimationFrame(tick);
      if (this.predicting) return;
      this.predicting = true;
      try {
        const sample = this.predictSample();
        if (sample) onSample(sample);
      } catch {
        onSample({ xNorm: 0, yNorm: 0, timestampMs: performance.now(), valid: false, quality: 0 });
      } finally {
        this.predicting = false;
      }
    };
    this.animationFrame = requestAnimationFrame(tick);
  }

  private predictSample(): GazeSample | null {
    if (!this.video || !this.tracker || this.video.currentTime === this.lastVideoTime) return null;
    this.lastVideoTime = this.video.currentTime;
    const invalid: GazeSample = { xNorm: 0, yNorm: 0, timestampMs: performance.now(), valid: false, quality: 0 };
    const image = captureVideoFrame(this.video, this.frameCanvas);
    if (!image) return invalid;
    const detection = this.tracker.detectFace(image);
    if (!detection) return invalid;
    const point = this.tracker.predictWithDetection(image, detection);
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return invalid;
    return { xNorm: clamp01(point.x / window.innerWidth), yNorm: clamp01(point.y / window.innerHeight), timestampMs: performance.now(), valid: true, quality: clamp01(detection.confidence ?? 1) };
  }

  async stop(): Promise<void> {
    this.calibrationAbort.abort();
    this.calibrated = false;
    if (this.animationFrame !== null) cancelAnimationFrame(this.animationFrame);
    this.animationFrame = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    if (this.video) { this.video.pause(); this.video.srcObject = null; }
    this.lastVideoTime = -1;
  }

  async dispose(): Promise<void> {
    await this.stop();
    this.tracker?.dispose();
    this.tracker = null;
  }
}
