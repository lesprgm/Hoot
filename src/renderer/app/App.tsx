import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AppConfig, AudioCue, GazeSample, TelemetrySummary } from "../../shared/types";
import { api, applyMessage, initialViewState, subscribeView, type ViewState } from "../bridge";
import { SimulatedGazeProvider } from "../gaze/SimulatedGazeProvider";
import { WebEyeTrackProvider, RealEyeProvider, hasMatchingCalibrationViewport } from "../gaze/WebEyeTrackProvider";
import type { GazeProvider } from "../gaze/GazeProvider";
import { CalibrationFailedError, currentCalibrationViewport, currentLiveSample, sameCalibrationViewport, type CalibrationViewport } from "../gaze/calibration";
import { GazeSmoother, DwellSelector, type DwellCommit, type HitRegion } from "../gaze/fixation";
import { confirmRegions, layoutFor, pickLayoutMode, shelfRegions, spriteRegion, type OverlaySurface, type PlacedRegion } from "../overlay/layout";
import { Sprite, QuadrantGrid } from "./Overlay";
import { NavigationController, type NavigationMode } from "../navigation/NavigationController";

const SEMANTIC_STATES = new Set(["SEMANTIC", "DECODING_ALT", "CLARIFYING", "FALLBACK_TEXT", "SEMANTIC_PAUSED"]);
const CONFIRM_STATES = new Set(["CONSEQUENTIAL_CONFIRMATION", "EXECUTION_INTERRUPTED", "ERROR_RECOVERY"]);
// Begin one focused-card request during the first deliberate gaze burst. The
// three-look selector can then finish while the decoder is already working.
const PREFETCH_PROGRESS_THRESHOLD = 0.18;

let ttsAudio: HTMLAudioElement | null = null;
let cueAudioContext: AudioContext | null = null;
let pendingSpeech: Array<{ dataUrl: string }> = [];
let speechPlaybackGeneration = 0;
let observedSpeechDataUrl: string | null = null;

function stopSpeechPlayback(): void {
  speechPlaybackGeneration += 1;
  pendingSpeech = [];
  observedSpeechDataUrl = null;
  ttsAudio?.pause();
  ttsAudio = null;
}

function playNextSpeech(setView: React.Dispatch<React.SetStateAction<ViewState>>): void {
  if (ttsAudio || pendingSpeech.length === 0) return;
  const next = pendingSpeech.shift();
  if (!next) return;
  const generation = speechPlaybackGeneration;
  let audio: HTMLAudioElement;
  try {
    audio = new Audio(next.dataUrl);
  } catch (error) {
    setView((current) => ({ ...current, notice: `Speech playback failed: ${(error as Error).message}` }));
    playNextSpeech(setView);
    return;
  }
  ttsAudio = audio;
  const settle = (notice?: string) => {
    if (generation !== speechPlaybackGeneration || ttsAudio !== audio) return;
    ttsAudio = null;
    setView((current) => ({
      ...current,
      speech: null,
      sprite: current.interactionState === "EXECUTING" ? "computer_use_running" : "idle",
      ...(notice ? { notice } : {}),
    }));
    playNextSpeech(setView);
  };
  audio.onended = () => settle();
  audio.onerror = () => settle("Speech playback failed. Check the system audio output.");
  void audio.play().catch((error) => settle(`Speech playback failed: ${(error as Error).message}`));
}

async function playAudioCue(cue: AudioCue): Promise<void> {
  try {
    cueAudioContext ??= new AudioContext();
    if (cueAudioContext.state === "suspended") await cueAudioContext.resume();
    const context = cueAudioContext;
    const start = context.currentTime;
    const frequencies = cue === "ready" ? [520, 660] : cue === "error" ? [240, 180] : [620];
    frequencies.forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const toneStart = start + index * 0.07;
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(frequency, toneStart);
      gain.gain.setValueAtTime(0.0001, toneStart);
      gain.gain.exponentialRampToValueAtTime(cue === "error" ? 0.055 : 0.035, toneStart + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, toneStart + 0.09);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(toneStart);
      oscillator.stop(toneStart + 0.1);
    });
    globalThis.dispatchEvent(new CustomEvent("view:audio-cue", { detail: cue }));
  } catch (error) {
    console.error("audio cue failed", error);
  }
}

const surfaceOf = (): OverlaySurface => ({ width: window.innerWidth, height: window.innerHeight });

function hit(region: PlacedRegion, id: string, dwellMs: number): HitRegion {
  const s = surfaceOf();
  if (s.width === 0 || s.height === 0) {
    return { id, xNorm: 0.5, yNorm: 0.5, widthNorm: 0.4, heightNorm: 0.4, dwellMs };
  }
  return {
    id,
    xNorm: Math.min(1, Math.max(0, region.x / s.width)),
    yNorm: Math.min(1, Math.max(0, region.y / s.height)),
    widthNorm: Math.min(1, Math.max(0, region.width / s.width)),
    heightNorm: Math.min(1, Math.max(0, region.height / s.height)),
    dwellMs,
  };
}

