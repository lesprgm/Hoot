import { describe, expect, it, vi } from "vitest";
import { DecoderCancelledError, DecoderRequestCoordinator, DecoderTimeoutError } from "../../src/main/prompt-completion/DecoderRequestCoordinator";

describe("DecoderRequestCoordinator", () => {
  it("aborts a request at the committed deadline", async () => {
    const coordinator = new DecoderRequestCoordinator({ interactionDeadlineMs: 20, requestMaxMs: 40 });
    const result = coordinator.run("predict", ({ signal }) => new Promise<string>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason));
    }));
    await expect(result).rejects.toBeInstanceOf(DecoderTimeoutError);
  });

  it("cancels obsolete work and does not accept a late result", async () => {
    const coordinator = new DecoderRequestCoordinator({ interactionDeadlineMs: 200, requestMaxMs: 200 });
    let resolveFirst!: (value: string) => void;
    const first = coordinator.run("predict", () => new Promise<string>((resolve) => { resolveFirst = resolve; }));
    await new Promise((resolve) => setTimeout(resolve, 1));
    const second = coordinator.run("predict", async () => "new");
    await expect(first).rejects.toBeInstanceOf(DecoderCancelledError);
    expect(await second).toBe("new");
    resolveFirst("old");
  });

  it("gives a committed request priority over speculation", async () => {
    const coordinator = new DecoderRequestCoordinator({ interactionDeadlineMs: 200, requestMaxMs: 200 });
    const abortSpy = vi.fn();
    const speculative = coordinator.run("prefetch", ({ signal }) => new Promise<string>((_resolve, reject) => {
      signal.addEventListener("abort", () => { abortSpy(); reject(signal.reason); });
    }), { speculative: true });
    await new Promise((resolve) => setTimeout(resolve, 1));
    const committed = coordinator.run("predict", async () => "committed");
    await expect(speculative).rejects.toBeInstanceOf(DecoderCancelledError);
    expect(await committed).toBe("committed");
    expect(abortSpy).toHaveBeenCalledOnce();
  });
});
