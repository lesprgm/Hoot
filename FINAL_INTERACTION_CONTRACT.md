# FINAL INTERACTION CONTRACT
## Notch Summon, Semantic Conversation, Exit, Correction, and Computer-Use Interruption

**Status:** AUTHORITATIVE / FINAL  
**Project:** Gaze-to-Agent Accessibility System  
**Purpose:** This document is the final UX/state-machine contract for the product.  
**Audience:** Coding agent / implementation team.

> **Current implementation scope (2026-09-12):** Apple iPhone Mirroring integration is deferred and is not part of the current build. Any phone-specific requirements elsewhere in this contract are historical; the shipped window-halo behavior is application-agnostic.

---

# 0. AUTHORITY AND PRECEDENCE

This document resolves the remaining interaction ambiguities after:

- `GAZE_AGENT_ONE_SHOT_SPEC.md`
- `NOTCH_SPRITE_UI_SPEC.md`

If any earlier document conflicts with this document on:

- how the agent is summoned,
- what dwelling on the notch does,
- how semantic mode is exited,
- how BACK works,
- how NONE/MORE works,
- what happens when gaze is lost,
- how Computer Use is interrupted,
- how confirmation works,

**THIS DOCUMENT WINS.**

Do not ask for clarification on these behaviors.

Implement them exactly as specified below.

---

# 1. ONE-SENTENCE PRODUCT MODEL

> The user's normal computer remains visible and usable; a persistent conversational sprite lives at the notch, a deliberate dwell summons semantic communication, transient large gaze regions let the user express intent, and a separate Computer Use agent performs the resulting task.

The user must never need:

- a mouse,
- a keyboard,
- speech,
- a physical switch,

after gaze calibration for the primary demo flows.

---

# 2. CORE MENTAL MODEL

The user needs to learn only this:

```text
LOOK AT NOTCH + HOLD
        =
TALK TO AGENT


A / B / C / D
        =
ANSWER / NARROW MEANING


NONE / MORE
        =
"YOU'RE NOT GETTING IT YET"


BACK
        =
"I CHOSE THE WRONG BRANCH"


EXIT
        =
"STOP THIS CONVERSATION"


WHILE COMPUTER USE IS RUNNING:

LOOK AT NOTCH + HOLD
        =
INTERRUPT / STEER
```

This mental model must remain true everywhere:

- Safari / Chrome
- Mail / Gmail
- documents
- YouTube
- Spotify
- Finder
- arbitrary desktop apps
- iPhone Mirroring
- arbitrary mirrored phone apps

---

# 3. PERSISTENT NOTCH SPRITE

The conversational sprite is persistent while Assistive Session is enabled.

It is the universal known point for:

1. summoning the conversational agent from normal mode;
2. interrupting the executor while Computer Use is running;
3. communicating conversational/system status.

The sprite does **not** disappear automatically.

The sprite does **not** move to represent every Computer Use action.

The sprite represents only the conversational agent.

---

# 4. GAZE ACTIVATION MODEL

A glance is attention.

A dwell is a command.

Initial defaults:

```text
0–150 ms       glance only
150–300 ms     attention / hover
300–550 ms     dwell progress visible
>= 550 ms      commit activation
```

All thresholds must be configurable.

A valid dwell requires:

- continuous gaze inside the target;
- adequate tracker confidence;
- no gaze loss beyond the configured tolerance;
- no accumulation of separate partial glances.

If gaze exits before commit:

```text
progress = 0
```

A committed action requires a look-away/reset before the exact same target can be committed again.

---

# 5. TOP-LEVEL STATES

Implement these states explicitly.

```ts
type InteractionState =
  | "PASSIVE"
  | "SEMANTIC"
  | "SEMANTIC_PAUSED"
  | "INTENT_CONFIRMATION"
  | "EXECUTING"
  | "EXECUTION_INTERRUPTED"
  | "CONSEQUENTIAL_CONFIRMATION"
  | "ERROR_RECOVERY";
```

Do not implement the product as loosely coupled flags.

There must be one authoritative state machine.

---

# 6. MASTER STATE TABLE

