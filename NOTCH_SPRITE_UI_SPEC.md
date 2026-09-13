# Notch Conversational Agent — Sprite & Overlay UI Specification

## 0. Purpose

This document defines the complete UI/behavior contract for the persistent conversational-agent sprite used by the gaze-to-agent accessibility system.

This specification is intentionally opinionated and deterministic. The implementation agent should follow it directly rather than inventing alternate interaction patterns.

> **Current implementation scope (2026-09-12):** Apple iPhone Mirroring integration is deferred and is not part of the current build. The implemented window-halo layout remains generic for any narrow active macOS window.

The central rule is:

> **The conversational agent lives in the MacBook notch.**
>
> It remains there during normal use, gaze decoding, voice conversation, and computer-use execution.
>
> It leaves the notch only in rare cases where its physical position on the screen communicates essential meaning that cannot be communicated as clearly with a highlight, label, or overlay.

The sprite represents only the **conversational agent**. It does not visually represent the semantic decoder, gaze tracker, computer-use executor, browser-use executor, or other internal models. Those components are implementation details.

From the user's perspective, there is one conversational companion living in the notch.

---

# 1. Core Product Model

The user should experience the system as:

```text
NORMAL COMPUTER
      +
small conversational companion in notch
      +
gaze is continuously available as an input channel
```

The computer should not feel like it has been replaced by an accessibility application.

The user continues to see and use:

- Safari / Chrome
- Mail / Gmail
- Finder
- Spotify
- YouTube
- documents
- arbitrary desktop applications
- iPhone Mirroring
- arbitrary phone apps shown through iPhone Mirroring

The agent is an overlay/accessibility layer above the user's existing digital environment.

The visual hierarchy is:

```text
NOTCH SPRITE
    = conversational agent / summon point / status

CURRENT SCREEN
    = the user's real digital environment

GAZE
    = natural attention + intentional selections

DYNAMIC QUADRANTS
    = transient semantic-response surface

COMPUTER-USE AGENT
    = invisible executor
```

---

# 2. Non-Negotiable Rules

## 2.1 Sprite persistence

The sprite remains visible at the notch at all times while Assistive Session is enabled.

It does **not** disappear because:

- the user changes applications
- the user enters semantic decoding
- the computer-use agent starts working
- voice is speaking
- an iPhone Mirroring window becomes active
- the user enters a browser
- a full-screen application appears

The sprite disappears only when:

1. the user explicitly disables the sprite in developer/settings controls;
2. Assistive Session is fully disabled;
3. the process exits;
4. a developer/debug override intentionally hides it.

Do not hide the sprite automatically for videos, games, full-screen apps, inactivity, or "immersive mode" in v1.

---

## 2.2 Sprite identity

The sprite represents **only the conversational agent**.

It does not "become" the computer-use agent.

When Computer Use is running, the sprite remains in the notch and simply communicates conversational state such as:

- working
- waiting
- needs confirmation
- completed
- interrupted

Do not animate the sprite traveling around the screen to represent the executor clicking things.

---

## 2.3 Notch is home

The notch is the sprite's canonical home.

The user must always know:

> "If I want the agent, I look up there."

The sprite's activation location must never move according to application context.

---

## 2.4 Gaze semantics

A quick glance at the sprite means **attention**.

A deliberate dwell means **command**.

The user must never accidentally summon the agent simply by looking toward the top of the screen.

Recommended initial thresholds:

```text
0–150 ms:
    no command
    optional subtle sprite eye-contact reaction

150–300 ms:
    hover/attention state
    no selection

300–550 ms:
    visible dwell progress begins

>= 550 ms:
    commit SUMMON / INTERRUPT
```

All dwell timings must be configurable.

The threshold should be tested with the actual gaze tracker and adjusted based on noise.

---

# 3. macOS Overlay Architecture

## 3.1 Use a native overlay host

Implement the sprite/overlay host using AppKit, even if the main product shell is Electron/TypeScript.

Preferred architecture:

