export interface SemanticEmbeddingProvider {
  readonly name: string;
  readonly available: boolean;
  embed(texts: string[]): Promise<number[][] | null>;
}

function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
}

function trigrams(text: string): Set<string> {
  const clean = ` ${text.toLowerCase().trim()} `;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= clean.length; i++) out.add(clean.slice(i, i + 3));
  return out;
}

function lexicalVector(text: string): Float64Array {
  const v = new Float64Array(128);
  let seed = 17;
  const words = tokenize(text);
  const grams = trigrams(text);
  for (const w of words) {
    let h = seed;
    for (const c of w) h = (h * 31 + c.codePointAt(0)!) % 997;
    v[h % 128] += 1;
  }
  for (const g of grams) {
    let h = seed;
    for (const c of g) h = (h * 31 + c.codePointAt(0)!) % 997;
    v[(h % 64) + 64] += 0.5;
  }
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  for (let i = 0; i < v.length; i++) v[i] = norm > 0 ? v[i] / norm : 0;
  return v;
}

export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

class LexicalEmbeddingProvider implements SemanticEmbeddingProvider {
  readonly name = "lexical-trigram";
  readonly available = true;
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => Array.from(lexicalVector(t)));
  }
}

class TransformersJsMiniLMProvider implements SemanticEmbeddingProvider {
  readonly name = "transformersjs-minilm-l6-v2";
  available = false;
  private extractor: ((texts: string[], options: { pooling: "mean"; normalize: true }) => Promise<{ data: Float32Array; dims: number[] }>) | null = null;
  private worker: Promise<boolean> | null = null;

  private load(): Promise<boolean> {
    if (this.worker) return this.worker;
    this.worker = (async () => {
      try {
        const mod = await import("@huggingface/transformers");
        if (!mod.pipeline) return false;
        const featureExtractor = await mod.pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
          dtype: "fp32",
        });
        this.extractor = featureExtractor as unknown as typeof this.extractor;
        this.available = this.extractor != null;
        return this.available;
      } catch {
        this.available = false;
        return false;
      }
    })();
    return this.worker;
  }

  async embed(texts: string[]): Promise<number[][] | null> {
    if (!(await this.load()) || !this.extractor) return null;
    try {
      if (texts.length === 0) return [];
      const res = await this.extractor(texts, { pooling: "mean", normalize: true });
      const rows = res.dims[0] ?? texts.length;
      const width = res.dims[1] ?? Math.trunc(res.data.length / Math.max(1, rows));
      if (rows !== texts.length || width <= 0) return null;
      return Array.from({ length: rows }, (_, row) =>
        Array.from(res.data.slice(row * width, (row + 1) * width))
      );
    } catch {
      this.available = false;
      return null;
    }
  }
}

export class EmbeddingHub {
  private lexical = new LexicalEmbeddingProvider();
  private minilm = new TransformersJsMiniLMProvider();
  private preferred: SemanticEmbeddingProvider = this.minilm;

  constructor(preferMiniLm: boolean = true) {
    if (!preferMiniLm) this.preferred = this.lexical;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (this.preferred === this.minilm && this.minilm.available === false && !texts.length) {
      return this.lexical.embed(texts);
    }
    const res = await this.preferred.embed(texts);
    if (res !== null) return res;
    return this.lexical.embed(texts);
  }

  get providerName(): string {
    return this.preferred.available ? this.preferred.name : `fallback:${this.lexical.name}`;
  }
}
