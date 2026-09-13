# PROMPT COMPLETION — AUTHORITATIVE BUILD SPEC
## Gaze-to-Agent Semantic Prompt Composer
### FINAL SOURCE OF TRUTH FOR HOW THE USER CONSTRUCTS A PROMPT

**Status:** AUTHORITATIVE / IMPLEMENT THIS  
**Project:** Gaze-to-Agent Accessibility System  
**Primary user model:** A person with severe motor/speech impairment who can intentionally control gaze  
**Primary objective:** Let the user express an arbitrary agent prompt with the fewest deliberate gaze actions possible  
**Platform:** macOS desktop application  
**This document supersedes all earlier prompt-completion behavior.**

---

# 0. READ THIS FIRST

This document defines the prompt-completion subsystem.

It supersedes any earlier project document that implies any of the following:

- screen context is the primary way we infer the user's intent;
- the first four choices are fixed app-specific commands;
- the semantic decoder is primarily a menu tree;
- the user must choose a category such as "communication", "information", or "action";
- two rounds of failed predictions are enough as the only fallback;
- the user can get stuck if the LLM does not guess an unusual name, phrase, number, file, or idea;
- the system is allowed to silently add details because they appear on screen.

Those ideas are no longer the source of truth for prompt composition.

The source of truth is:

> **The user is composing a natural-language prompt through semantic prediction.**
>
> The system continuously predicts useful chunks of the prompt, the user selects one with gaze, the prompt grows, and prediction repeats.
>
> When prediction is insufficient, the user provides the minimum additional letters, keywords, initials, or other explicit evidence needed to make prediction useful again.
>
> This must work even when the screen provides zero useful context.

Screen/app/gaze context can make prediction faster.

It must never be required to make the communication system complete.

---

# 1. PRODUCT INVARIANT

The product must satisfy this statement:

> **No matter what task the user wants to ask the agent to perform, the user can eventually express the complete intended prompt using gaze alone. Prediction accelerates communication; prediction never limits communication.**

The system is not attempting mind reading.

The system is attempting **information-efficient intent transmission**.

The human supplies enough information to disambiguate the intended prompt.

The AI expands that information into likely natural-language continuations.

---

# 2. THE STEPHEN HAWKING / AAC DESIGN PRINCIPLE

The reference mental model is not:

```text
look at screen
        ↓
AI guesses what user probably wants
```

It is:

```text
user has arbitrary thought
        ↓
user communicates a tiny amount of information
        ↓
prediction expands that information
        ↓
user accepts / rejects / adds more evidence
        ↓
complete message emerges
```

Professor Stephen Hawking's ACAT system is useful precedent because it combined constrained physical input with keyboard simulation, prediction, and speech synthesis.

Intel's public description of the Hawking system reported that predictive technology reduced the amount of characters he needed to explicitly enter to under 20% for his system.

Modern LLMs let this project go beyond character and next-word prediction.

Our unit of prediction is:

> **semantic prompt chunks and complete prompt hypotheses**

rather than individual characters.

---

# 3. RESEARCH BASIS TO STUDY BEFORE IMPLEMENTING

Before writing this subsystem, inspect the following projects and papers.

Do not reinvent components already available.

---

## 3.1 SpeakFaster — PRIMARY RESEARCH REFERENCE

Repository:

https://github.com/TeamGleason/SpeakFaster

Paper:

https://www.nature.com/articles/s41467-024-53873-3

Why it matters:

SpeakFaster is direct evidence that LLM-based expansion can reduce expensive motor input for eye-gaze AAC users.

The 2024 Nature Communications study reported:

- highly abbreviated text expansion;
- initials-only expansion;
- mixed initials + fully/partially spelled keywords;
- repair pathways when predictions miss;
- no-dead-end design;
- 29–60% faster text entry than baseline for two experienced ALS eye-gaze users;
- substantial motor-action savings.

The key lesson to copy conceptually:

```text
prediction
    ↓
prediction misses
    ↓
user adds a small amount of explicit evidence
    ↓
prediction improves
    ↓
repeat until exact intended phrase is available
```

The SpeakFaster UI/code is public and MIT licensed.

The original fine-tuned LaMDA models are proprietary and are NOT available.

Therefore:

- inspect/reuse UI concepts and open implementation where useful;
- do not waste time attempting to reproduce their training pipeline;
- use a current fast general-purpose LLM with strong prompting/Structured Outputs for the hackathon.

---

## 3.2 Dasher / Dasher Web — GUARANTEED LOW-LEVEL FALLBACK

Repositories:

https://github.com/dasher-project/DasherCore

https://github.com/dasher-project/dasher-web

Why it matters:

Dasher is an information-efficient predictive text-entry system built specifically for constrained pointing modalities including eye gaze.

The current Dasher project provides:

- DasherCore;
- a WebAssembly web build;
- JavaScript wrapper;
- pointer input;
- adaptive language model;
- MIT-licensed current v6 components.

For this project:

> **Do not build a custom gaze keyboard from scratch.**

Use Dasher Web / DasherCore as the final arbitrary-text fallback if semantic prediction and short hints are insufficient.

The Electron renderer can self-host the Dasher Web WASM bundle and feed gaze coordinates into the same pointer interface that normally receives mouse coordinates.

The fallback exists to guarantee:

```text
ANY STRING CAN EVENTUALLY BE ENTERED
```

even when the LLM has never seen or cannot infer it.

---

## 3.3 Intel ACAT — ARCHITECTURAL REFERENCE ONLY

Repository:

https://github.com/intel/acat

Why it matters:

ACAT was originally built for Professor Stephen Hawking and provides:

- constrained input;
- keyboard simulation;
- word/sentence prediction;
- speech synthesis;
- configurable panels;
- abbreviation support;
- extensible predictors.

The current ACAT codebase is Windows/.NET-oriented.

Do NOT port ACAT into the Mac project.

Study it for:

- accessibility interaction philosophy;
- prediction/fallback concepts;
- user-configurable input behavior.

---

## 3.4 KWickChat — KEYWORD-TO-SENTENCE RESEARCH REFERENCE

Repository:

https://github.com/CambridgeIIS/KWickChat

KWickChat explored constructing full AAC utterances from small keyword sets.

Useful idea:

```text
few explicit keywords
       ↓
full sentence candidates
```

Its repository does not expose a clear license in the surfaced metadata.

Therefore:

- study the concept/paper;
- do not copy source code unless license is independently verified.

---

## 3.5 Recent AAC authorship research — IMPORTANT CONSTRAINT

Recent AAC research raises an important warning:

AI can improve speed while also changing the user's voice or subtly steering what the person says.

Therefore this product must optimize for:

```text
EFFICIENCY
    without
LOSS OF AUTHORSHIP
```

The LLM may predict.

The user must remain the source of the final intent.