```text
Electron / TypeScript application
        |
        | IPC
        v
Native macOS overlay helper
(AppKit / Swift)
        |
        +-- notch sprite NSPanel
        +-- semantic card overlays
        +-- highlight overlays
        +-- dwell-progress overlays
```

If Electron can satisfy all requirements without sacrificing full-screen persistence or click-through behavior, it may host the visual content, but the implementation should still use native macOS window primitives for placement/layering.

---

## 3.2 Notch-safe placement

Do not draw "inside" the physical camera cutout.

Use:

- `NSScreen.safeAreaInsets`
- `NSScreen.auxiliaryTopLeftArea`
- `NSScreen.auxiliaryTopRightArea`
- `NSScreen.visibleFrame`

to determine the real screen geometry and camera-housing obstruction.

The sprite should visually appear to live at the notch by rendering:

- immediately beneath the camera housing; or
- partly peeking from immediately below it; or
- in the menu-bar region adjacent to the housing when visually appropriate.

No hard-coded pixel assumption about notch dimensions is allowed.

The system must work on:

- notched MacBook displays
- non-notched external displays
- non-notched MacBooks

Fallback for screens without a notch:

```text
top center of the active display
```

The same spatial mental model must be preserved.

---

## 3.3 Always-on-top behavior

The persistent sprite overlay must use a non-activating floating AppKit panel.

Required behavior:

- does not steal keyboard focus
- does not activate the app when merely visible
- remains above normal app windows
- can remain present across Spaces
- can remain visible above full-screen applications
- can be click-through except when developer/settings controls require pointer interaction
- supports transparent background

Implementation target:

```swift
NSApplication activation policy:
    .accessory

Sprite host:
    NSPanel with .nonactivatingPanel

Panel properties:
    isFloatingPanel = true
    hidesOnDeactivate = false
    collectionBehavior includes:
        .canJoinAllSpaces
        .canJoinAllApplications
        .fullScreenAuxiliary
        .stationary

For full-screen persistence:
    use an appropriate high window level
    (tested against current macOS)
```

Do not rely on repeatedly calling `orderFrontRegardless()` as the primary mechanism.

---

# 4. Sprite Visual States

The sprite must have a finite, explicit state machine.

Required states:

```text
IDLE
ATTENTION
DWELLING
SUMMONED
LISTENING_FOR_GAZE
THINKING
SPEAKING
COMPUTER_USE_RUNNING
NEEDS_CONFIRMATION
SUCCESS
INTERRUPTED
ERROR
PAUSED
```

Every state must have a visibly distinct but restrained animation.

---

## 4.1 IDLE

Purpose:
- communicate presence without distracting from the user's content.

Animation:
- occasional blink
- very subtle breathing/idle motion
- no bouncing
- no random travel
- no continuous glowing

The sprite should feel alive, not needy.

---

## 4.2 ATTENTION

Triggered when gaze rests on the sprite briefly but has not crossed the activation threshold.

Animation:
- sprite notices the user
- eyes orient toward viewer
- slight wake-up motion
- no semantic UI appears

This state should reinforce:

> glance != command

---

## 4.3 DWELLING

Triggered when gaze remains on the sprite long enough that activation is increasingly likely.

Required UI:
- circular or arc-shaped dwell-progress visualization around/under sprite.

Example:

```text
25%   ◔
50%   ◑
75%   ◕
100%  ●
```

The progress ring must:
- be smooth
- reset immediately if gaze exits the activation region
- never complete from accumulated intermittent glances
- use one continuous dwell

---

## 4.4 SUMMONED

Triggered when the dwell threshold completes while the system is idle.

Behavior:

1. give a short acknowledgement animation;
2. freeze the current contextual snapshot;
3. invoke semantic decoder / fetch prefetched semantic state;
4. display four semantic options;
5. transition to `LISTENING_FOR_GAZE`.

The acknowledgement animation must be short enough not to delay UI.

Target:
- <= 150 ms visual acknowledgement
- quadrant UI appears as soon as data is available
- use prefetched UI state when possible

---

## 4.5 LISTENING_FOR_GAZE

The sprite remains at the notch.

It should visually observe the user's selection process.

When gaze hovers a quadrant:
- sprite may subtly glance in that quadrant's direction
- do not physically travel
- do not cause screen motion

