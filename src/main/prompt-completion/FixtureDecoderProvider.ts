import type { DecoderInput, DecoderResponse, HintType } from "../../shared/types";

interface EvidenceMap {
  action: string[];
  target: string | null;
  relation: string[];
  time: string | null;
  recipient: string | null;
  detail: string[];
  this: boolean;
}

function normalize(s: string): string {
  return s.toLowerCase().trim();
}

function actionWord(action: string): string {
  switch (action) {
    case "find":
    case "search":
      return "find";
    case "create":
    case "write":
      return "create";
    case "open":
      return "open";
    case "send":
      return "send";
    case "email":
      return "email";
    case "play":
      return "play";
    case "summarize":
    case "summarise":
      return "summarize";
    case "explain":
      return "explain";
    case "ask":
      return "ask";
    default:
      return action;
  }
}

function targetPhrase(target: string): string {
  switch (target) {
    case "file":
      return "a file or document";
    case "online":
      return "something online";
    case "email":
      return "an email";
    case "message":
      return "a message";
    case "app":
      return "an app or setting";
    case "image":
      return "an image or photo";
    case "meeting":
      return "the meeting";
    case "video":
      return "a video";
    case "song":
      return "a song";
    default:
      return target;
  }
}

function parseEvidence(input: DecoderInput): EvidenceMap {
  const ev: EvidenceMap = { action: [], target: null, relation: [], time: null, recipient: null, detail: [], this: false };
  for (const line of input.explicitSemanticEvidence) {
    const clean = line.startsWith("option:") ? line.slice(7) : line;
    const [k, v] = clean.split("=", 2).map((s) => s.trim());
    const key = normalize(k ?? "");
    const value = v ?? "";
    if (key === "action" && value) ev.action.push(normalize(value));
    else if (key === "target" && value) ev.target = normalize(value);
    else if (key === "relation" && value) ev.relation.push(normalize(value));
    else if (key === "time" && value) ev.time = normalize(value);
    else if (key === "recipient" && value) ev.recipient = value;
    else if (key === "detail" && value) ev.detail.push(value);
    else if (key === "this") ev.this = true;
  }
  if (ev.this && !ev.target) ev.target = "this";
  return ev;
}

function assemblePrompt(ev: EvidenceMap): string {
  const main: string[] = [];
  const firstVerb = ev.action.length > 0 ? actionWord(ev.action[0]) : null;
  let subject: string | null = null;
  if (ev.target) subject = ev.target === "this" ? "this" : targetPhrase(ev.target);

  if (firstVerb) {
    main.push(subject ? `${firstVerb} ${subject}` : firstVerb);
  } else if (subject) {
    main.push(subject);
  } else {
    main.push("…");
  }
  for (const r of ev.relation) {
    if (r === "downloaded") main.push("I downloaded");
    else if (r === "working_on") main.push("I'm working on");
    else if (r === "received") main.push("I received");
    else if (r === "created") main.push("I created");
    else main.push(r);
  }
  if (ev.time) main.push(ev.time);
  for (const d of ev.detail) main.push(d);

  const compound = ev.action.slice(1).map((a) => {
    const verb = actionWord(a);
    if (a === "email") return `and email the summary${ev.recipient ? ` to ${ev.recipient}` : ""}`;
    return `and ${verb} it`;
  });
  const tail: string[] = [];
  if (ev.recipient && !ev.action.includes("email")) tail.push(`to ${ev.recipient}`);
  return "I want you to " + [...main, ...compound, ...tail].join(" ");
}

interface TemplateGroup {
  label: string;
  evidence: string;
  fragment: string;
  score: number;
  group: string;
}

interface CandidateSpec extends TemplateGroup {
  type: "continuation" | "next_clause" | "full_prompt" | "do_that";
  resultingPrompt: string;
}

export class FixtureDecoderProvider {
  readonly name = "fixture-decoder";

  async generateCandidates(input: DecoderInput): Promise<DecoderResponse> {
    return this.generate(input);
  }