Never silently add a consequential semantic detail just because the model thinks it is likely.

---

# 4. CORE UX

When the user summons the notch agent from PASSIVE mode, prompt composition starts with a visible scaffold:

```text
                         🦉

                  I want you to…
```

The prefix is shown automatically.

The user does NOT spend a gaze selection choosing:

```text
I want you to
```

because the act of summoning the agent already communicates that.

The first four selections are semantic continuations.

Example:

```text
                  I want you to…

╭──────────────────────╮      ╭──────────────────────╮
│ FIND / SEARCH FOR…   │      │ WRITE / CREATE…     │
╰──────────────────────╯      ╰──────────────────────╯


╭──────────────────────╮      ╭──────────────────────╮
│ OPEN / USE…          │      │ SEND / TELL…        │
╰──────────────────────╯      ╰──────────────────────╯
```

These are examples.

They must NOT be hard-coded as a permanent menu.

The decoder generates them dynamically from the current prompt state and language prior.

---

# 5. CRITICAL RULE: THIS IS NOT A MENU TREE

Bad implementation:

```text
ACTION
    ↓
FILES
    ↓
PDF
    ↓
YESTERDAY
    ↓
SUMMARIZE
```

That is merely a hierarchical accessibility menu.

The real implementation is:

```text
I want you to…
       ↓
FIND / SEARCH FOR…
       ↓
I want you to find…
       ↓
A FILE OR DOCUMENT…
       ↓
I want you to find a file…
       ↓
I DOWNLOADED…
       ↓
I want you to find a file I downloaded…
       ↓
YESTERDAY…
       ↓
I want you to find the file I downloaded yesterday…
       ↓
AND SUMMARIZE IT…
```

Each selection contributes **linguistic/semantic evidence** to an evolving prompt.

The next four choices are generated from that evolving prompt.

---

# 6. THE VISIBLE PROMPT BUFFER

Always show what the system currently believes the user is constructing.

Example progression:

```text
I want you to…
```

then:

```text
I want you to find…
```

then:

```text
I want you to find a file or document…
```

then:

```text
I want you to find a file I downloaded…
```

then:

```text
I want you to find the file I downloaded yesterday…
```

then:

```text
I want you to find the file I downloaded yesterday
and summarize the methods section…
```

The user must never have to wonder:

> "What does the system think I said?"

The current prompt is always visible.

---

# 7. TWO REPRESENTATIONS OF THE PROMPT

Maintain both:

```ts
displayPrompt: string
```

and a structured semantic representation:

```ts
interface CanonicalIntent {
  clauses: IntentClause[];
  explicitEntities: ExplicitEntity[];
  constraints: IntentConstraint[];
  unresolvedSlots: IntentSlot[];
}
```

Reason:

The visible text may need small grammatical normalization.

The semantic structure must preserve exactly what the user has explicitly communicated.

Example:

User selects:

```text
FIND
FILE
DOWNLOADED
YESTERDAY
SUMMARIZE
METHODS SECTION
```

The UI can render:

```text
I want you to find the file I downloaded yesterday
and summarize the methods section.
```

Do not treat grammatical rewriting as new semantic evidence.

---

# 8. EVIDENCE HIERARCHY

Use this priority order.

```text
1. explicit gaze selections
2. explicitly entered hints / letters / keywords
3. current prompt prefix
4. accepted prior clauses in this prompt
5. user-approved personalization / lexicon
6. generic language/task prior
7. conversation history
8. screen/app/gaze context
```

SCREEN CONTEXT IS LAST.

It is an accelerator.

It is not the communication channel.

---

# 9. THE BLANK DESKTOP TEST

This is mandatory.

The prompt-completion system must work if:

```text
active application = Finder
screen = blank wallpaper
recent gaze target = nothing meaningful
browser history = unavailable
```

From that state the user must still be able to construct prompts such as:

```text
Open Spotify and play Bohemian Rhapsody.

Find the PDF I downloaded yesterday and summarize the methods section.

Email Daniel the summary and ask whether he can meet Thursday afternoon.

Search the web for beginner-friendly explanations of CRISPR.

Open my calendar and move tomorrow's 3 PM meeting to Friday.

Find the presentation I worked on last week and export it as a PDF.
```

If these prompts cannot be completed without screen inference, the subsystem has failed.

---

# 10. HOW SCREEN CONTEXT MAY BE USED

Screen context can:

- rerank otherwise plausible continuations;
- resolve deictic phrases explicitly chosen by user such as "this";
- make a visible object/name more likely as an offered candidate;
- reduce selections when the user is clearly referring to a visible target.

Screen context may NOT:

- silently append a target;
- silently choose a recipient;
- silently choose an action;
- replace explicit user evidence;
- prevent arbitrary prompt composition.

Example:

The screen shows a PDF.

The user has only selected:

```text
I want you to send…
```

BAD:

```text
system silently changes prompt to:
"I want you to send this PDF to Daniel."
```

GOOD:

```text
SEND THIS PDF…
SEND A FILE…
SEND A MESSAGE…
SEND SOMETHING ELSE…
```

The user chooses.

---

# 11. SEMANTIC CONTINUATIONS, NOT NEXT TOKENS

Do not ask the LLM for literal token autocomplete.

Bad:

```text
I want you to find…

the
a
my
out
```

Good:

```text
A FILE OR DOCUMENT…
SOMETHING ONLINE…
AN EMAIL OR MESSAGE…
AN APP / SETTING…
```

The predicted unit should usually be:

```text
1–8 meaningful words
```

and should substantially reduce uncertainty.

---

# 12. OPTIONS CAN BE DIFFERENT LENGTHS

A semantic choice can be:

### A short continuation

```text
A FILE…
```

### A clause

```text
THE FILE I DOWNLOADED YESTERDAY…
```

### A next action

```text
AND SUMMARIZE IT…
```

### A whole-prompt hypothesis

```text
FIND THE PDF I DOWNLOADED YESTERDAY
AND SUMMARIZE THE METHODS SECTION
```

The engine should become more aggressive about offering longer completions as evidence accumulates.

---

# 13. JUMP AHEAD AGGRESSIVELY — BUT NEVER SILENTLY

Goal:

Minimize gaze selections.

If the prefix is:

```text
I want you to find the file I downloaded yesterday…
```

do not force:

```text
AND…
SUMMARIZE…
THE…
METHODS…
SECTION…
```

Offer useful chunks:

```text
AND SUMMARIZE IT…
AND OPEN IT…
AND SEND IT…
AND TELL ME ABOUT IT…
```

After selecting summarize:

```text
THE WHOLE DOCUMENT
JUST THE METHODS
THE MAIN FINDINGS
A SPECIFIC SECTION
```

The user still explicitly chooses each semantic leap.

---

# 14. USER CONTROLS WHEN PROMPTING

During prompt completion use a four-zone utility shelf:

