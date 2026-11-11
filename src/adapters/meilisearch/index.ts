/**
 * Meilisearch REFERENCE HTTP adapter — a minimal, fetch-based
 * `HttpSearchEngine` with `type: "meilisearch"`, registered as
 * `"meilisearch"`. Intentionally minimal (v0.2 "works with a live server"):
 * no SDK, no auth flows beyond a static API key, no retries.
 *
 * **Static auth header** (the single `apiKey` option):
 * `Authorization: Bearer <apiKey>`.
 *
 * **Two-channel preservation, server-side.** Each logical document is stored
 * as TWO Meilisearch documents so the strict/loose tone channels never
 * conflate on a backend that would otherwise de-accent everything:
 *
 *  - strict doc `{ id, th_title, th_body, th_channel: "strict" }` holding the
 *    mark-aware `buildIndexPayload` output (segment → synonyms → opt-in
 *    stopwords → opt-in `stemEn`);
 *  - loose doc `{ id: "<id>::loose", th_title, th_body, th_channel: "loose" }`
 *    holding `looseForm` of the same strict payloads.
 *
 * `search()` sends ONE `POST /indexes/{index}/search` per requested channel
 * (strict first, loose only while strict is short of `limit`), filtering on
 * `th_channel` and restricting matching to `th_title`/`th_body`. Each chunk
 * phrase is quoted so Meilisearch matches it as a contiguous phrase, mirroring
 * the fts5/memory phrase contract. Hits are merged strict-then-loose in JS,
 * deduped by BASE id (the `::loose` suffix stripped), ranked by
 * `_rankingScore` when the server provides it (server order otherwise), and
 * capped at `clampLimit(limit)`. `searchWithMeta()` returns the same hits plus
 * the query-level `truncated` flag, which is observable even for a capped query
 * that matched nothing.
 *
 * **Bulk indexing.** `addMany(docs)` accepts a sync OR async iterable and sends
 * ONE `POST /indexes/{index}/documents` carrying the JSON array of BOTH channel
 * docs for every logical document (same builders as `add`). An empty batch
 * sends nothing; Meilisearch applies a documents request atomically, so the
 * batch lands whole or not at all.
 *
 * **Not supported here (documented, not faked):** verified raw offsets
 * (`offsets` → no `quote`/`start`/`end` — the server only sees the indexed
 * payload, and this reference adapter does not keep the raw text), snippets,
 * and `prefix`/`titleWeight` (accepted on the options but no-ops).
 *
 * `add`/`remove`/`search` are ASYNC (see `HttpSearchEngine`); `remove`
 * swallows 404s so it is a no-op when the document is absent. `close()` is a
 * no-op on the server side (no local resources) but marks the engine closed —
 * every later use throws `"Search engine is closed"`, mirroring fts5/memory.
 *
 * ```ts
 * import { createMeilisearchEngine } from "thai-fts";
 * const engine = createMeilisearchEngine({ endpoint: "http://localhost:7700", index: "docs", apiKey: "key" });
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

export type { HttpSearchEngine } from "../_http.js";

/** Options accepted by `createMeilisearchEngine`: the common HTTP adapter
 * options plus the search defaults (`tone`/`limit` become per-search
 * defaults; `prefix`/`offsets`/`titleWeight` are accepted but no-ops). */
export interface MeilisearchEngineOptions
  extends ThaiEngineOptions,
    HttpAdapterOptions {}

/** Strip the `::loose` suffix from a Meilisearch doc id (base id = the
 * logical document id used for dedupe and round-trip). */
function baseIdOf(docId: string): string {
  return docId.endsWith("::loose") ? docId.slice(0, -"::loose".length) : docId;
}

/** One query chunk's words as a Meilisearch quoted phrase; empty chunks
 * (all-stopword) are dropped. */
function meiliQuery(phrases: string[][]): string {
  return phrases
    .map((words) => words.join(" "))
    .filter(Boolean)
    .map((p) => `"${p}"`)
    .join(" ");
}

/**
 * Build a `HttpSearchEngine` over a Meilisearch server (Node ≥ 18 global
 * `fetch`, no SDK). See the module header for the two-document channel
 * model and the unsupported-features list.
 */
