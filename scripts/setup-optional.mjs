#!/usr/bin/env node
// Best-effort installer for optional native/heavy providers.
// Failures are reported by setup. Runtime only uses simulation when the user
// explicitly chooses demo mode.
const { execFileSync } = require("node:child_process");

const optional = [
  "@realeye-io/webcam-eyetracker-light-open",
  "get-windows",
  "@nut-tree-fork/nut-js",
  "sharp",
  "@huggingface/transformers",
  "openai",
  "elevenlabs",
];

for (const pkg of optional) {
  try {
    console.log(`installing ${pkg} …`);
    execFileSync("npm", ["install", "--save-optional", pkg], { timeout: 600_000 });
    console.log(`  ok`);
  } catch (err) {
    console.log(`  skipped (${typeof err === "object" && err ? (err.message || "error") : err})`);
  }
}

try {
  execFileSync("npm", ["run", "verify:webeyetrack"], { timeout: 120_000, stdio: "inherit" });
} catch {
  console.log("The vendored WebEyeTrack verification failed. Run npm run verify:webeyetrack for details.");
}
console.log("Optional dependency setup finished.");
