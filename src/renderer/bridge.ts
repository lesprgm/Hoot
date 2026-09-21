import { IPC } from "../shared/ipc";
import type {
  AppConfig,
  AppSettings,
  ConsequentialState,
  ContextSnapshot,
  DebugInfo,
  EditorState,
  PermissionStatus,
  PromptViewState,
  RecoveryState,
  SpriteState,
  SteeringState,
  ViewMessage,
  SelectionEnvelope,
  InteractionSnapshot,
} from "../shared/types";
import type { TaskRecord } from "../shared/task";
import { invoke, subscribe } from "./subscribe";

export interface RendererApi {
  getConfig(): Promise<AppConfig>;
  getPermissionStatus(): Promise<PermissionStatus>;
  prepareCalibration(): Promise<void>;
  calibrationFailed(message: string): Promise<void>;
  startCalibration(): Promise<{ ok: boolean; message: string }>;
  enterDemoMode(): Promise<void>;
  quitApp(): Promise<void>;
  summon(): Promise<void>;
  prefetchOption(quadrant: "A" | "B" | "C" | "D"): Promise<void>;
  selectOption(selection: SelectionEnvelope): Promise<void>;
  more(): Promise<void>;
  back(): Promise<void>;
  exitSession(): Promise<void>;
  interruptExecutor(): Promise<void>;
  steer(choice: string): Promise<void>;
  consequentialChoice(choice: string): Promise<void>;
  recovery(choice: string): Promise<void>;
  toggleContext(): Promise<void>;
  approveContextSession(): Promise<void>;
  setAnchor(xNorm: number, yNorm: number, windowXNorm: number | null, windowYNorm: number | null, insideActiveWindow: boolean): Promise<void>;
  gazeStatus(valid: boolean): Promise<void>;
  notchVisual(sprite: SpriteState, progress: number | null, focused: boolean): Promise<void>;
  navigationScroll(direction: "next" | "previous", deltaPx: number): Promise<void>;
  getDebugInfo(): Promise<DebugInfo | null>;
  toggleHud(): Promise<void>;
  forceState(state: string): Promise<void>;
  simulate(action: string): Promise<void>;
}

export const api: RendererApi = {
  getConfig: () => invoke<AppConfig>(IPC.getConfig),
  getPermissionStatus: () => invoke<PermissionStatus>(IPC.getPermissionStatus),
  prepareCalibration: () => invoke(IPC.prepareCalibration),
  calibrationFailed: (message) => invoke(IPC.calibrationFailed, message),
  startCalibration: () => invoke(IPC.startCalibration),
  enterDemoMode: () => invoke(IPC.enterDemoMode),
  quitApp: () => invoke(IPC.quitApp),
  summon: () => invoke(IPC.summon),
  prefetchOption: (q) => invoke(IPC.prefetchOption, q),
  selectOption: (selection) => invoke(IPC.selectOption, selection),
  more: () => invoke(IPC.more),
  back: () => invoke(IPC.back),
  exitSession: () => invoke(IPC.exitSession),
  interruptExecutor: () => invoke(IPC.interruptExecutor),
  steer: (c) => invoke(IPC.steer, c),
  consequentialChoice: (c) => invoke(IPC.consequentialChoice, c),
  recovery: (c) => invoke(IPC.recovery, c),
  toggleContext: () => invoke(IPC.contextToggle),
  approveContextSession: () => invoke(IPC.contextApproveSession),
  setAnchor: (x, y, wx, wy, inside) => invoke(IPC.gazeAnchor, { xNorm: x, yNorm: y, windowXNorm: wx, windowYNorm: wy, insideActiveWindow: inside }),
  gazeStatus: (valid) => invoke(IPC.gazeSample, valid),
  notchVisual: (sprite, progress, focused) => invoke(IPC.notchVisual, { sprite, progress, focused }),
  navigationScroll: (direction, deltaPx) => invoke(IPC.navigationScroll, { direction, deltaPx }),
  getDebugInfo: () => invoke(IPC.getDebugInfo),
  toggleHud: () => invoke(IPC.toggleHud),
  forceState: (s) => invoke(IPC.forceState, s),
  simulate: (a) => invoke(IPC.simulateAction, a),
};

export interface ViewState {
  config: AppConfig | null;
  settings: AppSettings | null;
  appMode: "simulated" | "live";
  interactionState: string;
  prompt: PromptViewState | null;
  executing: { statusText: string; stepIndex: number; stepCount: number } | null;
  consequential: ConsequentialState | null;
  steering: SteeringState | null;
  recovery: RecoveryState | null;
  editor: EditorState | null;
  sprite: SpriteState;
  speech: { text: string; dataUrl?: string } | null;
  gazeStatus: string;
  notice: string | null;
  context: ContextSnapshot | null;
  interactionSnapshot: InteractionSnapshot | null;
  task: TaskRecord | null;
}

export function initialViewState(): ViewState {
  return {
    config: null,
    settings: null,
    appMode: "live",
    interactionState: "BOOT",
    prompt: null,
    executing: null,
    consequential: null,
    steering: null,
    recovery: null,
    editor: null,
    sprite: "idle",
    speech: null,
    gazeStatus: "disabled",
    notice: null,
    context: null,
    interactionSnapshot: null,
    task: null,
  };
}

export function applyMessage(state: ViewState, message: ViewMessage): ViewState {
  switch (message.type) {
    case "state":
      // Direct intent execution sends its payload immediately after the state
      // transition. Keep the semantic view mounted until that payload arrives.
      if (message.state === "EXECUTING" && !state.executing && state.prompt) return state;
      return { ...state, interactionState: message.state };
    case "prompt":
      return { ...state, prompt: message.view, executing: null, consequential: null, steering: null, recovery: null, editor: null };
    case "interaction-snapshot":
      return {
        ...state,
        interactionSnapshot: message.snapshot,
        // The snapshot is the authoritative state boundary. Null is a real
        // value, so an old prompt, context, or task cannot survive a session
        // exit or state transition by accident.
        prompt: message.snapshot.prompt,
        context: message.snapshot.context,
        task: message.snapshot.task ?? null,
        interactionState: message.snapshot.state,
      };
    case "task":
      return { ...state, task: message.task };
    case "executing":
      return { ...state, interactionState: "EXECUTING", executing: message.status, prompt: null, consequential: null, steering: null, recovery: null, editor: null };
    case "consequential":
      return { ...state, consequential: message.view, executing: { statusText: "Waiting for your decision…", stepIndex: 0, stepCount: 1 } };
    case "steering":
      return { ...state, steering: message.view };
    case "recovery":
      return { ...state, recovery: message.view };
    case "editor":
      return { ...state, editor: message.view };
    case "sprite":
      return { ...state, sprite: message.sprite };
    case "speech":
      return { ...state, speech: { text: message.text, dataUrl: message.dataUrl } };
    case "speech-stop":
      return { ...state, speech: null };
    case "gaze-status":
      return { ...state, gazeStatus: message.status };
    case "context":
      return { ...state, context: message.snapshot };
    case "layout-mode":
      return state;
    case "settings":
      return { ...state, settings: message.settings };
    case "app-mode":
      return { ...state, appMode: message.mode };
    case "notice":
      return { ...state, notice: message.text };
    default:
      return state;
  }
}

export function subscribeView(handler: (message: ViewMessage) => void): () => void {
  return subscribe<ViewMessage>(IPC.viewUpdate, handler);
}

export { invoke };
