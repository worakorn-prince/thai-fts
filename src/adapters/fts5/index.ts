/**
 * SQLite FTS5 adapter entry point. Re-exports the schema, store and search
 * primitives, and provides `createFts5Engine` — a ready-to-use
 * `ThaiSearchEngine` backed by a `node:sqlite` DatabaseSync store.
 *
 * ```ts
 * import { createFts5Engine } from "thai-fts";
 * const engine = createFts5Engine({ memory: true, tone: "both" });
 * engine.add({ id: "doc", title: "คู่มือ", body: "ติดตั้งโปรแกรม" });
 * const hits = engine.search("ติดตั้ง");
 * engine.close();
 * ```
 */
import type { ThaiDictionaryDef } from "../../core/types.js";
import {
  registerEngine,
  type ThaiEngineOptions,
  type ThaiSearchDoc,
  type ThaiSearchEngine,
  type ThaiSearchOutcome,
} from "../engine.js";
import { openFts5Store } from "./store.js";
import { fts5Search, fts5SearchWithMeta } from "./search.js";
import type { Fts5SearchOptions } from "./search.js";

export { FTS5_STRICT_SCHEMA, FTS5_LOOSE_SCHEMA } from "./schema.js";
export { openFts5Store } from "./store.js";
export type { OpenFts5StoreOptions, Fts5Store, Fts5DocRow } from "./store.js";
export { fts5Search, fts5SearchWithMeta } from "./search.js";
export type { Fts5SearchOptions, Fts5Candidate } from "./search.js";
export { checkSqliteSupport, SqliteSupportError } from "./capability.js";
export type {
  CheckSqliteSupportOptions,
  SegmenterSupport,
  SqliteSupportReport,
} from "./capability.js";
export {
  Fts5ConfigMismatchError,
  CURRENT_META_VERSION,
  computeFingerprint,
  canonicalJson,
} from "./meta.js";
export type {
  ConfigCategory,
  MetaStatus,
  IndexConfig,
  StoredMeta,
  DictionaryRef,
} from "./meta.js";

/**
 * Merge per-search options over the engine-level defaults using
 * DEFINED-KEYS-ONLY semantics: an explicitly `undefined` value in `override`
 * (e.g. `{ allTerms: undefined }`) is treated as "not given", so it can never
 * clobber a default set at create time. Mirrors the memory adapter's
 * `!== undefined` checks, keeping both adapters' option resolution identical.
 */
function withDefined(
  base: Fts5SearchOptions,
  override: Fts5SearchOptions | undefined
): Fts5SearchOptions {
  const merged: Fts5SearchOptions = { ...base };
  if (!override) return merged;
  if (override.tone !== undefined) merged.tone = override.tone;
  if (override.limit !== undefined) merged.limit = override.limit;
  if (override.prefix !== undefined) merged.prefix = override.prefix;
  if (override.offsets !== undefined) merged.offsets = override.offsets;
  if (override.titleWeight !== undefined) merged.titleWeight = override.titleWeight;
  if (override.allTerms !== undefined) merged.allTerms = override.allTerms;
  if (override.filter !== undefined) merged.filter = override.filter;
  return merged;
}

/** Options accepted by `createFts5Engine`. `tone`/`limit`/`prefix`/`offsets`/
 * `titleWeight` become defaults for `search()` (per-call options override
 * them); `path`/`memory` choose the backing database; `dictionaries` registers
 * Thai dictionaries at open. `prefix` doubles as the STORE option when it is a
 * number[] (FTS5 prefix-index lengths baked into the tables) and as the SEARCH
 * option (autocomplete `*` matching) when it is a boolean — pass both if you
 * want prefix-indexed autocomplete. `stopwords`/`stem` are store-level only. */
