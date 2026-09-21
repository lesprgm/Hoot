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

View starts from that base model. The adapter restores a locally saved affine model when the viewport signature matches; a user can force a new five-target training pass with `FORCE_CALIBRATION=true`. Every new calibration still runs four held-out accuracy checks before live gaze is enabled. Calibration metadata stays in the Electron user-data directory and is never sent to the decoder. The copied upstream bundle is unchanged.