```text
┌────────────┬────────────┬────────────┬────────────┐
│  ← BACK    │ MORE / NONE│ SPELL/HINT │   × EXIT   │
└────────────┴────────────┴────────────┴────────────┘
```

This supersedes any earlier three-zone prompt-completion shelf.

Each utility target uses approximately one quarter of the usable width.

The hit region is the whole zone.

The label itself does not need to be gazed at precisely.

---

# 15. BACK

Meaning:

> "My last accepted semantic chunk was wrong."

Implementation:

- maintain exact prompt history;
- pop the previous accepted selection;
- restore the cached prior prompt;
- restore the exact prior A/B/C/D options where possible;
- do not invent a different history.

BACK is disabled at root.

---

# 16. MORE / NONE

Meaning:

> "None of these four continuations express where I want to go."

Behavior:

1. mark all four as rejected for this state;
2. preserve the existing prompt prefix;
3. generate meaningfully different continuations;
4. do not merely return synonyms.

After two consecutive MORE/NONE actions:

```text
enter clarification mode
```

unless the user chooses SPELL/HINT first.

---

# 17. SPELL / HINT — CRITICAL GUARANTEE

Meaning:

> "You cannot predict the missing information. I am going to give you more explicit evidence."

This is required for:

- names;
- filenames;
- URLs;
- novel technical terms;
- numbers;
- unusual verbs;
- uncommon ideas;
- arbitrary wording;
- anything the model repeatedly misses.

The user must always be able to invoke it directly.

Do not hide it behind repeated failures.

---

# 18. HINT TYPES

The prompt engine supports:

```ts
type HintType =
  | "letters"
  | "word_prefix"
  | "keyword"
  | "initialism"
  | "number"
  | "literal_text";
```

Examples:

```text
D
```

may mean:

> recipient/name begins with D

```text
Dan
```

may make:

```text
Daniel
Danielle
Danny
Dana
```

likely.

```text
pdf
```

can sharply rerank document-related completions.

```text
fpidsm
```

can be interpreted as an initials-style phrase hint if the user intentionally enters it.

---

# 19. USE DASHER FOR HINT ENTRY — DO NOT BUILD A NEW GAZE KEYBOARD

When SPELL/HINT is activated:

use the existing Dasher Web WASM build.

Repository:

https://github.com/dasher-project/dasher-web

Integration target:

```text
Electron renderer
    ↓
embedded/self-hosted Dasher canvas
    ↓
feed normalized gaze coordinates
    ↓
Dasher pointer input
    ↓
text emitted through onOutput
```

Start with the current public WASM wrapper.

Do not implement a new QWERTY keyboard unless Dasher integration proves impossible after a short bounded attempt.

---

# 20. HINT MODE UX

When hint mode opens:

```text
CURRENT PROMPT:

I want you to email the summary to ______


           [ Dasher input surface ]

Hint: "D"
```

As soon as text is emitted:

```text
debounce ~100–200 ms
        ↓
regenerate likely semantic completions
```

Example after `D`:

```text
DANIEL
DAVID
DAD
ANOTHER D… NAME
```

If the desired option appears, the user exits hint mode by selecting it.

The user should not be required to spell the full word if one or two letters are enough.

---

# 21. PROGRESSIVE DISCLOSURE OF HUMAN EVIDENCE

The philosophy is:

```text
predict first
    ↓
if wrong, add a little evidence
    ↓
predict again
    ↓
if wrong, add a little more
```

Not:

```text
prediction failed
    ↓
type everything manually
```

---

# 22. INITIALISM / ABBREVIATION MODE

Support SpeakFaster-style compressed evidence.

Example intended clause:

```text
find the paper I downloaded yesterday
```

Possible user shorthand:

```text
ftpidy
```

The decoder may produce:

```text
Find the paper I downloaded yesterday
Find the PDF I downloaded yesterday
Find the presentation I downloaded yesterday
Find the paper I deleted yesterday
```

The user selects one or provides more evidence.

Do not require users to learn initialism mode for the hackathon demo.

It is an optional efficiency feature.

---

# 23. KEYWORD MODE

A user may provide one or more keywords instead of exact wording.

Example:

```text
PDF
yesterday
methods
Daniel
```

The model may produce full prompt candidates:

```text
Find the PDF I downloaded yesterday,
summarize the methods section,
and email the summary to Daniel.
```

Keyword mode is especially valuable after prediction misses a rare concept.

---

# 24. CLARIFICATION MODE

Two consecutive MORE/NONE actions indicate that broad prediction is not reducing uncertainty.

At that point the system may ask one spoken clarification question.

The question should partition the remaining intent space.

Example:

```text
"Are you trying to find something,
create something,
communicate with someone,
or control something?"
```

Then A/B/C/D become answers.

Clarification is a temporary repair mechanism.

It is NOT the primary composition method.

After the answer:

```text
return to semantic continuation mode
```

---

# 25. DO NOT OVER-INTERROGATE

Maximum normal clarification behavior:

```text
one clarification question
        ↓
try prediction again
```

If prediction is still poor:

offer SPELL/HINT prominently.

Do not subject the user to a long twenty-questions flow.

For a user with expensive motor input, entering one useful letter may be cheaper than answering five vague questions.

---

# 26. PROMPT COMPLETION / "DO THAT"

The user must control when the intended prompt is complete.

Do not automatically execute simply because the model believes the prefix is executable.

When the current prompt could be complete, allow one of the four semantic candidates to be:

```text
DO THAT
```

or a full-prompt candidate visually representing the current complete prompt.

Example:

```text
CURRENT:
I want you to open Spotify…

A: DO THAT
B: AND PLAY SOMETHING…
C: AND FIND A SONG…
D: AND CHANGE A SETTING…
```

If the user chooses DO THAT:

```text
enter INTENT_CONFIRMATION
```

This preserves the ability to continue compound prompts.

---

# 27. COMPLETE-PROMPT CANDIDATES

As confidence rises, candidate generation should increasingly include full prompt hypotheses.

Example current evidence:

```text
find
PDF
downloaded yesterday
methods
email
Daniel
```

Candidates may be:

```text
A
Find the PDF I downloaded yesterday,
summarize the methods section,
and email the summary to Daniel.

B
Find the PDF I downloaded yesterday
and email it directly to Daniel.

C
Find yesterday's PDF,
summarize the whole document,
and email the summary to Daniel.

D
Find the PDF,
summarize the methods,
and save the summary.
```

Selecting A means:

```text
candidate becomes proposed final prompt
        ↓
INTENT_CONFIRMATION
```

---

# 28. AUTHORSHIP RULE

The model is allowed to:

- normalize grammar;
- add function words;
- resolve agreement;
- convert selected semantic chunks into natural English.

The model is NOT allowed to:

