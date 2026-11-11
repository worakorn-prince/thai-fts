// Meilisearch + Elasticsearch reference HTTP adapters (TASK-009 PART 2):
// hermetic tests against a fake `node:http` server that records every request
// (method, path, headers, parsed JSON body) and returns canned per-channel
// responses. Asserts the REQUEST SHAPE each adapter sends (segmented strict
// payload, phrase queries, attribute/field targeting, auth headers) and the
// client-side STRICT-THEN-LOOSE merge (dedupe, order, limit).
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const {
  createMeilisearchEngine,
  createElasticsearchEngine,
  createEngine,
  createAsyncEngine,
  isAsyncEngine,
  listAsyncEngines,
} = await import("../../dist/index.js");

/** Start a fake server on 127.0.0.1:<ephemeral> that records every request
 * and answers via `handler(record) -> 200 | { status?, body? }`. `record.body`
 * is the JSON-parsed body (null for an empty OR non-JSON body); `record.rawBody`
 * always holds the exact bytes, for NDJSON (`_bulk`) assertions. */
function startFakeServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      let parsed = null;
      if (body) {
        try {
          parsed = JSON.parse(body);
        } catch {
          parsed = null;
        }
      }
      const record = {
        method: req.method,
        path: req.url,
        headers: req.headers,
        body: parsed,
        rawBody: body,
      };
      requests.push(record);
      const out = handler(record);
      const status = typeof out === "number" ? out : (out?.status ?? 200);
      const payload = typeof out === "number" ? {} : (out?.body ?? {});
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        endpoint: `http://127.0.0.1:${port}`,
        requests,
        // fetch (undici) keeps connections alive; drop them so close()
        // resolves and the test process can exit.
        close: () =>
          new Promise((r) => {
            server.closeAllConnections?.();
            server.close(r);
          }),
      });
    });
  });
}

test("registry: HTTP adapters are ASYNC engines (createAsyncEngine, not createEngine)", async () => {
  // The sync creator refuses an async-registered name and names the right API.
  assert.throws(
    () => createEngine("meilisearch", { endpoint: "http://127.0.0.1:9", index: "x" }),
    /createAsyncEngine/
  );
  assert.throws(
    () => createEngine("elasticsearch", { endpoint: "http://127.0.0.1:9", index: "x" }),
    /createAsyncEngine/
  );
  const m = createAsyncEngine("meilisearch", {
    endpoint: "http://127.0.0.1:9",
    index: "x",
  });
  assert.equal(m.type, "meilisearch");
  assert.equal(isAsyncEngine(m), true);
  assert.equal(typeof m.searchWithMeta, "function");
  assert.equal(typeof m.addMany, "function");
  m.close();
  const e = createAsyncEngine("elasticsearch", {
    endpoint: "http://127.0.0.1:9",
    index: "x",
  });
  assert.equal(e.type, "elasticsearch");
  assert.equal(isAsyncEngine(e), true);
  e.close();
  const names = listAsyncEngines();
  assert.ok(names.includes("meilisearch"), `async engines: ${names}`);
  assert.ok(names.includes("elasticsearch"), `async engines: ${names}`);
  assert.ok(!listAsyncEngines().includes("fts5"), "sync engines stay out of the list");
});

