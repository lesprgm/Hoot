# Verification and runtime limits

This document describes the checks that validate Hoot's local seams and the
conditions that require a supervised macOS run. Automated checks do not claim
camera accuracy, paid-provider latency, or a live desktop task.

## Runtime seams

| Area | Behavior | Default |
| --- | --- | --- |
| Selection and publication | Versioned selection envelopes, atomic interaction snapshots, and stale/duplicate rejection | Enabled |
| Decoder work | One coordinated request, abort/deadline propagation, strict provider errors, complete OpenRouter SSE checks, and explicit direct-Gemini transport fallback | `DECODER_FALLBACK_PROVIDER=none` |
| Context | Session-scoped active-window metadata, bounded window capture, one Accessibility focused-element query, reference checks, and pause/clear behavior | Enabled after summon |
| Task state | In-memory accepted task state, revision-aware context observations, host-owned task actions, and reference revalidation | `TASK_AWARE_CARDS=false` |
| Astra Computer Use | HTTP Responses request/action loop with failed and incomplete response handling | Enabled for live execution |
| Recording split | Opt-in overlay exposure plus fail-closed ScreenCaptureKit capture that excludes Hoots processes | `HOOTS_RECORDING_MODE=false` |

The decoder composition path separates typed intent from display wording.
`IntentFrame`, `ContextLedger`, `TargetResolver`, `CandidateRanker`, and
`TaskCompiler` have focused unit coverage in the regular test suite.

## Repository checks

These commands validate the checked-in source:

```sh
npm run typecheck
npm test
npm run build
npm run test:e2e
git diff --check
```

The suite contains 23 unit-test files with 129 tests. The Electron end-to-end
suite contains 12 tests. The build compiles the main process, preload, renderer,
notch helper, and filtered ScreenCaptureKit helper.

## Runtime limits

`DecoderRequestCoordinator` enforces the configured interaction deadline,
cancels obsolete work, and prevents stale responses from publishing cards.
Hoot does not collect or persist interaction telemetry.

`TASK_AWARE_CARDS=true` enables in-session task state for a supervised run:

```sh
TASK_AWARE_CARDS=true npm run agent:live
```

## Conditions outside automated checks

- Paid OpenAI, Gemini, and OpenRouter latency, token usage, and outage behavior require network access and provider credentials.
- Physical gaze accuracy and dwell timing require a real camera, stable seating, lighting, display scale, and macOS permissions.
- Live Astra Computer Use requires a harmless supervised task and an `OPENAI_API_KEY`.
- Full-display recording requires `HOOTS_RECORDING_MODE=true`, a ScreenCaptureKit helper, Screen Recording permission, and a recorder configured for the full display.
- Browser DOM extraction and editor-specific object adapters remain outside the context boundary.

These conditions remain explicit verification boundaries. Hoot does not respond
to them by switching models, enabling simulated gaze, repairing invalid cards,
or performing an unconfirmed desktop action.
