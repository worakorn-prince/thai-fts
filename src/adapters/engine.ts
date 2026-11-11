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
 * // Registry use:
 * const engine2 = createEngine("fts5", { memory: true });
 * ```
 *
 * The registry knows TWO kinds of engine: synchronous ones
 * (`registerEngine`/`createEngine`) and remote-backed ones
 * (`registerAsyncEngine`/`createAsyncEngine`). The kind is part of the
 * registration, not of the name lookup, so calling the wrong creator throws a
 * message that names the right one instead of returning a half-usable engine.
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

/** Typed subset of the adapter-diagnostics object carried on
 * `ThaiSearchResult.meta`. Adapters may add their own keys (the field is
 * `ThaiSearchMeta & Record<string, unknown>`), but these three are the shared
 * contract:
 *
 *  - `method` — how the hit was produced (`"fts5"`, `"memory"`,
 *    `"like_fallback"`, an HTTP adapter name, …);
 *  - `channel` — which tone channel matched (`"strict"` = mark-aware,
 *    `"loose"` = de-accented);
 *  - `truncated` — present (as `true`) only when the query carried more than
 *    the analyzed chunk cap, so `hits.length === 0` cannot be mistaken for a
 *    complete (empty) result set. Prefer `searchWithMeta()` when you need this
 *    signal with zero hits. */
export interface ThaiSearchMeta {
  method?: string;
  channel?: "strict" | "loose";
  truncated?: true;
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
  /** Adapter-specific diagnostics (`method`, `channel`, `truncated`, …). */
  meta?: ThaiSearchMeta & Record<string, unknown>;
}

/** Result envelope of `searchWithMeta()`: the same hits `search()` returns
 * plus the query-level truncation signal, which stays observable even when the
 * truncated query produced ZERO hits (`{ hits: [], truncated: true }`). */
export interface ThaiSearchOutcome {
  /** Ranked hits, identical to `search(query, opts)`. */
  hits: ThaiSearchResult[];
  /** True when the query carried more chunks than the analyzer cap, so the
   * tail chunks were dropped from the built query — regardless of hit count. */
  truncated: boolean;
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
  /** AND-mode: require every analyzed chunk of a multi-word query to be present
   * in a matching document, joining them with FTS5 `AND` instead of `OR`.
   * Synonym-expanded chunks stay grouped — `(a OR b) AND c`. Default off keeps
   * recall-oriented OR matching. HTTP adapters accept and ignore this option. */
  allTerms?: boolean;
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
  /** Bulk-index documents in one transaction: equivalent to calling `add` for
   * each entry, but either all of them land or none do — a failure part-way
   * through rolls the whole batch back, including any replacement of an
   * existing id. An empty iterable is a no-op. Optional: adapters that cannot
   * batch cheaply leave it out, so callers should feature-detect with
   * `typeof engine.addMany === "function"` and fall back to `add`. */
  addMany?(docs: Iterable<ThaiSearchDoc>): void;
  /** Drop every indexed row for `id` (no-op when absent). */
  remove(id: string | number): void;
  /** Ranked hits for `query`, honoring `opts` (see ThaiEngineOptions). */
  search(query: string, opts?: ThaiEngineOptions): ThaiSearchResult[];
  /** Same hits as `search()`, plus the query-level truncation flag — the ONLY
   * way to observe `truncated` when a truncated query yields no hits. Optional
   * for the same feature-detection reason as `addMany`. */
  searchWithMeta?(query: string, opts?: ThaiEngineOptions): ThaiSearchOutcome;
  /** Release the underlying index/database. Idempotent. */
  close(): void;
}

/** The ASYNC twin of `ThaiSearchEngine`, implemented by adapters backed by a
 * remote server (Meilisearch, Elasticsearch): `add`/`remove`/`search` return
 * Promises because they cross the network, while `close()` stays synchronous
 * (no local resources are held; every later call throws). */
export interface ThaiAsyncEngine {
  /** Stable adapter kind, e.g. `"meilisearch"`. */
  readonly type: string;
  /** Brand marking the engine as async. Every async adapter sets it to `true`
   * so `isAsyncEngine()` can classify an engine without probing (and mutating)
   * the index via `add`. */
  readonly async: true;
  /** Index (or re-index) a document on the remote server. */
  add(doc: ThaiSearchDoc): Promise<void>;
  /** Bulk-index documents in one backend request (or transaction) when the
   * adapter can do so atomically; accepts both sync and async iterables and
   * treats an empty batch as a no-op. Optional — feature-detect it. */
  addMany?(
    docs: Iterable<ThaiSearchDoc> | AsyncIterable<ThaiSearchDoc>
  ): Promise<void>;
  /** Drop the remote document(s) for `id` (no-op when absent). */
  remove(id: string | number): Promise<void>;
  /** Ranked hits for `query`, honoring the `tone`/`limit` subset of `opts`. */
  search(query: string, opts?: ThaiEngineOptions): Promise<ThaiSearchResult[]>;
  /** Same hits as `search()`, plus the truncation flag (works for 0 hits). */
  searchWithMeta?(
    query: string,
    opts?: ThaiEngineOptions
  ): Promise<ThaiSearchOutcome>;
  /** Mark the engine closed; every later use throws
   * `"Search engine is closed"`. */
  close(): void;
}

/** Factory that builds a `ThaiSearchEngine` for the given options. This is the
 * seam adapters register against; `opts` is opaque to the registry, so it is
 * forwarded untouched and each adapter narrows it to its own options type.
 * Typed `any` here (not `unknown`) on purpose: it lets a concrete factory such
 * as `createFts5Engine(opts: Fts5EngineOptions)` be registered DIRECTLY, with
 * no cast anywhere in the adapter files. */
export type ThaiEngineFactory = (opts?: any) => ThaiSearchEngine;

/** Factory that builds a `ThaiAsyncEngine` (see `registerAsyncEngine`). Same
 * opaque-`opts` rule as `ThaiEngineFactory`. */
export type ThaiAsyncEngineFactory = (opts?: any) => ThaiAsyncEngine;

/** One registry slot: the factory plus which creation API owns the name. */
interface RegistryEntry {
  factory: ThaiEngineFactory | ThaiAsyncEngineFactory;
  async: boolean;
}

const registry = new Map<string, RegistryEntry>();

/**
 * Register a SYNC engine factory under a stable name. Later registrations
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
  registry.set(key, { factory, async: false });
}

/**
 * Register an ASYNC engine factory under a stable name. The name then belongs
 * to `createAsyncEngine()`/`listAsyncEngines()`; `createEngine()` on it throws
 * a message naming the async API. Later registrations overwrite earlier ones
 * (including a sync factory of the same name), so a test can swap either kind.
 *
 * ```ts
 * registerAsyncEngine("meilisearch", createMeilisearchEngine);
 * const engine = createAsyncEngine("meilisearch", opts);
 * await engine.search("ติดตั้ง");
 * ```
 */
export function registerAsyncEngine(
  name: string,
  factory: ThaiAsyncEngineFactory
): void {
  const key = String(name ?? "").trim();
  if (!key) throw new TypeError("registerAsyncEngine requires a non-empty name");
  if (typeof factory !== "function") {
    throw new TypeError("registerAsyncEngine requires a factory function");
  }
  registry.set(key, { factory, async: true });
}

/** Every registered name (sync and async), for error messages. */
function registeredNames(): string {
  const names = [...registry.keys()].sort();
  return names.length > 0 ? names.join(", ") : "(none)";
}

/**
 * Look up a registered SYNC engine factory and invoke it with `opts`. Throws
 * when `name` is unknown or is registered as an async engine (use
 * `createAsyncEngine` for those). Callers wanting a fallback should check
 * `listEngines()` first or register their own default.
 */
export function createEngine(name: string, opts?: unknown): ThaiSearchEngine {
  const key = String(name ?? "").trim();
  const entry = registry.get(key);
  if (!entry) {
    throw new Error(
      `No search engine registered as "${name}". ` +
        `Registered: ${registeredNames()}. ` +
        `Use registerEngine() to add one.`
    );
  }
  if (entry.async) {
    throw new Error(
      `Search engine "${key}" is registered as an ASYNC engine. ` +
        `Use createAsyncEngine("${key}") instead of createEngine().`
    );
  }
  return (entry.factory as ThaiEngineFactory)(opts);
}

/**
 * Look up a registered ASYNC engine factory and invoke it with `opts`. Throws
 * when `name` is unknown or is registered as a sync engine (use
 * `createEngine` for those).
 */
export function createAsyncEngine(name: string, opts?: unknown): ThaiAsyncEngine {
  const key = String(name ?? "").trim();
  const entry = registry.get(key);
  if (!entry) {
    throw new Error(
      `No search engine registered as "${name}". ` +
        `Registered: ${registeredNames()}. ` +
        `Use registerAsyncEngine() to add one.`
    );
  }
  if (!entry.async) {
    throw new Error(
      `Search engine "${key}" is registered as a SYNC engine. ` +
        `Use createEngine("${key}") instead of createAsyncEngine().`
    );
  }
  return (entry.factory as ThaiAsyncEngineFactory)(opts);
}

/** Names of every SYNC engine currently registered. */
export function listEngines(): string[] {
  return [...registry.entries()]
    .filter(([, entry]) => !entry.async)
    .map(([name]) => name)
    .sort();
}

/** Names of every ASYNC engine currently registered. */
export function listAsyncEngines(): string[] {
  return [...registry.entries()]
    .filter(([, entry]) => entry.async)
    .map(([name]) => name)
    .sort();
}

const ASYNC_FUNCTION_TAG = "AsyncFunction";

/**
 * Runtime classification for an engine instance, used by code that accepts
 * either kind (`createEngine`/`createAsyncEngine` both return a working
 * engine, but only an async one is awaitable). The rule, in order:
 *
 *  1. the explicit brand `engine.async === true` (all async adapters in this
 *     package set it);
 *  2. otherwise a registry-known `type` whose registration is async;
 *  3. otherwise an `async`-tagged `add` function (covers third-party adapters
 *     that forgot the brand).
 *
 * The probe NEVER calls `add` (that would mutate the index), so the async
 * function tag is checked via its constructor name instead of a thenable
 * return value.
 */
export function isAsyncEngine(engine: unknown): engine is ThaiAsyncEngine {
  if (engine === null || typeof engine !== "object") return false;
  const candidate = engine as {
    async?: unknown;
    add?: unknown;
    type?: unknown;
  };
  if (candidate.async === true) return true;
  if (typeof candidate.type === "string") {
    const entry = registry.get(candidate.type);
    if (entry?.async === true) return true;
  }
  const add = candidate.add;
  return (
    typeof add === "function" &&
    (add as { constructor?: { name?: string } }).constructor?.name ===
      ASYNC_FUNCTION_TAG
  );
}

/** Clear the registry — both sync and async names (mainly for tests and
 * hot-reload tooling). */
export function unregisterAllEngines(): void {
  registry.clear();
}
