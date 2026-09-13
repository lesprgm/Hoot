import type {
  AttentionAnchor,
  AudioCue,
  ConsequentialState,
  ContextSnapshot,
  ExecutedTask,
  ExecutorEvent,
  IntentConfirmationState,
  PromptViewState,
  RecoveryState,
  SteeringState,
  ViewMessage,
} from "../../shared/types";
import { InteractionStateMachine } from "./StateMachine";
import { PromptCompletionEngine, CONFIRM_CHOICES } from "../prompt-completion/PromptCompletionEngine";
import { SessionMetrics } from "../telemetry/SessionMetrics";
import { TTSService } from "../tts/MacSayTTS";
import { ContextEngine } from "../context/ContextEngine";
import { OpenAIComputerUseExecutor } from "../executor/OpenAIComputerUseExecutor";
import { labelConsequentialAction } from "../executor/ExecutorProvider";
import { config } from "../config";
import { randomUUID } from "node:crypto";

export interface ControllerOptions {
  screenWidth: number;
  screenHeight: number;
  screenScale: number;
}

function decoderUsesConfiguredProvider(): boolean {
  return config.decoderProvider !== "fixture" && config.executionMode === "live";
}

export function spokenSelectionFeedback(label: string): string {
  const spoken = label
    .replace(/…/g, "")
    .replace(/\s*\/\s*/g, " or ")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
  return spoken ? `${spoken} selected.` : "Selection accepted.";
}

export class InteractionController {
  readonly machine = new InteractionStateMachine();
  private engine: PromptCompletionEngine;
  private metrics = new SessionMetrics();
  private tts: TTSService;
  private context: ContextEngine;
  private executor: OpenAIComputerUseExecutor | null = null;
  private pendingIntent: string | null = null;
  private pendingTask: ExecutedTask | null = null;
  private consequentialResolver: ((decision: "approve" | "change" | "cancel") => void) | null = null;
  private currentConsequential: ConsequentialState | null = null;
  private steeringResolver: ((choice: "continue" | "stop" | "change") => void) | null = null;
  private routingToCorrection = false;
  private readonly suppressedStoppedTaskIds = new Set<string>();
  private lastPromptView: PromptViewState | null = null;
  private clarifyRejects = 0;
  private executorCount = 0;
  private hasValidGaze = false;
  private demoMode = config.simulateGaze;
  private sessionPreparation: Promise<void> = Promise.resolve();
  private sessionGeneration = 0;
  private semanticRequestInFlight = false;
  private semanticRequestToken = 0;

  constructor(
    private broadcast: (message: ViewMessage) => void,
    voiceId: string,
    opts: ControllerOptions
  ) {
    this.context = new ContextEngine(opts.screenWidth, opts.screenHeight, opts.screenScale);
    this.machine.onState((state) => this.broadcast({ type: "state", state }));
    this.tts = new TTSService(voiceId);
    this.tts.onAudio = (result) => {
      this.metrics.recordTtsLatency(result.timeToFirstAudioMs);
      this.broadcast({ type: "speech", text: result.text, provider: result.provider, dataUrl: result.dataUrl });
    };
    this.tts.onError = (message) => {
      this.broadcast({ type: "audio-cue", cue: "error" });
      this.broadcast({ type: "notice", text: `${message} Audio feedback is unavailable.` });
      this.broadcast({ type: "sprite", sprite: this.machine.state === "EXECUTING" ? "computer_use_running" : "idle" });
    };
    this.engine = new PromptCompletionEngine(
      {
        onView: (view) => {
          if (this.machine.state === "AGENT_LOADING") this.machine.transition("optionsReady");
          this.lastPromptView = view;
          this.broadcast({ type: "prompt", view });
          this.broadcast({ type: "audio-cue", cue: "ready" });
        },
        onHint: (view) => {
          this.lastPromptView = view;
          this.broadcast({ type: "hint", view });
          this.broadcast({ type: "audio-cue", cue: "ready" });
        },
        onIntent: (intent) => this.handleIntent(intent),
        onBusy: (busy) => {
          if (busy) {
            if (this.machine.transition("decodingStarted")) {
              this.broadcast({ type: "sprite", sprite: "thinking" });
            }
          } else if (this.machine.transition("decodingFinished")) {
            this.broadcast({ type: "sprite", sprite: "idle" });
          }
        },
      },
      {
        recordSelection: () => {
          this.metrics.semanticSelections += 1;
        },
        recordNone: () => {
          this.metrics.noneSelections += 1;
        },
        recordClarifyAnswer: () => {
          this.metrics.clarificationAnswers += 1;
        },
        recordHintChars: (n) => {
          this.metrics.fallbackCharacters += n;
        },
        recordDecoderLatency: (ms) => {
          this.metrics.decoderColdLatencyMs.push(ms);
        },
        recordPrefetchHit: () => {
          this.metrics.prefetchHits += 1;
        },
        recordPrefetchMiss: () => {
          this.metrics.prefetchMisses += 1;
        },
        recordPrefetchedUiLatency: (ms) => {
          this.metrics.prefetchedUiLatencyMs.push(ms);
        },
      },
      config.settings,
      decoderUsesConfiguredProvider(),
      config.decoderProvider,
    );
  }

