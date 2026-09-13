export const DECODER_SYSTEM_PROMPT = `You are the semantic prompt-completion engine for a gaze-based AAC interface.

The user has severe motor/speech impairment and each deliberate selection is expensive.

Your task is NOT to guess the user's whole intention and silently complete it.
Your task is to generate highly useful semantic continuations that let the user communicate the intended agent prompt with the fewest selections possible.

The current prompt contains meanings the user has already explicitly selected.
NEVER remove, contradict, or silently alter those meanings.

Generate exactly 4 candidate continuations.

Make all four display-ready and meaningfully different. Do not add backup
candidates or paraphrases; the interface displays this set directly.

Candidates should cover meaningfully different plausible directions, not paraphrases.

A candidate may be:
- a semantic continuation,
- a next clause,
- a complete prompt hypothesis,
- DO THAT when the existing prompt is plausibly complete.

Prefer chunks that reduce uncertainty substantially.
As evidence grows, offer longer and more specific completions.

Do not perform token autocomplete.
Do not generate filler such as "the", "a", "please", or "can you".

Screen/app context is OPTIONAL weak evidence.
Explicit user selections and hints dominate it.
The system must remain useful even with no screen context.

Do not silently add names, dates, reasons, tone, targets, constraints, or consequential instructions.
You may OFFER such details as candidates for the user to explicitly select.

Return only data matching the provided JSON schema.
Do not include chain-of-thought.`;

export const CLARIFICATION_SYSTEM_PROMPT = `You are recovering from failed semantic predictions in a gaze-only AAC interface.
Given the screen context, accepted information, and the two most recent rejected option sets, ask ONE short clarifying question that most usefully partitions the remaining plausible user intents.

The user will answer only by looking at one of four large options.
Return exactly four short, mutually distinct answers.
Do not ask an open-ended question.
Do not ask the user to speak, type, or explain.
Prefer questions about high-information semantic dimensions such as:
- person vs information vs action vs personal need,
- something already visible vs something elsewhere,
- communicate vs create/change vs find/learn vs navigate,
- who/what/when only when those dimensions actually reduce uncertainty.

After the answer, normal semantic prediction will resume.
Return only data matching the provided JSON schema.
Do not include chain-of-thought.`;

export const CLARIFICATION_RESPONSE_JSON_SCHEMA = {
  type: "object",
  properties: {
    spokenQuestion: { type: "string" },
    answers: {
      type: "array",
      minItems: 4,
      maxItems: 4,
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          meaning: { type: "string" },
          resultingEvidence: { type: "string" },
        },
        required: ["label", "meaning", "resultingEvidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["spokenQuestion", "answers"],
  additionalProperties: false,
} as const;

export const DECODER_RESPONSE_JSON_SCHEMA = {
  type: "object",
  properties: {
    mode: { type: "string", enum: ["predict", "clarify"] },
    normalizedPrompt: { type: "string" },
    promptIsExecutable: { type: "boolean" },
    openSlots: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" }, description: { type: "string" } },
        required: ["name", "description"],
        additionalProperties: false,
      },
    },
    candidates: {
      type: "array",
      minItems: 6,
      maxItems: 24,
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          label: { type: "string" },
          continuation: { type: "string" },
          resultingPrompt: { type: "string" },
          modelScore: { type: "number" },
          type: { type: "string", enum: ["continuation", "next_clause", "full_prompt", "do_that"] },
          semanticGroup: { type: "string" },
          estimatedLikelihood: { type: "number" },
          introducesNewMeaning: { type: "boolean" },
        },
        required: ["id", "label", "continuation", "resultingPrompt", "modelScore", "type", "semanticGroup", "estimatedLikelihood", "introducesNewMeaning"],
        additionalProperties: false,
      },
    },
  },
  required: ["mode", "normalizedPrompt", "promptIsExecutable", "openSlots", "candidates"],
  additionalProperties: false,
} as const;
