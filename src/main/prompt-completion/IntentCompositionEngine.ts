import { randomUUID } from "node:crypto";
import type {
  ContextSnapshot,
  DecoderInput,
  DecoderResponse,
  DisplayOption,
  ExplicitEvidence,
  PromptViewState,
  QuadrantId,
  UserLexicon,
} from "../../shared/types";
import { applyIntentPatch, applySemanticFragment, cloneIntentFrame, createIntentFrame, deriveFrameState, type IntentFrame, type IntentPatch } from "../../shared/intent";
import type { TaskRecord } from "../../shared/task";
import { CandidateValidator } from "./CandidateValidator";
import { FixtureDecoderProvider } from "./FixtureDecoderProvider";
import type { DecoderProvider } from "./DecoderProvider";
import { GeminiFlashLiteProvider } from "./GeminiFlashLiteProvider";
import { OpenRouterDeepSeekProvider } from "./OpenRouterDeepSeekProvider";
import { DirectGeminiFallbackProvider } from "./DirectGeminiFallbackProvider";
import { PromptHistory, cloneNode, type PromptNode } from "./PromptHistory";
import { SpeculationCache, type SpeculativeState } from "./SpeculationCache";
import type { AppSettings } from "../../shared/types";
import { DecoderRequestCoordinator } from "./DecoderRequestCoordinator";
import { CandidateRanker } from "./CandidateRanker";
import { ContextLedger } from "../context/ContextLedger";
import { TargetResolver } from "../context/TargetResolver";
import { contextPredictionOptions } from "../context/ContextPrediction";
import { mergeLexicons, relevantLexicon } from "../context/PersonalizationLexicon";
import { compileTask } from "../task/TaskCompiler";

export interface EngineEvents {
  onView(view: PromptViewState): void;
  onIntent(intentText: string, frame?: IntentFrame): void;
  onBusy(busy: boolean): void;
}

export const DEFAULT_LEXICON: UserLexicon = {
  people: ["Professor Lee"],
  places: [],
  apps: ["Spotify", "Calendar", "Mail", "YouTube"],
  recurringPhrases: [],
  customVocabulary: [],
};

export type DecoderProviderKind = "gemini" | "openrouter" | "fixture";
export type DecoderFallbackProviderKind = "gemini" | null;

const QUADRANT_ORDER: QuadrantId[] = ["A", "B", "C", "D"];

interface SessionState {
  sessionId: string;
  turn: number;
  displayPrompt: string;
  evidence: ExplicitEvidence[];
  rejectedSets: Array<{ labels: string[]; turn: number }>;
  noneCount: number;
  clarifications: Array<{ question: string; answer: string }>;
  frame: IntentFrame;
}

interface PreparedDisplayOptions {
  response: DecoderResponse;
  display: DisplayOption[];
  errors: string[];
}

function freshSession(): SessionState {
  return {
    sessionId: randomUUID(),
    turn: 0,
    displayPrompt: "I want you to…",
    evidence: [],
    rejectedSets: [],
    noneCount: 0,
    clarifications: [],
    frame: createIntentFrame(),
  };
}

export class IntentCompositionEngine {
  private provider: DecoderProvider;
  private visionProvider: DecoderProvider | null = null;
  private validator = new CandidateValidator();
  private history = new PromptHistory();
  private cache = new SpeculationCache(true);
  private session: SessionState | null = null;
  private currentNode: PromptNode | null = null;
  private context: ContextSnapshot | null = null;
  private task: TaskRecord | null = null;
  private sessionGeneration = 0;
  private speculationInFlight = new Map<string, Promise<void>>();
  private contextPredictionShownSessionId: string | null = null;
  private readonly coordinator: DecoderRequestCoordinator;
  private readonly ranker = new CandidateRanker();
  private readonly contextLedger = new ContextLedger();
  private readonly targetResolver = new TargetResolver();
  private readonly userLexicon: UserLexicon;

  constructor(
    private events: EngineEvents,
    private settings: AppSettings,
    acceptRealModel: boolean,
    private decoderProvider: DecoderProviderKind = "openrouter",
    private decoderFallbackProvider: DecoderFallbackProviderKind = null,
    personalLexicon: Partial<UserLexicon> = {},
  ) {
    this.userLexicon = mergeLexicons(DEFAULT_LEXICON, personalLexicon);
    this.coordinator = new DecoderRequestCoordinator({
      interactionDeadlineMs: settings.decoderInteractionDeadlineMs,
      requestMaxMs: settings.decoderRequestMaxMs,
    });
    this.provider = this.createProvider(acceptRealModel);
    this.visionProvider = this.createVisionProvider(acceptRealModel);
  }

  get peerCount(): number {
    return this.history.depth;
  }

  get sessionId(): string | null {
    return this.session?.sessionId ?? null;
  }

