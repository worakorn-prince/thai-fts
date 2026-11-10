/**
 * Dual-channel FTS5 search over a store opened by `openFts5Store`. Implements
 * the tone-tiered retrieval contract:
 *
 *  - STRICT channel first (mark-aware index): ติดตั้ง ≠ ติดตัง, authoritative,
 *    ordered by FTS5 rank;
 *  - LOOSE channel appended BELOW strict only while the strict channel is
 *    short of the limit, deduped by id — a loose-only hit never displaces a
 *    strict hit, so the merge is deterministic (strict-then-loose).
 *
 * Two special paths keep the behavior predictable for awkward inputs:
 *  - 1–2 char pure-Thai queries fall back to a SQL LIKE scan (reported as
 *    `meta.method = "like_fallback"`, never a silent empty FTS miss);
 *  - query text (quotes, backslashes, `* - NEAR` …) is routed through the
 *    core MATCH builders, which quote-escape every token, so adversarial
 *    input cannot throw a SQL syntax error.
 *
 * An optional `filter` predicate (caller-owned, e.g. status/scope checks) is
 * applied per candidate row on each channel BEFORE the limit is accounted, so
 * filtered-out rows cannot starve in-scope hits (it is applied in JS to the
 * row shape `{ id, title, body }`).
 *
 * ## Opt-in features (TASK-006, all default off)
 *
 *  - `prefix` — autocomplete: the query builders append an FTS5 prefix `*` to
 *    each phrase's final token (needs a `prefix='n1 n2'` store index for
 *    speed). Query-side phrase filtering matches the store-side stopwords.
 *  - `stopwords` — ALWAYS threaded from `store.stopwords` into the query
 *    builders (empty list = off). This keeps the query side symmetric with the
 *    store's index-time stopword removal, so the opt-in feature works
 *    end-to-end without extra per-search configuration.
 *  - `offsets` — when true, each hit is enriched with `quote`/`start`/`end` in
 *    RAW document coordinates (the `documents`-table text, not the space-
 *    inserted segmented index). The matched segmented region is read back via
 *    FTS5 `highlight()`, stripped of its markers, and mapped onto the raw text
 *    with `mapSegmentedToRaw`; the mapping is validated (re-slicing raw must
 *    equal the de-spaced quote), and any hit that cannot be aligned exactly is
 *    SKIPPED — never guessed, so a wrong offset can never be emitted.
 *  - `titleWeight` — when set to a finite number, ranking becomes
 *    `titleRank*titleWeight + bodyRank` over the union of title-column and
 *    body-column hits (FTS5 column-filter queries). When undefined, the
 *    default single `ORDER BY rank` path is used unchanged.
 *
 * ```ts
 * import { fts5Search } from "thai-fts";
 * const hits = fts5Search(store, "ติดตัง", { limit: 10, tone: "both" });
 * ```
 */
import { buildSearchQuery } from "../../core/query.js";
import { looseForm, segmentQueryChunk } from "../../core/segment.js";
import { resolveToneMode } from "../../core/tone.js";
import type { ToneMode } from "../../core/types.js";
import type { ThaiEngineOptions, ThaiSearchResult } from "../engine.js";
import type { Fts5Store } from "./store.js";

/** A candidate row handed to the caller-owned `filter` hook. */
export interface Fts5Candidate {
  id: string | number;
  title: string;
  body: string;
}

/** Options for `fts5Search`. Extends the engine options with the filter hook
 * and the opt-in TASK-006 features; `tone` resolves through `resolveToneMode`
 * (default "both": strict first). */
export interface Fts5SearchOptions extends ThaiEngineOptions {
  /** Caller-owned predicate applied to each row before ranking/limit
   * accounting. Return true to keep a row. */
  filter?: (row: Fts5Candidate) => boolean;
}

interface ChannelRow {
  id: string;
  is_num: number;
  title: string;
  body: string;
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 200;
// Weighted-scoring stands-in for "no match in this column" (an unhit column
// must rank far below any single-column hit once multiplied out).
const MISS_RANK = 1e9;

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || limit === null) return DEFAULT_LIMIT;
  const n = Math.floor(Number(limit));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, MAX_LIMIT);
}

