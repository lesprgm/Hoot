# Owl sprite sources

These are the two source sheets supplied in the user's Downloads folder on
2026-09-12. `scripts/build-owl-sprites.mjs` removes the connected white sheet
background, extracts all eight illustrated frames from each sheet, and writes
the runtime PNG strips under `src/renderer/public/sprites/`.

- `idle-source.jpg` -> `owl-idle.png`
- `thinking-source.jpg` -> `owl-working.png`

The source files are retained so the runtime assets can be regenerated without
depending on a particular Downloads directory.