  get metricsSummary() {
    return this.metrics.summary();
  }

  get providerNames() {
    return { decoder: this.engine.getProviderName(), tts: this.tts.providerName, gaze: this.demoMode ? "simulated" : config.gazeProvider };
  }

  setDemoMode(enabled: boolean): void {
    this.demoMode = enabled;
    const useRealDecoder = !enabled && decoderUsesConfiguredProvider();
    this.engine.setRealModelEnabled(useRealDecoder);
  }

  attachContextEngine(engine: ContextEngine): void {
    this.context = engine;
  }

  async startContextPolling(): Promise<void> {
    await this.context.start();
    this.context.startPolling();
  }

  setAttentionAnchor(anchor: AttentionAnchor): void {
    this.context.setAttentionAnchor(anchor);
  }

  get activeAppPretty(): string {
    return this.context.activeAppPretty;
  }

  get currentAttentionAnchor(): AttentionAnchor | null { return this.context.current()?.attentionAnchor ?? null; }
  get screenWidth(): number { return this.screenWidthValue; }
  get screenHeight(): number { return this.screenHeightValue; }

  // ---- gaze lifecycle ----

  onGazeConfidence(validSample: boolean): void {
    if (validSample) {
      this.hasValidGaze = true;
      this.machine.transition("gazeRestored");
    } else if (this.hasValidGaze) {
      this.machine.transition("gazeLost");
    }
  }

  // ---- summon / session ----

  async summon(): Promise<void> {
    if (!this.machine.can("summonReady")) return;
    this.machine.transition("summonReady");
    await this.loadSession();
  }

  private async loadSession(): Promise<void> {
    this.metrics.resetSession();
    this.clarifyRejects = 0;
    const generation = ++this.sessionGeneration;
    try {
      // The root is fixed and context-independent, so publish it before any
      // capture or provider initialization work enters the critical path.
      await this.engine.start(null);

      const contextTask = this.demoMode
        ? Promise.resolve()
        : this.context.snapshotContext(true).then((snapshot) => {
            if (generation !== this.sessionGeneration) return;
            this.engine.setContext(snapshot);
            this.broadcast({ type: "context", snapshot });
          });
      this.sessionPreparation = Promise.all([contextTask, this.engine.warmup()]).then(() => undefined);
      // A later semantic action awaits this same promise and reports failure.
      // Registering a handler now prevents an idle rejected promise warning.
      void this.sessionPreparation.catch(() => undefined);
    } catch (err) {
      this.fail(err);
    }
  }

  async selectOption(quadrant: "A" | "B" | "C" | "D"): Promise<void> {
    if (!this.machine.can("selectOption")) return;
    const requestToken = this.beginSemanticRequest();
    if (requestToken === null) return;
    const selectedOption = this.lastPromptView?.options.find((option) => option.quadrant === quadrant);
    if (selectedOption) {
      this.cue("selection");
      if (selectedOption.type !== "do_that" && selectedOption.type !== "full_prompt") {
        this.speak(spokenSelectionFeedback(selectedOption.label));
      }
    }
    try {
      await this.sessionPreparation;
      if (requestToken !== this.semanticRequestToken) return;
      await this.engine.selectOption(quadrant);
    } catch (error) {
      if (requestToken === this.semanticRequestToken) this.fail(error);
    } finally {
      this.finishSemanticRequest(requestToken);
    }
  }