  getActivePrompt(): string {
    return this.session?.displayPrompt ?? "";
  }

  getProviderName(): string {
    return this.provider.name;
  }

  setContext(context: ContextSnapshot | null): void {
    this.context = context;
    if (context?.access === "active") {
      const ledger = this.contextLedger.digest();
      if (!ledger.active || ledger.sessionId !== context.sessionId) this.contextLedger.enable(context.sessionId);
      this.contextLedger.record(context);
    } else {
      this.contextLedger.pause();
      this.contextLedger.clear();
    }
    this.maybeShowContextPredictions(context);
  }

  /** Update accepted task state without resetting the current composition. */
  setTask(task: TaskRecord | null): void {
    this.task = task ? structuredClone(task) : null;
  }

  async warmup(): Promise<void> {
    await Promise.all([
      this.provider.warmup?.(),
      this.visionProvider?.warmup?.(),
      this.targetResolver.warmup(),
    ]);
  }

  /** Cancel the active provider request without discarding accepted evidence. */
  cancelPending(): void {
    this.coordinator.cancelAll("local interaction control");
    this.sessionGeneration += 1;
    this.speculationInFlight.clear();
    // Cancellation is a local UI operation. Clear the busy indicator even when
    // a provider ignores AbortSignal and resolves later.
    this.events.onBusy(false);
  }

  setRealModelEnabled(enabled: boolean): void {
    this.coordinator.cancelAll("decoder provider changed");
    this.provider = this.createProvider(enabled);
    this.visionProvider = this.createVisionProvider(enabled);
    this.cache.invalidateAll();
    this.speculationInFlight.clear();
  }

  private createProvider(enabled: boolean): DecoderProvider {
    if (!enabled || this.decoderProvider === "fixture") return new FixtureDecoderProvider();
    if (this.decoderProvider === "gemini") return new GeminiFlashLiteProvider(this.settings.decoderModel);
    const primary = new OpenRouterDeepSeekProvider(this.settings.decoderModel);
    return this.decoderFallbackProvider === "gemini"
      ? new DirectGeminiFallbackProvider(primary, new GeminiFlashLiteProvider(this.settings.geminiDecoderModel ?? "gemini-3.5-flash-lite"))
      : primary;
  }

  private createVisionProvider(enabled: boolean): DecoderProvider | null {
    if (!enabled || this.settings.visionDecoderProvider !== "gemini") return null;
    // Vision routing is an explicit direct-Gemini path. It is independent of
    // the transport-only fallback wrapper used for text decoder failures.
    return new GeminiFlashLiteProvider(this.settings.geminiDecoderModel ?? "gemini-3.5-flash-lite");
  }

  private providerForInput(input: DecoderInput): DecoderProvider {
    return this.visionProvider && Boolean(input.optionalContext.capturedImageDataUrl)
      ? this.visionProvider
      : this.provider;
  }

  async start(context?: ContextSnapshot | null): Promise<PromptViewState> {
    this.sessionGeneration += 1;
    this.session = freshSession();
    this.context = context ?? null;
    this.history.clear();
    this.cache.invalidateAll();
    this.speculationInFlight.clear();
    this.contextPredictionShownSessionId = null;
    this.contextLedger.enable(this.session.sessionId);
    if (this.context?.access === "active") this.contextLedger.record(this.context);
    else this.contextLedger.pause();
    // No semantic evidence exists for a new composition. A fixed, exhaustive
    // set of broad action families is faster and less biased than asking a
    // model to guess a specific person, app, or task from the user's lexicon.
    // An explicitly enabled task-aware session instead starts with four local
    // actions over the active task; that transition never needs a decoder
    // request and does not alter the default composition path.
    const contextOptions = contextPredictionOptions(this.context);
    const node = this.taskActionNode() ?? (contextOptions ? this.contextPredictionNode(contextOptions) : this.rootNode());
    if (contextOptions) this.contextPredictionShownSessionId = this.session.sessionId;
    this.currentNode = node;
    this.session.displayPrompt = node.displayPrompt;
    const view = this.viewFor(node);
    this.events.onView(view);
    return view;
  }

  /** Start one continuation request for the card currently under gaze.
   *
   * The renderer calls this before the dwell commits. The request uses the
   * same scoped cache as a committed selection, so a completed request can be
   * applied without issuing a second decoder request.
   */
  prefetchOption(quadrant: QuadrantId): Promise<void> {
    // Gemini is intentionally single-request: speculative branch requests
    // duplicate the paid decoder call and can race the user-visible request.
    if (!this.settings.prefetchEnabled || this.decoderProvider === "gemini") return Promise.resolve();
    const node = this.currentNode;
    const session = this.session;
    if (!node || !session) return Promise.resolve();
    const option = node.displayedCandidates.find((candidate) => candidate.quadrant === quadrant);
    if (!option || option.type === "do_that" || option.type === "full_prompt") {
      return Promise.resolve();
    }
    const scope = this.scopeKey(node);
    return this.speculateOne(scope, quadrant, () => this.inputAfterSelection(option));
  }