  generate(input: DecoderInput): DecoderResponse {
    const ev = parseEvidence(input);
    const base = assemblePrompt(ev);
    const withEllipsis = (s: string) => `${s.trim()}${s.endsWith("…") ? "" : "…"}`;
    let counter = 0;
    const nid = () => `c${++counter}_${input.turn}`;
    const candidates: DecoderResponse["candidates"] = [];

    const add = (spec: CandidateSpec) => {
      candidates.push({
        id: nid(),
        label: spec.label,
        continuation: spec.evidence || spec.fragment,
        resultingPrompt: spec.resultingPrompt,
        modelScore: spec.score,
        type: spec.type,
        semanticGroup: spec.group,
        estimatedLikelihood: spec.score,
        introducesNewMeaning: false,
      });
    };

    const specs = (templates: TemplateGroup[], basePrompt: string): CandidateSpec[] =>
      templates.map((t) => ({
        ...t,
        resultingPrompt: t.evidence === "" ? withEllipsis(basePrompt) : withEllipsis(`${basePrompt.replace(/…$/, "")} ${t.fragment}`),
        type: (t.label === "DO THAT" ? "do_that" : "continuation") as CandidateSpec["type"],
      }));

    const root = ev.action.length === 0 && !ev.target;
    const hintText = input.hints.map((h) => h.text).join(" ").trim();

    if (root) {
      const groups: TemplateGroup[] = [
        { label: "FIND / SEARCH FOR…", evidence: "action=find", fragment: "find", score: 0.92, group: "action_find" },
        { label: "WRITE / CREATE…", evidence: "action=create", fragment: "create", score: 0.88, group: "action_create" },
        { label: "OPEN / USE…", evidence: "action=open", fragment: "open", score: 0.84, group: "action_open" },
        { label: "SEND / TELL…", evidence: "action=send", fragment: "send", score: 0.8, group: "action_send" },
        { label: "EXPLAIN / SUMMARIZE…", evidence: "action=explain", fragment: "explain", score: 0.68, group: "action_explain" },
        { label: "PLAY / CONTROL…", evidence: "action=play", fragment: "play", score: 0.6, group: "action_play" },
        { label: "ASK A QUESTION…", evidence: "action=ask", fragment: "find out", score: 0.52, group: "action_ask" },
        { label: "SOMETHING ELSE…", evidence: "", fragment: "", score: 0.42, group: "coverage" },
      ];
      for (const s of specs(groups, "I want you to")) add(s);
      add({
        label: "DO THAT",
        evidence: "",
        fragment: "",
        score: 0.3,
        group: "coverage",
        type: "do_that",
        resultingPrompt: "I want you to…",
      });
      return {
        mode: "predict",
        normalizedPrompt: "I want you to…",
        promptIsExecutable: false,
        openSlots: [{ name: "action", description: "what the user wants done" }],
        candidates,
      };
    }

    if (hintText.length > 0) {
      for (const m of this.lexiconMatches(hintText, input)) {
        const kind = m.kind === "person" ? "recipient" : "target";
        add({
          label: m.name.toUpperCase(),
          evidence: `${kind}=${m.name}`,
          fragment: m.name,
          score: 0.95,
          group: `entity_${m.kind}`,
          type: "continuation",
          resultingPrompt: withEllipsis(`${base} ${m.name}`),
        });
      }
      if (ev.target == null || (ev.action.some((a) => a === "send" || a === "email") && ev.recipient == null)) {
        add({
          label: `“${hintText.toUpperCase()}”…`,
          evidence: `literal=${hintText}`,
          fragment: hintText,
          score: 0.88,
          group: "hint_echo",
          type: "continuation",
          resultingPrompt: withEllipsis(`${base} ${hintText}`),
        });
        add({
          label: "KEEP SPELLING…",
          evidence: `hint=${hintText}`,
          fragment: "",
          score: 0.6,
          group: "hint",
          type: "continuation",
          resultingPrompt: withEllipsis(base),
        });
      }
    }

    if (ev.target == null && !ev.this && hintText.length === 0) {
      const action = ev.action[ev.action.length - 1];
      const templates: TemplateGroup[] =
        action === "send" || action === "email"
          ? [
              { label: "AN EMAIL…", evidence: "target=email", fragment: "an email", score: 0.9, group: "email_target" },
              { label: "A MESSAGE…", evidence: "target=message", fragment: "a message", score: 0.85, group: "message_target" },
              { label: "THIS FILE / DOCUMENT…", evidence: "this", fragment: "this", score: 0.8, group: "this_target" },
              { label: "A SUMMARY…", evidence: "detail=summary", fragment: "a summary", score: 0.68, group: "summary" },
              { label: "SOMETHING ELSE…", evidence: "", fragment: "", score: 0.4, group: "coverage" },
            ]
          : [
              { label: "A FILE / DOCUMENT…", evidence: "target=file", fragment: "a file or document", score: 0.92, group: "file_target" },
              { label: "SOMETHING ONLINE…", evidence: "target=online", fragment: "something online", score: 0.85, group: "online_target" },
              { label: "AN EMAIL / MESSAGE…", evidence: "target=email", fragment: "an email or message", score: 0.8, group: "email_target" },
              { label: "AN APP / SETTING…", evidence: "target=app", fragment: "an app or setting", score: 0.75, group: "app_target" },
              { label: "A MEETING…", evidence: "target=meeting", fragment: "a meeting", score: 0.6, group: "meeting_target" },
              { label: "AN IMAGE / PHOTO…", evidence: "target=image", fragment: "an image or photo", score: 0.55, group: "image_target" },
              { label: "SOMETHING ELSE…", evidence: "", fragment: "", score: 0.4, group: "coverage" },
            ];
      for (const s of specs(templates, base)) add(s);
      return {
        mode: "predict",
        normalizedPrompt: withEllipsis(base),
        promptIsExecutable: false,
        openSlots: [{ name: "target", description: "what the action applies to" }],
        candidates,
      };
    }

    if ((ev.action.some((a) => a === "send" || a === "email")) && ev.recipient == null) {
      const templates: TemplateGroup[] = [];
      const people = input.userLexicon.people;
      if (people.length > 0) templates.push({ label: `TO ${people[0].toUpperCase()}…`, evidence: `recipient=${people[0]}`, fragment: `to ${people[0]}`, score: 0.92, group: "recipient" });
      if (people.length > 1) templates.push({ label: `TO ${people[1].toUpperCase()}…`, evidence: `recipient=${people[1]}`, fragment: `to ${people[1]}`, score: 0.85, group: "recipient" });
      templates.push(
        { label: "TO A RECENT CONTACT…", evidence: "recipient=<recent>", fragment: "to a recent contact", score: 0.7, group: "recipient" },
        { label: "TO SOMEONE ELSE…", evidence: "recipient=<someone>", fragment: "to someone else", score: 0.6, group: "recipient" },
        { label: "SPELL / HINT…", evidence: "hint", fragment: "", score: 0.94, group: "hint" }
      );
      for (const s of specs(templates, base)) add(s);
      return {
        mode: "predict",
        normalizedPrompt: withEllipsis(base),
        promptIsExecutable: false,
        openSlots: [{ name: "recipient", description: "who should receive it" }],
        candidates,
      };
    }

    if (ev.recipient == null && ev.detail.length === 0 && hintText.length === 0 && ev.time == null) {
      const templates: TemplateGroup[] = [
        ...(ev.relation.length === 0 ? [
          { label: "I DOWNLOADED…", evidence: "relation=downloaded", fragment: "I downloaded", score: 0.85, group: "origin_downloaded" },
          { label: "I'M WORKING ON…", evidence: "relation=working_on", fragment: "I'm working on", score: 0.8, group: "origin_working" },
          { label: "I RECEIVED…", evidence: "relation=received", fragment: "I received", score: 0.72, group: "origin_received" },
          { label: "I CREATED…", evidence: "relation=created", fragment: "I created", score: 0.6, group: "origin_created" },
        ] : []),
        { label: "YESTERDAY…", evidence: "time=yesterday", fragment: "yesterday", score: 0.68, group: "time" },
        { label: "A SPECIFIC DATE…", evidence: "time=<date>", fragment: "a specific date", score: 0.5, group: "time" },
        { label: "SOMETHING ELSE…", evidence: "", fragment: "", score: 0.4, group: "coverage" },
      ];
      for (const s of specs(templates, base)) add(s);
      add({ label: "DO THAT", evidence: "", fragment: "", score: 0.45, group: "coverage", type: "do_that", resultingPrompt: base });
      return {
        mode: "predict",
        normalizedPrompt: withEllipsis(base),
        promptIsExecutable: true,
        openSlots: [],
        candidates,
      };
    }

    if (ev.detail.length === 0 && (ev.action.some((a) => a === "summarize" || a === "explain"))) {
      const templates: TemplateGroup[] = [
        { label: "THE WHOLE DOCUMENT…", evidence: "detail=the whole document", fragment: "the whole document", score: 0.82, group: "scope_whole" },
        { label: "JUST THE METHODS…", evidence: "detail=the methods section", fragment: "the methods section", score: 0.8, group: "scope_methods" },
        { label: "THE MAIN FINDINGS…", evidence: "detail=the main findings", fragment: "the main findings", score: 0.72, group: "scope_findings" },
        { label: "A SPECIFIC SECTION…", evidence: "detail=a specific section", fragment: "a specific section", score: 0.62, group: "scope_specific" },
        { label: "SOMETHING ELSE…", evidence: "", fragment: "", score: 0.4, group: "coverage" },
      ];
      for (const s of specs(templates, base)) add(s);
      return {
        mode: "predict",
        normalizedPrompt: withEllipsis(base),
        promptIsExecutable: false,
        openSlots: [{ name: "scope", description: "which part to summarize" }],
        candidates,
      };
    }

    const templates: TemplateGroup[] = [
      { label: "AND SUMMARIZE IT…", evidence: "action=summarize", fragment: "and summarize it", score: 0.85, group: "compound_summarize" },
      { label: "AND EMAIL THE SUMMARY…", evidence: "action=email", fragment: "and email the summary", score: 0.8, group: "compound_email" },
      { label: "AND OPEN IT…", evidence: "action=open", fragment: "and open it", score: 0.74, group: "compound_open" },
      { label: "AND SEND IT…", evidence: "action=send", fragment: "and send it", score: 0.7, group: "compound_send" },
      { label: "AND TELL ME ABOUT IT…", evidence: "action=explain", fragment: "and tell me about it", score: 0.66, group: "compound_explain" },
      { label: "DO THAT", evidence: "", fragment: "", score: 0.62, group: "coverage" },
      { label: "SOMETHING ELSE…", evidence: "", fragment: "", score: 0.4, group: "coverage" },
    ].filter((template) => {
      if (!template.evidence.startsWith("action=")) return true;
      return !ev.action.includes(template.evidence.slice("action=".length));
    });
    for (const s of specs(templates, base)) add(s);
    if (ev.target != null && ev.time != null) {
      add({
        label: "USE THIS COMPLETE PROMPT",
        evidence: "",
        fragment: "",
        score: 0.9,
        group: "full_prompt",
        type: "full_prompt",
        resultingPrompt: base,
      });
    }
    return {
      mode: "predict",
      normalizedPrompt: withEllipsis(base),
      promptIsExecutable: true,
      openSlots: [],
      candidates,
    };
  }

  async generateClarification(_input?: DecoderInput): Promise<NonNullable<DecoderResponse["clarification"]>> {
    return {
      spokenQuestion: "What is this mainly about?",
      answers: [
        { label: "A PERSON", meaning: "about a person", resultingEvidence: "topic=person" },
        { label: "INFORMATION", meaning: "about information", resultingEvidence: "topic=information" },
        { label: "SOMETHING TO DO", meaning: "about an action", resultingEvidence: "topic=action" },
        { label: "A PERSONAL NEED", meaning: "a personal need", resultingEvidence: "topic=personal" },
      ],
    };
  }

  private lexiconMatches(hint: string, input: DecoderInput): Array<{ name: string; kind: string }> {
    const h = normalize(hint);
    if (!h) return [];
    const all: Array<{ name: string; kind: string }> = [];
    for (const name of input.userLexicon.people) all.push({ name, kind: "person" });
    for (const name of input.userLexicon.places) all.push({ name, kind: "place" });
    for (const name of input.userLexicon.apps) all.push({ name, kind: "app" });
    for (const name of input.userLexicon.customVocabulary) all.push({ name, kind: "vocab" });
    return all.filter((e) => normalize(e.name).startsWith(h));
  }
}
