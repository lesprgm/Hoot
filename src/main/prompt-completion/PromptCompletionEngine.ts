import { randomUUID } from "node:crypto";
import type {
  ContextSnapshot,
  DecoderInput,
  DecoderResponse,
  DisplayOption,
  ExplicitEvidence,
  Hint,
  IntentConfirmationState,
  PromptViewState,
  QuadrantId,
  UserLexicon,
} from "../../shared/types";
import { CandidateValidator } from "./CandidateValidator";
import { CandidateDiversifier } from "./CandidateDiversifier";
import { EmbeddingHub } from "./SemanticEmbeddings";
import { FixtureDecoderProvider } from "./FixtureDecoderProvider";
import { OpenAILunaProvider, type DecoderProvider } from "./CandidateGenerator";
import { GeminiFlashLiteProvider } from "./GeminiFlashLiteProvider";
import { OpenRouterDeepSeekProvider } from "./OpenRouterDeepSeekProvider";
import { FallbackDecoderProvider } from "./FallbackDecoderProvider";
import { PromptHistory, cloneNode, type PromptNode } from "./PromptHistory";
import { HintController } from "./HintController";
import { SpeculationCache, type SpeculativeState } from "./SpeculationCache";
import { composeSemanticPrompt, hasStructuredEvidence } from "./SemanticIntent";
import type { AppSettings } from "../../shared/types";

export interface EngineEvents {
  onView(view: PromptViewState): void;
  onHint(view: PromptViewState): void;
  onIntent(intentText: string): void;
  onBusy(busy: boolean): void;
  onOpenUrl?(url: string, spokenMessage: string): void;
}

export interface EngineMetrics {
  recordSelection(): void;
  recordNone(): void;
  recordClarifyAnswer(): void;
  recordHintChars(n: number): void;
  recordDecoderLatency(ms: number): void;
  recordPrefetchHit(): void;
  recordPrefetchMiss(): void;
  recordPrefetchedUiLatency(ms: number): void;
}

export const DEFAULT_LEXICON: UserLexicon = {
  people: ["Professor Lee"],
  places: [],
  apps: ["Spotify", "Calendar", "Mail", "YouTube"],
  recurringPhrases: [],
  customVocabulary: [],
};

export const CONFIRM_CHOICES = [
  { id: "yes" as const, label: "YES / DO IT" },
  { id: "change" as const, label: "CHANGE IT" },
  { id: "read" as const, label: "READ / REPEAT" },
  { id: "cancel" as const, label: "CANCEL" },
];

export type DecoderProviderKind = "openai" | "gemini" | "openrouter" | "fixture";

const QUADRANT_ORDER: QuadrantId[] = ["A", "B", "C", "D"];
const PUT_THAT_THERE_TARGET = {
  id: "RyBEUyEtxQo",
  title: "Put-that-there",
  url: "https://www.youtube.com/watch?v=RyBEUyEtxQo",
} as const;
const MEDIA_APP_PROFILES = [
  { name: "spotify", label: "SPOTIFY", playNoun: "SONG", playOperation: "play_song", collectionLabel: "PLAY A PLAYLIST / ALBUM", collectionOperation: "play_playlist", destinationPhrase: "there", titleKind: null, videoTarget: null },
  { name: "apple music", label: "APPLE MUSIC", playNoun: "SONG", playOperation: "play_song", collectionLabel: "PLAY A PLAYLIST / ALBUM", collectionOperation: "play_playlist", destinationPhrase: "there", titleKind: null, videoTarget: null },
  { name: "youtube music", label: "YOUTUBE MUSIC", playNoun: "SONG", playOperation: "play_song", collectionLabel: "PLAY A PLAYLIST / ALBUM", collectionOperation: "play_playlist", destinationPhrase: "there", titleKind: null, videoTarget: null },
  { name: "youtube", label: "YOUTUBE", playNoun: "VIDEO", playOperation: "play_video", collectionLabel: "PLAY A PLAYLIST", collectionOperation: "play_playlist", destinationPhrase: "there", titleKind: "video", videoTarget: PUT_THAT_THERE_TARGET },
  { name: "soundcloud", label: "SOUNDCLOUD", playNoun: "SONG", playOperation: "play_song", collectionLabel: "PLAY A PLAYLIST", collectionOperation: "play_playlist", destinationPhrase: "there", titleKind: null, videoTarget: null },
  { name: "tidal", label: "TIDAL", playNoun: "SONG", playOperation: "play_song", collectionLabel: "PLAY A PLAYLIST / ALBUM", collectionOperation: "play_playlist", destinationPhrase: "there", titleKind: null, videoTarget: null },
  { name: "pandora", label: "PANDORA", playNoun: "SONG", playOperation: "play_song", collectionLabel: "PLAY A STATION", collectionOperation: "play_station", destinationPhrase: "there", titleKind: null, videoTarget: null },
] as const;
const MEDIA_APP_NAMES = MEDIA_APP_PROFILES.map((profile) => profile.name);