| Current State | Dwell on Notch | A/B/C/D | BACK | NONE/MORE | EXIT |
|---|---|---|---|---|---|
| PASSIVE | Enter SEMANTIC | N/A | N/A | N/A | N/A |
| SEMANTIC | No destructive action | Select option | Previous semantic node | Reject current options | Return to PASSIVE |
| SEMANTIC_PAUSED | No destructive action | Disabled | Disabled | Disabled | May exit if gaze valid |
| INTENT_CONFIRMATION | No destructive action | Confirmation choice | Return to semantic editing | N/A | Cancel intent |
| EXECUTING | **Interrupt immediately** | Hidden | N/A | N/A | N/A |
| EXECUTION_INTERRUPTED | Resume/engage conversation if needed | Steering choice | Context-specific | Context-specific | Stop task |
| CONSEQUENTIAL_CONFIRMATION | No destructive action | Confirmation choice | Return/edit if applicable | N/A | Cancel pending action |
| ERROR_RECOVERY | Engage/help status | Recovery choice | Context-specific | Context-specific | Abort task |

This table is authoritative.

---

# 7. PASSIVE STATE

## 7.1 What PASSIVE means

PASSIVE is the normal computer state.

Visible:

- user's real computer/app content;
- persistent notch sprite;
- optional minimal local status indicator.

Hidden:

- semantic quadrants;
- utility shelf;
- semantic transcript;
- Computer Use controls.

Running locally:

- gaze tracker;
- fixation/dwell classifier;
- active window monitor;
- lightweight context monitor;
- optional navigation primitives such as reading auto-scroll.

Do not continuously call a large LLM merely because PASSIVE is active.

---

## 7.2 Summoning semantic conversation

From PASSIVE:

```text
user gazes at notch sprite
        ↓
continuous dwell reaches threshold
        ↓
sprite acknowledgement
        ↓
snapshot context
        ↓
enter SEMANTIC
```

The context snapshot should include, where available:

- active app;
- active window;
- window bounds;
- current URL/title;
- recent gaze fixation;
- accessibility element near fixation;
- screen semantic summary;
- current content type;
- recent conversation context;
- current navigation mode.

Semantic options should be prefetched whenever safely possible so the UI feels immediate.

---

# 8. SEMANTIC STATE

SEMANTIC is the user-facing language-decoding mode.

The goal is:

> infer the user's intended natural-language prompt with as few deliberate gaze selections as possible.

It is not a mouse replacement.

It is not a gaze keyboard except as a final fallback.

---

# 9. SEMANTIC UI LAYOUT

When SEMANTIC begins, show exactly four primary semantic options:

```text
A = upper-left
B = upper-right
C = lower-left
D = lower-right
```

Their meanings change.

Their positions never change.

Example:

```text
┌──────────────────────────────┐
│ A                         B  │
│                              │
│       underlying app         │
│       remains visible        │
│                              │
│ C                         D  │
└──────────────────────────────┘
```

The visual cards may be compact.

The gaze hit regions must be substantially larger than the visible cards.

---

# 10. THE UTILITY SHELF

When SEMANTIC is active, reserve a dedicated bottom utility strip.

The utility strip is separate from A/B/C/D.

It must not overlap the invisible gaze regions of C or D.

Use three stable zones:

```text
┌──────────────────────────────────────────┐
│                                          │
│            semantic content              │
│                                          │
├──────────────┬──────────────┬────────────┤
│   ← BACK     │ NONE / MORE  │   × EXIT   │
└──────────────┴──────────────┴────────────┘
```

Recommended geometry:

```text
utility shelf height:
    10–14% of usable screen height

horizontal allocation:
    BACK        = left 1/3
    NONE/MORE   = center 1/3
    EXIT        = right 1/3
```

The entire zone is the gaze target.

Do not require the gaze tracker to hit the text label itself.

The shelf must be visually subordinate to the four primary choices but still clearly available.

---

# 11. BACK

BACK means:

> "My previous semantic selection was wrong. Go back one semantic step."

Behavior:

1. pop the most recent accepted semantic decision;
2. restore the exact previous semantic state if cached;
3. restore its original A/B/C/D ordering;
4. restore its previous question/prompt;
5. do not regenerate different choices unless the previous state is unavailable;
6. do not treat BACK as negative evidence against the previous choices beyond undoing the choice.

