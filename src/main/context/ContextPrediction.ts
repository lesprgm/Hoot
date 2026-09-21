import type { IntentPatch } from "../../shared/intent";
import type { ContextReference, ContextSnapshot, DisplayOption, QuadrantId } from "../../shared/types";

const QUADRANTS: QuadrantId[] = ["A", "B", "C", "D"];

/**
 * Returns context-grounded offers for a newly summoned session. These offers
 * remain proposals: selecting one creates user-selected evidence in the
 * composition engine. Context alone never executes a task.
 */
export function contextPredictionOptions(snapshot: ContextSnapshot | null): DisplayOption[] | null {
  if (!isStrongContext(snapshot)) return null;
  const context = snapshot!;
  const app = context.window?.appName?.trim() || "this app";
  const reference = primaryReference(context);
  const target = referenceTarget(reference, app);
  const refProps = reference ? {
    referenceId: reference.id,
    referenceRevision: reference.revision,
    contextRevision: context.revision,
  } : {};
  const surface = context.surfaceType;

  if (surface === "media_player") {
    const video = context.window?.url && /(?:youtube\.com\/watch|youtu\.be\/)/i.test(context.window.url);
    return assignQuadrants([
      makeOption("context_media_continue", video ? "PLAY THIS VIDEO" : `CONTINUE PLAYBACK IN ${app.toUpperCase()}`, {
        action: "play",
        operation: video ? "play_video" : "play_current",
        target: video
          ? { value: target.value, kind: "video", entityId: context.window?.url, display: target.display }
          : { value: "current media", kind: "media", display: target.display },
        service: app,
        ...(video && context.window?.url ? { url: context.window.url } : {}),
      }, "context_media", refProps),
      makeOption("context_media_search", `SEARCH ${app.toUpperCase()}`, { action: "search", service: app }, "context_media", refProps),
      makeOption("context_media_open", `OPEN ${app.toUpperCase()}`, { action: "open", target: app }, "context_media", refProps),
      makeOption("context_media_browse", "CHOOSE A TRACK OR PLAYLIST", { action: "choose", service: app }, "context_media", refProps),
    ]);
  }

  if (surface === "email_or_message") {
    return assignQuadrants([
      makeOption("context_message_reply", "REPLY TO THIS", { action: "reply", target }, "context_message", refProps),
      makeOption("context_message_summarize", "SUMMARIZE THIS THREAD", { action: "summarize", target }, "context_message", refProps),
      makeOption("context_message_send", "SEND THIS SOMEWHERE", { action: "send", target }, "context_message", refProps),
      makeOption("context_message_find", "FIND IN THIS THREAD", { action: "find", target }, "context_message", refProps),
    ]);
  }

  if (surface === "document_or_article" || surface === "file_or_editor") {
    return assignQuadrants([
      makeOption("context_document_summarize", "SUMMARIZE THIS", { action: "summarize", target }, "context_document", refProps),
      makeOption("context_document_explain", "READ / EXPLAIN THIS", { action: "explain", target }, "context_document", refProps),
      makeOption("context_document_find", "FIND SOMETHING IN THIS", { action: "find", target }, "context_document", refProps),
      makeOption("context_document_change", "CHANGE THIS", { action: "change", target }, "context_document", refProps),
    ]);
  }

  if (surface === "search_or_results") {
    return assignQuadrants([
      makeOption("context_search_refine", "REFINE THIS SEARCH", { action: "search", target }, "context_search", refProps),
      makeOption("context_search_summarize", "SUMMARIZE THESE RESULTS", { action: "summarize", target }, "context_search", refProps),
      makeOption("context_search_open", "OPEN THIS RESULT", { action: "open", target }, "context_search", refProps),
      makeOption("context_search_more", "OPEN ANOTHER RESULT", { action: "open", target }, "context_search", refProps),
    ]);
  }

  return assignQuadrants([
    makeOption("context_app_use", `USE ${app.toUpperCase()}`, { action: "use", target: app }, "context_app", refProps),
    makeOption("context_app_explain", "READ / EXPLAIN THIS", { action: "explain", target }, "context_app", refProps),
    makeOption("context_app_find", "FIND SOMETHING HERE", { action: "find", target }, "context_app", refProps),
    makeOption("context_app_show", "SHOW THIS WINDOW", { action: "show", target: app }, "context_app", refProps),
  ]);
}

export function isStrongContext(snapshot: ContextSnapshot | null): boolean {
  if (!snapshot || snapshot.access !== "active" || !snapshot.window) return false;
  const specificSurface = snapshot.surfaceType !== "unknown" && snapshot.surfaceType !== "generic_app";
  const semanticObservation = Boolean(snapshot.selectedText || snapshot.visibleText || snapshot.focusedElement || snapshot.window.url || snapshot.references.some((reference) => reference.kind === "document"));
  return specificSurface || semanticObservation;
}

function primaryReference(snapshot: ContextSnapshot): ContextReference | null {
  return snapshot.focusedElement
    ?? snapshot.references.find((reference) => reference.kind === "document")
    ?? snapshot.references[0]
    ?? null;
}

function referenceTarget(reference: ContextReference | null, fallback: string): { value: string; kind: string; entityId?: string; display?: string } {
  if (!reference) return { value: fallback, kind: "application", display: fallback };
  return { value: reference.label || fallback, kind: reference.kind, entityId: reference.id, display: reference.label || fallback };
}

function makeOption(
  id: string,
  label: string,
  intentPatch: IntentPatch,
  semanticGroup: string,
  reference: Pick<DisplayOption, "referenceId" | "referenceRevision" | "contextRevision"> = {},
): DisplayOption {
  const resultingPrompt = `I want you to ${label.toLowerCase().replace(/\s+/g, " ")}…`;
  return {
    id,
    cardId: id,
    quadrant: QUADRANTS[0],
    label,
    resultingPrompt,
    type: "continuation",
    semanticGroup,
    continuation: Object.entries(intentPatch).map(([key, value]) => `${key}=${patchValueText(value)}`).join(";"),
    intentPatch,
    ...reference,
  };
}

function patchValueText(value: IntentPatch[ string ]): string {
  const values = Array.isArray(value) ? value : [value];
  return values.map((item) => typeof item === "object" && item !== null ? item.value : String(item)).join(",");
}

function assignQuadrants(options: DisplayOption[]): DisplayOption[] {
  return options.map((option, index) => ({ ...option, quadrant: QUADRANTS[index] }));
}
