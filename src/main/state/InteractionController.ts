import type {
  AttentionAnchor,
  AudioCue,
  ConsequentialState,
  ContextSnapshot,
  ExecutedTask,
  ExecutorEvent,
  PromptViewState,
  RecoveryState,
  SelectionEnvelope,
  SteeringState,
  ViewMessage,
} from "../../shared/types";
import { isDecisionOperation, isSelectionEnvelope, makeInteractionSnapshot, parseDecisionOperation } from "../../shared/decisions";
import { TaskStore } from "../task/TaskStore";
import { ObjectRegistry } from "../context/ObjectRegistry";
import { chooseInteractionPolicy } from "../task/InteractionPolicy";
import { InteractionStateMachine } from "./StateMachine";
import { IntentCompositionEngine } from "../prompt-completion/IntentCompositionEngine";
import { TTSService } from "../tts/MacSayTTS";
import { ContextEngine } from "../context/ContextEngine";
import { OpenAIComputerUseExecutor } from "../executor/OpenAIComputerUseExecutor";
import { config, personalizationLexicon } from "../config";
import { randomUUID } from "node:crypto";

export interface ControllerOptions {
  screenWidth: number;
  screenHeight: number;
  screenScale: number;
  contextAllowedApps?: string[];
  taskStore?: TaskStore;
  /** Native ScreenCaptureKit helper used when Hoots is being recorded. */
  astraCaptureHost?: string | null;
  /** Returns the current Hoots process IDs to exclude from Astra captures. */
  overlayProcessIds?: () => readonly number[];
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
  return spoken ? `Okay — ${spoken}.` : "Okay.";
}

export function shouldSpeakSemanticSelection(selectionNumber: number): boolean {
  return selectionNumber >= 2;
}

export class InteractionController {
  readonly machine = new InteractionStateMachine();
  private engine: IntentCompositionEngine;
  private tts: TTSService;
  private context: ContextEngine;
  private executor: OpenAIComputerUseExecutor | null = null;
  private pendingTask: ExecutedTask | null = null;
  private consequentialResolver: ((decision: "approve" | "change" | "cancel") => void) | null = null;
  private currentConsequential: ConsequentialState | null = null;
  private steeringResolver: ((choice: "continue" | "stop" | "change") => void) | null = null;
  private routingToCorrection = false;
  private readonly suppressedStoppedTaskIds = new Set<string>();
  private lastPromptView: PromptViewState | null = null;
  private clarifyRejects = 0;
  private hasValidGaze = false;
  private demoMode = config.simulateGaze;
  private sessionPreparation: Promise<void> = Promise.resolve();
  private sessionGeneration = 0;
  private semanticRequestInFlight = false;
  private semanticRequestToken = 0;
  private prefetchRequestToken = 0;
  private semanticSelectionCount = 0;
  private contextUnsubscribe: (() => void) | null = null;
  private readonly taskStore: TaskStore;
  private readonly objectRegistry = new ObjectRegistry();
  private interactionRevision = 0;
  private busy = false;
  private lastError: string | null = null;
  private lastInteractionId: string | null = null;
  private lastTaskContextRevision: number | null = null;
  private readonly astraCaptureHost: string | null;
  private readonly overlayProcessIds: () => readonly number[];

