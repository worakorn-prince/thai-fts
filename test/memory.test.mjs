// In-memory adapter (TASK-009): zero-dep `createMemoryEngine` registered as
// "memory" in the engine registry. Mirrors the fts5 reference semantics —
// strict-first dual channel with loose rescue below strict, dedupe by id,
// clampLimit, opt-in prefix/offsets/titleWeight/stopwords/stem, caller-owned
// filter hook, idempotent close, and "Search engine is closed" errors.
import { test } from "node:test";
import assert from "node:assert/strict";

const {
  createMemoryEngine,
  createEngine,
  listEngines,
} = await import("../dist/index.js");

const skip = typeof Intl.Segmenter !== "function";

test("registry: 'memory' is registered and creatable via createEngine", { skip }, () => {
  assert.ok(listEngines().includes("memory"), `expected memory in ${listEngines()}`);
  const eng = createEngine("memory", {});
  assert.equal(eng.type, "memory");
  eng.add({ id: "a", body: "ติดตั้งโปรแกรม" });
  assert.deepEqual(eng.search("ติดตั้ง", { tone: "strict" }).map((r) => r.id), ["a"]);
  eng.close();
});

test("tone strict: ติดตั้ง matches ONLY the correct-tone doc", { skip }, () => {
  const eng = createMemoryEngine();
  eng.add({ id: "a", body: "ต้องติดตั้งโปรแกรมใหม่" });
  eng.add({ id: "b", body: "ติดตังค่าบริการ" });
  assert.deepEqual(
    eng.search("ติดตั้ง", { tone: "strict" }).map((r) => r.id),
    ["a"],
    "strict channel must keep tone marks distinct"
  );
  eng.close();
});

test("tone both: loose rescue ranks below strict and dedupes by id", { skip }, () => {
  const eng = createMemoryEngine();
  // strict hit
  eng.add({ id: "s", body: "คู่มือติดตั้งโปรแกรม" });
  // loose-only hits (tone typo: same vowel skeleton, tone mark missing/moved)
  eng.add({ id: "l1", body: "ติดตังโปรแกรม" });
  eng.add({ id: "l2", body: "ติดตังใช้งานระบบ" });
  const res = eng.search("ติดตั้ง", { tone: "both" });
  const ids = res.map((r) => r.id);
  assert.deepEqual(ids, ["s", "l1", "l2"], "strict first, then loose in insertion order");
  assert.equal(ids.length, new Set(ids).size, "no duplicate ids");
  for (const r of res) {
    assert.ok(r.meta && "channel" in r.meta, "hits carry channel meta");
  }
  const sMeta = res.find((r) => r.id === "s")?.meta?.channel;
  const lMeta = res.find((r) => r.id === "l1")?.meta?.channel;
  assert.equal(sMeta, "strict");
  assert.equal(lMeta, "loose");
  eng.close();
});

test("loose rescue is skipped when strict fills the limit", { skip }, () => {
  const eng = createMemoryEngine();
  eng.add({ id: "s1", body: "ติดตั้งตัวที่หนึ่ง" });
  eng.add({ id: "s2", body: "ติดตั้งตัวที่สอง" });
  eng.add({ id: "l", body: "ติดตังตัวที่สาม" });
  const res = eng.search("ติดตั้ง", { tone: "both", limit: 2 });
  assert.deepEqual(res.map((r) => r.id), ["s1", "s2"], "limit saturated by strict → no loose");
  eng.close();
});

test("limit clamps: 0 → 1, default 10", { skip }, () => {
  const eng = createMemoryEngine();
  for (let i = 0; i < 12; i++) eng.add({ id: String(i), body: "alpha beta" });
  assert.equal(eng.search("alpha", { limit: 0 }).length, 1, "limit 0 clamps to 1");
  assert.equal(eng.search("alpha").length, 10, "default limit 10");
  assert.equal(eng.search("alpha", { limit: 5 }).length, 5);
  eng.close();
});

test("offsets + occurrences verify against the RAW text (Thai, 3× phrase)", { skip }, () => {
  const body = "ติดตั้งโปรแกรม ติดตั้งโปรแกรม ติดตั้งโปรแกรม";
  const eng = createMemoryEngine();
  eng.add({ id: "d", body });
  const [hit] = eng.search("ติดตั้งโปรแกรม", { tone: "strict", offsets: true });
  assert.equal(hit.id, "d");
  assert.ok(Array.isArray(hit.occurrences));
  assert.equal(hit.occurrences.length, 3);
  for (const o of hit.occurrences) {
    assert.equal(body.slice(o.start, o.end), o.quote, "every occurrence slice-verifies RAW");
  }
  assert.equal(hit.quote, hit.occurrences[0].quote);
  assert.equal(body.slice(hit.start, hit.end), hit.quote);
  eng.close();
});

