import type { Hint, HintType } from "../../shared/types";

export class HintController {
  private hints: Hint[] = [];

  get all(): Hint[] {
    return this.hints;
  }

  get text(): string {
    return this.hints.map((h) => h.text).join(" ").trim();
  }

  classify(text: string): HintType {
    const t = text.trim();
    if (!t) return "letters";
    if (/^[\d.,%$€£-]+$/.test(t)) return "number";
    if (t.includes(" ") || t.includes("-") || t.includes("_")) return "keyword";
    if (/^[a-z]{3,8}$/i.test(t) && !/[aeiouy]/i.test(t)) return "initialism";
    if (t.length <= 8) return "word_prefix";
    return "letters";
  }

  update(text: string): void {
    const t = text.trim();
    if (!t) {
      this.hints = [];
      return;
    }
    this.hints = [{ text: t, type: this.classify(t), enteredAt: Date.now() }];
  }

  clear(): void {
    this.hints = [];
  }

  restore(hints: Hint[]): void {
    this.hints = hints.map((h) => ({ ...h }));
  }
}