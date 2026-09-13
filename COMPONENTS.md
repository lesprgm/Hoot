# View component contract

This file identifies the runtime components that belong to View and separates them from development infrastructure and the user's applications.

## What appears on screen

View is an accessibility overlay, not an application launcher. The product surface contains only the perceived notch and owl, temporary gaze choices, interaction status, calibration, and explicit text entry.

View never renders Article, Email, Vertical Feed, Shopping, Desktop, or similar application tabs. The context engine identifies the active macOS application and window. The layout engine uses that geometry to choose screen-corner or window-halo placement without asking the user to classify the application.

The current build does not implement Apple iPhone Mirroring integration. View does not discover a phone, launch a mirroring session, or use an iOS-side API. A narrow active window still receives the same generic window-halo layout because the geometry rule is independent of the application name.

## Runtime ownership

| Component | Process | Responsibility | User-visible |
| --- | --- | --- | --- |
| `ContextEngine` | Main | Reads the active application, window bounds, and screen context | No |
| `InteractionController` and `StateMachine` | Main | Own the interaction state and allowed transitions | Through overlay state |
| `PromptCompletionEngine` | Main | Produces semantic choices and clarification turns | Through semantic cards |
| Computer-use executor | Main | Performs confirmed desktop actions | Status only |
| TTS service | Main | Speaks prompts and confirmations | Audio |
| WebEyeTrack provider | Renderer | Produces live camera gaze samples | Calibration only |
| Simulated gaze provider | Renderer | Supplies deterministic pointer-position samples for tests | No product chrome |
| Gaze smoother and dwell selector | Renderer | Stabilize gaze and commit continuous dwell selections | Progress feedback |
| Overlay layout | Renderer | Places cards from actual active-window geometry | Yes |
| Dasher | Renderer iframe | Provides explicit arbitrary-text entry | Only when requested |
| Owl and perceived notch | Renderer | Provide the stable summon and interrupt target | Always while View runs |

## Development fixtures

The HTML files under `src/renderer/public/fixtures/` are test documents. They are not View components and must not be mounted by the product overlay. Tests may open them independently when a controlled document is required.

`SIMULATE_GAZE=true` enables pointer-position samples for automated testing. It does not select a fake application, render fixture tabs, or activate in response to a live-provider failure.

## Live calibration contract

`WebEyeTrackProvider` owns camera activation, target presentation, independent validation, and activation errors. The patched worker owns camera-frame inference and the calibration coordinate correction. Calibration never uses pointer positions as gaze predictions. Target clicks provide known target coordinates only.

1. The worker serializes commands and accepts one distinct camera frame at a time. A reset acknowledgment separates consecutive targets.
2. Each of five targets contributes three raw, finite predictions sampled across a fixation interval of at least 250 ms. The worker fits an affine coordinate correction (scale, offset, and cross-axis correction) using the median prediction per target. The fit runs on CPU and leaves neural weights unchanged.
3. Four held-out targets are used only to measure accuracy. Each check excludes 300 ms of settling time, then measures 1,200 ms of predictions. These waits are calibration measurement intervals, not live inference throttles. The unchanged pass criterion is at least five valid frames and at least 70% of all frames within a normalized Euclidean distance of 0.25 from the target.
4. Only four passing checks permit a save. TensorFlow.js stores the network and `screenCalibration` metadata in one IndexedDB model artifact (`view-webeyetrack-v3`). The renderer records camera identity/resolution and viewport dimensions/scale after the save acknowledgment. `demo:calibrate` reuses this complete profile; `demo:recalibrate` explicitly replaces it after a successful new calibration.
5. Missing frames, an underdetermined fit, worker errors, incompatible profiles, and storage failures keep gaze disabled. Cancellation removes pending callbacks and stops only the owning camera stream. The application never switches providers automatically or substitutes pointer input after a camera failure.

The previous batch path fitted a coordinate correction and then changed the neural network weights that supplied its inputs. That operation invalidated the fitted correction. The previous save path also omitted the correction and restored only weights. Patch `0009` replaces that path and rejects incomplete legacy profiles. The earlier trace proves successful frame collection and failed validation; it does not by itself measure which numerical defect caused each failed corner.

Calibration logs include a session ID, stage timings, frame counts, fit error, and held-out root mean square error (RMSE) and 95th-percentile error. Error distances use normalized screen coordinates. Logs do not include camera images or individual gaze coordinates. A saved profile remains sensitive to seating, lighting, and camera placement; the application does not claim permanent accuracy after those conditions change.

The implementation uses TensorFlow.js model metadata and model IO, documented in the [TensorFlow.js API](https://js.tensorflow.org/api/latest/). `scripts/test-webeyetrack.cjs` tests the actual patched source and bundled model, including distorted inputs, independent targets, invalid fits, complete restore, and stream ownership. Electron tests separately exercise the calibration UI with a test-only worker dependency.

## Overlay behavior

All View-owned surfaces use the same light-neutral tokens from `src/renderer/styles.css`. The user's active application remains visible around those surfaces. View does not apply a theme to the underlying application.

The full-screen transparent renderer is click-through during passive and simulated operation. Calibration temporarily accepts input because its targets require clicks. Setup and calibration-error surfaces provide a visible Quit View action. `CommandOrControl+Alt+Shift+V` is the independent emergency quit shortcut; it is deliberately separate from macOS Log Out.

The overlay uses a floating window level. It must never use the `screen-saver` level because that level can cover macOS shutdown, Force Quit, and other system safety surfaces.

## Notch and owl geometry

AppKit supplies the safe-area top inset and the left and right edges of the camera gap. The perceived notch uses that exact width. It extends behind the current owl artwork and ends two pixels below the owl's visible frame.

The notch and owl share one gaze hit region. The perceived notch extends 62 px below the measured top inset so its black background covers the ring and owl art with a lower overlap margin. On a display without a camera gap, the owl uses a compact top-center hit region and no artificial notch is rendered.

## Resolved overlay defects

- Development fixture tabs previously appeared to be product applications.
- Simulated gaze emitted only on mouse movement, so a stationary dwell could not finish.
- Dwell progress used the last sample timestamp, producing stalled feedback between samples.
- The renderer knew only the notch center and height, so it could not draw a correctly sized perceived notch.
- The full-screen overlay used the `screen-saver` level and could intercept the desktop while covering system dialogs.
- The idle and working sprite loops took 11 and 4.8 seconds. The current artwork is retained with faster playback and a short reaction.
