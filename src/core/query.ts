/**
 * Pure FTS5 MATCH-expression builders for Thai queries. Extracted from the
 * database layer so adapters (SQLite FTS5, future engines) can reuse them
 * without a DB. Imports only the pure core modules — no Node built-ins, no
 * database.
 *
 * Both builders mirror the same index-time transform:
 *  - a Thai chunk becomes an ordered FTS5 phrase of its words ("ติด ตั้ง เร็ว"),
 *    matching how `segmentForIndex` stored the text — never OR-expanded, so a
 *    tone typo like ติดตัง cannot collide with ติดตั้ง on the strict channel;
 *  - an ASCII chunk whose transliteration is known ORs its counterpart
 *    phrase(s) in, so `deploy` also matches the Thai "ดี พลอย" token stream.
 *
 * `buildLooseFtsMatch` is the de-accented twin for the LOOSE channel: every
 * chunk passes through `looseForm` (tone marks stripped), so "ติดตั้ง" and
 * "ติดตัง" become the same loose phrase and a tone-mark typo can still match a
 * correctly-marked document. For pure-ASCII queries it is just a lowercase, so
 * it matches the same docs as the strict channel there.
 *
 * All three builders normalize the raw query (`normalizeThaiInput`) at the
 * chunk-split point, mirroring the index side — so hidden zero-width
 * characters embedded in a query Thai word behave exactly like the same word
 * indexed cleanly, keeping the index and query transforms symmetric.
 */
import { hasThai, looseForm, normalizeThaiInput, segmentQueryChunk } from "./segment.js";
import { expandChunkSynonyms } from "./synonyms.js";
import type { BuiltQuery, QueryChunk, ToneMode } from "./types.js";

/** Escape one token for use inside a quoted FTS5 phrase: backslashes doubled,
 * double-quotes doubled (FTS5 quote-escape convention). */
export function quoteFtsToken(t: string): string {
  return t.replace(/\\/g, "\\\\").replace(/"/g, '""');
}

export function buildFtsMatch(query: string): string {
  const chunks = normalizeThaiInput(query).trim().split(/\s+/).filter(Boolean).slice(0, 8);
  return chunks
    .map((chunk) => {
      // A Thai chunk becomes an FTS5 phrase of its words: "ติด ตั้ง เร็ว"
      // matches the words in order, mirroring how the index was segmented.
      // Thai chunks are NEVER OR-expanded here (even when the chunk is a known
      // synonym): buildFtsMatch("ติดตั้ง") must stay a single ordered phrase,
      // and the TH->EN bridge is already covered at index time
      // (expandIndexedText) plus the ASCII-chunk expansion below.
      const words = hasThai(chunk) ? segmentQueryChunk(chunk) : [chunk];
      const phrase = (words.length > 0 ? words : [chunk]).map(quoteFtsToken).join(" ");
      const base = `"${phrase}"`;
      if (hasThai(chunk)) return base;
      // Known ASCII chunk: OR the transliteration counterpart phrase(s) in, so
      // e.g. `deploy` also matches the Thai "ดี พลอย" token stream.
      const variants = expandChunkSynonyms(chunk);
      if (variants.length <= 1) return base;
      const alternatives = variants
        .slice(1)
        .map((v) => {
          const vw = hasThai(v) ? segmentQueryChunk(v) : [v];
          const vp = (vw.length > 0 ? vw : [v]).map(quoteFtsToken).join(" ");
          return `"${vp}"`;
        });
      return [base, ...alternatives].join(" OR ");
    })
    .join(" OR ");
}

/**
 * Query-side twin of buildFtsMatch for the de-accented LOOSE channel. Mirrors
 * buildFtsMatch's structure exactly — Thai chunk -> single ordered phrase,
 * ASCII chunk -> OR the transliteration counterpart(s) in — but every chunk is
 * first routed through looseForm() (strips only Thai tone-level marks, keeps
 * vowels, lowercases). This is what makes the transform chain agree with the
 * loose index rows (which store looseForm of the strict payload): "ติดตั้ง"
 * and "ติดตัง" both become the same loose phrase here, so a tone-mark typo can
 * still match the correctly-marked document. For pure-ASCII queries looseForm
 * is only a lowercase, so buildLooseFtsMatch ≡ buildFtsMatch's match set (FTS5
 * case-folds) and the loose channel adds nothing.
 */
export function buildLooseFtsMatch(query: string): string {
  const chunks = normalizeThaiInput(query).trim().split(/\s+/).filter(Boolean).slice(0, 8);
  return chunks
    .map((chunkRaw) => {
      const chunk = looseForm(chunkRaw);
      const thai = hasThai(chunk);
      const words = thai ? segmentQueryChunk(chunk) : [chunk];
      const phrase = (words.length > 0 ? words : [chunk]).map(quoteFtsToken).join(" ");
      const base = `"${phrase}"`;
      if (thai) return base;
      const variants = expandChunkSynonyms(chunk);
      if (variants.length <= 1) return base;
      const alternatives = variants
        .slice(1)
        .map((v) => {
          const vl = looseForm(v);
          const vw = hasThai(vl) ? segmentQueryChunk(vl) : [vl];
          const vp = (vw.length > 0 ? vw : [vl]).map(quoteFtsToken).join(" ");
          return `"${vp}"`;
        });
      return [base, ...alternatives].join(" OR ");
    })
    .join(" OR ");
}

/**
 * Structured variant of the MATCH builders for future adapters: split the query
 * into its whitespace-delimited chunks (max 8, like the builders), analyze each
 * chunk, and return both the strict and the loose MATCH expressions alongside.
 * `mode` is the resolved tone mode (defaults to "both" / strict-first) so an
 * adapter can pick a channel without re-deriving policy.
 */
export function buildSearchQuery(
  query: string,
  mode?: ToneMode | { mode?: ToneMode }
): BuiltQuery {
  const tone = resolveTone(mode);
  const chunkTexts = normalizeThaiInput(query).trim().split(/\s+/).filter(Boolean).slice(0, 8);
  const chunks: QueryChunk[] = chunkTexts.map((raw) => {
    const thai = hasThai(raw);
    const words = thai ? segmentQueryChunk(raw) : [raw];
    const synonyms = thai ? [] : expandChunkSynonyms(raw).slice(1);
    return { raw, thai, words, synonyms };
  });
  return {
    mode: tone,
    chunks,
    match: buildFtsMatch(query),
    looseMatch: buildLooseFtsMatch(query),
  };
}

function resolveTone(opts?: ToneMode | { mode?: ToneMode } | null): ToneMode {
  const t = opts == null ? undefined : typeof opts === "string" ? opts : opts.mode;
  return t === "strict" || t === "loose" || t === "both" ? t : "both";
}
