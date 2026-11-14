/**
 * HTTP route handlers for the thai-fts REST API server.
 */

import { IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";
import type { ThaiSearchEngine, ThaiAsyncEngine, ThaiSearchDoc, ThaiEngineOptions, ThaiSearchResult, ThaiSearchOutcome } from "../adapters/engine.js";
import type { ServerEngineRegistry, EngineInstance } from "./engine-registry.js";
import type { SearchParams, AddRequest, ApiResponse, HealthResponse, AddManyResponse, SearchResponse, SearchWithMetaResponse } from "./types.js";

const MAX_BODY_SIZE = 1024 * 1024; // 1MB

/** Extract-based narrowed views of the discriminated `EngineInstance` union:
 * `async` is the discriminant, so these give the right `engine` type. */
type AsyncEngineInstance = Extract<EngineInstance, { async: true }>;
type SyncEngineInstance = Extract<EngineInstance, { async: false }>;

/** Type guard for async engines. */
function isAsyncEngineInstance(engine: EngineInstance): engine is AsyncEngineInstance {
  return engine.async;
}

/** Type guard for sync engines. */
function isSyncEngineInstance(engine: EngineInstance): engine is SyncEngineInstance {
  return !engine.async;
}

/** Read and parse JSON request body with size limit. */
export async function readJsonBody(req: IncomingMessage, maxSize = MAX_BODY_SIZE): Promise<unknown> {
  // Validate here rather than before routing: a pre-dispatch check would turn
  // "wrong method on a known path" into a 400 instead of the correct 405.
  const contentType = req.headers["content-type"] ?? "";
  if (!contentType.includes("application/json")) {
    throw new Error("Content-Type must be application/json");
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    let overflow = false;
    const chunks: Buffer[] = [];

    req.on("data", (chunk: Buffer) => {
      if (overflow) return;
      size += chunk.length;
      if (size > maxSize) {
        // Keep consuming (and discarding) so the client can still read the 413
        // response; destroying the request here would kill the socket first.
        overflow = true;
        chunks.length = 0;
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString("utf8");
        if (!body.trim()) {
          resolve({});
          return;
        }
        resolve(JSON.parse(body));
      } catch (e) {
        reject(new Error("Invalid JSON body"));
      }
    });

    req.on("error", reject);
  });
}

/** Parse query string into SearchParams. */
function parseSearchParams(searchParams: URLSearchParams): SearchParams {
  const q = searchParams.get("q") ?? "";
  const limit = searchParams.has("limit") ? Number(searchParams.get("limit")) : undefined;
  const tone = searchParams.get("tone") as "strict" | "loose" | "both" | null;
  const prefix = searchParams.has("prefix") ? searchParams.get("prefix") === "true" : undefined;
  const offsets = searchParams.has("offsets") ? searchParams.get("offsets") === "true" : undefined;
  const allTerms = searchParams.has("allTerms") ? searchParams.get("allTerms") === "true" : undefined;
  const titleWeight = searchParams.has("titleWeight") ? Number(searchParams.get("titleWeight")) : undefined;

  return {
    q,
    limit: Number.isFinite(limit) ? limit : undefined,
    tone: tone ?? undefined,
    prefix,
    offsets,
    allTerms,
    titleWeight: Number.isFinite(titleWeight) ? titleWeight : undefined,
  };
}

/** Validate required fields for add/update. */
function validateAddRequest(body: unknown): AddRequest {
  if (!body || typeof body !== "object") {
    throw new Error("Request body must be an object");
  }
  const req = body as Record<string, unknown>;
  if (req.id === undefined || req.id === null) {
    throw new Error("Missing required field: id");
  }
  if (typeof req.id !== "string" && typeof req.id !== "number") {
    throw new Error("id must be a string or a number");
  }
  const id: string | number = req.id;
  return {
    ...req,
    id,
    title: typeof req.title === "string" ? req.title : undefined,
    body: typeof req.body === "string" ? req.body : undefined,
  };
}