test("meilisearch add: POSTs the two-doc batch (strict + loose payloads)", async () => {
  const srv = await startFakeServer(() => 200);
  const eng = createMeilisearchEngine({
    endpoint: srv.endpoint,
    index: "docs",
    apiKey: "KEY123",
  });
  await eng.add({ id: "a", title: "คู่มือ", body: "ติดตั้งโปรแกรม" });
  const req = srv.requests.at(-1);
  assert.equal(req.method, "POST");
  assert.equal(req.path, "/indexes/docs/documents");
  assert.equal(req.headers.authorization, "Bearer KEY123");
  assert.equal(req.headers["content-type"], "application/json");
  const [strictDoc, looseDoc] = req.body;
  assert.equal(strictDoc.id, "a");
  assert.equal(strictDoc.th_channel, "strict");
  // Strict payload is the SEGMENTED text: the word token survives intact.
  assert.ok(strictDoc.th_body.includes("\u{e15}\u{e31}\u{e49}\u{e07}"), `strict th_body: ${strictDoc.th_body}`);
  assert.ok(strictDoc.th_body.includes("\u{e42}\u{e1b}\u{e23}\u{e41}\u{e01}\u{e23}\u{e21}"));
  assert.ok(strictDoc.th_title.includes("คู่มือ"));
  // Loose twin: id suffixed, tone marks stripped from the SAME payload.
  assert.equal(looseDoc.id, "a::loose");
  assert.equal(looseDoc.th_channel, "loose");
  assert.ok(looseDoc.th_body.includes("\u{e15}\u{e31}\u{e07}"), `loose th_body: ${looseDoc.th_body}`);
  assert.ok(!looseDoc.th_body.includes("\u{e15}\u{e31}\u{e49}\u{e07}"));
  eng.close();
  await srv.close();
});

test("meilisearch search: posts strict THEN loose phrase queries and merges", async () => {
  const srv = await startFakeServer((rec) => {
    if (rec.method === "POST" && rec.path === "/indexes/docs/search") {
      if (String(rec.body.filter).includes("strict")) {
        return { body: { hits: [{ id: "a", _rankingScore: 1 }] } };
      }
      return { body: { hits: [{ id: "b::loose", _rankingScore: 2 }] } };
    }
    return 200;
  });
  const eng = createMeilisearchEngine({ endpoint: srv.endpoint, index: "docs" });
  const results = await eng.search("ติดตั้ง", { limit: 5 });
  const searchReqs = srv.requests.filter(
    (r) => r.method === "POST" && r.path === "/indexes/docs/search"
  );
  assert.equal(searchReqs.length, 2, "strict channel first, then loose");
  const [strictReq, looseReq] = searchReqs;
  // Strict request: quoted strict phrase (segmentation words joined) + channel filter.
  assert.equal(strictReq.body.q, `"ติด ตั้ง"`);
  assert.ok(String(strictReq.body.filter).includes("strict"));
  assert.deepEqual(strictReq.body.attributesToSearch, ["th_title", "th_body"]);
  assert.equal(strictReq.body.limit, 5);
  // Loose request: the de-accented twin phrase.
  assert.equal(looseReq.body.q, `"\u{e15}\u{e34}\u{e14} \u{e15}\u{e31}\u{e07}"`);
  assert.ok(String(looseReq.body.filter).includes("loose"));
  // Client-side merge: strict hit first, loose hit after, loose twin stripped.
  assert.deepEqual(results.map((r) => r.id), ["a", "b"]);
  assert.deepEqual(
    results.map((r) => r.meta.channel),
    ["strict", "loose"]
  );
  assert.equal(results[0].rank, 1);
  assert.equal(results[1].rank, 2);
  assert.ok(!("start" in results[0]), "offsets are not supported here");
  eng.close();
  await srv.close();
});

test("meilisearch search: strict-then-loose merge dedupes by base id", async () => {
  const srv = await startFakeServer((rec) => {
    if (rec.method === "POST" && rec.path === "/indexes/docs/search") {
      if (String(rec.body.filter).includes("strict")) {
        return { body: { hits: [{ id: "a", _rankingScore: 3 }, { id: "b", _rankingScore: 2 }] } };
      }
      // "b" also matches loose: its loose twin must NOT duplicate it.
      return {
        body: {
          hits: [
            { id: "b::loose", _rankingScore: 5 },
            { id: "c::loose", _rankingScore: 4 },
          ],
        },
      };
    }
    return 200;
  });
  const eng = createMeilisearchEngine({ endpoint: srv.endpoint, index: "docs" });
  const results = await eng.search("ติดตั้ง");
  assert.deepEqual(results.map((r) => r.id), ["a", "b", "c"]);
  assert.deepEqual(
    results.map((r) => r.meta.channel),
    ["strict", "strict", "loose"]
  );
  // limit caps the merged list.
  const capped = await eng.search("ติดตั้ง", { limit: 2 });
  assert.deepEqual(capped.map((r) => r.id), ["a", "b"]);
  eng.close();
  await srv.close();
});