  async more(): Promise<void> {
    if (!this.machine.can("more")) return;
    const requestToken = this.beginSemanticRequest();
    if (requestToken === null) return;
    this.acknowledgeSelection("More choices");
    if (this.lastPromptView?.mode === "clarify") {
      this.clarifyRejects += 1;
      if (this.clarifyRejects >= 2) {
        this.openFallback();
        this.finishSemanticRequest(requestToken);
        return;
      }
    }
    try {
      await this.sessionPreparation;
      if (requestToken !== this.semanticRequestToken) return;
      await this.engine.more();
    } catch (error) {
      if (requestToken === this.semanticRequestToken) this.fail(error);
    } finally {
      this.finishSemanticRequest(requestToken);
    }
  }

  async back(): Promise<void> {
    if (!this.machine.can("back") || this.semanticRequestInFlight) return;
    this.acknowledgeSelection("Back");
    try {
      await this.engine.back();
    } catch (error) {
      this.fail(error);
    }
  }

  async beginHint(): Promise<void> {
    if (this.semanticRequestInFlight || this.machine.state === "DECODING_ALT") return;
    if (!this.machine.can("selectOption") && this.machine.state !== "FALLBACK_TEXT") return;
    this.acknowledgeSelection("Spell or hint");
    const view = await this.engine.beginHint();
    void view;
  }

  async updateHint(text: string): Promise<void> {
    const requestToken = this.beginSemanticRequest();
    if (requestToken === null) return;
    if (this.machine.can("selectOption")) this.machine.transition("selectOption");
    try {
      await this.sessionPreparation;
      if (requestToken !== this.semanticRequestToken) return;
      await this.engine.updateHint(text);
    } catch (error) {
      if (requestToken === this.semanticRequestToken) this.fail(error);
    } finally {
      this.finishSemanticRequest(requestToken);
    }
  }

  async clearHint(): Promise<void> {
    if (this.semanticRequestInFlight || this.machine.state === "DECODING_ALT") return;
    const view = this.engine.clearHint();
    void view;
  }

  async acceptHintCandidate(id: string): Promise<void> {
    const requestToken = this.beginSemanticRequest();
    if (requestToken === null) return;
    if (this.machine.can("selectOption")) this.machine.transition("selectOption");
    try {
      await this.engine.acceptHintCandidate(id);
    } catch (error) {
      this.fail(error);
    } finally {
      this.finishSemanticRequest(requestToken);
    }
  }

  async commitHintLiteral(text: string): Promise<void> {
    if (this.semanticRequestInFlight || this.machine.state === "DECODING_ALT") return;
    await this.engine.commitHintLiteral(text);
  }

  async requestCompletion(): Promise<void> {
    if (this.semanticRequestInFlight || this.machine.state === "DECODING_ALT") return;
    const state = await this.engine.requestCompletion();
    void state;
  }

  private beginSemanticRequest(): number | null {
    if (this.semanticRequestInFlight || this.machine.state === "DECODING_ALT") return null;
    this.semanticRequestInFlight = true;
    return ++this.semanticRequestToken;
  }

  private finishSemanticRequest(requestToken: number): void {
    if (requestToken === this.semanticRequestToken) this.semanticRequestInFlight = false;
  }

  async exitSession(): Promise<void> {
    this.sessionGeneration += 1;
    this.semanticRequestToken += 1;
    this.semanticRequestInFlight = false;
    this.sessionPreparation = Promise.resolve();
    this.machine.transition("exit");
    this.engine.exit();
    this.pendingIntent = null;
    this.tts.stop();
    this.broadcast({ type: "speech-stop" });
    this.cue("selection");
    this.broadcast({ type: "state", state: this.machine.state });
  }

  private handleIntent(intent: string): void {
    this.pendingIntent = intent;
    if (this.machine.can("intentReady")) {
      this.machine.transition("intentReady");
    } else if (this.machine.state === "FALLBACK_TEXT") {
      this.machine.transition("literalCommit");
    } else if (this.machine.state === "SEMANTIC" || this.machine.state === "DECODING_ALT") {
      this.machine.transition("intentReady");
    }
    this.metrics.markIntentReady();
    const state: IntentConfirmationState = {
      sessionId: this.engine.sessionId ?? randomUUID(),
      intentText: intent,
      speakText: intent,
      canBack: this.machine.state === "INTENT_CONFIRMATION" && this.engine.peerCount > 0,
      choices: CONFIRM_CHOICES,
    };
    this.broadcast({ type: "intent-confirmation", view: state });
    this.cue("ready");
    this.speak(`You want me to ${intent.replace(/^I want you to\s*/i, "").replace(/\.$/, "")}. Is that right?`);
  }