export interface Fts5EngineOptions extends Omit<ThaiEngineOptions, "prefix"> {
  path?: string;
  memory?: boolean;
  dictionaries?: readonly ThaiDictionaryDef[];
  /** FTS5 prefix-index lengths (`readonly number[]`, store-level) OR
   * autocomplete matching (`boolean`, search-level). */
  prefix?: boolean | readonly number[];
  /** Opt-in symmetric stopword filtering (store-level): `true` uses the
   * curated THAI_DEFAULT_STOPWORDS, a string[] uses that exact list. Enabling
   * it changes the indexed payload — rebuild on-disk databases after toggling.
   * Default off. */
  stopwords?: boolean | readonly string[];
  /** Opt-in symmetric English Porter stemming (store-level): `stemEn` is
   * applied to ASCII tokens of the indexed payload (Thai tokens unchanged) and
   * `search()` threads it into the query-side MATCH builders automatically.
   * **OPT-IN: enabling it changes the indexed payload — existing on-disk
   * databases must be rebuilt after toggling.** Default off. */
  stem?: boolean;
  /** What to do when a reopened file database's persisted metadata disagrees
   * with this config: `"throw"` (default) raises `Fts5ConfigMismatchError`;
   * `"ignore"` opens and reports `metaStatus: "mismatch-ignored"`. Legacy
   * databases (no metadata) always open regardless. */
  onConfigMismatch?: "throw" | "ignore";
  /** SQLite page-cache cap for FILE-backed stores in KiB (store-level).
   * Default **65536** (64 MiB); `0` keeps SQLite's default. Ignored for
   * memory stores. Not part of the config fingerprint: changing it never
   * triggers a rebuild or a mismatch error. */
  cacheSizeKib?: number;
}

/**
 * Build a `ThaiSearchEngine` over a new FTS5 store. `tone`/`limit` and the
 * search features given here become search defaults; with neither, the store
 * defaults to a `:memory:` database and strict-first dual-channel tone
 * handling. The returned engine exposes both `search()` (hits only) and
 * `searchWithMeta()` (`{ hits, truncated }`), so the query-level truncation
 * flag is observable even when a capped query returns zero hits.
 */
export function createFts5Engine(opts: Fts5EngineOptions = {}): ThaiSearchEngine {
  const store = openFts5Store({
    path: opts.path,
    memory: opts.memory,
    dictionaries: opts.dictionaries,
    prefix: Array.isArray(opts.prefix) ? opts.prefix : undefined,
    stopwords: opts.stopwords,
    stem: opts.stem === true,
    onConfigMismatch: opts.onConfigMismatch,
    cacheSizeKib: opts.cacheSizeKib,
  });
  const base: ThaiEngineOptions = {};
  if (opts.tone !== undefined) base.tone = opts.tone;
  if (opts.limit !== undefined) base.limit = opts.limit;
  if (opts.offsets !== undefined) base.offsets = opts.offsets;
  if (opts.titleWeight !== undefined) base.titleWeight = opts.titleWeight;
  if (typeof opts.prefix === "boolean") base.prefix = opts.prefix;
  if (opts.allTerms !== undefined) base.allTerms = opts.allTerms;
  let closed = false;
  return {
    type: "fts5",
    add(doc: ThaiSearchDoc) {
      if (closed) throw new Error("Search engine is closed");
      store.add(doc);
    },
    addMany(docs: Iterable<ThaiSearchDoc>) {
      if (closed) throw new Error("Search engine is closed");
      store.addMany(docs);
    },
    remove(id) {
      if (closed) throw new Error("Search engine is closed");
      store.remove(id);
    },
    search(query, searchOpts) {
      if (closed) throw new Error("Search engine is closed");
      return fts5Search(store, query, withDefined(base, searchOpts));
    },
    searchWithMeta(query, searchOpts): ThaiSearchOutcome {
      if (closed) throw new Error("Search engine is closed");
      return fts5SearchWithMeta(store, query, withDefined(base, searchOpts));
    },
    close() {
      if (!closed) {
        closed = true;
        store.close();
      }
    },
  };
}

// Pre-register the reference adapter under its name so `createEngine("fts5")`
// works out of the box, alongside any future engines registered by the app.
registerEngine("fts5", createFts5Engine);
