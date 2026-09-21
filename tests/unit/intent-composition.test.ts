import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyIntentPatch, applySemanticFragment, createIntentFrame } from "../../src/shared/intent";
import { CandidateRanker } from "../../src/main/prompt-completion/CandidateRanker";
import { ContextLedger } from "../../src/main/context/ContextLedger";
import { contextPredictionOptions } from "../../src/main/context/ContextPrediction";
import { TargetResolver } from "../../src/main/context/TargetResolver";
import { compileTask } from "../../src/main/task/TaskCompiler";
import type { ContextSnapshot, RawCandidate } from "../../src/shared/types";

describe("typed intent composition", () => {
  it("keeps user-selected values authoritative over model proposals", () => {
    let frame = applySemanticFragment(createIntentFrame(), "action=open;target=Calendar", "user_selected", 1, "OPEN CALENDAR");
    frame = applyIntentPatch(frame, { target: "Spotify" }, "model_inference", 2);
    expect(frame.target?.value).toBe("Calendar");
    expect(frame.target?.source).toBe("user_selected");
  });

  it("compiles semantic fields without trusting decoder wording", () => {
    const frame = applySemanticFragment(createIntentFrame(), "action=play;target=song;target=Spotify;operation=play_song;title=Blue Monday", "user_selected", 1);
    expect(compileTask(frame).prompt).toContain("Blue Monday");
    expect(compileTask(frame).prompt).toContain("Spotify");
  });

  it("keeps user-approved coding details in the executable prompt", () => {
    let frame = applySemanticFragment(
      createIntentFrame(),
      "action=create;project=Hoots;language=TypeScript;framework=React;files=src/App.tsx;requirement=use a keyboard-free flow",
      "user_selected",
      1,
    );
    frame = applyIntentPatch(frame, { framework: "model guessed framework" }, "model_inference", 2);
    const compiled = compileTask(frame);
    expect(compiled.ready).toBe(true);
    expect(compiled.prompt).toContain("Project: Hoots");
    expect(compiled.prompt).toContain("Language: TypeScript");
    expect(compiled.prompt).toContain("Framework: React");
    expect(compiled.prompt).toContain("Files: src/App.tsx");
    expect(compiled.prompt).toContain("Requirement: use a keyboard-free flow");
    expect(compiled.prompt).not.toContain("model guessed framework");
  });

  it("ranks a hypothesis pool into four diverse semantic cards", () => {
    const frame = applySemanticFragment(createIntentFrame(), "action=find", "user_selected", 1, "FIND");
    const candidates: RawCandidate[] = Array.from({ length: 8 }, (_, index) => ({
      id: `candidate-${index}`,
      label: `OPTION ${index}`,
      continuation: `detail=option_${index}`,
      resultingPrompt: `Find option ${index}…`,
      modelScore: 0.99 - index / 100,
      type: "continuation",
      semanticGroup: `group-${index}`,
      estimatedLikelihood: 0.1,
      introducesNewMeaning: false,
    }));
    const result = new CandidateRanker().rank({ candidates, frame });
    expect(result.display).toHaveLength(4);
    expect(result.display.some((option) => option.label.includes("ADD A CLUE"))).toBe(false);
  });

  it("keeps the context ledger bounded and open-world", () => {
    const ledger = new ContextLedger(2);
    ledger.enable("session");
    ledger.addObservation({ id: "one", source: "foreground_context", kind: "app", label: "Notes", appName: "Notes", observedAt: 1 });
    ledger.addObservation({ id: "two", source: "recent_context", kind: "document", label: "Draft", appName: "Notes", observedAt: 2 });
    ledger.addObservation({ id: "three", source: "background_context", kind: "document", label: "Other", appName: null, observedAt: 3 });
    expect(ledger.digest().observations.map((entry) => entry.id)).toEqual(["two", "three"]);
    expect(ledger.digest().active).toBe(true);
  });

  it("resolves known targets without treating misses as exclusions", () => {
    const resolver = new TargetResolver({ installedApps: [{ name: "Calendar", bundleId: "com.apple.Calendar" }] });
    expect(resolver.resolveOne("calendar")?.entityId).toBe("com.apple.Calendar");
    expect(resolver.resolve("an app that is not indexed")).toEqual([]);
  });

  it("discovers closed local applications and recent files during warmup", async () => {
    const root = await mkdtemp(join(tmpdir(), "hoots-resolver-"));
    const apps = join(root, "Applications");
    const recent = join(root, "Documents");
    await mkdir(join(apps, "Figma.app"), { recursive: true });
    await mkdir(recent, { recursive: true });
    await writeFile(join(recent, "biology-notes.pdf"), "fixture");
    try {
      const resolver = new TargetResolver({ appDirectories: [apps], recentDirectories: [recent] });
      await resolver.warmup();
      expect(resolver.resolveOne("figma")?.kind).toBe("app");
      expect(resolver.resolveOne("biology-notes")?.kind).toBe("file");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps useful foreground context as a proposal source without making it authorization", () => {
    const snapshot: ContextSnapshot = {
      access: "active",
      sessionId: "context-session",
      revision: 3,
      window: {
        appName: "Spotify",
        bundleId: "com.spotify.client",
        windowTitle: "Now Playing",
        windowId: 1,
        bounds: { x: 0, y: 0, width: 900, height: 700 },
        screenWidth: 1470,
        screenHeight: 956,
      },
      surfaceType: "media_player",
      attentionAnchor: null,
      capturedImageDataUrl: null,
      capturedWidth: 0,
      capturedHeight: 0,
      capturedAt: null,
      activeAppDisplayName: "Spotify",
      approvedApp: true,
      contextScope: "app",
      sources: [],
      references: [],
      focusedElement: null,
      selectedText: null,
      visibleText: null,
    };
    const options = contextPredictionOptions(snapshot);
    expect(options?.map((option) => option.label)).toEqual([
      "CONTINUE PLAYBACK IN SPOTIFY",
      "SEARCH SPOTIFY",
      "OPEN SPOTIFY",
      "CHOOSE A TRACK OR PLAYLIST",
    ]);
    expect(options?.[0].intentPatch?.action).toBe("play");
    expect(options?.[0].referenceId).toBeUndefined();
  });
});
