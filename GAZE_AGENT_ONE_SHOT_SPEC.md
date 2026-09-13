# Gaze-to-Agent: One-Shot Build Specification

> **Purpose of this file:** This is an execution prompt/specification for a coding agent. Treat every MUST/SHALL statement as a requirement. Do not stop after scaffolding or planning. Build, run, test, and leave a working macOS prototype.

> **Current implementation scope (2026-09-12):** Apple iPhone Mirroring integration is deferred and is not part of the current build. References to phone-side control and iPhone-specific demo scenarios below are historical requirements; the implemented narrow-window behavior is application-agnostic.

## 0. Agent execution directive

You are the senior engineer responsible for delivering a working HackRice-quality prototype of **Gaze-to-Agent**, a gaze-first accessibility interface that lets a person with severe motor/speech impairment communicate high-level intent with their eyes and delegate the actual computer/browser/phone work to an AI computer-use agent.

You are expected to complete the task end-to-end. Do not ask the human to make routine engineering choices that are already specified here. If a third-party library has changed, inspect its current official documentation/source and adapt while preserving the behavior defined in this spec. If an API key is missing, implement and test the non-network path and a deterministic mock for that provider, leave `.env.example`, and continue; missing secrets are not a reason to stop.

### Core execution rules

1. **Bias toward reuse, not reinvention.** Before writing a subsystem, check the exact upstream projects named in §4. Reuse their package, demo, calibration flow, patches, or wrapper where possible.
2. **Do not build a gaze model, TTS model, browser agent, or desktop agent from scratch.** Use the named existing tools.
3. **Write only the glue and the novel product logic:** state machine, semantic decoder protocol, dynamic quadrant/halo layout, context fusion, speculation/cache, confirmation policy, and provider adapters.
4. **Use current upstream APIs.** Read current docs/SDK types before implementing OpenAI Computer Use. Do not cargo-cult old `computer-use-preview` examples if the installed/current SDK exposes the modern `computer` tool with `gpt-6-astra`.
5. **Pin dependency versions/commits once proven working.** Commit a lockfile and `THIRD_PARTY.md` with URLs, versions/commit hashes, licenses, and any upstream patches used.
6. **Do not silently replace a failing dependency with bespoke code.** Use the fallback chain specified below.
7. **Test the actual interaction, not only unit functions.** A no-camera/no-API simulation mode is mandatory so the full app can be exercised in CI/VM; real webcam/API smoke tests are additional when credentials/hardware are available.
8. **Do not leave TODOs in required MVP paths.** Optional/stretch functionality may be clearly marked.

---

# 1. Product thesis

The product is **not an eye-controlled mouse** and **not a fixed AAC operating system with a limited set of custom apps**.

The product is a system-level interface over the user's existing Mac, browser, desktop apps, and—when present—Apple iPhone Mirroring.

The fundamental interaction is:

```text
human intent
   ↓
coarse webcam gaze (large targets, not pixel-perfect pointing)
   ↓
semantic decoder repeatedly offers 4 meaningfully different branches
   ↓
if predictions miss, conversational/Akinator-style clarification asks one high-information question
   ↓
complete natural-language intent
   ↓
voice + gaze confirmation
   ↓
OpenAI Responses API + GPT-6 Astra Computer Use
   ↓
agent operates the user's existing computer/browser/iPhone Mirroring UI
```

The thesis to preserve in UI and architecture is:

> **The eyes communicate intent; the agent operates the computer.**

Do not degrade the project into “gaze cursor controls UI.” Natural gaze may provide *reference/context*, and deliberate gaze selections choose semantic branches.

---

# 2. MVP scope and non-goals

## 2.1 Target platform

MVP target is **macOS on Apple Silicon**, single primary display, with a built-in or USB webcam. The app must run as a desktop application and overlay other applications.

The implementation should be structured so other gaze providers and platforms can be added later, but do not spend hackathon time implementing Windows/Linux.

## 2.2 Required user-visible capabilities

The MVP MUST:

- calibrate a normal webcam gaze tracker;
- continuously estimate gaze locally;
- keep ordinary gaze non-clicking/non-destructive in passive mode;
- provide a deliberate gaze-only way to summon the agent;
- show four large gaze-selectable semantic options;
- adapt those options to current app/window/screen context;
- adapt overlay geometry to either the whole screen or a small active window (e.g. iPhone Mirroring);
- support “none of these” without sacrificing one of the four main semantic quadrants;
- after repeated misses, ask a spoken Akinator-style clarifying question with four gaze-selectable answers;
- infer a complete user intent and read it aloud for confirmation;
- require gaze confirmation before execution;
- hand the confirmed intent to OpenAI Responses API / GPT-6 Astra Computer Use;
- execute clicks, typing, scrolling, drags, keyboard actions, and waits on the real Mac;
- treat iPhone Mirroring as another controllable Mac window, without building an iOS integration;
- provide contextual low-level navigation modes for reading/feeds so users do not waste semantic selections repeatedly saying “scroll”;
- support a guaranteed fallback arbitrary text-entry path using Dasher Web if semantic decoding repeatedly fails;
- expose latency/selection telemetry for the demo;
- provide a deterministic simulation mode so the app can be demonstrated/tested without a camera or API credentials.

## 2.3 Explicit non-goals

Do NOT:

- train a custom gaze model;
- build a custom speech/TTS model;
- build a custom OCR system;
- build a new browser automation engine;
- rebuild Gmail/TikTok/Amazon/etc. inside our app;
- create app-specific hard-coded workflows for every site;
- use gaze as a raw mouse replacement by default;
- send webcam video frames to cloud APIs;
- claim this is a medical device or suitable for every person with stroke/CP/ALS;
- auto-send messages, purchases, deletes, posts, or other consequential actions without explicit confirmation.

---

# 3. Required architecture

Use a TypeScript-first Electron desktop app so WebEyeTrack can run directly in a browser-like renderer and the overlay can be transparent/system-level.

