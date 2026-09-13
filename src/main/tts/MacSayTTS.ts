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
    const url = `${TTS_ENDPOINT}/${this.voiceId}/stream?output_format=mp3_44100_128&optimize_streaming_latency=4`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey("ELEVENLABS_API_KEY"),
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: config.settings.ttsModel,
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
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
  private requestGeneration = 0;
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

  async speak(text: string): Promise<void> {
    if (!text.trim()) return;
    const generation = ++this.requestGeneration;
    try {
      const result = await this.synthesize(text);
      if (generation !== this.requestGeneration) return;
      if (result) this.play(result);
      else if (this.provider.name !== "mute") this.onError?.(`${this.provider.name} returned no audio.`);
    } catch (error) {
      if (generation !== this.requestGeneration) return;
      const message = error instanceof Error ? error.message : String(error);
      this.onError?.(`${this.provider.name} speech failed: ${message}`);
    }
  }

  private async synthesize(text: string): Promise<TTSResult | null> {
    const existing = this.prefetch.get(text);
    if (existing) {
      this.prefetch.delete(text);
      return existing;
    }
    const promise = this.provider.synthesize(text);
    this.prefetch.set(text, promise);
    const result = await promise;
    return result;
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
    this.requestGeneration += 1;
    this.provider.stop();
  }
}
