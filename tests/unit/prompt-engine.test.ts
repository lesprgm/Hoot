import { describe, expect, it } from "vitest";
import { OpenAILunaProvider } from "../../src/main/prompt-completion/CandidateGenerator";
import { CandidateValidator } from "../../src/main/prompt-completion/CandidateValidator";
import { CandidateDiversifier, type DiversificationResult } from "../../src/main/prompt-completion/CandidateDiversifier";
import { EmbeddingHub } from "../../src/main/prompt-completion/SemanticEmbeddings";
import { FixtureDecoderProvider } from "../../src/main/prompt-completion/FixtureDecoderProvider";
import { DEFAULT_LEXICON, PromptCompletionEngine, type EngineEvents, type EngineMetrics } from "../../src/main/prompt-completion/PromptCompletionEngine";
import type { AppSettings, DecoderResponse, DisplayOption, PromptViewState } from "../../src/shared/types";

export const TEST_SETTINGS: AppSettings = {
  gazeDwellMs: 550,
  agentSummonDwellMs: 900,
  noneDwellMs: 700,
  cancelDwellMs: 900,
  hintDwellMs: 650,
  gazeEmaAlpha: 0.28,
  autoScrollEnabled: true,
  prefetchEnabled: false,
  ttsPrefetchEnabled: false,
  speakOptionOnHover: false,
  reducedAnimation: false,
  gazeConfidenceMin: 0.5,
  duplicateThreshold: 0.82,
  decoderModel: "gpt-5.6-luna",
  executorModel: "gpt-6-astra",
  ttsModel: "eleven_flash_v2_5",
};

export function blankMetrics(): EngineMetrics {
  return {
    recordSelection: () => {},
    recordNone: () => {},
    recordClarifyAnswer: () => {},
    recordHintChars: () => {},
    recordDecoderLatency: () => {},
    recordPrefetchHit: () => {},
    recordPrefetchMiss: () => {},
    recordPrefetchedUiLatency: () => {},
  };
}

export function blankEvents(intents: string[], views: PromptViewState[]): EngineEvents {
  return {
    onView: (v) => views.push(v),
    onHint: (v) => views.push(v),
    onIntent: (t) => intents.push(t),
    onBusy: () => {},
  };
}