BACK is hidden or disabled on the first semantic node.

BACK must never exit the conversation.

---

# 12. NONE / MORE

NONE/MORE means:

> "I still want to communicate with the agent, but none of these four options represent what I mean."

Behavior:

```text
current A/B/C/D
      ↓ rejected
record explicit negative evidence
      ↓
generate semantically different alternatives
```

Do **not** simply show candidates ranked #5–#8 if they are paraphrases of the rejected set.

The decoder should diversify semantic coverage.

Example of BAD second round:

```text
Round 1:
Search
Find
Look up
Discover

Round 2:
Browse
Locate
Seek
Research
```

Example of GOOD second round:

```text
Round 1:
Find something
Communicate
Do something
Express a need

After NONE:

Describe something
Change something
Ask a question
Something personal
```

---

# 13. AKINATOR / CLARIFICATION TRIGGER

After two consecutive NONE/MORE events without a useful narrowing selection:

```text
prediction mode
      ↓
prediction retry
      ↓
second NONE
      ↓
CLARIFICATION MODE
```

The conversational agent asks one concise spoken question.

The question must be selected to maximally reduce uncertainty over the remaining plausible intents.

Then A/B/C/D become four short answers.

Example:

```text
Agent:
"What is this mainly about?"

A: A PERSON
B: INFORMATION
C: SOMETHING TO DO
D: A PERSONAL NEED
```

The user answers only by gaze.

Speech from the user is never required.

After a clarification answer:

```text
clarification evidence
        ↓
return to predictive semantic decoding
```

Do not remain in endless question mode if predictions can now be useful.

---

# 14. DWELLING ON THE NOTCH DURING SEMANTIC MODE

This is intentionally **NOT** the exit gesture.

Reason:

- the user may naturally look at the sprite while it speaks;
- the sprite is conversationally salient;
- using it as both "talk" and "close" would create accidental termination.

Therefore:

```text
STATE = SEMANTIC
+
dwell on notch
        ↓
NO destructive state transition
```

Permitted behavior:

- sprite reacts;
- dwell progress may appear;
- current voice may continue;
- the system may acknowledge attention visually.

Do not:

- exit;
- cancel;
- restart semantic decoding;
- interrupt the current conversation;
- reorder the options.

EXIT exists for exiting.

---

# 15. EXIT

EXIT means:

> "I do not want to continue this semantic conversation."

EXIT is always available during SEMANTIC.

On EXIT:

1. immediately stop accepting A/B/C/D selections;
2. hide semantic cards;
3. hide BACK/NONE/EXIT shelf;
4. stop optional nonessential TTS associated with the abandoned turn;
5. cancel uncommitted decoder requests where practical;
6. discard the active unconfirmed semantic branch;
7. perform no Computer Use action;
8. return to PASSIVE;
9. sprite returns to IDLE.

Do not ask:

> "Are you sure you want to exit?"

EXIT itself is the deliberate gaze action.

Do not trap the user in another confirmation loop.

---

# 16. WHAT PERSISTS AFTER EXIT

EXIT discards:

- current unconfirmed intent;
- current semantic branch;
- current rejected candidate set for that transaction;
- current Akinator question state.

The broader session may retain:

- normal conversation history;
- previously completed tasks;
- user preferences;
- non-sensitive app context needed for continuity.

Do not automatically resume the abandoned partial intent on the next summon.

Next summon starts a fresh semantic transaction using current context.

---

# 17. NO AUTOMATIC SEMANTIC TIMEOUT

Do not automatically close semantic mode because:

- user takes 10 seconds;
- user reads slowly;
- user looks away;
- model is waiting;
- gaze temporarily disappears.

Users may need substantial processing time.

Timeouts are inappropriate as an implicit EXIT mechanism.

---

# 18. GAZE LOSS DURING SEMANTIC MODE

If gaze tracking confidence drops below threshold:

```text
SEMANTIC
   ↓
SEMANTIC_PAUSED
```

In SEMANTIC_PAUSED:

