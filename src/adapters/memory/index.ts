/**
 * Zero-dependency IN-MEMORY search adapter — a `ThaiSearchEngine` with
 * `type: "memory"` that keeps every document (and its precomputed token
 * arrays) in process memory. No Node built-ins, no database, no npm packages:
 * it exists for tests, offline use, and small datasets, and deliberately does
 * NOT need to be as fast as the FTS5 reference adapter.
 *
 * It mirrors the fts5 adapter's documented semantics exactly:
 *
 *  - index-time transform is the shared `buildIndexPayload` pipeline
 *    (`segmentForIndex` → `expandIndexedText` → `applyStopwords` → opt-in
 *    `stemEn`), so a document indexed here and a document indexed in FTS5
 *    carry the same payload;
 *  - a STRICT channel (mark-aware token arrays): ติดตั้ง ≠ ติดตัง;
 *  - a LOOSE channel (`looseForm` of the strict payload) tried BELOW strict
 *    only while strict is short of the limit, deduped by id — the same
 *    strict-then-loose contract, so a loose-only hit never displaces a
 *    strict one;
 *  - phrase matching is a token-aligned CONTIGUOUS scan over the token
 *    arrays (the in-memory twin of an FTS5 phrase), with `prefix` mode
 *    matching the final token by `startsWith`;
 *  - `limit` is clamped with the shared `clampLimit`; ranking is match-count
 *    descending (or `titleScore*titleWeight + bodyScore` when `titleWeight`
 *    is set) with insertion order as the tie-break;
 *  - `offsets: true` returns verified raw `quote`/`start`/`end` plus up to
 *    `MAX_OFFSET_OCCURRENCES` `occurrences` via the SHARED
 *    `regionToRawOffsets` two-pointer alignment (the same code the fts5
 *    adapter uses, so the two can never drift) — a region that cannot be
 *    aligned exactly is skipped, never guessed;
 *  - an optional caller-owned `filter` predicate is applied per candidate
 *    BEFORE the limit is accounted (fts5 `Fts5SearchOptions.filter`
 *    semantics), so filtered-out rows cannot starve in-scope hits;
 *  - `close()` is idempotent; every operation after `close()` throws
 *    `"Search engine is closed"` (the fts5 engine's error).
 *
 * ```ts
 * import { createMemoryEngine } from "thai-fts";
 * const engine = createMemoryEngine();
 * engine.add({ id: 1, title: "คู่มือ", body: "ติดตั้งโปรแกรม" });
 * engine.search("ติดตั้ง");            // ThaiSearchResult[]
 * engine.close();
 * ```
 */
import { hasThai, looseForm } from "../../core/segment.js";
import { registerThaiDictionary } from "../../core/dictionaries.js";
import { THAI_DEFAULT_STOPWORDS } from "../../core/stopwords.js";
import { resolveToneMode } from "../../core/tone.js";
import type { ThaiDictionaryDef } from "../../core/types.js";
import {
  buildChannelPhrases,
  buildIndexPayload,
  buildNeedles,
  clampLimit,
  makeSnippet,
  MAX_OFFSET_OCCURRENCES,
  regionToRawOffsets,
  type VerifiedOffset,
} from "../_align.js";
import {
  registerEngine,
  type ThaiEngineOptions,
  type ThaiSearchDoc,
  type ThaiSearchEngine,
  type ThaiSearchOutcome,
  type ThaiSearchResult,
} from "../engine.js";

/** A candidate row handed to the caller-owned `filter` hook (the RAW
 * document text — the same shape the fts5 adapter passes). */
export interface MemoryCandidate {
  id: string | number;
  title: string;
  body: string;
}

/** Options for `createMemoryEngine().search`: the engine options plus the
 * caller-owned filter hook (fts5 `Fts5SearchOptions.filter` semantics). */
export interface MemorySearchOptions extends ThaiEngineOptions {
  /** Caller-owned predicate applied to each candidate row before
   * ranking/limit accounting. Return true to keep a row. */
  filter?: (row: MemoryCandidate) => boolean;
}

/** The memory engine: the standard `ThaiSearchEngine` surface plus a
 * convenience `update` (replace-then-index, identical to `add`). */
export interface MemorySearchEngine extends ThaiSearchEngine {
  /** Convenience for replace-then-index (identical semantics to `add`). */
  update(doc: ThaiSearchDoc): void;
}

