// FTS5 store lifecycle: file persistence, WAL mode, replace/update/rebuild,
// and guarded closed-store access (regression for BUG-3: get()/allRows() used
// to throw a confusing "statement has been finalized" instead of "FTS5 store
// is closed").
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

const { openFts5Store } = await import("../../dist/index.js");

const skip = typeof Intl.Segmenter !== "function";

function tempDbPath(tag) {
  const p = join(tmpdir(), `thai-fts-store-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  return p;
}

test("file DB: add, close, reopen persists rows (WAL mode)", () => {
  const p = tempDbPath("persist");
  const cleanup = () => rmSync(p, { force: true });
  try {
    let store = openFts5Store({ path: p });
    assert.equal(store.db.prepare("PRAGMA journal_mode").get().journal_mode.toLowerCase(), "wal");
    store.add({ id: "a", body: "ผมต้องติดตั้งโปรแกรม" });
    store.add({ id: "b", body: "ติดตังค่าบริการ" });
    assert.equal(store.allRows().length, 2);
    store.close();

    store = openFts5Store({ path: p });
    assert.equal(store.allRows().length, 2, "rows must survive reopen");
    assert.equal(store.get("a")?.id, "a");
    assert.ok((store.get("a")?.body ?? "").includes("ติดตั้ง"), "raw body persisted");
    store.close();
  } finally {
    for (const s of ["", "-wal", "-shm"]) rmSync(`${p}${s}`, { force: true });
  }
});

test("close is idempotent (twice)", () => {
  const store = openFts5Store({ memory: true });
  store.add({ id: "a", body: "โปรแกรม" });
  store.close();
  assert.doesNotThrow(() => store.close(), "second close must be a no-op");
});

test("BUG-3: get/allRows/add after close throw a clear 'store is closed' error", () => {
  const store = openFts5Store({ memory: true });
  store.add({ id: "a", body: "โปรแกรม" });
  store.close();
  for (const op of [
    () => store.get("a"),
    () => store.allRows(),
    () => store.add({ id: "b", body: "x" }),
    () => store.remove("a"),
    () => store.rebuild(),
  ]) {
    assert.throws(op, /FTS5 store is closed/, "closed store operations must throw clearly");
  }
});

test("replace same id updates payload; rebuild dedupes", { skip }, () => {
  const store = openFts5Store({ memory: true });
  store.add({ id: "a", title: "", body: "ติดตั้งโปรแกรม" });
  store.update({ id: "a", title: "", body: "ติดตั้งเวอร์ชันใหม่" });
  assert.equal(store.allRows().length, 1, "update must not duplicate");
  // rebuild with the same two docs keeps exactly those rows
  store.rebuild([
    { id: "a", title: "", body: "ติดตั้งเวอร์ชันใหม่" },
    { id: "b", title: "", body: "ติดตังค่าบริการ" },
  ]);
  assert.equal(store.allRows().length, 2);
  store.close();
});