function semanticLayout(surface: OverlaySurface, view: ViewState) {
  const isRoot = view.prompt?.options.length === 4 && view.prompt.options.every((option) => option.id.startsWith("root_"));
  const activeBounds = isRoot ? undefined : view.context?.window?.bounds;
  const kind = activeBounds
    ? pickLayoutMode(activeBounds.width * activeBounds.height, surface.width * surface.height)
    : "screen_corners";
  return {
    compact: kind === "window_halo",
    regions: layoutFor(kind === "window_halo" && activeBounds ? { kind, windowBounds: activeBounds } : { kind: "screen_corners" }, surface),
  };
}

export function App(): React.ReactElement {
  const [view, setView] = useState<ViewState>(initialViewState());
  const [gazePoint, setGazePoint] = useState<GazeSample | null>(null);
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [focused, setFocused] = useState<string | null>(null);
  const [hintInput, setHintInput] = useState("");
  const [dasherReady, setDasherReady] = useState(false);
  const [dasherRunning, setDasherRunning] = useState(false);
  const [debugOpen, setDebugOpen] = useState(false);
  const [telemetryOpen, setTelemetryOpen] = useState(false);
  const [navigationMode, setNavigationMode] = useState<NavigationMode>(null);
  const viewRef = useRef(view);
  const latestGaze = useRef<GazeSample | null>(null);
  const hintRef = useRef("");
  const configRef = useRef<AppConfig | null>(null);
  const selectorRef = useRef<DwellSelector | null>(null);
  const smootherRef = useRef<GazeSmoother | null>(null);
  const providerRef = useRef<GazeProvider | null>(null);
  const activationGeneration = useRef(0);
  const calibratedViewport = useRef<CalibrationViewport | null>(null);
  const dasherFrameRef = useRef<HTMLIFrameElement | null>(null);
  const lastAnchorSent = useRef(0);
  const lastStatusSent = useRef(0);
  const navigationRef = useRef<NavigationController | null>(null);
  const focusedPrefetchKeyRef = useRef<string | null>(null);
  const requestedPrefetchKeyRef = useRef<string | null>(null);

  useEffect(() => {
    navigationRef.current = new NavigationController(({ direction, deltaPx }) => {
      void api.navigationScroll(direction, deltaPx);
    });
    return () => { navigationRef.current = null; };
  }, []);

  useLayoutEffect(() => {
    viewRef.current = view;
    hintRef.current = hintInput;
  }, [view, hintInput]);

  useEffect(() => {
    void api.getConfig().then(async (cfg) => {
      configRef.current = cfg;
      const measuredTopInset = cfg.displayGeometry?.topInset ?? 0;
      const notchHeight = measuredTopInset > 0 ? measuredTopInset : (cfg.platform === "darwin" ? 38 : 30);
      document.documentElement.style.setProperty("--notch-height", `${notchHeight}px`);
      document.documentElement.style.setProperty("--notch-center-x", `${cfg.displayGeometry?.notchCenterX ?? window.innerWidth / 2}px`);
      document.documentElement.classList.toggle("reduced-animation", cfg.settings.reducedAnimation);
      if (cfg.displayGeometry?.notchLeftX != null && cfg.displayGeometry.notchRightX != null) {
        document.documentElement.style.setProperty("--notch-left-x", `${cfg.displayGeometry.notchLeftX}px`);
        document.documentElement.style.setProperty("--notch-width", `${cfg.displayGeometry.notchRightX - cfg.displayGeometry.notchLeftX}px`);
      }
      smootherRef.current = new GazeSmoother({ alpha: cfg.settings.gazeEmaAlpha, invalidGapMs: 250 });
      setView((v) => ({ ...v, config: cfg, settings: cfg.settings, appMode: cfg.simulateGaze ? "simulated" : "live", interactionState: cfg.simulateGaze ? "PASSIVE" : "SETUP_REQUIRED" }));
      setDebugOpen(cfg.debugHud);
      if (cfg.simulateGaze) await startGazeListener(cfg);
    });
    const unsub = subscribeView((message) => {
      if (message.type === "audio-cue") void playAudioCue(message.cue);
      if (message.type === "speech-stop") stopSpeechPlayback();
      setView((v) => applyMessage(v, message));
    });
    void api.getTelemetry().then((t) => {
      if (t) setView((v) => ({ ...v, telemetry: t }));
    });

    selectorRef.current = new DwellSelector((commit: DwellCommit) => dispatch(commit.regionId), 180, 0.7);
    const keyHandler = (e: KeyboardEvent) => handleKey(e);
    window.addEventListener("keydown", keyHandler);
    return () => {
      activationGeneration.current += 1;
      unsub();
      window.removeEventListener("keydown", keyHandler);
      stopSpeechPlayback();
      void providerRef.current?.dispose();
    };
  }, []);

  useEffect(() => {
    const receiveDasher = (event: MessageEvent) => {
      if (event.source !== dasherFrameRef.current?.contentWindow || !event.data || typeof event.data !== "object") return;
      if (event.data.type === "dasher-ready") setDasherReady(true);
      if (event.data.type === "dasher-output" && typeof event.data.text === "string") {
        setHintInput(event.data.text);
      }
      if (event.data.type === "dasher-error") {
        setView((v) => ({ ...v, notice: `Dasher failed: ${String(event.data.text ?? "unknown error")}` }));
      }
    };
    window.addEventListener("message", receiveDasher);
    return () => window.removeEventListener("message", receiveDasher);
  }, []);

  useEffect(() => {
    let frameId = 0;
    const tick = () => {
      const viewport = currentCalibrationViewport();
      if (calibratedViewport.current && !sameCalibrationViewport(calibratedViewport.current, viewport)) {
        console.info(`[calibration] ${JSON.stringify({ at: new Date().toISOString(), event: "viewport_invalidated", calibrated: calibratedViewport.current, current: viewport })}`);
        calibratedViewport.current = null;
        latestGaze.current = null;
        void providerRef.current?.dispose();
        void api.calibrationFailed("Display resolution or scale changed. Calibrate your eyes again before using gaze.");
      }
      const raw = configRef.current?.simulateGaze ? latestGaze.current
        : currentLiveSample(latestGaze.current, calibratedViewport.current, viewport, performance.now());
      const smoother = smootherRef.current;
      const selector = selectorRef.current;
      const cfg = configRef.current;
      if (smoother && selector && cfg) {
        const sample = smoother.update(raw ?? { xNorm: 0, yNorm: 0, timestampMs: Date.now(), valid: false });
        const surface = surfaceOf();
        const regions = buildRegions(surface, viewRef.current, hintRef.current);
        const now = performance.now();
        selector.update(regions, sample.valid ? sample : null, now);
        const spriteHit = regions.find((region) => region.id === "sprite");
        const lookingAtSprite = Boolean(spriteHit
          && sample.xNorm >= spriteHit.xNorm
          && sample.xNorm <= spriteHit.xNorm + spriteHit.widthNorm
          && sample.yNorm >= spriteHit.yNorm
          && sample.yNorm <= spriteHit.yNorm + spriteHit.heightNorm);
        navigationRef.current?.update({ xNorm: sample.xNorm, yNorm: sample.yNorm, valid: sample.valid && !lookingAtSprite, nowMs: now });
        const pr = selector.progress(regions, sample.valid ? sample : null, now);
        const nextProgress: Record<string, number> = {};
        if (pr) nextProgress[pr.regionId] = pr.progress01;
        const nextFocused = pr?.regionId ?? null;
        const currentPrompt = viewRef.current.prompt;
        const promptKey = currentPrompt
          ? `${currentPrompt.sessionId}|${currentPrompt.displayPrompt}|${currentPrompt.options.map((option) => option.id).join(",")}`
          : null;
        const focusedKey = promptKey && nextFocused ? `${promptKey}|${nextFocused}` : null;
        if (focusedKey !== focusedPrefetchKeyRef.current) {
          focusedPrefetchKeyRef.current = focusedKey;
          requestedPrefetchKeyRef.current = null;
        }
        const canPrefetch = viewRef.current.interactionState === "SEMANTIC"
          && viewRef.current.prompt?.mode !== "hint"
          && isQuadrantId(nextFocused)
          && pr !== null
          && pr.progress01 >= PREFETCH_PROGRESS_THRESHOLD
          && focusedKey !== null;
        if (canPrefetch && requestedPrefetchKeyRef.current !== focusedKey) {
          requestedPrefetchKeyRef.current = focusedKey;
          void api.prefetchOption(nextFocused);
        }
        setProgress(nextProgress);
        setFocused(nextFocused);
        setGazePoint(sample.valid ? sample : null);
        if (sample.valid && viewRef.current.prompt?.mode === "hint") {
          const frame = dasherFrameRef.current;
          const rect = frame?.getBoundingClientRect();
          if (frame?.contentWindow && rect && rect.width > 0 && rect.height > 0) {
            frame.contentWindow.postMessage({
              type: "gaze",
              x: Math.min(1, Math.max(0, (sample.xNorm * surface.width - rect.left) / rect.width)),
              y: Math.min(1, Math.max(0, (sample.yNorm * surface.height - rect.top) / rect.height)),
            }, "*");
          }
        }

        if (sample.valid && now - lastAnchorSent.current > 250) {
          lastAnchorSent.current = now;
          const windowBounds = viewRef.current.context?.window?.bounds;
          const screenX = sample.xNorm * surface.width;
          const screenY = sample.yNorm * surface.height;
          const insideWindow = Boolean(windowBounds
            && screenX >= windowBounds.x
            && screenX <= windowBounds.x + windowBounds.width
            && screenY >= windowBounds.y
            && screenY <= windowBounds.y + windowBounds.height);
          const windowXNorm = insideWindow && windowBounds
            ? Math.min(1, Math.max(0, (screenX - windowBounds.x) / windowBounds.width))
            : null;
          const windowYNorm = insideWindow && windowBounds
            ? Math.min(1, Math.max(0, (screenY - windowBounds.y) / windowBounds.height))
            : null;
          void api.setAnchor(sample.xNorm, sample.yNorm, windowXNorm, windowYNorm, insideWindow);
        }
        if (now - lastStatusSent.current > 500) {
          lastStatusSent.current = now;
          void api.gazeStatus(sample.valid);
        }
      }
      frameId = requestAnimationFrame(tick);
    };
    frameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameId);
  }, []);

  useEffect(() => {
    const dataUrl = view.speech?.dataUrl;
    if (!dataUrl) {
      observedSpeechDataUrl = null;
      return;
    }
    if (dataUrl !== observedSpeechDataUrl) {
      observedSpeechDataUrl = dataUrl;
      pendingSpeech.push({ dataUrl });
    }
    playNextSpeech(setView);
  }, [view.speech?.dataUrl]);

  async function startGazeListener(cfg: AppConfig, forceCalibration = cfg.forceCalibration): Promise<void> {
    console.info(`[calibration] ${JSON.stringify({ at: new Date().toISOString(), event: "activation_requested", provider: cfg.gazeProvider, simulated: cfg.simulateGaze })}`);
    const generation = ++activationGeneration.current;
    if (cfg.simulateGaze) {
      await activateGazeProvider(new SimulatedGazeProvider(), false, generation);
      return;
    }
    if (cfg.gazeProvider === "simulated") {
      await api.calibrationFailed("Select a camera gaze provider. Simulated eye data is disabled in live mode.");
      return;
    }

    const primary = cfg.gazeProvider === "realeye" ? new RealEyeProvider() : new WebEyeTrackProvider(forceCalibration, cfg.allowUnverifiedGaze);
    try {
      await activateGazeProvider(primary, true, generation);
      return;
    } catch (primaryError) {
      console.error(`[calibration] ${JSON.stringify({ at: new Date().toISOString(), event: "activation_failed", provider: primary.name, message: (primaryError as Error).message, stack: (primaryError as Error).stack })}`);
      await primary.dispose();
      if (generation !== activationGeneration.current) return;
      await api.calibrationFailed(`Gaze is disabled. ${(primaryError as Error).message}`);
    }
  }

  async function activateGazeProvider(provider: GazeProvider, live: boolean, generation: number): Promise<void> {
    const ensureCurrent = () => {
      if (generation !== activationGeneration.current) throw new DOMException("Calibration cancelled.", "AbortError");
    };
    providerRef.current = provider;
    await provider.initialize();
    ensureCurrent();
    const viewport = currentCalibrationViewport();
    if (live) {
      const calibration = provider.isCalibrationRestored?.()
        ? { ok: true, message: "Saved eye calibration restored." }
        : await provider.calibrate();
      ensureCurrent();
      if (!calibration.ok) throw new CalibrationFailedError(calibration.message);
      if (!sameCalibrationViewport(viewport, currentCalibrationViewport())) throw new CalibrationFailedError("Display resolution changed during calibration. Please retry.");
    }
    latestGaze.current = null;
    await provider.start((sample) => { if (generation === activationGeneration.current) latestGaze.current = sample; });
    ensureCurrent();
    if (live) {
      calibratedViewport.current = viewport;
      const accepted = await api.startCalibration();
      if (!accepted.ok) throw new CalibrationFailedError(accepted.message);
      console.info(`[calibration] ${JSON.stringify({ at: new Date().toISOString(), event: "activation_committed", provider: provider.name, viewport })}`);
      // Successful activation is represented by the passive owl. Keep the
      // overlay quiet; calibration failures still surface an explicit notice.
      setView((v) => ({ ...v, notice: null }));
    }
  }

  async function startLiveCalibration(forceCalibration = false): Promise<void> {
    const cfg = configRef.current;
    if (!cfg || cfg.simulateGaze) return;
    activationGeneration.current += 1;
    await providerRef.current?.dispose();
    latestGaze.current = null;
    calibratedViewport.current = null;
    selectorRef.current?.reset();
    smootherRef.current?.reset();
    setView((v) => ({ ...v, notice: null, interactionState: "CALIBRATING" }));
    await api.prepareCalibration();
    await startGazeListener(cfg, forceCalibration || cfg.forceCalibration);
  }

  function handleKey(e: KeyboardEvent): void {
    const key = e.key.toLowerCase();
    const st = viewRef.current.interactionState;

    if (hintRef.current.length > 0 || viewRef.current.prompt?.mode === "hint") {
      if (/^[a-z0-9 ]$/.test(key)) {
        if (e.metaKey || e.ctrlKey) return;
        setHintInput((h) => h + key);
        e.preventDefault();
        return;
      }
      if (key === "backspace") {
        setHintInput((h) => h.slice(0, -1));
        e.preventDefault();
        return;
      }
      if (key === "enter") {
        void api.commitHintLiteral(hintRef.current);
        e.preventDefault();
        return;
      }
    }

    switch (key) {
      case "1":
      case "2":
      case "3":
      case "4":
        if (SEMANTIC_STATES.has(st) || CONFIRM_STATES.has(st)) {
          if (st !== "DECODING_ALT") void api.selectOption(("ABCD")[parseInt(key, 10) - 1] as "A" | "B" | "C" | "D");
        }
        break;
      case "b":
        void api.back();
        break;
      case "m":
        void api.more();
        break;
      case "h":
        void api.beginHint();
        break;
      case "x":
        navigationRef.current?.setMode(null);
        setNavigationMode(null);
        void api.exitSession();
        break;
      case "n":
        if (st === "PASSIVE") {
          navigationRef.current?.setMode(null);
          setNavigationMode(null);
          void api.summon();
        }
        else if (st === "EXECUTING" || st === "CONSEQUENTIAL_CONFIRMATION") void api.interruptExecutor();
        break;
      case "r":
        if (st === "PASSIVE") { navigationRef.current?.toggle("reading"); setNavigationMode(navigationRef.current?.activeMode ?? null); }
        break;
      case "f":
        if (st === "PASSIVE") { navigationRef.current?.toggle("vertical_feed"); setNavigationMode(navigationRef.current?.activeMode ?? null); }
        break;
      case "d":
        if (e.metaKey || e.ctrlKey) setDebugOpen((o) => !o);
        break;
    }
  }

  function dispatch(regionId: string): void {
    const st = viewRef.current.interactionState;
    if (st === "DECODING_ALT") return;
    if (regionId === "sprite") {
      if (st === "PASSIVE") {
        navigationRef.current?.setMode(null);
        setNavigationMode(null);
        void api.summon();
      }
      else if (st === "EXECUTING") void api.interruptExecutor();
      return;
    }
    if (regionId === "shelf_0") return void api.back();
    if (regionId === "shelf_1") return void api.more();
    if (regionId === "shelf_2") return void api.beginHint();
    if (regionId === "shelf_3") return void api.exitSession();
    if (regionId === "hint_clear") {
      setHintInput("");
      dasherFrameRef.current?.contentWindow?.postMessage({ type: "clear" }, "*");
      void api.clearHint();
      return;
    }
    if (regionId === "dasher_toggle") {
      const next = !dasherRunning;
      setDasherRunning(next);
      dasherFrameRef.current?.contentWindow?.postMessage({ type: next ? "start" : "pause" }, "*");
      return;
    }
    if (regionId === "hint_use") {
      if (hintRef.current.trim()) void api.updateHint(hintRef.current);
      return;
    }
    if (regionId === "hint_commit") {
      void api.commitHintLiteral(hintRef.current);
      return;
    }
    if (regionId === "hint_cancel") {
      setHintInput("");
      void api.exitSession();
      return;
    }
    if (regionId.startsWith("hint_cand_")) {
      void api.acceptHintCandidate(regionId.slice("hint_cand_".length));
      return;
    }
    if (SEMANTIC_STATES.has(st) && (regionId === "A" || regionId === "B" || regionId === "C" || regionId === "D")) {
      void api.selectOption(regionId);
      return;
    }
    if (CONFIRM_STATES.has(st) && (regionId === "A" || regionId === "B" || regionId === "C" || regionId === "D")) {
      switch (st) {
        case "CONSEQUENTIAL_CONFIRMATION": {
          const map = { A: "approve", B: "change", C: "read", D: "cancel" };
          void api.consequentialChoice(map[regionId]);
          break;
        }
        case "EXECUTION_INTERRUPTED": {
          const map = { A: "change_something", B: "go_back", C: "continue", D: "stop" };
          void api.steer(map[regionId]);
          break;
        }
        case "ERROR_RECOVERY": {
          const map = { A: "retry", B: "go_back", C: "choose_else", D: "stop" };
          void api.recovery(map[regionId]);
          break;
        }
      }
    }
  }

  function buildRegions(surface: OverlaySurface, v: ViewState, hintText: string): HitRegion[] {
    const regions: HitRegion[] = [];
    const dwell = v.settings?.gazeDwellMs ?? 550;
    const summon = v.settings?.agentSummonDwellMs ?? 900;
    const noneDwell = v.settings?.noneDwellMs ?? 700;
    const cancelDwell = v.settings?.cancelDwellMs ?? 900;
    const hintDwell = v.settings?.hintDwellMs ?? 650;
    const measuredTopInset = configRef.current?.displayGeometry?.topInset ?? 0;
    const notchHeight = measuredTopInset > 0 ? measuredTopInset : (configRef.current?.platform === "darwin" ? 38 : 30);
    const notchCenterX = configRef.current?.displayGeometry?.notchCenterX ?? surface.width / 2;
    const notchLeftX = configRef.current?.displayGeometry?.notchLeftX;
    const notchRightX = configRef.current?.displayGeometry?.notchRightX;
    const notchWidth = notchLeftX != null && notchRightX != null ? notchRightX - notchLeftX : undefined;

    if (v.interactionState === "PASSIVE" || v.interactionState === "EXECUTING") {
      regions.push(hit(spriteRegion(surface, notchHeight, notchCenterX, notchWidth), "sprite", v.interactionState === "EXECUTING" ? 650 : summon));
    }

    if (SEMANTIC_STATES.has(v.interactionState) && v.prompt) {
      if (v.interactionState === "DECODING_ALT") return regions;
      if (v.prompt.mode === "hint") {
        document.querySelectorAll<HTMLButtonElement>("[data-gaze-control]").forEach((element) => {
          if (element.disabled) return;
          const rect = element.getBoundingClientRect();
          const id = element.dataset.gazeControl!;
          regions.push(hit({ id, x: rect.x, y: rect.y, width: rect.width, height: rect.height }, id, id === "hint_commit" ? cancelDwell : dwell));
        });
        return regions;
      }
      const quadRegions = semanticLayout(surface, v).regions;
      for (const r of quadRegions) regions.push(hit(r, r.id, dwell));

      const shelf = shelfRegions(surface, 4).slice(0, 4);
      const zones: Array<{ region: PlacedRegion; enabled: boolean; ms: number; slot: number }> = [
        { region: shelf[0], enabled: v.prompt.canBack, ms: dwell, slot: 0 },
        { region: shelf[1], enabled: v.prompt.canMore, ms: noneDwell, slot: 1 },
        { region: shelf[2], enabled: v.prompt.canHint, ms: hintDwell, slot: 2 },
        { region: shelf[3], enabled: v.prompt.canExit, ms: cancelDwell, slot: 3 },
      ];
      for (const z of zones) {
        if (z.enabled) regions.push(hit(z.region, `shelf_${z.slot}`, z.ms));
      }

    }

    if (CONFIRM_STATES.has(v.interactionState)) {
      for (const r of confirmRegions(surface)) regions.push(hit(r, r.id, dwell));
    }

    return regions;
  }

  const st = view.interactionState;
  const semanticBusy = st === "DECODING_ALT";
  const showSemantic = SEMANTIC_STATES.has(st) && view.prompt != null;
  const showHintPanel = view.prompt?.mode === "hint" || st === "FALLBACK_TEXT";
  const layout = semanticLayout(surfaceOf(), view);
  const hasMeasuredNotch = view.config?.displayGeometry?.notchLeftX != null
    && view.config.displayGeometry.notchRightX != null;
  const spriteState = focused === "sprite" ? "dwelling" : view.sprite;

  return (
    <div className="stage">
      <video id="gaze-camera" className="gaze-camera" autoPlay muted playsInline />
      {hasMeasuredNotch ? <div className="perceived-notch" aria-hidden="true" /> : null}
      {debugOpen ? <div className="topbar">
        <button className="topbtn" onClick={() => setDebugOpen(!debugOpen)} title="Debug HUD">HUD</button>
        <div className="title">Gaze → Agent</div>
        <button className="topbtn" onClick={() => setTelemetryOpen(!telemetryOpen)} title="Task results">📊</button>
      </div> : null}
      <Sprite state={spriteState} progress={progress.sprite ?? null} hasNotch={hasMeasuredNotch} />
      {navigationMode ? <div className="navigation-status">{navigationMode === "reading" ? "READING MODE" : "FEED MODE"} · R/F to switch · X to exit</div> : null}

      {showSemantic ? (
        <>
          {!showHintPanel ? <div className="prompt-buffer">
            <span className="prompt-prefix">🦉</span>
            <span className="prompt-text">{view.prompt!.displayPrompt}</span>
            {view.prompt!.mode === "clarify" && view.prompt!.clarificationQuestion ? <div className="clarify-question">“{view.prompt!.clarificationQuestion}”</div> : null}
          </div> : null}
          {!showHintPanel ? <QuadrantGrid options={view.prompt!.options} focused={focused} progress={progress} regions={layout.regions} compact={layout.compact} locked={semanticBusy} /> : null}
          {semanticBusy ? <div className="decoder-status" role="status" aria-live="polite"><span className="decoder-status-dot" />UPDATING CHOICES…</div> : null}
          {view.prompt!.mode !== "hint" ? (
            <div className={`shelf${semanticBusy ? " decoding" : ""}`}>
              <div className={`shelf-zone${focused === "shelf_0" ? " active" : ""}`} aria-disabled={!view.prompt!.canBack}><span>← BACK</span></div>
              <div className={`shelf-zone${focused === "shelf_1" ? " active" : ""}`} aria-disabled={!view.prompt!.canMore}><span>MORE / NONE</span></div>
              <div className={`shelf-zone${focused === "shelf_2" ? " active" : ""}`} aria-disabled={!view.prompt!.canHint}><span>SPELL / HINT</span></div>
              <div className={`shelf-zone${focused === "shelf_3" ? " active" : ""}`} aria-disabled={!view.prompt!.canExit}><span>× EXIT</span></div>
            </div>
          ) : null}
          {showHintPanel ? (
            <DasherPanel
              frameRef={dasherFrameRef}
              input={hintInput}
              ready={dasherReady}
              running={dasherRunning}
              focused={focused}
              onToggle={() => dispatch("dasher_toggle")}
              onClear={() => dispatch("hint_clear")}
              onHint={() => dispatch("hint_use")}
              onCommit={() => dispatch("hint_commit")}
            />
          ) : null}
        </>
      ) : null}

      {st === "CONSEQUENTIAL_CONFIRMATION" && view.consequential ? <ConsequentialCard summary={view.consequential.pendingActionSummary} /> : null}
      {st === "EXECUTION_INTERRUPTED" && view.steering ? <SteeringCard status={view.steering.recentStatus} options={view.steering.options} /> : null}
      {st === "ERROR_RECOVERY" && view.recovery ? <RecoveryCard summary={view.recovery.errorSummary} options={view.recovery.choices} /> : null}
      {st === "EXECUTING" && view.executing ? (
        <div className="executing-card">
          <div className="executing-spinner" />
          <div className="executing-text">{view.executing.statusText}</div>
          <div className="hint-line">Look at the sprite and hold to interrupt</div>
        </div>
      ) : null}
      {st === "COMPLETE" ? <div className="complete-card">✓ Task completed</div> : null}

      {st === "SETUP_REQUIRED" || st === "CALIBRATING" || st === "CALIBRATION_ERROR" ? <SetupWizard ready={Boolean(view.config)} calibrating={st === "CALIBRATING"} allowUnverified={view.config?.allowUnverifiedGaze === true} canRestore={view.config?.gazeProvider === "webeyetrack" && !view.config.forceCalibration && hasMatchingCalibrationViewport(view.config.allowUnverifiedGaze)} onCalibrate={() => void startLiveCalibration()} onRecalibrate={() => void startLiveCalibration(true)} onQuit={() => void api.quitApp()} /> : null}

      {view.notice ? <div className="notice" onClick={() => setView((v) => ({ ...v, notice: null }))}>{view.notice}</div> : null}
      {debugOpen ? <DebugHUD view={view} gaze={gazePoint} progress={progress} /> : null}
      {telemetryOpen && view.telemetry ? <TelemetryCard telemetry={view.telemetry} onClose={() => setTelemetryOpen(false)} /> : null}
    </div>
  );
}

