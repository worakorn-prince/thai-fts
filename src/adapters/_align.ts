/**
 * Shared INTERNAL search utilities for the adapter layer (`src/adapters/*`).
 * Module-private by convention — the `_` prefix marks it as non-public; it is
 * not re-exported from any subpath entry and never appears in the public API.
 *
 * Contents:
 *  - `mapSegmentedToRaw` / `regionToRawOffsets` — the verified raw-offset
 *    alignment (moved out of `fts5/search.ts` so the fts5 and memory adapters
 *    share ONE implementation and can never drift);
 *  - `MAX_OFFSET_OCCURRENCES` — the cap on verified multi-occurrence offsets;
 *  - `clampLimit` / `makeSnippet` / `buildNeedles` — the search-plumbing
 *    helpers every local adapter mirrors from the fts5 reference;
 *  - `buildIndexPayload` / `buildChannelPhrases` — the symmetric index-time
 *    and query-time token pipelines (segment → expand → stopwords → opt-in
 *    ASCII stem) shared by the local and the reference HTTP adapters.
 *
 * Pure for the alignment parts (no I/O); the pipeline helpers import only the
 * pure core — no Node built-ins, no database, no npm packages.
 */
import {
  hasThai,
  looseForm,
  normalizeThaiInput,
  segmentForIndex,
  segmentQueryChunk,
} from "../core/segment.js";
import { expandIndexedText } from "../core/synonyms.js";
import {
  applyStopwords,
  filterStopwords,
  filterStopwordsLoose,
} from "../core/stopwords.js";
import { stemEn } from "../core/stem.js";
import { MAX_QUERY_CHUNKS } from "../core/query.js";

/** Verified raw-text offset of a matched region (RAW document coordinates). */
export interface VerifiedOffset {
  quote: string;
  start: number;
  end: number;
}

/**
 * Multi-occurrence cap (TASK-009): when `offsets` is requested, at most this
 * many verified `occurrences` are returned per hit, in document order. The
 * first entry is always the primary `quote`/`start`/`end`.
 */
export const MAX_OFFSET_OCCURRENCES = 3;

/**
 * Two-pointer alignment between a RAW document string and its SEGMENTED index
 * payload. The segmented payload is the raw text with spaces inserted between
 * Thai words (segmentForIndex) plus, possibly, appended synonym tokens that do
 * not exist in the raw text at all.
 *
 * Walk both strings: an inserted whitespace char in `segmented` maps to `null`
 * (the raw pointer does not advance); every other char maps to the NEXT
 * NON-whitespace raw index (raw's own whitespace is skipped — the segmented
 * payload normalizes separators, so raw spaces/tabs/newlines have no
 * counterpart in it). Content that has no raw counterpart (appended synonym
 * tokens past the end of `raw`) maps to `null` so it can never produce a
 * fabricated offset. The caller validates the result by re-slicing `raw` and
 * comparing it with the de-spaced quote — a mismatch means the offset cannot
 * be trusted and is dropped.
 */
export function mapSegmentedToRaw(
  raw: string,
  segmented: string
): Array<number | null> {
  const text = String(raw ?? "");
  const seg = String(segmented ?? "");
  const out: Array<number | null> = [];
  const isWs = (c: string | undefined): boolean =>
    c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v";
  let ri = 0;
  for (let i = 0; i < seg.length; i++) {
    const ch = seg[i] as string;
    if (isWs(ch)) {
      out.push(null);
      continue;
    }
    // Advance the raw pointer to the next NON-whitespace raw char: the
    // segmented payload normalizes separators, so raw's own whitespace has
    // no counterpart in it (consuming it would drift every later mapping).
    while (ri < text.length && isWs(text[ri])) ri += 1;
    if (ri < text.length) {
      out.push(ri);
      ri += 1;
    } else {
      out.push(null);
    }
  }
  return out;
}

/**
 * Map one matched region back to RAW document coordinates and verify it.
 *
 * `seg` is the de-marked segmented text of the region and `storedStart` its
 * character position inside the stored payload `stored` (the exact string the
 * index holds for that column). The non-whitespace chars of the region must
 * map to a CONTIGUOUS raw stretch — any gap means the region includes content
 * with no raw home (e.g. an appended synonym, or a loose-channel region whose
 * tone marks stripped in the index), so the offset cannot be trusted. The
 * result is validated by re-slicing `raw`; a mismatch returns undefined.
 * A wrong offset is NEVER emitted.
 */
export function regionToRawOffsets(
  raw: string,
  stored: string,
  seg: string,
  storedStart: number
): VerifiedOffset | undefined {
  const mapped = mapSegmentedToRaw(raw, stored);
  const positions = mapped.slice(storedStart, storedStart + seg.length);
  const pos: number[] = [];
  for (const p of positions) {
    if (p !== null) pos.push(p);
  }
  if (pos.length === 0) return undefined;
  let contiguous = true;
  for (let k = 1; k < pos.length; k++) {
    if (pos[k] !== (pos[k - 1] as number) + 1) {
      contiguous = false;
      break;
    }
  }
  if (!contiguous) return undefined;
  const start = pos[0] as number;
  const end = (pos[pos.length - 1] as number) + 1;
  const deSpaced = seg.replace(/\s+/g, "");
  const slice = raw.slice(start, end);
  if (slice !== deSpaced) return undefined;
  return { quote: slice, start, end };
}

/* ------------------------------------------------------------------ *
 * search plumbing (mirrored from the fts5 reference adapter)
 * ------------------------------------------------------------------ */