  constructor(
    private broadcast: (message: ViewMessage) => void,
    voiceId: string,
    opts: ControllerOptions
  ) {
    this.taskStore = opts.taskStore ?? new TaskStore();
    this.astraCaptureHost = opts.astraCaptureHost ?? null;
    this.overlayProcessIds = opts.overlayProcessIds ?? (() => []);
    this.taskStore.onChange((task) => {
      if (this.engine) this.engine.setTask(task);
      this.broadcast({ type: "task", task });
      this.publishInteractionSnapshot();
    });
    this.context = new ContextEngine(opts.screenWidth, opts.screenHeight, opts.screenScale, {
      allowedApps: opts.contextAllowedApps,
    });
    this.machine.onState((state) => {
      this.broadcast({ type: "state", state });
      this.publishInteractionSnapshot();
    });
    this.tts = new TTSService(voiceId);
    this.tts.onAudio = (result) => {
      this.broadcast({ type: "speech", text: result.text, provider: result.provider, dataUrl: result.dataUrl });
    };
    this.tts.onError = (message) => {
      this.broadcast({ type: "audio-cue", cue: "error" });
      this.broadcast({ type: "notice", text: `${message} Audio feedback is unavailable.` });
      this.broadcast({ type: "sprite", sprite: this.machine.state === "EXECUTING" ? "computer_use_running" : "idle" });
    };
    this.engine = new IntentCompositionEngine(
      {
        onView: (view) => {
          if (this.machine.state === "AGENT_LOADING") this.machine.transition("optionsReady");
          this.publishPrompt(view);
          this.broadcast({ type: "audio-cue", cue: "ready" });
        },
        onIntent: (intent) => this.handleIntent(intent),
        onBusy: (busy) => {
          if (busy) {
            this.busy = true;
            this.publishInteractionSnapshot();
            if (this.machine.transition("decodingStarted")) {
              this.broadcast({ type: "sprite", sprite: "thinking" });
            }
          } else {
            this.busy = false;
            this.publishInteractionSnapshot();
            if (this.machine.transition("decodingFinished")) {
              this.broadcast({ type: "sprite", sprite: "idle" });
            }
          }
        },
      },
      config.settings,
      decoderUsesConfiguredProvider(),
      config.decoderProvider,
      config.decoderFallbackProvider,
      personalizationLexicon,
    );
    this.engine.setTask(this.taskStore.current());
  }

  get providerNames() {
    return { decoder: this.engine.getProviderName(), tts: this.tts.providerName, gaze: this.demoMode ? "simulated" : config.gazeProvider };
  }

  setDemoMode(enabled: boolean): void {
    this.demoMode = enabled;
    // A simulated demo can use the same bounded, approved active-window
    // context as a live session. Disable it only when that mode is explicitly
    // opted out, or when live calibration is taking ownership of the flow.
    if (!enabled || config.settings.contextInSimulation !== true) this.context.disableSession();
    const useRealDecoder = !enabled && decoderUsesConfiguredProvider();
    this.engine.setRealModelEnabled(useRealDecoder);
  }

  async startContextPolling(): Promise<void> {
    this.contextUnsubscribe ??= this.context.onChange((snapshot) => this.publishContext(snapshot));
    await this.context.start();
    this.context.startPolling();
  }

  stopContextPolling(): void {
    this.context.stopPolling();
    this.contextUnsubscribe?.();
    this.contextUnsubscribe = null;
  }

  setAttentionAnchor(anchor: AttentionAnchor): void {
    this.context.setAttentionAnchor(anchor);
  }

  async toggleContext(): Promise<void> {
    if (!this.context.isSessionEnabled()) return;
    await this.context.togglePaused();
  }

  async approveContextSession(): Promise<void> {
    if (!this.context.isSessionEnabled()) return;
    await this.context.approveSessionContext();
  }

  private publishContext(snapshot: ContextSnapshot): void {
    this.objectRegistry.update(snapshot);
    // Gaze anchors can update more often than object observations. Keep those
    // transient coordinates available to the decoder without broadcasting task-state churn every frame.
    if (snapshot.revision !== this.lastTaskContextRevision) {
      this.lastTaskContextRevision = snapshot.revision;
      this.taskStore.observeContext(snapshot);
    }
    this.engine.setContext(snapshot);
    this.broadcast({ type: "context", snapshot });
    this.publishInteractionSnapshot();
  }

  private publishPrompt(view: PromptViewState): void {
    const cardSetId = view.cardSetId ?? randomUUID();
    const revision = ++this.interactionRevision;
    const decorated: PromptViewState = {
      ...view,
      cardSetId,
      revision,
      options: view.options.map((option) => ({ ...option, cardId: option.cardId ?? option.id })),
      decisionKind: chooseInteractionPolicy({ task: this.taskStore.current(), current: view, busy: this.busy, taskAwareEnabled: config.settings.taskAwareCards === true }).kind,
    };
    this.lastPromptView = decorated;
    this.lastError = null;
    this.broadcast({ type: "prompt", view: decorated });
    this.publishInteractionSnapshot();
  }