export function createMeilisearchEngine(
  opts: MeilisearchEngineOptions
): HttpSearchEngine {
  if (opts == null || typeof opts.endpoint !== "string" || !opts.endpoint.trim()) {
    throw new TypeError("meilisearch engine requires an `endpoint` URL");
  }
  if (typeof opts.index !== "string" || !opts.index.trim()) {
    throw new TypeError("meilisearch engine requires an `index` name");
  }
  const endpoint = opts.endpoint.trim().replace(/\/+$/, "");
  const index = opts.index.trim();
  const headers = authHeaders("bearer", opts.apiKey ?? "");
  const stopwords = resolveStopwordsList(opts.stopwords);
  const stem = opts.stem === true;
  const base = searchDefaults(opts);
  const ids = makeIdTracker();
  let closed = false;

  const assertOpen = (): void => {
    if (closed) throw new Error("Search engine is closed");
  };

  /** Both channel docs for ONE logical document: strict (id = base id) plus
   * its loose twin (id = `<base>::loose`), so a backend that de-accents never
   * conflates the channels. Identical builders to the single-doc `add()`. */
  const channelDocs = (
    doc: ThaiSearchDoc,
    method: "add" | "addMany"
  ): Array<Record<string, unknown>> => {
    if (doc == null || doc.id === null || doc.id === undefined) {
      throw new TypeError(
        `meilisearch engine ${method}() requires a document with an id`
      );
    }
    const title = String(doc.title ?? "");
    const body = String(doc.body ?? "");
    const strictTitle = buildIndexPayload(title, stopwords, stem);
    const strictBody = buildIndexPayload(body, stopwords, stem);
    const baseId = String(doc.id);
    ids.track(doc.id);
    return [
      { id: baseId, th_title: strictTitle, th_body: strictBody, th_channel: "strict" },
      {
        id: `${baseId}::loose`,
        th_title: looseForm(strictTitle),
        th_body: looseForm(strictBody),
        th_channel: "loose",
      },
    ];
  };

  const add = async (doc: ThaiSearchDoc): Promise<void> => {
    assertOpen();
    await requestJSON(endpoint, `/indexes/${index}/documents`, "POST", {
      headers,
      body: channelDocs(doc, "add"),
    });
  };

  /**
   * Bulk-index every document in ONE request (Meilisearch applies a documents
   * POST atomically): the body is the flat array of both channel docs per
   * logical document. Accepts sync and async iterables; an empty batch sends
   * no HTTP request at all.
   */
  const addMany = async (
    docs: Iterable<ThaiSearchDoc> | AsyncIterable<ThaiSearchDoc>
  ): Promise<void> => {
    assertOpen();
    const batch: Array<Record<string, unknown>> = [];
    for await (const doc of docs) {
      batch.push(...channelDocs(doc, "addMany"));
    }
    if (batch.length === 0) return;
    await requestJSON(endpoint, `/indexes/${index}/documents`, "POST", {
      headers,
      body: batch,
    });
  };

  const remove = async (id: string | number): Promise<void> => {
    assertOpen();
    ids.drop(id);
    for (const docId of [String(id), `${id}::loose`]) {
      try {
        await requestJSON(
          endpoint,
          `/indexes/${index}/documents/${encodeURIComponent(docId)}`,
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

    const doSearch = async (
      phrases: string[][],
      channel: "strict" | "loose"
    ): Promise<Record<string, unknown>[]> => {
      if (phrases.every((words) => words.length === 0)) return [];
      const res = (await requestJSON(
        endpoint,
        `/indexes/${index}/search`,
        "POST",
        {
          headers,
          body: {
            q: meiliQuery(phrases),
            filter: `th_channel = "${channel}"`,
            attributesToSearch: ["th_title", "th_body"],
            attributesToRetrieve: ["id"],
            limit,
          },
        }
      )) as { hits?: unknown } | null;
      const hits = res?.hits;
      return Array.isArray(hits) ? (hits as Record<string, unknown>[]) : [];
    };

    const push = async (
      phrases: string[][],
      channel: "strict" | "loose",
      out: ThaiSearchResult[],
      seen: Set<string>
    ): Promise<void> => {
      if (out.length >= limit) return;
      const hits = await doSearch(phrases, channel);
      // Rank by the server's `_rankingScore` when present (stable sort);
      // otherwise trust the server's hit order.
      const scored = hits.some(
        (h) => typeof (h?._rankingScore as unknown) === "number"
      );
      if (scored) {
        const score = (h: Record<string, unknown>): number => {
          const v = h?._rankingScore;
          return typeof v === "number" ? v : -Infinity;
        };
        hits.sort((a, b) => score(b) - score(a));
      }
      for (const hit of hits) {
        if (out.length >= limit) break;
        const rawId = String(hit?.id ?? "");
        if (!rawId) continue;
        const baseId = baseIdOf(rawId);
        if (seen.has(baseId)) continue;
        seen.add(baseId);
        out.push({
          id: ids.restore(baseId),
          rank: out.length + 1,
          meta: truncated ? { method: "meilisearch", channel, truncated: true } : { method: "meilisearch", channel },
        });
      }
    };

    // Strict-then-loose contract (fts5/memory semantics): strict hits rank
    // first; loose only fills the remaining limit; ids dedupe by base id so a
    // loose twin never duplicates a strict hit.
    const out: ThaiSearchResult[] = [];
    const seen = new Set<string>();
    if (tone === "strict") {
      await push(strict, "strict", out, seen);
    } else if (tone === "loose") {
      await push(loose, "loose", out, seen);
    } else {
      await push(strict, "strict", out, seen);
      await push(loose, "loose", out, seen);
    }
    return { hits: out, truncated };
  };

  const search = async (
    query: string,
    sOpts?: ThaiEngineOptions
  ): Promise<ThaiSearchResult[]> => (await searchOutcome(query, sOpts)).hits;

  return {
    type: "meilisearch",
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
// `createAsyncEngine("meilisearch")` works out of the box.
registerAsyncEngine("meilisearch", createMeilisearchEngine);