When a quadrant commits:
- short confirmation reaction
- next semantic state transitions in immediately

---

## 4.6 THINKING

Use only when real latency is exposed and the next UI is not already prefetched.

Animation:
- compact, clear thinking loop
- no fake "typing..." unless actual model work is happening

The system should aggressively precompute so this state is uncommon.

---

## 4.7 SPEAKING

When ElevenLabs / TTS is playing:

- sprite mouth/face/speaking animation
- optional tiny waveform directly under the notch
- waveform must not cover app content substantially

The user should immediately understand:
> the voice is coming from this conversational agent.

---

## 4.8 COMPUTER_USE_RUNNING

The sprite stays in the notch.

Required:
- clear "working" animation
- restrained motion
- no traveling around the screen

Examples:
- small activity orbit
- subtle "working" eyes
- tiny progress shimmer
- short action labels when useful:
  - "Opening Mail…"
  - "Finding Professor Lee…"
  - "Drafting…"

Do not expose internal chain-of-thought or hidden reasoning.

Only expose user-relevant status.

---

## 4.9 NEEDS_CONFIRMATION

When the executor reaches a consequential action:

- sprite visibly requests attention
- pulse, small bounce, or alert expression
- do not use startling animation
- optionally speak a concise question

Example:

```text
"Your email is ready. Send it?"
```

Then show confirmation quadrants.

---

## 4.10 SUCCESS

Short acknowledgement:
- check
- smile / celebratory micro-animation
- <= 800 ms

Then return to IDLE.

Do not run long celebration animations.

---

## 4.11 INTERRUPTED

Triggered when user dwells on the notch while Computer Use is running.

This is a universal human-takeover / steering command.

Behavior must be immediate:

1. stop/pause additional executor actions as safely as possible;
2. visually acknowledge interruption;
3. stop/duck current non-essential voice;
4. open conversational steering mode;
5. present context-aware choices or clarification UI.

Core promise:

> The user can always regain control by staring at the notch.

This interaction must work during:
- browser use
- desktop use
- iPhone Mirroring use
- long agent tasks
- TTS playback

---

## 4.12 ERROR

For demo reliability, errors should be rare.

When an unrecoverable error occurs:
- sprite remains at notch
- clearly signals error
- says a concise explanation
- offers recovery choices

Example:

```text
"I lost control of the window. What should I do?"

RETRY       CHOOSE WINDOW
GO BACK     CANCEL
```

Do not move the sprite to the error location in v1.

---

# 5. When May the Sprite Leave the Notch?

The default answer is:

> **Almost never.**

For v1, the sprite is allowed to leave the notch only for the following cases.

## 5.1 Onboarding / tutorial

This is the primary approved use.

During first-run onboarding, the sprite can temporarily move into the screen to teach:

- where A/B/C/D are
- what dwell means
- how to summon
- how to interrupt
- how to reject choices
- how confirmation works

Example:

```text
sprite leaves notch
      ↓
points at top-left
      ↓
"This is option A."
      ↓
returns to notch
```

After onboarding:
- this behavior is disabled
- do not repeat unless user explicitly reopens tutorial

---

## 5.2 Explicit spatial clarification

Only if the conversational agent cannot resolve which visible item the user means and a location-based clarification is genuinely necessary.

Example:

Two products are visible.
User's recent gaze is ambiguous.

The agent may ask:

```text
"Do you mean this one?"
```

Preferred v1 visualization:
- **do not move the sprite**
- outline/highlight the suspected object
- sprite remains in notch

Only if testing shows the highlight is insufficient may a temporary sprite projection appear beside the object.

Therefore, for v1:

```text
REFERENCE CONFIRMATION
    = highlight/outline
    != moving sprite
```

This supersedes earlier concepts of routinely moving the sprite to the referenced object.

---

## 5.3 Developer/debug mode

A developer-only mode may allow:
- dragging sprite
- previewing animations
- testing on-screen sprite locomotion
- forcing states

This must never be enabled by default for users.

---

# 6. Semantic Quadrant UI