  async selectOption(quadrant: QuadrantId): Promise<PromptViewState> {
    const session = this.requireSession();
    const node = this.currentNode;
    if (!session || !node) return this.rootView();
    const option = node.displayedCandidates.find((o) => o.quadrant === quadrant);
    if (!option) return this.rootView();
    const scope = this.scopeKey(node);

    if (option.type === "do_that" || option.type === "full_prompt") {
      this.history.push(snapshotWithSession(node, session));
      // `resultingPrompt` is the validated intent for both terminal option
      // types. The session display can lag semantic evidence such as a media
      // target that was reconstructed during deterministic refinement.
      const terminalFrame = option.intentPatch
        ? applyIntentPatch(session.frame, option.intentPatch, "user_selected", session.turn, option.label)
          : option.continuation && hasStructuredContinuation(option.continuation)
          ? applySemanticFragment(session.frame, option.continuation, "user_selected", session.turn, option.label)
          : session.frame;
      terminalFrame.state = "ready_for_execution";
      const text = !hasStructuredContinuation(option.continuation ?? "")
        ? completePrompt(option.resultingPrompt)
        : completePrompt(compileTask(terminalFrame).prompt);
      this.events.onIntent(text, terminalFrame);
      return this.currentView();
    }

    this.history.push(snapshotWithSession(node, session));
    this.commitEvidence(option);
    session.displayPrompt = compileTask(session.frame).prompt || option.resultingPrompt;
    session.turn += 1;

    let cached = this.cache.take(scope, quadrant);
    if (!cached) {
      const pending = this.speculationInFlight.get(`${scope}::${quadrant}`);
      if (pending) {
        this.events.onBusy(true);
        try {
          await pending;
          cached = this.cache.take(scope, quadrant);
        } finally {
          if (!cached) this.events.onBusy(false);
        }
      }
    }
    if (cached) {
      this.applySpeculative(cached);
      this.events.onBusy(false);
      return this.currentView();
    }
    return this.generateFromCurrent();
  }

  async more(): Promise<PromptViewState> {
    const session = this.requireSession();
    const node = this.currentNode;
    if (!session || !node) return this.rootView();
    const scope = this.scopeKey(node);
    session.noneCount += 1;
    session.rejectedSets.push({ labels: node.displayedCandidates.map((o) => o.label), turn: session.turn });

    const cached = this.cache.take(scope, "MORE");
    if (cached) {
      this.applySpeculative(cached);
      return this.currentView();
    }
    return this.generateFromCurrent();
  }

  /** Re-enter semantic prediction after the user rejects clarification. */
  async continueGuessing(): Promise<PromptViewState> {
    const session = this.requireSession();
    if (!session) return this.currentView();
    session.noneCount = 0;
    session.rejectedSets = [];
    return this.generateFromCurrent();
  }

  async back(): Promise<PromptViewState> {
    const previous = this.history.pop();
    if (!previous) return this.currentView();
    if (!this.session) return this.currentView();
    this.session.displayPrompt = previous.displayPrompt;
    this.session.evidence = previous.explicitEvidence.map((e) => ({ ...e }));
    this.session.rejectedSets = previous.rejectedSetsCopy.map((r) => ({ labels: [...r.labels], turn: r.turn }));
    this.session.noneCount = previous.noneCount;
    this.session.clarifications = previous.clarifications.map((c) => ({ ...c }));
    this.session.turn = previous.turn;
    this.session.frame = previous.frame ? cloneIntentFrame(previous.frame) : createIntentFrame();
    this.currentNode = cloneNode(previous);
    const view = this.viewFor(this.currentNode);
    this.events.onView(view);
    return view;
  }

  exit(): void {
    this.sessionGeneration += 1;
    this.session = null;
    this.currentNode = null;
    this.history.clear();
    this.cache.invalidateAll();
    this.speculationInFlight.clear();
    this.contextPredictionShownSessionId = null;
    this.contextLedger.disable();
    this.coordinator.cancelAll("session exited");
  }

  /** Restart composition while retaining the current app context. */
  async restartComposition(): Promise<PromptViewState> {
    return this.start(this.context);
  }

  private requireSession(): SessionState | null {
    return this.session;
  }

