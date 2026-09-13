import { createRequire } from "node:module";
import { dirname, resolve, join } from "node:path";
import { cpSync, mkdirSync, readdirSync, readFileSync } from "node:fs";

// Copy the runtime from the same installed package that RealEye imports.
// WebEyeTrack keeps its own pinned 0.10.3 assets unchanged.
const require = createRequire(import.meta.url);
const packageRoot = dirname(require.resolve("@mediapipe/tasks-vision"));
const { version } = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const source = join(packageRoot, "wasm");
const destination = resolve(import.meta.dirname, "../src/renderer/public/realeye/wasm");
mkdirSync(destination, { recursive: true });
for (const file of readdirSync(source)) {
  if (/\.(js|wasm)$/.test(file)) cpSync(join(source, file), join(destination, file));
}
console.log(`RealEye uses the installed MediaPipe ${version} JavaScript and WASM pair.`);