test("meilisearch remove: DELETEs both the base id and the loose twin", async () => {
  const srv = await startFakeServer(() => 200);
  const eng = createMeilisearchEngine({ endpoint: srv.endpoint, index: "docs" });
  await eng.remove("a");
  const dels = srv.requests.filter((r) => r.method === "DELETE");
  assert.deepEqual(
    dels.map((r) => r.path),
    [
      "/indexes/docs/documents/a",
      "/indexes/docs/documents/a%3A%3Aloose",
    ]
  );
  eng.close();
  await srv.close();
});

test("meilisearch search: non-2xx response rejects with status + body", async () => {
  const srv = await startFakeServer(() => ({
    status: 500,
    body: { message: "internal error" },
  }));
  const eng = createMeilisearchEngine({ endpoint: srv.endpoint, index: "docs" });
  await assert.rejects(eng.search("ติดตั้ง"), /HTTP 500.*internal error/);
  eng.close();
  await srv.close();
});

test("meilisearch: after close every use throws the clear error", async () => {
  const srv = await startFakeServer(() => 200);
  const eng = createMeilisearchEngine({ endpoint: srv.endpoint, index: "docs" });
  eng.close();
  eng.close(); // idempotent
  await assert.rejects(eng.search("ติดตั้ง"), /Search engine is closed/);
  await assert.rejects(eng.add({ id: "z", body: "x" }), /Search engine is closed/);
  await assert.rejects(eng.remove("z"), /Search engine is closed/);
  await srv.close();
});

test("elasticsearch add: PUTs _doc/{id} with th_token (segmented strict payload)", async () => {
  const srv = await startFakeServer(() => 200);
  const eng = createElasticsearchEngine({
    endpoint: srv.endpoint,
    index: "docs",
    apiKey: "KEY123",
  });
  await eng.add({ id: "a", title: "คู่มือ", body: "ติดตั้งโปรแกรม" });
  const req = srv.requests.at(-1);
  assert.equal(req.method, "PUT");
  assert.equal(req.path, "/docs/_doc/a");
  // Basic auth: ES API-key scheme — base64 of `:<apiKey>` (empty user).
  assert.equal(req.headers.authorization, "Basic OktFWTEyMw==");
  assert.ok(req.body.th_token.includes("\u{e15}\u{e31}\u{e49}\u{e07}"), `th_token: ${req.body.th_token}`);
  assert.ok(req.body.th_token_loose.includes("\u{e15}\u{e31}\u{e07}"));
  assert.ok(!req.body.th_token_loose.includes("\u{e15}\u{e31}\u{e49}\u{e07}"));
  assert.equal(req.body.th_title, "คู่มือ");
  assert.equal(req.body.th_body, "ติดตั้งโปรแกรม");
  eng.close();
  await srv.close();
});

test("elasticsearch search: match_phrase on th_token/th_token_loose, strict-then-loose merge", async () => {
  const srv = await startFakeServer((rec) => {
    if (rec.method === "POST" && rec.path === "/docs/_search") {
      const should = rec.body.query.bool.should;
      const field = Object.keys(should[0].match_phrase)[0];
      if (field === "th_token") {
        return { body: { hits: { hits: [{ _id: "a", _score: 2 }] } } };
      }
      // "a" also matches the loose field: the merge must NOT duplicate it.
      return {
        body: {
          hits: {
            hits: [
              { _id: "b", _score: 1 },
              { _id: "a", _score: 0.5 },
            ],
          },
        },
      };
    }
    return 200;
  });
  const eng = createElasticsearchEngine({ endpoint: srv.endpoint, index: "docs" });
  const results = await eng.search("ติดตั้ง", { limit: 5 });
  const searchReqs = srv.requests.filter(
    (r) => r.method === "POST" && r.path === "/docs/_search"
  );
  assert.equal(searchReqs.length, 2);
  const [strictReq, looseReq] = searchReqs;
  assert.equal(strictReq.body.query.bool.should[0].match_phrase.th_token, "ติด ตั้ง");
  assert.equal(strictReq.body.query.bool.minimum_should_match, 1);
  assert.equal(strictReq.body.size, 5);
  assert.equal(looseReq.body.query.bool.should[0].match_phrase.th_token_loose, "ติด ตัง");
  // Merge: strict "a" first, loose "b" after, "a" deduped (strict wins).
  assert.deepEqual(results.map((r) => r.id), ["a", "b"]);
  assert.deepEqual(
    results.map((r) => r.meta.channel),
    ["strict", "loose"]
  );
  assert.equal(results[1].meta.method, "elasticsearch");
  eng.close();
  await srv.close();
});

