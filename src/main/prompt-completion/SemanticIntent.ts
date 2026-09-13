const MEDIA_SERVICES = new Set([
  "spotify",
  "apple music",
  "youtube",
  "youtube music",
  "soundcloud",
  "tidal",
  "pandora",
]);

const OBJECT_LABELS: Record<string, string> = {
  app: "an app",
  email: "an email",
  file: "a file",
  image: "an image",
  meeting: "a meeting",
  message: "a message",
  online: "something online",
  photo: "a photo",
  playlist: "a playlist",
  song: "a song",
  track: "a song",
  video: "a video",
};

const NON_SEMANTIC_FLAGS = new Set(["clarify_answer", "hint", "something_else"]);

export interface SemanticIntent {
  fields: Map<string, string[]>;
  flags: Set<string>;
}

/** Parse the machine-facing key=value deltas selected by the user. */
export function parseSemanticIntent(fragments: readonly string[]): SemanticIntent {
  const fields = new Map<string, string[]>();
  const flags = new Set<string>();
  for (const fragment of fragments) {
    for (const rawPart of fragment.split(";")) {
      const part = rawPart.trim();
      if (!part) continue;
      const separator = part.indexOf("=");
      if (separator < 1) {
        flags.add(part.toLowerCase());
        continue;
      }
      const key = part.slice(0, separator).trim().toLowerCase();
      const value = part.slice(separator + 1).trim();
      if (!key || !value || (value.startsWith("<") && value.endsWith(">"))) continue;
      const values = fields.get(key) ?? [];
      if (!values.some((existing) => existing.toLowerCase() === value.toLowerCase())) values.push(value);
      fields.set(key, values);
    }
  }
  return { fields, flags };
}

export function hasStructuredEvidence(fragment: string): boolean {
  return fragment.split(";").some((part) => part.includes("="));
}

/**
 * Render accepted semantic state without relying on a decoder to repeat it.
 * The fallback is used only when the session has no actionable structured
 * evidence yet.
 */
export function composeSemanticPrompt(fragments: readonly string[], fallback: string): string {
  const intent = parseSemanticIntent(fragments);
  // Actions remain ordered because a user can explicitly build a multi-step
  // task such as find → summarize → email.
  const actions = intent.fields.get("action") ?? [];
  const action = first(actions);
  const operation = last(intent.fields.get("operation"));
  if (!action && !operation) return withEllipsis(fallback);

  const targets = intent.fields.get("target") ?? [];
  const explicitServices = [
    ...(intent.fields.get("service") ?? []),
    ...(intent.fields.get("app") ?? []),
  ];
  const services = unique([...explicitServices, ...targets.filter((value) => MEDIA_SERVICES.has(value.toLowerCase()))]);
  const objects = targets.filter((value) => !MEDIA_SERVICES.has(value.toLowerCase()));
  const title = last(intent.fields.get("title"));
  const details = intent.fields.get("detail") ?? [];
  const recipients = intent.fields.get("recipient") ?? [];
  const verb = operationVerb(operation) ?? humanize(action ?? "do");
  let prompt = `I want you to ${verb}`;

  if (title && operation?.startsWith("play")) {
    prompt += ` “${stripQuotes(title)}”`;
  } else {
    const operationObject = operationObjectLabel(operation);
    const object = operationObject ?? objects.map(objectLabel).join(" or ");
    if (object) prompt += ` ${object}`;
  }

  if (services.length > 0) {
    const service = services[services.length - 1];
    if (verb === "open" || verb === "launch" || verb === "use" || verb === "control") prompt += ` ${service}`;
    else prompt += ` on ${service}`;
  }

  for (const relation of intent.fields.get("relation") ?? []) prompt += ` ${relationPhrase(relation)}`;
  appendField(promptParts(intent, "time", ""), (part) => { prompt += part; });
  const secondaryActions = actions.slice(1);
  for (const secondary of secondaryActions) {
    const next = humanize(secondary);
    if (/^(summarize|summarise|explain)$/.test(next)) {
      prompt += `, then ${next} ${details.length > 0 ? details.map(humanize).join(" and ") : "it"}`;
    } else if (/^(email|send)$/.test(next)) {
      prompt += `, then ${next} the result`;
      if (recipients.length > 0) prompt += ` to ${recipients.map(humanize).join(" and ")}`;
    } else {
      prompt += `, then ${next}`;
    }
  }
  if (!secondaryActions.some((value) => /^(email|send)$/i.test(value))) {
    appendField(promptParts(intent, "recipient", "to"), (part) => { prompt += part; });
  }
  if (!secondaryActions.some((value) => /^(summarize|summarise|explain)$/i.test(value))) {
    appendField(promptParts(intent, "detail", ""), (part) => { prompt += part; });
  }
  appendField(promptParts(intent, "literal", ""), (part) => { prompt += part; });
  if (intent.flags.has("this")) prompt += " this";

  return withEllipsis(prompt.replace(/\s+/g, " ").trim());
}

/** Structured evidence is preserved by the accumulator, not repeated words. */
export function requiresLexicalPreservation(fragment: string): boolean {
  const trimmed = fragment.trim().toLowerCase();
  return Boolean(trimmed) && !hasStructuredEvidence(trimmed) && !NON_SEMANTIC_FLAGS.has(trimmed) && trimmed !== "this";
}

function operationVerb(operation: string | undefined): string | null {
  if (!operation) return null;
  if (operation.startsWith("play_")) return "play";
  if (operation === "search") return "search";
  if (operation === "browse") return "browse";
  return humanize(operation);
}

function operationObjectLabel(operation: string | undefined): string | null {
  if (!operation) return null;
  if (operation === "play_song") return "a song";
  if (operation === "play_video") return "a video";
  if (operation === "play_playlist") return "a playlist";
  if (operation === "play_station") return "a station";
  return null;
}

function objectLabel(value: string): string {
  return OBJECT_LABELS[value.toLowerCase()] ?? value;
}

function relationPhrase(value: string): string {
  const relation = value.toLowerCase();
  if (relation === "downloaded") return "that I downloaded";
  if (relation === "working_on") return "that I am working on";
  if (relation === "received") return "that I received";
  if (relation === "created") return "that I created";
  return `that ${humanize(value)}`;
}

function promptParts(intent: SemanticIntent, key: string, prefix: string): string[] {
  return (intent.fields.get(key) ?? []).map((value) => ` ${prefix ? `${prefix} ` : ""}${humanize(value)}`);
}

function appendField(parts: string[], append: (part: string) => void): void {
  for (const part of parts) append(part);
}

function humanize(value: string): string {
  return stripQuotes(value).replace(/_/g, " ").trim();
}

function stripQuotes(value: string): string {
  return value.replace(/^["“”']+|["“”']+$/g, "").trim();
}

function unique(values: string[]): string[] {
  return values.filter((value, index) => values.findIndex((candidate) => candidate.toLowerCase() === value.toLowerCase()) === index);
}

function last(values: string[] | undefined): string | undefined {
  return values?.[values.length - 1];
}

function first(values: string[] | undefined): string | undefined {
  return values?.[0];
}

function withEllipsis(prompt: string): string {
  const trimmed = prompt.replace(/…+$/, "").trim();
  return `${trimmed}…`;
}
