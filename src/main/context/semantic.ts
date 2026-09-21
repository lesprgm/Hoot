import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ContextReference, WindowContext } from "../../shared/types";

const execFileAsync = promisify(execFile);

export interface SemanticContextObservation {
  focusedElement: ContextReference | null;
  selectedText: string | null;
  visibleText: string | null;
}

export interface SemanticContextSource {
  readonly name: string;
  read(window: WindowContext): Promise<SemanticContextObservation>;
}

/** Best-effort AX query for the current frontmost application. */
export class MacAccessibilitySource implements SemanticContextSource {
  readonly name = "macos-accessibility";

  async read(window: WindowContext): Promise<SemanticContextObservation> {
    if (process.platform !== "darwin") return emptyObservation();
    try {
      const script = [
        'tell application "System Events"',
        'set frontProcess to first application process whose frontmost is true',
        'set focusedElement to value of attribute "AXFocusedUIElement" of frontProcess',
        'set roleName to ""',
        'set titleName to ""',
        'set valueText to ""',
        'try',
        'set roleName to value of attribute "AXRole" of focusedElement as text',
        'end try',
        'try',
        'set titleName to value of attribute "AXTitle" of focusedElement as text',
        'end try',
        'try',
        'set valueText to value of attribute "AXValue" of focusedElement as text',
        'end try',
        'return roleName & "|" & titleName & "|" & valueText',
        'end tell',
      ].join("\n");
      const result = await execFileAsync("/usr/bin/osascript", ["-e", script], { encoding: "utf8", timeout: 1_000, maxBuffer: 16 * 1024 });
      const [role, title, value] = String(result.stdout).trim().split("|").map((part) => part.trim().slice(0, 240));
      if (!role && !title && !value) return emptyObservation();
      const focusedElement: ContextReference = {
        id: `ax:${window.bundleId ?? window.appName}:${role || "element"}:${title || value || "focused"}`,
        kind: "control",
        label: title || value || role || "Focused element",
        appName: window.appName,
        source: "accessibility",
        observedAt: Date.now(),
        bounds: window.bounds,
        text: value || undefined,
      };
      return { focusedElement, selectedText: role === "AXTextArea" || role === "AXTextField" ? value || null : null, visibleText: title || null };
    } catch {
      return emptyObservation();
    }
  }
}

export function emptyObservation(): SemanticContextObservation {
  return { focusedElement: null, selectedText: null, visibleText: null };
}

