// FTS5 dual-channel search: strict (mark-aware) + loose (de-accented) fallback.
// The core feature under test: ติดตั้ง ≠ ติดตัง on the strict channel, while a
// tone typo can still reach a correctly-marked document via the loose channel,
// always ranked BELOW strict and never when the limit is saturated.
import { test } from "node:test";
import assert from "node:assert/strict";

const { openFts5Store, fts5Search, createFts5Engine } = await import("../../dist/index.js");

// ICU segmentation is optional (small-icu runtimes); Thai assertions skip then.
const skip = typeof Intl.Segmenter !== "function";

function storeWith(...docs) {
  const store = openFts5Store({ memory: true });
  for (const d of docs) store.add(d);
  return store;
}

test("unspaced Thai is found through FTS5", { skip }, () => {
  const store = storeWith(
    { id: 1, body: "ผมต้องติดตั้งโปรแกรมบนเซิร์ฟเวอร์ใหม่" },
    { id: 2, body: "ร้านนี้ข้าวผัดอร่อยมาก" }
  );
  const ids = fts5Search(store, "ติดตั้งโปรแกรม", { tone: "both" }).map((r) => r.id);
  assert.ok(ids.includes(1), `expected doc 1 in ${ids}`);
  assert.ok(!ids.includes(2), `expected doc 2 absent from ${ids}`);
  store.close();
});

test("strict channel: ติดตั้ง matches ONLY the ติดตั้ง doc; ติดตัง ONLY the ติดตัง doc", { skip }, () => {
  const store = storeWith(
    { id: 1, body: "ผมต้องติดตั้งโปรแกรมบนเซิร์ฟเวอร์ใหม่" },
    { id: 2, body: "ติดตังค่าบริการรายเดือน" }
  );
  // Strict channel isolates the mark-aware index: no cross-talk.
  assert.deepEqual(
    fts5Search(store, "ติดตั้ง", { tone: "strict" }).map((r) => r.id),
    [1],
    "ติดตั้ง must match only the ติดตั้ง doc"
  );
  assert.deepEqual(
    fts5Search(store, "ติดตัง", { tone: "strict" }).map((r) => r.id),
    [2],
    "ติดตัง must match only the ติดตัง doc"
  );
  store.close();
});

test("ranking: correct-tone document outranks skeleton-only text", { skip }, () => {
  const store = storeWith(
    { id: 1, body: "ติดตังค่าบริการรายเดือน" },
    { id: 2, body: "ต้องติดตั้งโปรแกรมใหม่บนเซิร์ฟเวอร์" },
    { id: 3, body: "ติดตัง" }
  );
  const res = fts5Search(store, "ติดตั้ง", { tone: "strict" });
  assert.equal(res[0].id, 2, `expected the correct-tone doc first: ${JSON.stringify(res)}`);
  assert.ok(
    !res.some((r) => r.id === 1 || r.id === 3),
    `skeleton-only docs must not match: ${JSON.stringify(res)}`
  );
  store.close();
});

test("loose channel rescues a tone typo BELOW strict, deduping by id", { skip }, () => {
  const store = storeWith(
    { id: 1, body: "ผมต้องติดตั้งโปรแกรมบนเซิร์ฟเวอร์ใหม่" },
    { id: 2, body: "ติดตังค่าบริการรายเดือน" }
  );
  // Query the TYPO. Strict returns only the ติดตัง doc; loose (de-accented)
  // also surfaces the correctly-marked ติดตั้ง doc, appended below.
  const res = fts5Search(store, "ติดตัง", { tone: "both", limit: 10 });
  const ids = res.map((r) => r.id);
  assert.deepEqual(ids, [2, 1], `typo query should yield [ติดตัง, ติดตั้ง]: ${ids}`);
  assert.ok(
    res.find((r) => r.id === 1)?.meta?.channel === "loose",
    "the rescued doc must come from the loose channel"
  );
  assert.equal(
    res.find((r) => r.id)?.meta?.method,
    "fts5",
    "FTS path reports method fts5"
  );
  store.close();
});

