import { cosineSimilarity, EmbeddingHub } from "./SemanticEmbeddings";
import type { RawCandidateShape } from "./decoderSchema";
import type { DisplayOption, QuadrantId } from "../../shared/types";

export interface DiversificationResult {
  options: DisplayOption[];
  rejectedForDuplicate: string[];
  poolSize: number;
  embeddingProvider: string;
}

const QUADRANT_ORDER: QuadrantId[] = ["A", "B", "C", "D"];

export class CandidateDiversifier {
  constructor(
    private readonly embeddings: EmbeddingHub,
    private readonly duplicateThreshold: number = 0.82,
    private readonly noveltyWeight: number = 0.3
  ) {}

  private defaultScore(candidate: RawCandidateShape): number {
    return candidate.modelScore;
  }

  select(candidates: RawCandidateShape[], historyLabels: string[] = []): Promise<DiversificationResult> {
    return this.selectMany(candidates, historyLabels).then((r) => r);
  }

  async selectMany(candidates: RawCandidateShape[], historyLabels: string[] = []): Promise<DiversificationResult> {
    const sorted = [...candidates].sort((a, b) => b.modelScore - a.modelScore);
    const pool = sorted.filter((c) => c.resultingPrompt.trim().length > 0);
    if (pool.length === 0) {
      return { options: [], rejectedForDuplicate: [], poolSize: 0, embeddingProvider: this.embeddings.providerName };
    }
    const toEmbed = pool.map((c) => `${c.semanticGroup}: ${c.label} ${c.continuation}`);
    const vectors = await this.embeddings.embed(toEmbed);
    const historyVectors = historyLabels.length > 0 ? await this.embeddings.embed(historyLabels.slice(0, 8)) : [];

    const chosen: RawCandidateShape[] = [];
    const chosenVectors: number[][] = [];
    const rejectedForDuplicate: string[] = [];
    const available = new Set<number>(pool.map((_, i) => i));

    const canPick = (i: number): boolean => {
      if (vectors[0] === null && typeof vectors[0] !== "object") return true;
      if (!vectors[i]) return true;
      for (const hv of historyVectors) {
        if (cosineSimilarity(vectors[i], hv) > this.duplicateThreshold) return false;
      }
      for (let index = 0; index < chosenVectors.length; index++) {
        const sameGroup = chosen[index]?.semanticGroup === pool[i].semanticGroup;
        const similarity = cosineSimilarity(vectors[i], chosenVectors[index]);
        if (sameGroup || similarity > Math.max(0.92, this.duplicateThreshold)) return false;
      }
      return true;
    };

    while (chosen.length < 4 && available.size > 0) {
      let best: number | null = null;
      let bestScore = -Infinity;
      for (const i of available) {
        if (vectors[i] && !canPick(i)) {
          continue;
        }
        let novelty = 1;
        if (vectors[i]) {
          const sims = chosenVectors.map((cv) => cosineSimilarity(vectors[i], cv));
          novelty = 1 - (sims.length > 0 ? Math.max(...sims) : 0);
        }
        const score = (1 - this.noveltyWeight) * this.defaultScore(pool[i]) + this.noveltyWeight * novelty;
        if (score > bestScore) {
          bestScore = score;
          best = i;
        }
      }
      if (best === null) break;
      available.delete(best);
      if (!canPick(best)) {
        rejectedForDuplicate.push(pool[best].label);
        continue;
      }
      chosen.push(pool[best]);
      chosenVectors.push(vectors[best] ?? []);
    }

    for (const i of available) rejectedForDuplicate.push(pool[i].label);

    const options: DisplayOption[] = [];
    for (let i = 0; i < 4 && i < chosen.length; i++) {
      const candidate = chosen[i];
      options.push({
        id: candidate.id,
        quadrant: QUADRANT_ORDER[i],
        label: candidate.label,
        resultingPrompt: candidate.resultingPrompt,
        type: candidate.type,
        semanticGroup: candidate.semanticGroup,
        continuation: candidate.continuation,
      });
    }

    return {
      options,
      rejectedForDuplicate,
      poolSize: pool.length,
      embeddingProvider: this.embeddings.providerName,
    };
  }
}