```text
┌────────────────────────────────────────────────────────────────────┐
│ Electron app                                                       │
│                                                                    │
│  Renderer                                                          │
│  ├─ webcam + GazeProvider                                          │
│  ├─ calibration                                                    │
│  ├─ fixation/dwell classifier                                      │
│  ├─ React overlay / semantic halo                                  │
│  └─ audio playback                                                 │
│                                                                    │
│  Main process                                                      │
│  ├─ get-windows: active window/app/url/bounds                      │
│  ├─ desktopCapturer: screenshots                                   │
│  ├─ @nut-tree-fork/nut-js: system input                            │
│  ├─ ContextEngine                                                  │
│  ├─ SemanticDecoder (OpenAI GPT-5.6 Luna, structured output)       │
│  ├─ PrefetchCache                                                  │
│  ├─ TTSProvider (ElevenLabs Flash; macOS say fallback)             │
│  └─ ComputerUseExecutor (OpenAI Responses + GPT-6 Astra)           │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

Use Electron IPC with a typed contract. The renderer must not have direct access to API keys. Secrets remain in the main process.

---

# 4. Existing projects/tools to reuse

Before coding each subsystem, inspect these upstreams. Prefer their documented APIs/examples over reimplementing them.

## 4.1 Primary gaze tracker — WebEyeTrack

**Repository:** https://github.com/RedForestAI/WebEyeTrack  
**NPM package:** `webeyetrack`  
**License:** MIT  
**Use:** primary webcam gaze provider and few-shot personalization/calibration.

Requirements:

- Use the JS/TypeScript/browser implementation, not the Python training stack.
- Start from upstream examples/minimal example.
- Preserve on-device inference.
- Gaze provider output to our app MUST be normalized screen coordinates `(xNorm, yNorm)` in `[0,1]` plus timestamp and quality/validity.

### Known upstream integration rough edges

Do not invent new patches if the published package has build/asset/personalization issues. First inspect and reuse the reproducible patch work from:

**Repository:** https://github.com/kiante-fernandez/otree-et

That project documents/pins a WebEyeTrack build and patch series exposing personalization, fixing asset paths, and repairing a clean build. Reuse or adapt that patch series; record exact upstream commit and patch files in `THIRD_PARTY.md`.

## 4.2 Gaze fallback — RealEye Webcam EyeTracker Light Open

**Repository:** https://github.com/RealEye-io/webcam-eyetracker-light-open  
**NPM:** `@realeye-io/webcam-eyetracker-light-open`

This is a fallback, not the first choice. It already provides webcam tracking, an interactive calibration wizard, direct on-screen coordinates, diagnostics, and testing infrastructure. Put it behind the same `GazeProvider` interface so a config flag can switch providers.

Do not mix both trackers simultaneously.

## 4.3 AAC interaction/design reference — SpeakFaster

**Repository:** https://github.com/TeamGleason/SpeakFaster  
**License:** MIT

Use it as a design/reference source for eye-gaze AAC patterns, contextual predictions, prediction overlays, personalization, correction, and metrics. Do not block MVP on integrating its proprietary/research model stack.

## 4.4 Guaranteed arbitrary text fallback — Dasher Web

**Repository:** https://github.com/dasher-project/dasher-web  
**Core:** https://github.com/dasher-project/DasherCore  
**License:** MIT for v6 projects.

Do not build a new gaze keyboard. Embed/self-host the existing Dasher Web WASM assets/demo in a dedicated fallback panel. Feed our normalized gaze pointer into its existing pointer API. Use the emitted text as a “hint” or full prompt, then return to semantic decoding.

For MVP, copy a known working built web/WASM bundle or use the upstream hosted demo only if self-hosting cannot be completed in time. Self-host is preferred for reliability/privacy.

## 4.5 Active-window metadata

Use **`get-windows`**, not a bespoke Swift process scanner.

- Repository: https://github.com/sindresorhus/get-windows
- NPM: `get-windows`
- It provides active window title, id, bounds, owning app/bundle, and URL for supported browsers on macOS.

## 4.6 Desktop input automation

Use **`@nut-tree-fork/nut-js`** for mouse/keyboard/scroll/drag/system input.

- NPM: `@nut-tree-fork/nut-js`
- This is a maintained/public community fork with prebuilt native dependencies.

Do NOT rely on nut.js screen capture on macOS; there have been macOS capture issues. Use Electron `desktopCapturer` for screenshots instead.

If nut.js input fails on the test Mac, use macOS Quartz/CGEvent through a *small* native fallback only for the failed primitive; do not replace the whole automation stack.

## 4.7 Screen/window capture

Use Electron `desktopCapturer` for screen/window thumbnails/screenshots and `sharp` for crop/resize/annotation.

Use `get-windows` window IDs/bounds to match/crop the active surface.

## 4.8 Semantic decoder LLM

Use OpenAI Responses API with:

- default model: `gpt-5.6-luna`
- low/none reasoning where supported for low latency;
- Structured Outputs (`json_schema`), never free-form parsing;
- image input for active-window context when needed.

Do not use GPT-6 Astra for every gaze turn.

## 4.9 Computer/browser executor

Use the **OpenAI Responses API with `gpt-6-astra` and the current native Computer Use tool**.

Official references the agent must inspect before implementation:

- https://developers.openai.com/api/docs/guides/latest-model
- https://developers.openai.com/api/docs/models/gpt-6-astra
- current Computer Use guide/API reference under developers.openai.com

Use current SDK types. `gpt-6-astra` is the required production executor model for this prototype. If the account lacks access or `OPENAI_API_KEY` is missing, expose a clear configuration/recovery error and do not simulate desktop actions or silently downgrade to an unrelated model.

## 4.10 TTS

Use ElevenLabs:

- model: `eleven_flash_v2_5`
- preferred path: realtime TTS WebSocket / streaming
- docs: https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/realtime-tts

Keep the connection warm when practical. If ElevenLabs credentials are absent or the API is down, fall back to macOS `say` so the prototype remains voice-capable.

---

# 5. Tech stack and repository layout

Use:

- Node.js 22 LTS (or the latest stable version compatible with dependencies)
- pnpm
- Electron
- React + TypeScript
- Vite/electron-vite
- Zod for runtime internal validation where useful
- OpenAI official JS SDK
- ElevenLabs official JS SDK if its streaming API is sufficient; otherwise a minimal WebSocket client following official docs
- `get-windows`
- `@nut-tree-fork/nut-js`
- `sharp`
- Vitest
- Playwright with Electron support for end-to-end tests

Expected repository:

```text
gaze-agent/
  apps/
    desktop/
      src/
        main/
          index.ts
          permissions.ts
          context/
            ContextEngine.ts
            capture.ts
            activeWindow.ts
          decoder/
            SemanticDecoder.ts
            schemas.ts
            prompts.ts
            PrefetchCache.ts
          executor/
            ComputerUseExecutor.ts
            ComputerEnvironment.ts
            actionExecutor.ts
            safety.ts
          tts/
            TTSProvider.ts
            ElevenLabsTTS.ts
            MacSayTTS.ts
          ipc/
            contract.ts
        preload/
          index.ts
        renderer/
          app/
          gaze/
            GazeProvider.ts
            WebEyeTrackProvider.ts
            RealEyeProvider.ts
            SimulatedGazeProvider.ts
            fixation.ts
          overlay/
            Overlay.tsx
            QuadrantCard.tsx
            AgentDock.tsx
            layout.ts
          fallback/
            DasherPanel.tsx
          debug/
            DebugHUD.tsx
  vendor/
    webeyetrack/          # only if patched/vendor build is required
    dasher-web/           # built/static assets if self-hosted
  fixtures/
    article.html
    vertical-feed.html
    email.html
    shopping.html
    computer-use-sandbox.html
  tests/
    e2e/
    unit/
  scripts/
    setup-webeyetrack.sh
    verify-third-party.sh
  .env.example
  THIRD_PARTY.md
  README.md
  ARCHITECTURE.md
  DEMO.md
  package.json
  pnpm-lock.yaml
