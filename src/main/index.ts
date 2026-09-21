import { app, BrowserWindow, ipcMain, screen, globalShortcut, net, protocol } from "electron";
import { existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { config } from "./config";
import { IPC } from "../shared/ipc";
import type { AppConfig, ViewMessage } from "../shared/types";
import { isSelectionEnvelope } from "../shared/decisions";
import { InteractionController } from "./state/InteractionController";
import { checkPermissions, probeCamera } from "./permissions";
import { readMacSafeAreaGeometry } from "./display/SafeArea";

const isMac = process.platform === "darwin";
let mainWindow: BrowserWindow | null = null;
let controller: InteractionController | null = null;
let notchHost: ChildProcess | null = null;
let nativeNotchHostAvailable = false;

protocol.registerSchemesAsPrivileged([
  {
    scheme: "view",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

function registerRendererProtocol(): void {
  const rendererRoot = resolve(app.getAppPath(), "out", "renderer");
  protocol.handle("view", (request) => {
    const url = new URL(request.url);
    if (url.host !== "renderer") return new Response("Not found", { status: 404 });
    const requestedPath = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
    const filePath = resolve(rendererRoot, requestedPath);
    const pathFromRoot = relative(rendererRoot, filePath);
    if (!pathFromRoot || pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) {
      return new Response("Invalid renderer path", { status: 400 });
    }
    return net.fetch(pathToFileURL(filePath).toString());
  });
}

function findNativeNotchHost(): string | null {
  const candidates = [
    join(process.cwd(), "native", "ViewNotchHost"),
    join(app.getAppPath(), "native", "ViewNotchHost"),
    join(process.resourcesPath, "native", "ViewNotchHost"),
    join(process.resourcesPath, "app.asar.unpacked", "native", "ViewNotchHost"),
  ];
  return candidates.find(existsSync) ?? null;
}

function findNativeScreenCaptureHost(): string | null {
  const candidates = [
    join(process.cwd(), "native", "ViewScreenCaptureHost"),
    join(app.getAppPath(), "native", "ViewScreenCaptureHost"),
    join(process.resourcesPath, "native", "ViewScreenCaptureHost"),
    join(process.resourcesPath, "app.asar.unpacked", "native", "ViewScreenCaptureHost"),
  ];
  return candidates.find(existsSync) ?? null;
}

function findSpriteDirectory(): string | null {
  const candidates = [
    join(process.cwd(), "src", "renderer", "public", "sprites"),
    join(app.getAppPath(), "src", "renderer", "public", "sprites"),
    join(app.getAppPath(), "out", "renderer", "sprites"),
    join(process.resourcesPath, "app.asar.unpacked", "renderer", "sprites"),
  ];
  return candidates.find(existsSync) ?? null;
}

function startNativeNotchHost(): void {
  if (!isMac) return;
  const executable = findNativeNotchHost();
  if (!executable) {
    console.warn("Native notch host is unavailable; using the renderer fallback.");
    return;
  }

  const spriteDirectory = findSpriteDirectory();
  const child = spawn(executable, spriteDirectory ? [spriteDirectory] : [], {
    cwd: app.getAppPath(),
    stdio: ["pipe", "ignore", "ignore"],
  });
  notchHost = child;
  nativeNotchHostAvailable = true;
  // A helper can exit while the renderer is still publishing sprite frames.
  // Handle the pipe error on the stream itself; a try/catch around write()
  // cannot catch an asynchronous EPIPE emitted by Node's Writable stream.
  child.stdin?.once("error", (error) => {
    console.warn("Native notch host input closed", error instanceof Error ? error.message : String(error));
    if (notchHost === child) {
      notchHost = null;
      nativeNotchHostAvailable = false;
    }
  });
  child.once("error", (error) => {
    console.error("Native notch host failed", error);
    if (notchHost === child) {
      notchHost = null;
      nativeNotchHostAvailable = false;
    }
  });
  child.once("exit", () => {
    if (notchHost === child) {
      notchHost = null;
      nativeNotchHostAvailable = false;
    }
  });
}

function sendNotchVisual(update: { sprite: string; progress?: number | null; focused?: boolean; visible?: boolean }): void {
  const input = notchHost?.stdin;
  if (!nativeNotchHostAvailable || !input || input.destroyed || input.writableEnded) return;
  try {
    input.write(`${JSON.stringify(update)}\n`);
  } catch (error) {
    console.error("Could not update native notch host", error);
  }
}

function stopNativeNotchHost(): void {
  const child = notchHost;
  notchHost = null;
  nativeNotchHostAvailable = false;
  if (!child) return;
  child.stdin?.end();
  setTimeout(() => {
    if (!child.killed) child.kill();
  }, 500);
}

function broadcast(message: ViewMessage): void {
  if (message.type === "sprite") {
    sendNotchVisual({ sprite: message.sprite, visible: true });
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC.viewUpdate, message);
  }
}

async function displayGeometry(): Promise<{ width: number; height: number; scale: number; topInset: number; notchCenterX: number | null; notchLeftX: number | null; notchRightX: number | null }> {
  try {
    await app.whenReady();
    const display = await screen.getPrimaryDisplay();
    const scale = display.scaleFactor ?? 1;
    const { width, height } = display.bounds;
    const nativeGeometry = await readMacSafeAreaGeometry();
    const workAreaTopInset = Math.max(0, display.workArea.y - display.bounds.y);
    const topInset = nativeGeometry?.topInset ?? workAreaTopInset;
    return {
      width: Math.round(width),
      height: Math.round(height),
      scale,
      topInset: Math.round(topInset),
      notchCenterX: nativeGeometry?.notchCenterX ?? null,
      notchLeftX: nativeGeometry?.notchLeftX ?? null,
      notchRightX: nativeGeometry?.notchRightX ?? null,
    };
  } catch {
    return { width: 1920, height: 1080, scale: 1, topInset: 38, notchCenterX: null, notchLeftX: null, notchRightX: null };
  }
}

async function createWindow(): Promise<void> {
  const display = screen.getPrimaryDisplay();
  mainWindow = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    show: true,
    backgroundColor: "#00000000",
    title: "Gaze Agent",
    transparent: true,
    frame: false,
    hasShadow: false,
    skipTaskbar: true,
    resizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Floating keeps View above ordinary applications without covering macOS
  // shutdown, Force Quit, and other system-owned safety surfaces.
  mainWindow.setAlwaysOnTop(true, "floating");
  // Keep the live overlay out of Astra's normal desktop screenshots. An
  // explicit recording mode exposes the overlay to Hoots' recorder while the
  // executor switches to the filtered ScreenCaptureKit capture path.
  mainWindow.setContentProtection(!config.simulateGaze && !config.settings.hootsRecordingMode);
  mainWindow.webContents.on("did-fail-load", (_event, code, description, url) => {
    console.error("renderer failed to load", { code, description, url });
  });
  mainWindow.webContents.on("console-message", (details) => {
    if (details.message.startsWith("[calibration]")) console.log(details.message);
    else if (details.level === "warning" || details.level === "error") console.error("renderer console", details.message);
  });

  const { width, height, scale } = await displayGeometry();
  controller?.setScreenSize(width, height);
  void scale;

  const envFile = process.env.ELECTRON_RENDERER_URL ?? process.env.VITE_DEV_SERVER_URL;
  if (!app.isPackaged && envFile) {
    await mainWindow.loadURL(envFile);
  } else {
    await mainWindow.loadURL("view://renderer/index.html");
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function registerIpc(): void {
  const ctrl = () => controller;

  ipcMain.handle(IPC.getConfig, async (): Promise<AppConfig> => ({
    ...config,
    nativeNotchHostAvailable,
    displayGeometry: await displayGeometry(),
  }));

  ipcMain.handle(IPC.getPermissionStatus, async () => {
    const status = await checkPermissions();
    status.camera = (await probeCamera()) ? "granted" : "unknown";
    return status;
  });

  ipcMain.handle(IPC.prepareCalibration, async () => {
    if (!controller || !mainWindow) throw new Error("Application is not ready.");
    controller.setDemoMode(false);
    controller.machine.set("CALIBRATING");
    mainWindow.setIgnoreMouseEvents(false);
    mainWindow.setFocusable(true);
    mainWindow.show();
    broadcast({ type: "app-mode", mode: "live" });
    broadcast({ type: "gaze-status", status: "disabled" });
  });

  ipcMain.handle(IPC.calibrationFailed, async (_e, message: string) => {
    controller?.machine.set("CALIBRATION_ERROR");
    mainWindow?.setIgnoreMouseEvents(false);
    mainWindow?.setFocusable(true);
    broadcast({ type: "gaze-status", status: "disabled" });
    broadcast({ type: "notice", text: message });
  });

  ipcMain.handle(IPC.startCalibration, async () => {
    if (!controller || !mainWindow) return { ok: false, message: "Application is not ready." };
    controller.setDemoMode(false);
    controller.machine.set("PASSIVE");
    mainWindow.setIgnoreMouseEvents(true, { forward: true });
    mainWindow.setFocusable(false);
    broadcast({ type: "state", state: "PASSIVE" });
    broadcast({ type: "app-mode", mode: "live" });
    broadcast({ type: "gaze-status", status: "active" });
    return { ok: true, message: "Live gaze calibration accepted." };
  });

  ipcMain.handle(IPC.enterDemoMode, async () => {
    if (!config.simulateGaze) throw new Error("Simulated gaze is disabled in live mode.");
    if (!controller) return;
    controller.setDemoMode(true);
    controller.machine.set("PASSIVE");
    // Forward pointer movement to the simulator while allowing clicks to reach
    // the actual desktop underneath the transparent overlay.
    mainWindow?.setIgnoreMouseEvents(true, { forward: true });
    mainWindow?.setFocusable(false);
    broadcast({ type: "state", state: "PASSIVE" });
    broadcast({ type: "app-mode", mode: "simulated" });
    broadcast({ type: "gaze-status", status: "active" });
    broadcast({ type: "notice", text: "Simulated gaze: move the mouse to look. Hold Shift to freeze. Keys 1-4/B/M/X/N drive the demo." });
  });

  ipcMain.handle(IPC.quitApp, async () => {
    app.quit();
  });

  ipcMain.handle(IPC.summon, async () => {
    ctrl()?.summon();
  });

  ipcMain.handle(IPC.prefetchOption, async (_e, quadrant: "A" | "B" | "C" | "D") => {
    await ctrl()?.prefetchOption(quadrant);
  });

  ipcMain.handle(IPC.selectOption, async (_e, selection: unknown) => {
    if (!isSelectionEnvelope(selection)) return;
    await ctrl()?.selectOption(selection);
  });

  ipcMain.handle(IPC.more, async () => {
    await ctrl()?.more();
  });

  ipcMain.handle(IPC.back, async () => {
    await ctrl()?.back();
  });

  ipcMain.handle(IPC.exitSession, async () => {
    await ctrl()?.exitSession();
  });

  ipcMain.handle(IPC.interruptExecutor, async () => {
    await ctrl()?.interruptExecutor();
  });

  ipcMain.handle(IPC.steer, async (_e, choice: string) => {
    await ctrl()?.steer(choice);
  });

  ipcMain.handle(IPC.consequentialChoice, async (_e, choice: string) => {
    await ctrl()?.consequentialChoice(choice);
  });

  ipcMain.handle(IPC.recovery, async (_e, choice: string) => {
    await ctrl()?.recovery(choice);
  });

  ipcMain.handle(IPC.contextToggle, async () => {
    await ctrl()?.toggleContext();
  });

  ipcMain.handle(IPC.contextApproveSession, async () => {
    await ctrl()?.approveContextSession();
  });

  ipcMain.handle(IPC.gazeAnchor, async (_e, anchor: { xNorm: number; yNorm: number; windowXNorm: number | null; windowYNorm: number | null; insideActiveWindow: boolean }) => {
    ctrl()?.setAttentionAnchor({ ...anchor, screenXNorm: anchor.xNorm, screenYNorm: anchor.yNorm });
  });

  ipcMain.handle(IPC.gazeSample, async (_e, valid: boolean) => {
    ctrl()?.onGazeConfidence(valid);
  });

  ipcMain.handle(IPC.notchVisual, async (_e, update: { sprite: string; progress: number | null; focused: boolean }) => {
    sendNotchVisual(update);
  });

  ipcMain.handle(IPC.navigationScroll, async (_e, payload: { direction: "next" | "previous"; deltaPx: number }) => {
    const controller = ctrl();
    if (!controller) return;
    const anchor = controller.currentAttentionAnchor;
    if (!anchor?.insideActiveWindow) return;
    try {
      const nut = await import("@nut-tree-fork/nut-js");
      await nut.mouse.setPosition({ x: Math.round(anchor.screenXNorm * controller.screenWidth), y: Math.round(anchor.screenYNorm * controller.screenHeight) });
      const amount = Math.max(1, Math.round(payload.deltaPx / 100));
      if (payload.direction === "next") await nut.mouse.scrollDown(amount);
      else await nut.mouse.scrollUp(amount);
    } catch {
      controller.notice("Navigation input is unavailable; install the optional nut.js dependency for live scrolling.");
    }
  });

  ipcMain.handle(IPC.getDebugInfo, async () => {
    const c = ctrl();
    if (!c) return null;
    return {
      state: c.machine.state,
      decoderProvider: c.providerNames.decoder,
      ttsProvider: c.providerNames.tts,
      gazeProvider: c.providerNames.gaze,
      activeApp: c.activeAppPretty,
      layoutMode: "screen_corners",
    };
  });

  ipcMain.handle(IPC.toggleHud, async () => {});

  ipcMain.handle(IPC.forceState, async (_e, state: string) => {
    ctrl()?.machine.transition("force", { forceState: state as never });
    broadcast({ type: "state", state: state as never });
  });

  ipcMain.handle(IPC.simulateAction, async (_e, action: string) => {
    const c = ctrl();
    if (!c) return;
    switch (action) {
      case "summon":
        await c.summon();
        break;
      case "more":
        await c.more();
        break;
      case "back":
        await c.back();
        break;
      case "exit":
        await c.exitSession();
        break;
      case "gaze_lost":
        c.onGazeConfidence(false);
        break;
      case "gaze_restored":
        c.onGazeConfidence(true);
        break;
    }
  });

}

async function bootstrap(): Promise<void> {
  await app.whenReady();
  startNativeNotchHost();
  registerRendererProtocol();
  const geometry = await displayGeometry();
  controller = new InteractionController(broadcast, config.elevenLabsVoiceId, {
    screenWidth: geometry.width,
    screenHeight: geometry.height,
    screenScale: geometry.scale,
    contextAllowedApps: config.contextAllowedApps,
    astraCaptureHost: findNativeScreenCaptureHost(),
    overlayProcessIds: () => {
      const ids = [process.pid, notchHost?.pid ?? 0];
      if (mainWindow && !mainWindow.isDestroyed()) {
        try {
          ids.push(mainWindow.webContents.getOSProcessId());
        } catch {
          // The renderer may be between creation and teardown. The main and
          // native helper PIDs remain available for the next capture.
        }
      }
      return [...new Set(ids.filter((pid) => Number.isInteger(pid) && pid > 0))];
    },
  });
  controller.setScreenSize(geometry.width, geometry.height);
  registerIpc();

  if (process.env.NODE_ENV !== "development" && process.env.VITE_DEV_SERVER_URL) {
    process.env.NODE_ENV = "production";
  }

  await Promise.all([
    controller.startContextPolling(),
    createWindow(),
  ]);
  try {
    const quitAccelerator = "CommandOrControl+Alt+Shift+V";
    const quitRegistered = globalShortcut.register(quitAccelerator, () => app.quit());
    if (!quitRegistered) console.error(`Could not register emergency quit shortcut ${quitAccelerator}.`);
    if (config.debugHud) globalShortcut.register("CommandOrControl+Shift+D", () => {});
  } catch {
    // The visible Quit action remains available if shortcut registration fails.
  }

  broadcast({ type: "app-mode", mode: config.simulateGaze ? "simulated" : "live" });
  broadcast({ type: "settings", settings: config.settings });
  broadcast({ type: "gaze-status", status: config.simulateGaze ? "active" : "disabled" });

  if (!config.simulateGaze) {
    controller.machine?.set("SETUP_REQUIRED");
  } else {
    controller.machine?.set("PASSIVE");
    mainWindow?.setIgnoreMouseEvents(true, { forward: true });
    mainWindow?.setFocusable(false);
  }
  broadcast({ type: "state", state: controller.machine?.state ?? "PASSIVE" });
  broadcast({ type: "sprite", sprite: "idle" });
  const decoderReady = config.decoderProvider === "gemini"
    ? config.hasGeminiKey
    : config.decoderProvider === "openrouter"
      ? config.hasOpenRouterKey
      : true;
  const decoderKeyName = config.decoderProvider === "gemini"
    ? "GEMINI_API_KEY"
    : config.decoderProvider === "openrouter"
      ? "OPENROUTER_API_KEY"
      : null;
  // Successful live startup is intentionally quiet. Provider identity remains
  // available in the debug HUD; only a missing required key is surfaced as an
  // actionable notice.
  if (!config.simulateGaze && !decoderReady && decoderKeyName) {
    broadcast({ type: "notice", text: `Live gaze enabled. ${decoderKeyName} is not set, so ${config.decoderProvider} prompt decoding will stop with a configuration error.` });
  }
  if (!config.simulateGaze && config.decoderFallbackProvider === "gemini" && !config.hasGeminiKey) {
    broadcast({ type: "notice", text: "Direct Gemini API fallback is configured but GEMINI_API_KEY is not set; OpenRouter transport failures will remain explicit." });
  }

  app.on("window-all-closed", () => {
    app.quit();
  });
}

app.whenReady().then(bootstrap).catch((err) => {
  console.error("fatal bootstrap error", err);
  app.quit();
});

app.on("will-quit", () => {
  controller?.stopContextPolling();
  globalShortcut.unregisterAll();
  stopNativeNotchHost();
});
