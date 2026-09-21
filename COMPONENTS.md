# Hoot component contract

This document defines the runtime components that belong to Hoot and separates
them from test fixtures and the user's applications.

## Visible surfaces

Hoot is an accessibility overlay, not an application launcher. The product
surface contains the perceived notch and owl, temporary gaze choices,
interaction status, context controls, confirmation/recovery panels, and
calibration.

Hoot does not render Article, Email, Vertical Feed, Shopping, Desktop, or other
fixture pages as product tabs. The context engine identifies the active macOS
application and window. The layout engine uses window geometry to select a
screen-corner or window-halo arrangement without asking the user to classify
the application.

Hoot has no Apple iPhone Mirroring integration. A narrow active window uses the
same generic window-halo rule as any other application.

## Runtime ownership

| Component | Process | Responsibility | User-visible |
| --- | --- | --- | --- |
| `ContextEngine` | Main | Session-scoped context policy, approved-window metadata, references, and optional window capture | Context badge |
| `InteractionController` and `StateMachine` | Main | Interaction state, selection envelopes, task dispatch, and recovery | Overlay state |
| `TaskStore` and `src/shared/task.ts` reducer | Main/shared | In-memory accepted task meaning, revisions, and task actions | Task-aware cards when enabled |
| `IntentCompositionEngine` | Main | Semantic choices, clarification turns, and terminal intent | Semantic cards |
| `IntentFrame` | Shared | Typed fields, accepted evidence, unresolved slots, and provenance | No direct UI |
| `ContextLedger` and `TargetResolver` | Main | Bounded weak context and open-world target lookup | Context metadata |
| `CandidateRanker` | Main | Converts decoder hypotheses into four diverse cards | Semantic cards |
| `TaskCompiler` | Main | Converts authoritative intent into an executor task | No direct UI |
| `DecoderProvider` | Main | Shared adapter contract for OpenRouter, direct Gemini, and fixture providers | No direct UI |
| Computer-use executor | Main | Performs desktop actions and consequential-action checks | Execution status |
| TTS service | Main | Speaks prompts and confirmations | Audio and sprite state |
| WebEyeTrack provider | Renderer | Produces live camera gaze samples and calibration events | Calibration |
| Simulated gaze provider | Renderer | Maps pointer position to gaze for demos and tests | No product chrome |
| Gaze smoother and dwell selector | Renderer | Stabilizes gaze and commits continuous dwell selections | Progress feedback |
| Overlay layout | Renderer | Places cards from screen and active-window geometry | Cards and shelf |
| `StatusPanels` | Renderer | Renders context, setup, debug, confirmation, interruption, and recovery panels | State-specific panels |
| `SpeechPlayback` | Renderer | Queues synthesized speech and short local cues | Audio |
| Owl and perceived notch | Native helper + renderer proxy | Native panel owns visible pixels; renderer owns the zero-opacity gaze target and CSS fallback | Notch and owl |

## Test fixtures

The HTML files under `src/renderer/public/fixtures/` are controlled test
documents. They are not Hoot components and are not mounted by the product
overlay. `SIMULATE_GAZE=true` enables deterministic pointer-position samples;
it does not activate after a live camera failure and does not select a fake
application.

## Live calibration contract

`WebEyeTrackProvider` owns camera activation, target presentation, validation,
profile storage, and activation errors. The worker owns camera-frame inference.
Calibration fits a CPU-side affine correction on top of fixed neural-network
outputs; it does not update neural weights and does not use pointer positions as
gaze predictions.

The calibration contract is:

1. The worker serializes commands and accepts one distinct camera frame at a
   time. A reset acknowledgment separates consecutive targets.
2. Five targets contribute three finite predictions each across a fixation
   interval of at least 250 ms. The worker fits scale, offset, and cross-axis
   correction using the median prediction for each target.
3. Four held-out targets measure accuracy. Each check excludes 300 ms of
   settling time and measures 1,200 ms of predictions. A check passes with at
   least five valid frames and at least 70% of frames within normalized distance
   `0.25`.
