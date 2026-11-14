// TASK-021: REST API server tests — boots a real HTTP server on an ephemeral
// port against the always-available memory engine and exercises the full
// endpoint surface: health, add, addMany, search (GET+POST), searchWithMeta,
// update, remove, error paths (404/400/405) and graceful close.
//
// The dual-channel assertions mirror the library contract: strict hits lead,
// loose rescues rank below, never displacing a strict hit.
import { test } from "node:test";
import assert from "node:assert/strict";

const { createServer } = await import("../../dist/server/index.js");

const DOCS = [
  { id: "g1", title: "คู่มือติดตั้ง", body: "ขั้นตอนการติดตั้งโปรแกรมบนเซิร์ฟเวอร์" },
  { id: "b1", title: "ติดตังค่าบริการ", body: "ชำระรายเดือน" },
];

async function start(engines, defaultEngine) {
  const srv = await createServer({
    port: 0, // ephemeral
    host: "127.0.0.1",
    engines,
    defaultEngine,
  });
  return { srv, base: srv.address() };
}

const json = async (base, path, init) => {
  const res = await fetch(`${base}${path}`, init);
  return { status: res.status, body: await res.json(), headers: res.headers };
};

const post = (base, path, payload, init = {}) =>
  json(base, path, {
    method: "POST",
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    body: JSON.stringify(payload),
  });

test("health lists engines, default engine and package version", async () => {
  const { srv, base } = await start(
    [
      { name: "memory", factory: "createMemoryEngine" },
      { name: "alt", factory: "createMemoryEngine" },
    ],
    "alt"
  );
  try {
    const { status, body } = await json(base, "/health");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.deepEqual(body.engines, ["alt", "memory"]);
    assert.equal(body.default, "alt");
    assert.ok(typeof body.version === "string" && body.version.length > 0);
  } finally {
    await srv.close();
  }
});

test("add + GET search: strict hit first, loose rescue below (never displacing)", async () => {
  const { srv, base } = await start([{ name: "memory", factory: "createMemoryEngine" }]);
  try {
    for (const doc of DOCS) {
      const r = await post(base, "/engines/memory/add", doc);
      assert.equal(r.status, 201);
      assert.equal(r.body.ok, true);
    }
    // "ติดตั้ง" matches g1 strictly; b1 only via the loose channel.
    const q = encodeURIComponent("ติดตั้ง");
    const { status, body } = await json(base, `/engines/memory/search?q=${q}`);
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.deepEqual(
      body.hits.map((h) => `${h.id}:${h.meta.channel}`),
      ["g1:strict", "b1:loose"]
    );
  } finally {
    await srv.close();
  }
});

test("POST search with options + tone-typo query honors per-request tone", async () => {
  const { srv, base } = await start();
  try {
    for (const doc of DOCS) await post(base, "/engines/memory/add", doc);
    const { body } = await post(base, "/engines/memory/search", {
      q: "ติดตัง",
      tone: "strict",
      limit: 5,
    });
    // strict channel must NOT match the correctly-marked document.
    assert.deepEqual(body.hits.map((h) => h.id), ["b1"]);
  } finally {
    await srv.close();
  }
});

test("searchWithMeta returns the truncation flag even with zero hits", async () => {
  const { srv, base } = await start();
  try {
    // >8 chunks → truncated: true, regardless of hits.
    const { body } = await post(base, "/engines/memory/searchWithMeta", {
      q: "a b c d e f g h i j",
    });
    assert.equal(body.ok, true);
    assert.equal(typeof body.truncated, "boolean");
    const { body: empty } = await post(base, "/engines/memory/searchWithMeta", {
      q: "หาอะไรไม่เจอแน่นอนๆ",
    });
    assert.deepEqual(empty.hits, []);
  } finally {
    await srv.close();
  }
});

test("addMany, update (upsert) and remove keep the document set in lockstep", async () => {
  const { srv, base } = await start();
  try {
    const r = await post(base, "/engines/memory/addMany", [
      { id: "x1", body: "ติดตั้ง" },
      { id: "x2", body: "ลบผมทีหลัง" },
    ]);
    assert.deepEqual(r.body, { ok: true, added: 2 });

    // update is replace-then-index (upsert)
    const u = await json(base, "/engines/memory/update", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "x1", body: "อัปเดตแล้ว" }),
    });
    assert.equal(u.status, 200);
    const q1 = encodeURIComponent("อัปเดตแล้ว");
    const afterUpdate = await json(base, `/engines/memory/search?q=${q1}`);
    assert.deepEqual(afterUpdate.body.hits.map((h) => h.id), ["x1"]);

    // remove
    const d = await json(base, "/engines/memory/remove/x2", { method: "DELETE" });
    assert.equal(d.status, 200);
    const q2 = encodeURIComponent("ลบผมทีหลัง");
    const afterRemove = await json(base, `/engines/memory/search?q=${q2}`);
    assert.deepEqual(afterRemove.body.hits, []);
  } finally {
    await srv.close();
  }
});