- add a new recipient;
- add a date;
- add a reason;
- add a preference;
- add a factual claim;
- add a tone;
- add a consequential instruction;

unless that meaning was explicitly selected, entered as a hint, or confirmed.

Example evidence:

```text
EMAIL
DANIEL
MEETING
```

Allowed:

```text
Email Daniel about the meeting.
```

Not allowed:

```text
Email Daniel and tell him I'll be late to the meeting.
```

"late" was never supplied.

---

# 29. SCREEN CONTEXT MUST NEVER OVERRIDE AUTHORSHIP

Suppose Gmail currently shows:

```text
Professor Lee
Subject: Thursday meeting
```

The user begins:

```text
I want you to email…
```

The system may OFFER:

```text
PROFESSOR LEE…
DANIEL…
A RECENT CONTACT…
SOMEONE ELSE…
```

It may not silently set:

```text
recipient = Professor Lee
```

The user chooses.

---

# 30. PERSONALIZATION

Personalization can be extremely valuable for:

- names;
- recurring contacts;
- common applications;
- repeated phrases;
- habitual tasks;
- user's writing style.

But personalization must be user-controlled.

For hackathon v1:

implement a simple local profile/lexicon:

```ts
interface UserLexicon {
  people: string[];
  places: string[];
  apps: string[];
  recurringPhrases: string[];
  customVocabulary: string[];
}
```

Store locally.

Provide sample demo data.

Do not require uploading a person's entire communication history.

---

# 31. PRIVACY RULE

Do not automatically train/fine-tune on all user messages.

Recent AAC research has highlighted risks where deeply personalized models can:

- alter perceived authorship;
- shape a user's voice;
- resurface private information in inappropriate contexts.

For the demo:

- personalization is local/simple;
- no silent training;
- no background ingestion of private conversations.

---

# 32. MODEL CHOICE

Use OpenAI Responses API.

Default semantic generation model:

```text
gpt-5.6-luna
```

Reason:

- fast;
- inexpensive relative to larger models;
- supports Structured Outputs;
- supports streaming;
- strong enough for repeated semantic completion calls.

Do NOT invoke the expensive Computer Use executor model for every prompt-selection turn.

Prompt completion and task execution are separate layers.

---

# 33. DECODER REQUEST — NO TOOLS

The semantic decoder call should have:

```text
model: gpt-5.6-luna
tools: []
structured output: enabled
reasoning effort: none or lowest stable setting
```

It does not need:

- web search;
- Computer Use;
- file search;
- code interpreter.

Those would add latency and unpredictability.

---

# 34. CANDIDATE GENERATION PIPELINE

Do not ask the LLM for only four raw options and display them directly.

Use a two-stage decoder.

```text
CURRENT PROMPT STATE
        ↓
Luna generates 12–20 candidate continuations
        ↓
local semantic embeddings
        ↓
cluster / diversify
        ↓
rank for probability + information gain + diversity
        ↓
select 4
        ↓
DISPLAY
```

This makes the semantic decoder a real algorithm rather than four arbitrary LLM outputs.

---

# 35. LOCAL EMBEDDINGS

Use:

```text
@huggingface/transformers
```

with:

```text
Xenova/all-MiniLM-L6-v2
```

or the closest currently supported equivalent.

Purpose:

- embed candidate semantic continuations locally;
- detect near-duplicates;
- enforce diversity;
- avoid another cloud call.

Example:

```ts
const extractor = await pipeline(
  "feature-extraction",
  "Xenova/all-MiniLM-L6-v2"
);
```

Use:

```text
pooling = mean
normalize = true
```

Cache the model after initial load.

---

# 36. DIVERSITY ALGORITHM

Given candidate set:

```text
C = {c1 ... cN}
```

Each candidate includes:

```ts
interface RawCandidate {
  label: string;
  continuation: string;
  resultingPrompt: string;
  modelScore: number;
  type:
    | "continuation"
    | "next_clause"
    | "full_prompt"
    | "do_that";
}
```

Embed `resultingPrompt`.

Greedy selection:

```text
select highest-scoring first candidate

then repeatedly choose candidate maximizing:

score =
    0.70 * modelScore
  + 0.30 * semanticNovelty
```

where:

```text
semanticNovelty =
1 - max cosine similarity to already selected options
```

Reject near duplicates.

Initial suggested duplicate threshold:

```text
cosine similarity > 0.82
```

Tune with tests.

If fewer than four diverse candidates remain:

- request additional candidates;
- or relax threshold slightly.

Never fill missing slots with synonyms solely to reach four.

---

# 37. INFORMATION GAIN HEURISTIC

When several continuations are similarly likely, prefer the one that divides future intent space most usefully.

Example prefix:

```text
I want you to find…
```

Better set:

```text
A FILE / DOCUMENT
SOMETHING ONLINE
AN EMAIL / MESSAGE
AN APP / SETTING
```

Worse set:

```text
A FILE
A DOCUMENT
A PDF
A DOWNLOAD
```

The first set reduces uncertainty over intent families.

---

# 38. CANDIDATE LENGTH HEURISTIC

Early in the prompt:

- broader chunks may be appropriate.

Later:

- longer, more specific chunks are appropriate.

As evidence grows:

```text
average candidate semantic payload should grow
```

The decoder should try to collapse multiple future selections when confidence supports it.

---

# 39. STRUCTURED OUTPUT SCHEMA

Use Structured Outputs.

Conceptual response:

```ts
interface DecoderResponse {
  mode:
    | "predict"
    | "clarify";

  normalizedPrompt: string;

  promptIsExecutable: boolean;

  openSlots: Array<{
    name: string;
    description: string;
  }>;

  candidates: Array<{
    id: string;
    label: string;
    continuation: string;
    resultingPrompt: string;

    type:
      | "continuation"
      | "next_clause"
      | "full_prompt"
      | "do_that";

    semanticGroup: string;
    estimatedLikelihood: number;

    introducesNewMeaning: boolean;
  }>;

  clarification?: {
    spokenQuestion: string;
    answers: Array<{
      label: string;
      meaning: string;
      resultingEvidence: string;
    }>;
  };
}
```

The model should generate 12–20 candidates.

The UI layer chooses four.

---

# 40. CRITICAL VALIDATION

Before accepting the model response:

For every candidate:

1. verify `resultingPrompt` preserves all explicit prior evidence;
2. verify no accepted semantic clause disappeared;
3. flag newly introduced entities/details;
4. if `introducesNewMeaning` is true, it is allowed only because the candidate itself is being offered for explicit selection;
5. never mutate the active prompt until the user chooses the candidate.

The model may propose.

The user commits.

---

# 41. EXACT DECODER SYSTEM PROMPT

Use the following as the starting system/developer instruction for Luna.