## 6.1 Spatial invariants

A/B/C/D never change spatial meaning.

```text
A = upper-left
B = upper-right
C = lower-left
D = lower-right
```

This applies across:
- browser
- desktop
- Mail
- documents
- iPhone Mirroring
- vertical video feeds
- confirmation screens
- clarification questions

Meanings can change.
Spatial positions cannot.

---

## 6.2 Sprite behavior during quadrant mode

Sprite stays in notch.

It may:
- look toward a currently hovered quadrant
- react to committed selection
- speak clarification questions
- show subtle status

It may not:
- fly to quadrant cards
- reorder choices
- move target geometry after choices are shown

Once a set of choices appears, freeze:
- text
- location
- order
- hit regions

until selection/rejection/cancel.

---

## 6.3 Large-surface layout

For large/maximized windows:

```text
┌──────────────────────────────┐
│ A                         B  │
│                              │
│          APP CONTENT         │
│                              │
│ C                         D  │
└──────────────────────────────┘
```

The cards may be visually compact.

The invisible gaze hit areas should be much larger than the cards.

---

## 6.4 Small-window / iPhone Mirroring layout

For a narrow or small active surface:

```text
        A             B
          ╲         ╱
        ┌─────────────┐
        │ active app  │
        │ / iPhone    │
        └─────────────┘
          ╱         ╲
        C             D
```

The visible cards should hug the active surface.

The gaze hit regions may extend much farther into the surrounding desktop so they remain easy to select.

Never shrink all four choices inside a narrow phone-sized window.

---

# 7. NONE / BACK / CANCEL

The four semantic positions should remain available for real semantic choices whenever possible.

Use a separate transient control for:

- NONE OF THESE
- BACK
- CANCEL

Recommended placement:
- bottom center, clearly separated from routine reading-scroll trigger zones

Important:
- this control is only visible during semantic mode
- it is not the persistent agent summon point
- the notch sprite is the summon point

The bottom-center region must have a dead zone around it for any auto-scroll detector.

---

# 8. Contextual Reference Highlighting

When the user invokes the agent, capture:

- recent gaze fixation
- active window
- app identity
- visible screen content
- accessibility element under/near fixation when available

If the system believes a visible element is the referent for "this", it may show a temporary highlight.

Example:

```text
user looked at paragraph
        ↓
summons agent
        ↓
paragraph receives subtle outline
        ↓
quadrants:
SUMMARIZE THIS / EXPLAIN THIS / ...
```

The highlight should:
- fade in quickly
- remain non-interactive
- never block text
- disappear when semantic context moves on

This gives the user confidence:
> the agent understood what "this" refers to

without moving the sprite away from its home.

---

# 9. Computer-Use Interaction

## 9.1 During execution

Sprite:
- remains in notch
- shows `COMPUTER_USE_RUNNING`

Quadrants:
- hidden unless a decision is required

Executor status:
- optionally summarized in very short human-readable labels

Do not clutter screen with a running transcript.

---

## 9.2 Universal interrupt

During Computer Use:

```text
user stares at notch sprite
        ↓
dwell completes
        ↓
INTERRUPT
```

This is higher priority than any ongoing executor action except an already-committed irreversible action that cannot be stopped.

When interruption happens:

```text
"Okay — what would you like to change?"
```

The semantic decoder receives:
- original intent
- current executor state
- completed actions
- current screen
- recent gaze context

Then present four likely steering intents.

Examples:

```text
CHANGE THE MESSAGE
CHOOSE SOMEONE ELSE
STOP THIS TASK
SOMETHING ELSE
```

---

# 10. Voice Behavior

Voice is primarily agent -> user.

Do not require the disabled user to speak.

The sprite should speak:
- Akinator/clarification questions
- inferred-intent confirmations
- consequential-action confirmations
- important errors
- optional read-aloud requests
- final completion message

The sprite should not narrate:
- every scroll
- every click
- every intermediate executor observation
- every model thought

Keep voice concise.

---

# 11. Expressiveness Level

The sprite should be expressive enough to make the hackathon demo memorable while still functioning as an accessibility control.

Required animation set:

