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
 *
 * ## Opt-in options (TASK-006)
 *
 *  - `prefix` (default off): when true, the FINAL token of each phrase gets a
 *    trailing FTS5 prefix postfix `*` (outside the phrase's closing quote, the
 *    `"a b"*` form that FTS5 accepts). Only the phrase-final token is starred,
 *    never a mid-phrase token. Powers autocomplete over a `prefix='n1 n2'`
 *    index; without such an index the `*` query still matches correctly but
 *    scans more tokens.
 *  - `stopwords` (default off): a token list removed from the word lists used
 *    to build phrases, mirroring the store's index-time `applyStopwords`
 *    filter so index and query stay symmetric. A chunk whose words are all
 *    stopwords is dropped entirely. The strict channel uses exact
 *    (`filterStopwords`) comparison; the loose channel uses the de-accented
 *    (`filterStopwordsLoose`) comparison.
 *  - `stem` (default off): opt-in English Porter stemming (`stemEn`) applied
 *    to ASCII word tokens only — Thai tokens pass through unchanged. Mirrors
 *    the store-level `stem` option so index and query stay symmetric.
 *    **Enabling it changes the indexed payload: existing indexes must be
 *    rebuilt after toggling it.** Default off keeps the query byte-identical.
 *  - `allTerms` (default off): join the per-chunk expressions with FTS5 `AND`
 *    instead of `OR`, so every whitespace-delimited chunk of a multi-word query
 *    must be present in a matching document. A chunk that expands into several
 *    synonym phrases is wrapped in parentheses — `(a OR b) AND c` — because
 *    FTS5 precedence is `NOT > AND > OR`, so an unparenthesized `a OR b AND c`
 *    would silently re-associate into `a OR (b AND c)`. A chunk with a single
 *    phrase stays parenthesized-free, so a one-chunk `allTerms` query is
 *    byte-identical to the default one. Default off keeps the OR-join output
 *    byte-identical.
 *
 * Whichever mode is used, only the FIRST `MAX_QUERY_CHUNKS` chunks of a query
 * are analyzed; `buildSearchQuery` reports the truncation on
 * `BuiltQuery.truncated` so adapters can surface it instead of silently
 * dropping terms.
 */
import { hasThai, looseForm, normalizeThaiInput, segmentQueryChunk } from "./segment.js";
import { expandChunkSynonyms } from "./synonyms.js";
import { filterStopwords, filterStopwordsLoose } from "./stopwords.js";
import { stemEn } from "./stem.js";
import type { BuiltQuery, QueryChunk, ToneMode } from "./types.js";

/** Hard cap on how many whitespace-delimited query chunks any builder will
 * analyze. Chunks past the cap are dropped — `buildSearchQuery` reports that
 * through `BuiltQuery.truncated` rather than failing silently. */
export const MAX_QUERY_CHUNKS = 8;

/** The ONE chunk plan every analyzer uses: the normalized chunks that will be
 * analyzed (at most `MAX_QUERY_CHUNKS`) plus whether the query carried more
 * chunks than the cap. Keeping the split here makes the 8-chunk rule a single
 * source of truth for the MATCH builders, `buildSearchQuery` and the adapter
 * helpers in `src/adapters/_align.ts`. */
export interface QueryChunkPlan {
  /** The analyzed chunks, in order (never more than `MAX_QUERY_CHUNKS`). */
  chunks: string[];
  /** True when the raw query had more chunks than `MAX_QUERY_CHUNKS`. */
  truncated: boolean;
}

/** Normalize a raw query and split it into the analyzed chunk plan (see
 * `QueryChunkPlan`). Pure; the single place the 8-chunk cap is applied. */
export function planQueryChunks(query: string): QueryChunkPlan {
  const rawChunks = normalizeThaiInput(String(query ?? ""))
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return {
    chunks: rawChunks.slice(0, MAX_QUERY_CHUNKS),
    truncated: rawChunks.length > MAX_QUERY_CHUNKS,
  };
}

/** Shared options for the MATCH builders. */
export interface MatchBuildOptions {
  /** Append a FTS5 prefix postfix `*` to each phrase's final token. */
  prefix?: boolean;
  /** Stopword tokens removed from the word lists before phrase building. */
  stopwords?: readonly string[];
  /** Opt-in English Porter stemming (`stemEn`) on ASCII word tokens only
   * (Thai tokens pass through unchanged). Symmetric with the store-level
   * `stem` option: enabling it changes the indexed payload, so existing
   * indexes must be rebuilt. Default off. */
  stem?: boolean;
  /** Join the per-chunk expressions with `AND` instead of the default `OR`, so
   * every analyzed chunk must appear in a matching document. Multi-phrase
   * (synonym-expanded) chunks get parenthesized — `(a OR b) AND c` — so FTS5's
   * `NOT > AND > OR` precedence cannot re-associate the expression. Default off
   * keeps the match string byte-identical. */
  allTerms?: boolean;
}