function isQuadrantId(value: string | null): value is "A" | "B" | "C" | "D" {
  return value === "A" || value === "B" || value === "C" || value === "D";
}

function DasherPanel({ frameRef, input, ready, running, focused, onToggle, onClear, onHint, onCommit }: {
  frameRef: React.RefObject<HTMLIFrameElement | null>;
  input: string;
  ready: boolean;
  running: boolean;
  focused: string | null;
  onToggle: () => void;
  onClear: () => void;
  onHint: () => void;
  onCommit: () => void;
}): React.ReactElement {
  return (
    <div className="dasher-panel" onClick={(e) => e.stopPropagation()}>
      <div className="dasher-title">DASHER GAZE TEXT ENTRY <span>{ready ? "READY" : "LOADING…"}</span></div>
      <iframe ref={frameRef} className="dasher-frame" src="./dasher/index.html" title="Dasher gaze text entry" />
      <div className="dasher-output">{input || "Gaze-generated text appears here…"}</div>
      <div className="dasher-actions">
        <button data-gaze-control="dasher_toggle" className={focused === "dasher_toggle" ? "active" : ""} disabled={!ready} onClick={onToggle}>{running ? "PAUSE" : "START"}</button>
        <button data-gaze-control="hint_clear" className={focused === "hint_clear" ? "active" : ""} onClick={onClear}>CLEAR</button>
        <button data-gaze-control="hint_use" className={focused === "hint_use" ? "active" : ""} disabled={!input.trim()} onClick={onHint}>USE AS HINT</button>
        <button data-gaze-control="hint_commit" className={focused === "hint_commit" ? "active primary" : "primary"} disabled={!input.trim()} onClick={onCommit}>USE FULL REQUEST</button>
      </div>
    </div>
  );
}