test("meilisearch search: meta.truncated surfaces only a capped query", async () => {
  const srv = await startFakeServer((rec) => {
    if (rec.method === "POST" && rec.path === "/indexes/docs/search") {
      return { body: { hits: [{ id: "a", _rankingScore: 1 }] } };
    }
    return 200;
  });
  const eng = createMeilisearchEngine({ endpoint: srv.endpoint, index: "docs" });
  const words = Array.from({ length: 9 }, (_, i) => `chunkword${i}`);
  const capped = await eng.search(words.join(" "), { tone: "strict" });
  assert.equal(capped.length, 1);
  assert.equal(capped[0].meta.truncated, true, "the dropped 9th chunk must be visible");
  assert.deepEqual(capped[0].meta, {
    method: "meilisearch",
    channel: "strict",
    truncated: true,
  });
  // The request only carried the first 8 chunks; the 9th is gone.
  const cappedQ = srv.requests.at(-1).body.q;
  assert.ok(!cappedQ.includes("chunkword8"), `the 9th chunk must be dropped: ${cappedQ}`);
  const short = await eng.search("chunkword0 chunkword1", { tone: "strict" });
  assert.equal(short.length, 1);
  assert.deepEqual(
    short[0].meta,
    { method: "meilisearch", channel: "strict" },
    "an uncapped hit keeps its original meta shape (no `truncated` key)"
  );
  eng.close();
  await srv.close();
});

test("meilisearch search: allTerms is accepted and ignored (no payload change)", async () => {
  const srv = await startFakeServer((rec) => {
    if (rec.method === "POST" && rec.path === "/indexes/docs/search") {
      return { body: { hits: [{ id: "a", _rankingScore: 1 }, { id: "b", _rankingScore: 0.5 }] } };
    }
    return 200;
  });
  const eng = createMeilisearchEngine({ endpoint: srv.endpoint, index: "docs" });
  const before = srv.requests.length;
  const plain = await eng.search("alpha beta", { tone: "strict" });
  const plainBodies = srv.requests.slice(before).map((r) => r.body);
  const mid = srv.requests.length;
  const andTerms = await eng.search("alpha beta", { tone: "strict", allTerms: true });
  const andBodies = srv.requests.slice(mid).map((r) => r.body);
  assert.deepEqual(andTerms, plain, "allTerms must not change the result");
  assert.deepEqual(
    andBodies,
    plainBodies,
    "allTerms is not sent to the server: the request payload stays identical"
  );
  eng.close();
  await srv.close();
});

