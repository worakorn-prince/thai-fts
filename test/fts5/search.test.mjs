// FTS5 dual-channel search: strict (mark-aware) + loose (de-accented) fallback.
// The core feature under test: ติดตั้ง ≠ ติดตัง on the strict channel, while a
// tone typo can still reach a correctly-marked document via the loose channel,
// always ranked BELOW strict and never when the limit is saturated.
import { test } from "node:test";
import assert from "node:assert/strict";

const { openFts5Store, fts5Search } = await import("../../dist/index.js");

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
