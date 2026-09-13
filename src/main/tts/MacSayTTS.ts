import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type { TTSProvider, TTSResult } from "./TTSProvider";
import { config, apiKey } from "../config";

const TTS_ENDPOINT = "https://api.elevenlabs.io/v1/text-to-speech";
const execFileAsync = promisify(execFile);

function supportsBreakTags(model: string): boolean {
  return model.startsWith("eleven_flash") || model.startsWith("eleven_turbo") || model.startsWith("eleven_multilingual");
}

/** Add one short, model-supported pause to acknowledgement phrases.
 *
 * Flash v2.5 understands SSML break tags. The pause gives the voice a small
 * turn-taking beat without adding a second request or delaying playback.
 */
function naturalizeSpeechText(text: string, model: string): string {
  if (!supportsBreakTags(model)) return text;
  return text.replace(/^Okay — /, 'Okay — <break time="0.18s" /> ');
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export class ElevenLabsTTS implements TTSProvider {
  readonly name = "elevenlabs";

  constructor(private voiceId: string) {}

  get available(): boolean {
    return config.hasElevenLabsKey && Boolean(this.voiceId);
  }

  async synthesize(text: string): Promise<TTSResult | null> {
    if (!this.available) throw new Error("ElevenLabs requires an API key and voice ID.");
    const started = now();
    const model = config.settings.ttsModel;
    const url = `${TTS_ENDPOINT}/${this.voiceId}/stream?output_format=mp3_44100_128&optimize_streaming_latency=4`;
    const voiceSettings = model === "eleven_v3"
      ? { stability: config.settings.ttsStability }
      : {
          stability: config.settings.ttsStability,
          similarity_boost: config.settings.ttsSimilarityBoost,
          style: config.settings.ttsStyle,
          use_speaker_boost: config.settings.ttsUseSpeakerBoost,
          speed: config.settings.ttsSpeed,
        };
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey("ELEVENLABS_API_KEY"),
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text: naturalizeSpeechText(text, model),
        model_id: model,
        voice_settings: voiceSettings,
      }),
    });
    if (!response.ok) throw new Error(`ElevenLabs returned HTTP ${response.status}.`);
    const audio = Buffer.from(await response.arrayBuffer());
    if (audio.length === 0) throw new Error("ElevenLabs returned empty audio.");
    return {
      dataUrl: `data:audio/mpeg;base64,${audio.toString("base64")}`,
      provider: this.name,
      timeToFirstAudioMs: now() - started,
      text,
    };
  }

  stop(): void {}
}

export class MacSayTTS implements TTSProvider {
  readonly name = "macos-say";
  private tempDir: string | null = null;

  get available(): boolean {
    return existsSync("/usr/bin/say");
  }

  async synthesize(text: string): Promise<TTSResult | null> {
    const started = now();
    try {
      this.tempDir ??= await mkdtemp(join(tmpdir(), "gaze-tts-"));
      const file = join(this.tempDir, `${randomUUID()}.aiff`);
      try {
        await execFileAsync("/usr/bin/say", ["-o", file, text], { timeout: 30_000 });
        const data = await readFile(file);
        return {
          dataUrl: `data:audio/aiff;base64,${data.toString("base64")}`,
          provider: this.name,
          timeToFirstAudioMs: now() - started,
          text,
        };
      } finally {
        try {
          await unlink(file);
        } catch {
          // ignore
        }
      }
    } catch {
      return null;
    }
  }

  stop(): void {}
}

export class MuteTTS implements TTSProvider {
  readonly name = "mute";
  readonly available = true;
  async synthesize(): Promise<TTSResult | null> {
    return null;
  }
  stop(): void {}
}

export class TTSService {
  private provider: TTSProvider;
  private prefetch = new Map<string, Promise<TTSResult | null>>();
  private cancelGeneration = 0;
  private speechQueue: Promise<void> = Promise.resolve();
  onAudio: ((result: TTSResult) => void) | null = null;
  onError: ((message: string) => void) | null = null;

  constructor(voiceId: string) {
    if (config.ttsProvider === "elevenlabs") {
      this.provider = new ElevenLabsTTS(voiceId);
    } else if (config.ttsProvider === "macos") {
      this.provider = new MacSayTTS();
    } else {
      this.provider = new MuteTTS();
    }
  }

  get providerName(): string {
    return this.provider.name;
  }

  speak(text: string): Promise<void> {
    if (!text.trim()) return Promise.resolve();
    const generation = this.cancelGeneration;
    const speakOne = async (): Promise<void> => {
      if (generation !== this.cancelGeneration) return;
      try {
        const result = await this.synthesize(text);
        if (generation !== this.cancelGeneration) return;
        if (result) this.play(result);
        else if (this.provider.name !== "mute") this.onError?.(`${this.provider.name} returned no audio.`);
      } catch (error) {
        if (generation !== this.cancelGeneration) return;
        const message = error instanceof Error ? error.message : String(error);
        this.onError?.(`${this.provider.name} speech failed: ${message}`);
      }
    };
    const scheduled = this.speechQueue.then(speakOne, speakOne);
    // Keep the chain alive after a failed callback so later selections still
    // receive feedback. speakOne reports provider errors through onError.
    this.speechQueue = scheduled.catch(() => undefined);
    return scheduled;
  }

  private async synthesize(text: string): Promise<TTSResult | null> {
    const existing = this.prefetch.get(text);
    if (existing) {
      this.prefetch.delete(text);
      return existing;
    }
    const promise = this.provider.synthesize(text);
    this.prefetch.set(text, promise);
    try {
      return await promise;
    } finally {
      if (this.prefetch.get(text) === promise) this.prefetch.delete(text);
    }
  }

  prefetchText(text: string): void {
    if (!text.trim() || this.prefetch.has(text)) return;
    this.prefetch.set(text, this.provider.synthesize(text).catch(() => null));
    if (this.prefetch.size > 24) {
      const first = this.prefetch.keys().next().value as string;
      this.prefetch.delete(first);
    }
  }

  play(result: TTSResult): void {
    if (this.onAudio) this.onAudio(result);
  }

  stop(): void {
    this.cancelGeneration += 1;
    this.speechQueue = Promise.resolve();
    this.prefetch.clear();
    this.provider.stop();
  }
}
