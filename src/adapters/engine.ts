/**
 * Search-engine abstraction layer for thai-fts. A `ThaiSearchEngine` is the
 * minimal pluggable surface an application talks to regardless of the backing
 * index (SQLite FTS5 today, Meilisearch/Elasticsearch/in-memory tomorrow).
 * Pure — this module imports no Node built-ins and no database, so any adapter
 * (in or out of this repo) can depend on it.
 *
 * ```ts
 * import { createEngine, createFts5Engine } from "thai-fts";
 *
 * // Direct (typed) use:
 * const engine = createFts5Engine({ memory: true });
 * engine.add({ id: 1, title: "คู่มือ", body: "ติดตั้งโปรแกรม" });
 * engine.search("ติดตั้ง");            // ThaiSearchResult[]
 * engine.close();
 *
 * // Registry use (future adapters plug in here):
 * const engine2 = createEngine("fts5", { memory: true });
 * ```
 */
import type { ToneMode } from "../core/types.js";

/** A document an engine can index. Only `id`, `title`, `body` are read by the
 * FTS5 adapter today; extra keys are carried for future adapters. */
export interface ThaiSearchDoc {
  /** Stable unique identifier (string or number). */
  id: string | number;
  /** Short heading text, indexed alongside `body`. */
  title?: string;
  /** Main searchable text. */
  body?: string;
  [key: string]: unknown;
}

/** A single ranked hit returned by `ThaiSearchEngine.search`. */
export interface ThaiSearchResult {
  /** The indexed document id, round-tripped to its original type. */
  id: string | number;
  /** 1-based position in the result list (strict hits before loose hits). */
  rank: number;
  /** Short window of matched text around the first hit, when one exists. */
  snippet?: string;
  /** The matched text in ORIGINAL raw document coordinates (no inserted
   * segmentation spaces), set only when `offsets` is requested and a valid
   * alignment was found. Never guessed/incorrect: set from a verified
   * raw↔indexed two-pointer map, or omitted. */
  quote?: string;
  /** Raw UTF-16 start index of the matched text in the source document.
   * `slice(rawText, start, end) === quote` when set. */
  start?: number;
  /** Raw UTF-16 index just past the matched text. */
  end?: number;
  /** Verified raw occurrences of the matched term when `offsets` is requested:
   * up to 3 `{ quote, start, end }` entries in document order, each satisfying
   * `slice(rawText, start, end) === quote`. The first entry equals the primary
   * `quote`/`start`/`end`. Omitted when no verified occurrence exists. */
  occurrences?: Array<{ quote: string; start: number; end: number }>;
  /** Adapter-specific diagnostics such as `{ method, channel }`. */
  meta?: Record<string, unknown>;
}

/** Options accepted by engine creation and per-search calls. Where they are
 * provided at create time they act as defaults that a per-search option
 * overrides. `tone` chooses the matching channel (see ToneMode); `limit`
 * bounds the returned hits; `prefix`/`offsets`/`titleWeight` are the opt-in
 * search features (see the fts5 adapter docs). */
export interface ThaiEngineOptions {
  tone?: ToneMode;
  limit?: number;
  /** Autocomplete mode: append FTS5 `*` to each phrase's final token so a
   * partial word matches (needs a `prefix` store index for speed). */
  prefix?: boolean;
  /** When true, also compute verified raw `quote`/`start`/`end` per hit. */
  offsets?: boolean;
  /** Weight titles above bodies: title-column hit score × `titleWeight` +
   * body-column hit score. Default (undefined) keeps unweighted ranking. */
  titleWeight?: number;
}

/** The minimal engine contract shared by every adapter. Implementations should
 * be cheap to open, require an explicit `close()`, and keep `add`/`remove`
 * idempotent (re-adding an id replaces it). */
export interface ThaiSearchEngine {
  /** Stable adapter kind, e.g. `"fts5"`. */
  readonly type: string;
  /** Index (or re-index) a document, replacing any previous row with the same
   * id. Bytes are a fixed point under repeat indexing. */
  add(doc: ThaiSearchDoc): void;
  /** Drop every indexed row for `id` (no-op when absent). */
  remove(id: string | number): void;
  /** Ranked hits for `query`, honoring `opts` (see ThaiEngineOptions). */
  search(query: string, opts?: ThaiEngineOptions): ThaiSearchResult[];
  /** Release the underlying index/database. Idempotent. */
  close(): void;
}

/** Factory that builds a `ThaiSearchEngine` for the given options. This is the
 * seam future adapters register against; `opts` is opaque so a registry can
 * forward engine-specific options without knowing them. */
export type ThaiEngineFactory = (opts?: unknown) => ThaiSearchEngine;

const registry = new Map<string, ThaiEngineFactory>();

/**
 * Register an engine factory under a stable name. Later registrations
 * overwrite earlier ones with the same name (no error), so applications can
 * swap an implementation (e.g. a test double) without changing call sites.
 *
 * ```ts
 * registerEngine("my-fts5", (opts) => createFts5Engine(opts));
 * const engine = createEngine("my-fts5", { memory: true });
 * ```
 */
export function registerEngine(name: string, factory: ThaiEngineFactory): void {
  const key = String(name ?? "").trim();
  if (!key) throw new TypeError("registerEngine requires a non-empty name");
  if (typeof factory !== "function") {
    throw new TypeError("registerEngine requires a factory function");
  }
  registry.set(key, factory);
}

/**
 * Look up a registered engine factory and invoke it with `opts`. Throws when
 * `name` has not been `registerEngine`-ed — callers wanting a fallback should
 * check `listEngines()` first or register their own default.
 */
export function createEngine(name: string, opts?: unknown): ThaiSearchEngine {
  const factory = registry.get(String(name ?? "").trim());
  if (!factory) {
    throw new Error(
      `No search engine registered as "${name}". ` +
        `Registered: ${[...listEngines()].join(", ") || "(none)"}. ` +
        `Use registerEngine() to add one.`
    );
  }
  return factory(opts);
}

/** Names of every engine currently registered. */
export function listEngines(): string[] {
  return [...registry.keys()].sort();
}

/** Clear the registry (mainly for tests and hot-reload tooling). */
export function unregisterAllEngines(): void {
  registry.clear();
}
