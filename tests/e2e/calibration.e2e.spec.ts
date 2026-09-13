/// <reference lib="dom" />

import { test, expect, _electron as electron, type Page } from "playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const metadataKey = "view.calibration.profile.v3";

async function launchCalibration(profile = mkdtempSync(join(tmpdir(), "view-calibration-e2e-")), allowUnverified = false) {
  const app = await electron.launch({
    args: [`--user-data-dir=${profile}`, "."],
    cwd: resolve(__dirname, "../.."),
    env: {
      ...process.env, SIMULATE_GAZE: "false", GAZE_PROVIDER: "webeyetrack", FORCE_CALIBRATION: "false", ALLOW_UNVERIFIED_GAZE: String(allowUnverified),
      EXECUTION_MODE: "live", DECODER_PROVIDER: "fixture", TTS_PROVIDER: "mute", OPENAI_API_KEY: "", DEBUG_HUD: "false", NODE_ENV: "production",
    },
  });
  try {
    const page = await app.firstWindow();
    await expect(page).toHaveTitle("Gaze Agent");
    expect(page.url()).toMatch(/^view:\/\/renderer\//);
    await expect(page.locator(".wizard")).toBeVisible();
    return { app, page, profile };
  } catch (error) { await app.close(); throw error; }
}

// A test-only worker dependency, installed in an isolated Electron profile.
// This verifies UI/protocol behavior, not physical camera accuracy. The real
// calibration implementation and actual model serialization have separate tests.
async function installWorkerFixture(page: Page, mode: "accurate" | "inaccurate" | "fit-error" | "camera-error" | "stalled-reset" = "accurate") {
  await page.evaluate((behavior) => {
    const video = document.getElementById("gaze-camera")!;
    Object.defineProperties(video, {
      readyState: { value: 4, configurable: true },
      videoWidth: { value: 640, configurable: true },
      videoHeight: { value: 480, configurable: true },
    });
    const calls = { collected: 0, fitted: 0, saved: 0, restored: false, destroyed: 0 };
    class TestWebcam {
      stopWebcam() {}
      getVideoSettings() { return { deviceId: "regression-camera", width: 640, height: 480 }; }
    }
    class TestProxy {
      onReady = (_restored: boolean) => {};
      onError = (_phase: string, _message: string) => {};
      onGazeResults = (_result: { normPog: number[]; timestamp: number; gazeState: string }) => {};
      onCalibrationPoint = (_ok: boolean, _x: number, _y: number) => {};
      onCalibrationApplied = (_ok: boolean, _rmse: number) => {};
      onCalibrationPointBegun = () => {};
      onCalibrationSaved = (_key: string) => {};
      timer: number;
      constructor(_webcam: TestWebcam, options: { calibrationKey?: string }) {
        calls.restored = Boolean(options.calibrationKey && localStorage.getItem("test.worker-profile"));
        queueMicrotask(() => {
          this.onReady(calls.restored);
          if (behavior === "camera-error") this.onError("camera", "Permission denied");
        });
        this.timer = window.setInterval(() => {
          const target = document.querySelector<HTMLElement>(".calibration-target");
          const x = behavior === "inaccurate" || !target ? 0.5 : parseFloat(target.style.left) / 100;
          const y = behavior === "inaccurate" || !target ? 0.5 : parseFloat(target.style.top) / 100;
          this.onGazeResults({ normPog: [x - 0.5, y - 0.5], timestamp: performance.now(), gazeState: "open" });
        }, 33);
      }
      beginCalibrationPoint() {
        if (behavior !== "stalled-reset") queueMicrotask(() => this.onCalibrationPointBegun());
      }
      calibrate(x: number, y: number) {
        calls.collected++;
        queueMicrotask(() => this.onCalibrationPoint(true, x, y));
      }
      applyCalibration() {
        calls.fitted++;
        queueMicrotask(() => behavior === "fit-error"
          ? this.onError("applyCalibration", "Calibration predictions are rank deficient")
          : this.onCalibrationApplied(true, 0));
      }
      saveCalibration(key: string) {
        calls.saved++;
        localStorage.setItem("test.worker-profile", key);
        queueMicrotask(() => this.onCalibrationSaved(key));
      }
      destroy() { window.clearInterval(this.timer); calls.destroyed++; }
    }
    Object.assign(window, { WebcamClient: TestWebcam, WebEyeTrackProxy: TestProxy, calibrationTestCalls: calls });
    const script = document.createElement("script");
    script.dataset.patchedWebeyetrack = "";
    document.head.appendChild(script);
  }, mode);
}

async function clickTrainingTargets(page: Page) {
  await page.getByRole("button", { name: "Start eye calibration", exact: true }).click();
  for (let target = 1; target <= 5; target++) {
    await expect(page.locator(".calibration-instruction")).toContainText(`dot ${target} of 5`);
    await page.getByRole("button", { name: "calibration target", exact: true }).click();
  }
}

async function clickVerificationTargets(page: Page) {
  for (let target = 1; target <= 4; target++) {
    await expect(page.locator(".calibration-instruction")).toContainText(`Accuracy check ${target} of 4`);
    if (target === 1) await page.screenshot({ path: "/tmp/view-calibration-check.png" });
    await page.getByRole("button", { name: "calibration target", exact: true }).click();
  }
}

const calls = (page: Page) => page.evaluate(() => (window as unknown as {
  calibrationTestCalls: { collected: number; fitted: number; saved: number; restored: boolean; destroyed: number };
}).calibrationTestCalls);

test("calibration UI saves only after four checks and a new process reuses the profile", async () => {
  const first = await launchCalibration();
  const errors: string[] = [];
  first.page.on("pageerror", error => errors.push(error.message));
  first.page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  try {
    await installWorkerFixture(first.page);
    await clickTrainingTargets(first.page);
    await clickVerificationTargets(first.page);
    await expect(first.page.locator(".notice")).toHaveText("Eye calibration saved. All four accuracy checks passed.");
    await expect(first.page.locator(".calibration-layer, .wizard, vite-error-overlay")).toHaveCount(0);
    expect(await calls(first.page)).toMatchObject({ collected: 5, fitted: 1, saved: 1, restored: false });
    expect(await first.page.evaluate(key => JSON.parse(localStorage.getItem(key)!).camera, metadataKey))
      .toEqual({ deviceId: "regression-camera", width: 640, height: 480 });
    expect(errors).toEqual([]);
  } finally { await first.app.close(); }

  const second = await launchCalibration(first.profile);
  try {
    await expect(second.page.getByRole("button", { name: "Start eye control", exact: true })).toBeVisible();
    await expect(second.page.getByRole("button", { name: "Recalibrate", exact: true })).toBeVisible();
    await second.page.screenshot({ path: "/tmp/view-calibration-saved.png" });
    await installWorkerFixture(second.page);
    await second.page.getByRole("button", { name: "Start eye control", exact: true }).click();
    await expect(second.page.locator(".notice")).toHaveText("Saved eye calibration restored. Gaze is active.");
    await expect(second.page.locator(".calibration-layer, .wizard")).toHaveCount(0);
    expect(await calls(second.page)).toMatchObject({ collected: 0, fitted: 0, saved: 0, restored: true });
  } finally { await second.app.close(); }
});

test("inaccurate readings cannot save a profile or enable gaze", async () => {
  const { app, page } = await launchCalibration();
  try {
    await installWorkerFixture(page, "inaccurate");
    await clickTrainingTargets(page);
    await clickVerificationTargets(page);
    await expect(page.locator(".notice")).toContainText("Accuracy checks failed at top-left, top-right, bottom-left, bottom-right. Gaze remains disabled.");
    await expect(page.getByRole("button", { name: "Quit View", exact: true })).toBeVisible();
    await expect(page.locator(".calibration-layer")).toHaveCount(0);
    expect(await calls(page)).toMatchObject({ collected: 5, fitted: 1, saved: 0, destroyed: 1 });
    expect(await page.evaluate(key => localStorage.getItem(key), metadataKey)).toBeNull();
    expect(await page.evaluate(() => localStorage.getItem("test.worker-profile"))).toBeNull();
  } finally { await app.close(); }
});

test("explicit unverified demo saves the five-point fit and starts real gaze without checks", async () => {
  const { app, page } = await launchCalibration(undefined, true);
  try {
    await expect(page.locator(".wizard")).toContainText("Accuracy checks will be skipped");
    await installWorkerFixture(page, "inaccurate");
    await clickTrainingTargets(page);
    await expect(page.locator(".notice")).toHaveText("Unverified demo gaze is active. The five-point mapping is saved, but accuracy checks were skipped.");
    await expect(page.locator(".calibration-layer, .wizard")).toHaveCount(0);
    await page.screenshot({ path: "/tmp/view-unverified-gaze-active.png" });
    expect(await calls(page)).toMatchObject({ collected: 5, fitted: 1, saved: 1, restored: false });
    expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).verified, metadataKey)).toBe(false);
  } finally { await app.close(); }
});

