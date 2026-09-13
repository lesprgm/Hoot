/// <reference lib="dom" />

import { test, expect, _electron as electron } from "playwright/test";
import { join, resolve } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

test("simulation exercises stationary summon and explicit Dasher text entry", async () => {
  const errors: string[] = [];
  const app = await electron.launch({
    args: ["."],
    cwd: resolve(__dirname, "../.."),
    env: {
      ...process.env,
      SIMULATE_GAZE: "true",
      GAZE_PROVIDER: "simulated",
      EXECUTION_MODE: "live",
      EXECUTOR_PROVIDER: "openai",
      DECODER_PROVIDER: "fixture",
      TTS_PROVIDER: "mute",
      OPENAI_API_KEY: "",
      NODE_ENV: "production",
    },
  });
  try {
    const window = await app.firstWindow();
    window.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await window.waitForLoadState("domcontentloaded");
    await expect(window).toHaveTitle("Gaze Agent");
    await expect(window.locator(".sprite")).toBeVisible();
    await window.evaluate(() => {
      const state = globalThis as unknown as { __viewAudioCues: string[] };
      state.__viewAudioCues = [];
      globalThis.addEventListener("view:audio-cue", (event: Event) => {
        state.__viewAudioCues.push((event as CustomEvent<string>).detail);
      });
    });
    await expect(window.locator(".topbar")).toHaveCount(0);
    await expect(window.locator(".fixture-host, .fixture-picker, .fixture-frame")).toHaveCount(0);
    const windowSafety = await app.evaluate(({ BrowserWindow }) => {
      const overlay = BrowserWindow.getAllWindows()[0];
      return { focusable: overlay.isFocusable(), alwaysOnTop: overlay.isAlwaysOnTop() };
    });
    expect(windowSafety).toEqual({ focusable: false, alwaysOnTop: true });
    const spriteAssets = await window.evaluate(async () => {
      const [idle, working] = await Promise.all([
        fetch(new URL("./sprites/owl-idle.png", document.baseURI)),
        fetch(new URL("./sprites/owl-working.png", document.baseURI)),
      ]);
      const art = document.querySelector<HTMLElement>(".sprite-art");
      return {
        idleAvailable: idle.ok,
        workingAvailable: working.ok,
        frameAnimation: getComputedStyle(art ?? document.body).animationName,
        frameDuration: getComputedStyle(art ?? document.body).animationDuration,
      };
    });
    expect(spriteAssets).toEqual({ idleAvailable: true, workingAvailable: true, frameAnimation: "owl-idle-frames", frameDuration: "7.2s" });

    const geometry = await window.evaluate(() => (globalThis as unknown as { __gazeIpc: { invoke: (channel: string) => Promise<{ displayGeometry?: { topInset: number; notchLeftX: number | null; notchRightX: number | null } }> } }).__gazeIpc.invoke("app:get-config"));
    if (geometry.displayGeometry?.notchLeftX != null && geometry.displayGeometry.notchRightX != null) {
      const notch = await window.locator(".perceived-notch").boundingBox();
      expect(notch).not.toBeNull();
      expect(notch!.x).toBeCloseTo(geometry.displayGeometry.notchLeftX, 0);
      expect(notch!.width).toBeCloseTo(geometry.displayGeometry.notchRightX - geometry.displayGeometry.notchLeftX, 0);
      expect(notch!.y).toBeCloseTo(-2, 0);
      expect(notch!.height).toBeCloseTo(geometry.displayGeometry.topInset + 64, 0);
      expect(notch!.y + notch!.height).toBeCloseTo(geometry.displayGeometry.topInset + 62, 0);
    }

    const sprite = await window.locator(".sprite").boundingBox();
    expect(sprite).not.toBeNull();
    await window.waitForTimeout(300);
    await window.evaluate(({ x, y }) => {
      globalThis.dispatchEvent(new MouseEvent("mousemove", { clientX: x, clientY: y }));
    }, { x: sprite!.x + sprite!.width / 2, y: sprite!.y + sprite!.height / 2 });
    await window.waitForTimeout(150);
    await expect(window.locator(".sprite")).toHaveClass(/sprite-state-dwelling/);
    expect(await window.locator(".sprite").evaluate((element) => getComputedStyle(element).animationName)).toContain("sprite-kick");
    await window.waitForTimeout(900);
    await expect(window.locator(".prompt-buffer")).toContainText("I want you to");
    await expect(window.locator(".quadrant")).toHaveCount(4);
    await expect.poll(() => window.evaluate(() => (globalThis as unknown as { __viewAudioCues: string[] }).__viewAudioCues)).toContain("ready");
    const panels = await window.locator(".quadrant").evaluateAll((elements) => elements.map((element) => {
      const card = element.getBoundingClientRect();
      const target = element.parentElement!.getBoundingClientRect();
      const css = getComputedStyle(element);
      return { background: css.backgroundColor, color: css.color,
        insideTarget: card.left >= target.left && card.right <= target.right && card.top >= target.top && card.bottom <= target.bottom,
        visibleFraction: card.width * card.height / (target.width * target.height) };
    }));
    for (const panel of panels) {
      expect(panel.color).toBe("rgb(17, 19, 24)");
      expect(panel.background).toBe("rgba(250, 249, 246, 0.9)");
      expect(panel.insideTarget).toBe(true);
      expect(panel.visibleFraction).toBeGreaterThan(0.55);
      expect(panel.visibleFraction).toBeLessThan(0.70);
    }

    await window.keyboard.press("1");
    await expect.poll(() => window.evaluate(() => (globalThis as unknown as { __viewAudioCues: string[] }).__viewAudioCues)).toContain("selection");
    await expect.poll(() => window.evaluate(() => (globalThis as unknown as { __viewAudioCues: string[] }).__viewAudioCues.filter((cue) => cue === "ready").length)).toBeGreaterThanOrEqual(2);
    await window.screenshot({ path: "/tmp/view-audio-feedback-cards.png" });

    await window.keyboard.press("h");
    await expect(window.locator(".dasher-panel")).toBeVisible();
    await expect(window.locator(".dasher-title")).toContainText("READY", { timeout: 30_000 });
    const dasher = window.frameLocator(".dasher-frame");
    await expect(dasher.locator("#canvas")).toBeVisible();
    await expect(dasher.locator("#status")).toContainText("Ready");
    await expect(window.locator(".dasher-actions button")).toHaveCount(4);

    const upstreamGazeAssets = await window.evaluate(async () => {
      await new Promise<void>((resolveLoad, rejectLoad) => {
        const script = document.createElement("script");
        script.src = new URL("./webeyetrack/webeyetrack.js", document.baseURI).toString();
        script.onload = () => resolveLoad();
        script.onerror = () => rejectLoad(new Error("patched WebEyeTrack bundle failed to load"));
        document.head.appendChild(script);
      });
      const gazeModule = window as unknown as { WebcamClient?: unknown; WebEyeTrackProxy?: unknown };
      const [gazeModel, faceModel, wasmRuntime] = await Promise.all([
        fetch(new URL("./web/model.json", document.baseURI)),
        fetch(new URL("./mediapipe/face_landmarker.task", document.baseURI)),
        fetch(new URL("./mediapipe/wasm/vision_wasm_internal.wasm", document.baseURI)),
      ]);
      return {
        webcamClient: typeof gazeModule.WebcamClient,
        proxy: typeof gazeModule.WebEyeTrackProxy,
        assetsAvailable: gazeModel.ok && faceModel.ok && wasmRuntime.ok,
      };
    });
    expect(upstreamGazeAssets).toEqual({ webcamClient: "function", proxy: "function", assetsAvailable: true });

    await window.screenshot({ path: "/tmp/gaze-agent-dasher.png" });
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});

test("semantic gaze prefetches the focused branch before dwell commits", async () => {
  const app = await launchDemo();
  const window = await app.firstWindow();
  const invoke = (channel: string, ...args: unknown[]) => window.evaluate(
    ({ channel: target, args: values }) => (window as unknown as { __gazeIpc: { invoke: (name: string, ...items: unknown[]) => Promise<unknown> } }).__gazeIpc.invoke(target, ...values),
    { channel, args },
  );
  try {
    await expect.poll(async () => (await invoke("debug:get") as { state: string }).state).toBe("PASSIVE");
    await invoke("session:summon");
    await expect(window.locator(".prompt-buffer")).toBeVisible();
    await expect(window.locator(".quadrant-target")).toHaveCount(4);
    const card = await window.locator('[data-gaze-region="A"]').boundingBox();
    expect(card).not.toBeNull();
    await window.mouse.move(card!.x + card!.width / 2, card!.y + card!.height / 2);
    await window.waitForTimeout(300);

    const before = await invoke("debug:get") as { telemetry: { decoderColdLatencyMs: number[]; prefetchHits: number } };
    expect(before.telemetry.decoderColdLatencyMs.length).toBeGreaterThanOrEqual(1);

    await window.keyboard.press("1");
    await expect.poll(async () => (await invoke("debug:get") as { telemetry: { prefetchHits: number } }).telemetry.prefetchHits).toBeGreaterThanOrEqual(1);
    await expect(window.locator(".prompt-buffer")).toContainText("I want you to find");
    await window.screenshot({ path: "/tmp/view-prefetch-semantic-card.png" });
  } finally {
    await app.close();
  }
});

test("live startup contains no simulated surface and requires eye calibration", async () => {
  const app = await electron.launch({
    args: [`--user-data-dir=${mkdtempSync(join(tmpdir(), "view-startup-e2e-"))}`, "."], cwd: resolve(__dirname, "../.."),
    env: { ...process.env, SIMULATE_GAZE: "false", GAZE_PROVIDER: "webeyetrack", EXECUTION_MODE: "live", EXECUTOR_PROVIDER: "openai", DECODER_PROVIDER: "fixture", TTS_PROVIDER: "mute", OPENAI_API_KEY: "", NODE_ENV: "production" },
  });
  try {
    const window = await app.firstWindow();
    await expect(window.getByRole("button", { name: "Start eye calibration" })).toBeVisible();
    await expect(window.getByRole("button", { name: "Quit View" })).toBeVisible();
    await expect(window.locator(".fixture-host")).toHaveCount(0);
    await expect(window.locator(".fixture-picker")).toHaveCount(0);
    await expect(window.locator(".topbar")).toHaveCount(0);
    await expect(window.locator(".wizard")).toContainText("Gaze controls stay disabled until calibration passes");
    expect(await window.locator("#gaze-camera").evaluate((video) => (video as HTMLVideoElement).srcObject === null)).toBe(true);
    const closed = window.waitForEvent("close");
    await window.getByRole("button", { name: "Quit View" }).click();
    await closed;
  } finally {
    if (!(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length === 0).catch(() => true))) await app.close();
  }
});