/** Validate search params. */
function validateSearchParams(params: SearchParams): void {
  if (!params.q || typeof params.q !== "string") {
    throw new Error("Missing required field: q");
  }
  if (params.limit !== undefined && (!Number.isInteger(params.limit) || params.limit < 1)) {
    throw new Error("limit must be a positive integer");
  }
  if (params.titleWeight !== undefined && !Number.isFinite(params.titleWeight)) {
    throw new Error("titleWeight must be a finite number");
  }
}

/** Convert engine options from SearchParams. */
function toEngineOptions(params: SearchParams): ThaiEngineOptions {
  return {
    limit: params.limit,
    tone: params.tone,
    prefix: params.prefix,
    offsets: params.offsets,
    allTerms: params.allTerms,
    titleWeight: params.titleWeight,
  };
}

/** Send JSON response with CORS headers. */
function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Thai-Fts-Engine");
  res.writeHead(status);
  res.end(JSON.stringify(data));
}

/** Send error response. */
function sendError(res: ServerResponse, status: number, error: string, message: string): void {
  sendJson(res, status, { ok: false, error, message });
}

/** Map a thrown error to a CLIENT status when the request itself was bad
 * (malformed body, wrong content-type, oversized body). Returns null for
 * engine/server failures, which must stay 500. */
function clientErrorFor(e: unknown): { status: number; error: string } | null {
  const message = e instanceof Error ? e.message : String(e);
  if (message === "Request body too large") return { status: 413, error: "Payload Too Large" };
  if (
    message.includes("Content-Type") ||
    message.includes("JSON") ||
    message.includes("field") ||
    message.includes("index") ||
    message.includes("must be a string or a number")
  ) {
    return { status: 400, error: "Bad Request" };
  }
  return null;
}

/** Handle CORS preflight. */
export function handleOptions(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Thai-Fts-Engine");
    res.writeHead(204);
    res.end();
    return true;
  }
  return false;
}

/** Extract engine name from request (path > header > query > default). */
function resolveEngineName(
  req: IncomingMessage,
  pathname: string,
  registry: ServerEngineRegistry
): string | null {
  // 1. Path param: /engines/:engine/...
  const pathMatch = pathname.match(/^\/engines\/([^/]+)/);
  if (pathMatch) {
    const rawEngine = pathMatch[1];
    if (rawEngine === undefined) return null;
    try {
      return decodeURIComponent(rawEngine);
    } catch {
      return rawEngine;
    }
  }

  // 2. Header: X-Thai-Fts-Engine
  const headerEngine = req.headers["x-thai-fts-engine"];
  if (headerEngine && typeof headerEngine === "string") {
    return headerEngine;
  }

  // 3. Query param: engine
  const url = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
  const queryEngine = url.searchParams.get("engine");
  if (queryEngine) {
    return queryEngine;
  }

  // 4. Default
  return registry.getDefaultEngineName();
}

/** Get engine instance or send 404. */
function getEngineOr404(
  res: ServerResponse,
  registry: ServerEngineRegistry,
  engineName: string | null
): EngineInstance | null {
  if (!engineName) {
    sendError(res, 400, "Bad Request", "No engine specified and no default engine available");
    return null;
  }

  const engine = registry.getEngine(engineName);
  if (!engine) {
    sendError(res, 404, "Not Found", `Engine '${engineName}' not registered`);
    return null;
  }

  return engine;
}

/** Route: GET /health */
export function handleHealth(
  req: IncomingMessage,
  res: ServerResponse,
  registry: ServerEngineRegistry,
  version: string
): void {
  if (handleOptions(req, res)) return;

  if (req.method !== "GET") {
    sendError(res, 405, "Method Not Allowed", "Only GET allowed");
    return;
  }

  const engines = registry.listEngineNames();
  const defaultEngine = registry.getDefaultEngineName() ?? "memory";

  const response: HealthResponse = {
    ok: true,
    engines,
    default: defaultEngine,
    version,
  };

  sendJson(res, 200, response);
}