/** Token-list filter derived from `MatchBuildOptions.stopwords` (may be
 * undefined = no filtering). Kept as a function so the loose builder can use
 * the de-accented comparison without double-filtering. */
type FilterFn = (tokens: readonly string[]) => string[];

/** Opt-in Porter stem applied per token: ASCII words go through `stemEn`
 * (which lowercases them — FTS5's unicode61 lowercases both sides anyway),
 * Thai tokens pass through unchanged. Identity (no copy) when `stem` is off. */
function stemWords(words: readonly string[], stem: boolean): readonly string[] {
  if (!stem) return words;
  return words.map((w) => (hasThai(w) ? w : stemEn(w)));
}

function filterFor(opts: MatchBuildOptions | undefined, loose: boolean): FilterFn | undefined {
  const sw = opts?.stopwords;
  if (!sw || sw.length === 0) return undefined;
  return loose ? (ts) => filterStopwordsLoose(ts, sw) : (ts) => filterStopwords(ts, sw);
}

/** Build a single quoted phrase from tokens. When `prefix` is set, the FTS5
 * phrase-prefix postfix `*` lands AFTER the closing quote (`"a"*`, `"a b"*` —
 * the only form FTS5 treats as a prefix query; `"a b*"` would search a literal
 * `b*` token and match nothing). Returns null when filtering leaves no tokens. */
function buildPhrase(
  words: readonly string[],
  filter: FilterFn | undefined,
  prefix: boolean
): string | null {
  const list = filter ? filter(words) : words;
  if (list.length === 0) return null;
  const inner = list.map((t) => quoteFtsToken(t)).join(" ");
  return `"${inner}"${prefix ? "*" : ""}`;
}

/** Escape one token for use inside a quoted FTS5 phrase: backslashes doubled,
 * double-quotes doubled (FTS5 quote-escape convention). */
