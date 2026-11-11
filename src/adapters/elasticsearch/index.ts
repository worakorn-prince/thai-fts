/**
 * Elasticsearch REFERENCE HTTP adapter — a minimal, fetch-based
 * `HttpSearchEngine` with `type: "elasticsearch"`, registered as
 * `"elasticsearch"`. Intentionally minimal (v0.2 "works with a live server"):
 * no SDK, no auth flows beyond a static API key, no retries.
 *
 * **Static auth header** (the single `apiKey` option):
 * `Authorization: Basic base64(apiKey)` (global `Buffer`, no imports).
 *
 * **Two-channel preservation, server-side.** One document per logical doc,
 * with the two channels as TWO FIELDS (the ES twin of Meilisearch's
 * two-docs model):
 *
 *  - `th_token` — the mark-aware `buildIndexPayload` token stream
 *    (segment → synonyms → opt-in stopwords → opt-in `stemEn`) of title +
 *    body, searched with `match_phrase` per chunk (phrase = words joined);
 *  - `th_token_loose` — `looseForm` of the same strict token stream;
 *  - `th_title` / `th_body` — the raw text, carried for display, never
 *    searched.
 *
 * `search()` sends TWO `POST /{index}/_search` calls when both channels are
 * requested (strict first, loose only while strict is short of `limit`): a
 * `bool.should` of `match_phrase` queries (OR across chunks,
 * `minimum_should_match: 1`), `size` = the clamped limit. Hits are merged
 * strict-then-loose in JS, deduped by `_id`, ranked by `_score` when the
 * server provides it (server order otherwise), and capped at
 * `clampLimit(limit)`.
 *
 * **Not supported here (documented, not faked):** verified raw offsets
 * (`offsets` → no `quote`/`start`/`end` — the server only sees the indexed
 * token fields), snippets, `prefix` and `titleWeight` (accepted on the
 * options but no-ops).
 *
 * `add`/`remove`/`search` are ASYNC (see `HttpSearchEngine`); `remove`
 * swallows 404s so it is a no-op when the document is absent. `close()` is a
 * no-op on the server side (no local resources) but marks the engine closed —
 * every later use throws `"Search engine is closed"`, mirroring fts5/memory.
 *
 * ```ts
 * import { createElasticsearchEngine } from "thai-fts";
 * const engine = createElasticsearchEngine({ endpoint: "http://localhost:9200", index: "docs" });
 * await engine.add({ id: 1, title: "คู่มือ", body: "ติดตั้งโปรแกรม" });
 * const hits = await engine.search("ติดตั้ง");
 * engine.close();
 * ```
 */
import { looseForm } from "../../core/segment.js";
import { resolveToneMode } from "../../core/tone.js";
import {
  buildChannelPhrases,
  buildIndexPayload,
  clampLimit,
} from "../_align.js";
import {
  authHeaders,
  makeIdTracker,
  requestJSON,
  resolveStopwordsList,
  searchDefaults,
  type HttpAdapterOptions,
  type HttpSearchEngine,
} from "../_http.js";
import {
  registerEngine,
  type ThaiEngineFactory,
  type ThaiEngineOptions,
  type ThaiSearchDoc,
  type ThaiSearchResult,
} from "../engine.js";

/** Options accepted by `createElasticsearchEngine`: the common HTTP adapter
 * options plus the search defaults (`tone`/`limit` become per-search
 * defaults; `prefix`/`offsets`/`titleWeight` are accepted but no-ops). */
export interface ElasticsearchEngineOptions
  extends ThaiEngineOptions,
    HttpAdapterOptions {}

/** The ES `bool.should` body for one channel: a `match_phrase` per non-empty
 * chunk (OR across chunks), `size` = the clamped limit. */
function phraseSearchBody(
  field: "th_token" | "th_token_loose",
  phrases: string[][],
  size: number
): Record<string, unknown> {
  return {
    query: {
      bool: {
        should: phrases
          .filter((words) => words.length > 0)
          .map((words) => ({ match_phrase: { [field]: words.join(" ") } })),
        minimum_should_match: 1,
      },
    },
    size,
  };
}

/**
 * Build a `HttpSearchEngine` over an Elasticsearch server (Node ≥ 18 global
 * `fetch`, no SDK). See the module header for the two-field channel model and
 * the unsupported-features list.
 */