  private openFallback(): void {
    this.machine.transition("openFallback");
    const view = this.lastPromptView;
    if (view) {
      const hintView = { ...view, mode: "hint" as const };
      this.broadcast({ type: "hint", view: hintView });
    }
    this.speak("I need more information. Use the hint panel to spell a word or name.");
  }

  // ---- confirmation ----

  async confirmYes(): Promise<void> {
    if (this.machine.state !== "INTENT_CONFIRMATION" || !this.pendingIntent) return;
    this.acknowledgeSelection("Do it");
    this.machine.transition("confirmYes");
    this.broadcast({ type: "state", state: "EXECUTING" });
    this.broadcast({ type: "executing", status: { taskId: "t", statusText: "Starting…", stepIndex: 0, stepCount: 1 } });
    this.startExecution(this.pendingIntent);
    this.pendingIntent = null;
  }

  async confirmChange(): Promise<void> {
    if (this.machine.state !== "INTENT_CONFIRMATION") return;
    this.cue("selection");
    this.pendingIntent = null;
    this.machine.transition("confirmChange");
    const view = await this.engine.back();
    this.lastPromptView = view;
    this.broadcast({ type: "prompt", view });
    this.speak("What would you like to change?");
  }

  async confirmRead(): Promise<void> {
    if (this.machine.state !== "INTENT_CONFIRMATION") return;
    this.cue("selection");
    this.machine.transition("confirmRead");
    if (this.pendingIntent) this.speak(this.pendingIntent);
  }

  async confirmCancel(): Promise<void> {
    this.cue("selection");
    this.machine.transition("confirmCancel");
    this.engine.exit();
    this.pendingIntent = null;
    this.tts.stop();
    this.broadcast({ type: "speech-stop" });
    this.broadcast({ type: "state", state: "PASSIVE" });
    this.speak("Cancelled.");
  }

  async chooseCorrection(_optionLabel: string): Promise<void> {
    this.pendingIntent = null;
    this.machine.transition("force", { forceState: "SEMANTIC" });
    const view = await this.engine.restartComposition();
    this.lastPromptView = view;
  }

  // ---- execution ----

  private async startExecution(intent: string): Promise<void> {
    const task: ExecutedTask = {
      taskId: randomUUID(),
      naturalLanguagePrompt: intent,
      startedAt: Date.now(),
      mode: "live",
    };
    this.pendingTask = task;
    const callbacks = {
      onEvent: (e: ExecutorEvent) => this.onExecutorEvent(e),
      requestConsequentialConfirmation: async (state: ConsequentialState) => (await this.handleConsequential(state)) === "approve",
      requestConsequentialChoice: (state: ConsequentialState) => this.handleConsequential(state),
      requestSteering: (taskInner: ExecutedTask, statusText: string) => this.handleSteering(taskInner, statusText),
      onComplete: (_task: ExecutedTask, summary: string) => {
        this.metrics.recordTask(summary, Date.now() - _task.startedAt, this.executorCount);
      },
    };
    this.executor = new OpenAIComputerUseExecutor(config.settings.executorModel, this.screenWidthValue, this.screenHeightValue);
    if (!this.executor.available) {
      this.notice("OpenAI Computer Use is unavailable. Set OPENAI_API_KEY to execute desktop actions.");
      this.executor = null;
      this.fail(new Error("OpenAI Computer Use requires OPENAI_API_KEY."));
      return;
    }
    this.executorCount = 0;
    try {
      await this.executor.start(task, callbacks);
    } catch (err) {
      this.fail(err);
    }
  }

  private onExecutorEvent(e: ExecutorEvent): void {
    switch (e.type) {
      case "task_started":
        this.broadcast({ type: "sprite", sprite: "computer_use_running", metadata: { status: "working" } });
        break;
      case "status":
      case "step":
        this.executorCount += 1;
        this.broadcast({
          type: "executing",
          status: { taskId: e.taskId, statusText: e.text ?? "Working…", stepIndex: e.stepIndex ?? 0, stepCount: e.stepCount ?? 1 },
        });
        break;
      case "consequential_pending":
        break;
      case "completed":
        this.broadcast({ type: "sprite", sprite: "success" });
        this.broadcast({ type: "executing", status: { taskId: e.taskId, statusText: e.text ?? "Done.", stepIndex: 1, stepCount: 1 } });
        this.machine.transition("completed");
        this.broadcast({ type: "state", state: "COMPLETE" });
        this.speak(e.text ?? "Task completed.");
        setTimeout(() => {
          this.machine.transition("optionsReady");
          this.broadcast({ type: "state", state: "PASSIVE" });
          this.broadcast({ type: "telemetry", summary: this.metrics.summary() });
          this.broadcast({ type: "sprite", sprite: "idle" });
        }, 1400);
        break;
      case "interrupted":
        this.broadcast({ type: "sprite", sprite: "interrupted" });
        break;
      case "stopped":
        this.broadcast({ type: "sprite", sprite: "idle" });
        if (this.routingToCorrection || this.suppressedStoppedTaskIds.delete(e.taskId)) return;
        this.machine.set("PASSIVE");
        this.broadcast({ type: "state", state: "PASSIVE" });
        this.speak(e.text ?? "Stopped.");
        break;
      case "error":
        this.fail(new Error(e.text ?? "executor error"));
        break;
    }
  }