  private commitEvidence(option: DisplayOption): void {
    const session = this.session;
    if (!session) return;
    if (this.isClarifyAnswer(option)) {
      const question = this.currentNode?.clarificationQuestion ?? "What is this mainly about?";
      session.clarifications.push({ question, answer: option.label });
      const clarificationFragment = option.resultingEvidence ?? "";
      if (clarificationFragment) session.frame = applySemanticFragment(session.frame, clarificationFragment, "user_selected", session.turn, option.label);
      session.noneCount = 0;
      return;
    }
    const fragment = evidenceFragmentFor(option);
    session.evidence.push({ kind: "option", text: option.label, semanticFragment: fragment, turn: session.turn });
    if (fragment && fragment !== "something_else" && fragment !== "clarify_answer") {
      session.frame = option.intentPatch
        ? applyIntentPatch(session.frame, option.intentPatch, "user_selected", session.turn, option.label)
        : applySemanticFragment(session.frame, fragment, "user_selected", session.turn, option.label);
      session.frame.unresolvedSlots = [];
    }
  }

  private async generateFromCurrent(): Promise<PromptViewState> {
    const session = this.requireSession();
    if (!session) return this.currentView();
    const generation = this.sessionGeneration;
    const started = now();
    this.events.onBusy(true);
    try {
      const node = await this.generateNode(this.buildInput(), "predict");
      if (generation !== this.sessionGeneration || this.session !== session) return this.currentView();
      this.currentNode = node;
      session.displayPrompt = node.displayPrompt;
      const view = this.viewFor(node);
      this.events.onView(view);
      console.info(`[decoder] ${JSON.stringify({ event: "choices_rendered", provider: this.provider.name, mode: node.mode, durationMs: Math.round(now() - started) })}`);
      return view;
    } finally {
      if (generation === this.sessionGeneration) this.events.onBusy(false);
    }
  }

  private applySpeculative(state: SpeculativeState): void {
    const session = this.session;
    if (!session) return;
    const node: PromptNode = {
      nodeId: randomUUID(),
      displayPrompt: state.response.normalizedPrompt || session.displayPrompt,
      explicitEvidence: session.evidence,
      rawCandidates: state.response.candidates,
      displayedCandidates: state.display,
      rejectedCandidateIds: [],
      mode: state.response.mode,
      clarificationQuestion: state.response.clarification?.spokenQuestion ?? null,
      noneCount: session.noneCount,
      turn: session.turn,
      rejectedSetsCopy: session.rejectedSets,
      clarifications: session.clarifications,
      frame: cloneIntentFrame(session.frame),
    };
    this.currentNode = node;
    session.displayPrompt = node.displayPrompt;
    this.events.onView(this.viewFor(node));
  }

  private async generateNode(input: DecoderInput, mode: "predict" | "clarify"): Promise<PromptNode> {
    const session = this.requireSession();
    if (!session) throw new Error("no session");
    const provider = this.providerForInput(input);
    const started = now();
    console.info(`[decoder] ${JSON.stringify({ event: "request_started", provider: provider.name, mode, turn: input.turn, vision: provider === this.visionProvider })}`);
    const response = await this.coordinator.run(
      mode,
      (options) => provider.generateCandidates(input, options),
      {},
    );
    const durationMs = now() - started;
    console.info(`[decoder] ${JSON.stringify({ event: "request_completed", provider: provider.name, mode, turn: input.turn, durationMs: Math.round(durationMs), candidates: response.candidates.length, vision: provider === this.visionProvider })}`);
    if (!mode || mode === "predict") {
      // Unresolved slots are model observations about what remains unknown;
      // they never replace an accepted field in the frame.
      session.frame.unresolvedSlots = (response.unresolvedSlots ?? response.openSlots).map((slot) => ({ ...slot, required: true }));
      session.frame.state = deriveFrameState(session.frame);
    }
    const validationStarted = now();
    const prepared = await this.prepareDisplayOptions(input, response);
    console.info(`[decoder] ${JSON.stringify({ event: "validation_completed", provider: this.providerForInput(input).name, mode, durationMs: Math.round(now() - validationStarted), valid: prepared.errors.length === 0 })}`);
    // Invalid output is an explicit failure. A repair request would hide the
    // provider defect and add a second network turn to a selection.
    if (prepared.errors.length > 0) {
      console.error(`[decoder] ${JSON.stringify({ event: "invalid_candidates", provider: this.providerForInput(input).name, errors: prepared.errors })}`);
      throw new Error(`Decoder returned invalid candidates: ${prepared.errors.join("; ")}`);
    }
    const { response: stabilizedResponse, display: options } = prepared;
    return {
      nodeId: randomUUID(),
      displayPrompt: stabilizedResponse.normalizedPrompt,
      explicitEvidence: session.evidence,
      rawCandidates: stabilizedResponse.candidates,
      displayedCandidates: options,
      rejectedCandidateIds: [],
      mode: stabilizedResponse.mode === "clarify" ? "clarify" : mode,
      clarificationQuestion: stabilizedResponse.clarification?.spokenQuestion ?? null,
      noneCount: session.noneCount,
      turn: session.turn,
      rejectedSetsCopy: session.rejectedSets,
      clarifications: session.clarifications,
      frame: cloneIntentFrame(session.frame),
    };
  }