- freeze all dwell timers;
- freeze option ordering;
- keep current options visible;
- do not commit selections;
- do not regenerate options;
- do not exit;
- show subtle "gaze paused / reacquiring" status.

When gaze confidence returns:

```text
SEMANTIC_PAUSED
      ↓
SEMANTIC
```

Resume from the exact same semantic state.

Never interpret tracking failure as NONE, BACK, EXIT, or a quadrant selection.

---

# 19. INTENT COMPLETION

The semantic decoder should stop asking for more selections when it has enough information to formulate a concrete, executable natural-language intent.

Example:

```text
"Email Professor Lee and tell her
I'll be about ten minutes late."
```

At that point:

```text
SEMANTIC
    ↓
INTENT_CONFIRMATION
```

---

# 20. INTENT CONFIRMATION

The conversational sprite speaks the inferred intent concisely.

Example:

> "You want me to email Professor Lee and tell her you'll be about ten minutes late. Is that right?"

Show four large confirmation options.

Preferred default:

```text
A: YES / DO IT
B: CHANGE IT
C: READ / REPEAT
D: CANCEL
```

The exact wording may adapt to context, but all four meanings must remain clear.

---

# 21. INTENT CONFIRMATION BEHAVIOR

## YES / DO IT

```text
confirmed intent
    ↓
hide semantic UI
    ↓
start executor
    ↓
EXECUTING
```

## CHANGE IT

Return to semantic decoding with the current inferred intent as editable context.

Do not discard everything.

The next four options should focus on likely correction dimensions.

Example:

```text
CHANGE RECIPIENT
CHANGE MESSAGE
ADD SOMETHING
SOMETHING ELSE
```

## READ / REPEAT

Speak the proposed intent again.

Stay in INTENT_CONFIRMATION.

## CANCEL

Equivalent to abandoning the transaction:

```text
cancel
 ↓
PASSIVE
```

No executor starts.

---

# 22. EXECUTING STATE

When the user confirms a task:

- semantic quadrants disappear;
- utility shelf disappears;
- existing app content becomes visually primary again;
- sprite remains in notch;
- sprite shows working animation;
- Computer Use agent executes.

The executor is visually invisible except for:

- normal application actions on screen;
- concise sprite status where useful.

Do not show internal reasoning.

Do not show a verbose transcript.

---

# 23. NOTCH DWELL DURING COMPUTER USE

This is the universal interrupt / steering action.

```text
STATE = EXECUTING
+
user dwells on notch
        ↓
highest-priority interrupt
```

Behavior:

1. stop issuing new executor actions as quickly and safely as possible;
2. preserve task state;
3. preserve completed actions;
4. preserve current screen context;
5. acknowledge interruption immediately;
6. enter `EXECUTION_INTERRUPTED`;
7. open a semantic steering interaction.

Core product promise:

> The user can always regain control by looking at the notch and holding.

---

# 24. EXECUTION INTERRUPTION UI

When interrupted, the conversational agent should infer likely steering needs from:

- original intent;
- current task plan;
- completed steps;
- current screen;
- most recent Computer Use action;
- current gaze target;
- any visible draft/result.

Then show four likely steering options.

Example while drafting an email:

```text
A: CHANGE THE MESSAGE
B: CHANGE THE PERSON
C: CONTINUE
D: STOP THE TASK
```

If no useful four-way set can be inferred:

```text
A: CHANGE SOMETHING
B: GO BACK
C: CONTINUE
D: STOP
```

NONE/MORE and clarification behavior remain available if required.

---

# 25. STOPPING AN EXECUTING TASK

While in EXECUTION_INTERRUPTED, the user must have a clear STOP / EXIT path.

Stopping the task:

1. cancels future executor actions;
2. preserves already completed external actions as historical facts;
3. does not pretend irreversible actions were undone;
4. hides steering UI;
5. returns to PASSIVE.

If the task has an unsent draft or reversible local intermediate state, it may remain as-is unless explicitly safe to clean up.

---

# 26. CONSEQUENTIAL ACTIONS

Actions such as:

- sending email/messages;
- publishing a post;
- deleting data;
- submitting forms;
- making purchases;
- financial transactions;
- account/security changes;
- other external or irreversible actions,