export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 200;

/** Clamp a per-search `limit` to a sane 1..MAX_LIMIT range (fts5 semantics). */
export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || limit === null) return DEFAULT_LIMIT;
  const n = Math.floor(Number(limit));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, MAX_LIMIT);
}

/**
 * Small window of text around the first query-token hit in title/body, for the
 * optional `snippet` field. Returns undefined when there is no recognizable
 * text (the caller may still surface the title).
 */
export function makeSnippet(
  title: string,
  body: string,
  needles: readonly string[]
): string | undefined {
  const text = `${title} ${body}`.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  const lower = text.toLowerCase();
  let best = -1;
  let bestLen = 0;
  for (const n of needles) {
    if (!n) continue;
    const idx = lower.indexOf(n.toLowerCase());
    if (idx !== -1 && (best === -1 || idx < best)) {
      best = idx;
      bestLen = n.length;
    }
  }
  if (best === -1) {
    return text.length > 120 ? `${text.slice(0, 120)}…` : text;
  }
  const start = Math.max(0, best - 30);
  const end = Math.min(text.length, best + bestLen + 60);
  const pre = start > 0 ? "…" : "";
  const post = end < text.length ? "…" : "";
  return `${pre}${text.slice(start, end)}${post}`;
}

/** Snippet needles: raw chunks plus their segmented words, lowercased dedupe. */
export function buildNeedles(query: string): string[] {
  const needles = new Set<string>();
  for (const chunk of String(query ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 8)) {
    needles.add(chunk);
    for (const w of segmentQueryChunk(chunk)) needles.add(w);
  }
  return [...needles];
}

/* ------------------------------------------------------------------ *
 * symmetric index/query token pipeline (shared by all adapters)
 * ------------------------------------------------------------------ */

/**
 * Index-time transform for ONE text (title or body), mirroring the fts5 store
 * pipeline: `segmentForIndex` → `expandIndexedText` (synonyms) → optional
 * `applyStopwords`, then (opt-in) `stemEn` on every token — `stemEn` is
 * ASCII-only, so Thai tokens pass through unchanged and the pipeline stays
 * byte-idempotent (a second pass is a fixed point). With `stopwords` empty and
 * `stem` off the output is byte-identical to the legacy fts5 path.
 */
export function buildIndexPayload(
  text: string,
  stopwords: readonly string[],
  stem: boolean
): string {
  const base = applyStopwords(expandIndexedText(segmentForIndex(String(text ?? ""))), stopwords);
  if (!stem) return base;
  const tokens = base.split(/\s+/).filter(Boolean);
  return tokens.map((t) => stemEn(t)).join(" ");
}

/** Per-channel query word lists for one query (max `MAX_QUERY_CHUNKS` chunks). */
export interface ChannelPhrases {
  /** Strict channel: one word list per query chunk (empty list = no chunk). */
  strict: string[][];
  /** Loose channel: the de-accented twin of `strict`. */
  loose: string[][];
  /** True when the raw query held more than `MAX_QUERY_CHUNKS` chunks, so the
   * ones past the cap are absent from both channels. Adapters surface this as
   * `meta.truncated` rather than letting a narrowed query read as complete. */
  truncated: boolean;
}

/**
 * Query-side twin of `buildIndexPayload` for adapters that match on word
 * arrays (memory) or send phrase text (Meilisearch/Elasticsearch). Each chunk
 * becomes an ordered word list:
 *
 *  - strict: Thai chunks are segmented (`segmentQueryChunk`); non-Thai chunks
 *    are the chunk itself (lowercased — local adapters casefold like FTS5's
 *    unicode61 does);
 *  - loose: every chunk first passes through `looseForm` (tone marks
 *    stripped, lowercased), then the same rules;
 *  - opt-in `stem`: ASCII word lists are passed through `stemEn` (Thai tokens
 *    pass through unchanged) — symmetric with the index-side `stem` option;
 *  - stopwords: the strict list uses exact comparison (`filterStopwords`),
 *    the loose list the de-accented one (`filterStopwordsLoose`), mirroring
 *    the index-time removal so a chunk whose words are all stopwords is
 *    dropped entirely.
 *
 * Word lists are lowercased so they match the lowercased index tokens the
 * adapters store for matching (the stored payload strings keep original case
 * for offset mapping).
 */
export function buildChannelPhrases(
  query: string,
  stopwords: readonly string[],
  stem: boolean
): ChannelPhrases {
  const rawChunks = normalizeThaiInput(String(query ?? ""))
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const truncated = rawChunks.length > MAX_QUERY_CHUNKS;
  const chunks = rawChunks.slice(0, MAX_QUERY_CHUNKS);
  const strict: string[][] = [];
  const loose: string[][] = [];
  for (const chunk of chunks) {
    const mk = (words: string[], looseChannel: boolean): string[] => {
      const stemmed = stem
        ? words.map((w) => (hasThai(w) ? w : stemEn(w)))
        : words;
      const list = stemmed.map((w) => (hasThai(w) ? w : w.toLowerCase()));
      return looseChannel ? filterStopwordsLoose(list, stopwords) : filterStopwords(list, stopwords);
    };
    const sThai = hasThai(chunk);
    strict.push(mk(sThai ? segmentQueryChunk(chunk) : [chunk], false));
    const lChunk = looseForm(chunk);
    const lThai = hasThai(lChunk);
    loose.push(mk(lThai ? segmentQueryChunk(lChunk) : [lChunk], true));
  }
  return { strict, loose, truncated };
}
