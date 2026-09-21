import type { IntentFrame, IntentPatchValue, SemanticValue } from "../../shared/intent";

/** Compiled output handed to Astra after the user has completed semantics. */
export interface CompiledIntent {
  prompt: string;
  ready: boolean;
  unresolvedSlots: string[];
  fields: Record<string, string[]>;
}

/**
 * Compiles typed intent state into the executor's natural-language prompt.
 * The compiler reads authoritative fields, not decoder-authored prose.
 */
export function compileTask(frame: IntentFrame): CompiledIntent {
  const values = (key: string): string[] => (frame.fields[key] ?? []).slice().sort((a, b) => authority(b) - authority(a)).map((item) => humanize(item.value)).filter(Boolean);
  const preferred = (key: string): string | undefined => values(key)[0];
  const actions = values("action");
  const operation = preferred("operation");
  const targets = values("target");
  const destinations = values("destination");
  const objectTargets = targets.filter((target) => isObjectTarget(target));
  const services = unique([
    ...values("service"),
    ...values("app"),
    ...targets.filter((target) => !objectTargets.includes(target)),
  ]);
  const titles = values("title");
  const recipients = values("recipient");
  const details = values("detail");
  const relations = values("relation");
  const times = values("time");
  const codingDetails = [
    ["project", "Project"],
    ["language", "Language"],
    ["framework", "Framework"],
    ["file", "File"],
    ["files", "Files"],
    ["requirement", "Requirement"],
    ["requirements", "Requirements"],
    ["acceptance", "Acceptance criteria"],
    ["acceptance_criteria", "Acceptance criteria"],
    ["constraint", "Constraint"],
    ["constraints", "Constraints"],
    ["editor", "Editor"],
    ["directory", "Directory"],
    ["output", "Output"],
    ["format", "Format"],
    ["artifact", "Artifact"],
  ].flatMap(([key, label]) => approvedValues(frame, key).map((value) => ({ label, value })));
  const verb = operationVerb(operation) ?? humanize(actions[0] ?? "do");
  const parts = [`I want you to ${verb}`];

  if (titles.length > 0 && operation?.startsWith("play")) parts.push(`“${titles[0]}”`);
  else if (operationObject(operation)) parts.push(operationObject(operation)!);
  else if (objectTargets.length > 0) parts.push(objectTargets.map(objectPhrase).join(" or "));

  if (services.length > 0) {
    const service = services[0]!;
    parts.push(["open", "launch", "use", "control"].includes(verb) ? service : `on ${service}`);
  }
  if (destinations.length > 0) parts.push(`to ${destinations.join(" and ")}`);
  for (const relation of relations) parts.push(relationPhrase(relation));
  for (const time of times) parts.push(time);
  for (const detail of details) parts.push(detail);
  for (const detail of uniqueLabeled(codingDetails)) parts.push(`${detail.label}: ${detail.value}`);
  for (const action of actions.slice(1)) {
    const next = humanize(action);
    if (/^(summarize|summarise|explain)$/.test(next)) parts.push(`then ${next} it`);
    else if (/^(email|send)$/.test(next)) parts.push(`then ${next} the result${recipients.length ? ` to ${recipients.join(" and ")}` : ""}`);
    else parts.push(`then ${next}`);
  }
  if (recipients.length > 0 && !actions.slice(1).some((action) => /^(email|send)$/i.test(action))) parts.push(`to ${recipients.join(" and ")}`);
  if (frame.fields.this?.length) parts.push("this");

  const unresolvedSlots = frame.unresolvedSlots.filter((slot) => slot.required !== false).map((slot) => slot.name);
  const prompt = `${parts.join(" ").replace(/\s+/g, " ").trim()}…`;
  return {
    prompt,
    ready: unresolvedSlots.length === 0 && (actions.length > 0 || Boolean(operation)),
    unresolvedSlots,
    fields: Object.fromEntries(Object.entries(frame.fields).map(([key, field]) => [key, field.map((value) => humanize(value.value))])),
  };
}

function authority(value: SemanticValue<IntentPatchValue>): number {
  const order: Record<string, number> = { model_inference: 1, background_context: 2, recent_context: 3, foreground_context: 4, resolved_entity: 5, user_selected: 6, user_explicit: 7 };
  return order[value.source] ?? 0;
}

function approvedValues(frame: IntentFrame, key: string): string[] {
  return (frame.fields[key] ?? [])
    .filter((item) => item.source === "user_selected" || item.source === "user_explicit")
    .slice()
    .sort((a, b) => authority(b) - authority(a))
    .map((item) => humanize(item.value))
    .filter(Boolean);
}

function uniqueLabeled(values: Array<{ label: string; value: string }>): Array<{ label: string; value: string }> {
  const seen = new Set<string>();
  return values.filter((item) => {
    const key = `${item.label.toLowerCase()}|${item.value.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function operationVerb(operation: string | undefined): string | undefined {
  if (!operation) return undefined;
  if (operation.startsWith("play_")) return "play";
  return operation === "search" ? "search" : operation === "browse" ? "browse" : humanize(operation);
}

function operationObject(operation: string | undefined): string | null {
  if (operation === "play_song") return "a song";
  if (operation === "play_video") return "a video";
  if (operation === "play_playlist") return "a playlist";
  if (operation === "play_station") return "a station";
  return null;
}

function objectPhrase(value: string): string {
  const labels: Record<string, string> = { file: "a file or document", online: "something online", email: "an email", message: "a message", app: "an app or setting", image: "an image or photo", meeting: "a meeting", video: "a video", song: "a song", playlist: "a playlist" };
  return labels[value.toLowerCase()] ?? value;
}

function isObjectTarget(value: string): boolean {
  return ["file", "online", "email", "message", "app", "image", "meeting", "video", "song", "playlist"].includes(value.toLowerCase());
}

function relationPhrase(value: string): string {
  const labels: Record<string, string> = { downloaded: "that I downloaded", working_on: "that I am working on", received: "that I received", created: "that I created" };
  return labels[value.toLowerCase()] ?? `that ${humanize(value)}`;
}

function humanize(value: IntentPatchValue): string {
  const raw = typeof value === "object" && value !== null ? value.value : String(value);
  return raw.replace(/^['“”"]+|['“”"]+$/g, "").replace(/_/g, " ").trim();
}

function unique(values: string[]): string[] {
  return values.filter((value, index) => values.findIndex((other) => other.toLowerCase() === value.toLowerCase()) === index);
}