export function createElasticsearchEngine(
  opts: ElasticsearchEngineOptions
): HttpSearchEngine {
  if (opts == null || typeof opts.endpoint !== "string" || !opts.endpoint.trim()) {
    throw new TypeError("elasticsearch engine requires an `endpoint` URL");
  }
  if (typeof opts.index !== "string" || !opts.index.trim()) {
    throw new TypeError("elasticsearch engine requires an `index` name");
  }
  const endpoint = opts.endpoint.trim().replace(/\/+$/, "");
  const index = opts.index.trim();
  const headers = authHeaders("basic", opts.apiKey ?? "");
  const stopwords = resolveStopwordsList(opts.stopwords);
  const stem = opts.stem === true;
  const base = searchDefaults(opts);
  const ids = makeIdTracker();
  let closed = false;

  const assertOpen = (): void => {
    if (closed) throw new Error("Search engine is closed");
  };

  const add = async (doc: ThaiSearchDoc): Promise<void> => {
    assertOpen();
    if (doc == null || doc.id === null || doc.id === undefined) {
      throw new TypeError(
        "elasticsearch engine add() requires a document with an id"
      );
    }
    const title = String(doc.title ?? "");
    const body = String(doc.body ?? "");
    const strictTitle = buildIndexPayload(title, stopwords, stem);
    const strictBody = buildIndexPayload(body, stopwords, stem);
    ids.track(doc.id);
    // One doc, two token fields: strict (th_token) + loose (th_token_loose),
    // plus the raw text for display.
    await requestJSON(
      endpoint,
      `/${index}/_doc/${encodeURIComponent(String(doc.id))}`,
      "PUT",
      {
        headers,
        body: {
          th_token: [strictTitle, strictBody].filter(Boolean).join(" "),
          th_token_loose: [
            looseForm(strictTitle),
            looseForm(strictBody),
          ]
            .filter(Boolean)
            .join(" "),
          th_title: title,
          th_body: body,
        },
      }
    );
  };

  const remove = async (id: string | number): Promise<void> => {
    assertOpen();
    ids.drop(id);
    try {
      await requestJSON(
        endpoint,
        `/${index}/_doc/${encodeURIComponent(String(id))}`,
        "DELETE",
        { headers }
      );
    } catch (err) {
      // 404 = the document is already gone; remove() is a documented
      // no-op when absent. Any other error propagates.
      if (!String((err as Error).message).includes("HTTP 404")) throw err;
    }
  };

  const search = async (
    query: string,
    sOpts?: ThaiEngineOptions
  ): Promise<ThaiSearchResult[]> => {
    assertOpen();
    const s = sOpts ?? {};
    const trimmed = String(query ?? "").trim();
    if (!trimmed) return [];
    const limit = clampLimit(s.limit ?? base.limit);
    const tone = resolveToneMode(s.tone ?? base.tone);
    // Symmetric query pipeline (same index-time stopwords/stem as add()).
    const { strict, loose, truncated } = buildChannelPhrases(trimmed, stopwords, stem);

    const out: ThaiSearchResult[] = [];
    const seen = new Set<string>();

    const push = async (
      phrases: string[][],
      channel: "strict" | "loose"
    ): Promise<void> => {
      if (out.length >= limit) return;
      if (phrases.every((words) => words.length === 0)) return;
      const field = channel === "strict" ? "th_token" : "th_token_loose";
      const res = (await requestJSON(endpoint, `/${index}/_search`, "POST", {
        headers,
        body: phraseSearchBody(field, phrases, limit),
      })) as { hits?: { hits?: unknown[] } } | null;
      const hits = res?.hits?.hits;
      if (!Array.isArray(hits)) return;
      // Rank by the server's `_score` when present (stable sort); otherwise
      // trust the server's hit order.
      if (hits.some((h) => typeof (h as Record<string, unknown>)?._score === "number")) {
        const score = (h: unknown): number => {
          const v = (h as Record<string, unknown> | undefined)?._score;
          return typeof v === "number" ? v : -Infinity;
        };
        hits.sort((a, b) => score(b) - score(a));
      }
      for (const hit of hits) {
        if (out.length >= limit) break;
        const rawId = String((hit as Record<string, unknown>)?._id ?? "");
        if (!rawId || seen.has(rawId)) continue;
        seen.add(rawId);
        out.push({
          id: ids.restore(rawId),
          rank: out.length + 1,
          meta: truncated ? { method: "elasticsearch", channel, truncated: true } : { method: "elasticsearch", channel },
        });
      }
    };

    // Strict-then-loose contract (fts5/memory semantics): strict hits rank
    // first; loose only fills the remaining limit; ids dedupe so a doc hit on
    // both channels appears once (its strict channel wins).
    if (tone === "strict") {
      await push(strict, "strict");
    } else if (tone === "loose") {
      await push(loose, "loose");
    } else {
      await push(strict, "strict");
      await push(loose, "loose");
    }
    return out;
  };

  return {
    type: "elasticsearch",
    add,
    remove,
    search,
    close() {
      // No local resources to release; closing only seals the engine.
      closed = true;
    },
  };
}

// Pre-register the reference adapter under its name so
// `createEngine("elasticsearch")` works out of the box.
registerEngine(
  "elasticsearch",
  createElasticsearchEngine as unknown as ThaiEngineFactory
);
