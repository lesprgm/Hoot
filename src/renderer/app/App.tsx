import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AppConfig, GazeSample, SpriteState } from "../../shared/types";
import { asSelectionEnvelope } from "../../shared/decisions";
import { api, applyMessage, initialViewState, subscribeView, type ViewState } from "../bridge";
import { SimulatedGazeProvider } from "../gaze/SimulatedGazeProvider";
import { WebEyeTrackProvider, hasMatchingCalibrationViewport } from "../gaze/WebEyeTrackProvider";
import type { GazeProvider } from "../gaze/GazeProvider";
import { CalibrationFailedError, currentCalibrationViewport, currentLiveSample, sameCalibrationViewport, type CalibrationViewport } from "../gaze/calibration";
import { GazeSmoother, DwellSelector, type DwellCommit, type HitRegion } from "../gaze/fixation";
import { confirmRegions, layoutFor, pickLayoutMode, shelfRegions, spriteRegion, type OverlaySurface, type PlacedRegion } from "../overlay/layout";
import { Sprite, QuadrantGrid } from "./Overlay";
import { ConsequentialCard, ContextBadge, DebugHUD, RecoveryCard, SetupWizard, SteeringCard } from "./StatusPanels";
import { speechPlayback } from "../audio/SpeechPlayback";
import { NavigationController, type NavigationMode } from "../navigation/NavigationController";