test("no duplicate ids when a doc matches both channels (dedupe)", { skip }, () => {
  const store = storeWith(
    { id: 1, body: "ติดตั้งโปรแกรมบนเซิร์ฟเวอร์" },
    { id: 2, body: "ติดตังค่าบริการ" }
  );
  const res = fts5Search(store, "ติดตั้ง", { tone: "both", limit: 10 });
  const ids = res.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, `duplicates must be deduped: ${ids}`);
  assert.equal(ids.filter((id) => id === 1).length, 1, "doc 1 appears exactly once");
  store.close();
});

test("loose rescue is skipped when the limit is saturated by strict hits", { skip }, () => {
  const store = storeWith(
    { id: 1, body: "ผมต้องติดตั้งโปรแกรมบนเซิร์ฟเวอร์ใหม่" },
    { id: 2, body: "ติดตังค่าบริการรายเดือน" }
  );
  // limit=1: strict fills the window, the ติดตั้ง doc must NOT be appended.
  const res = fts5Search(store, "ติดตัง", { tone: "both", limit: 1 });
  assert.deepEqual(
    res.map((r) => r.id),
    [2],
    `only the strict hit with limit=1: ${JSON.stringify(res)}`
  );
  store.close();
});

test("limit is clamped: default 10, floor 1, ceiling 200", () => {
  const docs = Array.from({ length: 50 }, (_, i) => ({
    id: `d${i}`,
    body: `deploy release v${i}`,
  }));
  const store = openFts5Store({ memory: true });
  for (const d of docs) store.add(d);

  const big = fts5Search(store, "deploy", { limit: 100000 });
  assert.ok(big.length <= 200, `ceiling clamp to 200: ${big.length}`);

  const zero = fts5Search(store, "deploy", { limit: 0 });
  assert.ok(zero.length <= 1, `floor clamp to 1: ${zero.length}`);

  const negative = fts5Search(store, "deploy", { limit: -5 });
  assert.ok(negative.length <= 1, `negative clamp to 1: ${negative.length}`);

  const none = fts5Search(store, "deploy");
  assert.ok(none.length <= 10 && none.length > 0, `default limit 10: ${none.length}`);
  store.close();
});

test("like_fallback for 1-2 char pure-Thai queries (never silent)", { skip }, () => {
  const store = storeWith(
    { id: "a", body: "ติดตั้งโปรแกรม" },
    { id: "b", body: "ดีมากครับ" }
  );
  const two = fts5Search(store, "ติด", { tone: "both" });
  assert.deepEqual(two.map((r) => r.id), ["a"], `LIKE should find ติด: ${JSON.stringify(two)}`);
  assert.ok(
    two.every((r) => r.meta?.method === "like_fallback"),
    "short Thai queries must report like_fallback"
  );

  const one = fts5Search(store, "ดี", { tone: "both" });
  assert.deepEqual(one.map((r) => r.id), ["b"], `single char ดี via LIKE: ${JSON.stringify(one)}`);
  assert.equal(one[0]?.meta?.method, "like_fallback");

  // No match is fine as long as it does not throw and stays a like fallback.
  const none = fts5Search(store, "ลา", { tone: "both" });
  assert.deepEqual(none, []);
  store.close();
});

