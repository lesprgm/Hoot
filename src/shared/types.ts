import type { TaskRecord } from "./task";
import type { IntentFrame, IntentPatch } from "./intent";
export type { AuthoredFragment, EntityValue, EvidenceRef, EvidenceSource, IntentFrame, IntentFrameState, IntentPatch, IntentPatchValue, SemanticValue, UnresolvedIntentSlot } from "./intent";

export type QuadrantId = "A" | "B" | "C" | "D";

export type InteractionState =
  | "BOOT"
  | "SETUP_REQUIRED"
  | "CALIBRATING"
  | "CALIBRATION_ERROR"
  | "PASSIVE"
  | "AGENT_LOADING"
  | "SEMANTIC"
  | "SEMANTIC_PAUSED"
  | "DECODING_ALT"
  | "CLARIFYING"
  | "EXECUTING"
  | "EXECUTION_INTERRUPTED"
  | "CONSEQUENTIAL_CONFIRMATION"
  | "COMPLETE"
  | "ERROR_RECOVERY"
  | "ERROR";

export type SpriteState =
  | "idle"
  | "attention"
  | "dwelling"
  | "summoned"
  | "listening_for_gaze"
  | "thinking"
  | "speaking"
  | "computer_use_running"
  | "needs_confirmation"
  | "success"
  | "interrupted"
  | "error"
  | "paused"
  | "hidden";

export type SurfaceType =
  | "document_or_article"
  | "vertical_feed"
  | "media_player"
  | "email_or_message"
  | "shopping_or_product"
  | "search_or_results"
  | "maps_or_location"
  | "file_or_editor"
  | "form_or_transaction"
  | "generic_app"
  | "unknown";

export type OverlayLayout =
  | { kind: "screen_corners"; screenId?: string }
  | { kind: "window_halo"; windowBounds: ScreenRect };

export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowContext {
  appName: string;
  bundleId?: string;
  windowTitle: string;
  url?: string;
  windowId: number;
  bounds: ScreenRect;
  screenWidth: number;
  screenHeight: number;
}

export interface AttentionAnchor {
  screenXNorm: number;
  screenYNorm: number;
  windowXNorm: number | null;
  windowYNorm: number | null;
  insideActiveWindow: boolean;
}

/** Whether the current task is allowed to use context observations. */
export type ContextAccessState = "disabled" | "active" | "paused" | "blocked";

/** Approval scope for context collection during the current agent session. */
export type ContextApprovalScope = "app" | "session";

export type ContextSourceKind = "active_window" | "accessibility" | "browser" | "screenshot" | "task";

export type ContextSourceState = "available" | "unavailable" | "paused" | "not_requested";

export interface ContextSourceStatus {
  kind: ContextSourceKind;
  state: ContextSourceState;
  observedAt: number | null;
  detail?: string;
}

/** A bounded, re-checkable reference that a model may use to ground a card. */
export interface ContextReference {
  id: string;
  kind: "window" | "document" | "selection" | "control";
  label: string;
  appName: string;
  source: ContextSourceKind;
  observedAt: number;
  bounds?: ScreenRect;
  url?: string;
  text?: string;
  revision?: string;
}

export interface ContextSnapshot {
  access: ContextAccessState;
  sessionId: string | null;
  revision: number;
  window: WindowContext | null;
  surfaceType: SurfaceType;
  attentionAnchor: AttentionAnchor | null;
  capturedImageDataUrl: string | null;
  capturedWidth: number;
  capturedHeight: number;
  capturedAt: number | null;
  activeAppDisplayName: string;
  approvedApp: boolean;
  /** `app` keeps collection on the summoned app; `session` follows app changes. */
  contextScope: ContextApprovalScope;
  sources: ContextSourceStatus[];
  references: ContextReference[];
  focusedElement: ContextReference | null;
  selectedText: string | null;
  visibleText: string | null;
}

export interface GazeSample {
  xNorm: number;
  yNorm: number;
  timestampMs: number;
  valid: boolean;
  quality?: number;
}

export interface UserLexicon {
  people: string[];
  places: string[];
  apps: string[];
  recurringPhrases: string[];
  customVocabulary: string[];
}

export type DisplayOptionType =
  | "continuation"
  | "next_clause"
  | "full_prompt"
  | "do_that";

export interface DisplayOption {
  id: string;
  quadrant: QuadrantId;
  label: string;
  resultingPrompt: string;
  type: DisplayOptionType;
  semanticGroup: string;
  continuation?: string;
  /** Stable identity used by the atomic selection envelope. */
  cardId?: string;
  /** Main-process operation proposal; the renderer never executes this value. */
  operation?: string;
  /** Optional registered context target for a task-aware card. */
  referenceId?: string;
  /** Revision supplied by the decoder for target revalidation. */
  referenceRevision?: string;
  /** Snapshot revision used to revalidate a context target. */
  contextRevision?: number;
  /** Semantic meaning used by clarification answers; card label remains presentation. */
  resultingEvidence?: string;
  /** Structured semantic delta carried through the host-owned selection. */
  intentPatch?: IntentPatch;
}