/** Escape LIKE wildcards so raw query text cannot act as a pattern. */
function likeEscape(s: string): string {
  return String(s).replace(/([\\%_])/g, "\\$1");
}

// Thai combining marks (vowels + tone) attach to the preceding base letter, so
// "ติด" is 2 Thai characters (ต + mark + ด), "ดี" is 1, "ลา" is 2. Matching
// the "1–2 char query" policy by raw code points would miscount these.
const THAI_MARK_RE = /[\u0E31\u0E34-\u0E3A\u0E47-\u0E4E]/;

/** Count Thai characters, folding a mark right after a Thai char into it. */
function countThaiChars(s: string): number {
  let count = 0;
  let prevThai = false;
  for (const ch of s) {
    if (ch < "\u0E00" || ch > "\u0E7F") {
      prevThai = false;
      continue;
    }
    if (prevThai && THAI_MARK_RE.test(ch)) continue;
    count += 1;
    prevThai = true;
  }
  return count;
}

/**
 * Small window of text around the first query-token hit in title/body, for the
 * optional `snippet` field. Returns undefined when there is no recognizable
 * text (the caller may still surface the title).
 */
function makeSnippet(
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

function decodeId(r: { id: string; is_num: number }): string | number {
  return r.is_num ? Number(r.id) : r.id;
}

function toResult(
  row: ChannelRow,
  needles: readonly string[],
  rank: number,
  meta: Record<string, unknown>
): ThaiSearchResult {
  return {
    id: decodeId(row),
    rank,
    snippet: makeSnippet(row.title, row.body, needles),
    meta,
  };
}

/** Search the store. See the module doc for channel + feature semantics. */
export function fts5Search(
  store: Fts5Store,
  query: string,
  opts: Fts5SearchOptions = {}
): ThaiSearchResult[] {
  const trimmed = String(query ?? "").trim();
  if (!trimmed) return [];

  const limit = clampLimit(opts.limit);
  const tone: ToneMode = resolveToneMode(opts);
  const needles = buildNeedles(trimmed);
  const weighted = Number.isFinite(opts.titleWeight)
    ? Number(opts.titleWeight)
    : undefined;

  // 1–2 char pure-Thai query: FTS5 phrases are unreliable at this width, so
  // fall back to a SQL LIKE scan and say so (never a silent empty result).
  // Counted by Thai characters (marks fold into their base), so a 3-code-point
  // ติด still counts as 2 chars and trips the fallback.
  const thaiChars = countThaiChars(trimmed);
  const onlyThai = /^[\u0E00-\u0E7F\s]+$/.test(trimmed);
  if (onlyThai && thaiChars > 0 && thaiChars <= 2) {
    return likeFallback(store, trimmed, tone, limit, opts.filter);
  }

  // Query-side stopword symmetry: ALWAYS thread the store's resolved stopword
  // list (resolved to [] when off, so the empty list disables filtering and
  // the default query is byte-identical). `prefix` stars each phrase's final
  // token for autocomplete.
  const built = buildSearchQuery(trimmed, {
    mode: tone,
    prefix: opts.prefix === true,
    stopwords: store.stopwords,
  });
  const db = store.db;
  const results: ThaiSearchResult[] = [];
  const seen = new Set<string>();
  // Raw document text per hit id, for `offsets` mapping (the `documents`
  // shadow table is the source of RAW text; the fts tables hold segmented).
  const rawByKey = new Map<string, { title: string; body: string }>();

  const pushResult = (row: ChannelRow, channel: string): void => {
    if (results.length >= limit) return;
    const key = String(row.id);
    rawByKey.set(key, { title: row.title, body: row.body });
    if (seen.has(key)) return;
    if (opts.filter) {
      const candidate: Fts5Candidate = {
        id: decodeId(row),
        title: row.title,
        body: row.body,
      };
      if (!opts.filter(candidate)) return;
    }
    seen.add(key);
    results.push(
      toResult(row, needles, results.length + 1, { method: "fts5", channel })
    );
  };

  // Default (unweighted) path: a single `ORDER BY rank` scan per channel.
  const runChannel = (table: string, match: string, channel: string): void => {
    const remaining = limit - results.length;
    if (remaining <= 0) return;
    const params: Array<string | number> = [match];
    let sql =
      `SELECT d.id, d.is_num, d.title, d.body ` +
      `FROM documents d JOIN ${table} ON ${table}.id = d.id ` +
      `WHERE ${table} MATCH ? ORDER BY rank`;
    if (!opts.filter) {
      sql += " LIMIT ?";
      params.push(remaining);
    }
    const rows = db.prepare(sql).all(...params) as unknown as ChannelRow[];
    for (const row of rows) {
      if (results.length >= limit) break;
      pushResult(row, channel);
    }
  };

  // Weighted path (opt-in `titleWeight`): candidates = title-column hits ∪
  // body-column hits; score each doc as titleRank*weight + bodyRank (MISS for
  // a column the doc does not hit), sort ascending, then apply filter/dedupe/
  // limit through the shared pusher. Keeps dual-channel strict-then-loose.
  const runWeightedChannel = (
    table: string,
    match: string,
    channel: string,
    weight: number
  ): void => {
    if (results.length >= limit) return;
    // Column-filter MATCH per column; raw text + is_num come from the
    // `documents` shadow table (the fts tables store the segmented payload).
    const base =
      `SELECT d.id, d.is_num, d.title, d.body, ${table}.rank AS rank ` +
      `FROM documents d JOIN ${table} ON ${table}.id = d.id WHERE ${table} MATCH ?`;
    const tRows = db.prepare(base).all(`title : ${match}`) as unknown as Array<
      ChannelRow & { rank: number }
    >;
    const bRows = db.prepare(base).all(`body : ${match}`) as unknown as Array<
      ChannelRow & { rank: number }
    >;

    const tRank = new Map<string, number>();
    const bRank = new Map<string, number>();
    const all = new Map<string, ChannelRow>();
    for (const r of tRows) {
      const k = String(r.id);
      tRank.set(k, r.rank);
      all.set(k, r);
    }
    for (const r of bRows) {
      const k = String(r.id);
      bRank.set(k, r.rank);
      if (!all.has(k)) all.set(k, r);
    }

    const scored: Array<{ row: ChannelRow; score: number }> = [];
    for (const [k, row] of all) {
      const t = tRank.get(k) ?? MISS_RANK;
      const b = bRank.get(k) ?? MISS_RANK;
      scored.push({ row, score: t * weight + b });
    }
    scored.sort((a, z) => a.score - z.score);
    for (const s of scored) {
      if (results.length >= limit) break;
      pushResult(s.row, channel);
    }
  };

  const channelRunner: (
    table: string,
    match: string,
    channel: string
  ) => void =
    weighted === undefined
      ? runChannel
      : (table, match, channel) =>
          runWeightedChannel(table, match, channel, weighted as number);

  if (tone === "strict") {
    channelRunner("fts5_strict", built.match, "strict");
  } else if (tone === "loose") {
    channelRunner("fts5_loose", built.looseMatch, "loose");
  } else {
    channelRunner("fts5_strict", built.match, "strict");
    if (results.length < limit) channelRunner("fts5_loose", built.looseMatch, "loose");
  }

  // Verified raw offsets (opt-in). A hit that cannot be aligned exactly keeps
  // its snippet but no quote/start/end — never a guessed offset.
  if (opts.offsets === true) {
    for (const r of results) {
      const table = r.meta?.channel === "loose" ? "fts5_loose" : "fts5_strict";
      const match = r.meta?.channel === "loose" ? built.looseMatch : built.match;
      const raw = rawByKey.get(String(r.id));
      const off = offsetsFor(store, table, match, String(r.id), raw);
      if (off) {
        r.quote = off.quote;
        r.start = off.start;
        r.end = off.end;
      }
    }
  }
  return results;
}

/** LIKE fallback for short pure-Thai queries. Tone-aware: exact scan first,
 * then (unless tone is "strict") a de-accented scan, deduped. */
function likeFallback(
  store: Fts5Store,
  query: string,
  tone: ToneMode,
  limit: number,
  filter?: Fts5SearchOptions["filter"]
): ThaiSearchResult[] {
  // Read a bounded slice per scan: an optional `filter` may reject rows, so the
  // bound sits a little above `limit` (dedup and the second loose scan absorb
  // the excess) while the LIKE read itself stays bounded.
  const scanLimit = limit * 2 + 16;
  const scan = (needle: string): ChannelRow[] => {
    const like = `%${likeEscape(needle)}%`;
    const rows = store.db
      .prepare(
        `SELECT id, is_num, title, body FROM documents
         WHERE title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\'
         ORDER BY rowid LIMIT ?`
      )
      .all(like, like, scanLimit) as unknown as ChannelRow[];
    return rows;
  };
  const collect = (needle: string, out: ThaiSearchResult[], seen: Set<string>): void => {
    for (const row of scan(needle)) {
      if (out.length >= limit) break;
      const key = String(row.id);
      if (seen.has(key)) continue;
      if (filter) {
        if (!filter({ id: decodeId(row), title: row.title, body: row.body })) continue;
      }
      seen.add(key);
      out.push(
        toResult(row, [query], out.length + 1, { method: "like_fallback" })
      );
    }
  };
  const out: ThaiSearchResult[] = [];
  const seen = new Set<string>();
  collect(query, out, seen);
  if (out.length < limit && tone !== "strict") {
    collect(looseForm(query), out, seen);
  }
  return out;
}

/** Snippet needles: raw chunks plus their segmented words, lowercased dedupe. */
function buildNeedles(query: string): string[] {
  const needles = new Set<string>();
  for (const chunk of query.trim().split(/\s+/).filter(Boolean).slice(0, 8)) {
    needles.add(chunk);
    for (const w of segmentQueryChunk(chunk)) needles.add(w);
  }
  return [...needles];
}

/* ------------------------------------------------------------------ *
 * offsets: raw-coordinate highlight mapping (opt-in, validated)
 * ------------------------------------------------------------------ */

const HILITE_OPEN = "\u0001";
const HILITE_CLOSE = "\u0002";

/**
 * Two-pointer alignment between a RAW document string and its SEGMENTED index
 * payload. The segmented payload is the raw text with spaces inserted between
 * Thai words (segmentForIndex) plus, possibly, appended synonym tokens that do
 * not exist in the raw text at all.
 *
 * Walk both strings: an inserted whitespace char in `segmented` maps to `null`
 * (the raw pointer does not advance); every other char maps to the raw index it
 * aligns with (the raw pointer advances by one). Content that has no raw
 * counterpart (appended synonym tokens past the end of `raw`) maps to `null`
 * so it can never produce a fabricated offset. The caller validates the result
 * by re-slicing `raw` and comparing it with the de-spaced quote — a mismatch
 * means the offset cannot be trusted and is dropped.
 */
export function mapSegmentedToRaw(
  raw: string,
  segmented: string
): Array<number | null> {
  const text = String(raw ?? "");
  const seg = String(segmented ?? "");
  const out: Array<number | null> = [];
  let ri = 0;
  for (let i = 0; i < seg.length; i++) {
    const ch = seg[i] as string;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      out.push(null);
      continue;
    }
    if (ri < text.length) {
      out.push(ri);
      ri += 1;
    } else {
      out.push(null);
    }
  }
  return out;
}