  private async prepareDisplayOptions(input: DecoderInput, response: DecoderResponse): Promise<PreparedDisplayOptions> {
    const stabilizedResponse = this.stabilizeResponse(input, response);
    if (stabilizedResponse.mode === "clarify" && stabilizedResponse.clarification) {
      return {
        response: stabilizedResponse,
        display: stabilizedResponse.clarification.answers.map((answer, index) => ({
          id: `clr_${index}_${input.turn}`,
          quadrant: QUADRANT_ORDER[index],
          label: answer.label,
          resultingPrompt: stabilizedResponse.normalizedPrompt || input.displayPrompt,
          type: "continuation",
          semanticGroup: "clarify_answer",
          resultingEvidence: answer.resultingEvidence,
        })),
        errors: [],
      };
    }

    const report = this.validator.validateSemantic(input, stabilizedResponse, input.intentFrame ?? createIntentFrame());
    if (!report.valid) return { response: stabilizedResponse, display: [], errors: report.errors };

    const pool = report.candidates;
    let display = this.ranker.rank({
      candidates: pool,
      frame: input.intentFrame ?? createIntentFrame(),
      decoderInput: input,
      context: this.contextLedger.references(),
      resolver: this.targetResolver,
    }).display;
    // The host owns the final action affordance. Once accepted evidence is
    // complete, the user always gets a stable RUN THIS card even when the
    // decoder returns only continuations. This keeps execution deterministic
    // and prevents a provider from having to invent a terminal candidate.
    const compiled = compileTask(this.session?.frame ?? input.intentFrame ?? createIntentFrame());
    const hasTerminal = display.some((option) => option.type === "do_that" || option.type === "full_prompt");
    if (compiled.ready && !hasTerminal) {
      const runOption: DisplayOption = {
        id: `run_current_task_${input.turn}`,
        quadrant: "D",
        label: "RUN THIS",
        resultingPrompt: compiled.prompt,
        type: "do_that",
        semanticGroup: "host_run",
      };
      const coverageIndex = display.findIndex((option) => option.semanticGroup === "coverage");
      if (coverageIndex >= 0) display[coverageIndex] = { ...runOption, quadrant: QUADRANT_ORDER[coverageIndex] };
      else if (display.length > 0) display[display.length - 1] = { ...runOption, quadrant: QUADRANT_ORDER[display.length - 1] };
      else display = [runOption];
    }
    const errors = display.length === 4
      ? []
      : [`Decoder returned ${display.length} usable candidates after semantic ranking.`];
    return { response: stabilizedResponse, display, errors };
  }

  private isClarifyAnswer(option: DisplayOption): boolean {
    return option.semanticGroup === "clarify_answer";
  }

  private viewFor(node: PromptNode): PromptViewState {
    const session = this.session;
    const options = node.displayedCandidates.map((o) => ({
      ...o,
      cardId: o.cardId ?? o.id,
      operation: o.operation ?? o.continuation,
      // Only references need a freshness guard. Background Accessibility
      // observations must not make ordinary semantic cards stale.
      contextRevision: o.referenceId && this.context?.access === "active" ? this.context.revision : undefined,
    }));
    const mode = node.mode === "clarify" && node.clarificationQuestion ? "clarify" : "predict";
    const speculativeReady: Partial<Record<QuadrantId | "MORE", boolean>> = {};
    const scope = this.scopeKey(node);
    for (const q of QUADRANT_ORDER) speculativeReady[q] = this.cache.has(scope, q);
    speculativeReady.MORE = this.cache.has(scope, "MORE");
    return {
      sessionId: session?.sessionId ?? "",
      displayPrompt: node.displayPrompt,
      options,
      canBack: this.history.depth > 0,
      canMore: true,
      canExit: true,
      mode,
      clarificationQuestion: node.clarificationQuestion ?? undefined,
      speculativeReady,
      cardSetId: node.nodeId,
      revision: node.turn,
      contextLabel: this.context?.access === "active"
        ? (this.context.focusedElement?.label ?? this.context.references.find((reference) => reference.kind === "document")?.label ?? this.context.window?.windowTitle)
        : undefined,
      contextRevision: this.context?.access === "active" ? this.context.revision : undefined,
    };
  }

  private currentView(): PromptViewState {
    if (!this.currentNode) return this.rootView();
    return this.viewFor(this.currentNode);
  }

  private rootView(): PromptViewState {
    const options = this.rootOptions();
    return {
      sessionId: this.session?.sessionId ?? "",
      displayPrompt: "I want you to…",
      options,
      canBack: this.history.depth > 0,
      canMore: true,
      canExit: true,
      mode: "predict",
      speculativeReady: {},
    };
  }

