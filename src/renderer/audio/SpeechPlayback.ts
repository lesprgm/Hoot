import type { Dispatch, SetStateAction } from "react";
import type { AudioCue } from "../../shared/types";
import type { ViewState } from "../bridge";

type ViewStateSetter = Dispatch<SetStateAction<ViewState>>;

/** Owns renderer-side speech queuing and short audio cues. */
export class SpeechPlayback {
  private audio: HTMLAudioElement | null = null;
  private cueAudioContext: AudioContext | null = null;
  private pending: Array<{ dataUrl: string }> = [];
  private generation = 0;
  private observedDataUrl: string | null = null;

  stop(): void {
    this.generation += 1;
    this.pending = [];
    this.observedDataUrl = null;
    this.audio?.pause();
    this.audio = null;
  }

  observe(dataUrl: string | undefined, setView: ViewStateSetter): void {
    if (!dataUrl) {
      this.observedDataUrl = null;
      return;
    }
    if (dataUrl !== this.observedDataUrl) {
      this.observedDataUrl = dataUrl;
      this.pending.push({ dataUrl });
    }
    this.playNext(setView);
  }

  async playCue(cue: AudioCue): Promise<void> {
    try {
      this.cueAudioContext ??= new AudioContext();
      if (this.cueAudioContext.state === "suspended") await this.cueAudioContext.resume();
      const context = this.cueAudioContext;
      const start = context.currentTime;
      const frequencies = cue === "ready" ? [520, 660] : cue === "error" ? [240, 180] : [620];
      frequencies.forEach((frequency, index) => {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const toneStart = start + index * 0.07;
        oscillator.type = "sine";
        oscillator.frequency.setValueAtTime(frequency, toneStart);
        gain.gain.setValueAtTime(0.0001, toneStart);
        gain.gain.exponentialRampToValueAtTime(cue === "error" ? 0.055 : 0.035, toneStart + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, toneStart + 0.09);
        oscillator.connect(gain).connect(context.destination);
        oscillator.start(toneStart);
        oscillator.stop(toneStart + 0.1);
      });
      globalThis.dispatchEvent(new CustomEvent("view:audio-cue", { detail: cue }));
    } catch (error) {
      console.error("audio cue failed", error);
    }
  }

  private playNext(setView: ViewStateSetter): void {
    if (this.audio || this.pending.length === 0) return;
    const next = this.pending.shift();
    if (!next) return;
    const generation = this.generation;
    let audio: HTMLAudioElement;
    try {
      audio = new Audio(next.dataUrl);
    } catch (error) {
      setView((current) => ({ ...current, notice: `Speech playback failed: ${(error as Error).message}` }));
      this.playNext(setView);
      return;
    }
    this.audio = audio;
    const settle = (notice?: string) => {
      if (generation !== this.generation || this.audio !== audio) return;
      this.audio = null;
      setView((current) => ({
        ...current,
        speech: null,
        sprite: current.interactionState === "EXECUTING" ? "computer_use_running" : "idle",
        ...(notice ? { notice } : {}),
      }));
      this.playNext(setView);
    };
    audio.onended = () => settle();
    audio.onerror = () => settle("Speech playback failed. Check the system audio output.");
    void audio.play().catch((error) => settle(`Speech playback failed: ${(error as Error).message}`));
  }
}

export const speechPlayback = new SpeechPlayback();