4. Four passing checks permit a save. TensorFlow.js stores the network and
   `screenCalibration` metadata in the IndexedDB artifact `view-webeyetrack-v3`.
   The renderer stores camera identity/resolution and viewport dimensions/scale.
   `demo:calibrate` reuses a matching profile; `demo:recalibrate` replaces it
   after a successful run.
5. Missing frames, an underdetermined fit, worker errors, incompatible profiles,
   cancellation, and storage failures keep gaze disabled. Hoot does not switch
   providers or substitute pointer input after a camera failure.

Calibration logs contain a session ID, stage timings, frame counts, fit error,
and held-out RMSE and 95th-percentile error. They do not contain camera images
or individual gaze coordinates. A saved profile remains sensitive to seating,
lighting, camera placement, display scale, and viewport changes.

The implementation uses TensorFlow.js model metadata and model I/O documented in
the [TensorFlow.js API](https://js.tensorflow.org/api/latest/). The WebEyeTrack
verification script and Electron calibration tests exercise the worker seam,
profile storage, invalid fits, stream ownership, and UI error states.

## Overlay behavior

All Hoot-owned surfaces use the light-neutral tokens in
`src/renderer/styles.css`. The active application remains visible around those
surfaces. Hoot does not apply a theme to the underlying application.

The transparent renderer is click-through during passive and simulated
operation. Calibration accepts pointer input because its target dots require
clicks. Setup and calibration-error surfaces expose `Quit View`. The emergency
`CommandOrControl+Alt+Shift+V` shortcut remains independent from macOS Log Out
and shutdown controls.

## Context and recording

Context starts disabled during boot and passive gaze. Summoning the owl creates
an app-scoped session. An empty `CONTEXT_ALLOWED_APPS` value approves the
frontmost app at summon; `ALLOW SESSION` follows approved foreground changes.
A configured app name or bundle ID allowlist pre-approves matching apps.

The main process keeps one bounded `ContextSnapshot` with access state, session
ID, revision, active-window metadata, source statuses, and references. A
requested screenshot comes only from the approved window. A failed capture
returns an unavailable source and does not widen to a primary-display image.
The Accessibility source performs one bounded focused-element/value query.
Browser DOM and selection extraction are outside the product boundary.

`PAUSE` clears the in-memory screenshot and stops refreshes. Exit, stop, and
verified completion disable the session and clear app and reference data. The
prompt engine forwards active structured context and an optional approved image
to providers; paused and blocked snapshots forward no app content.

Computer-use screenshots use a separate display boundary. Normal live mode
protects the Electron overlay from external capture. With
`HOOTS_RECORDING_MODE=true`, the executor invokes
`native/ScreenCaptureHost.swift`, and ScreenCaptureKit excludes Hoots' Electron
and native-helper processes before returning one PNG. A missing helper,
permission failure, or unresolved exclusion list is an explicit error. There is
no unfiltered fallback.

## Notch and owl geometry

AppKit supplies the safe-area top inset and camera-gap edges. The native helper
uses that geometry for the black perceived notch and extends it behind the owl
artwork. The owl and notch share one gaze hit region. The renderer keeps a
zero-opacity DOM proxy for gaze selection and a CSS fallback for systems where
the helper is unavailable. The helper uses a compact top-center surface on a
display without a camera gap.

## Keyboard controls

Keyboard controls support deterministic demonstrations and recovery. They are
not the primary gaze input path.

| Key | Action |
| --- | --- |
| `N` | Summon from `PASSIVE`; interrupt execution when active. |
| `1`–`4` | Select quadrant A–D in semantic, confirmation, interruption, or recovery views. |
| `B` | Go back in composition. |
| `M` | Request more choices / record `NONE`. |
| `X` | Exit the semantic session or navigation mode. |
| `R` | Toggle reading mode while passive. |
| `F` | Toggle vertical-feed mode while passive. |
| `P` | Pause or resume the enabled context session. |
| `A` | Approve the blocked app for the enabled context session. |
| `Cmd/Ctrl+D` | Toggle the debug HUD. |
| `Esc` | Cancel active calibration. |