describe("candidate validation", () => {
  it("rejects candidates that drop explicit evidence", () => {
    const validator = new CandidateValidator();
    const input = {
      displayPrompt: "I want you to find a file…",
      explicitSemanticEvidence: ["action=find", "target=file"],
      hints: [],
      rejectedSets: [],
      historyDepth: 1,
      userLexicon: DEFAULT_LEXICON,
      optionalContext: { activeApp: null, activeAppUrl: null, surfaceType: null, visibleReferent: null, gazeTargetDescription: null, capturedImageDataUrl: null },
      consecutiveNoneCount: 0,
      clarificationAnswers: [],
      turn: 2,
    };
    const bad: DecoderResponse = {
      mode: "predict",
      normalizedPrompt: "I want you to find a file…",
      promptIsExecutable: false,
      openSlots: [],
      candidates: [
        { id: "a", label: "YESTERDAY", continuation: "time=yesterday", resultingPrompt: "I want you to find a file yesterday…", modelScore: 0.9, type: "continuation", semanticGroup: "time", estimatedLikelihood: 0.9, introducesNewMeaning: false },
        { id: "b", label: "SOMETHING ELSE", continuation: "", resultingPrompt: "I want you to send…", modelScore: 0.8, type: "continuation", semanticGroup: "coverage", estimatedLikelihood: 0.8, introducesNewMeaning: false },
        { id: "c", label: "A", continuation: "x", resultingPrompt: "I want you to…", modelScore: 0.7, type: "continuation", semanticGroup: "x", estimatedLikelihood: 0.7, introducesNewMeaning: false },
        { id: "d", label: "B", continuation: "y", resultingPrompt: "delete everything…", modelScore: 0.6, type: "continuation", semanticGroup: "y", estimatedLikelihood: 0.6, introducesNewMeaning: true },
        { id: "e", label: "C", continuation: "", resultingPrompt: "I want you to find a file…", modelScore: 0.5, type: "continuation", semanticGroup: "z", estimatedLikelihood: 0.5, introducesNewMeaning: false },
      ],
    };
    const report = validator.validate(input, bad);
    expect(report.valid).toBe(false);
    expect(report.errors.join(" ")).toContain("resultingPrompt lost evidence");
  });

  it("rejects a normalized prompt that drops accepted meaning", () => {
    const validator = new CandidateValidator();
    const input = {
      displayPrompt: "I want you to find a file…",
      explicitSemanticEvidence: ["action=find", "target=file"],
      hints: [],
      rejectedSets: [],
      historyDepth: 1,
      userLexicon: DEFAULT_LEXICON,
      optionalContext: { activeApp: null, activeAppUrl: null, surfaceType: null, visibleReferent: null, gazeTargetDescription: null, capturedImageDataUrl: null },
      consecutiveNoneCount: 0,
      clarificationAnswers: [],
      turn: 2,
    };
    const response = new FixtureDecoderProvider().generate(input);
    response.normalizedPrompt = "I want you to open an email…";

    const report = validator.validate(input, response);

    expect(report.valid).toBe(false);
    expect(report.errors).toContain('normalizedPrompt lost evidence: "find"');
    expect(report.errors).toContain('normalizedPrompt lost evidence: "file"');
  });

  it("rejects duplicate candidate ids", () => {
    const validator = new CandidateValidator();
    const input = {
      displayPrompt: "I want you to…",
      explicitSemanticEvidence: [],
      hints: [],
      rejectedSets: [],
      historyDepth: 0,
      userLexicon: DEFAULT_LEXICON,
      optionalContext: { activeApp: null, activeAppUrl: null, surfaceType: null, visibleReferent: null, gazeTargetDescription: null, capturedImageDataUrl: null },
      consecutiveNoneCount: 0,
      clarificationAnswers: [],
      turn: 0,
    };
    const response = new FixtureDecoderProvider().generate(input);
    response.candidates[1].id = response.candidates[0].id;

    const report = validator.validate(input, response);

    expect(report.valid).toBe(false);
    expect(report.errors.join(" ")).toContain("duplicate candidate id");
  });
});

describe("diversity selection", () => {
  it("keeps distinct semantic branches even when scores are similar", async () => {
    const hub = new EmbeddingHub(false);
    const diversifier = new CandidateDiversifier(hub, 0.5);
    const mk = (id: string, label: string, group: string) => ({
      id,
      label,
      continuation: group,
      resultingPrompt: `I want you to ${label.toLowerCase()}…`,
      modelScore: 0.8,
      type: "continuation" as const,
      semanticGroup: group,
      estimatedLikelihood: 0.8,
      introducesNewMeaning: false,
    });
    const result = await diversifier.selectMany([
      mk("1", "FIND", "find"),
      mk("2", "CREATE", "create"),
      mk("3", "OPEN", "open"),
      mk("4", "SEND", "send"),
      mk("5", "ASK", "ask"),
    ]);
    expect(result.options.length).toBe(4);
    expect(result.rejectedForDuplicate.length).toBeGreaterThanOrEqual(1);
    const groups = result.options.map((o) => o.semanticGroup);
    expect(new Set(groups).size).toBe(4);
  });

  it("prefers the highest-scoring candidate first", async () => {
    const hub = new EmbeddingHub(false);
    const diversifier = new CandidateDiversifier(hub, 0.5);
    const mk = (id: string, label: string, group: string, score: number) => ({
      id,
      label,
      continuation: group,
      resultingPrompt: `I want you to ${label.toLowerCase()}…`,
      modelScore: score,
      type: "continuation" as const,
      semanticGroup: group,
      estimatedLikelihood: score,
      introducesNewMeaning: false,
    });
    const result = await diversifier.selectMany([
      mk("1", "FIND", "find", 0.95),
      mk("2", "CREATE", "create", 0.7),
      mk("3", "OPEN", "open", 0.6),
      mk("4", "SEND", "send", 0.5),
      mk("5", "ASK", "ask", 0.4),
    ]);
    expect(result.options[0].semanticGroup).toBe("find");
  });
});