```

Do not split into microservices. Keep it one Electron app for the hackathon.

---

# 6. Environment/configuration

Create `.env.example` with exactly these documented variables:

```bash
# Providers
GAZE_PROVIDER=webeyetrack            # webeyetrack | realeye | simulated
TTS_PROVIDER=elevenlabs              # elevenlabs | macos
EXECUTOR_PROVIDER=openai             # openai only

# OpenAI
OPENAI_API_KEY=
DECODER_MODEL=gpt-5.6-luna
EXECUTOR_MODEL=gpt-6-astra

# ElevenLabs
ELEVENLABS_API_KEY=
ELEVENLABS_VOICE_ID=
ELEVENLABS_MODEL=eleven_flash_v2_5

# Interaction
GAZE_DWELL_MS=550
AGENT_SUMMON_DWELL_MS=900
NONE_DWELL_MS=700
CANCEL_DWELL_MS=900
GAZE_EMA_ALPHA=0.28

# Safety/demo
EXECUTION_MODE=live                 # live only; desktop actions are never simulated
SIMULATE_GAZE=false
DEBUG_HUD=false
AUTO_SCROLL_ENABLED=true
PREFETCH_ENABLED=true
TTS_PREFETCH_ENABLED=true
```

If no `.env` exists, app starts in simulation/mock mode with a visible banner and remains demoable.

---

# 7. First-run permission/onboarding flow

On first launch, show a setup wizard. Required checks:

1. Camera permission.
2. Screen Recording permission (needed for context capture / computer use).
3. Accessibility permission (needed for nut.js system input and browser URL metadata depending on provider).
4. OpenAI key status.
5. ElevenLabs key status (optional because macOS voice fallback exists).
6. Gaze calibration.

Do not crash when permission is denied. Show the exact missing capability and a Retry button.

A “Demo without permissions” button MUST start `SimulatedGazeProvider` with deterministic local decoding and `MacSayTTS`. Desktop execution remains live-only and must show recovery when `OPENAI_API_KEY` is unavailable.

---

# 8. Gaze subsystem

## 8.1 Provider contract

Implement:

```ts
export interface GazeSample {
  xNorm: number;       // 0..1 relative to primary display
  yNorm: number;       // 0..1 relative to primary display
  timestampMs: number;
  valid: boolean;
  quality?: number;    // 0..1 if provider exposes it
}

export interface GazeProvider {
  readonly name: string;
  initialize(): Promise<void>;
  calibrate(): Promise<CalibrationResult>;
  start(onSample: (sample: GazeSample) => void): Promise<void>;
  stop(): Promise<void>;
  dispose(): Promise<void>;
}
```

Do not expose provider-specific coordinates above this layer.

## 8.2 Calibration

Primary goal is reliable quadrant discrimination, not precise pointer control.

For WebEyeTrack:

- reuse upstream few-shot calibration/personalization example;
- prefer 9 calibration points if supported by the patched integration;
- add four corner/edge verification targets after calibration;
- show a pass/fail result based on whether each verification gaze falls in the correct large region for at least 70% of valid samples in a 700 ms window.

If calibration fails, offer retry and RealEye fallback.

Do not promise centimeter/pixel accuracy in the UI.

## 8.3 Smoothing

Apply a lightweight EMA to valid gaze samples:

```text
smoothed = alpha * raw + (1-alpha) * previous
alpha default = 0.28
```

Do not smooth across invalid gaps longer than 250 ms; reset after a long gap.

## 8.4 Fixation/dwell selection

The core selector is region-based, not pixel-based.

A region is selected when:

- gaze is valid;
- smoothed point remains inside the same hit region for `GAZE_DWELL_MS` (default 550 ms);
- at least 70% of raw samples during the dwell window are also inside the region;
- after selection, that region is locked until gaze leaves it for at least 180 ms. This prevents double-selection from one long stare.

Visual progress ring/fill must show dwell progress.

Never execute a semantic selection from passive gaze mode.

## 8.5 Simulated gaze provider

Mandatory for tests and demos without a camera.

- mouse position acts as gaze;
- hold `Shift` to freeze gaze in place;
- renderer gets exactly the same `GazeSample` stream as a real provider.

No component above `GazeProvider` may special-case simulation.

---

# 9. Interaction state machine

Implement this explicit state machine. Do not invent alternate state transitions.

```text
BOOT
  -> SETUP_REQUIRED | CALIBRATING | PASSIVE

CALIBRATING
  -> PASSIVE | CALIBRATION_ERROR

PASSIVE
  -> AGENT_LOADING          (summon dwell)
  -> PASSIVE_NAV_MODE       (if reading/feed mode already enabled)

AGENT_LOADING
  -> DECODING               (context + first options ready)
  -> ERROR

DECODING
  -> DECODING               (one of 4 semantic options selected)
  -> DECODING_ALT           (NONE selected first time)
  -> CLARIFYING             (NONE selected second consecutive time)
  -> CONFIRM_INTENT         (decoder has complete intent)
  -> PASSIVE                (cancel)
  -> FALLBACK_TEXT          (decoder failure threshold reached)

DECODING_ALT
  -> DECODING               (option selected)
  -> CLARIFYING             (NONE)
  -> PASSIVE                (cancel)

CLARIFYING
  -> DECODING               (answer selected, miss count reset)
  -> FALLBACK_TEXT          (NONE twice during clarification or explicit fallback)
  -> PASSIVE                (cancel)

FALLBACK_TEXT
  -> DECODING               (user submits a hint/partial phrase)
  -> CONFIRM_INTENT         (user submits complete phrase)
  -> PASSIVE                (cancel)

CONFIRM_INTENT
  -> EXECUTING              (confirm)
  -> DECODING               (change)
  -> CONFIRM_INTENT         (read again)
  -> PASSIVE                (cancel)

EXECUTING
  -> CONFIRM_ACTION         (consequential external action pending)
  -> COMPLETE               (task complete)
  -> ERROR
  -> PASSIVE                (user abort)

CONFIRM_ACTION
  -> EXECUTING              (approve)
  -> EXECUTING              (edit/change instructions)
  -> PASSIVE                (cancel task)

COMPLETE
  -> PASSIVE

ERROR
  -> previous safe state | PASSIVE