export function quoteFtsToken(t: string): string {
  return t.replace(/\\/g, "\\\\").replace(/"/g, '""');
}

/** Join one chunk's synonym phrases. In the default OR mode the chunk's parts
 * are simply `OR`-ed together (byte-identical to the historical output). In
 * `allTerms` mode the group is parenthesized when it holds more than one
 * phrase, so an enclosing `AND` cannot bind into it (FTS5 precedence is
 * `NOT > AND > OR`); a single-phrase chunk stays bare. */
function joinGroup(parts: readonly string[], allTerms: boolean): string {
  const first = parts[0]!;
  if (parts.length === 1) return first;
  const or = parts.join(" OR ");
  return allTerms ? `(${or})` : or;
}

export function buildFtsMatch(query: string, opts?: MatchBuildOptions): string {
  const chunks = planQueryChunks(query).chunks;
  const filter = filterFor(opts, false);
  const prefix = opts?.prefix === true;
  const stem = opts?.stem === true;
  const allTerms = opts?.allTerms === true;
  const out: string[] = [];
  for (const chunk of chunks) {
    const thai = hasThai(chunk);
    const words = stemWords(thai ? segmentQueryChunk(chunk) : [chunk], stem);
    const base = buildPhrase(words, filter, prefix);
    if (!base) continue;
    // A Thai chunk becomes a single ordered FTS5 phrase, NEVER OR-expanded here
    // (even when the chunk is a known synonym): buildFtsMatch("ติดตั้ง") must
    // stay one ordered phrase, and the TH->EN bridge is already covered at
    // index time (expandIndexedText) plus the ASCII-chunk expansion below.
    if (thai) {
      out.push(base);
      continue;
    }
    // Known ASCII chunk: OR the transliteration counterpart phrase(s) in, so
    // e.g. `deploy` also matches the Thai "ดี พลอย" token stream.
    const variants = expandChunkSynonyms(chunk);
    if (variants.length <= 1) {
      out.push(base);
      continue;
    }
    const parts: string[] = [base];
    for (const v of variants.slice(1)) {
      const vw = stemWords(hasThai(v) ? segmentQueryChunk(v) : [v], stem);
      const vp = buildPhrase(vw, filter, prefix);
      if (vp) parts.push(vp);
    }
    out.push(joinGroup(parts, allTerms));
  }
  return out.join(allTerms ? " AND " : " OR ");
}

/**
 * Query-side twin of buildFtsMatch for the de-accented LOOSE channel. Mirrors
 * buildFtsMatch's structure exactly — Thai chunk -> single ordered phrase,
 * ASCII chunk -> OR the transliteration counterpart(s) in — but the Thai path
 * segments the RAW chunk first, then routes each token through looseForm()
 * (strips only Thai tone-level marks, keeps vowels, lowercases), mirroring the
 * index side looseForm(buildIndexPayload(...)) chain exactly: "ติดตั้ง"
 * and "ติดตัง" both become the same loose phrase here, so a tone-mark typo can
 * still match the correctly-marked document. For pure-ASCII queries looseForm
 * is only a lowercase, so buildLooseFtsMatch ≡ buildFtsMatch's match set (FTS5
 * case-folds) and the loose channel adds nothing.
 */
export function buildLooseFtsMatch(query: string, opts?: MatchBuildOptions): string {
  const chunks = planQueryChunks(query).chunks;
  // Stopword filtering on the loose side compares in de-accented form, so a
  // tone-mark typo in a stopword still drops the same token the index removed.
  const filter = filterFor(opts, true);
  const prefix = opts?.prefix === true;
  const stem = opts?.stem === true;
  const allTerms = opts?.allTerms === true;
  const out: string[] = [];
  for (const chunkRaw of chunks) {
    const thai = hasThai(chunkRaw);
    const chunk = looseForm(chunkRaw);
    // With `stem` on, the ASCII-chunk synonym expansion runs on the STEMMED
    // chunk: the unstemmed index tokens survive the expandIndexedText pass
    // verbatim (e.g. "install" stays in the payload alongside its stemmed
    // form "instal"), so an unstemmed whole-chunk lookup must stay available
    // or a stemmed query could miss docs whose only copy is the unstemmed
    // token. Thai chunks are untouched by the stem either way.
    const asciiChunk = stem && !thai ? stemEn(chunk) : chunk;
    const words = stemWords(thai ? segmentQueryChunk(chunkRaw).map(looseForm) : [chunk], stem);
    const base = buildPhrase(words, filter, prefix);
    if (!base) continue;
    if (thai) {
      out.push(base);
      continue;
    }
    const variants = expandChunkSynonyms(asciiChunk);
    if (variants.length <= 1) {
      out.push(base);
      continue;
    }
    const parts: string[] = [base];
    for (const v of variants.slice(1)) {
      const vw = stemWords(hasThai(v) ? segmentQueryChunk(v).map(looseForm) : [looseForm(v)], stem);
      const vp = buildPhrase(vw, filter, prefix);
      if (vp) parts.push(vp);
    }
    out.push(joinGroup(parts, allTerms));
  }
  return out.join(allTerms ? " AND " : " OR ");
}

/** Options accepted by `buildSearchQuery`. `mode` + the MATCH-builder opts. */
export interface SearchQueryOptions extends MatchBuildOptions {
  mode?: ToneMode;
}

/**
 * Structured variant of the MATCH builders for future adapters: split the query
 * into its whitespace-delimited chunks (max 8, like the builders), analyze each
 * chunk, and return both the strict and the loose MATCH expressions alongside.
 * `mode` is the resolved tone mode (defaults to "both" / strict-first) so an
 * adapter can pick a channel without re-deriving policy. `prefix`/`stopwords`/
 * `stem`/`allTerms` are threaded into both match expressions (see
 * `MatchBuildOptions`). `truncated` is true when the query carried more than
 * `MAX_QUERY_CHUNKS` chunks — the ones past the cap are dropped from every
 * expression, so an adapter must surface it rather than let the user read a
 * silently narrowed result set as a complete one.
 */
export function buildSearchQuery(
  query: string,
  opts?: ToneMode | SearchQueryOptions
): BuiltQuery {
  const tone = resolveTone(opts);
  const objectOpts = typeof opts === "object" && opts !== null ? (opts as SearchQueryOptions) : undefined;
  const prefix = objectOpts?.prefix;
  const stopwords = objectOpts?.stopwords;
  const stem = objectOpts?.stem;
  const allTerms = objectOpts?.allTerms;
  const plan = planQueryChunks(query);
  const truncated = plan.truncated;
  const chunkTexts = plan.chunks;
  const chunks: QueryChunk[] = chunkTexts.map((raw) => {
    const thai = hasThai(raw);
    const words = thai ? segmentQueryChunk(raw) : [raw];
    const synonyms = thai ? [] : expandChunkSynonyms(raw).slice(1);
    return { raw, thai, words, synonyms };
  });
  return {
    mode: tone,
    chunks,
    truncated,
    match: buildFtsMatch(query, { prefix, stopwords, stem, allTerms }),
    looseMatch: buildLooseFtsMatch(query, { prefix, stopwords, stem, allTerms }),
  };
}

function resolveTone(opts?: ToneMode | { mode?: ToneMode } | null): ToneMode {
  const t = opts == null ? undefined : typeof opts === "string" ? opts : opts.mode;
  return t === "strict" || t === "loose" || t === "both" ? t : "both";
}