export type SemanticMode = "predict" | "clarify";
export type DecisionKind = "compose" | "task_actions" | "clarify" | "review" | "error";

export interface PromptViewState {
  sessionId: string;
  displayPrompt: string;
  options: DisplayOption[];
  canBack: boolean;
  canMore: boolean;
  canExit: boolean;
  mode: SemanticMode;
  clarificationQuestion?: string;
  speculativeReady: Partial<Record<QuadrantId | "MORE", boolean>>;
  /** Immutable identity for this complete visible card set. */
  cardSetId?: string;
  /** Monotonic publication revision for stale-selection rejection. */
  revision?: number;
  /** Context reference shown as grounding metadata, never authorization. */
  contextLabel?: string;
  contextRevision?: number;
  decisionKind?: DecisionKind;
}

/** A selection committed by the renderer against one immutable card set. */
export interface SelectionEnvelope {
  interactionId: string;
  sessionId: string;
  cardSetId: string;
  cardId: string;
  expectedRevision: number;
}

export interface InteractionSnapshot {
  sessionId: string | null;
  interactionId: string | null;
  revision: number;
  state: InteractionState;
  busy: boolean;
  error: string | null;
  cardSetId: string | null;
  prompt: PromptViewState | null;
  context: ContextSnapshot | null;
  task?: TaskRecord | null;
  utilities: {
    back: boolean;
    more: boolean;
    exit: boolean;
  };
}

export type ConsequentialChoiceId = "approve" | "change" | "read" | "cancel";

export interface ConsequentialState {
  taskId: string;
  pendingActionSummary: string;
  taskContext: string;
  choices: Array<{ id: ConsequentialChoiceId; label: string }>;
}

export type SteeringChoiceId = "change_something" | "go_back" | "continue" | "stop";

export interface SteeringState {
  taskId: string;
  intentText: string;
  recentStatus: string;
  options: Array<{
    id: SteeringChoiceId;
    label: string;
    semanticMeaning: string;
  }>;
}

export type RecoveryChoiceId = "retry" | "go_back" | "choose_else" | "stop";

export interface RecoveryState {
  errorSummary: string;
  choices: Array<{ id: RecoveryChoiceId; label: string }>;
}

export interface ExecutorStatusState {
  taskId: string;
  statusText: string;
  stepIndex: number;
  stepCount: number;
}

export interface EditorState {
  intentText: string;
  options: DisplayOption[];
}

export type GazeStatus = "active" | "lost" | "paused" | "disabled";

export interface DebugInfo {
  state: InteractionState;
  gaze: { xNorm: number; yNorm: number; valid: boolean; fps: number };
  layoutMode: OverlayLayout["kind"];
  activeApp: string | null;
  dwellProgress: Record<string, number>;
  ttsProvider: string;
  decoderProvider: string;
  gazeProvider: string;
  lastViewState: ViewMessage;
}

export type AudioCue = "selection" | "ready" | "error";

export type ViewMessage =
  | { type: "state"; state: InteractionState }
  | { type: "prompt"; view: PromptViewState }
  | { type: "interaction-snapshot"; snapshot: InteractionSnapshot }
  | { type: "task"; task: TaskRecord | null }
  | { type: "executing"; status: ExecutorStatusState }
  | { type: "consequential"; view: ConsequentialState }
  | { type: "steering"; view: SteeringState }
  | { type: "recovery"; view: RecoveryState }
  | { type: "editor"; view: EditorState }
  | { type: "sprite"; sprite: SpriteState; metadata?: Record<string, unknown> }
  | { type: "speech"; text: string; provider: string; dataUrl: string }
  | { type: "speech-stop" }
  | { type: "audio-cue"; cue: AudioCue }
  | { type: "gaze-status"; status: GazeStatus }
  | { type: "context"; snapshot: ContextSnapshot }
  | { type: "layout-mode"; layout: OverlayLayout["kind"] }
  | { type: "settings"; settings: AppSettings }
  | { type: "app-mode"; mode: "simulated" | "live" }
  | { type: "notice"; text: string };

export interface AppSettings {
  gazeDwellMs: number;
  agentSummonDwellMs: number;
  noneDwellMs: number;
  cancelDwellMs: number;
  gazeEmaAlpha: number;
  prefetchEnabled: boolean;
  reducedAnimation: boolean;
  decoderModel: string;
  geminiDecoderModel?: string;
  /** Explicit direct-Gemini route for screenshot-aware semantic decoding. */
  visionDecoderProvider?: "none" | "gemini";
  executorModel: string;
  ttsModel: string;
  ttsStability: number;
  ttsSimilarityBoost: number;
  ttsStyle: number;
  ttsUseSpeakerBoost: boolean;
  ttsSpeed: number;
  /** Optional decoder/task-aware rollout controls. */
  decoderInteractionDeadlineMs?: number;
  decoderRequestMaxMs?: number;
  /** Enables approved active-window context during simulated gaze demos. */
  contextInSimulation?: boolean;
  taskAwareCards?: boolean;
  /**
   * When enabled, Hoots intentionally exposes its overlay to external
   * recorders. Astra uses the filtered ScreenCaptureKit path in this mode so
   * the agent does not receive Hoots' own cards or notch helper.
   */
  hootsRecordingMode?: boolean;
}

