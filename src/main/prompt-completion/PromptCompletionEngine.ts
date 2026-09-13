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
import { PromptHistory, cloneNode, type PromptNode } from "./PromptHistory";
import { HintController } from "./HintController";
import { SpeculationCache, type SpeculativeState } from "./SpeculationCache";
import type { AppSettings } from "../../shared/types";

export interface EngineEvents {
  onView(view: PromptViewState): void;
  onHint(view: PromptViewState): void;
  onIntent(intentText: string): void;
  onBusy(busy: boolean): void;
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
  people: ["Daniel", "Professor Lee"],
  places: [],
  apps: ["Spotify", "Calendar", "Mail"],
  recurringPhrases: [],
  customVocabulary: [],
};

export const CONFIRM_CHOICES = [
  { id: "yes" as const, label: "YES / DO IT" },
  { id: "change" as const, label: "CHANGE IT" },
  { id: "read" as const, label: "READ / REPEAT" },
  { id: "cancel" as const, label: "CANCEL" },
];

export type DecoderProviderKind = "openai" | "gemini" | "fixture";

const QUADRANT_ORDER: QuadrantId[] = ["A", "B", "C", "D"];

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
  }

  private createProvider(enabled: boolean): DecoderProvider {
    if (!enabled || this.decoderProvider === "fixture") return new FixtureDecoderProvider();
    if (this.decoderProvider === "gemini") return new GeminiFlashLiteProvider(this.settings.decoderModel);
    return new OpenAILunaProvider(this.settings.decoderModel);
  }

  async start(context?: ContextSnapshot | null): Promise<PromptViewState> {
    this.sessionGeneration += 1;
    this.session = freshSession();
    this.context = context ?? null;
    this.history.clear();
    this.hints.clear();
    this.cache.invalidateAll();
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
      const text = option.type === "full_prompt" ? option.resultingPrompt : completePrompt(session.displayPrompt);
      this.events.onIntent(text);
      return this.currentView();
    }

    if (this.isHintRequest(option)) {
      this.history.push(snapshotWithSession(node, session, this.hints.all));
      return this.enterHint();
    }

    this.history.push(snapshotWithSession(node, session, this.hints.all));
    this.commitEvidence(option);
    session.turn += 1;
    this.hints.clear();
    this.metrics.recordSelection();

    const cached = this.cache.take(scope, quadrant);
    if (cached) {
      this.metrics.recordPrefetchHit();
      const t0 = now();
      this.applySpeculative(cached);
      this.metrics.recordPrefetchedUiLatency(now() - t0);
      this.speculate();
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
      this.speculate();
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
    const text = session ? completePrompt(this.currentNode?.displayPrompt ?? session.displayPrompt) : "I want you to…";
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
    this.events.onBusy(true);
    try {
      const node = await this.generateNode(this.buildInput(), session.noneCount >= 2 ? "clarify" : "predict");
      if (generation !== this.sessionGeneration || this.session !== session) return this.currentView();
      this.currentNode = node;
      session.displayPrompt = node.displayPrompt;
      const view = this.viewFor(node);
      this.events.onView(view);
      this.speculate();
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
    const started = now();
    let response = await this.provider.generateCandidates(input);
    this.metrics.recordDecoderLatency(now() - started);
    let report = this.validator.validate(input, response);
    if (!report.valid && this.decoderProvider !== "gemini" && this.provider.repairCandidates) {
      try {
        const repairStarted = now();
        response = await this.provider.repairCandidates(input, response, report.errors);
        this.metrics.recordDecoderLatency(now() - repairStarted);
        report = this.validator.validate(input, response);
      } catch {
        // The validation error below reports the original invalid response.
      }
    }
    if (!report.valid) {
      throw new Error(`Decoder returned invalid candidates: ${report.errors.join("; ")}`);
    }
    const pool = report.candidates;
    let options = this.decoderProvider === "gemini"
      ? this.directOptions(pool)
      : (await this.diversifier.selectMany(pool, session.rejectedSets.flatMap((r) => r.labels))).options;
    if (this.decoderProvider !== "gemini" && options.length < 4) {
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
        visibleReferent: null,
        gazeTargetDescription: null,
        capturedImageDataUrl: this.context?.capturedImageDataUrl ?? null,
      },
      consecutiveNoneCount: session.noneCount,
      clarificationAnswers: session.clarifications,
      turn: session.turn,
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

  private speculate(): void {
    if (!this.settings.prefetchEnabled) return;
    // The Gemini implementation currently performs one API request per branch.
    // Five speculative requests per screen quickly exhaust low request-rate
    // quotas and contend with the next user-visible request. Re-enable this
    // when the provider supports one bulk speculation request.
    if (this.decoderProvider === "gemini") return;
    const node = this.currentNode;
    const session = this.session;
    if (!node || !session || node.displayedCandidates.length === 0) return;
    const scope = this.scopeKey(node);
    for (const q of QUADRANT_ORDER) {
      if (this.cache.has(scope, q)) continue;
      const option = node.displayedCandidates.find((o) => o.quadrant === q);
      if (!option || option.type === "do_that" || option.type === "full_prompt") continue;
      void this.speculateOne(scope, q, () => this.inputAfterSelection(option));
    }
    if (!this.cache.has(scope, "MORE") && node.mode !== "hint" && session.noneCount === 0) {
      void this.speculateOne(scope, "MORE", () => this.inputAfterMore(node));
    }
  }

  private speculateOne(scope: string, slot: string, build: () => DecoderInput): void {
    void (async () => {
      try {
        const input = build();
        const started = now();
        let response = await this.provider.generateCandidates(input);
        this.metrics.recordDecoderLatency(now() - started);
        let report = this.validator.validate(input, response);
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
        if (!report.valid) return;
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
        const pool = report.candidates.slice(0, 12);
        const diversified = await this.diversifier.selectMany(pool, this.session?.rejectedSets.flatMap((r) => r.labels) ?? []);
        let display = diversified.options;
        if (display.length < 4) {
          display = display.concat(this.genericFill(input.displayPrompt).slice(0, 4 - display.length));
        }
        this.cache.set(scope, slot, {
          response: { ...response, normalizedPrompt: input.displayPrompt },
          display,
          createdAt: Date.now(),
          forKey: scope,
        });
      } catch {
        // non-fatal
      }
    })();
  }

  private inputAfterSelection(option: DisplayOption): DecoderInput {
    const session = this.requireSession();
    if (!session) throw new Error("no session");
    const frag = evidenceFragmentFor(option);
    const nextEvidence = [...session.evidence.map((e) => e.semanticFragment), frag];
    const nextHints = this.hints.all.map((h) => ({ text: h.text, type: h.type }));
    if (frag !== "something_else") nextHints.length = 0;
    return {
      displayPrompt: option.resultingPrompt,
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

  private inputAfterMore(node: PromptNode): DecoderInput {
    const session = this.requireSession();
    if (!session) throw new Error("no session");
    return {
      ...this.buildInput(),
      rejectedSets: [
        ...session.rejectedSets,
        { labels: node.displayedCandidates.map((option) => option.label), turn: session.turn },
      ],
      consecutiveNoneCount: session.noneCount + 1,
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

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}
