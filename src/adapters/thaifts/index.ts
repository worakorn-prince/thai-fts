/**
 * thaifts-server REFERENCE HTTP adapter — a thin, fetch-based client for the
 * REST server shipped in `thai-fts/server` (`createServer`). Intentionally
 * minimal: no SDK, no auth flows beyond a static API key, no retries, no
 * channel machinery — the server already runs the strict/loose two-channel
 * pipeline, so the raw query string is forwarded verbatim and hits are mapped
 * back locally.
 *
 * **Endpoint layout.** With an `engine` option every request targets
 * `/engines/<engine>/...` (explicit engine selection, name encoded with
 * `encodeURIComponent`); without one the shorthand paths (`/add`,
 * `/searchWithMeta`, …) resolve to the server's default engine. `apiKey`
 * (when set) is sent as `Authorization: Bearer <key>` on every request.
 *
 * **Operations.** `add` POSTs the document to `/add`, `addMany` POSTs the
 * whole array in one request (an empty array is sent too — the server answers
 * `{ ok: true, added: 0 }`), `update` PUTs to `/update` (server-side upsert),
 * `remove` DELETEs `/remove/:id` (200 no-op when absent), and `search` POSTs
 * `/searchWithMeta` and strips the query-level `truncated` flag (the hit
 * shape is identical on both server endpoints). `close()` is synchronous and
 * only seals the engine — every later use throws
 * `"Search engine is closed"`, mirroring fts5/memory/meilisearch.
 *
 * **Not supported over HTTP (documented, not faked):** verified raw offsets —
 * the server strips `quote`/`start`/`end`/`occurrences` from hits, so
 * `offsets: true` cannot be honored; `truncated` defaults to `false` when the
 * response omits it. Document ids round-trip through a local id tracker, so
 * numeric ids stay numeric in `search()` results even though the server
 * hands back strings.
 *
 * ```ts
 * import { createThaiFtsServerEngine } from "thai-fts";
 * const engine = createThaiFtsServerEngine({ endpoint: "http://localhost:8787" });
 * await engine.add({ id: 1, title: "คู่มือ", body: "ติดตั้งโปรแกรม" });
 * const hits = await engine.search("ติดตั้ง");
 * engine.close();
 * ```
 */
import {
  authHeaders,
  makeIdTracker,
  requestJSON,
  searchDefaults,
} from "../_http.js";
import {
  registerAsyncEngine,
  type ThaiAsyncEngine,
  type ThaiEngineOptions,
  type ThaiSearchDoc,
  type ThaiSearchOutcome,
  type ThaiSearchResult,
} from "../engine.js";

/** Options accepted by `createThaiFtsServerEngine`. `tone`/`limit` act as
 * per-search defaults (a per-call option overrides them); the remaining
 * `ThaiEngineOptions` are forwarded per call (`prefix`/`titleWeight` when the
 * hosted engine supports them, `offsets` documented unsupported over HTTP). */
export interface ThaiFtsServerEngineOptions {
  /** Server root URL, e.g. `http://localhost:8787` (trailing slash ok). */
  endpoint: string;
  /** Engine name hosted by the server; omit to use the server default. */
  engine?: string;
  /** Static API key, sent as `Authorization: Bearer <key>` on every request. */
  apiKey?: string;
  /** Default tone channel for `search()` calls that don't pass one. */
  tone?: ThaiEngineOptions["tone"];
  /** Default hit limit for `search()` calls that don't pass one. */
  limit?: number;
}

/** Shape of one hit in the server's search/searchWithMeta response
 * (`id/rank/snippet/meta` — offset fields are stripped server-side). */
interface ServerHit {
  id?: unknown;
  rank?: unknown;
  snippet?: unknown;
  meta?: Record<string, unknown>;
}

/** Parsed body of the server's searchWithMeta response. */
interface ServerSearchOutcome {
  hits?: unknown;
  truncated?: unknown;
}

/**
 * Build a thin async `ThaiAsyncEngine` client over a thai-fts REST server
 * (Node ≥ 18 global `fetch`, no SDK). See the module header for the endpoint
 * layout and the unsupported-features list.
 */
