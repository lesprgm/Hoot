#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

if (process.platform !== "darwin") {
  console.log("Skipping the native notch and ScreenCaptureKit hosts outside macOS.");
  process.exit(0);
}

const root = resolve(import.meta.dirname, "..");
const notchSource = resolve(root, "native/NotchHost.swift");
const notchOutput = resolve(root, "native/ViewNotchHost");
const captureSource = resolve(root, "native/ScreenCaptureHost.swift");
const captureOutput = resolve(root, "native/ViewScreenCaptureHost");

await mkdir(dirname(notchOutput), { recursive: true });
await execFileAsync(
  "swiftc",
  ["-parse-as-library", "-swift-version", "5", "-O", notchSource, "-o", notchOutput, "-framework", "AppKit", "-framework", "CoreGraphics"],
  { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 },
);
console.log(`Built ${notchOutput}`);

await execFileAsync(
  "swiftc",
  ["-parse-as-library", "-swift-version", "5", "-O", captureSource, "-o", captureOutput, "-framework", "ScreenCaptureKit", "-framework", "CoreGraphics", "-framework", "ImageIO"],
  { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 },
);
console.log(`Built ${captureOutput}`);
