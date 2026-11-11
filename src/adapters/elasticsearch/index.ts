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
 * strict-then-loose in JS, deduped by BASE id (an optional `::loose` suffix is
 * stripped), ranked by `_score` when the server provides it (server order
 * otherwise), and capped at `clampLimit(limit)`. `searchWithMeta()` returns the
 * same hits plus the query-level `truncated` flag, observable even when a
 * capped query matched nothing.
 *
 * **Bulk indexing.** `addMany(docs)` accepts a sync OR async iterable and sends
 * ONE `POST /_bulk` with `Content-Type: application/x-ndjson`, one
 * `{"index":{"_index":..,"_id":..}}` action line + document line per CHANNEL doc
 * of every logical document (strict id = base id, loose id = `<base>::loose`),
 * trailing newline included. An empty batch sends nothing. `_bulk` is not
 * transactional: when the response reports `errors: true` the call throws an
 * `Error` that lists every failed id (the successful items DO stay indexed —
 * replaying the batch is idempotent because ids are explicit).
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
  registerAsyncEngine,
  type ThaiEngineOptions,
  type ThaiSearchDoc,
  type ThaiSearchOutcome,
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

/** Strip the optional `::loose` suffix from an ES `_id` so a loose twin never
 * duplicates its strict hit (and the base id round-trips to its original). */
function baseIdOf(docId: string): string {
  return docId.endsWith("::loose") ? docId.slice(0, -"::loose".length) : docId;
}

/** One `_bulk` item entry: `_id` plus the 2xx `status` / `error` the server
 * reports per action. */
interface BulkItem {
  _id?: string;
  status?: number;
  error?: unknown;
}

/** Ids whose `_bulk` item failed (an `error` payload or a non-2xx `status`),
 * de-duplicated in response order. */
function failedBulkIds(res: { items?: unknown }): string[] {
  const out = new Set<string>();
  const items = Array.isArray(res.items) ? res.items : [];
  for (const raw of items) {
    if (raw === null || typeof raw !== "object") continue;
    for (const action of Object.values(raw as Record<string, unknown>)) {
      if (action === null || typeof action !== "object") continue;
      const item = action as BulkItem;
      const status = typeof item.status === "number" ? item.status : 200;
      const bad =
        (item.error !== undefined && item.error !== null) ||
        status < 200 ||
        status >= 300;
      if (!bad) continue;
      out.add(item._id !== undefined ? String(item._id) : "(unknown)");
    }
  }
  return [...out];
}

