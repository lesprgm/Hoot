import { afterEach, describe, expect, it, vi } from "vitest";
import { calibrationOperation } from "../../src/renderer/gaze/CalibrationOperation";

afterEach(() => vi.useRealTimers());

describe("acknowledged calibration operations", () => {
  it("aborts immediately, removes callbacks, and ignores a late worker response", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const cleanup = vi.fn();
    let acknowledge!: (value: boolean) => void;
    const result = calibrationOperation<boolean>(controller.signal, "Fit", 5000, resolve => {
      acknowledge = resolve;
      return cleanup;
    });
    const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;
    acknowledge(true);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("propagates the actual worker error without waiting for a timeout", async () => {
    vi.useFakeTimers();
    const failure = new Error("Calibration predictions are rank deficient");
    const cleanup = vi.fn();
    const result = calibrationOperation(new AbortController().signal, "Fit", 5000, (_resolve, reject) => {
      reject(failure);
      return cleanup;
    });
    await expect(result).rejects.toBe(failure);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up synchronous acknowledgments and rejects unresponsive commands", async () => {
    vi.useFakeTimers();
    const cleanup = vi.fn();
    await expect(calibrationOperation(new AbortController().signal, "Save", 1000, resolve => {
      resolve("saved");
      return cleanup;
    })).resolves.toBe("saved");
    const timeout = calibrationOperation(new AbortController().signal, "Save", 1000, () => cleanup);
    const rejected = expect(timeout).rejects.toThrow("Save did not respond within 1000 ms");
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never submits a command after cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const subscribe = vi.fn();
    await expect(calibrationOperation(controller.signal, "Fit", 5000, subscribe)).rejects.toMatchObject({ name: "AbortError" });
    expect(subscribe).not.toHaveBeenCalled();
  });
});