function ConsequentialCard({ summary }: { summary: string }): React.ReactElement {
  return (
    <>
    <div className="center-card consequential">
      <div className="center-title">Consequential action — final confirmation</div>
      <div className="center-intent">{summary}</div>
    </div>
    <DecisionChoices labels={["APPROVE", "CHANGE", "READ / EXPLAIN", "CANCEL"]} />
    </>
  );
}

function SteeringCard({ status, options }: { status: string; options: Array<{ label: string }> }): React.ReactElement {
  return (
    <>
    <div className="center-card steering">
      <div className="center-title">Steer the task</div>
      <div className="center-intent">{status}</div>
    </div>
    <DecisionChoices labels={options.map((o) => o.label)} />
    </>
  );
}

function RecoveryCard({ summary, options }: { summary: string; options: Array<{ label: string }> }): React.ReactElement {
  return (
    <>
    <div className="center-card recovery">
      <div className="center-title">Recovery</div>
      <div className="center-intent">{summary}</div>
    </div>
    <DecisionChoices labels={options.map((o) => o.label)} />
    </>
  );
}

function DecisionChoices({ labels }: { labels: string[] }): React.ReactElement {
  return <>{confirmRegions(surfaceOf()).map((region, index) => (
    <div className="quadrant-target" key={region.id} data-gaze-region={region.id} style={{ left: region.x, top: region.y, width: region.width, height: region.height }}>
      <div className="choice"><b>{region.id}</b><span>{labels[index] ?? "…"}</span></div>
    </div>
  ))}</>;
}