```text
You are the semantic prompt-completion engine for a gaze-based AAC interface.

The user has severe motor/speech impairment and each deliberate selection is expensive.

Your task is NOT to guess the user's whole intention and silently complete it.
Your task is to generate highly useful semantic continuations that let the user communicate the intended agent prompt with the fewest selections possible.

The current prompt contains meanings the user has already explicitly selected.
NEVER remove, contradict, or silently alter those meanings.

Generate 12–20 candidate continuations.

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

If two or more consecutive candidate sets were rejected, generate one concise clarification question whose four answers divide the remaining plausible intent space.

Return only data matching the provided JSON schema.
Do not include chain-of-thought.
```

---

# 42. DECODER INPUT

Every call should include concise state.

Example:

```json
{
  "displayPrompt": "I want you to find a file I downloaded yesterday and...",
  "explicitSemanticEvidence": [
    "action=find",
    "target=file",
    "relation=downloaded_by_user",
    "time=yesterday"
  ],
  "hints": [],
  "rejectedSets": [],
  "historyDepth": 4,
  "userLexicon": {
    "people": ["Daniel", "Professor Lee"],
    "apps": ["Spotify"]
  },
  "optionalContext": {
    "activeApp": null,
    "visibleReferent": null
  }
}
```

Keep inputs compact to reduce latency/cost.

---

# 43. SCREEN CONTEXT WEIGHTING

Implementation rule:

screen context may rerank candidates but should not dominate candidate generation unless:

```text
the user explicitly selected a deictic concept
```

such as:

```text
THIS
THAT
THIS VIDEO
THIS EMAIL
THIS FILE
```

Only then should visual/gaze reference resolution become first-class.

Before a deictic choice:

screen context is weak.

---

# 44. SPECULATIVE NEXT-STATE GENERATION

While four options are visible:

prepare next states for:

```text
if A selected
if B selected
if C selected
if D selected
```

This can happen in parallel.

Cache:

```ts
Map<optionId, DecoderResponse>
```

On selection:

```text
commit option
        ↓
use cached next response
        ↓
new cards appear immediately
```

No external action may occur speculatively.

---

# 45. SPECULATE MORE / NONE

While the user is deciding, also precompute:

```text
alternative candidate set if MORE chosen
```

If rejected once:

present it immediately.

If rejected twice:

prefetch clarification question.

---

# 46. DO NOT SPECULATE USER COMMITMENTS

You may precompute:

- text;
- embeddings;
- candidates;
- TTS;
- possible clarifications.

You may not:

- click;
- type into another application;
- send;
- delete;
- navigate;
- execute Computer Use;

until prompt confirmation.

---

# 47. PROMPT HISTORY

Maintain a deterministic history stack.

```ts
interface PromptNode {
  nodeId: string;

  displayPrompt: string;
  canonicalIntent: CanonicalIntent;

  explicitEvidence: ExplicitEvidence[];
  hints: Hint[];

  rawCandidates: RawCandidate[];
  displayedCandidates: DisplayCandidate[];

  rejectedCandidateIds: string[];
}
```

On every committed selection:

```text
push current node
```

On BACK:

```text
restore previous node exactly
```

---

# 48. HINT DATA MUST PERSIST THROUGH FUTURE PREDICTION

If the user explicitly entered:

```text
Dan
```

do not discard that after one prediction round.

Keep it until:

- relevant slot is resolved;
- user backs past it;
- user explicitly removes it.

---

# 49. CORRECTION OF A NEAR-MISS

If a full-prompt candidate is almost correct, the user should not need to rebuild from root.

Selecting CHANGE during final confirmation returns to edit mode.

Generate likely correction dimensions:

```text
CHANGE PERSON
CHANGE ACTION
CHANGE TARGET
CHANGE TIME / CONDITION
```

If necessary:

```text
SPELL / HINT
```

remains available.

---

# 50. FINAL INTENT CONFIRMATION

When user selects DO THAT or a complete prompt candidate:

show the full prompt prominently.

Sprite speaks it.

Example:

```text
Find the PDF I downloaded yesterday,
summarize the methods section,
and email the summary to Daniel.
```

Then:

```text
YES / DO IT
CHANGE IT
READ AGAIN
CANCEL
```

Only YES starts Computer Use.

---

# 51. EXECUTOR RECEIVES NATURAL LANGUAGE + STRUCTURE

Pass both:

```ts
{
  naturalLanguagePrompt,
  canonicalIntent,
  explicitEvidence
}
```

The Computer Use agent should primarily operate from natural language.

The structured intent is useful for:

- validation;
- consequences;
- steering;
- debugging.

---

# 52. PROMPT COMPOSITION DOES NOT CALL COMPUTER USE

The decoder and executor are separated.

```text
PROMPT COMPOSER
      ↓ complete + confirm
EXECUTOR
```

Do not let the CU model "help" by acting before the prompt is finished.

---

# 53. ARBITRARY STRING GUARANTEE

The project must have this fallback chain:

```text
semantic continuation
        ↓
MORE / alternate predictions
        ↓
clarification
        ↓
SPELL / HINT
        ↓
partial letters / keywords
        ↓
prediction
        ↓
more letters if needed
        ↓
Dasher arbitrary text entry
```

There is always another path.

No dead end.

---

# 54. EXAMPLE — NO CONTEXT

Intended:

```text
Find the PDF I downloaded yesterday,
summarize the methods section,
and email the summary to Daniel.
```

Possible path:

```text
I want you to…

FIND / SEARCH FOR
        ↓

I want you to find…

A FILE / DOCUMENT
        ↓

I want you to find a file…

I DOWNLOADED
        ↓

I want you to find a file I downloaded…

YESTERDAY
        ↓

I want you to find the file I downloaded yesterday…

AND SUMMARIZE IT
        ↓

I want you to find the file I downloaded yesterday
and summarize…

JUST THE METHODS
        ↓

I want you to find the file I downloaded yesterday
and summarize the methods section…

AND EMAIL THE SUMMARY
        ↓

...and email the summary…

SPELL / HINT
        ↓

D
        ↓

DANIEL
        ↓

FULL PROMPT CANDIDATE
        ↓

CONFIRM
```

Screen context contributed nothing.

System still succeeded.

---

# 55. EXAMPLE — PREDICTION JUMPS AHEAD

Intended:

```text
Open Spotify and play Bohemian Rhapsody.
```

Possible path:

```text
I want you to…

OPEN / USE
        ↓

OPEN SPOTIFY…
        ↓

I want you to open Spotify…

PLAY BOHEMIAN RHAPSODY
PLAY MY LIKED SONGS
FIND A SONG
DO THAT
```

If the user's lexicon/history makes Bohemian Rhapsody likely:

one more selection finishes.

If not:

```text
FIND / PLAY A SONG
        ↓
SPELL / HINT
        ↓
Boh
        ↓
BOHEMIAN RHAPSODY
```

---

# 56. EXAMPLE — MODEL GETS IT WRONG