  private rootNode(): PromptNode {
    const session = this.requireSession();
    if (!session) throw new Error("no session");
    return {
      nodeId: randomUUID(),
      displayPrompt: session.displayPrompt,
      explicitEvidence: [],
      rawCandidates: [],
      displayedCandidates: this.rootOptions(),
      rejectedCandidateIds: [],
      mode: "predict",
      clarificationQuestion: null,
      noneCount: 0,
      turn: 0,
      rejectedSetsCopy: [],
      clarifications: [],
      frame: cloneIntentFrame(session.frame),
    };
  }

  private contextPredictionNode(options: DisplayOption[]): PromptNode {
    const session = this.requireSession();
    if (!session) throw new Error("no session");
    return {
      nodeId: randomUUID(),
      displayPrompt: session.displayPrompt,
      explicitEvidence: [],
      rawCandidates: options.map((option) => ({
        id: option.id,
        label: option.label,
        continuation: option.continuation ?? "",
        resultingPrompt: option.resultingPrompt,
        modelScore: 0,
        type: option.type,
        semanticGroup: option.semanticGroup,
        estimatedLikelihood: 0,
        introducesNewMeaning: false,
        intentPatch: option.intentPatch,
        referenceId: option.referenceId,
        referenceRevision: option.referenceRevision,
      })),
      displayedCandidates: options,
      rejectedCandidateIds: [],
      mode: "predict",
      clarificationQuestion: null,
      noneCount: session.noneCount,
      turn: session.turn,
      rejectedSetsCopy: session.rejectedSets,
      clarifications: session.clarifications,
      frame: cloneIntentFrame(session.frame),
    };
  }

  private maybeShowContextPredictions(context: ContextSnapshot | null): void {
    const session = this.session;
    if (!session || this.contextPredictionShownSessionId === session.sessionId || session.turn !== 0 || session.evidence.length > 0 || this.task) return;
    if (this.currentNode && this.currentNode.displayedCandidates.some((option) => option.semanticGroup !== "root_action")) return;
    const options = contextPredictionOptions(context);
    if (!options) return;
    this.contextPredictionShownSessionId = session.sessionId;
    const node = this.contextPredictionNode(options);
    this.currentNode = node;
    this.events.onView(this.viewFor(node));
  }

  private taskActionNode(): PromptNode | null {
    const session = this.requireSession();
    const task = this.task;
    if (!session || !task?.goal || this.settings.taskAwareCards !== true) return null;
    const goal = task.goal.replace(/\s+/g, " ").trim().slice(0, 220);
    const hasArtifact = task.artifacts.length > 0;
    const reviewOperation = hasArtifact
      ? JSON.stringify({ kind: "inspect_artifact", artifactId: task.artifacts[task.artifacts.length - 1].artifactId })
      : JSON.stringify({ kind: "task_action", action: "review" });
    const options: DisplayOption[] = [
      {
        id: "task_continue",
        quadrant: "A",
        label: "CONTINUE CURRENT TASK",
        resultingPrompt: `${goal} — continue the current task…`,
        type: "continuation",
        semanticGroup: "task_action",
        continuation: "task_action=continue",
        operation: JSON.stringify({ kind: "invoke_capability", capabilityId: "computer-use", referenceIds: [], arguments: { task_action: "continue" } }),
      },
      {
        id: "task_review",
        quadrant: "B",
        label: "REVIEW CURRENT RESULT",
        resultingPrompt: `${goal} — review the current result…`,
        type: "continuation",
        semanticGroup: "task_action",
        continuation: "task_action=review",
        operation: reviewOperation,
      },
      {
        id: "task_change",
        quadrant: "C",
        label: "CHANGE A DETAIL",
        resultingPrompt: `${goal} — change a detail…`,
        type: "continuation",
        semanticGroup: "task_action",
        continuation: "task_action=change",
        operation: JSON.stringify({ kind: "task_action", action: "change" }),
      },
      {
        id: "task_new",
        quadrant: "D",
        label: "START A NEW TASK",
        resultingPrompt: "I want you to…",
        type: "continuation",
        semanticGroup: "task_action",
        continuation: "task_action=new",
        operation: JSON.stringify({ kind: "task_action", action: "new" }),
      },
    ];
    return {
      nodeId: randomUUID(),
      displayPrompt: `Active task: ${goal}…`,
      explicitEvidence: [],
      rawCandidates: [],
      displayedCandidates: options,
      rejectedCandidateIds: [],
      mode: "predict",
      clarificationQuestion: null,
      noneCount: 0,
      turn: 0,
      rejectedSetsCopy: [],
      clarifications: [],
    };
  }