export function createThaiFtsServerEngine(
  opts: ThaiFtsServerEngineOptions
): ThaiAsyncEngine & { update?(doc: ThaiSearchDoc): Promise<void> } {
  if (
    opts == null ||
    typeof opts.endpoint !== "string" ||
    !opts.endpoint.trim()
  ) {
    throw new TypeError("thaifts-server engine requires an `endpoint` URL");
  }
  const endpoint = opts.endpoint.trim().replace(/\/+$/, "");
  const engineName =
    typeof opts.engine === "string" && opts.engine.trim()
      ? opts.engine.trim()
      : null;
  const enginePath = engineName
    ? `/engines/${encodeURIComponent(engineName)}`
    : "";
  const headers = authHeaders("bearer", opts.apiKey ?? "");
  const base = searchDefaults(opts);
  const ids = makeIdTracker();
  let closed = false;

  const assertOpen = (): void => {
    if (closed) throw new Error("Search engine is closed");
  };

  const requireId = (doc: ThaiSearchDoc, method: string): void => {
    if (doc == null || doc.id === undefined || doc.id === null) {
      throw new TypeError(
        `thaifts-server engine ${method}() requires a document with an id`
      );
    }
  };

  const add = async (doc: ThaiSearchDoc): Promise<void> => {
    assertOpen();
    requireId(doc, "add");
    ids.track(doc.id);
    await requestJSON(endpoint, `${enginePath}/add`, "POST", {
      headers,
      body: doc,
    });
  };

  /**
   * Bulk-index every document in ONE request. Unlike the meilisearch adapter,
   * an empty batch is still sent — the server answers `{ ok, added: 0 }`,
   * keeping the round-trip observable.
   */
  const addMany = async (
    docs: Iterable<ThaiSearchDoc> | AsyncIterable<ThaiSearchDoc>
  ): Promise<void> => {
    assertOpen();
    const batch: ThaiSearchDoc[] = [];
    for await (const doc of docs) {
      requireId(doc, "addMany");
      ids.track(doc.id);
      batch.push(doc);
    }
    await requestJSON(endpoint, `${enginePath}/addMany`, "POST", {
      headers,
      body: batch,
    });
  };

  const remove = async (id: string | number): Promise<void> => {
    assertOpen();
    ids.drop(id);
    await requestJSON(
      endpoint,
      `${enginePath}/remove/${encodeURIComponent(String(id))}`,
      "DELETE",
      { headers }
    );
  };

  /** Upsert on the server (`update` = server-side `add`). */
  const update = async (doc: ThaiSearchDoc): Promise<void> => {
    assertOpen();
    requireId(doc, "update");
    ids.track(doc.id);
    await requestJSON(endpoint, `${enginePath}/update`, "PUT", {
      headers,
      body: doc,
    });
  };

  /**
   * Shared search pipeline: merges create-time defaults (`tone`/`limit`)
   * under the per-call options (per-call wins), POSTs the flat options object
   * to `/searchWithMeta` (booleans stay real booleans over POST), and maps
   * hits through the id tracker. `truncated` defaults to `false` when the
   * response omits it.
   */
  const searchOutcome = async (
    query: string,
    sOpts?: ThaiEngineOptions
  ): Promise<ThaiSearchOutcome> => {
    assertOpen();
    const merged = { ...base, ...sOpts };
    const body: Record<string, unknown> = { q: String(query ?? "") };
    if (merged.tone !== undefined) body.tone = merged.tone;
    if (merged.limit !== undefined) body.limit = merged.limit;
    if (merged.prefix !== undefined) body.prefix = merged.prefix;
    if (merged.offsets !== undefined) body.offsets = merged.offsets;
    if (merged.allTerms !== undefined) body.allTerms = merged.allTerms;
    if (merged.titleWeight !== undefined) body.titleWeight = merged.titleWeight;
    const res = (await requestJSON(
      endpoint,
      `${enginePath}/searchWithMeta`,
      "POST",
      { headers, body }
    )) as ServerSearchOutcome | null;
    const rawHits = Array.isArray(res?.hits)
      ? (res.hits as ServerHit[])
      : [];
    const hits: ThaiSearchResult[] = rawHits.map((h) => ({
      id: ids.restore(String(h?.id ?? "")),
      rank: typeof h?.rank === "number" ? h.rank : 0,
      snippet: typeof h?.snippet === "string" ? h.snippet : "",
      meta: h?.meta,
    }));
    return { hits, truncated: res?.truncated === true };
  };

  const search = async (
    query: string,
    sOpts?: ThaiEngineOptions
  ): Promise<ThaiSearchResult[]> => (await searchOutcome(query, sOpts)).hits;

  return {
    type: "thaifts-server",
    async: true,
    add,
    addMany,
    remove,
    update,
    search,
    searchWithMeta: searchOutcome,
    close() {
      // No local resources to release; closing only seals the engine.
      closed = true;
    },
  };
}

// Pre-register the reference adapter as an ASYNC engine so
// `createAsyncEngine("thaifts-server")` works out of the box.
registerAsyncEngine("thaifts-server", createThaiFtsServerEngine);
