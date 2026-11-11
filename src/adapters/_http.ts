/**
 * Shared INTERNAL plumbing for the reference HTTP adapters
 * (`src/adapters/meilisearch`, `src/adapters/elasticsearch`).
 * Module-private by convention — the `_` prefix marks it as non-public; it is
 * not re-exported wholesale from any subpath entry (the `HttpSearchEngine`
 * type is re-exported by name from the meilisearch adapter file only).
 *
 * Contents:
 *  - `HttpSearchEngine` — the historical name of the ASYNC engine contract the
 *    HTTP adapters implement. It is now a straight alias of `ThaiAsyncEngine`
 *    (declared in `engine.ts`), which carries the `readonly async: true` brand
 *    the registry uses to classify engines without probing the index;
 *  - `requestJSON` — one small fetch-based JSON helper: builds the absolute
 *    URL, sets `Content-Type: application/json` (or an explicit
 *    `contentType` for a raw/NDJSON body), optional static headers, throws
 *    `Error` with status + body excerpt on non-2xx. No other features;
 *  - `authHeaders` — the single static-API-key seam: Meilisearch uses
 *    `Authorization: Bearer <apiKey>`, Elasticsearch
 *    `Authorization: Basic base64(":" + apiKey)` (ES API-key scheme);
 *  - `resolveStopwordsList` — the same stopword-option resolution every
 *    adapter uses (`undefined`/`false` = off, `true` = curated defaults,
 *    `string[]` = that exact list);
 *  - `makeIdTracker` — keeps the original document id around so hits coming
 *    back over HTTP (string ids) round-trip to their original type, matching
 *    the fts5/memory contract.
 *
 * Pure with respect to the Node import graph: no `node:` imports — only the
 * Node ≥ 18 global `fetch` and the Node global `Buffer` (base64 encoding),
 * so the package keeps zero runtime dependencies.
 */
import { THAI_DEFAULT_STOPWORDS } from "../core/stopwords.js";
import type { ThaiEngineOptions } from "./engine.js";

export type { ThaiAsyncEngine } from "./engine.js";

/** The ASYNC search-engine contract for adapters backed by a remote server:
 * `add`/`remove`/`search` are awaited; `close` stays synchronous (no local
 * resources are held, but every later use throws). Kept as an alias so
 * existing `HttpSearchEngine` imports keep compiling — it IS
 * `ThaiAsyncEngine`, the brand included. */
export type HttpSearchEngine = import("./engine.js").ThaiAsyncEngine;

/** Common create-time options for the reference HTTP adapters.
 * `endpoint` is the server root (e.g. `http://localhost:7700`), `index` the
 * Meilisearch index name / Elasticsearch index name. `apiKey` is a STATIC
 * header credential (no auth flows); `stopwords`/`stem` are the same
 * index-time, opt-in, index-changing pipeline options as the local adapters. */
export interface HttpAdapterOptions {
  /** Server root URL, e.g. `http://localhost:7700` (no trailing slash). */
  endpoint: string;
  /** Index name on the server. */
  index: string;
  /** Static API key. Meilisearch: sent as `Authorization: Bearer <key>`.
   * Elasticsearch: sent as `Authorization: Basic base64(<key>)`. */
  apiKey?: string;
  /** Opt-in symmetric stopword filtering (index-time, index-changing).
   * `true` uses the curated `THAI_DEFAULT_STOPWORDS`; a string[] uses that
   * exact list; default off. */
  stopwords?: boolean | readonly string[];
  /** Opt-in English Porter stemming on ASCII tokens (index-time,
   * index-changing; Thai tokens unchanged; symmetric with the query side).
   * Default off. */
  stem?: boolean;
}

/** Parsed JSON response of `requestJSON`. */
export type JsonValue = unknown;

/** Options for `requestJSON`. */
export interface RequestJsonOptions {
  /** Extra static headers merged over `Content-Type`. */
  headers?: Record<string, string>;
  /** JSON-serializable request body (ignored when `rawBody` is set; omitted
   * when both are absent, e.g. DELETE). */
  body?: unknown;
  /** Pre-serialized body sent verbatim, for APIs that do not take JSON — the
   * Elasticsearch `_bulk` NDJSON stream is the one caller today. */
  rawBody?: string;
  /** `Content-Type` for `rawBody` (defaults to `application/json`). */
  contentType?: string;
}