/** Options accepted by `createMemoryEngine`. `tone`/`limit`/`prefix`/
 * `offsets`/`titleWeight` become defaults for `search()` (per-call options
 * override them); `stopwords`/`stem`/`dictionaries` mirror the fts5 store's
 * index-time options. */
export interface MemoryEngineOptions extends ThaiEngineOptions {
  /** Thai dictionaries to register at create time (see
   * `registerThaiDictionary`). Registers are global to the core registry, so
   * this is a convenience for wiring them in one call. */
  dictionaries?: readonly ThaiDictionaryDef[];
  /** Opt-in symmetric stopword filtering. `true` uses the curated
   * `THAI_DEFAULT_STOPWORDS`; a string[] uses that exact list; `false`/absent
   * disables it. Stopword tokens are removed from the indexed payload on BOTH
   * channels, and search applies the same filter to query phrases. Default
   * off. */
  stopwords?: boolean | readonly string[];
  /** Opt-in English Porter stemming (`stemEn`) on ASCII tokens of the indexed
   * payload (Thai tokens pass through unchanged). Symmetric with the
   * query-side stemming; enabling it changes the indexed payload, so an
   * existing engine's documents must be re-added after toggling. Default off. */
  stem?: boolean;
}

/** One indexed document: the raw text plus both channels' stored payloads and
 * their precomputed matching-token arrays. */
interface DocRecord {
  id: string | number;
  isNum: boolean;
  /** RAW title/body text (shadow of the indexed payloads — source of truth
   * for snippets and raw-offset verification). */
  title: string;
  body: string;
  /** Mark-aware strict payloads (offset mapping keeps original case). */
  strictTitle: string;
  strictBody: string;
  /** De-accented loose payloads (`looseForm` of the strict payloads). */
  looseTitle: string;
  looseBody: string;
  /** Lowercased matching token arrays (ASCII lowercased, Thai mark-aware). */
  strictTitleTokens: string[];
  strictBodyTokens: string[];
  looseTitleTokens: string[];
  looseBodyTokens: string[];
  /** Insertion-order sequence number (re-adding an id re-orders it, like the
   * fts5 store's delete-then-insert rowid). */
  order: number;
}

/** One matched phrase occurrence inside a column's stored payload. */
interface Region {
  /** 0 = title column, 1 = body column (title comes before body). */
  col: 0 | 1;
  /** Token start index of the phrase inside the column's payload. */
  start: number;
  /** Number of phrase tokens (the matched chunk's word-list length). */
  n: number;
}

/** A scored candidate for one channel. */
interface Candidate {
  doc: DocRecord;
  score: number;
  regions: Region[];
}

/** Lowercased matching tokens of a stored payload: ASCII tokens are
 * lowercased, Thai tokens keep their marks/case — exactly the casefolding the
 * query side (`buildChannelPhrases`) applies, so matching is symmetric. */
function matchTokens(payload: string): string[] {
  return payload
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (hasThai(w) ? w : w.toLowerCase()));
}

/**
 * Token-aligned CONTIGUOUS phrase scan: the start indexes `i` where
 * `words[0..n)` matches `tokens[i..i+n)` in order — exact equality for every
 * token, and `startsWith` for the final token when `prefix` is on (the
 * in-memory twin of an FTS5 phrase + `"word"*` prefix query).
 */
