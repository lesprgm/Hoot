import { describe, expect, it, vi } from "vitest";
import type { DecoderProvider } from "../../src/main/prompt-completion/DecoderProvider";
import { CandidateValidator } from "../../src/main/prompt-completion/CandidateValidator";
import { FixtureDecoderProvider } from "../../src/main/prompt-completion/FixtureDecoderProvider";
import { DEFAULT_LEXICON, IntentCompositionEngine, type EngineEvents } from "../../src/main/prompt-completion/IntentCompositionEngine";
import type { AppSettings, ContextSnapshot, DecoderInput, DecoderResponse, DisplayOption, PromptViewState } from "../../src/shared/types";
import { createTaskRecord } from "../../src/shared/task";
import { applySemanticFragment, createIntentFrame } from "../../src/shared/intent";

export const TEST_SETTINGS: AppSettings = {
  gazeDwellMs: 550,
  agentSummonDwellMs: 900,
  noneDwellMs: 700,
  cancelDwellMs: 900,
  gazeEmaAlpha: 0.28,
  prefetchEnabled: false,
  reducedAnimation: false,
  decoderModel: "deepseek/deepseek-v4-flash-0731",
  executorModel: "gpt-6-astra",
  ttsModel: "eleven_flash_v2_5",
  ttsStability: 0.46,
  ttsSimilarityBoost: 0.8,
  ttsStyle: 0.05,
  ttsUseSpeakerBoost: false,
  ttsSpeed: 1,
};

export function blankEvents(intents: string[], views: PromptViewState[]): EngineEvents {
  return {
    onView: (v) => views.push(v),
    onIntent: (t) => intents.push(t),
    onBusy: () => {},
  };
}

describe("semantic candidate validation", () => {
  it("validates structured candidates without requiring wording preservation", () => {
    const validator = new CandidateValidator();
    const input: DecoderInput = {
      displayPrompt: "I want you to open Spotify…",
      explicitSemanticEvidence: ["action=open", "target=Spotify"],
      rejectedSets: [],
      historyDepth: 2,
      userLexicon: DEFAULT_LEXICON,
      optionalContext: { activeApp: null, activeAppUrl: null, surfaceType: null, visibleReferent: null, gazeTargetDescription: null, capturedImageDataUrl: null },
      consecutiveNoneCount: 0,
      clarificationAnswers: [],
      turn: 2,
      intentFrame: applySemanticFragment(createIntentFrame(), "action=open;target=Spotify", "user_selected", 1),
    };
    const response: DecoderResponse = {
      mode: "predict",
      normalizedPrompt: "Launch the music application…",
      promptIsExecutable: false,
      openSlots: [],
      candidates: ["launch", "use", "play", "browse"].map((id, index) => ({
        id,
        label: id.toUpperCase(),
        continuation: `operation=${id}`,
        resultingPrompt: "A different safe paraphrase…",
        modelScore: 0.9 - index * 0.05,
        type: "continuation",
        semanticGroup: id,
        estimatedLikelihood: 0.9 - index * 0.05,
        introducesNewMeaning: false,
        intentPatch: { operation: id },
      })),
    };
    expect(validator.validateSemantic(input, response, input.intentFrame!).valid).toBe(true);
  });

  it("rejects duplicate candidate ids as a structural error", () => {
    const validator = new CandidateValidator();
    const input = { intentFrame: createIntentFrame() } as DecoderInput;
    const response = new FixtureDecoderProvider().generate({
      displayPrompt: "I want you to…",
      explicitSemanticEvidence: [],
      rejectedSets: [],
      historyDepth: 0,
      userLexicon: DEFAULT_LEXICON,
      optionalContext: { activeApp: null, activeAppUrl: null, surfaceType: null, visibleReferent: null, gazeTargetDescription: null, capturedImageDataUrl: null },
      consecutiveNoneCount: 0,
      clarificationAnswers: [],
      turn: 0,
    });
    response.candidates[1].id = response.candidates[0].id;
    const report = validator.validateSemantic(input, response, input.intentFrame!);
    expect(report.valid).toBe(false);
    expect(report.errors.join(" ")).toContain("duplicate candidate id");
  });
});