test("a worker fit error surfaces immediately instead of waiting for a timeout", async () => {
  const { app, page } = await launchCalibration();
  try {
    await installWorkerFixture(page, "fit-error");
    await clickTrainingTargets(page);
    await expect(page.locator(".notice")).toContainText("Calibration predictions are rank deficient", { timeout: 2000 });
    await expect(page.locator(".calibration-layer")).toHaveCount(0);
    expect(await calls(page)).toMatchObject({ fitted: 1, saved: 0, destroyed: 1 });
  } finally { await app.close(); }
});

test("the real bundled tracker preserves its correction and all weights in browser IndexedDB", async () => {
  const { app, page } = await launchCalibration();
  try {
    const result = await page.evaluate(async () => {
      await new Promise<void>((resolveLoad, rejectLoad) => {
        const script = document.createElement("script");
        script.src = new URL("./webeyetrack/webeyetrack.js", document.baseURI).toString();
        script.onload = () => resolveLoad();
        script.onerror = () => rejectLoad(new Error("Bundled tracker failed to load"));
        document.head.appendChild(script);
      });
      type Tracker = {
        faceLandmarkerClient: { initialize: () => Promise<void> };
        blazeGaze: { model: { getWeights: () => Array<{ dataSync: () => Float32Array }> } };
        recentCalibrationFrames: Array<{ point: number[]; timestamp: number }>;
        screenCalibration: { version: number; matrix: number[][]; fitRmse: number };
        initialize: (url?: string, key?: string) => Promise<boolean>;
        beginCalibrationPoint: () => void;
        calibrate: (x: number, y: number) => boolean;
        applyCalibration: () => boolean;
        saveCalibration: (key: string) => Promise<void>;
      };
      const Constructor = (window as unknown as { WebEyeTrack: new () => Tracker }).WebEyeTrack;
      const tracker = new Constructor();
      // No physical camera or face model is needed for the real IO regression.
      tracker.faceLandmarkerClient.initialize = async () => {};
      const fresh = await tracker.initialize(new URL("./web/model.json", document.baseURI).toString());
      for (const target of [[0, 0], [-0.4, -0.4], [0.4, -0.4], [-0.4, 0.4], [0.4, 0.4]]) {
        tracker.beginCalibrationPoint();
        tracker.recentCalibrationFrames = [1, 2, 3].map(timestamp => ({
          timestamp, point: [0.2 + 0.3 * target[0], -0.1 + 0.4 * target[1]],
        }));
        if (!tracker.calibrate(target[0], target[1])) throw new Error("Point was not collected");
      }
      if (!tracker.applyCalibration()) throw new Error("Correction was not fitted");
      await tracker.saveCalibration("view-indexeddb-regression");
      const restored = new Constructor();
      restored.faceLandmarkerClient.initialize = async () => {};
      const wasRestored = await restored.initialize(undefined, "view-indexeddb-regression");
      const before = tracker.blazeGaze.model.getWeights().map(weight => Array.from(weight.dataSync()));
      const after = restored.blazeGaze.model.getWeights().map(weight => Array.from(weight.dataSync()));
      const sample = [0.29, 0.02];
      return {
        fresh, wasRestored, version: restored.screenCalibration.version,
        sameCorrection: JSON.stringify(restored.screenCalibration) === JSON.stringify(tracker.screenCalibration),
        sameWeights: JSON.stringify(after) === JSON.stringify(before),
        mapped: restored.screenCalibration.matrix.map(row => row[0] * sample[0] + row[1] * sample[1] + row[2]),
        cameraUnused: (document.getElementById("gaze-camera") as HTMLVideoElement).srcObject === null,
      };
    });
    expect(result).toMatchObject({ fresh: false, wasRestored: true, version: 3, sameCorrection: true, sameWeights: true, cameraUnused: true });
    expect(result.mapped[0]).toBeCloseTo(0.3, 6);
    expect(result.mapped[1]).toBeCloseTo(0.3, 6);
  } finally { await app.close(); }
});