test("like_fallback read is bounded by a SQL LIMIT (and respects limit)", { skip }, () => {
  // 50 docs match the 2-char Thai query "ตา" (2 Thai chars → LIKE fallback).
  // The scan must cap its read just above `limit` and hand back exactly
  // `limit` rows, not the whole matching set.
  const docs = Array.from({ length: 50 }, (_, i) => ({
    id: `d${i}`,
    body: `ตารางที่ ${i} ค่าบริการ`,
  }));
  const store = openFts5Store({ memory: true });
  for (const d of docs) store.add(d);

  // Spy on the LIKE scan to record its SQL and the bound it binds.
  const likeScans = [];
  const origPrepare = store.db.prepare.bind(store.db);
  store.db.prepare = (sql) => {
    const stmt = origPrepare(sql);
    if (sql.includes("ESCAPE")) {
      const origAll = stmt.all.bind(stmt);
      stmt.all = (...args) => {
        likeScans.push({ sql, args });
        return origAll(...args);
      };
    }
    return stmt;
  };

  const res = fts5Search(store, "ตา", { tone: "both", limit: 5 });
  assert.equal(res.length, 5, `limit 5 must return exactly 5 of 50 matches: ${res.length}`);
  assert.ok(res.every((r) => r.meta?.method === "like_fallback"));
  assert.ok(likeScans.length > 0, "the LIKE scan must run");
  assert.ok(
    likeScans.every((s) => /LIMIT \?/i.test(s.sql)),
    "the LIKE scan must carry a SQL LIMIT"
  );
  assert.ok(
    likeScans.every((s) => s.args[s.args.length - 1] === 5 * 2 + 16),
    `like scan must bind limit*2+16 (26), got: ${JSON.stringify(likeScans.map((s) => s.args))}`
  );
  store.close();

  // Fewer matches than limit: return as many as are available (all of them).
  const few = openFts5Store({ memory: true });
  for (const d of docs.slice(0, 3)) few.add(d);
  const resFew = fts5Search(few, "ตา", { tone: "both", limit: 10 });
  assert.deepEqual(
    resFew.map((r) => r.id),
    ["d0", "d1", "d2"],
    `fewer matches than limit should return all of them: ${JSON.stringify(resFew.map((r) => r.id))}`
  );
  few.close();
});

test("adversarial MATCH inputs never throw", () => {
  const store = storeWith(
    { id: 1, body: "deploy release v1" },
    { id: 2, body: "แมวกินปลาในห้องครัว" }
  );
  const nasty = [
    "",
    "   ",
    '"',
    "*",
    "*:*",
    "-",
    "(",
    ")",
    "\\",
    "''",
    'a"b',
    "a\\b",
    "NEAR",
    "NEAR/1",
    "deploy NEAR/1 release",
    '"deploy" OR "release"',
    "drop table;--",
    "OR",
    "AND",
    "NOT",
    "ติดตั้ง",
  ];
  for (const q of nasty) {
    assert.doesNotThrow(
      () => fts5Search(store, q, { limit: 5 }),
      `query must not throw: ${JSON.stringify(q)}`
    );
  }
  store.close();
});

test("optional filter hook applies per candidate and does not starve in-scope hits", () => {
  const store = storeWith(
    { id: 1, body: "deploy alpha", meta: "ok" },
    { id: 2, body: "deploy beta" },
    { id: 3, body: "deploy gamma" }
  );
  const res = fts5Search(store, "deploy", {
    limit: 2,
    filter: (row) => row.id !== 1,
  });
  const ids = res.map((r) => r.id);
  assert.ok(!ids.includes(1), "filtered-out row must not appear");
  assert.equal(ids.length, 2, `filter applied before limit: ${ids}`);
  store.close();
});

// TASK-006 opt-in search features (all default off): prefix autocomplete, raw
// offsets, titleWeight ranking, and symmetric index+query stopwords.
test("prefix: partial word with prefix:true isolates the ติดตั้ง-only doc", { skip }, () => {
  const store = openFts5Store({ memory: true, prefix: [2, 3] });
  store.add({ id: "a", body: "ต้องติดตั้งโปรแกรมใหม่" });
  store.add({ id: "b", body: "ติดตังค่าบริการ" });
  // 3+ Thai chars run the FTS prefix path: the phrase's final token gets a
  // trailing `*`, so the prefix "ติดตั้งโ" matches ติดตั้งแต่ไม่ใช่ติดตัง.
  assert.deepEqual(
    fts5Search(store, "ติดตั้งโ", { tone: "strict", prefix: true }).map((r) => r.id),
    ["a"],
    "prefix search must find only the ติดตั้ง doc"
  );
  store.close();
});

test("prefix: without prefix:true a partial word matches nothing (exact phrase)", { skip }, () => {
  const store = openFts5Store({ memory: true, prefix: [2, 3] });
  store.add({ id: "a", body: "ต้องติดตั้งโปรแกรมใหม่" });
  store.add({ id: "b", body: "ติดตังค่าบริการ" });
  // No `*`: the phrase's final token must be an EXACT token. No document holds a
  // standalone "โ" token, so the partial word must not match in exact mode.
  assert.deepEqual(
    fts5Search(store, "ติดตั้งโ", { tone: "strict" }),
    [],
    "exact (no-prefix) mode must not match a partial word"
  );
  store.close();
});

