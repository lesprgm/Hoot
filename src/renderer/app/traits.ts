export interface QuadrantOption {
  id: string;
  label: string;
}

export interface ConfirmationChoice {
  id: string;
  label: string;
}

export interface SpriteViewProps {
  state: string;
  progress: number | null;
  dwellTargetId: string | null;
}

export const QUADRANT_IDS = ["A", "B", "C", "D"] as const;

export const SPRITE_STATE_LABEL: Record<string, string> = {
  idle: "idle",
  attention: "attention",
  dwelling: "dwelling",
  summoned: "summoned",
  listening_for_gaze: "listening",
  thinking: "thinking",
  speaking: "speaking",
  computer_use_running: "working",
  needs_confirmation: "needs you",
  success: "done",
  interrupted: "interrupted",
  error: "error",
  paused: "paused",
  hidden: "hidden",
};

export function spriteEyes(state: string): string {
  switch (state) {
    case "computer_use_running":
      return "◐ ◐";
    case "thinking":
      return "·  ·";
    case "speaking":
      return "○ ○";
    case "interrupted":
      return "!  !";
    case "error":
      return "×  ×";
    case "success":
      return "^ ^";
    case "dwelling":
      return "◉ ◉";
    case "attention":
      return "●  ●";
    default:
      return "•  •";
  }
}