test("offsets: single occurrence maps to the exact raw span", { skip }, () => {
  const body = "ผมต้องติดตั้งโปรแกรมใหม่";
  const eng = createMemoryEngine();
  eng.add({ id: "d", body });
  const [hit] = eng.search("ติดตั้งโปรแกรม", { tone: "strict", offsets: true });
  assert.ok(hit.quote !== undefined, "offsets verified");
  assert.equal(body.slice(hit.start, hit.end), hit.quote);
  eng.close();
});

test("prefix: partial final token matches only with prefix:true", { skip }, () => {
  const eng = createMemoryEngine();
  eng.add({ id: "a", body: "deploy the server" });
  eng.add({ id: "b", body: "remove the client" });
  assert.deepEqual(
    eng.search("depl", { tone: "strict", prefix: true }).map((r) => r.id),
    ["a"]
  );
  assert.deepEqual(
    eng.search("depl", { tone: "strict" }).map((r) => r.id),
    [],
    "exact mode must not match a partial token"
  );
  eng.close();
});

test("titleWeight: weighted title hit outranks body-only hit; default keeps order", { skip }, () => {
  const eng = createMemoryEngine();
  // body-only doc first (insertion order baseline)
  eng.add({ id: "b", title: "หัวข้ออื่น", body: "ติดตั้ง" });
  eng.add({ id: "t", title: "คู่มือติดตั้ง", body: "เนื้อหา" });
  const def = eng.search("ติดตั้ง", { tone: "strict" }).map((r) => r.id);
  assert.deepEqual(def, ["b", "t"], "unweighted: body hit (inserted first, equal score) first");
  const weighted = eng.search("ติดตั้ง", { tone: "strict", titleWeight: 2 }).map((r) => r.id);
  assert.deepEqual(weighted, ["t", "b"], "titleWeight 2 lifts the title-only hit to rank 1");
  eng.close();
});

test("stopwords: symmetric removal, stopword-only query returns [] without crashing", { skip }, () => {
  const eng = createMemoryEngine({ stopwords: true });
  eng.add({ id: "x", body: "การติดตั้งโปรแกรม" });
  assert.deepEqual(eng.search("การติดตั้ง", { tone: "strict" }).map((r) => r.id), ["x"]);
  assert.deepEqual(eng.search("การ และ ของ", { tone: "strict" }), [], "stopword-only query → []");
  eng.close();
});

test("stem: opt-in English stemming is symmetric in the memory engine", { skip }, () => {
  const eng = createMemoryEngine({ stem: true });
  eng.add({ id: "a", body: "running the installer" });
  assert.deepEqual(eng.search("run", { tone: "strict" }).map((r) => r.id), ["a"]);
  const off = createMemoryEngine();
  off.add({ id: "a", body: "running the installer" });
  assert.deepEqual(off.search("run", { tone: "strict" }), [], "default engine does not stem");
  eng.close();
  off.close();
});

test("update replaces content (no duplicate); remove empties; remove absent is a no-op", { skip }, () => {
  const eng = createMemoryEngine();
  eng.add({ id: "a", body: "ติดตั้งโปรแกรม" });
  assert.equal(eng.search("ติดตั้ง", { tone: "strict" }).length, 1);
  eng.add({ id: "a", body: "เซิร์ฟเวอร์ใหม่" });
  assert.equal(eng.search("ติดตั้ง", { tone: "strict" }).length, 0, "update replaced the doc");
  assert.deepEqual(eng.search("เซิร์ฟเวอร์", { tone: "strict" }).map((r) => r.id), ["a"]);
  eng.remove("a");
  assert.deepEqual(eng.search("เซิร์ฟเวอร์", { tone: "strict" }), []);
  assert.doesNotThrow(() => eng.remove("a"), "removing an absent id is a no-op");
  eng.close();
});

test("close is idempotent; operations after close throw clearly", { skip }, () => {
  const eng = createMemoryEngine();
  eng.add({ id: "a", body: "ติดตั้ง" });
  eng.close();
  assert.doesNotThrow(() => eng.close(), "second close is a no-op");
  assert.throws(() => eng.search("ติดตั้ง"), /Search engine is closed/);
  assert.throws(() => eng.add({ id: "b", body: "x" }), /Search engine is closed/);
  assert.throws(() => eng.remove("a"), /Search engine is closed/);
});

test("filter hook: applied per candidate BEFORE the limit (fts5 semantics)", { skip }, () => {
  const eng = createMemoryEngine();
  eng.add({ id: 1, body: "deploy alpha" });
  eng.add({ id: 2, body: "deploy beta" });
  eng.add({ id: 3, body: "deploy gamma" });
  const res = eng.search("deploy", {
    tone: "strict",
    limit: 2,
    filter: (row) => row.id !== 1,
  });
  const ids = res.map((r) => r.id);
  assert.ok(!ids.includes(1), "filtered-out row must not appear");
  assert.equal(ids.length, 2, `filter applied before limit: ${ids}`);
  eng.close();
});