Intended:

```text
Create a spreadsheet comparing my internship offers.
```

Initial:

```text
WRITE AN EMAIL
CREATE A DOCUMENT
MAKE A PRESENTATION
CREATE SOMETHING ELSE
```

User selects:

```text
MORE / NONE
```

Second set:

```text
CREATE A SPREADSHEET
WRITE CODE
MAKE A PLAN
CREATE A DESIGN
```

User selects spreadsheet.

The decoder corrected without requiring full spelling.

---

# 57. EXAMPLE — RARE TECHNICAL TERM

Intended:

```text
Find papers about mechanistic interpretability.
```

Predictions miss the term.

User:

```text
FIND PAPERS ABOUT…
        ↓
SPELL / HINT
        ↓
mech int
```

Decoder proposes:

```text
MECHANISTIC INTERPRETABILITY
MECHANICAL INTERPRETATION
MECHANISTIC INTERACTIONS
SOMETHING ELSE
```

User selects correct term.

---

# 58. EXAMPLE — PERSON NAME

Intended:

```text
Email Xochitl the report.
```

Prediction may not know Xochitl.

User enters:

```text
Xo
```

The decoder can predict candidates.

If not:

continue Dasher entry:

```text
Xoch
```

until exact entity is available.

This is why the system can support arbitrary names.

---

# 59. LATENCY BUDGET

Target prompt-turn perceived latency:

```text
selection commit → next visual state:
< 150 ms when prefetched

non-prefetched:
show transition immediately
model result ideally < 600 ms
```

Do not block visual feedback while waiting for TTS.

---

# 60. CACHE PREFIXES

Many decoder calls share a stable system prompt and schema.

Use API prompt caching where supported.

Keep the variable state payload small and placed after stable instructions.

---

# 61. NEVER SHOW RAW MODEL THOUGHT

Do not expose:

- reasoning;
- hidden ranking explanation;
- chain-of-thought.

The user sees:

- current prompt;
- four continuations;
- utility controls;
- concise spoken questions.

---

# 62. UI DESIGN FOR PROMPT BUFFER

The current prompt should appear near the notch or top-center, visually associated with the conversational sprite.

Example:

```text
        ╭──────────────────────────────────────────╮
        │ 🦉  I want you to find a file I         │
        │     downloaded yesterday and…            │
        ╰──────────────────────────────────────────╯
```

Do not obscure the application more than necessary.

For long prompts:

- max ~2 lines visible;
- smoothly marquee/ellipsis older prefix if required;
- allow expanded readback on request.

The newest semantic chunk should be visually emphasized briefly.

---

# 63. UI DESIGN FOR CANDIDATES

Four floating glass cards.

Each card:

- short label;
- optional tiny icon;
- no paragraph text;
- huge invisible hit region;
- stable position.

Detailed full prompt candidates may use slightly smaller text or two lines.

Never resize cards dramatically during gaze dwell.

---

# 64. HOVER / DWELL

On candidate gaze:

```text
~150 ms:
subtle highlight

~300 ms:
dwell indicator begins / becomes clear

~550 ms:
commit
```

The current prompt should update immediately on commit.

Then next options replace old options.

---

# 65. ACCESSIBILITY: COGNITIVE LOAD

Prediction systems can save motor actions while adding visual/cognitive burden.

Therefore:

- only four primary candidates;
- short labels;
- stable geometry;
- no reordering while visible;
- no scrolling candidate list;
- no 20 suggestions on screen;
- no tiny text prediction bar.

Internally generate many.

Externally show four.

---

# 66. MODEL FAILURE

If Luna request fails:

1. retry once quickly;
2. use cached speculative state if available;
3. use local generic fallback options;
4. SPELL/HINT remains available;
5. never strand the user.

Generic root fallback:

```text
FIND / GET…
CREATE / WRITE…
OPEN / USE…
SEND / TELL…
```

Only use this when model service is unavailable.

---

# 67. OFFLINE / API-DOWN FALLBACK

The complete autonomous-agent product requires cloud models for full power.

But prompt entry should degrade gracefully.

If semantic API is unavailable:

- keep prompt history;
- offer Dasher;
- allow arbitrary text entry;
- allow local TTS if configured.

The accessibility input layer should not simply crash.

---

# 68. IMPLEMENTATION MODULES

Create:

```text
src/prompt-completion/
    PromptCompletionEngine.ts
    PromptState.ts
    CandidateGenerator.ts
    CandidateValidator.ts
    CandidateDiversifier.ts
    SemanticEmbeddings.ts
    PromptHistory.ts
    HintController.ts
    DasherAdapter.ts
    SpeculationCache.ts
    CompletionController.ts
    decoderSchema.ts
    decoderPrompt.ts
```

Tests:

```text
tests/prompt-completion/
```

---

# 69. PromptCompletionEngine API

```ts
interface PromptCompletionEngine {
  start(context?: OptionalContext): Promise<PromptViewState>;

  selectOption(
    optionId: "A" | "B" | "C" | "D"
  ): Promise<PromptViewState>;

  more(): Promise<PromptViewState>;

  back(): Promise<PromptViewState>;

  beginHint(): Promise<HintViewState>;

  updateHint(text: string): Promise<PromptViewState>;

  acceptHintCandidate(id: string): Promise<PromptViewState>;

  requestCompletion(): Promise<IntentConfirmationState>;

  exit(): Promise<void>;
}
```

---

# 70. VIEW STATE

```ts
interface PromptViewState {
  sessionId: string;

  displayPrompt: string;

  options: [
    DisplayOption,
    DisplayOption,
    DisplayOption,
    DisplayOption
  ];

  canBack: boolean;
  canMore: boolean;
  canHint: boolean;
  canExit: boolean;

  mode:
    | "predict"
    | "clarify"
    | "hint";

  clarificationQuestion?: string;

  speculativeReady: Partial<
    Record<"A" | "B" | "C" | "D" | "MORE", boolean>
  >;
}
```

---

# 71. OPTION CONTRACT

```ts
interface DisplayOption {
  quadrant: "A" | "B" | "C" | "D";

  label: string;

  resultingPrompt: string;

  type:
    | "continuation"
    | "next_clause"
    | "full_prompt"
    | "do_that";

  semanticGroup: string;
}
```

---

# 72. PROMPT COMPLETION BENCHMARKS

Build an automated benchmark suite.

Include at least 30 target prompts.

Categories:

```text
app control
file retrieval
web research
email
messaging
calendar
document editing
multi-step tasks
rare entities
technical vocabulary
compound prompts
```

The benchmark simulates a cooperative oracle user:

- if exact semantic continuation matches intended prompt, select it;
- otherwise MORE;
- if needed provide smallest hint capable of disambiguation.

Measure:

```text
deliberate selections
hint characters
MORE count
BACK count
model calls
time
semantic fidelity
```

