import type OpenAI from "openai";
import type { ComputerAction, ResponseComputerToolCall, ResponseInput } from "openai/resources/responses/responses";
import type { ExecutedTask } from "../../shared/types";
import type { ExecutorCallbacks, ExecutorProvider } from "./ExecutorProvider";
import { isConsequentialIntent, labelConsequentialAction } from "./ExecutorProvider";
import { apiKey } from "../config";
import { ScreenCapturer } from "../context/capture";

export class OpenAIComputerUseExecutor implements ExecutorProvider {
  readonly name = "openai-computer-use";
  readonly mode = "live";
  private client: OpenAI | null = null;
  private key: string;
  private running = false;
  private interruptFlag = false;
  private capturer = new ScreenCapturer();

  constructor(private model: string, private displayWidth: number, private displayHeight: number) {
    this.key = apiKey("OPENAI_API_KEY");
  }

  get available(): boolean {
    return this.key.length > 0;
  }

  async start(task: ExecutedTask, callbacks: ExecutorCallbacks): Promise<void> {
    const client = await this.getClient();
    const initialScreenshot = await this.capture();
    this.running = true;
    this.interruptFlag = false;
    callbacks.onEvent({ type: "task_started", taskId: task.taskId, text: "Starting computer use…" });

    const instructions = [
      "Operate the current macOS desktop to complete the confirmed request.",
      "Use the existing signed-in applications and browser sessions.",
      "Before a final external or irreversible action (send, post, submit, delete, purchase, payment, booking, or account change), return a computer safety check so the host can request explicit confirmation.",
      "Do not report success until the visible desktop confirms the requested result.",
      `Confirmed request: ${task.naturalLanguagePrompt}`,
    ].join("\n");

    let previousResponseId: string | undefined;
    let nextInput: ResponseInput = [{
      role: "user",
      content: [
        { type: "input_text", text: task.naturalLanguagePrompt },
        { type: "input_image", image_url: initialScreenshot, detail: "original" },
      ],
    }];
    let localConsequentialApproval = !isConsequentialIntent(task.naturalLanguagePrompt);

    try {
      for (let turn = 0; turn < 80 && this.running; turn++) {
        const response = await client.responses.create({
          model: this.model,
          instructions,
          tools: [{ type: "computer" }],
          input: nextInput,
          previous_response_id: previousResponseId,
          reasoning: { effort: "low" },
        });
        previousResponseId = response.id;
        if (!(await this.handleInterrupt(task, callbacks, "Paused before the next desktop action."))) return;

        const calls = (response.output ?? []).filter((item): item is ResponseComputerToolCall => item.type === "computer_call");
        for (const item of response.output ?? []) {
          if (item.type === "message") {
            const text = (item.content ?? []).filter((part) => part.type === "output_text").map((part) => "text" in part ? part.text : "").join(" ");
            if (text) callbacks.onEvent({ type: "status", taskId: task.taskId, text: text.slice(0, 180) });
          }
        }
        if (calls.length === 0) {
          if (response.status !== "completed") {
            throw new Error(`OpenAI Computer Use stopped with response status: ${response.status}`);
          }
          const summary = response.output_text.trim();
          if (!summary) throw new Error("OpenAI Computer Use returned no action and no completion summary.");
          callbacks.onEvent({ type: "completed", taskId: task.taskId, text: summary });
          callbacks.onComplete(task, summary);
          return;
        }

        const outputs: ResponseInput = [];
        for (const call of calls) {
          const checks = call.pending_safety_checks ?? [];
          if (checks.length > 0) {
            const approved = await this.requestApproval(
              task,
              callbacks,
              labelConsequentialAction(checks.map((check) => check.message ?? check.code ?? "external action").join("; ")),
            );
            if (!approved) {
              callbacks.onEvent({ type: "stopped", taskId: task.taskId, text: "Cancelled before the final action." });
              return;
            }
            localConsequentialApproval = true;
          }

          const actions = call.actions ?? (call.action ? [call.action] : []);
          const hasDesktopMutation = actions.some((action) => action.type !== "screenshot" && action.type !== "wait" && action.type !== "move");
          if (!localConsequentialApproval && hasDesktopMutation) {
            const approved = await this.requestApproval(task, callbacks, labelConsequentialAction(task.naturalLanguagePrompt));
            if (!approved) {
              callbacks.onEvent({ type: "stopped", taskId: task.taskId, text: "Cancelled before the consequential task changed the desktop." });
              return;
            }
            localConsequentialApproval = true;
          }

          for (const action of actions) {
            if (!(await this.handleInterrupt(task, callbacks, `Paused before: ${actionLabel(action.type)}`))) return;
            await this.performLocal(action);
            callbacks.onEvent({ type: "step", taskId: task.taskId, text: actionLabel(action.type), stepIndex: turn + 1, stepCount: 80 });
          }
          const screenshotOutput = {
            type: "computer_screenshot" as const,
            image_url: await this.capture(),
            detail: "original" as const,
          };
          outputs.push({
            type: "computer_call_output",
            call_id: call.call_id,
            output: screenshotOutput,
            acknowledged_safety_checks: checks,
          });
        }
        nextInput = outputs;
      }
      if (this.running) throw new Error("Computer use exceeded the 80-turn safety limit");
    } finally {
      this.running = false;
    }
  }

