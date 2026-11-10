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
  type ThaiEngineFactory,
  type ThaiEngineOptions,
  type ThaiSearchDoc,
  type ThaiSearchEngine,
} from "../engine.js";
import { openFts5Store } from "./store.js";
import { fts5Search } from "./search.js";

export { FTS5_STRICT_SCHEMA, FTS5_LOOSE_SCHEMA } from "./schema.js";
export { openFts5Store } from "./store.js";
export type { OpenFts5StoreOptions, Fts5Store, Fts5DocRow } from "./store.js";
export { fts5Search } from "./search.js";
export type { Fts5SearchOptions, Fts5Candidate } from "./search.js";

/** Options accepted by `createFts5Engine`. `tone`/`limit`/`prefix`/`offsets`/
 * `titleWeight` become defaults for `search()` (per-call options override
 * them); `path`/`memory` choose the backing database; `dictionaries` registers
 * Thai dictionaries at open. `prefix` doubles as the STORE option when it is a
 * number[] (FTS5 prefix-index lengths baked into the tables) and as the SEARCH
 * option (autocomplete `*` matching) when it is a boolean — pass both if you
 * want prefix-indexed autocomplete. `stopwords` is store-level only. */
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
}

/**
 * Build a `ThaiSearchEngine` over a new FTS5 store. `tone`/`limit` and the
 * search features given here become search defaults; with neither, the store
 * defaults to a `:memory:` database and strict-first dual-channel tone
 * handling.
 */
export function createFts5Engine(opts: Fts5EngineOptions = {}): ThaiSearchEngine {
  const store = openFts5Store({
    path: opts.path,
    memory: opts.memory,
    dictionaries: opts.dictionaries,
    prefix: Array.isArray(opts.prefix) ? opts.prefix : undefined,
    stopwords: opts.stopwords,
  });
  const base: ThaiEngineOptions = {};
  if (opts.tone !== undefined) base.tone = opts.tone;
  if (opts.limit !== undefined) base.limit = opts.limit;
  if (opts.offsets !== undefined) base.offsets = opts.offsets;
  if (opts.titleWeight !== undefined) base.titleWeight = opts.titleWeight;
  if (typeof opts.prefix === "boolean") base.prefix = opts.prefix;
  let closed = false;
  return {
    type: "fts5",
    add(doc: ThaiSearchDoc) {
      if (closed) throw new Error("Search engine is closed");
      store.add(doc);
    },
    remove(id) {
      if (closed) throw new Error("Search engine is closed");
      store.remove(id);
    },
    search(query, searchOpts) {
      if (closed) throw new Error("Search engine is closed");
      return fts5Search(store, query, { ...base, ...searchOpts });
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
registerEngine("fts5", createFts5Engine as unknown as ThaiEngineFactory);
