import type { TelemetrySummary } from "../../shared/types";

export class SessionMetrics {
  semanticSelections = 0;
  noneSelections = 0;
  clarificationAnswers = 0;
  fallbackCharacters = 0;
  timeToIntentMs: number | null = null;
  decoderColdLatencyMs: number[] = [];
  prefetchHits = 0;
  prefetchMisses = 0;
  prefetchedUiLatencyMs: number[] = [];
  ttsTimeToFirstAudioMs: number[] = [];
  executorActions = 0;
  totalTaskTimeMs: number | null = null;
  lastTaskSummary: string | null = null;
  private sessionStart = Date.now();

  resetSession(): void {
    this.semanticSelections = 0;
    this.noneSelections = 0;
    this.clarificationAnswers = 0;
    this.fallbackCharacters = 0;
    this.timeToIntentMs = null;
    this.decoderColdLatencyMs = [];
    this.prefetchHits = 0;
    this.prefetchMisses = 0;
    this.prefetchedUiLatencyMs = [];
    this.ttsTimeToFirstAudioMs = [];
    this.sessionStart = Date.now();
  }

  markIntentReady(): void {
    this.timeToIntentMs = Date.now() - this.sessionStart;
  }

  recordTtsLatency(ms: number): void {
    this.ttsTimeToFirstAudioMs.push(ms);
  }

  recordTask(taskSummary: string, ms: number, actions: number): void {
    this.totalTaskTimeMs = ms;
    this.executorActions = actions;
    this.lastTaskSummary = taskSummary;
  }

  summary(): TelemetrySummary {
    return {
      semanticSelections: this.semanticSelections,
      noneSelections: this.noneSelections,
      clarificationAnswers: this.clarificationAnswers,
      fallbackCharacters: this.fallbackCharacters,
      timeToIntentMs: this.timeToIntentMs,
      decoderColdLatencyMs: [...this.decoderColdLatencyMs],
      prefetchHits: this.prefetchHits,
      prefetchMisses: this.prefetchMisses,
      prefetchedUiLatencyMs: [...this.prefetchedUiLatencyMs],
      ttsTimeToFirstAudioMs: [...this.ttsTimeToFirstAudioMs],
      executorActions: this.executorActions,
      totalTaskTimeMs: this.totalTaskTimeMs,
      lastTaskSummary: this.lastTaskSummary,
    };
  }
}