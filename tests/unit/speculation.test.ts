import { describe, expect, it } from "vitest";
import { SpeculationCache } from "../../src/main/prompt-completion/SpeculationCache";
import type { DecoderResponse } from "../../src/shared/types";

describe("SpeculationCache", () => {
  it("stores and takes entries per scoped slot", () => {
    const cache = new SpeculationCache(true);
    const state = { response: null as never, display: [], createdAt: Date.now(), forKey: "k" };
    // note: response is typed DecoderResponseShape; store a minimal valid object
    const scope = "scope1";
    cache.set(scope, "A", { ...state, response: mockResponse() });
    expect(cache.has(scope, "A")).toBe(true);
    cache.take(scope, "A");
    expect(cache.has(scope, "A")).toBe(false);
  });

  it("invalidates entries after TTL", () => {
    const cache = new SpeculationCache(true);
    const scope = "s";
    cache.set(scope, "B", { response: mockResponse(), display: [], createdAt: Date.now() - 21_000, forKey: scope });
    expect(cache.has(scope, "B")).toBe(false);
  });

  it("invalidateAll clears everything", () => {
    const cache = new SpeculationCache(true);
    cache.set("s1", "A", { response: mockResponse(), display: [], createdAt: Date.now(), forKey: "s1" });
    cache.set("s2", "MORE", { response: mockResponse(), display: [], createdAt: Date.now(), forKey: "s2" });
    cache.invalidateAll();
    expect(cache.size).toBe(0);
  });

  it("key is stable and content-sensitive", () => {
    const a = SpeculationCache.key(["s1", 0, "hello", "x", "y"]);
    const b = SpeculationCache.key(["s1", 0, "hello", "x", "y"]);
    const c = SpeculationCache.key(["s1", 0, "hello", "x", "z"]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

function mockResponse(): DecoderResponse {
  return {
    mode: "predict",
    normalizedPrompt: "I want you to find…",
    promptIsExecutable: false,
    openSlots: [],
    candidates: [
      { id: "a", label: "A", continuation: "x", resultingPrompt: "I want you to find a file…", modelScore: 0.9, type: "continuation", semanticGroup: "g1", estimatedLikelihood: 0.9, introducesNewMeaning: false },
      { id: "b", label: "B", continuation: "y", resultingPrompt: "I want you to search online…", modelScore: 0.8, type: "continuation", semanticGroup: "g2", estimatedLikelihood: 0.8, introducesNewMeaning: false },
      { id: "c", label: "C", continuation: "z", resultingPrompt: "I want you to open mail…", modelScore: 0.7, type: "continuation", semanticGroup: "g3", estimatedLikelihood: 0.7, introducesNewMeaning: false },
      { id: "d", label: "D", continuation: "w", resultingPrompt: "I want you to send…", modelScore: 0.6, type: "continuation", semanticGroup: "g4", estimatedLikelihood: 0.6, introducesNewMeaning: false },
      { id: "e", label: "E", continuation: "v", resultingPrompt: "I want you to ask…", modelScore: 0.5, type: "continuation", semanticGroup: "g5", estimatedLikelihood: 0.5, introducesNewMeaning: false },
    ],
  };
}