const SEMANTIC_STATES = new Set(["SEMANTIC", "DECODING_ALT", "CLARIFYING", "SEMANTIC_PAUSED"]);
const CONFIRM_STATES = new Set(["CONSEQUENTIAL_CONFIRMATION", "EXECUTION_INTERRUPTED", "ERROR_RECOVERY"]);
// Begin one focused-card request during the first deliberate gaze burst. The
// three-look selector can then finish while the decoder is already working.
const PREFETCH_PROGRESS_THRESHOLD = 0.18;

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
  const [debugOpen, setDebugOpen] = useState(false);
  const [navigationMode, setNavigationMode] = useState<NavigationMode>(null);
  const viewRef = useRef(view);
  const latestGaze = useRef<GazeSample | null>(null);
  const configRef = useRef<AppConfig | null>(null);
  const selectorRef = useRef<DwellSelector | null>(null);
  const smootherRef = useRef<GazeSmoother | null>(null);
  const providerRef = useRef<GazeProvider | null>(null);
  const activationGeneration = useRef(0);
  const calibratedViewport = useRef<CalibrationViewport | null>(null);
  const lastAnchorSent = useRef(0);
  const lastStatusSent = useRef(0);
  const navigationRef = useRef<NavigationController | null>(null);
  const focusedPrefetchKeyRef = useRef<string | null>(null);
  const requestedPrefetchKeyRef = useRef<string | null>(null);
  const nativeNotchVisualKeyRef = useRef<string | null>(null);
  const contextControlRectsRef = useRef<Map<string, PlacedRegion>>(new Map());
  const regionsCacheRef = useRef<{ key: string; regions: HitRegion[] } | null>(null);
  const progressRef = useRef<Record<string, number>>({});
  const focusedRef = useRef<string | null>(null);
  const lastFeedbackPaintRef = useRef(0);
  const lastGazePaintRef = useRef(0);

  useEffect(() => {
    navigationRef.current = new NavigationController(({ direction, deltaPx }) => {
      void api.navigationScroll(direction, deltaPx);
    });
    return () => { navigationRef.current = null; };
  }, []);

  useLayoutEffect(() => {
    viewRef.current = view;
    measureGazeControls();
    regionsCacheRef.current = null;
  }, [view]);

  useEffect(() => {
    const onResize = () => {
      measureGazeControls();
      regionsCacheRef.current = null;
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

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
      if (message.type === "audio-cue") void speechPlayback.playCue(message.cue);
      if (message.type === "speech-stop") speechPlayback.stop();
      setView((v) => applyMessage(v, message));
    });
    selectorRef.current = new DwellSelector((commit: DwellCommit) => dispatch(commit.regionId), 180, 0.7);
    const keyHandler = (e: KeyboardEvent) => handleKey(e);
    window.addEventListener("keydown", keyHandler);
    return () => {
      activationGeneration.current += 1;
      unsub();
      window.removeEventListener("keydown", keyHandler);
      speechPlayback.stop();
      void providerRef.current?.dispose();
    };
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
        const regions = buildRegions(surface, viewRef.current);
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
        if (cfg.nativeNotchHostAvailable) {
          const nativeFocused = nextFocused === "sprite";
          const nativeProgress = nativeFocused && pr?.regionId === "sprite"
            ? Math.round(pr.progress01 * 20) / 20
            : null;
          const nativeSprite: SpriteState = nativeFocused ? "dwelling" : viewRef.current.sprite;
          const nativeKey = `${nativeSprite}|${nativeFocused}|${nativeProgress ?? "none"}`;
          if (nativeKey !== nativeNotchVisualKeyRef.current) {
            nativeNotchVisualKeyRef.current = nativeKey;
            void api.notchVisual(nativeSprite, nativeProgress, nativeFocused);
          }
        }
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
          && isQuadrantId(nextFocused)
          && pr !== null
          && pr.progress01 >= PREFETCH_PROGRESS_THRESHOLD
          && focusedKey !== null;
        if (canPrefetch && requestedPrefetchKeyRef.current !== focusedKey) {
          requestedPrefetchKeyRef.current = focusedKey;
          void api.prefetchOption(nextFocused);
        }
        const previousProgress = progressRef.current;
        const progressChanged = Object.keys(nextProgress).some((key) => Math.abs((nextProgress[key] ?? 0) - (previousProgress[key] ?? 0)) >= 0.03)
          || Object.keys(previousProgress).some((key) => !(key in nextProgress));
        if (progressChanged || nextFocused !== focusedRef.current || now - lastFeedbackPaintRef.current >= 50) {
          progressRef.current = nextProgress;
          focusedRef.current = nextFocused;
          lastFeedbackPaintRef.current = now;
          setProgress(nextProgress);
          setFocused(nextFocused);
        }
        if (now - lastGazePaintRef.current >= 100) {
          lastGazePaintRef.current = now;
          setGazePoint(sample.valid ? sample : null);
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
    speechPlayback.observe(view.speech?.dataUrl, setView);
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

    const primary = new WebEyeTrackProvider(forceCalibration, cfg.allowUnverifiedGaze);
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
      const restored = provider.isCalibrationRestored?.() === true;
      const verified = provider.isCalibrationVerified?.() === true;
      const exposesVerification = typeof provider.isCalibrationVerified === "function";
      const notice = restored
        ? "Saved eye calibration restored. Gaze is active."
        : exposesVerification
          ? verified
            ? "Eye calibration saved. All four accuracy checks passed."
            : "Unverified demo gaze is active. The five-point mapping is saved, but accuracy checks were skipped."
          : accepted.message;
      // Successful activation is represented by the passive owl. Keep a
      // concise, actionable result notice instead of leaving the user guessing
      // whether the camera is actually live.
      setView((v) => ({ ...v, notice }));
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

    switch (key) {
      case "1":
      case "2":
      case "3":
      case "4":
        handleQuadrantKey(("ABCD")[parseInt(key, 10) - 1] as "A" | "B" | "C" | "D");
        break;
      case "b":
        void api.back();
        break;
      case "m":
        void api.more();
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
      case "p":
        if (viewRef.current.context?.access === "active" || viewRef.current.context?.access === "paused") void api.toggleContext();
        break;
      case "a":
        if (viewRef.current.context?.access === "blocked" || viewRef.current.context?.contextScope === "app") void api.approveContextSession();
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
    if (regionId === "shelf_2") return void api.exitSession();
    if (regionId === "context_toggle") {
      void api.toggleContext();
      return;
    }
    if (regionId === "context_approve_session") {
      void api.approveContextSession();
      return;
    }
    if (SEMANTIC_STATES.has(st) && (regionId === "A" || regionId === "B" || regionId === "C" || regionId === "D")) {
      if (st !== "DECODING_ALT") commitQuadrant(regionId);
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

  function commitQuadrant(quadrant: "A" | "B" | "C" | "D"): void {
    const prompt = viewRef.current.prompt;
    const option = prompt?.options.find((candidate) => candidate.quadrant === quadrant);
    if (!prompt || !option) return;
    const interactionId = globalThis.crypto?.randomUUID?.() ?? `interaction_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const envelope = asSelectionEnvelope(prompt, option.cardId ?? option.id, interactionId);
    if (!envelope) return;
    void api.selectOption(envelope);
  }

  function handleQuadrantKey(quadrant: "A" | "B" | "C" | "D"): void {
    const st = viewRef.current.interactionState;
    if (SEMANTIC_STATES.has(st) && st !== "DECODING_ALT") {
      commitQuadrant(quadrant);
      return;
    }
    if (st === "CONSEQUENTIAL_CONFIRMATION") {
      void api.consequentialChoice(({ A: "approve", B: "change", C: "read", D: "cancel" })[quadrant]);
      return;
    }
    if (st === "EXECUTION_INTERRUPTED") {
      void api.steer(({ A: "change_something", B: "go_back", C: "continue", D: "stop" })[quadrant]);
      return;
    }
    if (st === "ERROR_RECOVERY") {
      void api.recovery(({ A: "retry", B: "go_back", C: "choose_else", D: "stop" })[quadrant]);
    }
  }

  function measureGazeControls(): void {
    const context = new Map<string, PlacedRegion>();
    document.querySelectorAll<HTMLElement>("[data-context-control]").forEach((element) => {
      const id = element.dataset.contextControl;
      const rect = element.getBoundingClientRect();
      if (!id || rect.width <= 0 || rect.height <= 0) return;
      const placed = { id, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      context.set(id, placed);
    });
    contextControlRectsRef.current = context;
  }

  function buildRegions(surface: OverlaySurface, v: ViewState): HitRegion[] {
    const cacheKey = `${surface.width}x${surface.height}|${v.interactionState}|${v.prompt?.cardSetId ?? "none"}|${v.prompt?.revision ?? 0}|${v.prompt?.mode ?? "none"}|${v.context?.access ?? "disabled"}|${v.context?.window?.windowId ?? 0}`;
    if (regionsCacheRef.current?.key === cacheKey) return regionsCacheRef.current.regions;
    const regions: HitRegion[] = [];
    const dwell = v.settings?.gazeDwellMs ?? 550;
    const summon = v.settings?.agentSummonDwellMs ?? 900;
    const noneDwell = v.settings?.noneDwellMs ?? 700;
    const cancelDwell = v.settings?.cancelDwellMs ?? 900;
    const measuredTopInset = configRef.current?.displayGeometry?.topInset ?? 0;
    const notchHeight = measuredTopInset > 0 ? measuredTopInset : (configRef.current?.platform === "darwin" ? 38 : 30);
    const notchCenterX = configRef.current?.displayGeometry?.notchCenterX ?? surface.width / 2;
    const notchLeftX = configRef.current?.displayGeometry?.notchLeftX;
    const notchRightX = configRef.current?.displayGeometry?.notchRightX;
    const notchWidth = notchLeftX != null && notchRightX != null ? notchRightX - notchLeftX : undefined;

    if (v.context && v.context.access !== "disabled") {
      for (const [id, rect] of contextControlRectsRef.current) regions.push(hit(rect, id, cancelDwell));
    }

    if (v.interactionState === "PASSIVE" || v.interactionState === "EXECUTING") {
      regions.push(hit(spriteRegion(surface, notchHeight, notchCenterX, notchWidth), "sprite", v.interactionState === "EXECUTING" ? 650 : summon));
    }

    if (SEMANTIC_STATES.has(v.interactionState) && v.prompt) {
      if (v.interactionState !== "DECODING_ALT") {
        const quadRegions = semanticLayout(surface, v).regions;
        for (const r of quadRegions) regions.push(hit(r, r.id, dwell));
      }

      const shelf = shelfRegions(surface, 3).slice(0, 3);
      const zones: Array<{ region: PlacedRegion; enabled: boolean; ms: number; slot: number }> = [
        { region: shelf[0], enabled: v.prompt.canBack, ms: dwell, slot: 0 },
        { region: shelf[1], enabled: v.prompt.canMore && v.interactionState !== "DECODING_ALT", ms: noneDwell, slot: 1 },
        { region: shelf[2], enabled: v.prompt.canExit, ms: cancelDwell, slot: 2 },
      ];
      for (const z of zones) {
        if (z.enabled) regions.push(hit(z.region, `shelf_${z.slot}`, z.ms));
      }

    }

    if (CONFIRM_STATES.has(v.interactionState)) {
      for (const r of confirmRegions(surface)) regions.push(hit(r, r.id, dwell));
    }

    regionsCacheRef.current = { key: cacheKey, regions };
    return regions;
  }

  const st = view.interactionState;
  const semanticBusy = st === "DECODING_ALT";
  const showSemantic = SEMANTIC_STATES.has(st) && view.prompt != null;
  const layout = semanticLayout(surfaceOf(), view);
  const nativeNotchHost = view.config?.nativeNotchHostAvailable === true;
  const hasMeasuredNotch = view.config?.displayGeometry?.notchLeftX != null
    && view.config.displayGeometry.notchRightX != null;
  const spriteState = focused === "sprite" ? "dwelling" : view.sprite;

  return (
    <div className="stage">
      <video id="gaze-camera" className="gaze-camera" autoPlay muted playsInline />
      {hasMeasuredNotch ? <div className={`perceived-notch${nativeNotchHost ? " native-notch-proxy" : ""}`} aria-hidden="true" /> : null}
      {debugOpen ? <div className="topbar">
        <button className="topbtn" onClick={() => setDebugOpen(!debugOpen)} title="Debug HUD">HUD</button>
        <div className="title">Gaze → Agent</div>
      </div> : null}
      <Sprite state={spriteState} progress={progress.sprite ?? null} hasNotch={hasMeasuredNotch} nativeHost={nativeNotchHost} startupHidden={view.config === null} />
      {view.context && view.context.access !== "disabled" ? <ContextBadge snapshot={view.context} focused={focused} /> : null}
      {navigationMode ? <div className="navigation-status">{navigationMode === "reading" ? "READING MODE" : "FEED MODE"} · R/F to switch · X to exit</div> : null}

      {showSemantic ? (
        <>
          <div className="prompt-buffer">
            <span className="prompt-prefix">🦉</span>
            <span className="prompt-text">{view.prompt!.displayPrompt}</span>
            {view.prompt!.mode === "clarify" && view.prompt!.clarificationQuestion ? <div className="clarify-question">“{view.prompt!.clarificationQuestion}”</div> : null}
          </div>
          <QuadrantGrid options={view.prompt!.options} focused={focused} progress={progress} regions={layout.regions} compact={layout.compact} locked={semanticBusy} contextLabel={view.prompt!.contextLabel} />
          {semanticBusy ? <div className="decoder-status" role="status" aria-live="polite"><span className="decoder-status-dot" />UPDATING CHOICES…</div> : null}
          <div className={`shelf${semanticBusy ? " decoding" : ""}`}>
            <div className={`shelf-zone${focused === "shelf_0" ? " active" : ""}`} aria-disabled={!view.prompt!.canBack}><span>← BACK</span></div>
            <div className={`shelf-zone${focused === "shelf_1" ? " active" : ""}`} aria-disabled={!view.prompt!.canMore || semanticBusy}><span>MORE / NONE</span></div>
            <div className={`shelf-zone${focused === "shelf_2" ? " active" : ""}`} aria-disabled={!view.prompt!.canExit}><span>× EXIT</span></div>
          </div>
        </>
      ) : null}

      {st === "CONSEQUENTIAL_CONFIRMATION" && view.consequential ? <ConsequentialCard summary={view.consequential.pendingActionSummary} /> : null}
      {st === "EXECUTION_INTERRUPTED" && view.steering ? <SteeringCard status={view.steering.recentStatus} options={view.steering.options} /> : null}
      {st === "ERROR_RECOVERY" && view.recovery ? <RecoveryCard summary={view.recovery.errorSummary} options={view.recovery.choices} /> : null}
      {st === "EXECUTING" && view.executing ? (
        <div className="executing-card">
          <div className="executing-spinner" />
          <div className="executing-text">{view.executing.statusText}</div>
          <div className="interrupt-line">Look at the sprite and hold to interrupt</div>
        </div>
      ) : null}
      {st === "COMPLETE" ? <div className="complete-card">✓ Task completed</div> : null}

      {st === "SETUP_REQUIRED" || st === "CALIBRATING" || st === "CALIBRATION_ERROR" ? <SetupWizard ready={Boolean(view.config)} calibrating={st === "CALIBRATING"} allowUnverified={view.config?.allowUnverifiedGaze === true} canRestore={view.config?.gazeProvider === "webeyetrack" && !view.config.forceCalibration && hasMatchingCalibrationViewport(view.config.allowUnverifiedGaze)} onCalibrate={() => void startLiveCalibration()} onRecalibrate={() => void startLiveCalibration(true)} onQuit={() => void api.quitApp()} /> : null}

      {view.notice ? <div className="notice" onClick={() => setView((v) => ({ ...v, notice: null }))}>{view.notice}</div> : null}
      {debugOpen ? <DebugHUD view={view} gaze={gazePoint} progress={progress} /> : null}
    </div>
  );
}

function isQuadrantId(value: string | null): value is "A" | "B" | "C" | "D" {
  return value === "A" || value === "B" || value === "C" || value === "D";
}