```

Persist the current intent-session state in memory only for MVP. Do not persist webcam frames.

---

# 10. Passive mode and agent summon

In PASSIVE mode:

- normal gaze is used only to maintain an **attention anchor** (what the user is probably looking at);
- no quadrant/card is selectable;
- a small fixed `Agent` dock is visible at the bottom center of the primary display;
- summoning requires a 900 ms dwell on that dock;
- ordinary gaze elsewhere never causes clicks or agent actions.

Record the median gaze point from the 400 ms immediately before summon. That point is the `attentionAnchor` for initial context.

Once agent mode opens, freeze the attention anchor until the next explicit semantic turn unless the user returns to passive mode.

---

# 11. Context engine

The context engine must answer: **What application/surface is active, what is visible, what is the user referring to, and what generic interaction affordances exist?**

## 11.1 Metadata

At 2 Hz in passive mode, use `get-windows.activeWindow()` and cache:

```ts
interface WindowContext {
  appName: string;
  bundleId?: string;
  windowTitle: string;
  url?: string;
  windowId: number;
  bounds: {x:number; y:number; width:number; height:number};
  screenWidth: number;
  screenHeight: number;
}
```

Do not call the LLM at 2 Hz. Only local metadata polling runs continuously.

## 11.2 Visual context capture

On summon and after material screen/app changes:

1. capture the active window via Electron `desktopCapturer` when possible;
2. if matching the window source fails, capture the primary display and crop to `window.bounds` using `sharp`;
3. create a 512–768 px wide context image;
4. create a second gaze crop centered on the attention anchor, clamped to the active-window image;
5. NEVER capture the webcam feed as part of this context.

Pass full active-window context + gaze crop + metadata to the decoder model for the initial semantic turn.

## 11.3 Generic surface classification

The decoder/context response may classify the current surface into these generic types only:

```text
document_or_article
vertical_feed
media_player
email_or_message
shopping_or_product
search_or_results
maps_or_location
file_or_editor
form_or_transaction
generic_app
```

Do not write code like `if app === "TikTok"` or `if url.includes("amazon")` except in local demo fixtures/tests. Runtime behavior must depend on generic surface/affordances returned from context plus window metadata.

## 11.4 Attention anchor

Represent attention anchor both globally and window-locally:

```ts
interface AttentionAnchor {
  screenXNorm: number;
  screenYNorm: number;
  windowXNorm: number | null;
  windowYNorm: number | null;
  insideActiveWindow: boolean;
}
```

The initial decoder prompt must explicitly treat this as “what the user is likely referring to,” not as a click coordinate.

---

# 12. Dynamic overlay and quadrant geometry

The semantic options always have fixed semantic positions:

```text
A = top-left
B = top-right
C = bottom-left
D = bottom-right
```

Never shuffle A/B/C/D while a session is active.

The **meaning changes; the spatial vocabulary does not**.

## 12.1 Visual style

- Transparent/click-through always-on-top Electron overlay window covering primary display.
- Four cards are translucent, high contrast, rounded, large typography.
- Underlying app remains visible.
- Current gaze card gets a subtle focus glow + dwell progress.
- Do not use tiny text.
- All hitboxes are larger than their visible cards.
- Overlay ignores mouse events except in debug mode.

## 12.2 Layout mode selection

Implement exactly two semantic layout modes for MVP.

### `SCREEN_CORNERS`

Use when active window area / screen area >= `0.55`, or active window is effectively maximized/fullscreen.

Visual card target zones:

- A: left 30% × top 28%
- B: right 30% × top 28%
- C: left 30% × bottom 28%
- D: right 30% × bottom 28%

The visible card itself should occupy only ~55–70% of its target zone so underlying content remains visible.

### `WINDOW_HALO`

Use when active window area / screen area < `0.55`, with special importance for narrow/vertical windows such as iPhone Mirroring.

Compute four large hit regions around the active window:

- A adjacent to upper-left side of the window;
- B adjacent to upper-right side;
- C adjacent to lower-left side;
- D adjacent to lower-right side.

Desired visible card size:

```text
width  = clamp(screenWidth * 0.16, 220, 340)
height = clamp(screenHeight * 0.10, 90, 140)
gap    = 18
```

Cards should be outside the active window when there is room. If a card would go offscreen, slide it along the relevant edge. If still impossible, overlap the active window by at most 20% with 70%+ transparency. Never shrink below 200×80 logical points.

The large hit target may extend farther outward than the visible card.

This is the required behavior for iPhone Mirroring: the phone window visually remains the center of gravity, with four large semantic options around its border/halo rather than tiny controls inside it.

## 12.3 Auxiliary gaze controls

Do not consume one of the four semantic quadrants for global control.

When semantic options are visible, also show:

- **bottom-center:** `None of these / More` — 700 ms dwell;
- **top-center:** `Cancel` — 900 ms dwell.

These auxiliary controls must not overlap quadrant target zones.

## 12.4 Freeze rule

Once a set of four options becomes visible, freeze:

- labels;
- locations;
- hitboxes;
- ordering.

Do not live-regenerate under the user's eyes. Background prefetch may run, but results commit only after the current selection.

---

# 13. Semantic decoder

This is the novel core. It converts very low-bandwidth gaze selections into a normal natural-language prompt.

## 13.1 Model

Use `gpt-5.6-luna` with OpenAI Responses API and Structured Outputs.

For ordinary turns, use the lowest reasoning effort that yields stable schema-compliant output. Keep prompts concise and stable for prompt caching.

## 13.2 Decoder session state

```ts
interface DecoderSession {
  id: string;
  startedAt: number;
  windowContext: WindowContext;
  surfaceType: SurfaceType;
  attentionAnchor: AttentionAnchor;
  accepted: Array<{
    turn: number;
    optionId: "A"|"B"|"C"|"D";
    label: string;
    semanticFragment: string;
  }>;
  rejectedSets: Array<{
    turn: number;
    labels: string[];
  }>;
  clarifications: Array<{
    question: string;
    answer: string;
  }>;
  hintText?: string;
  consecutiveMisses: number;
  turn: number;
}
```

## 13.3 Option requirements

Every displayed option MUST:

- be understandable without reading a paragraph;
- contain <= 7 words; target <= 5;
- represent a materially different semantic branch from the other three;
- be phrased as an intent/meaning, not a token fragment unless deeper decoding requires it;
- avoid near-synonym duplication (e.g. do not show “Search”, “Find”, “Look up”, “Discover” together);
- be grounded in current context but leave one branch broad enough to preserve coverage;
- never contain destructive execution language that bypasses confirmation.

Examples for a selected email:

```text
A Reply to this
B Find a related message
C Explain this email
D Do something else with it
```

Examples for a product page:

```text
A Find this cheaper
B Compare alternatives
C Is this worth it?
D Save or buy this
```

These examples are illustrative, not hard-coded app rules.

## 13.4 Structured output schema

Create a strict schema equivalent to:

```ts
type DecoderTurn = {
  surfaceType: SurfaceType;
  spokenPrompt: string;                // <= 14 words
  options: [DecoderOption, DecoderOption, DecoderOption, DecoderOption];
  candidateIntent: string | null;       // complete natural-language instruction if sufficiently inferred
  candidateIntentReady: boolean;
  navigationModeSuggestion: "none" | "reading" | "vertical_feed";
};

