import type { UserLexicon } from "../../shared/types";

/**
 * Merges user-provided vocabulary with the small built-in vocabulary while
 * keeping each category bounded. Personalization changes ranking only; it is
 * never treated as accepted intent.
 */
export function mergeLexicons(base: UserLexicon, personal: Partial<UserLexicon> = {}, maxPerCategory = 32): UserLexicon {
  return {
    people: mergeCategory(base.people, personal.people, maxPerCategory),
    places: mergeCategory(base.places, personal.places, maxPerCategory),
    apps: mergeCategory(base.apps, personal.apps, maxPerCategory),
    recurringPhrases: mergeCategory(base.recurringPhrases, personal.recurringPhrases, maxPerCategory),
    customVocabulary: mergeCategory(base.customVocabulary, personal.customVocabulary, maxPerCategory),
  };
}

/** Keep only vocabulary that can help with the current bounded interaction. */
export function relevantLexicon(lexicon: UserLexicon, query: string, maxPerCategory = 8): UserLexicon {
  const normalizedQuery = normalize(query);
  return {
    people: filterCategory(lexicon.people, normalizedQuery, maxPerCategory),
    places: filterCategory(lexicon.places, normalizedQuery, maxPerCategory),
    apps: filterCategory(lexicon.apps, normalizedQuery, maxPerCategory),
    recurringPhrases: filterCategory(lexicon.recurringPhrases, normalizedQuery, maxPerCategory),
    customVocabulary: filterCategory(lexicon.customVocabulary, normalizedQuery, maxPerCategory),
  };
}

function mergeCategory(base: string[], personal: string[] | undefined, maxPerCategory: number): string[] {
  return unique([...base, ...(personal ?? [])]).slice(0, maxPerCategory);
}

function filterCategory(values: string[], query: string, maxPerCategory: number): string[] {
  return values
    .map((value, index) => ({ value, index, score: relevance(value, query) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, maxPerCategory)
    .map((entry) => entry.value);
}

function relevance(value: string, query: string): number {
  if (!query) return 0;
  const normalized = normalize(value);
  if (query === normalized) return 3;
  if (normalized.startsWith(query) || query.split(/\s+/).some((part) => part && normalized.startsWith(part))) return 2;
  if (normalized.includes(query) || query.includes(normalized)) return 1;
  return 0;
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  return values
    .map((value) => value.trim())
    .filter((value) => {
      const key = normalize(value);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}