test("prefix: a shared short prefix matches both docs (LIKE width)", { skip }, () => {
  const store = openFts5Store({ memory: true, prefix: [2, 3] });
  store.add({ id: "a", body: "ต้องติดตั้งโปรแกรมใหม่" });
  store.add({ id: "b", body: "ติดตังค่าบริการ" });
  // "ติ" is a 1-char Thai query → the LIKE fallback runs; both docs contain
  // "ติ" so both match. Assert length 2 only — never pin the rowid order.
  const res = fts5Search(store, "ติ", { tone: "strict", prefix: true });
  assert.equal(res.length, 2, `short prefix should match both docs: ${JSON.stringify(res)}`);
  assert.ok(
    res.some((r) => r.id === "a") && res.some((r) => r.id === "b"),
    "both docs start with ติ"
  );
  store.close();
});

test("offsets: raw quote/start/end validated against the source text", { skip }, () => {
  const body = "คู่มือติดตั้งโปรแกรม และติดตั้งใหม่";
  const store = openFts5Store({ memory: true });
  store.add({ id: "d", body });
  const [hit] = fts5Search(store, "ติดตั้ง", { tone: "strict", offsets: true });
  assert.equal(hit.id, "d");
  assert.equal(hit.quote, "ติดตั้ง");
  assert.equal(typeof hit.start, "number", "start must be a raw coordinate number");
  assert.equal(typeof hit.end, "number", "end must be a raw coordinate number");
  assert.ok(hit.start < hit.end, `valid span ${hit.start}..${hit.end}`);
  // RAW coordinate invariant: re-slicing the raw body reproduces the quote
  // (no inserted segmentation spaces).
  assert.equal(body.slice(hit.start, hit.end), hit.quote);
  store.close();
});

test("titleWeight: default ranks the body-only hit first; weight 2 flips to the title hit", { skip }, () => {
  const store = storeWith(
    { id: "t", title: "ติดตั้งยืนยันขั้นตอนการทำงานอย่างละเอียด", body: "เนื้อหายาวมาก" },
    { id: "b", title: "บทความอื่น", body: "ติดตั้ง" }
  );
  const def = fts5Search(store, "ติดตั้ง", { tone: "strict" }).map((r) => r.id);
  assert.deepEqual(def, ["b", "t"], "without weighting the body-only hit ranks 1");
  const weighted = fts5Search(store, "ติดตั้ง", {
    tone: "strict",
    titleWeight: 2,
  }).map((r) => r.id);
  assert.deepEqual(weighted, ["t", "b"], "titleWeight must lift the title hit to rank 1");
  store.close();
});

test("stopwords: symmetric index+query removal matches through the engine", { skip }, () => {
  const on = createFts5Engine({ memory: true, stopwords: true });
  on.add({ id: "s", body: "การติดตั้งโปรแกรม" });
  assert.deepEqual(
    on.search("การติดตั้ง", { tone: "strict" }).map((r) => r.id),
    ["s"],
    "the query-side filter drops การ exactly like the index did"
  );
  assert.deepEqual(
    on.search("ติดตั้ง", { tone: "strict" }).map((r) => r.id),
    ["s"],
    "the plain-word query still matches after การ was removed at index time"
  );
  on.close();
});

test("stopwords: default (off) stays symmetric — neither side drops การ", { skip }, () => {
  const off = createFts5Engine({ memory: true });
  off.add({ id: "s", body: "การติดตั้งโปรแกรม" });
  // Stopwords are opt-in. With the feature off, neither the index nor the query
  // removes การ, so the phrase still matches (symmetric-keep on both sides).
  assert.deepEqual(
    off.search("การติดตั้ง", { tone: "strict" }).map((r) => r.id),
    ["s"],
    "off path keeps tokens on both sides, so the phrase matches"
  );
  off.close();
});
