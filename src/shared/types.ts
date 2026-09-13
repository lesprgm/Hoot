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
  | "FALLBACK_TEXT"
  | "INTENT_CONFIRMATION"
  | "EXECUTING"
  | "EXECUTION_INTERRUPTED"
  | "CONFIRM_ACTION"
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

export interface ContextSnapshot {
  window: WindowContext | null;
  surfaceType: SurfaceType;
  attentionAnchor: AttentionAnchor | null;
  capturedImageDataUrl: string | null;
  capturedWidth: number;
  capturedHeight: number;
  capturedAt: number | null;
  activeAppDisplayName: string;
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
}

export type SemanticMode = "predict" | "clarify" | "hint";

export interface PromptViewState {
  sessionId: string;
  displayPrompt: string;
  options: DisplayOption[];
  canBack: boolean;
  canMore: boolean;
  canHint: boolean;
  canExit: boolean;
  mode: SemanticMode;
  clarificationQuestion?: string;
  speculativeReady: Partial<Record<QuadrantId | "MORE", boolean>>;
  hintText?: string;
}

export interface HintViewState {
  sessionId: string;
  displayPrompt: string;
  hintText: string;
  candidateOptions: DisplayOption[];
}

export type ConfirmationChoiceId = "yes" | "change" | "read" | "cancel";

export interface IntentConfirmationState {
  sessionId: string;
  intentText: string;
  speakText: string;
  canBack: boolean;
  choices: Array<{ id: ConfirmationChoiceId; label: string }>;
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

export interface TelemetrySummary {
  semanticSelections: number;
  noneSelections: number;
  clarificationAnswers: number;
  fallbackCharacters: number;
  timeToIntentMs: number | null;
  decoderColdLatencyMs: number[];
  prefetchHits: number;
  prefetchMisses: number;
  prefetchedUiLatencyMs: number[];
  ttsTimeToFirstAudioMs: number[];
  executorActions: number;
  totalTaskTimeMs: number | null;
  lastTaskSummary: string | null;
}

export interface DebugInfo {
  state: InteractionState;
  gaze: { xNorm: number; yNorm: number; valid: boolean; fps: number };
  layoutMode: OverlayLayout["kind"];
  activeApp: string | null;
  dwellProgress: Record<string, number>;
  ttsProvider: string;
  decoderProvider: string;
  gazeProvider: string;
  telemetry: TelemetrySummary;
  lastViewState: ViewMessage;
}

export type AudioCue = "selection" | "ready" | "error";

export type ViewMessage =
  | { type: "state"; state: InteractionState }
  | { type: "prompt"; view: PromptViewState }
  | { type: "hint"; view: PromptViewState }
  | { type: "intent-confirmation"; view: IntentConfirmationState }
  | { type: "executing"; status: ExecutorStatusState }
  | { type: "consequential"; view: ConsequentialState }
  | { type: "steering"; view: SteeringState }
  | { type: "recovery"; view: RecoveryState }
  | { type: "editor"; view: EditorState }
  | { type: "telemetry"; summary: TelemetrySummary }
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
  hintDwellMs: number;
  gazeEmaAlpha: number;
  autoScrollEnabled: boolean;
  prefetchEnabled: boolean;
  ttsPrefetchEnabled: boolean;
  speakOptionOnHover: boolean;
  reducedAnimation: boolean;
  gazeConfidenceMin: number;
  duplicateThreshold: number;
  decoderModel: string;
  executorModel: string;
  ttsModel: string;
}

export interface AppConfig {
  gazeProvider: "webeyetrack" | "realeye" | "simulated";
  ttsProvider: "elevenlabs" | "macos" | "mute";
  elevenLabsVoiceId: string;
  executorProvider: "openai";
  decoderProvider: "openai" | "gemini" | "fixture";
  executionMode: "live";
  simulateGaze: boolean;
  forceCalibration: boolean;
  allowUnverifiedGaze: boolean;
  debugHud: boolean;
  settings: AppSettings;
  hasOpenAiKey: boolean;
  hasGeminiKey: boolean;
  hasElevenLabsKey: boolean;
  platform: string;
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
  canonicalIntent?: CanonicalIntent;
  explicitEvidence?: string[];
  startedAt: number;
  mode: "live";
}

export interface IntentClause {
  action: string;
  target?: string;
  modifiers: string[];
}

export interface ExplicitEntity {
  kind: string;
  value: string;
}

export interface IntentConstraint {
  name: string;
  value: string;
}

export interface IntentSlot {
  name: string;
  description: string;
}

export interface CanonicalIntent {
  clauses: IntentClause[];
  explicitEntities: ExplicitEntity[];
  constraints: IntentConstraint[];
  unresolvedSlots: IntentSlot[];
}

export type HintType =
  | "letters"
  | "word_prefix"
  | "keyword"
  | "initialism"
  | "number"
  | "literal_text";

export interface Hint {
  text: string;
  type: HintType;
  enteredAt: number;
}

export interface ExplicitEvidence {
  kind: "option" | "hint" | "clarification" | "literal";
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
}

export interface DecoderResponse {
  mode: "predict" | "clarify";
  normalizedPrompt: string;
  promptIsExecutable: boolean;
  openSlots: IntentSlot[];
  candidates: RawCandidate[];
  clarification?: {
    spokenQuestion: string;
    answers: Array<{ label: string; meaning: string; resultingEvidence: string }>;
  };
}

export interface DecoderInput {
  displayPrompt: string;
  explicitSemanticEvidence: string[];
  hints: Array<{ text: string; type: HintType }>;
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
  };
  consecutiveNoneCount: number;
  clarificationAnswers: Array<{ question: string; answer: string }>;
  turn: number;
}

export interface DecoderTurn {
  surfaceType: SurfaceType;
  spokenPrompt: string;
  options: [DecoderOption, DecoderOption, DecoderOption, DecoderOption];
  candidateIntent: string | null;
  candidateIntentReady: boolean;
  navigationModeSuggestion: "none" | "reading" | "vertical_feed";
}

export interface DecoderOption {
  id: QuadrantId;
  label: string;
  semanticFragment: string;
  kind: "intent" | "category" | "detail" | "answer";
}

export interface ClarificationTurn {
  spokenQuestion: string;
  options: [
    { id: "A"; label: string; semanticAnswer: string },
    { id: "B"; label: string; semanticAnswer: string },
    { id: "C"; label: string; semanticAnswer: string },
    { id: "D"; label: string; semanticAnswer: string }
  ];
}