/** Route: POST /engines/:engine/add */
export async function handleAdd(
  req: IncomingMessage,
  res: ServerResponse,
  registry: ServerEngineRegistry
): Promise<void> {
  if (handleOptions(req, res)) return;

  if (req.method !== "POST") {
    sendError(res, 405, "Method Not Allowed", "Only POST allowed");
    return;
  }

  const pathname = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`).pathname;
  const engineName = resolveEngineName(req, pathname, registry);
  const engine = getEngineOr404(res, registry, engineName);
  if (!engine) return;

  try {
    const body = await readJsonBody(req);
    const doc = validateAddRequest(body);

    if (isAsyncEngineInstance(engine)) {
      await engine.engine.add(doc);
    } else {
      engine.engine.add(doc);
    }

    sendJson(res, 201, { ok: true, id: doc.id });
  } catch (e) {
    const client = clientErrorFor(e);
    const message = e instanceof Error ? e.message : String(e);
    if (client) {
      sendError(res, client.status, client.error, message);
    } else if (message.includes("closed")) {
      sendError(res, 500, "Internal Error", "Engine is closed");
    } else {
      sendError(res, 500, "Internal Error", message);
    }
  }
}

/** Route: POST /engines/:engine/addMany */
export async function handleAddMany(
  req: IncomingMessage,
  res: ServerResponse,
  registry: ServerEngineRegistry
): Promise<void> {
  if (handleOptions(req, res)) return;

  if (req.method !== "POST") {
    sendError(res, 405, "Method Not Allowed", "Only POST allowed");
    return;
  }

  const pathname = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`).pathname;
  const engineName = resolveEngineName(req, pathname, registry);
  const engine = getEngineOr404(res, registry, engineName);
  if (!engine) return;

  try {
    const body = await readJsonBody(req);

    if (!Array.isArray(body)) {
      sendError(res, 400, "Bad Request", "Request body must be an array of documents");
      return;
    }

    if (body.length === 0) {
      sendJson(res, 201, { ok: true, added: 0 });
      return;
    }

    const docs: ThaiSearchDoc[] = [];
    for (let i = 0; i < body.length; i++) {
      try {
        docs.push(validateAddRequest(body[i]));
      } catch (e) {
        sendError(res, 400, "Bad Request", `Invalid document at index ${i}: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
    }

    if (isAsyncEngineInstance(engine)) {
      if (typeof engine.engine.addMany === "function") {
        await engine.engine.addMany(docs);
      } else {
        for (const doc of docs) await engine.engine.add(doc);
      }
    } else {
      if (typeof engine.engine.addMany === "function") {
        engine.engine.addMany(docs);
      } else {
        for (const doc of docs) engine.engine.add(doc);
      }
    }

    sendJson(res, 201, { ok: true, added: docs.length });
  } catch (e) {
    const client = clientErrorFor(e);
    const message = e instanceof Error ? e.message : String(e);
    if (client) {
      sendError(res, client.status, client.error, message);
    } else {
      sendError(res, 500, "Internal Error", message);
    }
  }
}

/** Route: DELETE /engines/:engine/remove/:id */
export async function handleRemove(
  req: IncomingMessage,
  res: ServerResponse,
  registry: ServerEngineRegistry
): Promise<void> {
  if (handleOptions(req, res)) return;

  if (req.method !== "DELETE") {
    sendError(res, 405, "Method Not Allowed", "Only DELETE allowed");
    return;
  }

  const url = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
  const pathname = url.pathname;
  const engineName = resolveEngineName(req, pathname, registry);
  const engine = getEngineOr404(res, registry, engineName);
  if (!engine) return;

  // Extract ID from path: /engines/:engine/remove/:id
  const pathMatch = pathname.match(/^\/engines\/[^/]+\/remove\/([^/]+)/);
  if (!pathMatch || pathMatch[1] === undefined) {
    sendError(res, 400, "Bad Request", "Missing document ID in path");
    return;
  }

  const id = decodeURIComponent(pathMatch[1]);

  try {
    if (isAsyncEngineInstance(engine)) {
      await engine.engine.remove(id);
    } else {
      engine.engine.remove(id);
    }
    sendJson(res, 200, { ok: true, id });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message.includes("closed")) {
      sendError(res, 500, "Internal Error", "Engine is closed");
    } else {
      sendError(res, 500, "Internal Error", message);
    }
  }
}

/** Route: PUT /engines/:engine/update */
export async function handleUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  registry: ServerEngineRegistry
): Promise<void> {
  if (handleOptions(req, res)) return;

  if (req.method !== "PUT") {
    sendError(res, 405, "Method Not Allowed", "Only PUT allowed");
    return;
  }

  const pathname = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`).pathname;
  const engineName = resolveEngineName(req, pathname, registry);
  const engine = getEngineOr404(res, registry, engineName);
  if (!engine) return;

  try {
    const body = await readJsonBody(req);
    const doc = validateAddRequest(body);

    if (isAsyncEngineInstance(engine)) {
      await engine.engine.add(doc); // add is upsert
    } else {
      engine.engine.add(doc); // add is upsert
    }

    sendJson(res, 200, { ok: true, id: doc.id });
  } catch (e) {
    const client = clientErrorFor(e);
    const message = e instanceof Error ? e.message : String(e);
    if (client) {
      sendError(res, client.status, client.error, message);
    } else {
      sendError(res, 500, "Internal Error", message);
    }
  }
}

/** Route: GET /engines/:engine/search?q=... */
export async function handleSearchGet(
  req: IncomingMessage,
  res: ServerResponse,
  registry: ServerEngineRegistry
): Promise<void> {
  if (handleOptions(req, res)) return;

  if (req.method !== "GET") {
    sendError(res, 405, "Method Not Allowed", "Only GET allowed");
    return;
  }

  const url = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
  const pathname = url.pathname;
  const engineName = resolveEngineName(req, pathname, registry);
  const engine = getEngineOr404(res, registry, engineName);
  if (!engine) return;

  const params = parseSearchParams(url.searchParams);
  try {
    validateSearchParams(params);
  } catch (e) {
    sendError(res, 400, "Bad Request", e instanceof Error ? e.message : String(e));
    return;
  }

  const options = toEngineOptions(params);

  try {
    let hits: ThaiSearchResult[];
    if (isAsyncEngineInstance(engine)) {
      hits = await engine.engine.search(params.q, options);
    } else {
      hits = engine.engine.search(params.q, options);
    }

    const response: SearchResponse = {
      hits: hits.map((h) => ({
        id: h.id,
        rank: h.rank,
        snippet: h.snippet,
        meta: h.meta,
      })),
    };
    sendJson(res, 200, { ok: true, ...response });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message.includes("closed")) {
      sendError(res, 500, "Internal Error", "Engine is closed");
    } else {
      sendError(res, 500, "Internal Error", message);
    }
  }
}

/** Route: POST /engines/:engine/search */
export async function handleSearchPost(
  req: IncomingMessage,
  res: ServerResponse,
  registry: ServerEngineRegistry
): Promise<void> {
  if (handleOptions(req, res)) return;

  if (req.method !== "POST") {
    sendError(res, 405, "Method Not Allowed", "Only POST allowed");
    return;
  }

  const pathname = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`).pathname;
  const engineName = resolveEngineName(req, pathname, registry);
  const engine = getEngineOr404(res, registry, engineName);
  if (!engine) return;

  try {
    const body = await readJsonBody(req);
    const params = body as SearchParams;

    // Validate required q field
    if (!params.q || typeof params.q !== "string") {
      sendError(res, 400, "Bad Request", "Missing required field: q");
      return;
    }

    validateSearchParams(params);
    const options = toEngineOptions(params);

    let hits: ThaiSearchResult[];
    if (isAsyncEngineInstance(engine)) {
      hits = await engine.engine.search(params.q, options);
    } else {
      hits = engine.engine.search(params.q, options);
    }

    const response: SearchResponse = {
      hits: hits.map((h) => ({
        id: h.id,
        rank: h.rank,
        snippet: h.snippet,
        meta: h.meta,
      })),
    };
    sendJson(res, 200, { ok: true, ...response });
  } catch (e) {
    const client = clientErrorFor(e);
    const message = e instanceof Error ? e.message : String(e);
    if (client) {
      sendError(res, client.status, client.error, message);
    } else if (message.includes("closed")) {
      sendError(res, 500, "Internal Error", "Engine is closed");
    } else {
      sendError(res, 500, "Internal Error", message);
    }
  }
}

/** Route: POST /engines/:engine/searchWithMeta */
export async function handleSearchWithMeta(
  req: IncomingMessage,
  res: ServerResponse,
  registry: ServerEngineRegistry
): Promise<void> {
  if (handleOptions(req, res)) return;

  if (req.method !== "POST") {
    sendError(res, 405, "Method Not Allowed", "Only POST allowed");
    return;
  }

  const pathname = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`).pathname;
  const engineName = resolveEngineName(req, pathname, registry);
  const engine = getEngineOr404(res, registry, engineName);
  if (!engine) return;

  try {
    const body = await readJsonBody(req);
    const params = body as SearchParams;

    if (!params.q || typeof params.q !== "string") {
      sendError(res, 400, "Bad Request", "Missing required field: q");
      return;
    }

    validateSearchParams(params);
    const options = toEngineOptions(params);

    let outcome: ThaiSearchOutcome;
    if (isAsyncEngineInstance(engine)) {
      if (typeof engine.engine.searchWithMeta === "function") {
        outcome = await engine.engine.searchWithMeta(params.q, options);
      } else {
        const hits = await engine.engine.search(params.q, options);
        outcome = { hits, truncated: false };
      }
    } else {
      if (typeof engine.engine.searchWithMeta === "function") {
        outcome = engine.engine.searchWithMeta(params.q, options);
      } else {
        const hits = engine.engine.search(params.q, options);
        outcome = { hits, truncated: false };
      }
    }

    const response: SearchWithMetaResponse = {
      hits: outcome.hits.map((h) => ({
        id: h.id,
        rank: h.rank,
        snippet: h.snippet,
        meta: h.meta,
      })),
      truncated: outcome.truncated,
    };
    sendJson(res, 200, { ok: true, ...response });
  } catch (e) {
    const client = clientErrorFor(e);
    const message = e instanceof Error ? e.message : String(e);
    if (client) {
      sendError(res, client.status, client.error, message);
    } else if (message.includes("closed")) {
      sendError(res, 500, "Internal Error", "Engine is closed");
    } else {
      sendError(res, 500, "Internal Error", message);
    }
  }
}