describe("four-option provider display", () => {
  it("keeps the configured OpenRouter provider explicit", () => {
    const engine = new IntentCompositionEngine(blankEvents([], []), TEST_SETTINGS, true, "openrouter");
    expect(engine.getProviderName()).toBe("openrouter-deepseek-v4-flash");
  });

  it("preserves OpenRouter's conditioned top four even when they share a semantic group", async () => {
    const views: PromptViewState[] = [];
    const engine = new IntentCompositionEngine(blankEvents([], views), TEST_SETTINGS, false, "openrouter");
    const labels = ["RECENT FILE", "DOWNLOADED FILE", "SHARED FILE", "FILE BY NAME"];
    const response: DecoderResponse = {
      mode: "predict",
      normalizedPrompt: "I want you to find…",
      promptIsExecutable: false,
      openSlots: [{ name: "object", description: "what to find" }],
      candidates: labels.map((label, index) => ({
        id: `conditioned_${index}`,
        label,
        continuation: `object=file_${index}`,
        resultingPrompt: `I want you to find ${label.toLowerCase()}…`,
        modelScore: 0.9 - index * 0.1,
        type: "continuation" as const,
        semanticGroup: "object",
        estimatedLikelihood: 0.9 - index * 0.1,
        introducesNewMeaning: false,
      })),
    };
    const provider: DecoderProvider = {
      name: "fake-openrouter",
      generateCandidates: vi.fn(async () => response),
      generateClarification: vi.fn(async () => ({ spokenQuestion: "Which?", answers: [] })),
    };
    (engine as unknown as { provider: DecoderProvider }).provider = provider;

    await engine.start(null);
    await engine.selectOption("A");

    expect(views[views.length - 1].options.map((option) => option.label)).toEqual(labels);
  });

  it("adds a host-owned RUN THIS card when accepted intent is complete", async () => {
    const views: PromptViewState[] = [];
    const engine = new IntentCompositionEngine(blankEvents([], views), TEST_SETTINGS, false, "openrouter");
    const response: DecoderResponse = {
      mode: "predict",
      normalizedPrompt: "I want you to find…",
      promptIsExecutable: false,
      openSlots: [],
      candidates: ["RECENT FILE", "DOWNLOADED FILE", "SHARED FILE", "FILE BY NAME"].map((label, index) => ({
        id: `complete_${index}`,
        label,
        continuation: `object=${label.toLowerCase()}`,
        resultingPrompt: `I want you to find ${label.toLowerCase()}…`,
        modelScore: 0.9 - index * 0.1,
        type: "continuation" as const,
        semanticGroup: `object_${index}`,
        estimatedLikelihood: 0.9 - index * 0.1,
        introducesNewMeaning: false,
      })),
    };
    const provider: DecoderProvider = {
      name: "fake-complete",
      generateCandidates: vi.fn(async () => response),
      generateClarification: vi.fn(async () => ({ spokenQuestion: "Which?", answers: [] })),
    };
    (engine as unknown as { provider: DecoderProvider }).provider = provider;

    await engine.start(null);
    await engine.selectOption("A");

    const next = views[views.length - 1];
    expect(next.options).toHaveLength(4);
    expect(next.options.at(-1)?.label).toBe("RUN THIS");
    expect(next.options.at(-1)?.type).toBe("do_that");
  });

  it("routes an approved screenshot to direct Gemini when vision is enabled", async () => {
    const engine = new IntentCompositionEngine(
      blankEvents([], []),
      { ...TEST_SETTINGS, visionDecoderProvider: "gemini" },
      true,
      "openrouter",
    );
    const fixture = new FixtureDecoderProvider();
    const primary: DecoderProvider = {
      name: "primary-text",
      generateCandidates: vi.fn(async (input) => fixture.generate(input)),
      generateClarification: vi.fn(async () => ({ spokenQuestion: "Which?", answers: [] })),
    };
    const vision: DecoderProvider = {
      name: "direct-gemini-vision",
      generateCandidates: vi.fn(async (input) => fixture.generate(input)),
      generateClarification: vi.fn(async () => ({ spokenQuestion: "Which?", answers: [] })),
    };
    const context = {
      access: "active" as const,
      sessionId: "vision-session",
      revision: 1,
      window: null,
      surfaceType: "unknown" as const,
      attentionAnchor: null,
      capturedImageDataUrl: "data:image/png;base64,ZmFrZQ==",
      capturedWidth: 1,
      capturedHeight: 1,
      capturedAt: 1,
      activeAppDisplayName: "Notes",
      approvedApp: true,
      contextScope: "app" as const,
      sources: [],
      references: [],
      focusedElement: null,
      selectedText: null,
      visibleText: null,
    } satisfies ContextSnapshot;
    const internals = engine as unknown as { provider: DecoderProvider; visionProvider: DecoderProvider | null };
    internals.provider = primary;
    internals.visionProvider = vision;

    await engine.start(context);
    await engine.selectOption("A");

    expect(vision.generateCandidates).toHaveBeenCalledOnce();
    expect(primary.generateCandidates).not.toHaveBeenCalled();
  });
});

