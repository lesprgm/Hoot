import { z } from "zod";
import type { IntentPatch } from "../../shared/intent";

export const rejectedSetSchema = z.object({
  labels: z.array(z.string()).min(1).max(8),
  turn: z.number().int().min(0),
});

export const decoderInputSchema = z.object({
  displayPrompt: z.string(),
  explicitSemanticEvidence: z.array(z.string()),
  rejectedSets: z.array(rejectedSetSchema),
  historyDepth: z.number().int().min(0),
  userLexicon: z.object({
    people: z.array(z.string()),
    places: z.array(z.string()),
    apps: z.array(z.string()),
    recurringPhrases: z.array(z.string()),
    customVocabulary: z.array(z.string()),
  }),
  optionalContext: z.object({
    activeApp: z.string().nullable(),
    activeAppUrl: z.string().nullable(),
    surfaceType: z.string().nullable(),
    visibleReferent: z.string().nullable(),
    gazeTargetDescription: z.string().nullable(),
    capturedImageDataUrl: z.string().nullable(),
    contextState: z.enum(["disabled", "active", "paused", "blocked"]).optional(),
    contextSessionId: z.string().nullable().optional(),
    contextRevision: z.number().int().min(0).optional(),
    contextSources: z.array(z.object({
      kind: z.enum(["active_window", "accessibility", "browser", "screenshot", "task"]),
      state: z.enum(["available", "unavailable", "paused", "not_requested"]),
      observedAt: z.number().nullable(),
      detail: z.string().optional(),
    })).max(8).optional(),
    contextReferences: z.array(z.object({
      id: z.string().max(512),
      kind: z.enum(["window", "document", "selection", "control"]),
      label: z.string().max(240),
      appName: z.string().max(240),
      source: z.enum(["active_window", "accessibility", "browser", "screenshot", "task"]),
      observedAt: z.number(),
      bounds: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional(),
      url: z.string().max(512).optional(),
      text: z.string().max(2000).optional(),
      revision: z.string().max(200).optional(),
    })).max(8).optional(),
    focusedElement: z.object({
      id: z.string().max(512),
      kind: z.enum(["window", "document", "selection", "control"]),
      label: z.string().max(240),
      appName: z.string().max(240),
      source: z.enum(["active_window", "accessibility", "browser", "screenshot", "task"]),
      observedAt: z.number(),
      bounds: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional(),
      url: z.string().max(512).optional(),
      text: z.string().max(2000).optional(),
      revision: z.string().max(200).optional(),
    }).nullable().optional(),
    selectedText: z.string().max(4000).nullable().optional(),
    visibleText: z.string().max(4000).nullable().optional(),
    contextLedger: z.object({
      active: z.boolean(),
      revision: z.number().int().min(0),
      observations: z.array(z.object({
        id: z.string().max(512),
        source: z.enum(["foreground_context", "recent_context", "background_context"]),
        kind: z.string().max(80),
        label: z.string().max(240),
        appName: z.string().max(240).nullable(),
        url: z.string().max(512).optional(),
        text: z.string().max(2000).optional(),
        referenceId: z.string().max(512).optional(),
        observedAt: z.number(),
        revision: z.number().int().min(0),
      })).max(24),
    }).optional(),
  }),
  consecutiveNoneCount: z.number().int().min(0),
  clarificationAnswers: z.array(z.object({ question: z.string(), answer: z.string() })),
  turn: z.number().int().min(0),
  task: z.unknown().nullable().optional(),
  intentFrame: z.unknown().optional(),
});

const rawCandidateSchema = z.object({
  id: z.string(),
  label: z.string().min(1).max(200),
  continuation: z.string().max(400),
  resultingPrompt: z.string().min(1).max(1600),
  modelScore: z.number().min(0).max(1),
  type: z.enum(["continuation", "next_clause", "full_prompt", "do_that"]),
  semanticGroup: z.string().max(80),
  estimatedLikelihood: z.number().min(0).max(1),
  introducesNewMeaning: z.boolean(),
  operation: z.string().max(240).optional(),
  referenceId: z.string().max(512).optional(),
  referenceRevision: z.string().max(200).optional(),
  intentPatch: z.record(z.string(), z.unknown()).transform((value) => value as IntentPatch).optional(),
});

export const decoderResponseSchema = z.object({
  mode: z.enum(["predict", "clarify"]),
  normalizedPrompt: z.string(),
  promptIsExecutable: z.boolean(),
  openSlots: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
    })
  ),
  // The model proposes a pool. The host ranker chooses the four visible cards.
  candidates: z.array(rawCandidateSchema).min(8).max(12),
  unresolvedSlots: z.array(z.object({ name: z.string(), description: z.string() })).max(12).optional(),
  clarification: z
    .object({
      spokenQuestion: z.string().min(1).max(200),
      answers: z
        .array(z.object({ label: z.string().min(1).max(80), meaning: z.string(), resultingEvidence: z.string() }))
        .min(4)
        .max(4),
    })
    .optional(),
});

export const clarificationSchema = z.object({
  spokenQuestion: z.string().min(1).max(200),
  answers: z
    .array(z.object({ label: z.string().min(1).max(80), meaning: z.string(), resultingEvidence: z.string() }))
    .length(4),
});

export type DecoderInputShape = z.infer<typeof decoderInputSchema>;
export type DecoderResponseShape = z.infer<typeof decoderResponseSchema>;
export type RawCandidateShape = z.infer<typeof rawCandidateSchema>;

export function validateDecoderResponse(value: unknown): { ok: true; data: DecoderResponseShape } | { ok: false; errors: string[] } {
  const result = decoderResponseSchema.safeParse(value);
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, errors: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
}

export function validateDecoderInput(value: unknown): { ok: true; data: DecoderInputShape } | { ok: false; errors: string[] } {
  const result = decoderInputSchema.safeParse(value);
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, errors: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
}

export function validateClarification(value: unknown): { ok: true; data: z.infer<typeof clarificationSchema> } | { ok: false; errors: string[] } {
  const result = clarificationSchema.safeParse(value);
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, errors: result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`) };
}