interface MarkSpan {
  start: number;
  end: number;
}

/** All `\u0001...\u0002` pairs in a highlighted column value. */
function markerPairs(h: string): MarkSpan[] {
  const out: MarkSpan[] = [];
  let i = 0;
  for (;;) {
    const s = h.indexOf(HILITE_OPEN, i);
    if (s === -1) break;
    const e = h.indexOf(HILITE_CLOSE, s + 1);
    if (e === -1) break;
    out.push({ start: s, end: e + 1 });
    i = e + 1;
  }
  return out;
}

/**
 * The FIRST contiguous marker group in a highlighted column value (a phrase
 * match marks several tokens that are only separated by whitespace; we want
 * the whole first phrase, the "first hit"). Returns the de-marked segmented
 * text and its starting position inside the un-marked stored payload.
 */
function firstMarkedRegion(
  h: string | null
): { seg: string; storedStart: number } | undefined {
  const text = String(h ?? "");
  const pairs = markerPairs(text);
  if (pairs.length === 0) return undefined;
  let last = 0;
  for (let k = 1; k < pairs.length; k++) {
    const between = text.slice(pairs[k - 1]?.end ?? 0, pairs[k]?.start ?? 0);
    if (between.trim() !== "") break;
    last = k;
  }
  const spanStart = (pairs[0] as MarkSpan).start;
  const spanEnd = (pairs[last] as MarkSpan).end;
  let storedStart = 0;
  for (let k = 0; k < spanStart; k++) {
    const ch = text[k];
    if (ch !== HILITE_OPEN && ch !== HILITE_CLOSE) storedStart += 1;
  }
  const seg = text.slice(spanStart, spanEnd).replace(/[\u0001\u0002]/g, "");
  if (!seg.trim()) return undefined;
  return { seg, storedStart };
}