require final confirmation.

The executor may prepare the action.

It must stop before committing it.

Transition:

```text
EXECUTING
   ↓
CONSEQUENTIAL_CONFIRMATION
```

---

# 27. CONSEQUENTIAL CONFIRMATION UI

Example email:

```text
A: SEND
B: EDIT
C: READ TO ME
D: CANCEL
```

Example purchase:

```text
A: PLACE ORDER
B: CHANGE ORDER
C: REVIEW DETAILS
D: CANCEL
```

Use the semantic positions A/B/C/D.

Do not put "SEND" on a small native app button and expect webcam gaze accuracy to hit it.

The overlay remains the user's high-confidence control surface.

---

# 28. CONSEQUENCE CANCEL

CANCEL at the consequential stage means:

- do not perform the pending irreversible action;
- stop the current task unless the user explicitly chooses an edit/review path;
- return safely to PASSIVE or semantic editing depending on the displayed choice semantics.

Never infer "cancel confirmation" as "continue without confirmation."

---

# 29. NOTCH DWELL DURING CONFIRMATION

During:

- INTENT_CONFIRMATION;
- CONSEQUENTIAL_CONFIRMATION;

dwelling on the notch must not accidentally confirm or cancel.

The user answers through the explicit large confirmation choices.

The notch may react visually only.

---

# 30. READING / PASSIVE NAVIGATION

Routine navigation should not consume semantic bandwidth.

Examples:

- article auto-scroll;
- next/previous in a vertical feed;
- pause/resume media;
- reading continuation.

These are lower-level accessibility/navigation primitives.

They operate outside semantic mode when safely inferred or explicitly enabled.

The user should not need:

```text
SUMMON
→ "scroll"
SUMMON
→ "scroll"
SUMMON
→ "scroll"
```

Semantic mode is for intent, not repetitive low-level navigation.

---

# 31. AUTO-SCROLL AND NOTCH SAFETY

If article reading auto-scroll is enabled:

- reserve a dead region around the notch;
- gaze toward the sprite must never be interpreted as scrolling;
- dwell progress on the sprite has higher priority than navigation inference.

Event priority:

```text
NOTCH SUMMON / INTERRUPT
        >
CONFIRMATIONS
        >
SEMANTIC SELECTION
        >
BACK / NONE / EXIT
        >
NAVIGATION
        >
PASSIVE CONTEXT
```

---

# 32. IPHONE MIRRORING

iPhone Mirroring is treated as another visible computer surface.

For narrow mirrored-phone windows:

- do not put four tiny gaze controls inside the phone;
- use the `WINDOW_HALO` semantic layout;
- keep hit regions large outside the window;
- preserve A/B/C/D spatial identity.

Example:

```text
        A                   B
         ╲                 ╱
          ╲   ┌────────┐  ╱
              │ iPhone │
              │ TikTok │
              └────────┘
          ╱                 ╲
         ╱                   ╲
        C                     D
```

The notch sprite remains at the top of the Mac display.

It does not move onto the phone.

---

# 33. SEMANTIC DECODER CONTRACT

The semantic decoder returns exactly four primary options when in prediction/clarification mode.

It must optimize for:

1. probability;
2. semantic diversity;
3. context relevance;
4. short readable language;
5. low ambiguity;
6. minimal number of future selections.

It must not merely return four paraphrases.

---

# 34. DECODER STATE

Maintain:

```ts
interface SemanticSession {
  sessionId: string;
  startedAt: number;

  contextSnapshot: ContextSnapshot;

  acceptedChoices: SemanticDecision[];
  rejectedOptionSets: RejectedSet[];
  clarificationAnswers: ClarificationAnswer[];

  consecutiveNoneCount: number;

  currentNode: SemanticNode;
  historyStack: SemanticNode[];

  candidateIntents: IntentHypothesis[];

  mode:
    | "predict"
    | "clarify"
    | "confirm"
    | "edit";
}
```

---

# 35. BACK IMPLEMENTATION

BACK requires a real history stack.

Do not simulate BACK by asking the LLM to "guess what the prior state was."

When a new semantic node is committed:

