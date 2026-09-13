import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig, AppSettings } from "../shared/types";

function loadEnvFile(): Record<string, string> {
  const result: Record<string, string> = {};
  const candidates = [
    join(process.cwd(), ".env"),
    join(process.cwd(), "..", ".env"),
    join(process.cwd(), "..", "..", ".env"),
  ];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const raw = readFileSync(file, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
      result[key] = value;
    }
  }
  return result;
}

function envKey(set: Record<string, string>, key: string, fallback: string): string {
  // An explicit process environment value must override the local .env file.
  // E2E runs and packaged launchers use this to select fixture providers
  // without changing the user's local credentials or provider defaults.
  return process.env[key] ?? set[key] ?? fallback;
}

function envInt(set: Record<string, string>, key: string, fallback: number): number {
  const raw = envKey(set, key, String(fallback));
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envFloat(set: Record<string, string>, key: string, fallback: number): number {
  const raw = envKey(set, key, String(fallback));
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envBool(set: Record<string, string>, key: string, fallback: boolean): boolean {
  const raw = envKey(set, key, fallback ? "true" : "false").toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}

const env = loadEnvFile();
const decoderProvider = envKey(env, "DECODER_PROVIDER", "openai") as AppConfig["decoderProvider"];
const defaultDecoderModel = decoderProvider === "gemini" ? "gemini-3.5-flash-lite" : "gpt-5.6-luna";

export const config: AppConfig = {
  gazeProvider: (envKey(env, "GAZE_PROVIDER", "webeyetrack") as AppConfig["gazeProvider"]) ?? "webeyetrack",
  ttsProvider: (envKey(env, "TTS_PROVIDER", "macos") as AppConfig["ttsProvider"]) ?? "macos",
  elevenLabsVoiceId: envKey(env, "ELEVENLABS_VOICE_ID", ""),
  executorProvider: "openai",
  decoderProvider,
  executionMode: "live",
  simulateGaze: envBool(env, "SIMULATE_GAZE", false),
  forceCalibration: envBool(env, "FORCE_CALIBRATION", false),
  allowUnverifiedGaze: envBool(env, "ALLOW_UNVERIFIED_GAZE", false),
  debugHud: envBool(env, "DEBUG_HUD", false),
  settings: {
    gazeDwellMs: envInt(env, "GAZE_DWELL_MS", 550),
    agentSummonDwellMs: envInt(env, "AGENT_SUMMON_DWELL_MS", 900),
    noneDwellMs: envInt(env, "NONE_DWELL_MS", 700),
    cancelDwellMs: envInt(env, "CANCEL_DWELL_MS", 900),
    hintDwellMs: envInt(env, "HINT_DWELL_MS", 650),
    gazeEmaAlpha: envFloat(env, "GAZE_EMA_ALPHA", 0.28),
    autoScrollEnabled: envBool(env, "AUTO_SCROLL_ENABLED", true),
    prefetchEnabled: envBool(env, "PREFETCH_ENABLED", true),
    ttsPrefetchEnabled: envBool(env, "TTS_PREFETCH_ENABLED", true),
    speakOptionOnHover: envBool(env, "SPEAK_OPTION_ON_HOVER", false),
    reducedAnimation: envBool(env, "REDUCED_ANIMATION", false),
    gazeConfidenceMin: envFloat(env, "GAZE_CONFIDENCE_MIN", 0.5),
    duplicateThreshold: envFloat(env, "DUPLICATE_THRESHOLD", 0.82),
    decoderModel: envKey(env, "DECODER_MODEL", defaultDecoderModel),
    executorModel: envKey(env, "EXECUTOR_MODEL", "gpt-6-astra"),
    ttsModel: envKey(env, "ELEVENLABS_MODEL", "eleven_flash_v2_5"),
  },
  hasOpenAiKey: Boolean(envKey(env, "OPENAI_API_KEY", "")),
  hasGeminiKey: Boolean(envKey(env, "GEMINI_API_KEY", "")),
  hasElevenLabsKey: Boolean(envKey(env, "ELEVENLABS_API_KEY", "")),
  platform: String(process.platform),
};

export function apiKey(name: string): string {
  return process.env[name] ?? env[name] ?? "";
}