  private async getClient(): Promise<OpenAI> {
    if (!this.key) throw new Error("OpenAI executor requires OPENAI_API_KEY");
    if (!this.client) {
      const { default: OpenAIClient } = await import("openai");
      this.client = new OpenAIClient({ apiKey: this.key });
    }
    return this.client;
  }

  private async requestApproval(task: ExecutedTask, callbacks: ExecutorCallbacks, summary: string): Promise<boolean> {
    return callbacks.requestConsequentialConfirmation({
      taskId: task.taskId,
      pendingActionSummary: summary,
      taskContext: task.naturalLanguagePrompt,
      choices: [
        { id: "approve", label: "APPROVE" },
        { id: "change", label: "CHANGE" },
        { id: "read", label: "READ / EXPLAIN" },
        { id: "cancel", label: "CANCEL" },
      ],
    });
  }

  private async capture(): Promise<string> {
    const frame = await this.capturer.capturePrimary();
    if (!frame) throw new Error("Screen capture failed. Grant Screen Recording permission and retry.");
    return frame.dataUrl;
  }

  private async handleInterrupt(task: ExecutedTask, callbacks: ExecutorCallbacks, status: string): Promise<boolean> {
    if (!this.interruptFlag && this.running) return true;
    callbacks.onEvent({ type: "interrupted", taskId: task.taskId, text: status });
    const choice = await callbacks.requestSteering(task, status);
    if (choice === "continue") {
      this.interruptFlag = false;
      this.running = true;
      callbacks.onEvent({ type: "status", taskId: task.taskId, text: "Continuing from the paused action…" });
      return true;
    }
    this.running = false;
    callbacks.onEvent({ type: "stopped", taskId: task.taskId, text: choice === "change" ? "Task stopped so the instruction can be changed." : "Task stopped." });
    return false;
  }