test("camera startup errors retain their actual cause", async () => {
  const { app, page } = await launchCalibration();
  try {
    await installWorkerFixture(page, "camera-error");
    await page.getByRole("button", { name: "Start eye calibration", exact: true }).click();
    await expect(page.locator(".notice")).toContainText("WebEyeTrack camera failed: Permission denied", { timeout: 2000 });
    expect(await calls(page)).toMatchObject({ collected: 0, fitted: 0, saved: 0, destroyed: 1 });
  } finally { await app.close(); }
});

test("Escape cancels a pending worker command and leaves Quit available", async () => {
  const { app, page } = await launchCalibration();
  try {
    await installWorkerFixture(page, "stalled-reset");
    await page.getByRole("button", { name: "Start eye calibration", exact: true }).click();
    await expect(page.locator(".calibration-instruction")).toContainText("dot 1 of 5");
    await page.getByRole("button", { name: "calibration target", exact: true }).click();
    await expect(page.locator(".calibration-instruction")).toContainText("Capturing gaze");
    await page.keyboard.press("Escape");
    await expect(page.locator(".notice")).toContainText("Calibration cancelled", { timeout: 1000 });
    await expect(page.locator(".calibration-layer")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Quit View", exact: true })).toBeVisible();
    expect(await calls(page)).toMatchObject({ fitted: 0, saved: 0, destroyed: 1 });
  } finally { await app.close(); }
});
