// FTS5 adapter, opt-in English Porter stemming: `stem: true` must stem ASCII
// tokens SYMMETRICALLY on the index and query sides, leave Thai tokens
// untouched, and stay OFF by default (default-off index is unaffected).
import { test } from "node:test";
import assert from "node:assert/strict";

const { openFts5Store, fts5Search } = await import("../../dist/index.js");

const skip = typeof Intl.Segmenter !== "function";

test("stem default OFF: 'run' does not match a doc containing only 'running'", { skip }, () => {
  const store = openFts5Store({ memory: true });
  store.add({ id: "a", body: "running the installer" });
  // Without stemming, tokens are compared exactly: run ≠ running (and 'run'
  // words are deliberately excluded from the synonym map, so no rescue).
  assert.deepEqual(
    fts5Search(store, "run", { tone: "strict" }).map((r) => r.id),
    [],
    "default store must not stem"
  );
  // …while the exact token still matches.
  assert.deepEqual(
    fts5Search(store, "running", { tone: "strict" }).map((r) => r.id),
    ["a"]
  );
  store.close();
});

test("stem ON: query 'run' matches doc 'running' (symmetric index+query)", { skip }, () => {
  const store = openFts5Store({ memory: true, stem: true });
  store.add({ id: "a", body: "running the installer" });
  assert.deepEqual(
    fts5Search(store, "run", { tone: "strict" }).map((r) => r.id),
    ["a"],
    "stemmed index + stemmed query must match"
  );
  // The exact token still matches (run→run on both sides).
  assert.deepEqual(
    fts5Search(store, "running", { tone: "strict" }).map((r) => r.id),
    ["a"]
  );
  store.close();
});

test("stem ON: 'install' matches 'installing' (index/query symmetric)", { skip }, () => {
  const store = openFts5Store({ memory: true, stem: true });
  store.add({ id: "i", body: "installing the package" });
  assert.deepEqual(
    fts5Search(store, "install", { tone: "strict" }).map((r) => r.id),
    ["i"]
  );
  store.close();
});

test("stem ON: Thai tokens are unaffected", { skip }, () => {
  const store = openFts5Store({ memory: true, stem: true });
  store.add({ id: "t", body: "ผมต้องติดตั้งโปรแกรมบนเซิร์ฟเวอร์" });
  assert.deepEqual(
    fts5Search(store, "ติดตั้งโปรแกรม", { tone: "strict" }).map((r) => r.id),
    ["t"],
    "Thai phrase must still match under stem:true"
  );
  // Mixed doc: the Thai word and the English word both behave.
  const store2 = openFts5Store({ memory: true, stem: true });
  store2.add({ id: "m", body: "ติดตั้ง deploy system" });
  assert.ok(
    fts5Search(store2, "ติดตั้ง", { tone: "strict" }).some((r) => r.id === "m"),
    "Thai part unaffected"
  );
  assert.ok(
    fts5Search(store2, "deploying", { tone: "strict" }).some((r) => r.id === "m"),
    "English part stemmed (deploying → deploy)"
  );
  store2.close();
});
