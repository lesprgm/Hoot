import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig, UserLexicon } from "../shared/types";

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

function hasEnvValue(set: Record<string, string>, key: string): boolean {
  return envKey(set, key, "").trim().length > 0;
}

function envList(set: Record<string, string>, key: string): string[] {
  return envKey(set, key, "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function parseDecoderProvider(value: string): AppConfig["decoderProvider"] {
  const normalized = value.trim().toLowerCase();
  if (normalized === "gemini" || normalized === "openrouter" || normalized === "fixture") return normalized;
  throw new Error(`Unsupported DECODER_PROVIDER "${value}". Use openrouter, gemini, or fixture.`);
}

function parseDecoderFallbackProvider(value: string, primary: AppConfig["decoderProvider"]): AppConfig["decoderFallbackProvider"] {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === "none") return null;
  if (normalized === "gemini" && primary === "openrouter") return "gemini";
  throw new Error("DECODER_FALLBACK_PROVIDER=gemini selects the direct Gemini API and is valid only with DECODER_PROVIDER=openrouter.");
}

function parseVisionDecoderProvider(value: string): NonNullable<AppConfig["settings"]["visionDecoderProvider"]> {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === "none") return "none";
  if (normalized === "gemini") return "gemini";
  throw new Error(`Unsupported DECODER_VISION_PROVIDER "${value}". Use none or gemini.`);
}

function parseGazeProvider(value: string): AppConfig["gazeProvider"] {
  const normalized = value.trim().toLowerCase();
  if (normalized === "webeyetrack" || normalized === "simulated") return normalized;
  throw new Error(`Unsupported GAZE_PROVIDER "${value}". Use webeyetrack or simulated.`);
}

const env = loadEnvFile();
const decoderProvider = parseDecoderProvider(envKey(env, "DECODER_PROVIDER", "openrouter"));
const decoderFallbackProvider = parseDecoderFallbackProvider(envKey(env, "DECODER_FALLBACK_PROVIDER", ""), decoderProvider);
const visionDecoderProvider = parseVisionDecoderProvider(envKey(env, "DECODER_VISION_PROVIDER", "none"));
const defaultDecoderModel = decoderProvider === "gemini"
  ? "gemini-3.5-flash-lite"
  : "deepseek/deepseek-v4-flash-0731";

export const config: AppConfig = {
  gazeProvider: parseGazeProvider(envKey(env, "GAZE_PROVIDER", "webeyetrack")),
  ttsProvider: (envKey(env, "TTS_PROVIDER", "macos") as AppConfig["ttsProvider"]) ?? "macos",
  elevenLabsVoiceId: envKey(env, "ELEVENLABS_VOICE_ID", ""),
  executorProvider: "openai",
  decoderProvider,
  decoderFallbackProvider,
  executionMode: "live",
  simulateGaze: envBool(env, "SIMULATE_GAZE", false),
  forceCalibration: envBool(env, "FORCE_CALIBRATION", false),
  allowUnverifiedGaze: envBool(env, "ALLOW_UNVERIFIED_GAZE", false),
  contextAllowedApps: envList(env, "CONTEXT_ALLOWED_APPS"),
  debugHud: envBool(env, "DEBUG_HUD", false),
  settings: {
    gazeDwellMs: envInt(env, "GAZE_DWELL_MS", 1500),
    agentSummonDwellMs: envInt(env, "AGENT_SUMMON_DWELL_MS", 900),
    noneDwellMs: envInt(env, "NONE_DWELL_MS", 700),
    cancelDwellMs: envInt(env, "CANCEL_DWELL_MS", 900),
    gazeEmaAlpha: envFloat(env, "GAZE_EMA_ALPHA", 0.28),
    prefetchEnabled: envBool(env, "PREFETCH_ENABLED", true),
    reducedAnimation: envBool(env, "REDUCED_ANIMATION", false),
    decoderModel: envKey(env, "DECODER_MODEL", defaultDecoderModel),
    geminiDecoderModel: envKey(env, "GEMINI_DECODER_MODEL", "gemini-3.5-flash-lite"),
    visionDecoderProvider,
    executorModel: envKey(env, "EXECUTOR_MODEL", "gpt-6-astra"),
    ttsModel: envKey(env, "ELEVENLABS_MODEL", "eleven_flash_v2_5"),
    // This profile keeps Flash speech expressive without trading away its
    // low-latency behavior. Each value remains environment-tunable for a
    // particular voice recording.
    ttsStability: envFloat(env, "ELEVENLABS_STABILITY", 0.46),
    ttsSimilarityBoost: envFloat(env, "ELEVENLABS_SIMILARITY_BOOST", 0.80),
    ttsStyle: envFloat(env, "ELEVENLABS_STYLE", 0.05),
    ttsUseSpeakerBoost: envBool(env, "ELEVENLABS_USE_SPEAKER_BOOST", false),
    ttsSpeed: envFloat(env, "ELEVENLABS_SPEED", 1.0),
    // A gaze selection can commit a real decoder request. Keep one generous
    // cutoff for both committed and speculative work instead of failing a
    // valid OpenRouter response after a few seconds.
    decoderInteractionDeadlineMs: envInt(env, "DECODER_INTERACTION_DEADLINE_MS", 15000),
    decoderRequestMaxMs: envInt(env, "DECODER_REQUEST_MAX_MS", 15000),
    contextInSimulation: envBool(env, "CONTEXT_IN_SIMULATION", true),
    taskAwareCards: envBool(env, "TASK_AWARE_CARDS", false),
    hootsRecordingMode: envBool(env, "HOOTS_RECORDING_MODE", false),
  },
  hasOpenAiKey: hasEnvValue(env, "OPENAI_API_KEY"),
  hasGeminiKey: hasEnvValue(env, "GEMINI_API_KEY"),
  hasOpenRouterKey: hasEnvValue(env, "OPENROUTER_API_KEY"),
  hasElevenLabsKey: hasEnvValue(env, "ELEVENLABS_API_KEY"),
  platform: String(process.platform),
  nativeNotchHostAvailable: false,
};

/**
 * Optional local vocabulary is read once at startup and kept in memory. The
 * decoder receives only the small subset relevant to the current prompt.
 */
export const personalizationLexicon: UserLexicon = {
  people: envList(env, "HOOTS_PEOPLE"),
  places: envList(env, "HOOTS_PLACES"),
  apps: envList(env, "HOOTS_APPS"),
  recurringPhrases: envList(env, "HOOTS_RECURRING_PHRASES"),
  customVocabulary: envList(env, "HOOTS_VOCABULARY"),
};

export function apiKey(name: string): string {
  return (process.env[name] ?? env[name] ?? "").trim();
}
