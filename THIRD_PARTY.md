# Third-party notices

## Google Gen AI JavaScript SDK

The optional Gemini decoder uses `@google/genai` from npm and the Gemini API. The SDK is distributed under the Apache License 2.0; the package includes its complete license and notice files under `node_modules/@google/genai/` after `npm install`.

## WebEyeTrack

The primary gaze provider uses a reproducible vendored build instead of the unpatched npm package.

- Upstream: <https://github.com/RedForestAI/WebEyeTrack>
- Upstream commit: `14719ad861467c98890058f7c41a94638ae1db2b`
- License: MIT
- Integration reference: <https://github.com/kiante-fernandez/otree-et>
- Integration-reference commit inspected: `c09a815c44001337709948442c12688535156c57`
- Patch sources: `vendor/webeyetrack/patches/`
- Rebuild and byte comparison: `npm run verify:webeyetrack`

The five copied `otree-et` patches repair the upstream library build and add configurable local model paths, explicit calibration, calibration persistence, initialization/error callbacks, incidental-click control, and deterministic cleanup. The resulting bundle is stored in `src/renderer/public/webeyetrack/`. The WebEyeTrack gaze model and MediaPipe runtime/model files are copied from the same `otree-et` integration so live tracking does not fetch runtime assets from third-party hosts.

View currently starts from that base model and requires fresh nine-point calibration plus four held-out accuracy checks on every launch. The adapter does not restore or save calibration: an existing model alone cannot establish accuracy for the current user, camera, seating position, resolution, or display scale. Previously stored models remain on disk but are ignored. The copied upstream bundle is unchanged.

## RealEye Webcam EyeTracker Light Open

The fallback provider uses `@realeye-io/webcam-eyetracker-light-open@1.1.0` and follows the repository's 17-point calibration and same-frame prediction flow.

- Upstream: <https://github.com/RealEye-io/webcam-eyetracker-light-open>
- Repository commit inspected: `d94850fa01f50087d5e51d24d741bc78f61ded64`
- License: AGPL-3.0-or-later or a RealEye commercial license; see the package license files for the applicable terms.

`scripts/sync-realeye-assets.mjs` copies RealEye's MediaPipe WASM runtime from the installed `@mediapipe/tasks-vision` package to `src/renderer/public/realeye/wasm/` before development and production builds. Its JavaScript and WASM therefore come from the same lockfile-resolved version (currently 0.10.35, Apache-2.0), separately from WebEyeTrack's pinned 0.10.3 runtime. View also checks face availability at each calibration target and validates four held-out targets before enabling RealEye gaze.

## Dasher Web

This repository includes the Dasher Web JavaScript and WebAssembly distribution under `src/renderer/public/dasher/`.

- Project: <https://github.com/dasher-project/dasher-web>
- License: GNU General Public License, version 2 or later
- Upstream license copy: `src/renderer/public/dasher/LICENSE`

The bundled files provide the actual Dasher text-entry engine. They are not a mock implementation.