  private handleConsequential(state: ConsequentialState): Promise<"approve" | "change" | "cancel"> {
    this.machine.transition("consequentialPending");
    this.currentConsequential = state;
    this.broadcast({ type: "sprite", sprite: "needs_confirmation" });
    this.broadcast({ type: "consequential", view: state });
    this.cue("ready");
    this.speak(`${state.pendingActionSummary}. Approve?`);
    return new Promise((resolve) => {
      this.consequentialResolver = resolve;
    });
  }

  private handleSteering(task: ExecutedTask, statusText: string): Promise<"continue" | "stop" | "change"> {
    this.machine.transition("interrupt");
    const state: SteeringState = {
      taskId: task.taskId,
      intentText: task.naturalLanguagePrompt,
      recentStatus: statusText,
      options: [
        { id: "change_something", label: "CHANGE SOMETHING", semanticMeaning: "steer=change" },
        { id: "go_back", label: "GO BACK", semanticMeaning: "steer=back" },
        { id: "continue", label: "CONTINUE", semanticMeaning: "steer=continue" },
        { id: "stop", label: "STOP THE TASK", semanticMeaning: "steer=stop" },
      ],
    };
    this.broadcast({ type: "steering", view: state });
    this.cue("ready");
    this.speak("Okay — what would you like to change?");
    return new Promise((resolve) => {
      this.steeringResolver = resolve;
    });
  }

  async interruptExecutor(): Promise<void> {
    if (this.machine.state === "EXECUTING" && this.executor) {
      await this.executor.interrupt();
      this.broadcast({ type: "sprite", sprite: "interrupted" });
    }
  }

  async steer(choice: string): Promise<void> {
    if (this.machine.state !== "EXECUTION_INTERRUPTED") return;
    this.cue("selection");
    const resolver = this.steeringResolver;
    this.steeringResolver = null;
    if (choice === "continue") {
      this.speak("Continue selected.");
      this.machine.transition("steerContinue");
      this.broadcast({ type: "state", state: "EXECUTING" });
      this.broadcast({ type: "executing", status: { taskId: this.pendingTask?.taskId ?? "task", statusText: "Continuing from the paused action…", stepIndex: 0, stepCount: 1 } });
      if (resolver) resolver("continue");
      return;
    }
    if (choice === "stop") {
      this.machine.transition("steerStop");
      this.broadcast({ type: "state", state: "PASSIVE" });
      this.speak("Stopped the task.");
      if (resolver) resolver("stop");
      return;
    }
    // A changed task must return through intent composition and confirmation.
    const trigger = choice === "go_back" ? "steerBack" : "steerChange";
    if (!this.machine.transition(trigger)) return;
    this.routingToCorrection = true;
    if (this.pendingTask) this.suppressedStoppedTaskIds.add(this.pendingTask.taskId);
    await this.executor?.stop();
    if (resolver) resolver("change");
    this.pendingTask = null;
    this.currentConsequential = null;
    this.pendingIntent = null;
    const view = choice === "go_back" ? await this.engine.back() : await this.engine.restartComposition();
    this.releaseCorrectionRouting();
    this.lastPromptView = view;
    this.broadcast({ type: "state", state: "SEMANTIC" });
    this.broadcast({ type: "prompt", view });
    this.speak(choice === "go_back" ? "Let's go back and revise the task." : "Let's try something else.");
  }

  // ---- consequential decision ----