  private async performLocal(action: ComputerAction): Promise<void> {
    const nut = await import("@nut-tree-fork/nut-js");
    const point = (x: number, y: number) => new nut.Point(
      Math.max(0, Math.min(this.displayWidth - 1, Math.round(x))),
      Math.max(0, Math.min(this.displayHeight - 1, Math.round(y))),
    );
    const withHeldKeys = async (rawKeys: string[] | null | undefined, operation: () => Promise<unknown>): Promise<void> => {
      const keys = (rawKeys ?? []).map((key) => toNutKey(nut.Key, key));
      if (keys.some((key) => key === null)) throw new Error(`Unsupported modifier key: ${(rawKeys ?? []).join("+")}`);
      const mapped = keys as number[];
      if (mapped.length > 0) await nut.keyboard.pressKey(...mapped);
      try {
        await operation();
      } finally {
        if (mapped.length > 0) await nut.keyboard.releaseKey(...[...mapped].reverse());
      }
    };
    switch (action.type) {
      case "move":
        await withHeldKeys(action.keys, () => nut.mouse.setPosition(point(action.x, action.y)));
        break;
      case "click":
        await nut.mouse.setPosition(point(action.x, action.y));
        await withHeldKeys(action.keys, () => nut.mouse.click(toNutButton(nut.Button, action.button)));
        break;
      case "double_click":
        await nut.mouse.setPosition(point(action.x, action.y));
        await withHeldKeys(action.keys, () => nut.mouse.doubleClick(nut.Button.LEFT));
        break;
      case "drag":
        if (action.path.length > 1) await withHeldKeys(action.keys, () => nut.mouse.drag(action.path.map((entry) => point(entry.x, entry.y))));
        break;
      case "scroll": {
        await nut.mouse.setPosition(point(action.x, action.y));
        const vertical = Math.max(1, Math.round(Math.abs(action.scroll_y) / 100));
        const horizontal = Math.max(1, Math.round(Math.abs(action.scroll_x) / 100));
        await withHeldKeys(action.keys, async () => {
          if (action.scroll_y > 0) await nut.mouse.scrollDown(vertical);
          if (action.scroll_y < 0) await nut.mouse.scrollUp(vertical);
          if (action.scroll_x > 0) await nut.mouse.scrollRight(horizontal);
          if (action.scroll_x < 0) await nut.mouse.scrollLeft(horizontal);
        });
        break;
      }
      case "keypress": {
        const keys = (action.keys ?? []).map((key) => toNutKey(nut.Key, key)).filter((key): key is number => key !== null);
        if (keys.length === 0) throw new Error(`Unsupported key combination: ${(action.keys ?? []).join("+")}`);
        await nut.keyboard.pressKey(...keys);
        await nut.keyboard.releaseKey(...[...keys].reverse());
        break;
      }
      case "type":
        await nut.keyboard.type(action.text ?? "");
        break;
      case "wait":
        await new Promise((resolve) => setTimeout(resolve, 500));
        break;
      case "screenshot":
        // Every computer call returns a fresh screenshot below.
        break;
    }
  }

  async interrupt(): Promise<void> {
    this.interruptFlag = true;
  }

  async stop(): Promise<void> {
    this.interruptFlag = true;
    this.running = false;
  }
}

function toNutButton(buttons: { LEFT: number; MIDDLE: number; RIGHT: number }, raw: string): number {
  if (raw === "left") return buttons.LEFT;
  if (raw === "right") return buttons.RIGHT;
  if (raw === "wheel") return buttons.MIDDLE;
  throw new Error(`Unsupported mouse button: ${raw}`);
}

function actionLabel(type: ComputerAction["type"]): string {
  return ({ click: "Click", double_click: "Double click", drag: "Drag", scroll: "Scroll", keypress: "Key press", type: "Type text", wait: "Wait", move: "Move pointer", screenshot: "Inspect screen" })[type];
}

function toNutKey(keys: Record<string, string | number>, raw: string): number | null {
  const normalized = raw.toLowerCase().replace(/[ _-]/g, "");
  const aliases: Record<string, string> = {
    cmd: "LeftCmd", command: "LeftCmd", meta: "LeftCmd", ctrl: "LeftControl", control: "LeftControl",
    alt: "LeftAlt", option: "LeftAlt", shift: "LeftShift", enter: "Enter", return: "Return",
    esc: "Escape", escape: "Escape", space: "Space", backspace: "Backspace", delete: "Delete",
    tab: "Tab", up: "Up", arrowup: "Up", down: "Down", arrowdown: "Down",
    left: "Left", arrowleft: "Left", right: "Right", arrowright: "Right",
  };
  const name = aliases[normalized] ?? (normalized.length === 1 ? normalized.toUpperCase() : raw);
  const value = keys[name];
  return typeof value === "number" ? value : null;
}
