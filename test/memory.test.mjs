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

/* ------------------------------------------------------------------ *
 * TASK-012: AND-mode, truncation visibility, addMany() rollback
 * ------------------------------------------------------------------ */

test("allTerms: the memory adapter ANDs exactly like the fts5 reference", { skip }, () => {
  const eng = createMemoryEngine({});
  eng.add({ id: 1, body: "alpha" });
  eng.add({ id: 2, body: "beta" });
  eng.add({ id: 3, body: "alpha beta" });
  try {
    // Default OR keeps every partial match; "alpha beta" scores highest, so the
    // comparison is made on the id SET rather than the ranking.
    const orIds = eng.search("alpha beta", { tone: "strict" }).map((r) => r.id).sort();
    assert.deepEqual(orIds, [1, 2, 3], "OR must surface every doc with either chunk");
    assert.deepEqual(
      eng.search("alpha beta", { tone: "strict", allTerms: true }).map((r) => r.id),
      [3],
      "AND must keep only docs carrying BOTH chunks"
    );
    assert.deepEqual(
      eng.search("alpha", { tone: "strict", allTerms: true }).map((r) => r.id).sort(),
      eng.search("alpha", { tone: "strict" }).map((r) => r.id).sort(),
      "one chunk has nothing to AND — the flag must change nothing"
    );
  } finally {
    eng.close();
  }
});

test("meta.truncated: memory reports the cap exactly where fts5 does", { skip }, () => {
  const eng = createMemoryEngine({});
  const words = Array.from({ length: 9 }, (_, i) => `chunkword${i}`);
  eng.add({ id: 1, body: words.join(" ") });
  eng.add({ id: 2, body: "chunkword0" });
  try {
    const long = eng.search(words.join(" "), { tone: "strict" });
    assert.ok(long.length > 0, "a capped query must still return hits");
    assert.equal(long[0].meta.truncated, true, "the dropped chunk must be visible, not silent");
    const short = eng.search("chunkword0 chunkword1", { tone: "strict" });
    assert.ok(short.length > 0);
    assert.equal("truncated" in short[0].meta, false, "an uncapped hit keeps its original shape");
  } finally {
    eng.close();
  }
});

test("addMany: a batch that fails mid-iteration leaves the index (and its tie-break order) alone", () => {
  const eng = createMemoryEngine({});
  for (const id of ["a", "b", "c"]) eng.add({ id, body: "alpha" });
  const order = () => eng.search("alpha", { tone: "strict" }).map((r) => r.id);
  assert.deepEqual(order(), ["a", "b", "c"], "equal scores fall back to insertion order");
  function* batch() {
    yield { id: "d", body: "alpha" };
    throw new Error("generator exploded");
  }
  assert.throws(() => eng.addMany(batch()), /generator exploded/);
  assert.deepEqual(order(), ["a", "b", "c"], "a half-applied batch must restore the exact prior order");
  eng.add({ id: "e", body: "alpha" });
  assert.deepEqual(order(), ["a", "b", "c", "e"], "the restored map must keep appending normally");
  eng.close();
});

test("addMany: a mid-batch insert failure rolls the inserted docs back", () => {
  const eng = createMemoryEngine({});
  for (const id of ["a", "b"]) eng.add({ id, body: "alpha" });
  const order = () => eng.search("alpha", { tone: "strict" }).map((r) => r.id);
  assert.deepEqual(order(), ["a", "b"], "equal scores fall back to insertion order");
  // The getter throws only when insert() reads `body` — after the batch has
  // been materialized and passed the id validation, so docs "c" and "d" are
  // already written and the catch-block rollback must undo them.
  const bad = {
    id: "x",
    get body() {
      throw new Error("body exploded");
    },
  };
  assert.throws(
    () => eng.addMany([{ id: "c", body: "alpha" }, { id: "d", body: "alpha" }, bad]),
    /body exploded/
  );
  assert.deepEqual(order(), ["a", "b"], "the half-applied batch must be restored exactly");
  assert.equal(eng.search("alpha", { tone: "strict" }).length, 2, "the new docs must be absent");
  eng.add({ id: "e", body: "alpha" });
  assert.deepEqual(order(), ["a", "b", "e"], "the restored map must keep appending normally");
  eng.close();
});