interface SessionState {
  sessionId: string;
  turn: number;
  displayPrompt: string;
  evidence: ExplicitEvidence[];
  rejectedSets: Array<{ labels: string[]; turn: number }>;
  noneCount: number;
  clarifications: Array<{ question: string; answer: string }>;
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
  };
}

export class PromptCompletionEngine {
  private provider: DecoderProvider;
  private validator = new CandidateValidator();
  private diversifier: CandidateDiversifier;
  private history = new PromptHistory();
  private hints = new HintController();
  private cache = new SpeculationCache(true);
  private session: SessionState | null = null;
  private currentNode: PromptNode | null = null;
  private context: ContextSnapshot | null = null;
  private sessionGeneration = 0;
  private speculationInFlight = new Map<string, Promise<void>>();

  constructor(
    private events: EngineEvents,
    private metrics: EngineMetrics,
    private settings: AppSettings,
    acceptRealModel: boolean,
    private decoderProvider: DecoderProviderKind = "openai"
  ) {
    this.provider = this.createProvider(acceptRealModel);
    // Lexical vectors are deterministic and complete in-process. Loading
    // MiniLM on the first decoder turn adds model initialization latency to a
    // path that only needs coarse duplicate removal.
    this.diversifier = new CandidateDiversifier(new EmbeddingHub(false), settings.duplicateThreshold);
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
  }

  async warmup(): Promise<void> {
    await this.provider.warmup?.();
  }

  setRealModelEnabled(enabled: boolean): void {
    this.provider = this.createProvider(enabled);
    this.cache.invalidateAll();
    this.speculationInFlight.clear();
  }

  private createProvider(enabled: boolean): DecoderProvider {
    if (!enabled || this.decoderProvider === "fixture") return new FixtureDecoderProvider();
    if (this.decoderProvider === "gemini") return new GeminiFlashLiteProvider(this.settings.decoderModel);
    const primary = this.decoderProvider === "openrouter"
      ? new OpenRouterDeepSeekProvider(this.settings.decoderModel)
      : new OpenAILunaProvider(this.settings.decoderModel);
    return new FallbackDecoderProvider(primary, new GeminiFlashLiteProvider("gemini-3.5-flash"));
  }

  async start(context?: ContextSnapshot | null): Promise<PromptViewState> {
    this.sessionGeneration += 1;
    this.session = freshSession();
    this.context = context ?? null;
    this.history.clear();
    this.hints.clear();
    this.cache.invalidateAll();
    this.speculationInFlight.clear();
    // No semantic evidence exists at the root. A fixed, exhaustive set of broad
    // action families is faster and less biased than asking a model to guess a
    // specific person, app, or task from the user's lexicon.
    const node = this.rootNode();
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
    if (!node || !session || node.mode === "hint") return Promise.resolve();
    const option = node.displayedCandidates.find((candidate) => candidate.quadrant === quadrant);
    if (!option || option.type === "do_that" || option.type === "full_prompt" || this.isHintRequest(option)) {
      return Promise.resolve();
    }
    const scope = this.scopeKey(node);
    return this.speculateOne(scope, quadrant, () => this.inputAfterSelection(option));
  }

