/** One acknowledged worker command. Abort, failure and timeout settle it once
 * and remove callbacks before another calibration can start. */
export function calibrationOperation<T>(
  signal: AbortSignal,
  label: string,
  timeoutMs: number,
  subscribe: (resolve: (value: T) => void, reject: (error: Error) => void) => () => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException("Calibration cancelled.", "AbortError")); return; }
    let settled = false;
    let unsubscribe = () => {};
    const finish = (error: Error | null, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      unsubscribe();
      if (error) reject(error); else resolve(value as T);
    };
    const abort = () => finish(new DOMException("Calibration cancelled.", "AbortError"));
    const timer = setTimeout(() => finish(new Error(`${label} did not respond within ${timeoutMs} ms.`)), timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    try {
      unsubscribe = subscribe(value => finish(null, value), error => finish(error));
      if (settled) unsubscribe();
    } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
  });
}