---

# 73. PRIMARY METRIC: INTENT COMPRESSION

Define:

```text
Intent Compression Ratio =
baseline deliberate input actions
/
our deliberate gaze actions
```

For a text baseline:

```text
baseline = characters or gaze-key selections needed
```

For semantic system:

```text
our actions =
quadrant commits
+ utility commits
+ explicit hint-entry commits
```

Show this during the hackathon demo if possible.

---

# 74. SECONDARY METRIC: DEAD-END RATE

Target:

```text
0%
```

Because Dasher/literal input provides arbitrary-string fallback.

If a test prompt cannot eventually be expressed:

critical failure.

---

# 75. SEMANTIC FIDELITY

Do not score only text similarity.

Two prompts can be phrased differently while expressing the same task.

For tests:

validate semantic slots:

```text
action
target
recipient
constraints
time
subtasks
order where relevant
```

Any missing or invented consequential slot is a failure.

---

# 76. BLANK-DESKTOP ACCEPTANCE SUITE

Run every benchmark with:

```text
optionalContext = null
```

At least 90% of ordinary benchmark prompts should reach the intended full prompt without using literal full-sentence Dasher entry.

All 100% must remain possible with fallback.

---

# 77. CONTEXT-BOOST SUITE

Then rerun with helpful context.

Expected:

```text
same semantic fidelity
fewer or equal selections
```

If context reduces fidelity:

context weighting is too strong.

---

# 78. AUTHORSHIP TESTS

Test that these do NOT happen:

Evidence:

```text
email Daniel
```

Bad generated final:

```text
Email Daniel that I'll be late.
```

Evidence:

```text
find yesterday's PDF
```

Bad:

```text
Find yesterday's biology PDF.
```

Evidence:

```text
send this
```

Bad:

```text
Send this to my sister.
```

unless sister was explicitly selected/hinted.

---

# 79. DIVERSITY TESTS

For every candidate set:

reject if:

- 3+ candidates are near synonyms;
- candidates differ only grammatically;
- two candidates have cosine similarity above configured threshold without good reason;
- all four belong to same narrow semantic sub-branch when broader plausible branches exist.

---

# 80. SPECIFIC DEMO TEST

Before demo, hard-test this exact no-context prompt:

```text
Find the PDF I downloaded yesterday,
summarize the methods section,
and email the summary to Daniel.
```

Requirements:

- blank desktop;
- no pre-seeded screen referent;
- no hard-coded prompt;
- Daniel may exist in local demo lexicon;
- prompt must be built through real decoder;
- user must be able to reject incorrect candidates;
- hint path must work if Daniel does not appear;
- final readback;
- confirmation;
- executor receives correct prompt.

---

# 81. SECOND DEMO TEST

```text
Open Spotify and play Bohemian Rhapsody.
```

Run twice:

### Test A
song in demo personalization.

### Test B
song not in personalization.

Test B must demonstrate:

```text
prediction
→ hint
→ prediction
```

---

# 82. THIRD DEMO TEST

Novel technical term:

```text
Search for beginner explanations of mechanistic interpretability.
```

The purpose is to prove that novel vocabulary does not break the system.

---

# 83. DO NOT HARD-CODE THE DEMO PROMPTS

They may appear only in:

```text
tests/
fixtures/
demo scripts
```

The semantic production code must not check for:

```text
"PDF"
"Daniel"
"Spotify"
"Bohemian Rhapsody"
```

to force expected output.

---

# 84. MODEL AGNOSTIC ENGINE

The candidate-generation provider should use an interface.

```ts
interface SemanticModelProvider {
  generateCandidates(
    state: DecoderInput
  ): Promise<DecoderResponse>;
}
```

Default:

```text
OpenAILunaProvider
```

This allows future replacement without rewriting the prompt composer.

---

# 85. DASher ADAPTER CONTRACT

```ts
interface DasherAdapter {
  mount(container: HTMLElement): Promise<void>;
  setGazePoint(x: number, y: number): void;
  start(): void;
  stop(): void;
  clear(): void;

  onTextChanged(
    callback: (text: string) => void
  ): () => void;
}
```

Do not fork DasherCore unless necessary.

Prefer using the maintained WASM wrapper.

---

# 86. LOCAL EMBEDDING ADAPTER

```ts
interface SemanticEmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
}
```

Default:

```text
TransformersJsMiniLMProvider
```

Load lazily at semantic-session start or application warm-up.

Cache candidate embeddings per session.

---

# 87. GRAMMATICAL NORMALIZER

Do not spend a separate LLM call solely on grammar after every selection.

The main decoder response includes:

```text
normalizedPrompt
```

Use it for display only if it preserves semantic evidence.

Keep canonical semantic state separately.

---

# 88. PUNCTUATION / FILLER

The user should not select:

```text
please
the
a
an
to
and
comma
period
```

unless linguistically necessary for disambiguation.

The system supplies grammatical glue automatically.

The user supplies meaning.

---

# 89. COMPOUND TASKS

The system must support:

```text
ACTION 1
AND
ACTION 2
AND
ACTION 3
```

Example:

```text
find document
→ summarize section
→ email summary
```

Do not treat the first executable clause as automatically complete.

Offer:

```text
DO THAT
```

alongside plausible continuation clauses.

---

# 90. ORDER OF OPERATIONS

When multiple clauses are explicitly composed:

preserve order unless order is semantically irrelevant.

Example:

```text
Find the file,
summarize it,
then email the summary.
```

Do not execute:

```text
email file,
then summarize.
```

---

# 91. NEGATION

Explicit negation is high-priority evidence.

Example:

```text
DON'T SEND IT YET
```

must survive all normalization.

Never "clean up" a negative into a positive action.

---

# 92. NUMBERS

For numbers:

- offer likely ranges when appropriate;
- SPELL/HINT may accept numeric literal;
- do not guess exact amounts/dates when consequential.

Example:

```text
move meeting to…
```

Can offer:

```text
TOMORROW
FRIDAY
NEXT WEEK
A SPECIFIC DATE
```

For a specific date:

use hint/literal selector.

---

# 93. NAMES / ENTITIES

Entity prediction order:

```text
explicit hint match
local user lexicon
recent user-approved entities
generic candidate
SPELL/HINT
```

Do not use screen entities as automatic truth.

---

# 94. "THIS" / DEICTIC MODE

If user explicitly selects:

```text
THIS
```

then resolve referent using:

```text
recent gaze fixation
accessibility element
active window
vision
```

Show a temporary highlight.

If ambiguous:

ask one clarification.

This is the point where screen/gaze context becomes critical.

Not before.

---

# 95. FIRST-ROUND OPTIONS

Do not permanently hard-code the first four.

However, if the model is unavailable and no context exists, use fallback:

```text
FIND / GET…
CREATE / WRITE…
OPEN / USE…
SEND / TELL…
```

