# Vendored WebEyeTrack

Do not edit `webeyetrack.js` by hand. It is a build artifact.

- Source: https://github.com/RedForestAI/WebEyeTrack (MIT)
- Pinned at: `14719ad861467c98890058f7c41a94638ae1db2b`
- Patches: `vendor/webeyetrack/patches/` at the project root
- Rebuild: `bash scripts/build-webeyetrack.sh`
- Verify: `npm run verify:webeyetrack`

## Why we patch upstream

The patch series adds local assets, explicit calibration commands, errors,
camera teardown, ordered frame processing, and complete profile persistence.
View disables incidental click adaptation and does not switch to simulated
gaze when a live provider fails.

Patch 0009 supersedes the earlier neural adaptation path. It fits a CPU affine
coordinate correction from raw predictions at five targets and keeps the
network fixed. The old path changed neural weights after fitting the map,
invalidating that map. The old save path also omitted the map.

The network and versioned `screenCalibration` metadata now share one TF.js
IndexedDB model artifact. A requested but incomplete stored profile fails
explicitly. Only independent accuracy checks in the renderer authorize saving.
The renderer additionally checks camera and display compatibility on reuse.

Before bundling, `scripts/test-webeyetrack.cjs` tests the patched source,
held-out numerical predictions, invalid fits, actual bundled neural model
save/restore, and camera-stream ownership. It does not certify physical gaze
accuracy. See `COMPONENTS.md` at the project root for the complete contract.

## Updating

1. Bump `REF` in `vendor/webeyetrack/UPSTREAM`.
2. Run `bash scripts/build-webeyetrack.sh`. If a patch no longer applies, the script
   stops and names it.
3. Commit the regenerated `webeyetrack.js` together with the patch changes.

Upstream's build is reproducible from its `package-lock.json`; an unpatched
build of `14719ad861467c98890058f7c41a94638ae1db2b` is byte-identical to the published `webeyetrack@0.0.2`
npm artifact. `--check` relies on that.