  async consequentialChoice(choice: string, readAgain = false): Promise<void> {
    if (this.machine.state !== "CONSEQUENTIAL_CONFIRMATION") return;
    this.cue("selection");
    if (choice === "approve") {
      this.speak("Approved.");
      const resolver = this.takeConsequentialResolver();
      this.machine.transition("approveConsequential");
      this.currentConsequential = null;
      this.broadcast({ type: "state", state: "EXECUTING" });
      if (resolver) resolver("approve");
    } else if (choice === "cancel") {
      const resolver = this.takeConsequentialResolver();
      this.machine.transition("cancelConsequential");
      this.currentConsequential = null;
      this.broadcast({ type: "state", state: "PASSIVE" });
      await this.executor?.stop();
      this.speak("Cancelled. Nothing was sent.");
      if (resolver) resolver("cancel");
    } else if (choice === "read") {
      this.speak(this.currentConsequential?.pendingActionSummary ?? "The pending action is awaiting your approval.");
      void readAgain;
    } else {
      const resolver = this.takeConsequentialResolver();
      // change
      this.machine.transition("editConsequential");
      this.currentConsequential = null;
      this.routingToCorrection = true;
      if (this.pendingTask) this.suppressedStoppedTaskIds.add(this.pendingTask.taskId);
      await this.executor?.stop();
      if (resolver) resolver("change");
      this.pendingTask = null;
      this.pendingIntent = null;
      const view = await this.engine.restartComposition();
      this.releaseCorrectionRouting();
      this.lastPromptView = view;
      this.broadcast({ type: "state", state: "SEMANTIC" });
      this.broadcast({ type: "prompt", view });
      this.speak("The pending action was cancelled. Compose and confirm the changed instruction before running it.");
    }
  }

  private takeConsequentialResolver(): ((decision: "approve" | "change" | "cancel") => void) | null {
    const resolver = this.consequentialResolver;
    this.consequentialResolver = null;
    return resolver;
  }

  async recovery(choice: string): Promise<void> {
    this.cue("selection");
    if (choice === "retry") {
      this.speak("Try again selected.");
      if (!this.machine.transition("recoveryRetry")) return;
      this.broadcast({ type: "state", state: "AGENT_LOADING" });
      await this.loadSession();
      return;
    }
    this.pendingIntent = null;
    this.pendingTask = null;
    if (choice === "go_back" || choice === "choose_else") {
      const trigger = choice === "go_back" ? "recoveryBack" : "recoveryChoose";
      if (!this.machine.transition(trigger)) return;
      const view = choice === "go_back" ? await this.engine.back() : await this.engine.restartComposition();
      this.lastPromptView = view;
      this.broadcast({ type: "state", state: "SEMANTIC" });
      this.broadcast({ type: "prompt", view });
      this.speak(choice === "go_back" ? "Let's return to the previous step." : "Choose a different instruction.");
      return;
    }
    this.machine.transition("recoveryStop");
    await this.executor?.stop();
    this.executor = null;
    this.engine.exit();
    this.broadcast({ type: "state", state: "PASSIVE" });
  }

  private releaseCorrectionRouting(): void {
    // The executor reports its stopped event after the correction promise resolves.
    // Keep the guard through that microtask so it cannot replace the semantic view.
    setTimeout(() => { this.routingToCorrection = false; }, 0);
  }

  // ---- misc ----

  private fail(err: unknown): void {
    const text = err instanceof Error ? err.message : String(err);
    if (!this.machine.transition("error")) this.machine.set("ERROR_RECOVERY");
    const state: RecoveryState = {
      errorSummary: text.slice(0, 160),
      choices: [
        { id: "retry", label: "TRY AGAIN" },
        { id: "go_back", label: "GO BACK" },
        { id: "choose_else", label: "CHOOSE SOMETHING ELSE" },
        { id: "stop", label: "STOP" },
      ],
    };
    this.broadcast({ type: "recovery", view: state });
    this.cue("ready");
    this.speak(`Something went wrong. ${state.errorSummary}`);
  }

  speak(text: string): void {
    if (config.ttsProvider === "mute") return;
    this.broadcast({ type: "sprite", sprite: "speaking" });
    void this.tts.speak(text);
  }

  private cue(cue: AudioCue): void {
    this.broadcast({ type: "audio-cue", cue });
  }

  private acknowledgeSelection(label: string): void {
    this.cue("selection");
    this.speak(spokenSelectionFeedback(label));
  }

  notice(text: string): void {
    this.broadcast({ type: "notice", text });
  }

  private screenWidthValue = 1920;
  private screenHeightValue = 1080;
  setScreenSize(w: number, h: number): void {
    this.screenWidthValue = w;
    this.screenHeightValue = h;
  }
}