describe("fixture decoder — blank desktop benchmark prompt", () => {
  it("opens immediately with broad action families instead of guessed tasks", async () => {
    const views: PromptViewState[] = [];
    let decoderCalls = 0;
    const metrics = { ...blankMetrics(), recordDecoderLatency: () => { decoderCalls += 1; } };
    const engine = new PromptCompletionEngine(blankEvents([], views), metrics, TEST_SETTINGS, false);

    const root = await engine.start(null);

    expect(root.displayPrompt).toBe("I want you to…");
    expect(root.options.map((option) => option.label)).toEqual([
      "FIND / LEARN…",
      "CREATE / CHANGE…",
      "OPEN / CONTROL…",
      "SEND / TELL…",
    ]);
    expect(decoderCalls).toBe(0);
  });

  it("completes a full prompt without any screen context using only semantic selections", async () => {
    const intents: string[] = [];
    const views: PromptViewState[] = [];
    const engine = new PromptCompletionEngine(blankEvents(intents, views), blankMetrics(), TEST_SETTINGS, false);

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
    const daniel = optionIn(view7, "DANIEL");
    await engine.selectOption(daniel.quadrant);

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
    expect(intent).toContain("daniel");
  });

  it("two consecutive MORE actions enter clarification and one answer resumes prediction", async () => {
    const intents: string[] = [];
    const views: PromptViewState[] = [];
    const engine = new PromptCompletionEngine(blankEvents(intents, views), blankMetrics(), TEST_SETTINGS, false);
    const root = await engine.start(null);

    await engine.more();
    const view1 = views[views.length - 1];
    await engine.more();
    const view2 = views[views.length - 1];
    expect(view2.mode).toBe("clarify");
    expect(view2.clarificationQuestion).toBeTruthy();
    expect(view2.options).toHaveLength(4);

    await engine.selectOption(view2.options[0].quadrant);
    const view3 = views[views.length - 1];
    expect(view3.mode).toBe("predict");
  });

  it("enters clarification after two MORE actions when production prefetch is enabled", async () => {
    const intents: string[] = [];
    const views: PromptViewState[] = [];
    const engine = new PromptCompletionEngine(
      blankEvents(intents, views),
      blankMetrics(),
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
    const engine = new PromptCompletionEngine(blankEvents(intents, views), blankMetrics(), TEST_SETTINGS, false);
    const root = await engine.start(null);
    const labelsBefore = root.options.map((o) => o.label);
    const pick = optionIn(root, "FIND");
    await engine.selectOption(pick.quadrant);
    await engine.back();
    const restored = views[views.length - 1];
    expect(restored.options.map((o) => o.label)).toEqual(labelsBefore);
  });

  it("hints can disambiguate a named entity", async () => {
    const intents: string[] = [];
    const views: PromptViewState[] = [];
    const engine = new PromptCompletionEngine(blankEvents(intents, views), blankMetrics(), TEST_SETTINGS, false);
    const root = await engine.start(null);
    const send = optionIn(root, "SEND");
    await engine.selectOption(send.quadrant);
    const view1 = views[views.length - 1];
    const email = optionIn(view1, "EMAIL");
    await engine.selectOption(email.quadrant);
    const view2 = views[views.length - 1];
    const hint = optionIn(view2, "HINT");
    await engine.selectOption(hint.quadrant);

    const hinted = await engine.updateHint("dan");
    const daniel = hinted.options.find((o) => o.label.includes("DANIEL"));
    expect(daniel).toBeTruthy();
    await engine.acceptHintCandidate(daniel!.id);
    expect(intents).toHaveLength(0);
    const after = views[views.length - 1];
    expect(after.displayPrompt.toLowerCase()).toContain("daniel");
  });
});

function optionIn(view: PromptViewState, needle: string): DisplayOption {
  const found = view.options.find((o) => o.label.toUpperCase().includes(needle.toUpperCase()));
  if (!found) throw new Error(`no option matching "${needle}" in: ${view.options.map((o) => o.label).join(" | ")}`);
  return found;
}