interface RawText {
  title: string;
  body: string;
}

/** Offset shape returned by `offsetsFor`. */
export interface FtsOffsets {
  quote: string;
  start: number;
  end: number;
}

/**
 * Compute verified raw `{ quote, start, end }` for a hit. Reads the hit's
 * highlighted segmented payload from FTS5 (`highlight(ftable, col, \u0001,
 * \u0002)` — only meaningful during a MATCH), strips the markers to get the
 * matched segmented quote, maps it back to RAW document coordinates, and
 * validates by re-slicing the raw text. Any failure skips offsets (returns
 * undefined) — a wrong offset is never emitted.
 */
function offsetsFor(
  store: Fts5Store,
  table: string,
  match: string,
  id: string,
  raw: RawText | undefined
): FtsOffsets | undefined {
  if (!raw) return undefined;
  const rec = store.db
    .prepare(
      `SELECT highlight(${table}, 1, ?, ?) AS ht, highlight(${table}, 2, ?, ?) AS hb,
              title AS st, body AS sb
       FROM ${table} WHERE ${table} MATCH ? AND id = ?`
    )
    .get(HILITE_OPEN, HILITE_CLOSE, HILITE_OPEN, HILITE_CLOSE, match, id) as
    | { ht: string | null; hb: string | null; st: string | null; sb: string | null }
    | undefined;
  if (!rec) return undefined;

  const columns = [
    { highlight: rec.ht, stored: rec.st ?? "", raw: raw.title },
    { highlight: rec.hb, stored: rec.sb ?? "", raw: raw.body },
  ];

  for (const col of columns) {
    const region = firstMarkedRegion(col.highlight);
    if (!region) continue;
    const mapped = mapSegmentedToRaw(col.raw, col.stored);
    const positions = mapped.slice(
      region.storedStart,
      region.storedStart + region.seg.length
    );
    const pos: number[] = [];
    for (const p of positions) {
      if (p !== null) pos.push(p);
    }
    if (pos.length === 0) continue;
    // The non-space chars of the matched region must map to a CONTIGUOUS raw
    // stretch (any gap means the region includes content with no raw home, e.g.
    // an appended synonym, so the offset cannot be trusted).
    let contiguous = true;
    for (let k = 1; k < pos.length; k++) {
      if (pos[k] !== (pos[k - 1] as number) + 1) {
        contiguous = false;
        break;
      }
    }
    if (!contiguous) continue;
    const start = pos[0] as number;
    const end = (pos[pos.length - 1] as number) + 1;
    const deSpaced = region.seg.replace(/\s+/g, "");
    const slice = col.raw.slice(start, end);
    if (slice !== deSpaced) continue; // reconstruction mismatch -> skip
    return { quote: slice, start, end };
  }
  return undefined;
}
