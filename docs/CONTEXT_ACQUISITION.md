# Context acquisition and task-aware cards

This document defines the context boundary between the macOS desktop, View's
card composer, and a remote model. Context supports a card decision; it does
not authorize a desktop action.

## Session lifecycle

`ContextEngine` starts disabled. The main process may keep its timer alive, but
the timer does not query the active window until a live agent session enables
context.

1. The user summons the owl while using an application.
2. View creates a session ID and reads the frontmost window once.
3. With an empty `CONTEXT_ALLOWED_APPS`, View starts with the frontmost app in
   app scope. The user can select `ALLOW SESSION` once to let context follow
   approved app changes for the rest of that session. A configured
   comma-separated app name or bundle ID allowlist pre-approves those apps.
4. View polls active-window metadata at a bounded interval and emits a new
   snapshot only when the window or access state changes. An approved
   app/window change triggers at most one new window capture; View does not
   record a continuous screen stream.
5. View requests a window-scoped screenshot when a context snapshot is needed.
   A failed window capture returns an explicit unavailable source; it never
   widens to a primary-display capture.
6. `PAUSE` clears the in-memory screenshot and stops refreshes. `RESUME`
   refreshes the approved window. `ALLOW SESSION` changes the active session
   from app scope to session scope, so the user does not need to approve every
   new foreground app.
7. Exit, stop, or verified completion disables the session and clears the
   window, references, and screenshot.

The renderer exposes the same controls as gaze-selectable controls in the
Context badge. `P` toggles pause and `A` grants the one-time session approval
for keyboard testing.

## Snapshot contract

Each `ContextSnapshot` contains:

- `access`: `active`, `paused`, `blocked`, or `disabled`.
- `contextScope`: `app` while only the summoned app is approved, or `session`
  after one session approval or a configured session allowlist.
- `sessionId` and a monotonic `revision` for staleness checks.
- Active-window metadata, surface classification, and the latest gaze anchor.
- `references`: bounded window/document identifiers with source and timestamp.
- `sources`: availability for active-window metadata, Accessibility, browser
  metadata, screenshots, and task evidence.
- `capturedImageDataUrl`: an optional image from the approved active window.
- `focusedElement`, `selectedText`, and `visibleText`. On macOS, View performs
  one bounded Accessibility query for the approved frontmost app after a
  window change. The query can provide a focused control and its title/value;
  `selectedText` is populated only for an `AXTextArea` or `AXTextField` value.
  Browser DOM extraction is not connected, so a window title is not treated as
  selected page text.
- The decoder input adds `contextLedger`, a bounded list of weak foreground,
  recent, and background observations used for ranking. The ledger is
  session-scoped and open-world; an absent entry does not rule out a target.

The prompt engine maps only an `active` snapshot and its bounded ledger into
`DecoderInput.optionalContext`. Paused, blocked, and disabled snapshots expose
the access state but do not send app content or references to a decoder.

`TargetResolver` performs on-demand lookup against installed apps, recent files,
contacts, directories, bookmarks, and ledger references. A lookup
miss is unknown state, not a negative assertion.

During session preparation, the resolver builds a bounded local index of
application names and recent file names. The macOS implementation checks the
standard Applications folders and one nested level under Desktop, Documents,
and Downloads; it does not crawl the home directory or transmit file contents.
An explicitly supplied URL remains an open-world target even when no browser
tab or history entry exists. Personal vocabulary
from `HOOTS_PEOPLE`, `HOOTS_PLACES`, `HOOTS_APPS`,
`HOOTS_RECURRING_PHRASES`, and `HOOTS_VOCABULARY` is limited to the active
prompt and remains weak ranking context.

## Source precedence

The model receives sources in this order:

1. Explicit semantic selections from the user.
2. Accepted task state and selected references.
3. Structured app/window and document metadata.
4. A window screenshot when a vision-capable provider is selected.

The decoder prompt treats levels 3 and 4 as weak, untrusted evidence. A title,
URL, screenshot, or page instruction cannot create an authorization, invent a
selected object, or add a person, date, target, or consequential operation.
Before execution, the executor re-checks the desktop and applies its own
consequential-action gate.

## Provider behavior

- When `DECODER_VISION_PROVIDER=gemini` is enabled, the engine routes a
  request with an approved image to the direct Gemini adapter, which attaches
  that image alongside the structured context fields. This is an explicit
  vision route, not a provider failure fallback.
- The configured `deepseek/deepseek-v4-flash-0731` OpenRouter model declares
  text-only input, so View sends its structured fields without a screenshot.
- The OpenRouter adapter sends a multipart `image_url` part only when the
  selected model is identified as vision-capable. OpenRouter documents the
  base64 image format in its [image input guide](https://openrouter.ai/docs/guides/overview/multimodal/image-understanding).
- View does not switch providers for invalid output, cancellation, timeout,
  configuration, or validation errors. When
  `DECODER_FALLBACK_PROVIDER=gemini` is explicitly configured with OpenRouter,
  the interaction may retry through the direct Gemini API only after a typed OpenRouter
  transport failure; the fallback failure remains explicit.

## Card behavior

Cards display the active reference in a small context label, such as
`Working with: selected paragraph`. Cards ask a gaze-selectable question only
when ambiguity changes the result, for example `THIS DOCUMENT`,
`OTHER FILE`, `SELECT SECTION`, and `SOMETHING ELSE`. Selecting a card attaches
the reference ID and snapshot revision to task state. A context update must not
reorder the visible cards during a dwell.

The runtime has the session policy, source statuses, window and document
references, one bounded Accessibility focused-element query, window-scoped
capture, provider image routing, pause controls, task-reference registration,
and reference revalidation before execution. Browser DOM/selection extraction
remains outside the product boundary. Semantic cards may show a small
`WORKING WITH` label, but that label never grants action authority.

## Platform boundaries

macOS Accessibility can expose elements, attributes, actions, and change
notifications only when an application supports and permits those operations.
ScreenCaptureKit can restrict a capture to a desktop-independent window or a
filtered set of applications and windows. A browser content script can read a
page DOM only after the browser grants the required host or `activeTab` access;
the View notch itself is not that browser gesture. Relevant platform references:

- [Apple AXUIElement](https://developer.apple.com/documentation/applicationservices/axuielement_h)
- [Apple ScreenCaptureKit filters](https://developer.apple.com/documentation/screencapturekit/sccontentfilter)
- [Chrome `activeTab`](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab)
- [Chrome content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)