test("addMany rejects an id-less doc before touching the index", () => {
  const eng = createMemoryEngine({});
  eng.add({ id: "a", body: "alpha" });
  eng.add({ id: "b", body: "beta" });
  assert.throws(
    () => eng.addMany([{ id: "c", body: "gamma" }, { body: "no id at all" }]),
    TypeError
  );
  assert.deepEqual(eng.search("alpha", { tone: "strict" }).map((r) => r.id), ["a"]);
  assert.equal(eng.search("gamma", { tone: "strict" }).length, 0, "the batch must not have applied");
  eng.close();
});

test("addMany keeps the live payload when a replacement batch fails", () => {
  const eng = createMemoryEngine({});
  eng.add({ id: "v", body: "version one" });
  assert.throws(
    () =>
      eng.addMany([
        { id: "w", body: "alpha" },
        { id: "v", body: "version two" },
        { body: "bad doc" },
      ]),
    TypeError
  );
  assert.deepEqual(eng.search("version", { tone: "strict" }).map((r) => r.id), ["v"]);
  assert.equal(eng.search("two", { tone: "strict" }).length, 0, "the new payload must stay invisible");
  eng.close();
});

test("addMany on a closed memory engine throws the guarded error", () => {
  const eng = createMemoryEngine({});
  eng.close();
  assert.throws(() => eng.addMany([{ id: "a", body: "alpha" }]), /Search engine is closed/);
});

/* ------------------------------------------------------------------ *
 * TASK-013: searchWithMeta + replace-then-fail rollback + defaults
 * ------------------------------------------------------------------ */

test("searchWithMeta: a truncated 9-chunk query with no matches reports truncated", () => {
  const eng = createMemoryEngine({});
  try {
    eng.add({ id: "a", body: "alpha" });
    const words = Array.from({ length: 9 }, (_, i) => `absentword${i}`);
    const out = eng.searchWithMeta(words.join(" "), { tone: "strict" });
    assert.deepEqual(out.hits, [], "nothing matches");
    assert.equal(out.truncated, true, "0 hits from a capped query is NOT a complete result");

    const eight = Array.from({ length: 8 }, (_, i) => `absentword${i}`);
    const whole = eng.searchWithMeta(eight.join(" "), { tone: "strict" });
    assert.deepEqual(whole.hits, []);
    assert.equal(whole.truncated, false, "the whole query was analyzed");
  } finally {
    eng.close();
  }
});

test("addMany: a replace-then-fail batch restores the ORIGINAL payload AND its position", () => {
  const eng = createMemoryEngine({});
  try {
    for (const id of ["a", "b", "c"]) eng.add({ id, body: "alpha" });
    const order = () => eng.search("alpha", { tone: "strict", limit: 10 }).map((r) => r.id);
    assert.deepEqual(order(), ["a", "b", "c"], "equal scores fall back to insertion order");

    // The getter throws only when insert() reads `body`, i.e. AFTER "a" has
    // already been replaced, so the rollback must undo a real half-applied
    // mutation — content AND map position (a move to the end would change the
    // ranking tie-break).
    const bad = {
      id: "x",
      get body() {
        throw new Error("body exploded");
      },
    };
    assert.throws(
      () => eng.addMany([{ id: "a", body: "replacement payload" }, bad]),
      /body exploded/
    );

    assert.deepEqual(order(), ["a", "b", "c"], "the replacement must restore its original slot");
    assert.equal(
      eng.search("replacement", { tone: "strict" }).length,
      0,
      "the replacement payload must stay invisible"
    );
    eng.add({ id: "d", body: "alpha" });
    assert.deepEqual(order(), ["a", "b", "c", "d"], "the restored map keeps appending normally");
  } finally {
    eng.close();
  }
});

test("createMemoryEngine: a default allTerms survives an explicit undefined override", () => {
  const eng = createMemoryEngine({ allTerms: true });
  try {
    eng.add({ id: 1, body: "alpha" });
    eng.add({ id: 2, body: "beta" });
    eng.add({ id: 3, body: "alpha beta" });
    assert.deepEqual(
      eng.search("alpha beta", { tone: "strict" }).map((r) => r.id),
      [3],
      "the engine default must AND the chunks"
    );
    assert.deepEqual(
      eng.search("alpha beta", { tone: "strict", allTerms: undefined }).map((r) => r.id),
      [3],
      "{ allTerms: undefined } must NOT clobber the engine default"
    );
    assert.deepEqual(
      eng.search("alpha beta", { tone: "strict", allTerms: false }).map((r) => r.id).sort(),
      [1, 2, 3],
      "an explicit false still overrides the default"
    );
  } finally {
    eng.close();
  }
});
