/**
 * Shared public types for the thai-fts core. Pure type declarations — no
 * runtime value, no imports, safe for any consumer to reference.
 */

/**
 * Tone-handling mode for query construction / matching.
 * - "strict": tone-exact channel only (FTS keeps tone marks significant).
 * - "loose": de-accented channel only (tone marks stripped by `looseForm`).
 * - "both": dual-channel — build both and let the caller/DB decide, strict
 *   first. This is the default resolution.
 */
export type ToneMode = "strict" | "loose" | "both";

/** One whitespace-delimited query chunk after structural analysis. */
export interface QueryChunk {
  /** The raw chunk exactly as it appeared in the input query. */
  raw: string;
  /** Whether the chunk contains any Thai characters (U+0E00..U+0E7F). */
  thai: boolean;
  /**
   * Word tokens for the chunk. Thai chunks are segmented via
   * `segmentQueryChunk`; ASCII chunks are the chunk itself.
   */
  words: string[];
  /**
   * Synonym counterparts for ASCII chunks (from `expandChunkSynonyms`, minus
   * the chunk itself). Empty for Thai chunks — Thai stays strict/ordered.
   */
  synonyms: string[];
}

/** Structured output of `buildSearchQuery` — one row per future adapter. */
export interface BuiltQuery {
  /** The resolved tone mode (defaults to "both"/strict-first). */
  mode: ToneMode;
  /** Per-chunk structural analysis of the raw query. */
  chunks: QueryChunk[];
  /** FTS5 match expression for the strict (mark-aware) channel. */
  match: string;
  /** FTS5 match expression for the loose (de-accented) channel. */
  looseMatch: string;
  /** True when the raw query carried more than `MAX_QUERY_CHUNKS` chunks, so
   * the ones past the cap were dropped from every expression. Adapters surface
   * this on `meta.truncated` instead of letting it read as a complete query. */
  truncated: boolean;
}

/**
 * A registered Thai dictionary definition. `words` are treated as forced
 * compounds by the segmenter (kept whole as one token), `synonyms` feed the
 * bidirectional transliteration synonym layer, and `overrides` are explicit
 * term → fixed token overrides with the same merge semantics as
 * `setSegmentOverrideProvider`.
 */
export interface ThaiDictionaryDef {
  /** Stable unique id used to overwrite the same dictionary on re-register. */
  id: string;
  /** Words that must stay a single token after segmentation. */
  words?: readonly string[];
  /** `[en, th]`-style transliteration/semantic synonym pairs. */
  synonyms?: readonly (readonly [string, string])[];
  /** Explicit term → fixed single-token overrides. */
  overrides?: readonly { term: string; fixed: string }[];
}