  private rootOptions(): DisplayOption[] {
    return QUADRANT_ORDER.map((quadrant, index) => ({
      id: `root_${quadrant}`,
      quadrant,
      label: GENERIC_ROOT[index].label,
      resultingPrompt: GENERIC_ROOT[index].prompt,
      type: "continuation",
      semanticGroup: "root_action",
      continuation: GENERIC_ROOT[index].continuation,
    }));
  }

  private buildInput(): DecoderInput {
    const session = this.requireSession();
    if (!session) throw new Error("no session");
    const context = this.context?.access === "active" ? this.context : null;
    return {
      displayPrompt: session.displayPrompt,
      explicitSemanticEvidence: session.evidence.map((e) => e.semanticFragment),
      rejectedSets: session.rejectedSets,
      historyDepth: this.history.depth,
      userLexicon: this.lexiconForInput(),
      optionalContext: {
        activeApp: context?.window?.appName ?? null,
        activeAppUrl: context?.window?.url ?? null,
        surfaceType: context?.surfaceType ?? null,
        visibleReferent: context?.window?.windowTitle ?? null,
        gazeTargetDescription: describeGazeAnchor(context?.attentionAnchor ?? null),
        capturedImageDataUrl: context?.capturedImageDataUrl ?? null,
        contextState: this.context?.access ?? "disabled",
        contextSessionId: this.context?.sessionId ?? null,
        contextRevision: this.context?.revision ?? 0,
        contextSources: this.context?.sources ?? [],
        contextReferences: context?.references ?? [],
        focusedElement: context?.focusedElement ?? null,
        selectedText: context?.selectedText ?? null,
        visibleText: context?.visibleText ?? null,
        contextLedger: this.contextLedger.digest(),
      },
      consecutiveNoneCount: session.noneCount,
      clarificationAnswers: session.clarifications,
      turn: session.turn,
      task: this.settings.taskAwareCards === true && this.task ? structuredClone(this.task) : null,
      intentFrame: cloneIntentFrame(session.frame),
    };
  }

  private stabilizeResponse(input: DecoderInput, response: DecoderResponse): DecoderResponse {
    const frame = input.intentFrame ?? createIntentFrame();
    return {
      ...response,
      // Accepted typed state is authoritative. Decoder wording is display
      // metadata and cannot rewrite or remove accumulated intent.
      normalizedPrompt: frame.state === "forming" && frame.authoredFragments.length === 0
        ? response.normalizedPrompt
        : compileTask(frame).prompt,
      unresolvedSlots: response.unresolvedSlots ?? response.openSlots,
    };
  }

  private scopeKey(node: PromptNode): string {
    return SpeculationCache.key([
      this.session?.sessionId ?? "",
      node.turn,
      node.displayPrompt,
      this.context?.revision ?? 0,
      ...node.displayedCandidates.map((o) => o.id),
    ]);
  }

  private speculateOne(scope: string, slot: string, build: () => DecoderInput): Promise<void> {
    const key = `${scope}::${slot}`;
    if (this.cache.has(scope, slot)) return Promise.resolve();
    const existing = this.speculationInFlight.get(key);
    if (existing) return existing;
    let promise: Promise<void> = Promise.resolve();
    let providerName = this.provider.name;
    promise = (async () => {
      const prefetchStarted = now();
      try {
        const input = build();
        const provider = this.providerForInput(input);
        providerName = provider.name;
        console.info(`[decoder] ${JSON.stringify({ event: "prefetch_started", provider: provider.name, slot, turn: input.turn, vision: provider === this.visionProvider })}`);
        const started = now();
        const response = await this.coordinator.run(
          "prefetch",
          (options) => provider.generateCandidates(input, options),
          { speculative: true },
        );
        const durationMs = now() - started;
        console.info(`[decoder] ${JSON.stringify({ event: "prefetch_request_completed", provider: provider.name, slot, turn: input.turn, durationMs: Math.round(durationMs), candidates: response.candidates.length, vision: provider === this.visionProvider })}`);
        const validationStarted = now();
        const prepared = await this.prepareDisplayOptions(input, response);
        console.info(`[decoder] ${JSON.stringify({ event: "prefetch_validation_completed", provider: provider.name, slot, durationMs: Math.round(now() - validationStarted), valid: prepared.errors.length === 0 })}`);
        if (prepared.errors.length > 0) {
          console.warn(`[decoder] ${JSON.stringify({ event: "prefetch_invalid_candidates", provider: provider.name, slot, errors: prepared.errors })}`);
          return;
        }
        const { response: preparedResponse, display } = prepared;
        this.cache.set(scope, slot, {
          response: { ...preparedResponse, normalizedPrompt: input.displayPrompt },
          display,
          createdAt: Date.now(),
          forKey: scope,
        });
        console.info(`[decoder] ${JSON.stringify({ event: "prefetch_ready", provider: provider.name, slot, durationMs: Math.round(now() - prefetchStarted), vision: provider === this.visionProvider })}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[decoder] ${JSON.stringify({ event: "prefetch_failed", provider: providerName, slot, message })}`);
      } finally {
        if (this.speculationInFlight.get(key) === promise) this.speculationInFlight.delete(key);
      }
    })();
    this.speculationInFlight.set(key, promise);
    return promise;
  }