test("completed intent executes directly and unavailable executor recovery returns to composition", async () => {
  const app = await launchDemo();
  const window = await app.firstWindow();
  const invoke = (channel: string, ...args: unknown[]) => window.evaluate(
    ({ channel: target, args: values }) => (window as unknown as { __gazeIpc: { invoke: (name: string, ...items: unknown[]) => Promise<unknown> } }).__gazeIpc.invoke(target, ...values),
    { channel, args },
  );
  try {
    await invoke("session:summon");
    await expect(window.locator(".prompt-buffer")).toBeVisible();

    await invoke("session:commit-hint-literal", "find a file");
    await expect(window.locator(".recovery")).toBeVisible({ timeout: 5_000 });
    await invoke("recovery:choose", "choose_else");
    await expect(window.locator(".prompt-buffer")).toBeVisible({ timeout: 5_000 });
    await expect.poll(async () => (await invoke("debug:get") as { state: string }).state).toBe("SEMANTIC");
  } finally {
    await app.close();
  }
});

async function launchDemo() {
  const app = await electron.launch({
    args: ["."],
    cwd: resolve(__dirname, "../.."),
    env: {
      ...process.env,
      SIMULATE_GAZE: "true",
      GAZE_PROVIDER: "simulated",
      EXECUTION_MODE: "live",
      EXECUTOR_PROVIDER: "openai",
      DECODER_PROVIDER: "fixture",
      TTS_PROVIDER: "mute",
      OPENAI_API_KEY: "",
      NODE_ENV: "production",
    },
  });
  const window = await app.firstWindow();
  await window.waitForLoadState("domcontentloaded");
  await expect(window).toHaveTitle("Gaze Agent");
  await expect(window.locator(".sprite")).toBeVisible();
  await window.waitForFunction(() => document.documentElement.style.getPropertyValue("--notch-height").length > 0);
  return app;
}