function SetupWizard({ onCalibrate, onRecalibrate, onQuit, calibrating, canRestore, ready, allowUnverified }: { onCalibrate: () => void; onRecalibrate: () => void; onQuit: () => void; calibrating: boolean; canRestore: boolean; ready: boolean; allowUnverified: boolean }): React.ReactElement {
  return (
    <div className="wizard">
      <h2>{calibrating ? "Preparing your camera…" : canRestore ? "Your eye calibration is saved" : "Calibrate your eyes"}</h2>
      <p>{canRestore ? "Start with your saved calibration. Choose Recalibrate if your camera or seating position has changed." : allowUnverified ? "Demo mode: look at five dots to fit the real camera stream. Accuracy checks will be skipped." : "Look at each of five dots, then click while keeping your gaze on it. Four separate accuracy checks follow."}</p>
      <p>{window.innerWidth} × {window.innerHeight} logical pixels · {window.devicePixelRatio}× display scale</p>
      <p>{allowUnverified ? "Accuracy is not guaranteed in this explicit demo mode." : "Gaze controls stay disabled until calibration passes."} Keep your usual seating position. Press Esc to cancel the dots.</p>
      <div className="wizard-actions">
        <button className="wizard-btn primary" disabled={calibrating || !ready} onClick={onCalibrate}>{!ready ? "Loading settings…" : calibrating ? "Starting camera…" : canRestore ? "Start eye control" : "Start eye calibration"}</button>
        {canRestore ? <button className="wizard-btn" disabled={calibrating} onClick={onRecalibrate}>Recalibrate</button> : null}
        <button className="wizard-btn quiet" onClick={onQuit}>Quit View</button>
      </div>
    </div>
  );
}

