# View architecture

View is an Electron application with a privileged main process and a browser renderer. The renderer owns gaze acquisition, smoothing, dwell hit testing, the overlay, Dasher, and fixture pages. The main process owns active-window discovery, screen capture, permissions, text-to-speech, stateful session orchestration, and computer execution. The preload bridge exposes the allow-listed IPC operations in `src/shared/ipc.ts`.

The user-visible component and overlay boundary is summarized in the [README](./README.md#what-runs-on-screen). Fixture pages are standalone test inputs and are not mounted by the product overlay.

The current build has no iPhone Mirroring integration. Active-window discovery and capture remain generic macOS operations; a narrow window can use the generic halo layout without adding phone-specific behavior.

## Runtime flow

1. `src/main/index.ts` creates `InteractionController`, starts `ContextEngine` polling, and registers IPC handlers.
2. `src/renderer/app/App.tsx` starts the configured gaze provider, smooths samples, and converts dwell commits into bridge calls.
3. `InteractionController` drives `StateMachine`, `PromptCompletionEngine`, TTS, and the live `OpenAIComputerUseExecutor`.
4. Main-process events are broadcast as `ViewMessage` values. `applyMessage` reduces those messages into renderer `ViewState`.

## Navigation modes

`src/renderer/navigation/NavigationController.ts` implements explicit, stateful low-level navigation. Reading mode uses a 15% top edge and 22% bottom edge, with 700/650 ms dwell, 320 px steps, and a 550 ms cooldown. Vertical-feed mode uses 18%/18% edges, 600 ms dwell, one 720 px item step, and the same cooldown. Center gaze and invalid samples reset dwell. The notch/sprite remains handled by the higher-priority overlay hit region.

The `R` key toggles reading mode and the `F` key toggles vertical-feed mode while passive. The main process moves the pointer to the current active-window anchor and sends a generic nut.js scroll. Tests exercise navigation logic independently from the product overlay. No app-specific or phone-side API is used.

## Safety boundaries

Semantic confirmation precedes execution. The executor requests a second confirmation before consequential actions. Navigation is disabled while semantic, confirmation, execution, or recovery cards are active. The live scroll handler ignores anchors outside the active window and reports unavailable optional input support instead of failing silently.

## Providers and configuration

`.env` controls `GAZE_PROVIDER`, `DECODER_PROVIDER`, the OpenAI executor model, TTS, dwell timings, and feature flags. Deterministic fixture providers support CI and demo use without camera or decoder API credentials. Desktop execution remains live-only and requires `OPENAI_API_KEY`. Optional dependencies provide WebEyeTrack, RealEye, OpenAI, Gemini, nut.js, and ElevenLabs integrations.

### LLM provider seams

`DecoderProvider` in `src/main/prompt-completion/CandidateGenerator.ts` is the preferred fast-model seam. `GeminiFlashLiteProvider` implements that seam in `src/main/prompt-completion/GeminiFlashLiteProvider.ts` with the `@google/genai` Interactions API and structured `response_format` JSON. The adapter returns the existing `DecoderResponse` shape, and `PromptCompletionEngine` requires one locally valid set of exactly four Gemini candidates. The Gemini path does not issue a repair request or substitute generic candidates; configuration and response errors stop the interaction explicitly. Set `DECODER_PROVIDER=gemini`, `GEMINI_API_KEY`, and `DECODER_MODEL=gemini-3.5-flash-lite` to enable it in live mode; fixture mode remains available when explicitly selected for the demo and CI.

`ExecutorProvider` in `src/main/executor/ExecutorProvider.ts` exposes the live OpenAI Computer Use implementation. Gemini Computer Use has a different screenshot/action loop and safety-decision payload, so it requires an explicit adapter that maps actions and confirmations; it is not part of this Gemini decoder change. When the OpenAI key is unavailable, the controller enters recovery instead of simulating desktop actions. `TTSProvider` is a compatible extension point. `SemanticEmbeddingProvider` is an optional local candidate-diversity optimization, not a decoder dependency; Gemini decoding works without embeddings, and this repository has no Gemini TTS or execution implementation.

Research sources for those adapters are the [Gemini model catalog](https://ai.google.dev/gemini-api/docs/models), [JavaScript SDK guide](https://ai.google.dev/gemini-api/docs/get-started), [structured-output guide](https://ai.google.dev/gemini-api/docs/structured-output), [Computer Use guide](https://ai.google.dev/gemini-api/docs/computer-use), [embeddings guide](https://ai.google.dev/gemini-api/docs/embeddings), and [TTS guide](https://ai.google.dev/gemini-api/docs/speech-generation). The implementation should follow those current API shapes and retain the local validator and explicit safety gates.

## Validation

Run `npm run typecheck`, `npm test`, `npm run build`, and `npm run test:e2e`. E2E requires the packaged Electron runtime and validates summon/Dasher, article/feed navigation, and correction/recovery. Live gaze, live Gemini/OpenAI decoding, and live OpenAI execution additionally require macOS permissions and credentials.