```text
idle blink
attention / looks back
dwell progress
summoned / wake-up
looking toward A/B/C/D
thinking
speaking
working
needs attention
success
error
interrupt acknowledgement
paused
```

Optional polish:
- tiny head tilt
- subtle eye tracking
- breathing
- short celebration

Forbidden:
- continuous random movement
- decorative wandering
- long dances
- animations that obscure content
- moving during reading for no functional reason

The guiding principle:

> Every significant animation should communicate state.

---

# 12. First-Run Onboarding

Onboarding is the one place where the sprite is allowed to physically leave the notch by design.

Suggested flow:

### Step 1 — Meet agent

Sprite appears in notch.

Voice:
> "I'm your agent. Look at me and hold your gaze to get my attention."

User practices dwell.

### Step 2 — Teach four choices

Sprite temporarily moves toward each region:

```text
A top-left
B top-right
C bottom-left
D bottom-right
```

Voice:
> "I will usually give you four choices. Their meanings change, but their positions never do."

Then sprite returns to notch.

### Step 3 — Practice selection

Show four harmless demo choices.

### Step 4 — Teach NONE/BACK

Show bottom-center control.

### Step 5 — Teach interrupt

Fake a "working" state.

Voice:
> "If I'm doing something and you want me to stop or change course, look at me again."

User dwells on notch.
System interrupts.

### Step 6 — Complete

Sprite returns to permanent notch home.

Do not repeat onboarding automatically.

---

# 13. Accessibility and Safety

## 13.1 Visual clarity

- large type
- high contrast
- no reliance on color alone
- readable in light/dark backgrounds
- semantic cards have strong edge separation
- use system accessibility contrast settings when possible

## 13.2 Motion sensitivity

Add developer/user setting:

```text
Reduced Animation
```

When enabled:
- no sprite travel during onboarding
- fade/scale transitions only
- no bouncing
- simplified speaking/working states

## 13.3 Dwell configuration

Expose:
- summon dwell
- quadrant dwell
- hover threshold
- audio preview threshold
- look-away reset requirement
- gaze smoothing strength

## 13.4 Accidental activation protection

Require:
- continuous dwell
- stable gaze confidence
- look-away reset before repeated activation
- no accumulated fragmented dwell

---

# 14. Multi-Display Behavior

Canonical behavior:

- sprite lives on the display containing the currently active interaction surface;
- if the user moves focus to another display, migrate the sprite only after stable focus/context changes;
- on a notched built-in display, prefer notch home;
- on an external display, use top-center fallback.

Migration should be rare and animated subtly.

For the hackathon demo:
- optimize and test primarily for a single MacBook display.

---

# 15. Implementation Interfaces

Define the following interfaces.

```ts
type SpriteState =
  | "idle"
  | "attention"
  | "dwelling"
  | "summoned"
  | "listening_for_gaze"
  | "thinking"
  | "speaking"
  | "computer_use_running"
  | "needs_confirmation"
  | "success"
  | "interrupted"
  | "error"
  | "paused";

interface SpriteController {
  setState(state: SpriteState, metadata?: Record<string, unknown>): void;
  setDwellProgress(progress01: number): void;
  lookToward(target: "A" | "B" | "C" | "D" | "CENTER" | "USER"): void;
  speakState(active: boolean): void;
  showStatus(text?: string): void;
  reset(): void;
}

interface OverlayController {
  showQuadrants(options: SemanticOption[], layout: OverlayLayout): void;
  hideQuadrants(): void;
  showNoneBack(mode: "none" | "back" | "cancel"): void;
  hideNoneBack(): void;
  highlightRect(rect: ScreenRect, style?: HighlightStyle): void;
  clearHighlight(): void;
  showDwellProgress(targetId: string, progress01: number): void;
  clearDwellProgress(): void;
}

type OverlayLayout =
  | { kind: "screen_corners"; screenId: string }
  | { kind: "window_halo"; windowBounds: ScreenRect };

interface SemanticOption {
  id: "A" | "B" | "C" | "D";
  label: string;
  semanticMeaning: string;
}
```