  private publishInteractionSnapshot(): void {
    const promptState = new Set(["AGENT_LOADING", "SEMANTIC", "SEMANTIC_PAUSED", "DECODING_ALT", "CLARIFYING"]);
    this.broadcast({
      type: "interaction-snapshot",
      snapshot: makeInteractionSnapshot({
        state: this.machine.state,
        busy: this.busy,
        // A prompt belongs to a semantic state. Clearing it at the snapshot
        // boundary prevents an older card set from flashing during execution,
        // recovery, calibration, or passive mode.
        prompt: promptState.has(this.machine.state) ? this.lastPromptView : null,
        context: this.context.current(),
        task: this.taskStore.current(),
        revision: this.interactionRevision,
        interactionId: this.lastInteractionId,
        error: this.lastError,
      }),
    });
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
    this.clarifyRejects = 0;
    this.semanticSelectionCount = 0;
    this.lastError = null;
    this.lastInteractionId = null;
    ++this.sessionGeneration;
    try {
      const contextEnabled = !this.demoMode || config.settings.contextInSimulation === true;
      if (!contextEnabled) {
        this.context.disableSession();
      }
      // Publish the deterministic initial view before capture or provider
      // initialization. Approved foreground context may replace it once.
      await this.engine.start(null);

      if (contextEnabled) await this.context.enableSession();

      const contextTask = contextEnabled
        ? this.context.snapshotContext(true).then(() => undefined)
        : Promise.resolve();
      this.sessionPreparation = Promise.all([contextTask, this.engine.warmup()]).then(() => undefined);
      // A later semantic action awaits this same promise and reports failure.
      // Registering a handler now prevents an idle rejected promise warning.
      void this.sessionPreparation.catch(() => undefined);
    } catch (err) {
      this.fail(err);
    }
  }