type DecoderOption = {
  id: "A" | "B" | "C" | "D";
  label: string;                        // <= 7 words
  semanticFragment: string;             // machine-facing concise meaning
  kind: "intent" | "category" | "detail" | "answer";
};
```

Validate length/count locally. If invalid, issue one repair call with the validation errors. If repair fails, fall back to four deterministic generic branches:

```text
A Communicate
B Find or learn
C Do something
D Personal need / other
```

## 13.5 Normal prediction prompt

Implement a stable system/developer prompt with this exact intent:

```text
You are the semantic decoder for a gaze-only AAC-to-agent interface.
The user cannot be required to type or speak.
Your job is to turn a few coarse 4-way gaze choices into the user's intended natural-language instruction.

Generate exactly four short, semantically distinct choices that collectively cover the most plausible next meanings given:
- active app/window and visible screen context,
- what the user was looking at when they summoned the agent,
- accepted prior choices,
- rejected option sets,
- clarification answers,
- optional text hint.

Do not offer four synonyms.
Prefer high-level semantic branches early and increasingly specific meanings later.
Use the gaze anchor as a likely referent ("this"), not as a command to click.
Never assume the user wants an irreversible action merely because it is visible.
When the accumulated context is enough to express a specific useful instruction, provide candidateIntent and set candidateIntentReady=true. The UI will still confirm it before execution.
Keep spokenPrompt short; the user can see the four options.
```

Do not ask the model to reveal chain-of-thought.

## 13.6 Selection behavior

On A/B/C/D selection:

1. append selected `semanticFragment` to `accepted`;
2. set `consecutiveMisses = 0`;
3. increment turn;
4. if a prefetched next state exists for this exact session-state hash, display it immediately;
5. otherwise request next decoder turn;
6. if returned `candidateIntentReady=true`, transition to `CONFIRM_INTENT` instead of showing another semantic turn.

Minimum behavior before completion:

- normally require at least 2 deliberate semantic selections;
- allow completion after 1 selection only if the option itself is an explicit complete action and decoder returns a specific candidate intent (e.g. “Pause this video”).

## 13.7 “None of these” behavior

On first consecutive `None of these`:

1. record all four labels in `rejectedSets`;
2. `consecutiveMisses = 1`;
3. request four **semantically different alternatives**, explicitly telling the model not to paraphrase rejected branches;
4. state = `DECODING_ALT`.

On second consecutive `None of these`:

- do NOT generate another flat prediction set;
- transition to `CLARIFYING`.

## 13.8 Akinator / clarification mode

The clarifier must ask one short question chosen to reduce uncertainty as much as possible, then offer four short gaze answers.

Use a dedicated structured prompt:

```text
You are recovering from failed semantic predictions in a gaze-only AAC interface.
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
```

Structured output:

```ts
type ClarificationTurn = {
  spokenQuestion: string;   // <= 18 words
  options: [
    {id:"A", label:string, semanticAnswer:string},
    {id:"B", label:string, semanticAnswer:string},
    {id:"C", label:string, semanticAnswer:string},
    {id:"D", label:string, semanticAnswer:string}
  ];
};
```

After an answer:

- append question/answer to `clarifications`;
- reset `consecutiveMisses=0`;
- return to normal decoder generation.

If the user rejects two clarification sets in the same session, open `FALLBACK_TEXT` automatically.

## 13.9 Complete intent confirmation

When decoder returns a candidate intent:

- show the exact sentence prominently;
- speak: `I think you mean: <intent>. Is that right?`
- show four fixed confirm quadrants:

```text
A Confirm
B Change it
C Read again
D Cancel
```

`Change it` returns to semantic decoding with the candidate intent added as a rejected hypothesis and asks what to change.

Do not execute until A is selected.

---

# 14. Speculative decoding / perceived latency

This is required, not stretch.

## 14.1 One-level branch prefetch

As soon as a four-option turn is displayed, asynchronously prepare the next state for all four possible selections.

Implement a bulk prefetch call that asks the decoder to generate four possible `DecoderTurn` outputs—one conditioned on A, one on B, one on C, one on D—using the same context.

Cache key:

```text
sha256(sessionId + turn + accepted + rejectedSets + clarifications + currentOptionSetHash)
```

Cache value contains the 4 successor turns.

On a user's selection, a cache hit MUST commit the successor UI synchronously/local-only before starting any new network work.

## 14.2 Prefetch invalidation

Invalidate cached successors if:

- active app/window changes materially;
- user chooses `None`;
- context capture changed because executor moved the UI;
- session is cancelled;
- cache older than 20 seconds.

## 14.3 TTS prefetch

If `TTS_PREFETCH_ENABLED=true`, synthesize the successor spoken prompts in the background with max concurrency 2. Store audio buffers keyed by successor state.

Never play prefetched audio until that branch is actually selected.

## 14.4 UI timing target

On a branch cache hit:

- selection acknowledgement: < 16 ms render frame;
- successor cards visible: target < 60 ms after confirmed dwell;
- prefetched audio start: target < 150 ms after confirmed dwell.

Log actual values.

---

# 15. Voice / conversational layer

## 15.1 Primary provider

Use ElevenLabs Flash v2.5.

Keep utterances short. The voice should speak:

- clarification questions;
- complete intent confirmations;
- consequential-action confirmations;
- short completion/error messages.

Do not read all four visible option labels by default.

## 15.2 Optional auditory preview

Accessibility setting: `Speak option on hover`.

If enabled:

- after gaze remains inside an option for 250 ms, speak only that option label once;
- continuing dwell selects it at normal dwell threshold;
- leaving cancels without selection.

Default OFF to minimize noise/latency.

## 15.3 Fallback

If ElevenLabs unavailable, `MacSayTTS` shells out to `/usr/bin/say` with no API dependency.

The UI should display which provider is active.

---

# 16. Contextual navigation modes

Semantic quadrants are scarce; routine repeated navigation should not require semantic decoding every time.

Navigation modes are explicit stateful modes suggested by context and activated by the user.

## 16.1 Reading mode

When context is `document_or_article`, semantic options may include a contextually generated option equivalent to `Follow as I read` / `Hands-free scroll`.

After the user selects/accepts reading mode:

- hide semantic cards and return to passive-looking UI;
- keep a tiny `Reading` status indicator;
- if gaze remains in the lower 22% of the active window for 650 ms, issue a small downward scroll (default 320 logical px);
- cooldown 550 ms;
- if gaze remains in upper 15% for 700 ms, issue a small upward scroll;
- central gaze does nothing;
- looking at Agent dock summons semantic agent and pauses scrolling;
- exiting reading mode is available through the agent dock.

Do not attempt automatic text-line tracking in MVP.

## 16.2 Vertical-feed mode

When context is `vertical_feed`, semantic options may offer a hands-free feed mode.

When active:

- lower edge dwell -> one next-item scroll/swipe;
- upper edge dwell -> one previous-item scroll/swipe;
- center remains content viewing area;
- agent dock summons semantic choices such as “Ask about this”, “Save/like this”, “Find more like this”, etc., generated dynamically.

For an iPhone Mirroring window, all scroll/click coordinates are constrained to that window’s bounds.

No hard-coded TikTok API integration is allowed. It must work by generic screen/window control.

---

# 17. iPhone Mirroring behavior

Treat Apple iPhone Mirroring as a normal Mac window.

Required behavior:

1. `get-windows` detects active window/bounds/app.
2. Overlay switches to `WINDOW_HALO` because the phone window is narrow/small.
3. Context screenshot is the mirrored iPhone window.
4. Semantic choices are generated from visible content.
5. Executor uses Mac mouse/keyboard/scroll/drag events inside the window.
6. No iOS SDK, jailbreak, phone-side app, or accessibility integration is required for MVP.

The implementation should not depend on the window title being exactly `iPhone Mirroring`; generic small-window behavior must still work.

---

# 18. Computer Use executor

## 18.1 Invocation boundary

The expensive executor is invoked only after `CONFIRM_INTENT -> Confirm`.

Input is a complete natural-language task plus context metadata, e.g.:

```text
User confirmed task:
"Open the email from Professor Lee about tomorrow and reply that I will be ten minutes late."