function DebugHUD({ view, gaze, progress }: { view: ViewState; gaze: GazeSample | null; progress: Record<string, number> }): React.ReactElement {
  return (
    <div className="debug-hud">
      <div className="debug-title">Debug HUD</div>
      <div>state: {view.interactionState}</div>
      <div>mode: {view.appMode}</div>
      <div>sprite: {view.sprite}</div>
      <div>gaze: {gaze ? `${(gaze.xNorm * 100).toFixed(0)}%,${(gaze.yNorm * 100).toFixed(0)}%` : "—"}</div>
      <div>focused: {Object.keys(progress).join(",") || "—"}</div>
      <div>decoder: {view.config?.settings.decoderModel}</div>
    </div>
  );
}

function TelemetryCard({ telemetry, onClose }: { telemetry: TelemetrySummary; onClose: () => void }): React.ReactElement {
  return (
    <div className="telemetry-card">
      <div className="center-title">Task results</div>
      <div>{telemetry.lastTaskSummary ?? "No task completed yet"}</div>
      <div>Semantic gaze selections: {telemetry.semanticSelections}</div>
      <div>Clarification questions: {telemetry.clarificationAnswers}</div>
      <div>Prefetch hit/miss: {telemetry.prefetchHits}/{telemetry.prefetchMisses}</div>
      <div>Time to intent: {telemetry.timeToIntentMs ? `${(telemetry.timeToIntentMs / 1000).toFixed(1)} s` : "—"}</div>
      <div>Task time: {telemetry.totalTaskTimeMs ? `${(telemetry.totalTaskTimeMs / 1000).toFixed(1)} s` : "—"}</div>
      <div>Computer actions delegated: {telemetry.executorActions}</div>
      <button className="wizard-btn" onClick={onClose}>CLOSE</button>
    </div>
  );
}
