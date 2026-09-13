import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("ElevenLabs speech feedback", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("TTS_PROVIDER", "elevenlabs");
    vi.stubEnv("ELEVENLABS_API_KEY", "test-elevenlabs-key");
    vi.stubEnv("ELEVENLABS_MODEL", "eleven_flash_v2_5");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("uses the configured fast model and selected voice", async () => {
    const request = vi.fn(async (..._args: unknown[]) => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    vi.stubGlobal("fetch", request);
    const { ElevenLabsTTS } = await import("../../src/main/tts/MacSayTTS");

    const result = await new ElevenLabsTTS("demo-voice").synthesize("Find selected.");

    expect(result?.provider).toBe("elevenlabs");
    expect(result?.dataUrl).toMatch(/^data:audio\/mpeg;base64,/);
    const [url, init] = request.mock.calls[0] as [unknown, { body?: unknown }];
    expect(String(url)).toContain("/demo-voice/stream");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model_id: "eleven_flash_v2_5",
      text: "Find selected.",
      voice_settings: {
        stability: 0.46,
        similarity_boost: 0.8,
        style: 0.05,
        use_speaker_boost: false,
        speed: 1,
      },
    });
  });

  it("adds one short pause to natural acknowledgement phrasing", async () => {
    const request = vi.fn(async (..._args: unknown[]) => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    vi.stubGlobal("fetch", request);
    const { ElevenLabsTTS } = await import("../../src/main/tts/MacSayTTS");

    await new ElevenLabsTTS("demo-voice").synthesize("Okay — find or learn.");

    const [, init] = request.mock.calls[0] as [unknown, { body?: unknown }];
    expect(JSON.parse(String(init?.body)).text).toBe('Okay — <break time="0.18s" /> find or learn.');
  });

  it("reports an ElevenLabs failure instead of using macOS speech", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unauthorized", { status: 401 })));
    const { TTSService } = await import("../../src/main/tts/MacSayTTS");
    const service = new TTSService("demo-voice");
    const failures: string[] = [];
    const audio: string[] = [];
    service.onError = (message) => failures.push(message);
    service.onAudio = (result) => audio.push(result.provider);

    await service.speak("Selection accepted.");

    expect(service.providerName).toBe("elevenlabs");
    expect(audio).toEqual([]);
    expect(failures).toEqual(["elevenlabs speech failed: ElevenLabs returned HTTP 401."]);
  });

  it("serializes consecutive feedback so a later phrase cannot cancel the selection acknowledgement", async () => {
    const requests: string[] = [];
    const request = vi.fn(async (...args: unknown[]) => {
      const init = args[1] as { body?: unknown } | undefined;
      requests.push(JSON.parse(String(init?.body)).text as string);
      return new Response(new Uint8Array([requests.length]), { status: 200 });
    });
    vi.stubGlobal("fetch", request);
    const { TTSService } = await import("../../src/main/tts/MacSayTTS");
    const service = new TTSService("demo-voice");
    const audio: string[] = [];
    service.onAudio = (result) => audio.push(result.text);

    await Promise.all([service.speak("Find selected."), service.speak("You want me to find a file. Is that right?")]);

    expect(requests).toEqual(["Find selected.", "You want me to find a file. Is that right?"]);
    expect(audio).toEqual(requests);
  });
});