```ts
historyStack.push(currentNode)
currentNode = nextNode
```

On BACK:

```ts
currentNode = historyStack.pop()
```

Restore cached option text/order when possible.

---

# 36. NONE IMPLEMENTATION

On NONE:

```ts
rejectedOptionSets.push({
  options: currentNode.options,
  timestamp: Date.now()
})

consecutiveNoneCount += 1
```

If:

```ts
consecutiveNoneCount < 2
```

generate diverse alternatives.

If:

```ts
consecutiveNoneCount >= 2
```

generate clarification question.

After a useful A/B/C/D selection:

```ts
consecutiveNoneCount = 0
```

---

# 37. SPECULATIVE PREFETCH

While the user is deciding among A/B/C/D:

precompute candidate next states for:

```text
if A selected
if B selected
if C selected
if D selected
```

Optionally also precompute:

- likely spoken question;
- TTS audio;
- likely NONE alternative set;
- likely clarification question.

No speculative result may cause an external side effect.

Allowed speculation:

- LLM generation;
- UI preparation;
- semantic context;
- TTS generation;
- read-only screen analysis.

Forbidden speculation:

- sending;
- clicking external UI;
- typing into real applications;
- deleting;
- purchasing;
- committing state.

---

# 38. VOICE

Voice is agent → user.

The user never needs speech.

Speak:

- Akinator questions;
- inferred intent;
- consequential confirmations;
- important errors;
- requested read-aloud content;
- short completion status.

Do not speak every quadrant automatically by default.

Optional gaze hover audio preview may be enabled.

---

# 39. NOTCH SPRITE DURING VOICE

When voice is playing:

- animate speaking;
- keep sprite at notch;
- do not change the meaning of notch dwell;
- do not exit semantic mode if user looks at the speaker.

This is one of the main reasons EXIT is separate.

---

# 40. UI FREEZE RULE

Once options appear:

```text
text is frozen
order is frozen
geometry is frozen
hit regions are frozen
```

until:

- user selects;
- user chooses BACK;
- user chooses NONE;
- user chooses EXIT;
- gaze tracking pauses.

Never stream new words into a card the user is currently evaluating.

---

# 41. ERROR RECOVERY

Errors must never strand a gaze-only user.

If the system loses control or encounters an unrecoverable executor problem:

show four large recovery choices.

Example:

```text
A: TRY AGAIN
B: GO BACK
C: CHOOSE SOMETHING ELSE
D: STOP
```

The notch remains visible.

EXIT/STOP remains reachable.

---

# 42. DEVELOPER / CAREGIVER CONTROLS

Provide conventional controls for development and assistance:

- enable/disable Assistive Session;
- recalibrate;
- pause gaze;
- adjust dwell time;
- adjust gaze smoothing;
- enable reduced motion;
- mute/unmute voice;
- disable sprite;
- force semantic state;
- simulate A/B/C/D;
- simulate NONE/BACK/EXIT;
- simulate notch dwell;
- simulate gaze loss.

These controls must not be necessary for normal gaze-only operation.

---

# 43. EXACT DEMO FLOWS TO TEST

## 43.1 Article flow

```text
PASSIVE
↓
user reads article
↓
optional auto-scroll
↓
dwell notch
↓
SEMANTIC
↓
A/B/C/D:
  summarize / explain / related / other
↓
user selects
↓
if enough context: result
if not: next semantic node
↓
user can BACK / NONE / EXIT at any time
↓
EXIT or completion
↓
PASSIVE
```

Acceptance:
- no mouse/keyboard after calibration;
- no accidental exit by looking at sprite;
- explicit EXIT works in one dwell.

---

## 43.2 Email flow

```text
PASSIVE
↓
dwell notch
↓
SEMANTIC
↓
semantic decoding
↓
possible Akinator clarification
↓
complete intent:
"Email Professor Lee that I'll be 10 minutes late."
↓
INTENT_CONFIRMATION
↓
YES
↓
EXECUTING
↓
draft prepared
↓
CONSEQUENTIAL_CONFIRMATION
↓
SEND
↓
SUCCESS
↓
PASSIVE
```

