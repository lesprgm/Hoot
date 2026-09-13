#!/usr/bin/env bash
#
# Build the vendored WebEyeTrack bundle from pinned upstream source plus our
# patch series, and install it at src/renderer/public/webeyetrack/webeyetrack.js.
#
#   bash scripts/build-webeyetrack.sh           build and install
#   bash scripts/build-webeyetrack.sh --check   build and verify the checked-in bundle
#                                        matches, without touching it
#
# Why a patch series rather than a fork
# -------------------------------------
# View needs explicit calibration, local model assets, complete profile
# persistence, ordered frame processing, and errors that reach the renderer.
# Patch 0009 keeps the network fixed and fits a CPU coordinate correction;
# earlier patches preserve the history of the integration. Updating means
# bumping REF in vendor/webeyetrack/UPSTREAM and re-running this script. If
# upstream moves patched code, `git apply` fails explicitly.
#
# Upstream's build is byte-for-byte reproducible from its package-lock.json, so
# --check is a real supply-chain assertion: the committed bundle is exactly what
# this pinned source and these patches produce, and nothing else.
#
# Requires: node, npm, curl, tar, git.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR_DIR="$REPO_ROOT/vendor/webeyetrack"
PATCH_DIR="$VENDOR_DIR/patches"
DEST_DIR="$REPO_ROOT/src/renderer/public/webeyetrack"
DEST="$DEST_DIR/webeyetrack.js"

CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

# shellcheck disable=SC1091
REPO="$(sed -n 's/^REPO=//p' "$VENDOR_DIR/UPSTREAM")"
REF="$(sed -n 's/^REF=//p' "$VENDOR_DIR/UPSTREAM")"
test -n "$REPO" && test -n "$REF" || { echo "error: REPO/REF missing from $VENDOR_DIR/UPSTREAM" >&2; exit 1; }

for cmd in node npm curl tar git; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "error: '$cmd' is required" >&2; exit 1; }
done

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Fetching ${REPO} @ ${REF}"
curl -fsSL "${REPO/github.com/codeload.github.com}/tar.gz/${REF}" -o "$TMP/src.tgz"
mkdir -p "$TMP/src"
tar xzf "$TMP/src.tgz" -C "$TMP/src" --strip-components=1

JS="$TMP/src/js"
test -d "$JS/src" || { echo "error: js/src missing -- upstream layout changed" >&2; exit 1; }

echo "Applying patch series"
for patch in "$PATCH_DIR"/*.patch; do
  name="$(basename "$patch")"
  if ! git -C "$JS" apply --check "$patch" 2>/dev/null; then
    echo "error: ${name} does not apply to ${REF}." >&2
    echo "       Upstream moved the code this patch touches. Re-roll it against" >&2
    echo "       the new source, then bump REF in vendor/webeyetrack/UPSTREAM." >&2
    exit 1
  fi
  git -C "$JS" apply "$patch"
  echo "  applied ${name}"
done

echo "Installing build dependencies (--ignore-scripts skips 'canvas', a jest-only native dep)"
npm --prefix "$JS" ci --ignore-scripts --no-audit --no-fund >/dev/null 2>&1

echo "Testing calibration math, persistence, and camera teardown"
node "$REPO_ROOT/scripts/test-webeyetrack.cjs" "$JS"

echo "Building"
( cd "$JS" && npx webpack --config webpack.config.js >/dev/null 2>&1 )
BUILT="$JS/dist/index.js"
test -f "$BUILT" || { echo "error: webpack produced no dist/index.js" >&2; exit 1; }

# The bundle must expose the API our tracker depends on. A silent upstream
# rename would otherwise ship a bundle that fails only in a participant's
# browser, mid-study.
for symbol in 'type:"calibrate"' 'type:"applyCalibration"' 'type:"error"' 'screenCalibration' 'setAdaptOnClick' 'indexeddb://' 'type:"ready"'; do
  if ! grep -q "$symbol" "$BUILT"; then
    echo "error: built bundle is missing '${symbol}'. The patches applied but did not take effect." >&2
    exit 1
  fi
done
node --check "$BUILT"
echo "  built $(wc -c < "$BUILT" | tr -d ' ') bytes; API symbols present; parses"

if [ "$CHECK_ONLY" -eq 1 ]; then
  if cmp -s "$BUILT" "$DEST"; then
    echo "OK: ${DEST#"$REPO_ROOT"/} is exactly what ${REF} + patches produce."
    exit 0
  fi
  echo "MISMATCH: ${DEST#"$REPO_ROOT"/} differs from a fresh build." >&2
    echo "          Run bash scripts/build-webeyetrack.sh to regenerate it." >&2
  exit 1
fi

mkdir -p "$DEST_DIR"
cp "$BUILT" "$DEST"
cp "$TMP/src/LICENSE" "$DEST_DIR/LICENSE"
cp "$JS/dist/index.js.LICENSE.txt" "$DEST_DIR/THIRD_PARTY_LICENSES.txt"

cat > "$DEST_DIR/VENDOR.md" <<EOF
# Vendored WebEyeTrack

Do not edit \`webeyetrack.js\` by hand. It is a build artifact.

- Source: ${REPO} (MIT)
- Pinned at: \`${REF}\`
- Patches: \`vendor/webeyetrack/patches/\` at the project root
- Rebuild: \`bash scripts/build-webeyetrack.sh\`
- Verify: \`npm run verify:webeyetrack\`

## Why we patch upstream

The patch series adds local assets, explicit calibration commands, errors,
camera teardown, ordered frame processing, and complete profile persistence.
View disables incidental click adaptation and does not switch to simulated
gaze when a live provider fails.

Patch 0009 supersedes the earlier neural adaptation path. It fits a CPU affine
coordinate correction from raw predictions at five targets and keeps the
network fixed. The old path changed neural weights after fitting the map,
invalidating that map. The old save path also omitted the map.

The network and versioned \`screenCalibration\` metadata now share one TF.js
IndexedDB model artifact. A requested but incomplete stored profile fails
explicitly. Only independent accuracy checks in the renderer authorize saving.
The renderer additionally checks camera and display compatibility on reuse.

Before bundling, \`scripts/test-webeyetrack.cjs\` tests the patched source,
held-out numerical predictions, invalid fits, actual bundled neural model
save/restore, and camera-stream ownership. It does not certify physical gaze
accuracy. See \`COMPONENTS.md\` at the project root for the complete contract.

## Updating

1. Bump \`REF\` in \`vendor/webeyetrack/UPSTREAM\`.
2. Run \`bash scripts/build-webeyetrack.sh\`. If a patch no longer applies, the script
   stops and names it.
3. Commit the regenerated \`webeyetrack.js\` together with the patch changes.

Upstream's build is reproducible from its \`package-lock.json\`; an unpatched
build of \`${REF}\` is byte-identical to the published \`webeyetrack@0.0.2\`
npm artifact. \`--check\` relies on that.
EOF

echo
echo "Installed:"
ls -la "$DEST_DIR" | awk 'NR>3 {printf "  %-28s %10s bytes\n", $9, $5}'