The real model should generate the first set dynamically and may replace one branch with another high-probability action family.

---

# 96. THE ROOT PREFIX

Default:

```text
I want you to…
```

The display may omit it later if prompt becomes long.

Internally:

```text
root speech act = request agent action
```

This is not user-authored semantic content that costs a selection.

---

# 97. NON-TASK EXPRESSION

The primary product is agent prompting.

If user needs general AAC expression rather than agent execution:

the system may switch to:

```text
I want to say…
```

This is secondary.

Do not mix this into every root interaction.

The hackathon MVP should optimize:

```text
I want you to…
```

---

# 98. NO SCREEN-FIRST ROOT

Do not generate root solely from active application.

Bad:

```text
Gmail open
        ↓
REPLY
FORWARD
ARCHIVE
DELETE
```

That is a gaze app menu.

Better:

```text
I want you to…

SEND / TELL…
FIND / GET…
WRITE / CREATE…
OPEN / USE…
```

If later the user chooses:

```text
SEND…
THIS EMAIL…
```

then Gmail context helps.

---

# 99. OPTIONAL CONTEXT SHOULD SAVE SELECTIONS, NOT DEFINE POSSIBILITIES

Correct:

```text
without context:
6 selections

with useful context:
3 selections
```

Incorrect:

```text
without context:
impossible

with context:
possible
```

---

# 100. BUILD ORDER

Implement in this order.

### Phase 1
Prompt-state machine with mouse/keyboard simulation.

### Phase 2
Luna Structured Outputs candidate generation.

### Phase 3
Local MiniLM diversity selection.

### Phase 4
BACK / MORE / EXIT.

### Phase 5
SPELL/HINT using Dasher Web.

### Phase 6
Akinator clarification after repeated rejection.

### Phase 7
Speculative next-state generation.

### Phase 8
Gaze input integration.

### Phase 9
Visual polish.

### Phase 10
Computer Use handoff after confirmation.

Do not wait for perfect gaze tracking before proving the semantic composer works.

---

# 101. DEVELOPMENT SIMULATION

Support keyboard controls:

```text
1 = A
2 = B
3 = C
4 = D

B = BACK
M = MORE
H = HINT
X = EXIT

N = notch summon
```

This lets the coding agent debug prompt composition deterministically without staring at the screen for every test.

Production gaze uses the same state-machine actions.

---

# 102. LOGGING FOR BENCHMARKS

Log only development/demo-safe data unless explicit user consent exists.

Record:

```ts
{
  sessionId,
  targetPromptId?,
  selectedOptionIds,
  candidateSets,
  hintCharacterCount,
  moreCount,
  backCount,
  elapsedMs,
  finalPrompt,
  success
}
```

Do not persist sensitive real user prompt history by default.

---

# 103. FAILURE CONDITIONS

The prompt composer is NOT done if any of these are true:

- it relies on current screen to know what user wants;
- it displays four app commands instead of prompt continuations;
- it cannot express a rare name;
- it cannot express a novel technical term;
- two bad prediction rounds leave user stuck;
- the user must switch to keyboard/mouse;
- the model silently changes user meaning;
- screen context injects unselected details;
- candidate options are mostly synonyms;
- a compound prompt executes after first clause;
- there is no explicit way to indicate the prompt is complete;
- there is no arbitrary text fallback.

---

# 104. DEFINITION OF DONE

All must pass.

### Core composition
- [ ] starts from `I want you to…`
- [ ] first selection is meaningful semantic content
- [ ] every selection updates visible prompt
- [ ] next options are semantic continuations
- [ ] choices are not fixed menu hierarchy
- [ ] model can offer long jumps/full prompts

### Context independence
- [ ] blank desktop benchmark works
- [ ] screen context disabled does not break arbitrary prompt entry
- [ ] screen context only reduces selections

### Prediction repair
- [ ] MORE gives genuinely different predictions
- [ ] second MORE can trigger concise clarification
- [ ] SPELL/HINT always reachable
- [ ] one or a few letters can rerank predictions
- [ ] keyword hints work
- [ ] arbitrary literal text can be entered through Dasher

### Authorship
- [ ] selected meaning never disappears
- [ ] unselected consequential details are never silently added
- [ ] context cannot override explicit evidence
- [ ] final prompt is read back
- [ ] user confirms before execution

### Diversity algorithm
- [ ] model generates >4 raw candidates
- [ ] candidates embedded locally
- [ ] near duplicates removed
- [ ] four displayed options cover distinct semantic directions

### Performance
- [ ] speculative A/B/C/D states work
- [ ] cached selection transitions feel immediate
- [ ] Luna calls do not invoke tools
- [ ] Computer Use model is not invoked during composition

### Accessibility
- [ ] four stable quadrants
- [ ] BACK
- [ ] MORE/NONE
- [ ] SPELL/HINT
- [ ] EXIT
- [ ] gaze-only after calibration
- [ ] no dead end

---

# 105. FINAL TRUTH

This is the product:

```text
                         🦉

                  I want you to…
                         │
                         ▼
             FOUR SEMANTIC CONTINUATIONS
                         │
                        👁
                         ▼
               PROMPT BECOMES RICHER
                         │
                         ▼
             FOUR BETTER CONTINUATIONS
                         │
              ┌──────────┴──────────┐
              │                     │
          prediction works      prediction misses
              │                     │
              ▼                     ▼
         keep selecting       MORE or HINT
                                    │
                              add minimum
                              human evidence
                                    │
                                    ▼
                              predict again
                                    │
                         ┌──────────┴──────────┐
                         │                     │
                  desired prompt found     still missing
                         │                     │
                         ▼                     ▼
                     DO THAT              add evidence
                         │                     │
                         └──────────┬──────────┘
                                    ▼
                          FULL PROMPT CONFIRM
                                    │
                                    ▼
                            COMPUTER USE
```

The screen may help.

The user's prior history may help.

The language model may help.

But the communication channel stands on its own.

---

# 106. FINAL COMMAND TO THE CODING AGENT

Treat this file as the authoritative specification for prompt completion.

Do not reintroduce the earlier context-first design.

Before implementation:

1. inspect SpeakFaster;
2. inspect Dasher Web/DasherCore;
3. inspect ACAT prediction concepts;
4. use existing libraries instead of rebuilding their low-level functionality;
5. implement the prompt composer independently of Computer Use;
6. prove it on a blank desktop;
7. prove hint recovery with an unknown name;
8. prove arbitrary fallback;
9. benchmark deliberate gaze selections;
10. only then connect final confirmed prompt to the executor.

The core innovation to preserve is:

> **The user does not operate software with their eyes.**
>
> **The user uses their eyes to transmit just enough semantic information for an agent to understand a complete instruction.**
>
> **Every selection should buy as much meaning as possible.**