test("elasticsearch search: meta.truncated surfaces only a capped query", async () => {
  const srv = await startFakeServer((rec) => {
    if (rec.method === "POST" && rec.path === "/docs/_search") {
      return { body: { hits: { hits: [{ _id: "a", _score: 1 }] } } };
    }
    return 200;
  });
  const eng = createElasticsearchEngine({ endpoint: srv.endpoint, index: "docs" });
  const words = Array.from({ length: 9 }, (_, i) => `chunkword${i}`);
  const capped = await eng.search(words.join(" "), { tone: "strict" });
  assert.equal(capped.length, 1);
  assert.equal(capped[0].meta.truncated, true, "the dropped 9th chunk must be visible");
  assert.deepEqual(capped[0].meta, {
    method: "elasticsearch",
    channel: "strict",
    truncated: true,
  });
  const should = srv.requests.at(-1).body.query.bool.should;
  assert.equal(should.length, 8, "the request carries at most MAX_QUERY_CHUNKS chunks");
  assert.ok(
    !JSON.stringify(should).includes("chunkword8"),
    "the 9th chunk must be dropped from the request"
  );
  const short = await eng.search("chunkword0 chunkword1", { tone: "strict" });
  assert.equal(short.length, 1);
  assert.deepEqual(
    short[0].meta,
    { method: "elasticsearch", channel: "strict" },
    "an uncapped hit keeps its original meta shape (no `truncated` key)"
  );
  eng.close();
  await srv.close();
});

test("elasticsearch search: allTerms is accepted and ignored (no payload change)", async () => {
  const srv = await startFakeServer((rec) => {
    if (rec.method === "POST" && rec.path === "/docs/_search") {
      return { body: { hits: { hits: [{ _id: "a", _score: 1 }, { _id: "b", _score: 0.5 }] } } };
    }
    return 200;
  });
  const eng = createElasticsearchEngine({ endpoint: srv.endpoint, index: "docs" });
  const before = srv.requests.length;
  const plain = await eng.search("alpha beta", { tone: "strict" });
  const plainBodies = srv.requests.slice(before).map((r) => r.body);
  const mid = srv.requests.length;
  const andTerms = await eng.search("alpha beta", { tone: "strict", allTerms: true });
  const andBodies = srv.requests.slice(mid).map((r) => r.body);
  assert.deepEqual(andTerms, plain, "allTerms must not change the result");
  assert.deepEqual(
    andBodies,
    plainBodies,
    "allTerms is not sent to the server: the request payload stays identical"
  );
  eng.close();
  await srv.close();
});

test("elasticsearch: non-2xx rejects; remove swallows 404; closed throws", async () => {
  let n = 0;
  const srv = await startFakeServer((rec) => {
    n += 1;
    if (rec.method === "POST" && rec.path === "/docs/_search") {
      return { status: 500, body: { error: "boom" } };
    }
    return { status: 404, body: { error: "not_found" } };
  });
  const eng = createElasticsearchEngine({ endpoint: srv.endpoint, index: "docs" });
  await assert.rejects(eng.search("ติดตั้ง"), /HTTP 500.*boom/);
  await eng.remove("a"); // 404 is swallowed: remove() is a no-op when absent
  eng.close();
  await assert.rejects(eng.search("ติดตั้ง"), /Search engine is closed/);
  await srv.close();
});

/* ------------------------------------------------------------------ *
 * TASK-013 W2: addMany (bulk) + searchWithMeta (0-hit truncation)
 * ------------------------------------------------------------------ */

/** Wrap docs in an async generator (the `AsyncIterable` addMany input). */
async function* asyncDocs(docs) {
  for (const doc of docs) yield doc;
}

test("meilisearch addMany: ONE request with both channel docs per logical doc", async () => {
  const srv = await startFakeServer(() => 200);
  const eng = createMeilisearchEngine({ endpoint: srv.endpoint, index: "docs" });
  await eng.addMany([
    { id: 1, title: "คู่มือ", body: "ติดตั้งโปรแกรม" },
    { id: 2, body: "alpha beta" },
  ]);
  assert.equal(srv.requests.length, 1, "a whole batch is ONE documents POST");
  const req = srv.requests[0];
  assert.equal(req.method, "POST");
  assert.equal(req.path, "/indexes/docs/documents");
  assert.equal(req.headers["content-type"], "application/json");
  assert.ok(Array.isArray(req.body));
  assert.equal(req.body.length, 4, "two channel docs per logical doc");
  assert.deepEqual(
    req.body.map((d) => d.id),
    ["1", "1::loose", "2", "2::loose"]
  );
  assert.deepEqual(
    req.body.map((d) => d.th_channel),
    ["strict", "loose", "strict", "loose"]
  );
  // Same builders as add(): strict keeps the tone mark, loose strips it.
  assert.ok(req.body[0].th_body.includes("\u{e15}\u{e31}\u{e49}\u{e07}"));
  assert.ok(req.body[1].th_body.includes("\u{e15}\u{e31}\u{e07}"));
  assert.ok(!req.body[1].th_body.includes("\u{e15}\u{e31}\u{e49}\u{e07}"));
  eng.close();
  await srv.close();
});