The semantic decoder must never directly position windows.
It returns meanings.
The overlay/layout engine decides geometry.

---

# 16. Event Priority

Highest to lowest priority:

```text
1. user interrupt dwell on notch
2. consequential-action confirmation
3. cancel/back selection
4. quadrant selection
5. summon
6. navigation/auto-scroll
7. passive gaze context
8. decorative sprite reactions
```

A lower-priority event must never block a higher-priority event.

---

# 17. Hackathon Demo Behavior

The demo should make the sprite valuable immediately.

## Demo 1 — Article

1. user naturally reads
2. optional auto-scroll works
3. sprite remains idle in notch
4. user dwells on sprite
5. sprite wakes
6. article referent may receive subtle highlight
7. quadrants appear:
   - SUMMARIZE THIS
   - EXPLAIN THIS
   - FIND MORE ABOUT THIS
   - SOMETHING ELSE
8. user selects
9. sprite speaks result/clarification
10. returns to idle

## Demo 2 — Email

1. Gmail/Mail visible
2. user summons sprite
3. semantic decoder infers communication intent
4. Akinator clarification if necessary
5. inferred complete intent spoken
6. user confirms
7. quadrants disappear
8. sprite enters working animation
9. CU agent drafts message
10. sprite enters NEEDS_CONFIRMATION
11. final choices:
    - SEND
    - EDIT
    - READ TO ME
    - CANCEL
12. user chooses SEND
13. success animation

## Demo 3 — iPhone Mirroring / vertical feed

1. iPhone Mirroring active as narrow window
2. sprite remains in notch
3. routine scrolling/navigation handled separately
4. user summons sprite
5. semantic cards appear as window halo
6. choices relate to current content
7. user expresses intent
8. CU operates mirrored phone
9. sprite remains in notch with working animation
10. user may interrupt at any time by dwelling on sprite

---

# 18. Explicitly Rejected Designs

Do NOT implement any of the following:

### Rejected: bottom-center persistent agent button
The notch sprite replaces it.

### Rejected: moving mascot follows every CU click
The sprite is conversational only.

### Rejected: sprite disappears during full-screen use
It remains available.

### Rejected: four tiny buttons inside iPhone Mirroring
Use a window halo with large hit regions.

### Rejected: random sprite wandering
Movement must communicate meaning.

### Rejected: dynamic A/B/C/D geometry
Semantics adapt; spatial vocabulary remains stable.

### Rejected: voice required from user
Gaze alone must be sufficient.

### Rejected: full chatbot window
The system is an accessibility interaction layer, not a chat client.

### Rejected: continuous transcript
Show only concise status and choices.

---

# 19. Definition of Done

The sprite/UI subsystem is complete only when all of these pass:

- [ ] sprite appears at correct notch/top-center position based on real screen geometry
- [ ] sprite persists above normal apps
- [ ] sprite persists across Spaces
- [ ] sprite remains usable above full-screen apps on target macOS version
- [ ] sprite does not steal keyboard focus
- [ ] quick glance does not summon
- [ ] dwell progress is visible and resets correctly
- [ ] full dwell summons semantic UI
- [ ] A/B/C/D remain spatially invariant
- [ ] quadrant cards freeze until selection
- [ ] window-halo layout works around iPhone Mirroring-sized window
- [ ] sprite remains in notch during CU
- [ ] working animation is visible during CU
- [ ] dwell on sprite during CU interrupts/steers
- [ ] consequential actions produce confirmation UI
- [ ] reference highlighting works without moving sprite
- [ ] onboarding can temporarily move sprite to teach quadrants
- [ ] onboarding returns sprite to notch
- [ ] reduced-animation mode functions
- [ ] developer can disable/hide sprite intentionally
- [ ] no other ordinary state makes sprite disappear
- [ ] all demo workflows can be completed without keyboard/mouse after calibration

---

# 20. Final Product Rule

When uncertain about a UI choice, apply this rule:

> **The notch is home. The sprite is conversation. The screen is the user's world. The quadrants are temporary language. The executor stays invisible.**

Do not let visual novelty weaken the user's spatial certainty or ability to regain control.