/**
 * One JSON request against a remote server via global `fetch` (Node 18+).
 * Builds the absolute URL from `endpoint` + `path`, sets `Content-Type` from
 * `opts.contentType` (`application/json` by default), sends either the
 * pre-serialized `rawBody` or `JSON.stringify(opts.body)`, and resolves with
 * the parsed JSON (null/undefined for empty bodies). A non-2xx response
 * rejects with `Error` whose message carries the status + a body excerpt.
 * Nothing else: no retries, no auth flows, no streaming.
 */
export async function requestJSON(
  endpoint: string,
  path: string,
  method: string,
  opts: RequestJsonOptions = {}
): Promise<JsonValue> {
  const root = String(endpoint ?? "").trim().replace(/\/+$/, "");
  if (!root) throw new TypeError("requestJSON requires a non-empty endpoint");
  const url = `${root}/${String(path ?? "").replace(/^\/+/, "")}`;
  const headers: Record<string, string> = {
    "Content-Type": opts.contentType ?? "application/json",
    ...(opts.headers ?? {}),
  };
  const payload =
    opts.rawBody !== undefined
      ? opts.rawBody
      : opts.body === undefined
        ? undefined
        : JSON.stringify(opts.body);
  const res = await fetch(url, {
    method: String(method ?? "GET").toUpperCase(),
    headers,
    body: payload,
  });
  const text = await res.text();
  if (!res.ok) {
    const excerpt =
      text.replace(/\s+/g, " ").trim().slice(0, 200) || "(no body)";
    throw new Error(`HTTP ${res.status} from ${method} ${url}: ${excerpt}`);
  }
  if (!text) return null;
  return JSON.parse(text) as JsonValue;
}

/** Static API-key headers for the two reference adapters (one `apiKey`
 * option, two documented header shapes):
 *  - Meilisearch: `Authorization: Bearer <key>`;
 *  - Elasticsearch: `Authorization: Basic base64(key)` (global `Buffer`). */
export function authHeaders(
  scheme: "bearer" | "basic",
  apiKey: string
): Record<string, string> {
  const key = String(apiKey ?? "");
  if (!key) return {};
  return scheme === "bearer"
    ? { Authorization: `Bearer ${key}` }
    : { Authorization: `Basic ${Buffer.from(`:${key}`, "utf8").toString("base64")}` };
}

/** Resolve the opt-in `stopwords` option into the exact list used on both
 * the index and the query side (`undefined`/`false` = none). */
export function resolveStopwordsList(
  value: boolean | readonly string[] | undefined
): readonly string[] {
  if (value === undefined || value === false) return [];
  if (value === true) return THAI_DEFAULT_STOPWORDS;
  return [...value];
}

/**
 * Local id tracker: HTTP servers hand back string ids, but the engine
 * contract round-trips the ORIGINAL id (numeric ids stay numeric). `track`
 * on add, `drop` on remove, `restore` on hits (falls back to the key itself
 * for ids never seen locally).
 */
export interface IdTracker {
  track(id: string | number): void;
  drop(id: string | number): void;
  restore(key: string): string | number;
}

export function makeIdTracker(): IdTracker {
  const ids = new Map<string, string | number>();
  return {
    track(id) {
      ids.set(String(id), id);
    },
    drop(id) {
      ids.delete(String(id));
    },
    restore(key) {
      const v = ids.get(key);
      return v !== undefined ? v : key;
    },
  };
}

/** Copy the search-default subset of create-time options (tone/limit) into a
 * per-search defaults object, mirroring the fts5/memory adapters. */
export function searchDefaults(
  opts: Partial<ThaiEngineOptions>
): ThaiEngineOptions {
  const base: ThaiEngineOptions = {};
  if (opts.tone !== undefined) base.tone = opts.tone;
  if (opts.limit !== undefined) base.limit = opts.limit;
  return base;
}