Acceptance:
- message cannot send without final gaze confirmation;
- notch dwell while EXECUTING interrupts;
- notch dwell while confirmation is open does not accidentally send.

---

## 43.3 Computer Use interrupt flow

Start any executor task.

While it runs:

```text
user dwells on notch
↓
executor pauses/stops future actions
↓
EXECUTION_INTERRUPTED
↓
four steering choices
```

Acceptance:
- interrupt is visibly acknowledged quickly;
- prior task context is retained;
- user can change course;
- user can STOP;
- user can CONTINUE.

---

## 43.4 Semantic failure flow

Force intended phrase outside initial predictions.

```text
initial four
↓
NONE
↓
diverse second four
↓
NONE
↓
agent asks optimal clarification
↓
four answers
↓
user selects
↓
predictions improve
```

Acceptance:
- second set is semantically diverse;
- two NONE actions trigger clarification;
- user never needs keyboard input.

---

## 43.5 Exit flow

From any semantic prediction node:

```text
dwell EXIT
↓
all semantic UI disappears
↓
no task executes
↓
PASSIVE
```

Acceptance:
- one explicit exit dwell;
- no extra "are you sure?";
- abandoned partial prompt does not resurrect automatically next summon.

---

## 43.6 Gaze-loss flow

While in SEMANTIC:

```text
simulate low gaze confidence
↓
SEMANTIC_PAUSED
↓
no choice can commit
↓
same choices remain
↓
restore gaze
↓
resume same state
```

Acceptance:
- no auto-exit;
- no accidental selection;
- no regenerated ordering.

---

# 44. EVENT PRIORITY

Implement event arbitration with this priority:

```text
1. notch interrupt during EXECUTING
2. consequential confirmation selection
3. intent confirmation selection
4. explicit EXIT / STOP
5. BACK
6. NONE / MORE
7. A/B/C/D semantic selection
8. notch summon from PASSIVE
9. routine navigation / auto-scroll
10. passive gaze context
11. decorative sprite reactions
```

If two events appear to occur simultaneously, the higher-priority event wins.

---

# 45. LATENCY TARGETS

Optimize for perceived latency.

The user naturally spends time dwelling/deciding.

Use that time for speculative preparation.

Target subjective behavior:

```text
selection commit
    ↓
next UI appears immediately
    ↓
voice starts as soon as available
```

Do not block showing prepared visual choices on completion of TTS.

UI can lead voice.

---

# 46. NO-AMBIGUITY RULES

The implementation agent must not reinterpret the following:

### Rule 1
The notch sprite is the universal summon point from PASSIVE.

### Rule 2
The notch sprite is the universal interrupt point during EXECUTING.

### Rule 3
The notch is **not** the semantic-mode exit control.

### Rule 4
EXIT is explicit and separate.

### Rule 5
BACK undoes one semantic decision.

### Rule 6
NONE means "keep talking, but these guesses are wrong."

### Rule 7
EXIT means "stop talking and return to my computer."

### Rule 8
Gaze loss pauses; it never exits.

### Rule 9
Semantic mode has no automatic inactivity timeout.

### Rule 10
Consequential external actions require explicit confirmation.

### Rule 11
A/B/C/D positions never move.

### Rule 12
Text/order/hitboxes freeze once displayed.

### Rule 13
User speech is optional and never required.

### Rule 14
The executor does not visually become the mascot.

### Rule 15
The user can always regain control during Computer Use by dwelling on the notch.

---

# 47. IMPLEMENTATION REFERENCE NOTES

The macOS overlay behavior is compatible with AppKit's current primitives.

Relevant Apple concepts:

- `NSPanel`
- `.nonactivatingPanel`
- floating panels
- `NSWindow.CollectionBehavior.fullScreenAuxiliary`
- `NSWindow.CollectionBehavior.canJoinAllApplications`
- accessory app activation policy

Apple documentation:
- https://developer.apple.com/documentation/appkit/nspanel
- https://developer.apple.com/documentation/appkit/nswindow/stylemask-swift.struct/nonactivatingpanel
- https://developer.apple.com/documentation/appkit/nswindow/collectionbehavior-swift.struct/fullscreenauxiliary
- https://developer.apple.com/documentation/appkit/nswindow/collectionbehavior-swift.struct/canjoinallapplications