  async selectOption(selection: SelectionEnvelope): Promise<void> {
    if (!this.machine.can("selectOption")) return;
    const resolved = this.resolveSelection(selection);
    if (!resolved) return;
    const { quadrant, interactionId, option } = resolved;
    if (!this.validateSelectedOption(option)) return;
    this.prefetchRequestToken += 1;
    const requestToken = this.beginSemanticRequest();
    if (requestToken === null) return;
    this.lastInteractionId = interactionId;
    this.semanticSelectionCount += 1;
    const isTerminalSelection = option.type === "do_that" || option.type === "full_prompt";
    this.acknowledgeSelection(option.label, !isTerminalSelection && shouldSpeakSemanticSelection(this.semanticSelectionCount));
    this.applyTaskOperation(option);
    if (await this.handleTaskAction(option)) {
      this.finishSemanticRequest(requestToken);
      return;
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

  private resolveSelection(selection: SelectionEnvelope): { quadrant: "A" | "B" | "C" | "D"; interactionId: string; option: PromptViewState["options"][number] } | null {
    const view = this.lastPromptView;
    if (!isSelectionEnvelope(selection) || !view) {
      return null;
    }
    const option = view.options.find((candidate) => (candidate.cardId ?? candidate.id) === selection.cardId);
    if (!option || selection.sessionId !== view.sessionId || selection.cardSetId !== view.cardSetId || selection.expectedRevision !== view.revision) {
      return null;
    }
    return { quadrant: option.quadrant, interactionId: selection.interactionId, option };
  }

  private validateSelectedOption(option: PromptViewState["options"][number]): boolean {
    const context = this.context.current();
    if (option.referenceId) {
      if (context?.access !== "active") {
        this.notice("That target is no longer available. Choose another card or resume context.");
        return false;
      }
      if (option.contextRevision != null && option.contextRevision !== context.revision) {
        this.notice("That target changed. The current cards remain available; choose the refreshed target.");
        return false;
      }
      const target = this.objectRegistry.revalidate(option.referenceId, option.referenceRevision);
      if (!target.ok) {
        this.notice(`That target is no longer valid: ${target.reason}`);
        return false;
      }
    }
    const operation = parseDecisionOperation(option);
    if (operation && !isDecisionOperation(operation)) {
      this.notice("That card describes an unsupported operation. Choose another card.");
      return false;
    }
    if (operation?.kind === "invoke_capability" && operation.capabilityId !== "computer-use") {
      this.notice("That operation is not supported by the current host.");
      return false;
    }
    return true;
  }

  private applyTaskOperation(option: PromptViewState["options"][number]): void {
    if (config.settings.taskAwareCards !== true) return;
    // Active-task controls are host-owned UI commands. They are handled by
    // handleTaskAction and must not be recorded as model-proposed operations.
    if (option.semanticGroup === "task_action") return;
    const operation = parseDecisionOperation(option);
    if (!operation) return;
    switch (operation.kind) {
      case "set_goal":
        if (this.taskStore.current()) this.taskStore.dispatch({ type: "set_goal", goal: operation.goal, provenance: "user_selected", evidence: option.label });
        else this.taskStore.create(operation.goal);
        break;
      case "add_requirement":
        if (!this.taskStore.current()) this.taskStore.create(null);
        this.taskStore.dispatch({ type: "add_requirement", name: operation.name, value: operation.value, provenance: "user_selected", evidence: option.label });
        break;
      case "replace_requirement":
        if (!this.taskStore.current()) this.taskStore.create(null);
        this.taskStore.dispatch({ type: "replace_requirement", name: operation.name, value: operation.value, provenance: "user_selected", evidence: option.label });
        break;
      case "select_reference": {
        const object = this.objectRegistry.get(operation.referenceId);
        if (object) this.taskStore.dispatch({ type: "select_reference", reference: { objectId: object.id, source: object.source, locator: object.url ?? object.id, objectRevision: object.revision, observedAt: object.observedAt, label: object.label } });
        break;
      }
      case "invoke_capability":
      case "inspect_artifact":
        if (this.taskStore.current()) this.taskStore.dispatch({ type: "add_proposal", operation: option.operation ?? option.continuation ?? operation.kind });
        break;
    }
  }

  /** Handle active-task controls locally; these controls do not need a new decoder request. */
  private async handleTaskAction(option: PromptViewState["options"][number]): Promise<boolean> {
    if (config.settings.taskAwareCards !== true || option.semanticGroup !== "task_action") return false;
    const operation = parseDecisionOperation(option);
    const action = operation?.kind === "invoke_capability"
      ? String(operation.arguments.task_action ?? "")
      : operation?.kind === "inspect_artifact"
        ? "review"
        : operation?.kind === "task_action"
          ? operation.action
        : "";
    if (action === "continue") {
      const task = this.taskStore.current();
      if (!task?.goal) {
        this.notice("The active task has no accepted goal to continue.");
        return true;
      }
      if (!this.machine.transition("intentReady")) return true;
      this.broadcast({ type: "executing", status: { taskId: task.taskId, statusText: "Continuing active task…", stepIndex: 0, stepCount: 1 } });
      void this.startExecution(task.goal, task.taskId);
      return true;
    }
    if (action === "review") {
      const artifact = this.taskStore.current()?.artifacts.at(-1);
      const message = artifact ? `Current result: ${artifact.observation}` : "No verified result is attached to the active task yet.";
      this.notice(message);
      this.speak(message);
      return true;
    }
    if (action === "new") {
      this.taskStore.discard();
      this.engine.setTask(null);
      const view = await this.engine.start(this.context.current());
      this.publishPrompt(view);
      return true;
    }
    if (action === "change") {
      this.taskStore.discard();
      this.engine.setTask(null);
      const view = await this.engine.start(this.context.current());
      this.publishPrompt(view);
      this.notice("Choose the changed instruction from the new cards.");
      return true;
    }
    return false;
  }

  async prefetchOption(quadrant: "A" | "B" | "C" | "D"): Promise<void> {
    if (this.machine.state !== "SEMANTIC" || this.semanticRequestInFlight) return;
    const prefetchToken = ++this.prefetchRequestToken;
    const generation = this.sessionGeneration;
    try {
      await this.sessionPreparation;
      if (prefetchToken !== this.prefetchRequestToken || generation !== this.sessionGeneration || this.machine.state !== "SEMANTIC" || this.semanticRequestInFlight) return;
      await this.engine.prefetchOption(quadrant);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[decoder] ${JSON.stringify({ event: "prefetch_preparation_failed", message })}`);
    }
  }

  async more(): Promise<void> {
    if (!this.machine.can("more")) return;
    this.prefetchRequestToken += 1;
    const requestToken = this.beginSemanticRequest();
    if (requestToken === null) return;
    this.acknowledgeSelection("More choices", true);
    if (this.lastPromptView?.mode === "clarify") {
      this.clarifyRejects += 1;
      if (this.clarifyRejects >= 2) {
        // Keep proposing gaze-selectable semantic choices after repeated
        // clarification rejection.
        this.clarifyRejects = 0;
        try {
          await this.sessionPreparation;
          if (requestToken !== this.semanticRequestToken) return;
          await this.engine.continueGuessing();
        } catch (error) {
          if (requestToken === this.semanticRequestToken) this.fail(error);
        } finally {
          this.finishSemanticRequest(requestToken);
        }
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
    const decoding = this.machine.state === "DECODING_ALT";
    if ((!this.machine.can("back") && !decoding) || this.machine.state === "PASSIVE") return;
    if (this.semanticRequestInFlight || decoding) {
      this.semanticRequestToken += 1;
      this.semanticRequestInFlight = false;
      this.engine.cancelPending();
      if (decoding) this.machine.set("SEMANTIC");
    }
    this.prefetchRequestToken += 1;
    this.acknowledgeSelection("Back", true);
    try {
      await this.engine.back();
    } catch (error) {
      this.fail(error);
    }
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
    this.prefetchRequestToken += 1;
    this.semanticRequestToken += 1;
    this.semanticRequestInFlight = false;
    this.sessionPreparation = Promise.resolve();
    this.machine.transition("exit");
    this.engine.exit();
    this.context.disableSession();
    this.semanticSelectionCount = 0;
    this.acknowledgeSelection("Exit");
    this.broadcast({ type: "state", state: this.machine.state });
  }

  private handleIntent(intent: string): void {
    const acceptedTask = this.taskStore.create(intent);
    const task = this.taskStore.observeContext(this.context.current() ?? {
      access: "disabled",
      sessionId: null,
      revision: 0,
      window: null,
      surfaceType: "unknown",
      attentionAnchor: null,
      capturedImageDataUrl: null,
      capturedWidth: 0,
      capturedHeight: 0,
      capturedAt: null,
      activeAppDisplayName: "None",
      approvedApp: false,
      contextScope: "app",
      sources: [],
      references: [],
      focusedElement: null,
      selectedText: null,
      visibleText: null,
    }) ?? acceptedTask;
    if (this.machine.can("intentReady")) {
      this.machine.transition("intentReady");
    } else if (this.machine.state === "SEMANTIC" || this.machine.state === "DECODING_ALT") {
      this.machine.transition("intentReady");
    }
    if (this.machine.state !== "EXECUTING") {
      this.fail(new Error("The completed intent could not enter execution."));
      return;
    }
    this.broadcast({ type: "executing", status: { taskId: "pending", statusText: "Starting…", stepIndex: 0, stepCount: 1 } });
    void this.startExecution(intent, task.taskId);
  }

  // ---- execution ----

  private async startExecution(intent: string, taskId?: string): Promise<void> {
    const storedTask = this.taskStore.current();
    if (storedTask) {
      for (const reference of storedTask.references) {
        const result = this.objectRegistry.revalidate(reference.objectId, reference.objectRevision);
        if (!result.ok) {
          this.fail(new Error(`The selected target is no longer valid: ${result.reason}`));
          return;
        }
      }
    }
    const task: ExecutedTask = {
      taskId: taskId ?? randomUUID(),
      naturalLanguagePrompt: intent,
      startedAt: Date.now(),
      mode: "live",
      taskRevision: storedTask?.revision ?? this.taskStore.current()?.revision,
      referenceRevisions: Object.fromEntries((storedTask?.references ?? this.taskStore.current()?.references ?? []).map((reference) => [reference.objectId, reference.objectRevision ?? ""])),
    };
    this.pendingTask = task;
    const callbacks = {
      onEvent: (e: ExecutorEvent) => this.onExecutorEvent(e),
      requestConsequentialConfirmation: async (state: ConsequentialState) => (await this.handleConsequential(state)) === "approve",
      requestConsequentialChoice: (state: ConsequentialState) => this.handleConsequential(state),
      requestSteering: (taskInner: ExecutedTask, statusText: string) => this.handleSteering(taskInner, statusText),
    };
    this.executor = new OpenAIComputerUseExecutor(
      config.settings.executorModel,
      this.screenWidthValue,
      this.screenHeightValue,
      {
        recordingMode: config.settings.hootsRecordingMode === true,
        filteredCaptureHost: this.astraCaptureHost,
        excludedProcessIds: this.overlayProcessIds,
      },
    );
    if (!this.executor.available) {
      this.notice("OpenAI Computer Use is unavailable. Set OPENAI_API_KEY to execute desktop actions.");
      this.executor = null;
      this.taskStore.dispatch({ type: "set_execution", status: "failed", operationId: task.taskId, checkpoint: "Executor credentials are unavailable." });
      this.fail(new Error("OpenAI Computer Use requires OPENAI_API_KEY."));
      return;
    }
    this.taskStore.dispatch({ type: "set_execution", status: "running", operationId: task.taskId });
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
        this.broadcast({
          type: "executing",
          status: { taskId: e.taskId, statusText: e.text ?? "Working…", stepIndex: e.stepIndex ?? 0, stepCount: e.stepCount ?? 1 },
        });
        break;
      case "consequential_pending":
        break;
      case "completed":
        this.taskStore.dispatch({ type: "set_execution", status: "completed", operationId: e.taskId });
        const completionGeneration = this.sessionGeneration;
        this.broadcast({ type: "sprite", sprite: "success" });
        this.broadcast({ type: "executing", status: { taskId: e.taskId, statusText: e.text ?? "Done.", stepIndex: 1, stepCount: 1 } });
        this.machine.transition("completed");
        this.broadcast({ type: "state", state: "COMPLETE" });
        this.speak(e.text ?? "Task completed.");
        setTimeout(() => {
          if (this.sessionGeneration !== completionGeneration || this.pendingTask?.taskId !== e.taskId) return;
          this.context.disableSession();
          this.machine.transition("optionsReady");
          this.broadcast({ type: "state", state: "PASSIVE" });
          this.broadcast({ type: "sprite", sprite: "idle" });
        }, 1400);
        break;
      case "interrupted":
        this.broadcast({ type: "sprite", sprite: "interrupted" });
        break;
      case "stopped":
        this.taskStore.dispatch({ type: "set_execution", status: "stopped", operationId: e.taskId });
        this.broadcast({ type: "sprite", sprite: "idle" });
        if (this.routingToCorrection || this.suppressedStoppedTaskIds.delete(e.taskId)) return;
        this.context.disableSession();
        this.machine.set("PASSIVE");
        this.broadcast({ type: "state", state: "PASSIVE" });
        this.speak(e.text ?? "Stopped.");
        break;
      case "error":
        this.taskStore.dispatch({ type: "set_execution", status: "failed", operationId: e.taskId, checkpoint: e.text ?? null });
        this.fail(new Error(e.text ?? "executor error"));
        break;
    }
  }

  private handleConsequential(state: ConsequentialState): Promise<"approve" | "change" | "cancel"> {
    this.machine.transition("consequentialPending");
    this.taskStore.dispatch({ type: "set_execution", status: "awaiting_user", operationId: state.taskId, pendingDecision: state.pendingActionSummary });
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
    this.taskStore.dispatch({ type: "set_execution", status: "pause_requested", operationId: task.taskId, checkpoint: statusText });
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
    const spokenChoice = choice === "continue" ? "Continue" : choice === "stop" ? "Stop" : choice === "go_back" ? "Go back" : "Change something";
    this.acknowledgeSelection(spokenChoice);
    const resolver = this.steeringResolver;
    this.steeringResolver = null;
    if (choice === "continue") {
      this.machine.transition("steerContinue");
      this.broadcast({ type: "state", state: "EXECUTING" });
      this.broadcast({ type: "executing", status: { taskId: this.pendingTask?.taskId ?? "task", statusText: "Continuing from the paused action…", stepIndex: 0, stepCount: 1 } });
      if (resolver) resolver("continue");
      this.taskStore.dispatch({ type: "set_execution", status: "running", operationId: this.pendingTask?.taskId ?? null });
      return;
    }
    if (choice === "stop") {
      this.machine.transition("steerStop");
      this.broadcast({ type: "state", state: "PASSIVE" });
      this.context.disableSession();
      this.speak("Stopped the task.");
      if (resolver) resolver("stop");
      this.taskStore.dispatch({ type: "set_execution", status: "stopped", operationId: this.pendingTask?.taskId ?? null });
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
    const view = choice === "go_back" ? await this.engine.back() : await this.engine.restartComposition();
    this.releaseCorrectionRouting();
    this.broadcast({ type: "state", state: "SEMANTIC" });
    this.publishPrompt(view);
    this.speak(choice === "go_back" ? "Let's go back and revise the task." : "Let's try something else.");
  }

  // ---- consequential decision ----

  async consequentialChoice(choice: string, readAgain = false): Promise<void> {
    if (this.machine.state !== "CONSEQUENTIAL_CONFIRMATION") return;
    const spokenChoice = choice === "approve" ? "Approve" : choice === "cancel" ? "Cancel" : choice === "read" ? "Read or explain" : "Change";
    this.acknowledgeSelection(spokenChoice);
    if (choice === "approve") {
      this.speak("Approved.");
      const resolver = this.takeConsequentialResolver();
      this.machine.transition("approveConsequential");
      this.currentConsequential = null;
      this.broadcast({ type: "state", state: "EXECUTING" });
      this.taskStore.dispatch({ type: "set_execution", status: "running", operationId: this.pendingTask?.taskId ?? null, pendingDecision: null });
      if (resolver) resolver("approve");
    } else if (choice === "cancel") {
      const resolver = this.takeConsequentialResolver();
      this.machine.transition("cancelConsequential");
      this.currentConsequential = null;
      this.broadcast({ type: "state", state: "PASSIVE" });
      await this.executor?.stop();
      this.context.disableSession();
      this.speak("Cancelled. Nothing was sent.");
      this.taskStore.dispatch({ type: "set_execution", status: "stopped", operationId: this.pendingTask?.taskId ?? null, pendingDecision: null });
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
      const view = await this.engine.restartComposition();
      this.releaseCorrectionRouting();
      this.broadcast({ type: "state", state: "SEMANTIC" });
      this.publishPrompt(view);
      this.speak("The pending action was cancelled. Compose and confirm the changed instruction before running it.");
    }
  }

  private takeConsequentialResolver(): ((decision: "approve" | "change" | "cancel") => void) | null {
    const resolver = this.consequentialResolver;
    this.consequentialResolver = null;
    return resolver;
  }

  async recovery(choice: string): Promise<void> {
    this.acknowledgeSelection(choice === "retry" ? "Try again" : choice === "go_back" ? "Go back" : choice === "choose_else" ? "Choose something else" : "Stop");
    if (choice === "retry") {
      if (!this.machine.transition("recoveryRetry")) return;
      this.broadcast({ type: "state", state: "AGENT_LOADING" });
      await this.loadSession();
      return;
    }
    this.pendingTask = null;
    if (choice === "go_back" || choice === "choose_else") {
      const trigger = choice === "go_back" ? "recoveryBack" : "recoveryChoose";
      if (!this.machine.transition(trigger)) return;
      const view = choice === "go_back" ? await this.engine.back() : await this.engine.restartComposition();
      this.broadcast({ type: "state", state: "SEMANTIC" });
      this.publishPrompt(view);
      this.speak(choice === "go_back" ? "Let's return to the previous step." : "Choose a different instruction.");
      return;
    }
    this.machine.transition("recoveryStop");
    await this.executor?.stop();
    this.context.disableSession();
    this.executor = null;
    this.engine.exit();
    this.broadcast({ type: "state", state: "PASSIVE" });
    this.speak("Stopped.");
  }

  private releaseCorrectionRouting(): void {
    // The executor reports its stopped event after the correction promise resolves.
    // Keep the guard through that microtask so it cannot replace the semantic view.
    setTimeout(() => { this.routingToCorrection = false; }, 0);
  }

  // ---- misc ----

  private fail(err: unknown): void {
    const text = err instanceof Error ? err.message : String(err);
    this.lastError = text.slice(0, 240);
    this.publishInteractionSnapshot();
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

  private acknowledgeSelection(label: string, speakFeedback = true): void {
    this.stopSpeech();
    this.cue("selection");
    if (speakFeedback) this.speak(spokenSelectionFeedback(label));
  }

  private stopSpeech(): void {
    this.tts.stop();
    this.broadcast({ type: "speech-stop" });
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
