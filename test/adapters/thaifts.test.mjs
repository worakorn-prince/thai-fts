// TASK-022: thaifts-server client adapter tests — boots a real HTTP server on
// an ephemeral port (same pattern as test/server/api.test.mjs) and drives it
// through createThaiFtsServerEngine from the public engine entry: add /
// addMany / update / remove round-trips with numeric-id preservation, search
// + searchWithMeta (incl. the truncation flag), per-engine targeting, error
// paths (unknown engine, closed engine), apiKey pass-through and prefix
// support (the memory engine hosted server-side honors it).
import { test } from "node:test";
import assert from "node:assert/strict";

const { createServer } = await import("../../dist/server/index.js");
const {
  createThaiFtsServerEngine,
} = await import("../../dist/engine/index.js");

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

const json = async (base, path) => {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json() };
};

const makeClient = (base, opts = {}) =>
  createThaiFtsServerEngine({ endpoint: base, ...opts });

test("add + search: hit round-trips and a numeric id stays numeric", async () => {
  const { srv, base } = await start([{ name: "mem", factory: "createMemoryEngine" }]);
  try {
    const engine = makeClient(base);
    await engine.add({ id: 42, title: "คู่มือติดตั้ง", body: "ขั้นตอนการติดตั้งโปรแกรม" });
    await engine.add(DOCS[1]);
    const hits = await engine.search("ติดตั้ง");
    assert.ok(hits.length >= 1);
    assert.equal(hits[0].id, 42); // numeric, not "42"
    assert.equal(typeof hits[0].id, "number");
    assert.equal(hits[0].rank, 1);
    assert.equal(hits[0].meta.channel, "strict");
    engine.close();
  } finally {
    await srv.close();
  }
});

test("addMany: full array and empty array both succeed", async () => {
  const { srv, base } = await start([{ name: "mem", factory: "createMemoryEngine" }]);
  try {
    const engine = makeClient(base);
    await engine.addMany(DOCS);
    assert.equal((await engine.search("ชำระ")).length, 1);
    // Empty batch is sent too — server answers { ok: true, added: 0 } with 201.
    await engine.addMany([]);
    assert.equal((await engine.search("ชำระ")).length, 1); // still there
    engine.close();
  } finally {
    await srv.close();
  }
});

test("update (upsert): new body is found, old body is gone", async () => {
  const { srv, base } = await start([{ name: "mem", factory: "createMemoryEngine" }]);
  try {
    const engine = makeClient(base);
    await engine.add({ id: "u1", title: "เดิม", body: "ขายของออนไลน์" });
    await engine.update({ id: "u1", title: "ใหม่", body: "ให้เช่าอพาร์ตเมนต์" });
    assert.equal((await engine.search("ให้เช่า")).length, 1);
    assert.equal((await engine.search("ขายของ")).length, 0);
    // update on an id never added before also lands (upsert).
    await engine.update({ id: "u2", title: "เพิ่ม", body: "จองตั๋วเครื่องบิน" });
    assert.equal((await engine.search("ตั๋วเครื่องบิน")).length, 1);
    engine.close();
  } finally {
    await srv.close();
  }
});

test("remove: document disappears and removing an absent id is a no-op", async () => {
  const { srv, base } = await start([{ name: "mem", factory: "createMemoryEngine" }]);
  try {
    const engine = makeClient(base);
    await engine.addMany(DOCS);
    // "ขั้นตอน" only matches g1 — "ติดตั้ง" would loose-match b1's "ติดตัง".
    assert.equal((await engine.search("ขั้นตอน")).length, 1);
    await engine.remove("g1");
    assert.equal((await engine.search("ขั้นตอน")).length, 0);
    // Removing something never added must not throw (200 no-op server-side).
    await engine.remove("never-added");
    engine.close();
  } finally {
    await srv.close();
  }
});

