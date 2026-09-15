#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

if (process.platform !== "darwin") {
  console.log("Skipping the native notch host outside macOS.");
  process.exit(0);
}

const root = resolve(import.meta.dirname, "..");
const source = resolve(root, "native/NotchHost.swift");
const output = resolve(root, "native/ViewNotchHost");

await mkdir(dirname(output), { recursive: true });
await execFileAsync(
  "swiftc",
  ["-parse-as-library", "-swift-version", "5", "-O", source, "-o", output, "-framework", "AppKit", "-framework", "CoreGraphics"],
  { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 },
);
console.log(`Built ${output}`);