describe("fixture decoder — blank desktop prompt", () => {
  it("opens immediately with broad action families instead of guessed tasks", async () => {
    const views: PromptViewState[] = [];
    const engine = new IntentCompositionEngine(blankEvents([], views), TEST_SETTINGS, false);

    const root = await engine.start(null);

    expect(root.displayPrompt).toBe("I want you to…");
    expect(root.options.map((option) => option.label)).toEqual([
      "FIND / LEARN…",
      "CREATE / CHANGE…",
      "OPEN / CONTROL…",
      "SEND / TELL…",
    ]);
  });

  it("uses a strong foreground surface for immediate whole-intent proposals", async () => {
    const engine = new IntentCompositionEngine(blankEvents([], []), TEST_SETTINGS, false);
    const context: ContextSnapshot = {
      access: "active",
      sessionId: "session",
      revision: 1,
      window: {
        appName: "Notes",
        bundleId: "com.apple.Notes",
        windowTitle: "Meeting notes",
        windowId: 1,
        bounds: { x: 0, y: 0, width: 900, height: 700 },
        screenWidth: 1470,
        screenHeight: 956,
      },
      surfaceType: "document_or_article",
      attentionAnchor: null,
      capturedImageDataUrl: null,
      capturedWidth: 0,
      capturedHeight: 0,
      capturedAt: null,
      activeAppDisplayName: "Notes",
      approvedApp: true,
      contextScope: "app",
      sources: [],
      references: [],
      focusedElement: null,
      selectedText: null,
      visibleText: null,
    };

    const view = await engine.start(context);

    expect(view.options.map((option) => option.label)).toEqual([
      "SUMMARIZE THIS",
      "READ / EXPLAIN THIS",
      "FIND SOMETHING IN THIS",
      "CHANGE THIS",
    ]);
    expect(view.options[0].intentPatch?.action).toBe("summarize");
  });

  it("confirms the validated terminal prompt rather than a stale session display", async () => {
    const intents: string[] = [];
    const engine = new IntentCompositionEngine(blankEvents(intents, []), TEST_SETTINGS, false);
    await engine.start(null);
    const internals = engine as unknown as {
      session: { displayPrompt: string };
      currentNode: { displayedCandidates: DisplayOption[] };
    };
    internals.session.displayPrompt = "I want you to open…";
    internals.currentNode.displayedCandidates = [{
      id: "media_open_spotify",
      quadrant: "A",
      label: "JUST OPEN SPOTIFY",
      resultingPrompt: "I want you to open Spotify",
      type: "do_that",
      semanticGroup: "media_open",
      continuation: "",
    }];

    await engine.selectOption("A");

    expect(intents).toEqual(["I want you to open Spotify"]);
  });

  it("reuses a targeted prefetch when a semantic card is selected", async () => {
    const views: PromptViewState[] = [];
    const engine = new IntentCompositionEngine(
      blankEvents([], views),
      { ...TEST_SETTINGS, prefetchEnabled: true },
      false,
    );

    const root = await engine.start(null);
    await engine.prefetchOption("A");
    await engine.selectOption("A");

    expect(views[views.length - 1].displayPrompt).toContain("find");
    expect(root.options).toHaveLength(4);
  });

  it("waits for an in-flight targeted prefetch instead of duplicating the request", async () => {
    const views: PromptViewState[] = [];
    const engine = new IntentCompositionEngine(
      blankEvents([], views),
      { ...TEST_SETTINGS, prefetchEnabled: true },
      false,
    );
    const provider = (engine as unknown as { provider: FixtureDecoderProvider }).provider;
    const originalGenerate = provider.generateCandidates.bind(provider);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    vi.spyOn(provider, "generateCandidates").mockImplementation(async (input) => {
      calls += 1;
      await gate;
      return originalGenerate(input);
    });

    await engine.start(null);
    const prefetch = engine.prefetchOption("A");
    expect(calls).toBe(1);
    const selection = engine.selectOption("A");
    await Promise.resolve();
    expect(calls).toBe(1);

    release();
    await Promise.all([prefetch, selection]);
    expect(calls).toBe(1);
  });

  it("completes a full prompt without any screen context using only semantic selections", async () => {
    const intents: string[] = [];
    const views: PromptViewState[] = [];
    const engine = new IntentCompositionEngine(blankEvents(intents, views), TEST_SETTINGS, false);

    const root = await engine.start(null);
    const findOption = optionIn(root, "FIND");
    await engine.selectOption(findOption.quadrant);

    const view1 = views[views.length - 1];
    const fileOption = optionIn(view1, "FILE");
    await engine.selectOption(fileOption.quadrant);

    const view2 = views[views.length - 1];
    const downloaded = optionIn(view2, "DOWNLOADED");
    await engine.selectOption(downloaded.quadrant);

    const view3 = views[views.length - 1];
    const yesterday = optionIn(view3, "YESTERDAY");
    await engine.selectOption(yesterday.quadrant);

    const view4 = views[views.length - 1];
    const summarize = optionIn(view4, "SUMMARIZE");
    await engine.selectOption(summarize.quadrant);

    const view5 = views[views.length - 1];
    const methods = optionIn(view5, "METHODS");
    await engine.selectOption(methods.quadrant);

    const view6 = views[views.length - 1];
    const email = optionIn(view6, "EMAIL THE SUMMARY");
    await engine.selectOption(email.quadrant);

    const view7 = views[views.length - 1];
    const professorLee = optionIn(view7, "PROFESSOR LEE");
    await engine.selectOption(professorLee.quadrant);

    const view8 = views[views.length - 1];
    const doThat = optionIn(view8, "DO THAT");
    await engine.selectOption(doThat.quadrant);

    expect(intents.length).toBeGreaterThanOrEqual(1);
    const intent = intents[intents.length - 1].toLowerCase();
    expect(intent).toContain("find");
    expect(intent).toContain("file");
    expect(intent).toContain("yesterday");
    expect(intent).toContain("summarize");
    expect(intent).toContain("methods");
    expect(intent).toContain("email");
    expect(intent).toContain("professor lee");
  });

  it("two consecutive MORE actions enter clarification and one answer resumes prediction", async () => {
    const intents: string[] = [];
    const views: PromptViewState[] = [];
    const engine = new IntentCompositionEngine(blankEvents(intents, views), TEST_SETTINGS, false);
    await engine.start(null);

    await engine.more();
    await engine.more();
    const view2 = views[views.length - 1];
    expect(view2.mode).toBe("clarify");
    expect(view2.clarificationQuestion).toBeTruthy();
    expect(view2.options).toHaveLength(4);

    await engine.selectOption(view2.options[0].quadrant);
    const view3 = views[views.length - 1];
    expect(view3.mode).toBe("predict");
  });

  it("continues semantic guessing after clarification is rejected", async () => {
    const views: PromptViewState[] = [];
    const engine = new IntentCompositionEngine(blankEvents([], views), TEST_SETTINGS, false);
    await engine.start(null);
    await engine.more();
    await engine.more();
    expect(views.at(-1)?.mode).toBe("clarify");

    const next = await engine.continueGuessing();
    expect(next.mode).toBe("predict");
    expect(next.options).toHaveLength(4);
  });

  it("enters clarification after two MORE actions when production prefetch is enabled", async () => {
    const intents: string[] = [];
    const views: PromptViewState[] = [];
    const engine = new IntentCompositionEngine(
      blankEvents(intents, views),
      { ...TEST_SETTINGS, prefetchEnabled: true },
      false,
    );

    await engine.start(null);
    await engine.more();
    await engine.more();

    const clarification = views[views.length - 1];
    expect(clarification.mode).toBe("clarify");
    expect(clarification.options).toHaveLength(4);
  });

  it("BACK restores the exact previous option set", async () => {
    const intents: string[] = [];
    const views: PromptViewState[] = [];
    const engine = new IntentCompositionEngine(blankEvents(intents, views), TEST_SETTINGS, false);
    const root = await engine.start(null);
    const labelsBefore = root.options.map((o) => o.label);
    const pick = optionIn(root, "FIND");
    await engine.selectOption(pick.quadrant);
    await engine.back();
    const restored = views[views.length - 1];
    expect(restored.options.map((o) => o.label)).toEqual(labelsBefore);
  });

});

describe("task-aware restored composition", () => {
  it("starts with local task actions when the opt-in flag is enabled", async () => {
    const views: PromptViewState[] = [];
    const engine = new IntentCompositionEngine(
      blankEvents([], views),
      { ...TEST_SETTINGS, taskAwareCards: true },
      false,
    );
    const task = createTaskRecord("Open the project and review the latest draft", "task-restored");
    task.execution.status = "paused";
    engine.setTask(task);

    const view = await engine.start(null);

    expect(view.displayPrompt).toContain("Active task:");
    expect(view.options.map((option) => option.label)).toEqual([
      "CONTINUE CURRENT TASK",
      "REVIEW CURRENT RESULT",
      "CHANGE A DETAIL",
      "START A NEW TASK",
    ]);
    expect(view.options.every((option) => option.operation?.startsWith("{") === true)).toBe(true);
  });
});

function optionIn(view: PromptViewState, needle: string): DisplayOption {
  const found = view.options.find((o) => o.label.toUpperCase().includes(needle.toUpperCase()));
  if (!found) throw new Error(`no option matching "${needle}" in: ${view.options.map((o) => o.label).join(" | ")}`);
  return found;
}