test("GET /search and the client's searchWithMeta return identical hits (strict first)", async () => {
  const { srv, base } = await start([{ name: "mem", factory: "createMemoryEngine" }]);
  try {
    const engine = makeClient(base);
    await engine.addMany(DOCS);
    const q = encodeURIComponent("ติดตั้ง");
    const { status, body } = await json(base, `/search?q=${q}`);
    assert.equal(status, 200);
    const clientHits = (await engine.searchWithMeta("ติดตั้ง")).hits;
    assert.deepEqual(
      clientHits.map((h) => `${h.id}:${h.meta.channel}`),
      body.hits.map((h) => `${h.id}:${h.meta.channel}`)
    );
    assert.deepEqual(clientHits.map((h) => h.meta.channel), ["strict", "loose"]);
    engine.close();
  } finally {
    await srv.close();
  }
});

test("searchWithMeta: truncated false normally, true past the chunk cap", async () => {
  const { srv, base } = await start([{ name: "mem", factory: "createMemoryEngine" }]);
  try {
    const engine = makeClient(base);
    await engine.add({ id: "t1", title: "ปกติ", body: "ค้นหาข้อมูล" });
    const normal = await engine.searchWithMeta("ค้นหา");
    assert.equal(normal.truncated, false);
    // 10 chunks > analyzer cap 8 → truncated: true even with zero hits.
    const capped = await engine.searchWithMeta("a b c d e f g h i j");
    assert.equal(capped.truncated, true);
    engine.close();
  } finally {
    await srv.close();
  }
});

test("engine option: two clients target two hosted engines with isolated data", async () => {
  const { srv, base } = await start([
    { name: "mem", factory: "createMemoryEngine" },
    { name: "mem2", factory: "createMemoryEngine" },
  ]);
  try {
    const a = makeClient(base, { engine: "mem" });
    const b = makeClient(base, { engine: "mem2" });
    // "รายการ" segments cleanly, unlike "เอกสารบี" (which mis-segments).
    await a.add({ id: "a1", title: "ฝั่งเอ", body: "รายการของฝั่งเอ" });
    await b.add({ id: "b1", title: "ฝั่งบี", body: "รายการของฝั่งบี" });
    assert.deepEqual((await a.search("รายการ")).map((h) => h.id), ["a1"]);
    assert.deepEqual((await b.search("รายการ")).map((h) => h.id), ["b1"]);
    a.close();
    b.close();
  } finally {
    await srv.close();
  }
});

test("unknown engine name: requests reject with HTTP 404", async () => {
  const { srv, base } = await start([{ name: "mem", factory: "createMemoryEngine" }]);
  try {
    const engine = makeClient(base, { engine: "nope" });
    await assert.rejects(() => engine.add({ id: "x", body: "ทดสอบ" }), /HTTP 404/);
    await assert.rejects(() => engine.search("ทดสอบ"), /HTTP 404/);
    engine.close();
  } finally {
    await srv.close();
  }
});

test("close seals the engine: later add/search throw 'Search engine is closed'", async () => {
  const { srv, base } = await start([{ name: "mem", factory: "createMemoryEngine" }]);
  try {
    const engine = makeClient(base);
    engine.close();
    // add() is async — a sealed engine must reject it, not throw synchronously.
    await assert.rejects(() => engine.add({ id: "x", body: "ทดสอบ" }), /Search engine is closed/);
    await assert.rejects(() => engine.search("ทดสอบ"), /Search engine is closed/);
    engine.close(); // idempotent
  } finally {
    await srv.close();
  }
});

test("apiKey option: sent as a Bearer header without breaking requests", async () => {
  const { srv, base } = await start([{ name: "mem", factory: "createMemoryEngine" }]);
  try {
    const engine = makeClient(base, { apiKey: "secret-key" });
    await engine.add({ id: "k1", title: "กุญแจ", body: "ตรวจสอบสิทธิ์" });
    assert.equal((await engine.search("ตรวจสอบ")).length, 1);
    engine.close();
  } finally {
    await srv.close();
  }
});

test("prefix option passes through to the hosted memory engine", async () => {
  const { srv, base } = await start([{ name: "mem", factory: "createMemoryEngine" }]);
  try {
    const engine = makeClient(base);
    await engine.add({ id: "p1", title: "โปรแกรม", body: "ติดตั้งโปรแกรมบนเครื่อง" });
    assert.equal((await engine.search("โปร", { prefix: true })).length, 1);
    assert.equal((await engine.search("โปร")).length, 0); // without prefix: no match
    engine.close();
  } finally {
    await srv.close();
  }
});
