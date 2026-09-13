export interface TTSResult {
  dataUrl: string;
  provider: string;
  timeToFirstAudioMs: number;
  text: string;
}

export interface TTSProvider {
  readonly name: string;
  readonly available: boolean;
  synthesize(text: string): Promise<TTSResult | null>;
  stop(): void;
}