Apple's own Dwell accessibility system is useful behavioral precedent for:
- explicit dwell countdown;
- pause rather than accidental activation;
- stable accessibility controls.

Reference:
- https://support.apple.com/guide/mac-help/control-the-pointer-using-dwell-mchl437b47b0/mac

Do not copy Apple's UI.
Use the behavior as accessibility precedent.

---

# 48. FINAL ACCEPTANCE CHECKLIST

The build is not ready until all of the following are true.

## Summon
- [ ] quick glance at sprite does nothing destructive
- [ ] continuous notch dwell summons semantic mode
- [ ] dwell progress resets on gaze exit
- [ ] summon works without mouse/keyboard

## Semantic mode
- [ ] exactly four primary semantic options
- [ ] A always upper-left
- [ ] B always upper-right
- [ ] C always lower-left
- [ ] D always lower-right
- [ ] options freeze while displayed
- [ ] utility shelf does not overlap C/D hit regions

## BACK
- [ ] hidden/disabled on root
- [ ] restores exact previous node
- [ ] does not exit

## NONE
- [ ] rejects current set
- [ ] generates semantically diverse alternatives
- [ ] two consecutive NONE actions trigger clarification
- [ ] still does not exit

## EXIT
- [ ] explicit gaze-accessible EXIT is always present in semantic mode
- [ ] one committed dwell exits
- [ ] no confirmation required
- [ ] no executor starts
- [ ] partial intent is discarded
- [ ] returns to PASSIVE

## Notch in semantic mode
- [ ] looking at sprite cannot accidentally close semantic UI
- [ ] speaking animation does not alter state
- [ ] notch dwell is non-destructive

## Gaze loss
- [ ] pauses dwell
- [ ] preserves state
- [ ] preserves order
- [ ] resumes correctly
- [ ] never triggers EXIT

## Execution
- [ ] semantic overlay hides after confirmed task
- [ ] sprite remains in notch
- [ ] sprite visibly indicates working state
- [ ] executor can control target computer surface

## Interrupt
- [ ] notch dwell during execution interrupts
- [ ] no new CU actions continue after interrupt boundary
- [ ] task state is preserved
- [ ] steering UI appears
- [ ] STOP is available
- [ ] CONTINUE is available

## Consequential action
- [ ] final action cannot happen without gaze confirmation
- [ ] confirmation is presented using large gaze targets
- [ ] CANCEL prevents the pending action

## iPhone Mirroring
- [ ] narrow window uses halo layout
- [ ] no four tiny buttons inside phone
- [ ] sprite stays at notch
- [ ] CU can act on mirrored window

## Overall
- [ ] all three demo workflows are gaze-only after calibration
- [ ] user always has an obvious escape
- [ ] user always has an obvious interrupt
- [ ] no semantic dead end forces keyboard input
- [ ] no state depends on user speech

---

# 49. FINAL PRODUCT INVARIANT

The implementation should always preserve this:

```text
THE NOTCH = GET THE AGENT'S ATTENTION

THE QUADRANTS = EXPRESS MEANING

BACK = I CHOSE WRONG

NONE = YOU GUESSED WRONG

EXIT = END THIS CONVERSATION

NOTCH DURING EXECUTION = STOP AND LISTEN TO ME
```

If an implementation detail breaks this model, change the implementation detail.

Do not change the model.

---

# 50. FINAL COMMAND TO THE CODING AGENT

Proceed to implementation.

Do not replace this interaction model with:

- a gaze-controlled cursor;
- a chatbot;
- a fixed app launcher;
- a standard four-button menu;
- a keyboard-first AAC interface;
- a generic accessibility overlay.

The product is a **gaze-to-semantic-intent interface for autonomous computer agents**.

Use existing, tested open-source components and platform APIs wherever available.

Prioritize:
1. reliable gaze interaction,
2. deterministic state transitions,
3. user escape/control,
4. semantic compression,
5. low perceived latency,
6. end-to-end task completion,
7. demo polish.

Test every acceptance flow above before declaring the build complete.
