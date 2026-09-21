import { randomUUID } from "node:crypto";

export interface DecoderRequestOptions {
  requestId: string;
  signal: AbortSignal;
  deadlineAt: number;
}

export interface DecoderRequestCoordinatorOptions {
  interactionDeadlineMs?: number;
  requestMaxMs?: number;
  now?: () => number;
}

export class DecoderTimeoutError extends Error {
  readonly code = "DECODER_TIMEOUT";
  constructor(message = "Decoder request exceeded its deadline.") {
    super(message);
    this.name = "DecoderTimeoutError";
  }
}

export class DecoderCancelledError extends Error {
  readonly code = "DECODER_CANCELLED";
  constructor(message = "Decoder request was cancelled.") {
    super(message);
    this.name = "DecoderCancelledError";
  }
}

type ActiveRequest = {
  requestId: string;
  controller: AbortController;
  speculative: boolean;
  reject?: (reason: unknown) => void;
};

/** Enforces one bounded decoder request and gives committed work priority over speculation. */
export class DecoderRequestCoordinator {
  private readonly interactionDeadlineMs: number;
  private readonly requestMaxMs: number;
  private readonly clock: () => number;
  private active: ActiveRequest | null = null;

  constructor(options: DecoderRequestCoordinatorOptions = {}) {
    this.interactionDeadlineMs = Math.max(100, options.interactionDeadlineMs ?? 15_000);
    this.requestMaxMs = Math.max(this.interactionDeadlineMs, options.requestMaxMs ?? 15_000);
    this.clock = options.now ?? (() => performance.now());
  }

  async run<T>(
    _kind: string,
    task: (options: DecoderRequestOptions) => Promise<T>,
    requestOptions: { speculative?: boolean; deadlineMs?: number } = {},
  ): Promise<T> {
    if (requestOptions.speculative && this.active?.speculative) this.cancel("replaced by a newer speculative request");
    if (!requestOptions.speculative && this.active) this.cancel("committed selection took priority");

    const requestId = randomUUID();
    const controller = new AbortController();
    const speculative = requestOptions.speculative === true;
    const active: ActiveRequest = { requestId, controller, speculative };
    this.active = active;
    const started = this.clock();
    const defaultDeadline = speculative ? this.requestMaxMs : this.interactionDeadlineMs;
    const deadlineMs = Math.min(this.requestMaxMs, Math.max(100, requestOptions.deadlineMs ?? defaultDeadline));
    const deadlineAt = started + deadlineMs;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let settled = false;
    try {
      let work: Promise<T>;
      try {
        // Invoke the provider immediately so a prefetch can overlap the
        // user's remaining dwell interval. Promise wrapping still normalizes
        // synchronous provider errors for the coordinator.
        work = Promise.resolve(task({
          requestId,
          signal: controller.signal,
          deadlineAt,
        }));
      } catch (error) {
        work = Promise.reject(error);
      }
      work.then(
        () => undefined,
        () => undefined,
      );
      const result = new Promise<T>((resolve, reject) => {
        active.reject = (reason) => {
          if (settled) return;
          settled = true;
          reject(reason);
        };
        work.then(
          (value) => {
            if (settled) return;
            settled = true;
            resolve(value);
          },
          (error) => {
            if (settled) return;
            settled = true;
            reject(error);
          },
        );
      });
      timeout = setTimeout(() => {
        timedOut = true;
        const timeoutError = new DecoderTimeoutError();
        controller.abort(timeoutError);
        active.reject?.(timeoutError);
      }, Math.max(1, deadlineAt - this.clock()));
      const value = await result;
      if (timedOut) throw new DecoderTimeoutError();
      if (controller.signal.aborted) throw this.abortError(controller.signal.reason);
      return value;
    } catch (error) {
      const reason = timedOut ? new DecoderTimeoutError() : controller.signal.aborted ? this.abortError(controller.signal.reason) : error;
      throw reason;
    } finally {
      if (timeout) clearTimeout(timeout);
      if (this.active?.requestId === requestId) this.active = null;
    }
  }

  cancel(reason = "cancelled by the interaction controller"): void {
    if (!this.active) return;
    const active = this.active;
    const cancellation = new DecoderCancelledError(reason);
    active.controller.abort(cancellation);
    active.reject?.(cancellation);
  }

  cancelSpeculation(reason = "speculation cancelled"): void {
    if (this.active?.speculative) this.cancel(reason);
  }

  cancelAll(reason = "decoder work cancelled"): void {
    this.cancel(reason);
  }

  private abortError(reason: unknown): Error {
    if (reason instanceof DecoderTimeoutError || reason instanceof DecoderCancelledError) return reason;
    return new DecoderCancelledError(reason instanceof Error ? reason.message : "Decoder request was cancelled.");
  }
}