  async selectOption(quadrant: QuadrantId): Promise<PromptViewState> {
    const session = this.requireSession();
    const node = this.currentNode;
    if (!session || !node) return this.rootFallbackView();
    const option = node.displayedCandidates.find((o) => o.quadrant === quadrant);
    if (!option) return this.rootFallbackView();
    const scope = this.scopeKey(node);

    if (option.type === "do_that" || option.type === "full_prompt") {
      this.history.push(snapshotWithSession(node, session, this.hints.all));
      this.metrics.recordSelection();
      // `resultingPrompt` is the validated intent for both terminal option
      // types. The session display can lag semantic evidence such as a media
      // target that was reconstructed during deterministic refinement.
      const terminalEvidence = option.continuation
        ? [...session.evidence.map((e) => e.semanticFragment), option.continuation]
        : session.evidence.map((e) => e.semanticFragment);
      const text = option.type === "full_prompt" && !hasStructuredEvidence(option.continuation ?? "")
        ? completePrompt(option.resultingPrompt)
        : completePrompt(composeSemanticPrompt(terminalEvidence, option.resultingPrompt));
      this.events.onIntent(text);
      return this.currentView();
    }

    if (this.isHintRequest(option)) {
      this.history.push(snapshotWithSession(node, session, this.hints.all));
      return this.enterHint();
    }

    this.history.push(snapshotWithSession(node, session, this.hints.all));
    if (isMediaAppSelection(option)) {
      const appName = (option.continuation ?? "").replace(/^target=/i, "");
      if (appName.toLowerCase() === "youtube") {
        this.events.onOpenUrl?.(
          "https://www.youtube.com",
          "YouTube is open. Choose what you want to watch.",
        );
      }
    }
    this.commitEvidence(option);
    session.displayPrompt = composeSemanticPrompt(
      session.evidence.map((e) => e.semanticFragment),
      option.resultingPrompt,
    );
    session.turn += 1;
    this.hints.clear();
    this.metrics.recordSelection();

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
      this.metrics.recordPrefetchHit();
      const t0 = now();
      this.applySpeculative(cached);
      this.metrics.recordPrefetchedUiLatency(now() - t0);
      this.events.onBusy(false);
      return this.currentView();
    }
    this.metrics.recordPrefetchMiss();
    return this.generateFromCurrent();
  }

  async more(): Promise<PromptViewState> {
    const session = this.requireSession();
    const node = this.currentNode;
    if (!session || !node) return this.rootFallbackView();
    const scope = this.scopeKey(node);
    this.metrics.recordNone();
    session.noneCount += 1;
    session.rejectedSets.push({ labels: node.displayedCandidates.map((o) => o.label), turn: session.turn });

    if (session.noneCount >= 2) {
      return this.enterClarify();
    }

    const cached = this.cache.take(scope, "MORE");
    if (cached) {
      this.metrics.recordPrefetchHit();
      this.applySpeculative(cached);
      return this.currentView();
    }
    this.metrics.recordPrefetchMiss();

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
    this.hints.restore(previous.hints.map((h) => ({ ...h })));
    this.currentNode = cloneNode(previous);
    const view = this.viewFor(this.currentNode);
    this.events.onView(view);
    return view;
  }

  async beginHint(): Promise<PromptViewState> {
    return this.enterHint();
  }

  async updateHint(text: string): Promise<PromptViewState> {
    const session = this.requireSession();
    if (!session) return this.currentView();
    const generation = this.sessionGeneration;
    this.events.onBusy(true);
    try {
      const started = now();
      this.hints.update(text);
      if (text.length > 0) this.metrics.recordHintChars(text.length);
      const node = await this.generateNode(this.buildInput(), "hint");
      this.metrics.recordDecoderLatency(now() - started);
      if (generation !== this.sessionGeneration || this.session !== session) return this.currentView();
      this.currentNode = node;
      this.events.onHint(this.viewFor(node));
      return this.viewFor(node);
    } finally {
      if (generation === this.sessionGeneration) this.events.onBusy(false);
    }
  }

  async acceptHintCandidate(id: string): Promise<PromptViewState> {
    const node = this.currentNode;
    if (!node) return this.currentView();
    const option = node.displayedCandidates.find((o) => o.id === id);
    if (!option) return this.currentView();
    this.hints.clear();
    return this.selectOption(option.quadrant);
  }

  clearHint(): PromptViewState {
    this.hints.clear();
    if (this.currentNode) this.events.onView(this.viewFor(this.currentNode));
    return this.currentView();
  }

  async commitHintLiteral(text: string): Promise<void> {
    const session = this.requireSession();
    if (!session) return;
    this.metrics.recordHintChars(text.length);
    this.hints.clear();
    this.events.onIntent(text.trim());
  }

  async requestCompletion(): Promise<IntentConfirmationState> {
    const session = this.requireSession();
    const text = session
      ? completePrompt(composeSemanticPrompt(session.evidence.map((e) => e.semanticFragment), this.currentNode?.displayPrompt ?? session.displayPrompt))
      : "I want you to…";
    this.events.onIntent(text);
    return {
      sessionId: session?.sessionId ?? "",
      intentText: text,
      speakText: text,
      canBack: this.history.depth > 0,
      choices: CONFIRM_CHOICES,
    };
  }

  exit(): void {
    this.sessionGeneration += 1;
    this.session = null;
    this.currentNode = null;
    this.history.clear();
    this.hints.clear();
    this.cache.invalidateAll();
    this.speculationInFlight.clear();
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
      this.metrics.recordClarifyAnswer();
      session.noneCount = 0;
      return;
    }
    const fragment = evidenceFragmentFor(option);
    session.evidence.push({ kind: "option", text: option.label, semanticFragment: fragment, turn: session.turn });
  }

  private async generateFromCurrent(): Promise<PromptViewState> {
    const session = this.requireSession();
    if (!session) return this.currentView();
    const generation = this.sessionGeneration;
    const started = now();
    this.events.onBusy(true);
    try {
      const node = await this.generateNode(this.buildInput(), session.noneCount >= 2 ? "clarify" : "predict");
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

  private async enterClarify(): Promise<PromptViewState> {
    const session = this.session;
    if (!session) return this.rootFallbackView();
    const generation = this.sessionGeneration;
    this.events.onBusy(true);
    try {
      const started = now();
      const clarification = await this.provider.generateClarification(this.buildInput());
      this.metrics.recordDecoderLatency(now() - started);
      if (generation !== this.sessionGeneration || this.session !== session) return this.currentView();
      const options: DisplayOption[] = clarification.answers.map((a, i) => ({
        id: `clr_${i}_${session.turn}`,
        quadrant: QUADRANT_ORDER[i % 4],
        label: a.label,
        resultingPrompt: session.displayPrompt,
        type: "continuation",
        semanticGroup: "clarify_answer",
      }));
      const node: PromptNode = {
        nodeId: randomUUID(),
        displayPrompt: session.displayPrompt,
        explicitEvidence: session.evidence,
        hints: this.hints.all,
        rawCandidates: [],
        displayedCandidates: options,
        rejectedCandidateIds: [],
        mode: "clarify",
        clarificationQuestion: clarification.spokenQuestion,
        noneCount: session.noneCount,
        turn: session.turn,
        rejectedSetsCopy: session.rejectedSets,
        clarifications: session.clarifications,
      };
      this.currentNode = node;
      const view = this.viewFor(node);
      this.events.onView(view);
      return view;
    } finally {
      if (generation === this.sessionGeneration) this.events.onBusy(false);
    }
  }

  private enterHint(): PromptViewState {
    const session = this.session;
    const node = this.currentNode;
    if (!session || !node) return this.rootFallbackView();
    const hintNode: PromptNode = { ...node, nodeId: randomUUID(), mode: "hint" };
    this.currentNode = hintNode;
    const view = this.viewFor(hintNode);
    this.events.onHint(view);
    return view;
  }

  private applySpeculative(state: SpeculativeState): void {
    const session = this.session;
    if (!session) return;
    const node: PromptNode = {
      nodeId: randomUUID(),
      displayPrompt: state.response.normalizedPrompt || session.displayPrompt,
      explicitEvidence: session.evidence,
      hints: this.hints.all,
      rawCandidates: state.response.candidates,
      displayedCandidates: state.display,
      rejectedCandidateIds: [],
      mode: state.response.mode,
      clarificationQuestion: state.response.clarification?.spokenQuestion ?? null,
      noneCount: session.noneCount,
      turn: session.turn,
      rejectedSetsCopy: session.rejectedSets,
      clarifications: session.clarifications,
    };
    this.currentNode = node;
    session.displayPrompt = node.displayPrompt;
    this.events.onView(this.viewFor(node));
  }

  private async generateNode(input: DecoderInput, mode: "predict" | "clarify" | "hint"): Promise<PromptNode> {
    const session = this.requireSession();
    if (!session) throw new Error("no session");
    const deterministicMedia = mode === "predict" ? this.mediaRefinementResponse(input) : null;
    let response: DecoderResponse;
    if (deterministicMedia) {
      response = deterministicMedia;
    } else {
      const started = now();
      console.info(`[decoder] ${JSON.stringify({ event: "request_started", provider: this.provider.name, mode, turn: input.turn })}`);
      response = await this.provider.generateCandidates(input);
      const durationMs = now() - started;
      this.metrics.recordDecoderLatency(durationMs);
      console.info(`[decoder] ${JSON.stringify({ event: "request_completed", provider: this.provider.name, mode, turn: input.turn, durationMs: Math.round(durationMs), candidates: response.candidates.length })}`);
    }
    response = this.stabilizeResponse(input, response);
    const validationStarted = now();
    let report = this.validator.validate(input, response);
    console.info(`[decoder] ${JSON.stringify({ event: "validation_completed", provider: this.provider.name, mode, durationMs: Math.round(now() - validationStarted), valid: report.valid })}`);
    if (!report.valid && this.decoderProvider !== "gemini" && this.provider.repairCandidates) {
      try {
        const repairStarted = now();
        console.info(`[decoder] ${JSON.stringify({ event: "repair_started", provider: this.provider.name, mode, errors: report.errors })}`);
        response = await this.provider.repairCandidates(input, response, report.errors);
        const repairDurationMs = now() - repairStarted;
        this.metrics.recordDecoderLatency(repairDurationMs);
        report = this.validator.validate(input, response);
        console.info(`[decoder] ${JSON.stringify({ event: "repair_completed", provider: this.provider.name, mode, durationMs: Math.round(repairDurationMs), valid: report.valid })}`);
      } catch {
        // The validation error below reports the original invalid response.
      }
    }
    if (!report.valid) {
      console.error(`[decoder] ${JSON.stringify({ event: "invalid_candidates", provider: this.provider.name, errors: report.errors })}`);
      throw new Error(`Decoder returned invalid candidates: ${report.errors.join("; ")}`);
    }
    const pool = this.normalizeTerminalCandidates(report.candidates, input);
    const providerSuppliesDisplaySet = this.decoderProvider === "gemini" || this.decoderProvider === "openrouter";
    let options = providerSuppliesDisplaySet
      ? this.directOptions(pool)
      : (await this.diversifier.selectMany(pool, session.rejectedSets.flatMap((r) => r.labels))).options;
    if (!providerSuppliesDisplaySet && options.length < 4) {
      options = options.concat(this.genericFill(session.displayPrompt).slice(0, 4 - options.length));
    }
    if (options.length !== 4) {
      throw new Error(`Decoder returned ${options.length} usable candidates; exactly 4 are required.`);
    }
    return {
      nodeId: randomUUID(),
      displayPrompt: response.normalizedPrompt,
      explicitEvidence: session.evidence,
      hints: this.hints.all,
      rawCandidates: response.candidates,
      displayedCandidates: options,
      rejectedCandidateIds: [],
      mode,
      clarificationQuestion: response.clarification?.spokenQuestion ?? null,
      noneCount: session.noneCount,
      turn: session.turn,
      rejectedSetsCopy: session.rejectedSets,
      clarifications: session.clarifications,
    };
  }

  /** Deterministic coverage for offline fixture and legacy OpenAI flows only. */
  private genericFill(basePrompt: string): DisplayOption[] {
    return GENERIC_ROOT.map((g, i) => ({
      id: `fill_${i}`,
      quadrant: QUADRANT_ORDER[i % 4],
      label: g.label,
      resultingPrompt: `${basePrompt.trim().replace(/…$/, "")} ${g.fragment}…`,
      type: "continuation",
      semanticGroup: `fallback_${i}`,
      continuation: g.continuation,
    }));
  }

  private isHintRequest(option: DisplayOption): boolean {
    return option.semanticGroup === "hint" || option.label.toUpperCase().startsWith("SPELL");
  }

  private isClarifyAnswer(option: DisplayOption): boolean {
    return option.semanticGroup === "clarify_answer";
  }

  private viewFor(node: PromptNode): PromptViewState {
    const session = this.session;
    const options = node.displayedCandidates.map((o) => ({ ...o }));
    const mode = node.mode === "hint" ? "hint" : node.mode === "clarify" && node.clarificationQuestion ? "clarify" : "predict";
    const speculativeReady: Partial<Record<QuadrantId | "MORE", boolean>> = {};
    const scope = this.scopeKey(node);
    for (const q of QUADRANT_ORDER) speculativeReady[q] = this.cache.has(scope, q);
    speculativeReady.MORE = this.cache.has(scope, "MORE");
    return {
      sessionId: session?.sessionId ?? "",
      displayPrompt: node.displayPrompt,
      options,
      canBack: this.history.depth > 0,
      canMore: node.mode !== "hint",
      canHint: true,
      canExit: true,
      mode,
      clarificationQuestion: node.clarificationQuestion ?? undefined,
      speculativeReady,
      hintText: this.hints.text.length > 0 ? this.hints.text : undefined,
    };
  }

  private currentView(): PromptViewState {
    if (!this.currentNode) return this.rootFallbackView();
    return this.viewFor(this.currentNode);
  }

  private rootFallbackView(): PromptViewState {
    const options = this.rootOptions();
    return {
      sessionId: this.session?.sessionId ?? "",
      displayPrompt: "I want you to…",
      options,
      canBack: this.history.depth > 0,
      canMore: true,
      canHint: true,
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
      hints: [],
      rawCandidates: [],
      displayedCandidates: this.rootOptions(),
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

  private directOptions(candidates: DecoderResponse["candidates"]): DisplayOption[] {
    return candidates.slice(0, 4).map((candidate, index) => ({
      id: candidate.id,
      quadrant: QUADRANT_ORDER[index],
      label: candidate.label,
      resultingPrompt: candidate.resultingPrompt,
      type: candidate.type,
      semanticGroup: candidate.semanticGroup,
      continuation: candidate.continuation,
    }));
  }

  /**
   * Keep an app-only media target in refinement until the user has selected
   * the app itself. This protects the explicit-selection contract when a
   * decoder marks "open Spotify" as executable too early.
   */
  private normalizeTerminalCandidates(
    candidates: DecoderResponse["candidates"],
    input: DecoderInput,
  ): DecoderResponse["candidates"] {
    const inputText = `${input.displayPrompt} ${input.explicitSemanticEvidence.join(" ")}`.toLowerCase();
    const mediaTargetAlreadySelected = MEDIA_APP_NAMES.some((name) => inputText.includes(name));
    if (mediaTargetAlreadySelected) return candidates;

    return candidates.map((candidate) => {
      if (candidate.type !== "do_that" && candidate.type !== "full_prompt") return candidate;
      const candidateText = `${candidate.label} ${candidate.resultingPrompt}`.toLowerCase();
      const mediaApp = MEDIA_APP_NAMES.find((name) => candidateText.includes(name));
      if (!mediaApp || !/\b(open|launch|use|control)\b/.test(candidateText)) return candidate;
      if (/\b(song|playlist|album|artist|podcast|episode|station|radio|search|browse|queue|track)\b/.test(candidateText)) return candidate;
      return {
        ...candidate,
        type: "continuation" as const,
        semanticGroup: "media_app_target",
        continuation: candidate.continuation || `target=${mediaApp}`,
      };
    });
  }

  private mediaRefinementResponse(input: DecoderInput): DecoderResponse | null {
    const candidates = this.mediaRefinementCandidates(input);
    if (!candidates) return null;
    const normalizedPrompt = candidates[0]?.resultingPrompt ?? input.displayPrompt;
    return {
      mode: "predict",
      normalizedPrompt: withEllipsis(normalizedPrompt),
      promptIsExecutable: false,
      openSlots: [{ name: "media_operation", description: "what to do in the media service" }],
      candidates,
    };
  }

  private mediaRefinementCandidates(input: DecoderInput): DecoderResponse["candidates"] | null {
    const inputText = `${input.displayPrompt} ${input.explicitSemanticEvidence.join(" ")}`.toLowerCase();
    const profile = MEDIA_APP_PROFILES.find((candidate) => inputText.includes(candidate.name));
    if (!profile || !/\b(open|launch|use|control|play|listen)\b/.test(inputText)) return null;
    if (/\b(song|playlist|album|artist|podcast|episode|station|radio|track|search|browse|queue|shuffle|pause|resume)\b/.test(inputText)) return null;

    const visiblePrompt = input.displayPrompt.replace(/…$/, "").trim();
    // A selected app can exist only in semantic evidence when the previous
    // decoder returned a shortened display prompt. Keep that accepted target
    // visible in every deterministic refinement candidate.
    const basePrompt = visiblePrompt.toLowerCase().includes(profile.name)
      ? visiblePrompt
      : `${visiblePrompt} ${profile.label}`;
    const appLabel = profile.label;
    const videoTarget = profile.titleKind === "video"
      ? resolveMediaVideoTarget(input, profile.videoTarget)
      : null;
    const videoTitle = videoTarget?.title ?? null;
    const playLabel = videoTitle ? `PLAY “${videoTitle}”` : `PLAY A ${profile.playNoun}`;
    const playPrompt = videoTitle
      ? `${basePrompt} and play “${videoTitle}” ${profile.destinationPhrase}…`
      : `${basePrompt} and play a ${profile.playNoun.toLowerCase()} ${profile.destinationPhrase}…`;
    const playContinuation = videoTitle
      ? `operation=${profile.playOperation};title=${videoTitle}${videoTarget?.url ? `;url=${videoTarget.url}` : ""}`
      : `operation=${profile.playOperation}`;
    const make = (
      id: string,
      label: string,
      continuation: string,
      resultingPrompt: string,
      type: "continuation" | "do_that",
      semanticGroup: string,
      modelScore: number,
    ): DecoderResponse["candidates"][number] => ({
      id,
      label,
      continuation,
      resultingPrompt,
      modelScore,
      type,
      semanticGroup,
      estimatedLikelihood: modelScore,
      introducesNewMeaning: false,
    });

    if (profile.name === "youtube") {
      return [
        make("youtube_random_homepage", "RANDOM FROM HOMEPAGE", "operation=random_video;source=homepage", `${basePrompt} and play a random video from the homepage…`, "continuation", "media_random_homepage", 0.94),
        make("youtube_random_first_page", "RANDOM FROM FIRST PAGE", "operation=random_video;source=first_page", `${basePrompt} and play a random video from the first page…`, "continuation", "media_random_first_page", 0.9),
        make("youtube_specific_video", "PICK SOMETHING SPECIFIC", "operation=play_video", `${basePrompt} and play a specific video…`, "continuation", "media_specific_video", 0.86),
        make("youtube_search", "SEARCH / BROWSE YOUTUBE", "operation=search", `${basePrompt} and search or browse there…`, "continuation", "media_search", 0.82),
      ];
    }

    return [
      make(`media_open_${profile.name}`, `JUST OPEN ${appLabel}`, "", basePrompt, "do_that", "media_open", 0.98),
      make(`media_play_${profile.name}`, playLabel, playContinuation, playPrompt, "continuation", "media_play", 0.94),
      make(`media_collection_${profile.name}`, profile.collectionLabel, `operation=${profile.collectionOperation}`, `${basePrompt} and ${profile.collectionLabel.toLowerCase()} ${profile.destinationPhrase}…`, "continuation", "media_collection", 0.9),
      make(`media_search_${profile.name}`, `SEARCH / BROWSE ${appLabel}`, "operation=search", `${basePrompt} and search or browse ${profile.destinationPhrase}…`, "continuation", "media_search", 0.86),
    ];
  }

  private buildInput(): DecoderInput {
    const session = this.requireSession();
    if (!session) throw new Error("no session");
    return {
      displayPrompt: session.displayPrompt,
      explicitSemanticEvidence: session.evidence.map((e) => e.semanticFragment),
      hints: this.hints.all.map((h) => ({ text: h.text, type: h.type })),
      rejectedSets: session.rejectedSets,
      historyDepth: this.history.depth,
      userLexicon: DEFAULT_LEXICON,
      optionalContext: {
        activeApp: this.context?.window?.appName ?? null,
        activeAppUrl: this.context?.window?.url ?? null,
        surfaceType: this.context?.surfaceType ?? null,
        visibleReferent: this.context?.window?.windowTitle ?? null,
        gazeTargetDescription: null,
        capturedImageDataUrl: this.context?.capturedImageDataUrl ?? null,
      },
      consecutiveNoneCount: session.noneCount,
      clarificationAnswers: session.clarifications,
      turn: session.turn,
    };
  }

  private stabilizeResponse(input: DecoderInput, response: DecoderResponse): DecoderResponse {
    return {
      ...response,
      // Accepted key=value evidence is authoritative. The decoder proposes
      // future deltas but cannot rewrite or remove the accumulated intent.
      normalizedPrompt: composeSemanticPrompt(input.explicitSemanticEvidence, response.normalizedPrompt),
    };
  }

  private scopeKey(node: PromptNode): string {
    return SpeculationCache.key([
      this.session?.sessionId ?? "",
      node.turn,
      node.displayPrompt,
      ...node.displayedCandidates.map((o) => o.id),
    ]);
  }

  private speculateOne(scope: string, slot: string, build: () => DecoderInput): Promise<void> {
    const key = `${scope}::${slot}`;
    if (this.cache.has(scope, slot)) return Promise.resolve();
    const existing = this.speculationInFlight.get(key);
    if (existing) return existing;
    let promise: Promise<void> = Promise.resolve();
    promise = (async () => {
      const prefetchStarted = now();
      try {
        const input = build();
        console.info(`[decoder] ${JSON.stringify({ event: "prefetch_started", provider: this.provider.name, slot, turn: input.turn })}`);
        const deterministicMedia = this.mediaRefinementResponse(input);
        let response: DecoderResponse;
        if (deterministicMedia) {
          response = deterministicMedia;
        } else {
          const started = now();
          response = await this.provider.generateCandidates(input);
          const durationMs = now() - started;
          this.metrics.recordDecoderLatency(durationMs);
          console.info(`[decoder] ${JSON.stringify({ event: "prefetch_request_completed", provider: this.provider.name, slot, turn: input.turn, durationMs: Math.round(durationMs), candidates: response.candidates.length })}`);
        }
        response = this.stabilizeResponse(input, response);
        const validationStarted = now();
        let report = this.validator.validate(input, response);
        console.info(`[decoder] ${JSON.stringify({ event: "prefetch_validation_completed", provider: this.provider.name, slot, durationMs: Math.round(now() - validationStarted), valid: report.valid })}`);
        if (!report.valid && this.provider.repairCandidates) {
          try {
            const repairStarted = now();
            response = await this.provider.repairCandidates(input, response, report.errors);
            this.metrics.recordDecoderLatency(now() - repairStarted);
            report = this.validator.validate(input, response);
          } catch {
            return;
          }
        }
        if (!report.valid) {
          console.warn(`[decoder] ${JSON.stringify({ event: "prefetch_invalid_candidates", provider: this.provider.name, slot, errors: report.errors })}`);
          return;
        }
        if (response.mode === "clarify" && response.clarification) {
          const options: DisplayOption[] = response.clarification.answers.map((a, i) => ({
            id: `spec_clr_${i}`,
            quadrant: QUADRANT_ORDER[i % 4],
            label: a.label,
            resultingPrompt: input.displayPrompt,
            type: "continuation",
            semanticGroup: "clarify_answer",
          }));
          this.cache.set(scope, slot, {
            response,
            display: options,
            createdAt: Date.now(),
            forKey: scope,
          });
          return;
        }
        const pool = this.normalizeTerminalCandidates(report.candidates, input).slice(0, 4);
        const providerSuppliesDisplaySet = this.decoderProvider === "gemini" || this.decoderProvider === "openrouter";
        const diversified = providerSuppliesDisplaySet
          ? null
          : await this.diversifier.selectMany(pool, input.rejectedSets.flatMap((r) => r.labels));
        let display = providerSuppliesDisplaySet ? this.directOptions(pool) : diversified!.options;
        if (!providerSuppliesDisplaySet && display.length < 4) {
          display = display.concat(this.genericFill(input.displayPrompt).slice(0, 4 - display.length));
        }
        this.cache.set(scope, slot, {
          response: { ...response, normalizedPrompt: input.displayPrompt },
          display,
          createdAt: Date.now(),
          forKey: scope,
        });
        console.info(`[decoder] ${JSON.stringify({ event: "prefetch_ready", provider: this.provider.name, slot, durationMs: Math.round(now() - prefetchStarted) })}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[decoder] ${JSON.stringify({ event: "prefetch_failed", provider: this.provider.name, slot, message })}`);
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
    const nextHints = this.hints.all.map((h) => ({ text: h.text, type: h.type }));
    if (frag !== "something_else") nextHints.length = 0;
    return {
      displayPrompt: composeSemanticPrompt(nextEvidence, option.resultingPrompt),
      explicitSemanticEvidence: nextEvidence,
      hints: nextHints,
      rejectedSets: session.rejectedSets,
      historyDepth: this.history.depth + 1,
      userLexicon: DEFAULT_LEXICON,
      optionalContext: this.buildInput().optionalContext,
      consecutiveNoneCount: 0,
      clarificationAnswers: session.clarifications,
      turn: session.turn + (frag === "something_else" ? 0 : 1),
    };
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
  return option.semanticGroup ?? option.label;
}

function isMediaAppSelection(option: DisplayOption): boolean {
  return option.semanticGroup === "media_app_target" || /^target=(?:spotify|apple music|youtube music|youtube|soundcloud|tidal|pandora)$/i.test(option.continuation ?? "");
}

function snapshotWithSession(node: PromptNode, session: SessionState, hints: Hint[]): PromptNode {
  return {
    nodeId: node.nodeId,
    displayPrompt: node.displayPrompt,
    explicitEvidence: session.evidence.map((e) => ({ ...e })),
    hints: hints.map((h) => ({ ...h })),
    rawCandidates: node.rawCandidates.map((r) => ({ ...r })),
    displayedCandidates: node.displayedCandidates.map((o) => ({ ...o })),
    rejectedCandidateIds: [...node.rejectedCandidateIds],
    mode: node.mode,
    clarificationQuestion: node.clarificationQuestion,
    noneCount: session.noneCount,
    turn: session.turn,
    rejectedSetsCopy: session.rejectedSets.map((r) => ({ labels: [...r.labels], turn: r.turn })),
    clarifications: session.clarifications.map((c) => ({ ...c })),
  };
}

function completePrompt(prompt: string): string {
  return prompt.replace(/…$/, "").trim();
}

function withEllipsis(prompt: string): string {
  const trimmed = prompt.trim();
  return trimmed.endsWith("…") ? trimmed : `${trimmed}…`;
}

function extractMediaTitle(windowTitle: string | null): string | null {
  if (!windowTitle) return null;
  const compact = windowTitle.replace(/\s+/g, " ").trim();
  const withoutServiceSuffix = compact
    .replace(/\s*(?:[-–—|]\s*)?youtube(?:\s+music)?(?:\s*[-–—|]\s*(?:google chrome|safari|arc|firefox|microsoft edge))?\s*$/i, "")
    .trim();
  if (!withoutServiceSuffix || /^(?:youtube(?:\s+music)?|google chrome|safari|arc|firefox|microsoft edge)$/i.test(withoutServiceSuffix)) return null;
  return withoutServiceSuffix.length > 64 ? `${withoutServiceSuffix.slice(0, 61).trimEnd()}…` : withoutServiceSuffix;
}

function resolveMediaVideoTarget(
  input: DecoderInput,
  knownTarget: { id: string; title: string; url: string } | null,
): { title: string; url: string | null } | null {
  const title = extractMediaTitle(input.optionalContext.visibleReferent);
  const activeUrl = input.optionalContext.activeAppUrl?.trim() || null;
  if (title) return { title, url: activeUrl && /(?:youtube\.com|youtu\.be)/i.test(activeUrl) ? activeUrl : null };
  const activeYouTubeVideo = activeUrl && /(?:youtube\.com\/watch|youtu\.be\/)/i.test(activeUrl);
  if (knownTarget && (!activeYouTubeVideo || activeUrl.includes(knownTarget.id))) return { title: knownTarget.title, url: knownTarget.url };
  return null;
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}