/**
 * Build a `HttpSearchEngine` over an Elasticsearch server (Node ≥ 18 global
 * `fetch`, no SDK). See the module header for the channel model and the
 * unsupported-features list.
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

  /** The two channel docs for ONE logical document, each with just the token
   * field its channel is searched on: strict (`_id` = base id, `th_token`) and
   * loose (`_id` = `<base>::loose`, `th_token_loose`). Both carry the raw
   * display text, never searched. */
  const channelBulkDocs = (
    doc: ThaiSearchDoc,
    method: "add" | "addMany"
  ): Array<{ _id: string; payload: Record<string, string> }> => {
    if (doc == null || doc.id === null || doc.id === undefined) {
      throw new TypeError(
        `elasticsearch engine ${method}() requires a document with an id`
      );
    }
    const title = String(doc.title ?? "");
    const body = String(doc.body ?? "");
    const strictTitle = buildIndexPayload(title, stopwords, stem);
    const strictBody = buildIndexPayload(body, stopwords, stem);
    const baseId = String(doc.id);
    ids.track(doc.id);
    return [
      {
        _id: baseId,
        payload: {
          th_token: [strictTitle, strictBody].filter(Boolean).join(" "),
          th_title: title,
          th_body: body,
        },
      },
      {
        _id: `${baseId}::loose`,
        payload: {
          th_token_loose: [looseForm(strictTitle), looseForm(strictBody)]
            .filter(Boolean)
            .join(" "),
          th_title: title,
          th_body: body,
        },
      },
    ];
  };

  /**
   * Bulk-index every document with ONE `_bulk` request: an NDJSON stream of
   * `{"index":{"_index","_id"}}` action lines followed by their document lines,
   * for BOTH channel docs of each logical document, ending with a newline.
   * Accepts sync and async iterables; an empty batch sends no request. A
   * response carrying `errors: true` rejects with an Error naming the failed
   * ids.
   */
  const addMany = async (
    docs: Iterable<ThaiSearchDoc> | AsyncIterable<ThaiSearchDoc>
  ): Promise<void> => {
    assertOpen();
    const lines: string[] = [];
    for await (const doc of docs) {
      for (const entry of channelBulkDocs(doc, "addMany")) {
        lines.push(JSON.stringify({ index: { _index: index, _id: entry._id } }));
        lines.push(JSON.stringify(entry.payload));
      }
    }
    if (lines.length === 0) return;
    const res = (await requestJSON(endpoint, "/_bulk", "POST", {
      headers,
      rawBody: `${lines.join("\n")}\n`,
      contentType: "application/x-ndjson",
    })) as { errors?: unknown; items?: unknown } | null;
    if (res?.errors === true) {
      const failed = failedBulkIds(res);
      throw new Error(
        `elasticsearch bulk index failed for ids: ${
          failed.length > 0 ? failed.join(", ") : "(server reported errors)"
        }`
      );
    }
  };

  const remove = async (id: string | number): Promise<void> => {
    assertOpen();
    ids.drop(id);
    for (const docId of [String(id), `${id}::loose`]) {
      try {
        await requestJSON(
          endpoint,
          `/${index}/_doc/${encodeURIComponent(docId)}`,
          "DELETE",
          { headers }
        );
      } catch (err) {
        // 404 = the document is already gone; remove() is a documented
        // no-op when absent. Any other error propagates.
        if (!String((err as Error).message).includes("HTTP 404")) throw err;
      }
    }
  };

  /** Shared search pipeline: hits plus the query-level truncation flag (see
   * `ThaiSearchOutcome`). `truncated` comes from the shared chunk plan, so a
   * capped query reports it even when nothing matched. */
  const searchOutcome = async (
    query: string,
    sOpts?: ThaiEngineOptions
  ): Promise<ThaiSearchOutcome> => {
    assertOpen();
    const s = sOpts ?? {};
    const trimmed = String(query ?? "").trim();
    if (!trimmed) return { hits: [], truncated: false };
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
        if (!rawId) continue;
        const baseId = baseIdOf(rawId);
        if (seen.has(baseId)) continue;
        seen.add(baseId);
        out.push({
          id: ids.restore(baseId),
          rank: out.length + 1,
          meta: truncated ? { method: "elasticsearch", channel, truncated: true } : { method: "elasticsearch", channel },
        });
      }
    };

    // Strict-then-loose contract (fts5/memory semantics): strict hits rank
    // first; loose only fills the remaining limit; ids dedupe by base id so a
    // loose twin never duplicates a strict hit.
    if (tone === "strict") {
      await push(strict, "strict");
    } else if (tone === "loose") {
      await push(loose, "loose");
    } else {
      await push(strict, "strict");
      await push(loose, "loose");
    }
    return { hits: out, truncated };
  };

  const search = async (
    query: string,
    sOpts?: ThaiEngineOptions
  ): Promise<ThaiSearchResult[]> => (await searchOutcome(query, sOpts)).hits;

  return {
    type: "elasticsearch",
    async: true,
    add,
    addMany,
    remove,
    search,
    searchWithMeta: searchOutcome,
    close() {
      // No local resources to release; closing only seals the engine.
      closed = true;
    },
  };
}

// Pre-register the reference adapter as an ASYNC engine so
// `createAsyncEngine("elasticsearch")` works out of the box.
registerAsyncEngine("elasticsearch", createElasticsearchEngine);