test("meilisearch addMany: AsyncIterable works; an empty batch sends nothing", async () => {
  const srv = await startFakeServer(() => 200);
  const eng = createMeilisearchEngine({ endpoint: srv.endpoint, index: "docs" });
  await eng.addMany(asyncDocs([{ id: 3, body: "alpha" }]));
  assert.equal(srv.requests.length, 1);
  assert.deepEqual(
    srv.requests[0].body.map((d) => d.id),
    ["3", "3::loose"]
  );
  const afterIterable = srv.requests.length;
  await eng.addMany([]);
  assert.equal(srv.requests.length, afterIterable, "empty array: 0 requests");
  await eng.addMany(asyncDocs([]));
  assert.equal(srv.requests.length, afterIterable, "empty async batch: 0 requests");
  eng.close();
  await assert.rejects(
    eng.addMany([{ id: 4, body: "x" }]),
    /Search engine is closed/
  );
  await srv.close();
});

test("elasticsearch addMany: ONE _bulk request, NDJSON action+doc pairs for both channels", async () => {
  const srv = await startFakeServer(() => 200);
  const eng = createElasticsearchEngine({ endpoint: srv.endpoint, index: "docs" });
  await eng.addMany([
    { id: 1, title: "คู่มือ", body: "ติดตั้งโปรแกรม" },
    { id: 2, body: "alpha beta" },
  ]);
  assert.equal(srv.requests.length, 1, "a whole batch is ONE _bulk POST");
  const req = srv.requests[0];
  assert.equal(req.method, "POST");
  assert.equal(req.path, "/_bulk");
  assert.ok(
    req.headers["content-type"].startsWith("application/x-ndjson"),
    `content-type: ${req.headers["content-type"]}`
  );
  assert.ok(req.rawBody.endsWith("\n"), "the NDJSON body ends with a newline");
  const lines = req.rawBody.split("\n");
  assert.equal(lines.at(-1), "", "trailing newline");
  const bodyLines = lines.slice(0, -1);
  assert.equal(bodyLines.length, 8, "4 action lines + 4 doc lines");
  const actions = [];
  const docs = [];
  for (let i = 0; i < bodyLines.length; i += 2) {
    actions.push(JSON.parse(bodyLines[i]));
    docs.push(JSON.parse(bodyLines[i + 1]));
  }
  assert.deepEqual(
    actions.map((a) => a.index._id),
    ["1", "1::loose", "2", "2::loose"]
  );
  assert.deepEqual(
    actions.map((a) => a.index._index),
    ["docs", "docs", "docs", "docs"]
  );
  // Strict doc carries th_token, its loose twin th_token_loose.
  assert.ok(docs[0].th_token.includes("\u{e15}\u{e31}\u{e49}\u{e07}"));
  assert.equal(docs[0].th_token_loose, undefined);
  assert.ok(docs[1].th_token_loose.includes("\u{e15}\u{e31}\u{e07}"));
  assert.ok(!docs[1].th_token_loose.includes("\u{e15}\u{e31}\u{e49}\u{e07}"));
  assert.equal(docs[1].th_token, undefined);
  eng.close();
  await srv.close();
});