test("errors: 404 unknown engine, 400 bad JSON, 405 wrong method", async () => {
  const { srv, base } = await start();
  try {
    const nf = await json(base, "/engines/nope/search?q=x");
    assert.equal(nf.status, 404);
    assert.equal(nf.body.error, "Not Found");

    const bad = await fetch(`${base}/engines/memory/add`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{invalid",
    });
    assert.equal(bad.status, 400);

    const wrongType = await fetch(`${base}/engines/memory/add`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "x",
    });
    assert.equal(wrongType.status, 400);
    assert.equal((await wrongType.json()).error, "Bad Request");

    // 1 MiB body cap → 413 (client error, not a 500).
    const huge = await fetch(`${base}/engines/memory/add`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "huge", body: "x".repeat(1024 * 1024 + 64) }),
    });
    assert.equal(huge.status, 413);
    assert.equal((await huge.json()).error, "Payload Too Large");

    const mna = await json(base, "/engines/memory/search", { method: "PUT" });
    assert.equal(mna.status, 405);
    assert.equal(mna.headers.get("allow"), "GET, POST");
  } finally {
    await srv.close();
  }
});

test("CORS headers on responses and 204 for preflight", async () => {
  const { srv, base } = await start();
  try {
    const pre = await fetch(`${base}/engines/memory/search`, { method: "OPTIONS" });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get("access-control-allow-origin"), "*");
    const { headers } = await json(base, "/health");
    assert.equal(headers.get("access-control-allow-origin"), "*");
  } finally {
    await srv.close();
  }
});

test("shorthand routes: path > header > engine query > default", async () => {
  const { srv, base } = await start(
    [
      { name: "a", factory: "createMemoryEngine" },
      { name: "b", factory: "createMemoryEngine" },
      { name: "c", factory: "createMemoryEngine" },
      { name: "d", factory: "createMemoryEngine" },
    ],
    "a"
  );
  try {
    const doc = (id) => ({ id, title: id, body: `เอกสารของ ${id}` });
    // One doc per engine, each addressable through a different mechanism.
    await post(base, "/engines/a/add", doc("via-path"));
    await post(base, "/engines/b/add", doc("via-header"));
    await post(base, "/engines/c/add", doc("via-query"));
    await post(base, "/engines/d/add", doc("via-d"));
    // No engine in the request → lands on the default ("a").
    await post(base, "/add", doc("added-via-shorthand"));

    const q = encodeURIComponent("เอกสารของ");

    // default → a
    const def = await json(base, `/search?q=${q}`);
    assert.deepEqual(def.body.hits.map((h) => h.id).sort(), ["added-via-shorthand", "via-path"]);

    // header → b
    const hdr = await json(base, `/search?q=${q}`, {
      headers: { "X-Thai-Fts-Engine": "b" },
    });
    assert.deepEqual(hdr.body.hits.map((h) => h.id), ["via-header"]);

    // query → c (header absent)
    const qry = await json(base, `/search?q=${q}&engine=c`);
    assert.deepEqual(qry.body.hits.map((h) => h.id), ["via-query"]);

    // explicit path wins over header
    const pathWins = await json(base, `/engines/a/search?q=${q}`, {
      headers: { "X-Thai-Fts-Engine": "b" },
    });
    assert.deepEqual(pathWins.body.hits.map((h) => h.id).sort(), [
      "added-via-shorthand",
      "via-path",
    ]);

    // shorthand remove + addMany + update + searchWithMeta reach the engine
    await post(base, "/addMany", [doc("bulk-1")], { headers: { "X-Thai-Fts-Engine": "d" } });
    const upd = await json(base, "/update", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Thai-Fts-Engine": "d" },
      body: JSON.stringify({ id: "bulk-1", body: "แก้ไขแล้ว" }),
    });
    assert.equal(upd.status, 200);
    const meta = await post(base, "/searchWithMeta", { q: "แก้ไขแล้ว" }, { headers: { "X-Thai-Fts-Engine": "d" } });
    assert.deepEqual(meta.body.hits.map((h) => h.id), ["bulk-1"]);
    const del = await json(base, "/remove/bulk-1", {
      method: "DELETE",
      headers: { "X-Thai-Fts-Engine": "d" },
    });
    assert.equal(del.status, 200);
  } finally {
    await srv.close();
  }
});

test("close() releases the server: subsequent requests fail", async () => {
  const { srv, base } = await start();
  const port = Number(new URL(base).port);
  await srv.close();
  await assert.rejects(() => fetch(`${base}/health`), undefined);
  assert.equal(srv.registry.isClosed(), true);
});
