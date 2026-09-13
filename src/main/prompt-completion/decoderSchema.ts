import { z } from "zod";

export const hintSchema = z.object({
  text: z.string().min(1).max(200),
  type: z.enum(["letters", "word_prefix", "keyword", "initialism", "number", "literal_text"]),
});

export const rejectedSetSchema = z.object({
  labels: z.array(z.string()).min(1).max(8),
  turn: z.number().int().min(0),
});

export const decoderInputSchema = z.object({
  displayPrompt: z.string(),
  explicitSemanticEvidence: z.array(z.string()),
  hints: z.array(hintSchema),
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
  }),
  consecutiveNoneCount: z.number().int().min(0),
  clarificationAnswers: z.array(z.object({ question: z.string(), answer: z.string() })),
  turn: z.number().int().min(0),
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
  candidates: z.array(rawCandidateSchema).min(4).max(24),
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
