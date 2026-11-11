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

/* ------------------------------------------------------------------ *
 * TASK-012: addMany() — one transaction per batch, all-or-nothing
 * ------------------------------------------------------------------ */

test("addMany indexes the same rows as repeated add, in the same order", () => {
  const docs = [
    { id: "a", title: "first", body: "alpha" },
    { id: "b", title: "", body: "beta" },
    { id: 7, title: "num", body: "gamma" },
  ];
  const bulk = openFts5Store({ memory: true });
  const oneByOne = openFts5Store({ memory: true });
  try {
    bulk.addMany(docs);
    for (const d of docs) oneByOne.add(d);
    assert.deepEqual(bulk.allRows(), oneByOne.allRows(), "bulk must be indistinguishable from add()");
  } finally {
    bulk.close();
    oneByOne.close();
  }
});

test("addMany rolls the whole batch back when a doc mid-way is rejected", () => {
  const store = openFts5Store({ memory: true });
  function* batch() {
    yield { id: "ok1", title: "", body: "alpha" };
    yield { id: "ok2", title: "", body: "beta" };
    yield { title: "", body: "this doc has no id" };
  }
  try {
    assert.throws(() => store.addMany(batch()), TypeError);
    assert.equal(store.allRows().length, 0, "the two valid docs must not survive a rolled-back batch");
  } finally {
    store.close();
  }
});

test("addMany leaves the previous row untouched when a replacement fails", () => {
  const store = openFts5Store({ memory: true });
  try {
    store.add({ id: "x", title: "", body: "version one" });
    function* batch() {
      yield { id: "y", title: "", body: "beta" };
      yield { id: "x", title: "", body: "version two" };
      yield { title: "", body: "boom" };
    }
    assert.throws(() => store.addMany(batch()), TypeError);
    assert.equal(store.get("x").body, "version one", "a half-applied replacement must not stick");
    assert.equal(store.allRows().length, 1, "the batch sibling doc must roll back too");
  } finally {
    store.close();
  }
});

test("addMany treats an empty batch as a no-op (no transaction opened)", () => {
  const store = openFts5Store({ memory: true });
  try {
    store.addMany([]);
    store.addMany((function* () {})());
    assert.equal(store.allRows().length, 0);
  } finally {
    store.close();
  }
});

test("addMany on a closed store throws the guarded error, like add()", () => {
  const store = openFts5Store({ memory: true });
  store.close();
  assert.throws(() => store.addMany([{ id: "a", body: "alpha" }]), /FTS5 store is closed/);
});

/* ------------------------------------------------------------------ *
 * TASK-013: a failing ROLLBACK must never mask the original error
 * ------------------------------------------------------------------ */

test("addMany: a throwing ROLLBACK still surfaces the ORIGINAL insert error", () => {
  const store = openFts5Store({ memory: true });
  const realExec = store.db.exec.bind(store.db);
  let rollbacks = 0;
  store.db.exec = (sql) => {
    if (String(sql).trim().toUpperCase() === "ROLLBACK") {
      rollbacks += 1;
      throw new Error("rollback exploded");
    }
    return realExec(sql);
  };
  function* batch() {
    yield { id: "ok", title: "", body: "alpha" };
    yield { title: "", body: "this doc has no id" };
  }
  let thrown;
  try {
    store.addMany(batch());
  } catch (e) {
    thrown = e;
  } finally {
    // Restore the real exec, then unwind the transaction the failed ROLLBACK
    // left open before closing the database.
    store.db.exec = realExec;
    try {
      realExec("ROLLBACK");
    } catch {
      /* already unwound */
    }
    store.close();
  }
  assert.ok(thrown, "the batch must fail");
  assert.equal(rollbacks, 1, "the batch failure must still attempt a ROLLBACK");
  assert.match(String(thrown.message), /requires a document with an id/);
  assert.doesNotMatch(
    String(thrown.message),
    /rollback exploded/,
    "the cleanup failure must never replace the original error"
  );
});