test("elasticsearch addMany: AsyncIterable works; an empty batch sends nothing", async () => {
  const srv = await startFakeServer(() => 200);
  const eng = createElasticsearchEngine({ endpoint: srv.endpoint, index: "docs" });
  await eng.addMany(asyncDocs([{ id: 3, body: "alpha" }]));
  assert.equal(srv.requests.length, 1);
  assert.equal(srv.requests[0].path, "/_bulk");
  const afterIterable = srv.requests.length;
  await eng.addMany([]);
  assert.equal(srv.requests.length, afterIterable, "empty array: 0 requests");
  await eng.addMany(asyncDocs([]));
  assert.equal(srv.requests.length, afterIterable, "empty async batch: 0 requests");
  eng.close();
  await assert.rejects(
    eng.addMany([{ id: 4, body: "x" }]),
    /Search engine is closed/
  );
  await srv.close();
});

test("elasticsearch addMany: errors:true in the _bulk response rejects naming the failed id", async () => {
  const srv = await startFakeServer((rec) => {
    if (rec.method === "POST" && rec.path === "/_bulk") {
      return {
        body: {
          errors: true,
          items: [
            { index: { _index: "docs", _id: "1", status: 201 } },
            { index: { _index: "docs", _id: "1::loose", status: 201 } },
            {
              index: {
                _index: "docs",
                _id: "2",
                status: 400,
                error: { type: "mapper_parsing_exception" },
              },
            },
            { index: { _index: "docs", _id: "2::loose", status: 201 } },
          ],
        },
      };
    }
    return 200;
  });
  const eng = createElasticsearchEngine({ endpoint: srv.endpoint, index: "docs" });
  await assert.rejects(
    eng.addMany([
      { id: 1, body: "alpha" },
      { id: 2, body: "beta" },
    ]),
    /ids: 2$/
  );
  assert.equal(srv.requests.length, 1);
  eng.close();
  await srv.close();
});

test("meilisearch searchWithMeta: truncated stays true for a 0-hit capped query", async () => {
  const srv = await startFakeServer((rec) => {
    if (rec.method === "POST" && rec.path === "/indexes/docs/search") {
      const q = String(rec.body.q);
      return {
        body: { hits: q.includes("chunkword") ? [] : [{ id: "a", _rankingScore: 1 }] },
      };
    }
    return 200;
  });
  const eng = createMeilisearchEngine({ endpoint: srv.endpoint, index: "docs" });
  const words = Array.from({ length: 9 }, (_, i) => `chunkword${i}`);
  const capped = await eng.searchWithMeta(words.join(" "), { tone: "strict" });
  assert.deepEqual(capped.hits, []);
  assert.equal(capped.truncated, true, "no hits must not read as a complete result");
  const open = await eng.searchWithMeta("alpha beta", { tone: "strict" });
  assert.deepEqual(open.hits.map((h) => h.id), ["a"]);
  assert.equal(open.truncated, false);
  // search() unchanged: just the hits array, same objects as searchWithMeta.
  const hits = await eng.search("alpha beta", { tone: "strict" });
  assert.deepEqual(hits, open.hits);
  eng.close();
  await srv.close();
});

test("elasticsearch searchWithMeta: truncated stays true for a 0-hit capped query", async () => {
  const srv = await startFakeServer((rec) => {
    if (rec.method === "POST" && rec.path === "/docs/_search") {
      const q = JSON.stringify(rec.body.query);
      return {
        body: {
          hits: { hits: q.includes("chunkword") ? [] : [{ _id: "a", _score: 1 }] },
        },
      };
    }
    return 200;
  });
  const eng = createElasticsearchEngine({ endpoint: srv.endpoint, index: "docs" });
  const words = Array.from({ length: 9 }, (_, i) => `chunkword${i}`);
  const capped = await eng.searchWithMeta(words.join(" "), { tone: "strict" });
  assert.deepEqual(capped.hits, []);
  assert.equal(capped.truncated, true, "no hits must not read as a complete result");
  const open = await eng.searchWithMeta("alpha beta", { tone: "strict" });
  assert.deepEqual(open.hits.map((h) => h.id), ["a"]);
  assert.equal(open.truncated, false);
  const hits = await eng.search("alpha beta", { tone: "strict" });
  assert.deepEqual(hits, open.hits);
  eng.close();
  await srv.close();
});