export interface AppConfig {
  gazeProvider: "webeyetrack" | "simulated";
  ttsProvider: "elevenlabs" | "macos" | "mute";
  elevenLabsVoiceId: string;
  executorProvider: "openai";
  decoderProvider: "gemini" | "openrouter" | "fixture";
  decoderFallbackProvider: "gemini" | null;
  executionMode: "live";
  simulateGaze: boolean;
  forceCalibration: boolean;
  allowUnverifiedGaze: boolean;
  /** Optional case-insensitive app names or bundle IDs allowed for context. */
  contextAllowedApps: string[];
  debugHud: boolean;
  settings: AppSettings;
  hasOpenAiKey: boolean;
  hasGeminiKey: boolean;
  hasOpenRouterKey: boolean;
  hasElevenLabsKey: boolean;
  platform: string;
  nativeNotchHostAvailable: boolean;
  displayGeometry?: {
    width: number;
    height: number;
    scale: number;
    topInset: number;
    notchCenterX: number | null;
    notchLeftX: number | null;
    notchRightX: number | null;
  };
}

export interface PermissionStatus {
  camera: "granted" | "denied" | "unknown";
  screenRecording: "granted" | "denied" | "unknown";
  accessibility: "granted" | "denied" | "unknown";
}

export interface CalibrationResult {
  ok: boolean;
  message: string;
  verification?: { target: QuadrantId; pass: boolean }[];
}

export interface ExecutorEvent {
  type:
    | "task_started"
    | "step"
    | "status"
    | "consequential_pending"
    | "completed"
    | "interrupted"
    | "stopped"
    | "error";
  taskId: string;
  stepIndex?: number;
  stepCount?: number;
  text?: string;
  pendingAction?: string;
}

export interface ExecutedTask {
  taskId: string;
  naturalLanguagePrompt: string;
  explicitEvidence?: string[];
  startedAt: number;
  mode: "live";
  taskRevision?: number;
  referenceRevisions?: Record<string, string>;
}

export interface IntentSlot {
  name: string;
  description: string;
}

export interface ExplicitEvidence {
  kind: "option" | "clarification";
  text: string;
  semanticFragment: string;
  turn: number;
}

export interface RawCandidate {
  id: string;
  label: string;
  continuation: string;
  resultingPrompt: string;
  modelScore: number;
  type: DisplayOptionType;
  semanticGroup: string;
  estimatedLikelihood: number;
  introducesNewMeaning: boolean;
  operation?: string;
  referenceId?: string;
  referenceRevision?: string;
  /** Structured semantic delta proposed by the decoder. */
  intentPatch?: IntentPatch;
}

export interface DecoderResponse {
  mode: "predict" | "clarify";
  normalizedPrompt: string;
  promptIsExecutable: boolean;
  openSlots: IntentSlot[];
  candidates: RawCandidate[];
  /** Optional host-readable unresolved slots returned with hypotheses. */
  unresolvedSlots?: IntentSlot[];
  clarification?: {
    spokenQuestion: string;
    answers: Array<{ label: string; meaning: string; resultingEvidence: string }>;
  };
}

export interface DecoderInput {
  displayPrompt: string;
  explicitSemanticEvidence: string[];
  rejectedSets: Array<{ labels: string[]; turn: number }>;
  historyDepth: number;
  userLexicon: UserLexicon;
  optionalContext: {
    activeApp: string | null;
    activeAppUrl: string | null;
    surfaceType: SurfaceType | null;
    visibleReferent: string | null;
    gazeTargetDescription: string | null;
    capturedImageDataUrl: string | null;
    contextState?: ContextAccessState;
    contextSessionId?: string | null;
    contextRevision?: number;
    contextSources?: ContextSourceStatus[];
    contextReferences?: ContextReference[];
    focusedElement?: ContextReference | null;
    selectedText?: string | null;
    visibleText?: string | null;
    /** Bounded weak observations; an absent observation never excludes a target. */
    contextLedger?: {
      active: boolean;
      revision: number;
      observations: Array<{
        id: string;
        source: "foreground_context" | "recent_context" | "background_context";
        kind: string;
        label: string;
        appName: string | null;
        url?: string;
        text?: string;
        referenceId?: string;
        observedAt: number;
        revision: number;
      }>;
    };
  };
  consecutiveNoneCount: number;
  clarificationAnswers: Array<{ question: string; answer: string }>;
  turn: number;
  /** Accepted task state is host-owned context, not model authorization. */
  task?: TaskRecord | null;
  /** Typed intent state is authoritative; prompt text is presentation only. */
  intentFrame?: IntentFrame;
}
