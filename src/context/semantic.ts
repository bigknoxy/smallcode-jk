import type { FileMap } from "./types.ts";

/**
 * Semantic retrieval (opt-in, `SMALLCODE_SEMANTIC_RETRIEVAL=1`, default OFF).
 *
 * The lexical scorer (`scoreFiles`) can only localize a task to a file when they
 * share a WORD — a task that says "cycle its focus across files" cannot reach
 * `carousel.ts` because no token overlaps. That is the measured lexical ceiling
 * (blind localization probe: top-1 ~31%). This module adds a MEANING signal:
 * embed a compact profile of each file and the task query with a LOCAL Ollama
 * embedding model (fully offline — consistent with the north star), cosine-rank,
 * and fuse the similarity into the lexical score as an additive boost that can
 * resurrect a lexically-zero definer without letting weak matches dominate.
 *
 * Pure except `embedTexts`, which is the only network touch (local Ollama).
 */

/** Embed a batch of texts → one vector per text. The single injection seam. */
export type EmbedFn = (texts: string[]) => Promise<number[][]>;

export interface EmbedClientOptions {
  baseUrl: string; // OpenAI-compatible base, e.g. http://localhost:11434/v1
  model: string; // e.g. nomic-embed-text
  apiKey?: string;
  timeoutMs?: number;
}

/**
 * Make an {@link EmbedFn} backed by an OpenAI-compatible `/embeddings` endpoint
 * (Ollama serves this locally). Batches every text in one request; returns
 * vectors in input order. Throws on a non-2xx or malformed response — callers
 * that want retrieval to DEGRADE to lexical-only on an embedding failure should
 * catch and fall back (see `computeSemanticScores`).
 */
export function makeOllamaEmbedder(opts: EmbedClientOptions): EmbedFn {
  const base = opts.baseUrl.replace(/\/$/, "");
  const timeoutMs = opts.timeoutMs ?? 120_000;
  return async (texts: string[]): Promise<number[][]> => {
    if (texts.length === 0) return [];
    const res = await fetch(`${base}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(opts.apiKey && opts.apiKey !== "none"
          ? { authorization: `Bearer ${opts.apiKey}` }
          : {}),
      },
      body: JSON.stringify({ model: opts.model, input: texts }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`embeddings request failed: ${res.status} ${res.statusText}`);
    }
    const json = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
    const data = json.data;
    if (!Array.isArray(data) || data.length !== texts.length) {
      throw new Error(`embeddings response shape mismatch: got ${data?.length} for ${texts.length}`);
    }
    return data.map((d) => {
      if (!Array.isArray(d.embedding)) throw new Error("embeddings response missing vector");
      return d.embedding;
    });
  };
}

/**
 * Compact semantic profile of a file: its path plus the identifiers and
 * signatures it defines. Deliberately excludes full file BODIES — the symbol
 * surface is what a task refers to, and embedding whole files would blow the
 * batch cost and dilute the signal with boilerplate. nomic-style models want a
 * task prefix; callers add `search_document:` / `search_query:` (see below).
 */
export function fileProfile(fileMap: FileMap): string {
  const names = fileMap.symbols.map((s) => s.signature ?? s.name);
  // De-dup while preserving order; cap so one huge file can't dominate a batch.
  const seen = new Set<string>();
  const uniq: string[] = [];
  for (const n of names) {
    if (seen.has(n)) continue;
    seen.add(n);
    uniq.push(n);
    if (uniq.length >= 60) break;
  }
  return `${fileMap.path}\n${uniq.join("\n")}`;
}

/** Cosine similarity of two equal-length vectors; 0 if either is degenerate. */
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Cosine floor below which a file's semantic similarity contributes NOTHING.
 * nomic-embed cosine for a genuinely related task/file pair sits well above this;
 * unrelated pairs cluster lower. Thresholding keeps a diffuse "everything is a
 * little similar" haze from lifting every file above zero (which would defeat the
 * lexical score>0 target gate). Tuned on the localization probes.
 */
export const SEMANTIC_THRESHOLD = ((): number => {
  const v = Number(process.env["SMALLCODE_SEMANTIC_THRESHOLD"]);
  return Number.isFinite(v) && v > 0 && v < 1 ? v : 0.55;
})();

/**
 * Max additive boost a perfect (cosine=1) semantic match adds to a file's
 * lexical score. Set high enough that a strong semantic hit can resurrect a
 * lexically-ZERO definer above a mid-size decoy's partial-match pile, but not so
 * high that a marginal (just-over-threshold) match dominates an exact lexical
 * signal. Tuned on the blind localization probe.
 */
export const SEMANTIC_WEIGHT = ((): number => {
  const v = Number(process.env["SMALLCODE_SEMANTIC_WEIGHT"]);
  return Number.isFinite(v) && v > 0 ? v : 100;
})();

/**
 * Map each file path → its additive semantic boost for `query`. Embeds the query
 * and every file profile with `embed`, cosine-ranks, and scales the above-floor
 * similarity into `[0, SEMANTIC_WEIGHT]`. Returns an EMPTY map (retrieval
 * degrades to lexical-only) if embedding throws — a down/absent local embedder
 * must never break a run. `search_query:` / `search_document:` prefixes follow
 * the nomic convention (measurably better asymmetric retrieval).
 */
export async function computeSemanticScores(
  query: string,
  files: FileMap[],
  embed: EmbedFn,
  docVectors?: number[][],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (files.length === 0) return out;
  try {
    // File profile vectors are query-INDEPENDENT — embed them once and pass
    // `docVectors` back on later queries (the production path builds this index
    // once per run; the probe reuses it across all cases). Absent → embed inline.
    let docs = docVectors;
    if (!docs) {
      docs = await embed(files.map((f) => `search_document: ${fileProfile(f)}`));
    }
    const [queryVec] = await embed([`search_query: ${query}`]);
    if (!queryVec) return out;
    for (let i = 0; i < files.length; i++) {
      const dv = docs[i];
      if (!dv) continue;
      const sim = cosine(queryVec, dv);
      if (sim <= SEMANTIC_THRESHOLD) continue;
      const scaled = (SEMANTIC_WEIGHT * (sim - SEMANTIC_THRESHOLD)) / (1 - SEMANTIC_THRESHOLD);
      out.set(files[i]!.path, scaled);
    }
    return out;
  } catch {
    return out; // degrade to lexical-only
  }
}

/**
 * Embed every file's profile once → the query-independent document index reused
 * across queries (see `computeSemanticScores`'s `docVectors`). Returns null on
 * failure so callers degrade to lexical-only.
 */
export async function embedFileIndex(
  files: FileMap[],
  embed: EmbedFn,
): Promise<number[][] | null> {
  if (files.length === 0) return [];
  try {
    return await embed(files.map((f) => `search_document: ${fileProfile(f)}`));
  } catch {
    return null;
  }
}
