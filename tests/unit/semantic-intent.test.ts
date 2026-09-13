import { describe, expect, it } from "vitest";
import { composeSemanticPrompt, parseSemanticIntent, requiresLexicalPreservation } from "../../src/main/prompt-completion/SemanticIntent";

describe("structured semantic intent", () => {
  it("retains selected play and song semantics without decoder wording", () => {
    expect(composeSemanticPrompt(["action=play", "target=song"], "Listen to music…"))
      .toBe("I want you to play a song…");
  });

  it("merges a later service delta into the accumulated media intent", () => {
    expect(composeSemanticPrompt(["action=play", "target=song", "target=Spotify"], "Use Spotify…"))
      .toBe("I want you to play a song on Spotify…");
  });

  it("preserves an explicitly selected multi-step action sequence", () => {
    expect(composeSemanticPrompt([
      "action=find",
      "target=file",
      "relation=downloaded",
      "time=yesterday",
      "action=summarize",
      "detail=the methods section",
      "action=email",
      "recipient=Daniel",
    ], "Decoder rewrite…")).toBe(
      "I want you to find a file that I downloaded yesterday, then summarize the methods section, then email the result to Daniel…",
    );
  });

  it("renders deterministic media operations and hides machine-only URLs", () => {
    expect(composeSemanticPrompt([
      "action=open",
      "target=YouTube",
      "operation=play_video;title=Put-that-there;url=https://www.youtube.com/watch?v=RyBEUyEtxQo",
    ], "Play it…")).toBe("I want you to play “Put-that-there” on YouTube…");
  });

  it("parses repeated typed fields without replacing earlier object semantics", () => {
    const intent = parseSemanticIntent(["action=play", "target=song", "target=Spotify"]);
    expect(intent.fields.get("target")).toEqual(["song", "Spotify"]);
  });

  it("leaves lexical preservation only for unstructured legacy evidence", () => {
    expect(requiresLexicalPreservation("action=play")).toBe(false);
    expect(requiresLexicalPreservation("target=song")).toBe(false);
    expect(requiresLexicalPreservation("legacy phrase")).toBe(true);
  });
});