/** Route: POST /engines/:engine/close */
export async function handleClose(
  req: IncomingMessage,
  res: ServerResponse,
  registry: ServerEngineRegistry
): Promise<void> {
  if (handleOptions(req, res)) return;

  if (req.method !== "POST") {
    sendError(res, 405, "Method Not Allowed", "Only POST allowed");
    return;
  }

  const pathname = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`).pathname;
  const engineName = resolveEngineName(req, pathname, registry);
  const engine = getEngineOr404(res, registry, engineName);
  if (!engine) return;

  try {
    engine.engine.close();
    sendJson(res, 200, { ok: true, message: `Engine '${engineName}' closed` });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    sendError(res, 500, "Internal Error", message);
  }
}

/** Main request router. */
export async function routeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  registry: ServerEngineRegistry,
  version: string
): Promise<void> {
  // Handle CORS preflight for all routes
  if (handleOptions(req, res)) return;

  const url = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
  let pathname = url.pathname;

  // Root-level shorthand: `/search`, `/add`, `/remove/:id`, … rewrite to the
  // resolved engine (`X-Thai-Fts-Engine` header > `engine` query param >
  // default) so a client can use one base URL. The explicit
  // `/engines/:engine/...` form still wins because it matches first.
  if (/^\/(add|addMany|remove|update|search|searchWithMeta|close)(\/|$)/.test(pathname)) {
    const shorthandEngine = resolveEngineName(req, pathname, registry);
    if (shorthandEngine !== null) {
      const rawUrl = req.url ?? "";
      const queryIndex = rawUrl.indexOf("?");
      const query = queryIndex >= 0 ? rawUrl.slice(queryIndex) : "";
      pathname = `/engines/${encodeURIComponent(shorthandEngine)}${pathname}`;
      req.url = `${pathname}${query}`;
    }
  }

  // Content-Type is validated inside readJsonBody, so requests that never reach
  // a body-reading route (e.g. PUT /search) still get the correct error.

  // Reject an oversized declared body before reading it: `content-length` is
  // known up front, so the client reliably gets a 413 instead of racing a
  // mid-stream abort. Chunked uploads still hit the guard in readJsonBody.
  const declaredLength = Number(req.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_SIZE) {
    sendError(res, 413, "Payload Too Large", "Request body too large");
    req.resume(); // drain the remainder so the client can read the response
    return;
  }

  try {
    // Health check
    if (pathname === "/health" && req.method === "GET") {
      handleHealth(req, res, registry, version);
      return;
    }

    // Engine routes
    if (pathname.startsWith("/engines/")) {
      // POST /engines/:engine/add
      if (pathname.match(/^\/engines\/[^/]+\/add$/) && req.method === "POST") {
        await handleAdd(req, res, registry);
        return;
      }

      // POST /engines/:engine/addMany
      if (pathname.match(/^\/engines\/[^/]+\/addMany$/) && req.method === "POST") {
        await handleAddMany(req, res, registry);
        return;
      }

      // DELETE /engines/:engine/remove/:id
      if (pathname.match(/^\/engines\/[^/]+\/remove\/[^/]+$/) && req.method === "DELETE") {
        await handleRemove(req, res, registry);
        return;
      }

      // PUT /engines/:engine/update
      if (pathname.match(/^\/engines\/[^/]+\/update$/) && req.method === "PUT") {
        await handleUpdate(req, res, registry);
        return;
      }

      // GET /engines/:engine/search
      if (pathname.match(/^\/engines\/[^/]+\/search$/) && req.method === "GET") {
        await handleSearchGet(req, res, registry);
        return;
      }

      // POST /engines/:engine/search
      if (pathname.match(/^\/engines\/[^/]+\/search$/) && req.method === "POST") {
        await handleSearchPost(req, res, registry);
        return;
      }

      // POST /engines/:engine/searchWithMeta
      if (pathname.match(/^\/engines\/[^/]+\/searchWithMeta$/) && req.method === "POST") {
        await handleSearchWithMeta(req, res, registry);
        return;
      }

      // POST /engines/:engine/close
      if (pathname.match(/^\/engines\/[^/]+\/close$/) && req.method === "POST") {
        await handleClose(req, res, registry);
        return;
      }
    }

    // Known engine paths reached with an unsupported method → 405 (not 404),
    // with an Allow header documenting what the route accepts.
    const engineRoutes: Array<[RegExp, string]> = [
      [/^\/engines\/[^/]+\/add$/, "POST"],
      [/^\/engines\/[^/]+\/addMany$/, "POST"],
      [/^\/engines\/[^/]+\/remove\/[^/]+$/, "DELETE"],
      [/^\/engines\/[^/]+\/update$/, "PUT"],
      [/^\/engines\/[^/]+\/search$/, "GET, POST"],
      [/^\/engines\/[^/]+\/searchWithMeta$/, "POST"],
      [/^\/engines\/[^/]+\/close$/, "POST"],
    ];
    for (const [pattern, allow] of engineRoutes) {
      if (pattern.test(pathname)) {
        res.setHeader("Allow", allow);
        sendError(res, 405, "Method Not Allowed", `Allowed methods: ${allow}`);
        return;
      }
    }
    if (pathname === "/health") {
      res.setHeader("Allow", "GET");
      sendError(res, 405, "Method Not Allowed", "Allowed methods: GET");
      return;
    }

    // Not found
    sendError(res, 404, "Not Found", `Route not found: ${req.method} ${pathname}`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    sendError(res, 500, "Internal Error", message);
  }
}