Operate the user's current Mac desktop to complete this task.
Use the existing signed-in apps/browser when possible.
Do not perform an irreversible/external action such as Send, Purchase, Delete, Post, Submit, or Confirm payment without returning control to our confirmation UI immediately before that final action.
```

## 18.2 OpenAI model/tool

Use:

- Responses API;
- model `gpt-6-astra`;
- the current native Computer Use tool supported by Astra;
- low reasoning initially unless task complexity requires more;
- state/persisted response chaining per current SDK.

At implementation time, inspect the current OpenAI JS SDK types and official docs. If the modern tool type is `computer`, use it. Do not force deprecated preview schema if SDK/docs have moved on.

## 18.3 Local computer environment adapter

Implement `ComputerEnvironment`:

```ts
interface ComputerEnvironment {
  getDisplayInfo(): Promise<{width:number; height:number; scaleFactor:number}>;
  screenshot(): Promise<Buffer>; // PNG exactly matching advertised logical width/height
  execute(action: ComputerAction): Promise<void>;
}
```

### Screenshot path

- temporarily hide semantic overlay from the captured frame;
- capture primary display with `desktopCapturer`;
- resize to Electron logical display bounds via `sharp` so OpenAI coordinate space matches action coordinates;
- restore overlay immediately after capture if needed;
- during continuous execution, it is acceptable to keep the semantic overlay hidden and show a separate small non-interfering status indicator.

### Action path

Map Computer Use actions to `@nut-tree-fork/nut-js`:

- click -> mouse move + click;
- double click;
- drag path;
- scroll;
- key press / hotkey;
- type text;
- wait.

Add an automated coordinate-map calibration test using `fixtures/computer-use-sandbox.html`: the model/test executor clicks known colored/numbered grid targets and the page reports which target received the click. Fix Retina scaling until the logical coordinates match.

## 18.4 Browser tasks

Do not create a separate cloud Browser Use product for MVP. The same Astra Computer Use executor operates the user's existing browser session. You may additionally expose OpenAI web search to Astra for research tasks, but GUI actions still occur in the user's browser when the task requires interacting with their accounts/session.

## 18.5 Consequential action gate

The app must intercept any action sequence when the executor is about to cause an external/consequential side effect.

At minimum gate:

- send email/message;
- submit/post;
- purchase/payment/checkout;
- delete/archive if destructive;
- account/security changes;
- file deletion/overwrite;
- booking/appointment confirmation;
- financial transaction.

When the executor reports/requests such a step, pause and show:

```text
A Approve
B Change
C Read/Explain
D Cancel
```

Speak a concise summary of the exact pending action. Only A resumes.

Also honor any native OpenAI Computer Use safety-check/confirmation mechanism required by the API.

---

# 19. Dasher fallback

Semantic prediction must never trap the user.

Enter `FALLBACK_TEXT` when:

- two clarification sets are rejected;
- decoder errors twice;
- user explicitly chooses fallback from a recovery screen.

Embed Dasher Web in a modal/overlay panel that uses the same gaze stream as pointer input.

Provide buttons/targets:

```text
Use as hint
Use as full request
Clear
Cancel
```

`Use as hint` stores text in `session.hintText` and returns to semantic decoder, allowing even one or two letters/keywords to dramatically narrow predictions.

`Use as full request` transitions directly to `CONFIRM_INTENT` with the entered text.

Do not implement a custom alphabet keyboard unless Dasher cannot be made to load at all; if that happens, leave a clearly isolated emergency `Base4Keyboard` fallback only after documenting the upstream failure.

---

# 20. Privacy and data boundaries

MVP privacy rules:

- webcam frames stay local inside gaze provider;
- do not log raw webcam images;
- gaze samples may be logged only as normalized coordinates/timestamps when Debug/Research logging is enabled;
- screenshots are sent to the decoder/executor only as required for context/computer use;
- API keys remain in Electron main process;
- redact secrets from logs;
- logs must be deletable from Settings;
- default telemetry is local JSONL, no external analytics service.

Show a one-time notice explaining that screen content may be sent to the configured AI provider during semantic context analysis/execution.

---

# 21. Telemetry and demo metrics

Create a local `SessionMetrics` recorder. Required metrics:

```ts
interface SessionMetrics {
  semanticSelections: number;
  noneSelections: number;
  clarificationAnswers: number;
  fallbackCharacters?: number;
  timeToIntentMs: number;
  decoderColdLatencyMs: number[];
  prefetchHits: number;
  prefetchMisses: number;
  prefetchedUiLatencyMs: number[];
  ttsTimeToFirstAudioMs: number[];
  executorStartLatencyMs?: number;
  totalTaskTimeMs?: number;
  executorActions?: number;
}
```

Show a hidden Debug HUD toggled with `Cmd+Shift+D` displaying:

- gaze FPS;
- smoothed gaze point;
- current state;
- current layout mode;
- active app/title;
- dwell progress;
- decoder latency;
- prefetch hit/miss;
- TTS provider/TTFA;
- semantic selection count;
- current candidate intent.

Create a simple post-task results card:

```text
Task completed
Semantic gaze selections: 5
Clarification questions: 1
Computer actions delegated: 18
Time to intent: 4.8 s
Task completion: 12.6 s
```

Do not fabricate comparisons to traditional gaze typing. If a benchmark comparison is shown, it must come from an actual test run.

---

# 22. Deterministic mock/demo mode

The full app MUST work without external credentials.

When `GAZE_PROVIDER=simulated` and `DECODER_PROVIDER=fixture`:

- mouse = gaze;
- decoder can use deterministic fixture rules for the bundled demo pages OR a local canned response graph;
- TTS defaults to macOS `say`;
- desktop execution is not simulated; confirming a task without `OPENAI_API_KEY` enters recovery;
- all state transitions/layouts/prefetch behavior remain identical to live mode.

Do not build a separate mock UI. Same UI/state machine, swapped providers.

---

# 23. Fixtures for testing

Create local fixtures that emulate context without external accounts:

## `article.html`

- long readable article;
- enough text to scroll;
- a highlighted paragraph to test gaze attention anchor;
- buttons `Summarize section`, `Save` only as visual content, not app controls.

Expected semantic behavior after gazing at paragraph + summon: choices should include concepts equivalent to explain/summarize/find more/save, not four generic actions.

## `vertical-feed.html`

- 8 vertically stacked full-height media cards;
- current card id visible;
- scroll changes current card;
- used for feed navigation mode.

## `email.html`

- fake selected email from Professor Lee;
- fake reply button and compose area;
- executor may draft/reply locally without external side effects.

## `shopping.html`

- fake product page with price/reviews;
- semantic options expected to adapt to compare/find cheaper/explain/save-buy categories.

## `computer-use-sandbox.html`

- 3×3 button grid with known coordinates;
- text field;
- scrollable area;
- drag target;
- action log;
- “send” button requiring our consequential-action confirmation.

---

# 24. Tests

## 24.1 Unit tests

Must cover:

- coordinate normalization and Retina mapping;
- EMA reset behavior;
- dwell selection and leave-to-rearm;
- state-machine transitions;
- `SCREEN_CORNERS` geometry;
- `WINDOW_HALO` geometry at center/edges/small vertical window;
- no option overlap with auxiliary controls;
- decoder schema validation;
- rejected-set behavior;
- two misses -> clarifier;
- two clarifier misses -> fallback;
- prefetch cache hit/invalidation;
- consequential-action gate.

## 24.2 Electron/Playwright E2E

Required E2E tests in simulated gaze mode:

### E2E 1 — semantic path

1. launch app in simulated/mock mode;
2. open article fixture;
3. simulate gaze at article paragraph;
4. dwell Agent dock;
5. verify four context-sensitive options render;
6. select a branch;
7. verify successor appears;
8. reach candidate intent;
9. confirm;
10. With `OPENAI_API_KEY` configured, OpenAI Computer Use completes a safe action; without it, the executor-unavailable recovery card appears;
11. metrics show semantic selections > 0.

### E2E 2 — rejection/Akinator

1. summon;
2. select `None` twice;
3. verify spoken/visible clarification question;
4. choose one answer;
5. verify normal decoder resumes and misses reset.

### E2E 3 — halo layout

1. create/position a narrow fixture window occupying < 30% screen area;
2. make it active;
3. summon;
4. verify `WINDOW_HALO`;
5. verify all cards are >= 200×80 and on-screen;
6. verify A/B/C/D fixed relative ordering.

### E2E 4 — reading mode

1. activate reading mode in article fixture;
2. simulate lower-window gaze dwell;
3. verify scroll happens once;
4. verify cooldown prevents repeated runaway scroll;
5. summon agent and verify scrolling pauses.

### E2E 5 — executor coordinate mapping

1. open computer-use sandbox;
2. call `ComputerEnvironment.screenshot()`;
3. execute local click actions on grid center points;
4. verify exact intended buttons receive clicks;
5. test text typing, scroll, and drag.

## 24.3 Live smoke tests when credentials/hardware available

If `OPENAI_API_KEY` exists:

- validate one `gpt-5.6-luna` structured decoder call against article fixture;
- validate one `gpt-6-astra` Responses Computer Use dry-run on sandbox only;
- do NOT run destructive real-world actions.

If `ELEVENLABS_API_KEY` exists:

- measure first audio byte/playback start for a short phrase using `eleven_flash_v2_5`.

If webcam is available:

- run calibration;
- verify four-corner discrimination;
- log sample rate and invalid-rate.

---

# 25. Demo scenarios that must work

At least three of these four must be demo-ready; Scenario 1 and 2 are mandatory.

## Scenario 1 — Article -> semantic question

User looks at a paragraph, summons agent.

Expected experience:

```text
Explain this
Summarize this section
Find more about this
Save/use this later
```

User selects `Explain this`; system infers complete intent, reads it aloud, confirms, then executor may open/search or respond appropriately.

Reading mode must also be discoverable and demonstrate gaze scrolling.

## Scenario 2 — Email -> full workflow

Fake/local or safe real email context.

User gaze decodes an intent equivalent to:

> “Reply to Professor Lee that I will be ten minutes late.”

Voice confirms. User confirms with gaze. Executor opens/focuses reply, drafts text. Before `Send`, the app asks for a second consequential-action confirmation.

## Scenario 3 — iPhone Mirroring / narrow vertical window

If iPhone Mirroring is available, use it; otherwise use a narrow vertical fixture window.

- overlay MUST switch to semantic halo;
- choices appear around the window, not squeezed inside it;
- feed-like context can enter vertical-feed navigation mode;
- lower/upper edge gaze performs next/previous via scroll;
- agent dock opens semantic choices about current content.

## Scenario 4 — Predictions fail -> Akinator recovery

Deliberately reject two prediction sets.

Agent speaks a short clarifying question with four answers. One gaze answer should materially improve the next prediction set. This proves the system is not trapping the user inside the model's top guesses.

---

# 26. Visual/UX requirements

The app should look demo-ready, not like a developer panel.

- dark translucent cards with strong text contrast;
- minimal chrome;
- visible dwell progress;
- smooth 120–180 ms transitions between semantic turns;
- no layout movement while user is dwelling;
- active app remains legible under overlay;
- candidate intent confirmation gets a centered, high-contrast card;
- agent execution state shows one concise status line (`Finding the email…`, `Draft ready…`) without exposing raw model reasoning;
- Debug HUD is hidden by default.

Do not use “medical-looking” hospital styling. This is a universal computer interface/accessibility product.

---

# 27. Performance targets

These are engineering targets, not promises. Measure and report actual values.

- gaze processing: >= 20 valid prediction attempts/sec preferred;
- overlay render: 60 fps;
- dwell acknowledgement visual: < 1 frame;
- prefetched next semantic UI: < 100 ms after dwell commit;
- cold semantic decoder response: target < 600 ms;
- first spoken audio after a cached/prefetched turn: target < 250 ms;
- initial summon -> first useful quadrants: target < 900 ms cold, faster if context cached;
- no UI thread blocking during model/TTS calls.

Use `performance.now()` timing spans and expose in Debug HUD.

---

# 28. Failure/fallback rules

Implement these exact fallback decisions:

1. **WebEyeTrack fails to build/load:** use the known `otree-et` patch series.
2. **Patched WebEyeTrack still fails at runtime on target Electron version:** switch config to RealEye provider; do not block project.
3. **ElevenLabs missing/down:** macOS `say`.
4. **OpenAI decoder missing key/down:** deterministic fixture decoder in demo mode; live mode surfaces error without losing session.
5. **Astra executor unavailable:** show an executor-unavailable recovery card; do not simulate or pretend real computer use ran.
6. **nut.js screen capture issue:** irrelevant; screenshots use `desktopCapturer`.
7. **nut.js input primitive fails:** isolate that primitive and use Quartz/CGEvent fallback.
8. **Dasher self-host build fails:** embed known working upstream hosted demo only for hackathon fallback, document this clearly.
9. **Window metadata fails:** fall back to screen-corner layout and active-display screenshot; semantic decoding still works.

---

# 29. Build sequence

Follow this order so a working demo exists early.

## Milestone 1 — app shell + simulation

- Electron/React app;
- transparent overlay;
- simulated gaze;
- dwell selector;
- Agent dock;
- screen-corner and halo layouts;
- canned decoder;
- local fixtures;
- E2E halo/selection tests.

**Do not proceed until this interaction is smooth.**

## Milestone 2 — real gaze

- integrate WebEyeTrack;
- calibration;
- quadrant verification;
- RealEye fallback adapter;
- keep simulation available.

## Milestone 3 — context + live semantic decoder

- `get-windows` metadata;
- active-window screenshot/crop;
- GPT-5.6 Luna structured decoder;
- None -> alternate -> clarifier;
- candidate intent confirmation;
- prefetch cache.

## Milestone 4 — TTS

- ElevenLabs Flash streaming;
- MacSay fallback;
- clarification/confirmation voice;
- TTFA metrics.

## Milestone 5 — local computer environment

- desktop screenshot;
- nut.js actions;
- Retina coordinate test;
- sandbox fixture.

## Milestone 6 — Astra Computer Use

- current Responses API computer tool;
- action loop;
- safe sandbox end-to-end;
- consequential confirmation.

## Milestone 7 — reading/feed modes + Dasher

- reading scroll;
- vertical feed mode;
- Dasher Web fallback.

## Milestone 8 — polish/demo

- UX polish;
- debug/metrics;
- DEMO.md;
- record actual latency and selection counts;
- run full tests.

---

# 30. Required documentation

## README.md

Must include:

- product thesis in one paragraph;
- architecture diagram;
- prerequisites;
- permissions;
- setup commands;
- `.env` instructions;
- how to launch simulated mode;
- how to launch live webcam mode;
- how to test OpenAI Computer Use safely;
- known limitations.

## THIRD_PARTY.md

For every reused repo/package, record:

- URL;
- package/version or git commit;
- license;
- exactly what we reuse;
- any patches.

## ARCHITECTURE.md

Explain provider interfaces and state machine, including why semantic intent and execution are separated.

## DEMO.md

Give a 2-minute demo script:

1. one sentence problem/thesis;
2. webcam calibration briefly;
3. article or email semantic gaze interaction;
4. Akinator clarification if possible;
5. confirmed computer-use task;
6. show selection count / delegated action count;
7. optionally show narrow iPhone-mirroring halo.

HackRice judging prioritizes technical rigor, originality/creativity, UX/design, practicality/impact, and track relevance; demonstrate those properties directly rather than explaining them abstractly.

---

# 31. Final acceptance checklist

Do not declare completion until all non-optional items below are true.

### App / gaze

- [ ] Electron app launches on macOS.
- [ ] Simulated gaze works.
- [ ] Real WebEyeTrack provider is integrated OR documented fallback RealEye is active due a proven upstream issue.
- [ ] Calibration flow works.
- [ ] Gaze selection requires dwell and leave-to-rearm.
- [ ] Passive gaze cannot accidentally select semantic options.

### Dynamic UI

- [ ] Agent dock summons UI by gaze.
- [ ] Four semantic options appear.
- [ ] `SCREEN_CORNERS` works.
- [ ] `WINDOW_HALO` works for a narrow vertical window.
- [ ] A/B/C/D positions remain stable.
- [ ] `None of these` and `Cancel` auxiliary targets work.
- [ ] Current option set remains frozen until selection.

### Decoder

- [ ] GPT-5.6 Luna structured output path implemented.
- [ ] Four options are schema-validated.
- [ ] First None produces different alternatives.
- [ ] Second None opens clarifier.
- [ ] Clarifier produces one question + four answers.
- [ ] Candidate complete intent appears and is spoken.
- [ ] Confirm/change/read-again/cancel works.
- [ ] One-level speculative branch prefetch works and logs hit/miss.

### Voice

- [ ] ElevenLabs Flash provider implemented.
- [ ] macOS voice fallback works.

### Navigation

- [ ] Reading mode scroll works with gaze zones.
- [ ] Vertical-feed mode works on fixture.
- [ ] Agent summon pauses navigation mode.

### Executor

- [ ] desktop screenshot returned at correct logical resolution.
- [ ] nut.js click/type/scroll/drag works.
- [ ] Retina coordinate mapping test passes.
- [ ] OpenAI Responses / GPT-6 Astra Computer Use path implemented with current SDK.
- [ ] Executor tested on safe local sandbox when API key available.
- [ ] Consequential action confirmation gate works.

### Fallback/tests/docs

- [ ] Dasher Web fallback loads or upstream-hosted emergency fallback documented.
- [ ] Unit tests pass.
- [ ] Required E2E tests pass in simulated mode.
- [ ] README, ARCHITECTURE, THIRD_PARTY, DEMO docs exist.
- [ ] No raw webcam frames are logged/sent to cloud.
- [ ] `.env.example` is complete.
- [ ] No required-path TODOs remain.

---

# 32. Final response expected from the coding agent

When finished, do not merely say “implemented.” Report:

1. exact commands to install/run;
2. which gaze provider is active and why;
3. which third-party repos/packages were reused and exact versions/commits;
4. which tests were run and their results;
5. actual measured latency metrics from the machine, if available;
6. whether live OpenAI/ElevenLabs smoke tests ran or were skipped due credentials;
7. any known issue that still affects the demo;
8. the fastest demo path to reproduce the end-to-end flow.

If a required capability could not be completed, say exactly which acceptance item failed, why, and show the tested fallback. Do not hide failures.

---

# 33. Upstream references to inspect before implementation

- WebEyeTrack: https://github.com/RedForestAI/WebEyeTrack
- Patched WebEyeTrack integration reference: https://github.com/kiante-fernandez/otree-et
- RealEye fallback: https://github.com/RealEye-io/webcam-eyetracker-light-open
- SpeakFaster AAC reference: https://github.com/TeamGleason/SpeakFaster
- Dasher Web: https://github.com/dasher-project/dasher-web
- DasherCore: https://github.com/dasher-project/DasherCore
- get-windows: https://github.com/sindresorhus/get-windows
- nut.js upstream: https://github.com/nut-tree/nut.js
- OpenAI model guide: https://developers.openai.com/api/docs/guides/latest-model
- OpenAI Astra model: https://developers.openai.com/api/docs/models/gpt-6-astra
- ElevenLabs realtime TTS: https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/realtime-tts
- Apple iPhone Mirroring behavior: https://support.apple.com/120421

**Build the product described here, not a reduced eye-mouse demo.**