function phrasePositions(
  tokens: readonly string[],
  words: readonly string[],
  prefix: boolean
): number[] {
  const n = words.length;
  if (n === 0 || tokens.length < n) return [];
  const out: number[] = [];
  const max = tokens.length - n;
  for (let i = 0; i <= max; i++) {
    let ok = true;
    for (let k = 0; k < n; k++) {
      const t = tokens[i + k] as string;
      const w = words[k] as string;
      if (k === n - 1 && prefix) {
        if (!t.startsWith(w)) {
          ok = false;
          break;
        }
      } else if (t !== w) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/**
 * Score ONE document against one channel's word lists. Default OR semantics: a
 * doc is a candidate when at least one chunk's phrase matches. With `allTerms`
 * every analyzed (non-empty) chunk must match — the AND-mode twin of the fts5
 * `AND` join — so a doc missing any one chunk is not a candidate at all.
 * Returns the candidate (match-count score + every matched region for the
 * offsets pass) or null when nothing matches. `weight` set →
 * `titleHits*weight + bodyHits` (the fts5 `titleWeight` contract); unset →
 * `titleHits + bodyHits`.
 */
function scoreDoc(
  doc: DocRecord,
  phrases: readonly string[][],
  prefix: boolean,
  weight: number | undefined,
  looseChannel: boolean,
  allTerms: boolean
): Candidate | null {
  const tTok = looseChannel ? doc.looseTitleTokens : doc.strictTitleTokens;
  const bTok = looseChannel ? doc.looseBodyTokens : doc.strictBodyTokens;
  let titleHits = 0;
  let bodyHits = 0;
  let groups = 0;
  let matched = 0;
  const regions: Region[] = [];
  for (const words of phrases) {
    if (words.length === 0) continue;
    groups++;
    const tp = phrasePositions(tTok, words, prefix);
    const bp = phrasePositions(bTok, words, prefix);
    if (tp.length === 0 && bp.length === 0) continue;
    matched++;
    titleHits += tp.length;
    bodyHits += bp.length;
    for (const p of tp) regions.push({ col: 0, start: p, n: words.length });
    for (const p of bp) regions.push({ col: 1, start: p, n: words.length });
  }
  if (titleHits === 0 && bodyHits === 0) return null;
  if (allTerms && matched < groups) return null;
  const score = weight === undefined ? titleHits + bodyHits : titleHits * weight + bodyHits;
  return { doc, score, regions };
}

/**
 * Build a `ThaiSearchEngine` backed purely by process memory. `tone`/`limit`
 * and the search features given here become search defaults; `stopwords`/
 * `stem`/`dictionaries` are index-time options (mirroring `openFts5Store`).
 * Zero dependencies — no Node built-ins, no database.
 */
export function createMemoryEngine(opts: MemoryEngineOptions = {}): MemorySearchEngine {
  // Index-time options, resolved exactly like the fts5 store: `stopwords`
  // (empty list = off) and `stem` (false = off) change the indexed payload,
  // and `dictionaries` register into the global core registry.
  const stopwords: readonly string[] =
    opts.stopwords === undefined || opts.stopwords === false
      ? []
      : opts.stopwords === true
        ? THAI_DEFAULT_STOPWORDS
        : [...opts.stopwords];
  const stem = opts.stem === true;
  for (const def of opts.dictionaries ?? []) {
    registerThaiDictionary(def);
  }

  const base: ThaiEngineOptions = {};
  if (opts.tone !== undefined) base.tone = opts.tone;
  if (opts.limit !== undefined) base.limit = opts.limit;
  if (opts.offsets !== undefined) base.offsets = opts.offsets;
  if (opts.titleWeight !== undefined) base.titleWeight = opts.titleWeight;
  if (opts.prefix !== undefined) base.prefix = opts.prefix === true;
  if (opts.allTerms !== undefined) base.allTerms = opts.allTerms;

  const docs = new Map<string, DocRecord>();
  let orderSeq = 0;
  let closed = false;

  const assertOpen = (): void => {
    if (closed) throw new Error("Search engine is closed");
  };

  const insert = (doc: ThaiSearchDoc): void => {
    if (doc == null || doc.id === null || doc.id === undefined) {
      throw new TypeError("memory engine add() requires a document with an id");
    }
    const id = String(doc.id);
    const isNum = typeof doc.id === "number";
    const title = String(doc.title ?? "");
    const body = String(doc.body ?? "");
    // The shared index-time pipeline (byte-identical to the fts5 store's when
    // stopwords is empty and stem is off); the loose channel stores
    // looseForm of the SAME strict payload, mirroring the fts5 store.
    const strictTitle = buildIndexPayload(title, stopwords, stem);
    const strictBody = buildIndexPayload(body, stopwords, stem);
    const looseTitle = looseForm(strictTitle);
    const looseBody = looseForm(strictBody);
    // Re-adding an id re-orders it (the fts5 store's delete-then-insert gives
    // the row a fresh rowid; insertion order is the ranking tie-break).
    docs.delete(id);
    docs.set(id, {
      id: doc.id,
      isNum,
      title,
      body,
      strictTitle,
      strictBody,
      looseTitle,
      looseBody,
      strictTitleTokens: matchTokens(strictTitle),
      strictBodyTokens: matchTokens(strictBody),
      looseTitleTokens: matchTokens(looseTitle),
      looseBodyTokens: matchTokens(looseBody),
      order: orderSeq++,
    });
  };

  const removeRow = (id: string | number): void => {
    docs.delete(String(id));
  };

  /** Search and return BOTH the hits and the query-level truncation flag (see
   * `ThaiSearchOutcome`): `truncated` is derived from the shared chunk plan, so
   * a query cut past the 8-chunk cap reports it even when nothing matched. */
  const searchOutcome = (
    query: string,
    rawOpts?: ThaiEngineOptions
  ): ThaiSearchOutcome => {
    assertOpen();
    const s: MemorySearchOptions = rawOpts ?? {};
    const trimmed = String(query ?? "").trim();
    if (!trimmed) return { hits: [], truncated: false };

    const limit = clampLimit(s.limit ?? base.limit);
    const tone = resolveToneMode(s.tone ?? base.tone);
    const prefix = (s.prefix !== undefined ? s.prefix : base.prefix) === true;
    const offsets = (s.offsets !== undefined ? s.offsets : base.offsets) === true;
    const weightRaw = s.titleWeight !== undefined ? s.titleWeight : base.titleWeight;
    const weight = Number.isFinite(weightRaw) ? Number(weightRaw) : undefined;
    const filter = s.filter;
    const allTerms = (s.allTerms !== undefined ? s.allTerms : base.allTerms) === true;
    const needles = buildNeedles(trimmed);
    // Symmetric query pipeline (shared with the fts5/HTTP adapters): stopword
    // + stem flags come from the store-level options, so index and query stay
    // symmetric without per-search configuration.
    const { strict, loose, truncated } = buildChannelPhrases(trimmed, stopwords, stem);

    const results: ThaiSearchResult[] = [];
    const seen = new Set<string>();
    const docsByResult: DocRecord[] = [];
    const regionsByResult: Region[][] = [];

    const runChannel = (phrases: string[][], channel: string): void => {
      const looseChannel = channel === "loose";
      const cands: Candidate[] = [];
      for (const doc of docs.values()) {
        const c = scoreDoc(doc, phrases, prefix, weight, looseChannel, allTerms);
        if (c) cands.push(c);
      }
      // Match-count desc; insertion order as the deterministic tie-break.
      cands.sort((a, b) => b.score - a.score || a.doc.order - b.doc.order);
      for (const c of cands) {
        if (results.length >= limit) break;
        const key = String(c.doc.id);
        if (seen.has(key)) continue;
        // Caller-owned filter is applied per candidate BEFORE the limit is
        // accounted (fts5 semantics): a filtered-out row never consumes a slot.
        if (filter) {
          const candidate: MemoryCandidate = {
            id: c.doc.id,
            title: c.doc.title,
            body: c.doc.body,
          };
          if (!filter(candidate)) continue;
        }
        seen.add(key);
        const meta: Record<string, unknown> = { method: "memory", channel };
        // Only ever set when the query really was cut down — the default hit
        // shape stays byte-for-byte what it was before.
        if (truncated) meta.truncated = true;
        results.push({
          id: c.doc.id,
          rank: results.length + 1,
          snippet: makeSnippet(c.doc.title, c.doc.body, needles),
          meta,
        });
        docsByResult.push(c.doc);
        regionsByResult.push(c.regions);
      }
    };

    // Dual-channel strict-then-loose contract (fts5 semantics): strict is
    // authoritative; loose is only consulted while strict is short of the
    // limit, and ids are deduped so a loose-only hit never displaces a
    // strict one. An all-stopword query leaves a channel empty — skipped,
    // never a crash.
    if (tone === "strict") {
      if (strict.length > 0) runChannel(strict, "strict");
    } else if (tone === "loose") {
      if (loose.length > 0) runChannel(loose, "loose");
    } else {
      if (strict.length > 0) runChannel(strict, "strict");
      if (results.length < limit && loose.length > 0) {
        runChannel(loose, "loose");
      }
    }

    // Verified raw offsets (opt-in). Every region is mapped with the SHARED
    // regionToRawOffsets two-pointer alignment (title column before body) and
    // validated by re-slicing the raw text; a region that cannot be aligned
    // exactly (e.g. a loose-channel region whose tone marks were stripped in
    // the index) is skipped — a wrong offset is never emitted. Up to
    // MAX_OFFSET_OCCURRENCES occurrences, first one = the primary offset.
    if (offsets && results.length > 0) {
      for (let i = 0; i < results.length; i++) {
        const r = results[i] as ThaiSearchResult | undefined;
        const doc = docsByResult[i] as DocRecord | undefined;
        const regions = regionsByResult[i] as Region[] | undefined;
        if (!r || !doc || !regions) continue;
        const strictChannel = String(r.meta?.channel ?? "strict") !== "loose";
        const columns = [
          {
            raw: doc.title,
            stored: strictChannel ? doc.strictTitle : doc.looseTitle,
          },
          { raw: doc.body, stored: strictChannel ? doc.strictBody : doc.looseBody },
        ];
        // Dedupe identical regions (overlapping chunks can yield the same
        // col+start+n), then process title before body, in token order.
        const uniq = new Map<string, Region>();
        for (const g of regions) {
          const k = `${g.col}:${g.start}:${g.n}`;
          if (!uniq.has(k)) uniq.set(k, g);
        }
        const occ: VerifiedOffset[] = [];
        let col = 0 as 0 | 1;
        while (col < 2 && occ.length < MAX_OFFSET_OCCURRENCES) {
          const column = columns[col] as { raw: string; stored: string } | undefined;
          if (column) {
            const { raw, stored } = column;
            // REAL character positions of the tokens inside the actual stored
            // payload (it may carry a leading space and original separators —
            // re-derive from the string itself, never reconstruct with
            // join(" "), which would shift the window).
            const charStarts: number[] = [];
            for (const m of stored.matchAll(/\S+/g)) charStarts.push(m.index ?? 0);
            const colRegions = [...uniq.values()]
              .filter((g) => g.col === col)
              .sort((a, b) => a.start - b.start);
            for (const g of colRegions) {
              const cs = charStarts[g.start];
              if (cs === undefined) continue;
              const cEnd =
                g.start + g.n < charStarts.length
                  ? (charStarts[g.start + g.n] as number)
                  : stored.length;
              const seg = stored.slice(cs, cEnd);
              const off = regionToRawOffsets(raw, stored, seg, cs);
              if (off) {
                occ.push(off);
                if (occ.length >= MAX_OFFSET_OCCURRENCES) break;
              }
            }
          }
          col = (col + 1) as 0 | 1;
        }
        const primary = occ[0];
        if (primary) {
          r.quote = primary.quote;
          r.start = primary.start;
          r.end = primary.end;
          r.occurrences = occ;
        }
      }
    }
    return { hits: results, truncated };
  };

  const search = (query: string, rawOpts?: ThaiEngineOptions): ThaiSearchResult[] =>
    searchOutcome(query, rawOpts).hits;

  const engine: MemorySearchEngine = {
    type: "memory",
    add(doc: ThaiSearchDoc): void {
      assertOpen();
      insert(doc);
    },
    addMany(batch: Iterable<ThaiSearchDoc>): void {
      assertOpen();
      // NOTE: unlike the fts5 store's lazy + transactional path, this adapter
      // materializes the whole batch EAGERLY (`[...batch]`) so the pre-batch
      // snapshot below describes exactly the ids the batch will touch. A
      // side effect is that a generator which throws mid-iteration aborts
      // before any mutation, so nothing needs rolling back; a very large batch
      // must therefore fit in memory here.
      const incoming = [...batch];
      if (incoming.length === 0) return;
      // Rollback state captured BEFORE the first mutation: the prior record of
      // every id the batch touches, plus the map's key order — insertion order
      // is the ranking tie-break, so restoring content while re-ordering the
      // entries would not be a true undo of a half-applied batch.
      const order = [...docs.keys()];
      const prev = new Map<string, DocRecord | undefined>();
      for (const d of incoming) {
        if (d == null || d.id === null || d.id === undefined) {
          throw new TypeError("memory engine addMany() requires a document with an id");
        }
        const key = String(d.id);
        if (!prev.has(key)) prev.set(key, docs.get(key));
      }
      try {
        for (const d of incoming) insert(d);
      } catch (e) {
        const restored = new Map<string, DocRecord>();
        for (const id of order) {
          const p = prev.get(id);
          if (p !== undefined) restored.set(id, p);
          else if (!prev.has(id)) {
            const cur = docs.get(id);
            if (cur) restored.set(id, cur);
          }
        }
        docs.clear();
        for (const [id, rec] of restored) docs.set(id, rec);
        throw e;
      }
    },
    remove(id: string | number): void {
      assertOpen();
      removeRow(id);
    },
    update(doc: ThaiSearchDoc): void {
      engine.add(doc);
    },
    search,
    searchWithMeta: searchOutcome,
    close(): void {
      if (closed) return;
      closed = true;
      docs.clear();
    },
  };
  return engine;
}

// Pre-register the adapter under its name so `createEngine("memory")` works
// out of the box, alongside any other engines registered by the app.
registerEngine("memory", createMemoryEngine);
