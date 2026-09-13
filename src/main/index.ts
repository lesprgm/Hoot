import { app, BrowserWindow, ipcMain, screen, globalShortcut, net, protocol } from "electron";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { config } from "./config";
import { IPC } from "../shared/ipc";
import type { AppConfig, ViewMessage } from "../shared/types";
import { InteractionController } from "./state/InteractionController";
import { checkPermissions, probeCamera } from "./permissions";
import { readMacSafeAreaGeometry } from "./display/SafeArea";

const isMac = process.platform === "darwin";
let mainWindow: BrowserWindow | null = null;
let controller: InteractionController | null = null;

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

function broadcast(message: ViewMessage): void {
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
  // Demo screenshots must include the overlay; live model captures must not.
  mainWindow.setContentProtection(!config.simulateGaze);
  mainWindow.webContents.on("did-fail-load", (_event, code, description, url) => {
    console.error("renderer failed to load", { code, description, url });
  });
  mainWindow.webContents.on("console-message", (_event, level, message) => {
    if (message.startsWith("[calibration]")) console.log(message);
    else if (level >= 2) console.error("renderer console", message);
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
    broadcast({ type: "notice", text: "Simulated gaze: move the mouse to look. Hold Shift to freeze. Keys 1-4/B/M/H/X/N drive the demo." });
  });

  ipcMain.handle(IPC.quitApp, async () => {
    app.quit();
  });

  ipcMain.handle(IPC.summon, async () => {
    ctrl()?.summon();
  });

  ipcMain.handle(IPC.selectOption, async (_e, quadrant: "A" | "B" | "C" | "D") => {
    await ctrl()?.selectOption(quadrant);
  });

  ipcMain.handle(IPC.more, async () => {
    await ctrl()?.more();
  });

  ipcMain.handle(IPC.back, async () => {
    await ctrl()?.back();
  });

  ipcMain.handle(IPC.beginHint, async () => {
    await ctrl()?.beginHint();
  });

  ipcMain.handle(IPC.updateHint, async (_e, text: string) => {
    await ctrl()?.updateHint(text);
  });

  ipcMain.handle(IPC.clearHint, async () => {
    await ctrl()?.clearHint();
  });

  ipcMain.handle(IPC.acceptHintCandidate, async (_e, id: string) => {
    await ctrl()?.acceptHintCandidate(id);
  });

  ipcMain.handle(IPC.commitHintLiteral, async (_e, text: string) => {
    await ctrl()?.commitHintLiteral(text);
  });

  ipcMain.handle(IPC.requestCompletion, async () => {
    await ctrl()?.requestCompletion();
  });

  ipcMain.handle(IPC.exitSession, async () => {
    await ctrl()?.exitSession();
  });

  ipcMain.handle(IPC.confirmYes, async () => {
    await ctrl()?.confirmYes();
  });

  ipcMain.handle(IPC.confirmChange, async () => {
    await ctrl()?.confirmChange();
  });

  ipcMain.handle(IPC.confirmRead, async () => {
    await ctrl()?.confirmRead();
  });

  ipcMain.handle(IPC.confirmCancel, async () => {
    await ctrl()?.confirmCancel();
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

  ipcMain.handle(IPC.gazeAnchor, async (_e, anchor: { xNorm: number; yNorm: number; windowXNorm: number | null; windowYNorm: number | null; insideActiveWindow: boolean }) => {
    ctrl()?.setAttentionAnchor({ ...anchor, screenXNorm: anchor.xNorm, screenYNorm: anchor.yNorm });
  });

  ipcMain.handle(IPC.gazeSampleTelemetry, async (_e, valid: boolean) => {
    ctrl()?.onGazeConfidence(valid);
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
      telemetry: c.metricsSummary,
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
      case "hint":
        await c.beginHint();
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

  ipcMain.handle(IPC.getTelemetry, async () => ctrl()?.metricsSummary ?? null);
}

async function bootstrap(): Promise<void> {
  await app.whenReady();
  registerRendererProtocol();
  const geometry = await displayGeometry();
  controller = new InteractionController(broadcast, config.elevenLabsVoiceId, {
    screenWidth: geometry.width,
    screenHeight: geometry.height,
    screenScale: geometry.scale,
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
    : config.decoderProvider === "openai"
      ? config.hasOpenAiKey
      : true;
  const decoderKeyName = config.decoderProvider === "gemini" ? "GEMINI_API_KEY" : "OPENAI_API_KEY";
  const startupNotice = !decoderReady
      ? `Live gaze enabled. ${decoderKeyName} is not set, so ${config.decoderProvider} prompt decoding will stop with a configuration error.`
      : config.decoderProvider === "gemini"
        ? "Assistive session enabled with live gaze and Gemini 3.5 Flash decoding; execution follows its separate provider configuration."
        : config.decoderProvider === "fixture"
          ? "Assistive session enabled with live gaze and deterministic fixture decoding; execution follows its separate provider configuration."
        : "Assistive session enabled with live gaze and OpenAI providers.";
  if (!config.simulateGaze) broadcast({ type: "notice", text: startupNotice });

  app.on("window-all-closed", () => {
    app.quit();
  });
}

app.whenReady().then(bootstrap).catch((err) => {
  console.error("fatal bootstrap error", err);
  app.quit();
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});