  private inputAfterSelection(option: DisplayOption): DecoderInput {
    const session = this.requireSession();
    if (!session) throw new Error("no session");
    const frag = evidenceFragmentFor(option);
    const nextEvidence = [...session.evidence.map((e) => e.semanticFragment), frag];
    const nextFrame = frag === "something_else" || frag === "clarify_answer"
      ? cloneIntentFrame(session.frame)
      : option.intentPatch
        ? applyIntentPatch(session.frame, option.intentPatch, "user_selected", session.turn, option.label)
        : applySemanticFragment(session.frame, frag, "user_selected", session.turn, option.label);
    return {
      displayPrompt: compileTask(nextFrame).prompt || option.resultingPrompt,
      explicitSemanticEvidence: nextEvidence,
      rejectedSets: session.rejectedSets,
      historyDepth: this.history.depth + 1,
      userLexicon: this.lexiconForInput(),
      optionalContext: this.buildInput().optionalContext,
      consecutiveNoneCount: 0,
      clarificationAnswers: session.clarifications,
      turn: session.turn + (frag === "something_else" ? 0 : 1),
      task: this.settings.taskAwareCards === true && this.task ? structuredClone(this.task) : null,
      intentFrame: nextFrame,
    };
  }

  private lexiconForInput(): UserLexicon {
    const context = this.context?.access === "active" ? this.context : null;
    const query = [
      this.session?.displayPrompt ?? "",
      ...(this.session?.evidence.map((evidence) => evidence.semanticFragment) ?? []),
      context?.window?.appName ?? "",
      context?.window?.windowTitle ?? "",
      context?.selectedText ?? "",
    ].join(" ");
    return relevantLexicon(this.userLexicon, query);
  }

}

const GENERIC_ROOT = [
  { label: "FIND / LEARN…", prompt: "I want you to find…", fragment: "find", continuation: "action=find" },
  { label: "CREATE / CHANGE…", prompt: "I want you to create…", fragment: "create", continuation: "action=create" },
  { label: "OPEN / CONTROL…", prompt: "I want you to open…", fragment: "open", continuation: "action=open" },
  { label: "SEND / TELL…", prompt: "I want you to send…", fragment: "send", continuation: "action=send" },
];

function evidenceFragmentFor(option: DisplayOption): string {
  if (option.semanticGroup === "coverage") return "something_else";
  if (option.semanticGroup === "clarify_answer") return "clarify_answer";
  if (option.continuation) return option.continuation;
  if (option.intentPatch) return patchFragment(option.intentPatch);
  return option.semanticGroup ?? option.label;
}

function patchFragment(patch: IntentPatch): string {
  return Object.entries(patch).flatMap(([key, value]) => {
    const values = Array.isArray(value) ? value : [value];
    return values.filter((item) => item !== null).map((item) => `${key}=${typeof item === "object" ? item.value : String(item)}`);
  }).join(";");
}

function snapshotWithSession(node: PromptNode, session: SessionState): PromptNode {
  return {
    nodeId: node.nodeId,
    displayPrompt: node.displayPrompt,
    explicitEvidence: session.evidence.map((e) => ({ ...e })),
    rawCandidates: node.rawCandidates.map((r) => ({ ...r })),
    displayedCandidates: node.displayedCandidates.map((o) => ({ ...o })),
    rejectedCandidateIds: [...node.rejectedCandidateIds],
    mode: node.mode,
    clarificationQuestion: node.clarificationQuestion,
    noneCount: session.noneCount,
    turn: session.turn,
    rejectedSetsCopy: session.rejectedSets.map((r) => ({ labels: [...r.labels], turn: r.turn })),
    clarifications: session.clarifications.map((c) => ({ ...c })),
    frame: cloneIntentFrame(session.frame),
  };
}

function completePrompt(prompt: string): string {
  return prompt.replace(/…$/, "").trim();
}

function hasStructuredContinuation(fragment: string): boolean {
  return fragment.split(";").some((part) => part.includes("="));
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function describeGazeAnchor(anchor: ContextSnapshot["attentionAnchor"]): string | null {
  if (!anchor) return null;
  if (!anchor.insideActiveWindow) return "gaze is outside the approved active window";
  // Coarse wording prevents exact eye coordinates from becoming model input
  // while still telling a decoder whether the current attention is on the
  // approved application or on the surrounding overlay.
  return "gaze is inside the approved active window";
}
