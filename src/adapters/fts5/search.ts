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

/** Options for `fts5Search`. Extends the engine options with the filter hook;
 * `tone` resolves through `resolveToneMode` (default "both": strict first). */
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

/** Search the store. See the module doc for channel semantics. */
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

  // 1–2 char pure-Thai query: FTS5 phrases are unreliable at this width, so
  // fall back to a SQL LIKE scan and say so (never a silent empty result).
  // Counted by Thai characters (marks fold into their base), so a 3-code-point
  // ติด still counts as 2 chars and trips the fallback.
  const thaiChars = countThaiChars(trimmed);
  const onlyThai = /^[\u0E00-\u0E7F\s]+$/.test(trimmed);
  if (onlyThai && thaiChars > 0 && thaiChars <= 2) {
    return likeFallback(store, trimmed, tone, limit, opts.filter);
  }

  const built = buildSearchQuery(trimmed, { mode: tone });
  const db = store.db;
  const results: ThaiSearchResult[] = [];
  const seen = new Set<string>();

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
      const key = String(row.id);
      if (seen.has(key)) continue;
      if (opts.filter) {
        const candidate: Fts5Candidate = {
          id: decodeId(row),
          title: row.title,
          body: row.body,
        };
        if (!opts.filter(candidate)) continue;
      }
      seen.add(key);
      results.push(
        toResult(row, needles, results.length + 1, { method: "fts5", channel })
      );
    }
  };

  if (tone === "strict") {
    runChannel("fts5_strict", built.match, "strict");
  } else if (tone === "loose") {
    runChannel("fts5_loose", built.looseMatch, "loose");
  } else {
    runChannel("fts5_strict", built.match, "strict");
    if (results.length < limit) runChannel("fts5_loose", built.looseMatch, "loose");
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
