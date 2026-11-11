// TASK-020: bounded SQLite page cache for file-backed stores. The cache is a
// per-connection, lazily allocated resource: it must be capped for files,
// ignored for memory DBs, reject impossible values, stay OUT of the TASK-016
// config fingerprint, and never change search results.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

const { openFts5Store, createFts5Engine, fts5Search } = await import(
  "../../dist/index.js"
);

function tempDbPath(tag) {
  return join(
    tmpdir(),
    `thai-fts-cache-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

function cleanup(p) {
  for (const s of ["", "-wal", "-shm"]) rmSync(`${p}${s}`, { force: true });
}

// PRAGMA cache_size is negative when expressed in KiB (SQLite's convention).
function cacheSize(store) {
  const row = store.db.prepare("PRAGMA cache_size").get();
  return Number(Object.values(row)[0]);
}

const CORPUS = [
  { id: 1, title: "install guide", body: "ติดตั้งโปรแกรมบนเซิร์ฟเวอร์ใหม่" },
  { id: 2, title: "ติดตังค่าบริการ", body: "ติดตังค่าบริการรายเดือน" },
  { id: 3, title: "server setup", body: "configure the server and install the program" },
  { id: 4, title: "ข้าวผัด", body: "ร้านนี้ข้าวผัดอร่อยมาก" },
];

const QUERIES = [
  ["install", "strict"],
  ["install", "loose"],
  ["install", "both"],
  ["server", "both"],
  ["ติดตั้ง", "both"],
  ["ติดตั้ง", "loose"],
  ["ข้าวผัด", "both"],
];

function buildFile(tag, cacheSizeKib) {
  const p = tempDbPath(tag);
  const store = openFts5Store({ path: p, cacheSizeKib });
  store.addMany(CORPUS);
  return { p, store, cacheSizeKib };
}

// 1. File store default: 64 MiB cap.
test("file store defaults to a -65536 (64 MiB) page cache", () => {
  const p = tempDbPath("default");
  try {
    const store = openFts5Store({ path: p });
    assert.equal(cacheSize(store), -65536);
    store.close();
  } finally {
    cleanup(p);
  }
});

// 2. Explicit override is applied in KiB.
test("file store honors an explicit cacheSizeKib", () => {
  const p = tempDbPath("override");
  try {
    const store = openFts5Store({ path: p, cacheSizeKib: 32768 });
    assert.equal(cacheSize(store), -32768);
    store.close();
  } finally {
    cleanup(p);
  }
});

// 3. 0 means "leave SQLite's default alone".
test("cacheSizeKib: 0 keeps SQLite's default cache size", () => {
  const p = tempDbPath("zero");
  try {
    const store = openFts5Store({ path: p, cacheSizeKib: 0 });
    const observed = cacheSize(store);
    assert.notEqual(observed, -65536);
    assert.ok(observed < 0, `expected the SQLite default (KiB), got ${observed}`);
    store.close();
  } finally {
    cleanup(p);
  }
});

// 4. Memory stores never take the file-store cap (nor an explicit override).
test("memory stores are unaffected by cacheSizeKib", () => {
  const plain = openFts5Store({ memory: true });
  assert.notEqual(cacheSize(plain), -65536);
  plain.close();

  const explicit = openFts5Store({ memory: true, cacheSizeKib: 32768 });
  assert.notEqual(cacheSize(explicit), -32768);
  assert.notEqual(cacheSize(explicit), -65536);
  explicit.close();
});

// 5. Impossible values fail fast, before any database is opened.
test("non-integer or negative cacheSizeKib throws TypeError", () => {
  const p = tempDbPath("invalid");
  try {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => openFts5Store({ path: p, cacheSizeKib: bad }),
        (err) => {
          assert.ok(err instanceof TypeError, `expected TypeError for ${bad}`);
          assert.match(err.message, /cacheSizeKib/);
          return true;
        },
      );
    }
    // Nothing was opened, so the path stays free for a valid open.
    const store = openFts5Store({ path: p });
    assert.equal(cacheSize(store), -65536);
    store.close();
  } finally {
    cleanup(p);
  }
});

// 6. Cache sizing is a pure resource knob: identical hits for every setting.
test("search results are identical across cache settings", () => {
  const variants = [
    buildFile("identical-default", undefined),
    buildFile("identical-zero", 0),
    buildFile("identical-16mib", 16384),
  ];
  try {
    for (const [query, tone] of QUERIES) {
      const results = variants.map(({ store }) =>
        JSON.stringify(fts5Search(store, query, { tone }).map((r) => r.id)),
      );
      assert.equal(results[1], results[0], `cache=0 drifted for "${query}" (${tone})`);
      assert.equal(results[2], results[0], `cache=16384 drifted for "${query}" (${tone})`);
    }
    // Sanity: the corpus really did match, so identity is not vacuous.
    assert.ok(fts5Search(variants[0].store, "server", { tone: "both" }).length > 0);
    assert.deepEqual(variants.map(({ cacheSizeKib }) => cacheSizeKib), [undefined, 0, 16384]);
  } finally {
    for (const { p, store } of variants) {
      store.close();
      cleanup(p);
    }
  }
});

// 7. The cache size is not part of the TASK-016 fingerprint: no mismatch, no
// rebuild, and the index is still reported as verified after a cache change.
test("reopening with a different cacheSizeKib stays verified", () => {
  const p = tempDbPath("fingerprint");
  let store;
  try {
    store = openFts5Store({ path: p });
    assert.equal(cacheSize(store), -65536);
    store.addMany(CORPUS);
    assert.equal(store.metaStatus, "verified");
    const fingerprint = store.configFingerprint;
    store.close();

    store = openFts5Store({ path: p, cacheSizeKib: 8192 });
    assert.equal(cacheSize(store), -8192);
    assert.equal(store.metaStatus, "verified", "cache change must not look like drift");
    assert.equal(store.configMismatch, null);
    assert.equal(store.configFingerprint, fingerprint);
    assert.equal(store.allRows().length, CORPUS.length);
    const ids = fts5Search(store, "server", { tone: "both" }).map((r) => r.id);
    assert.ok(ids.includes(3), `reopened index still searches correctly: ${ids}`);
    assert.ok(!ids.includes(2) && !ids.includes(4), `unrelated docs absent: ${ids}`);
  } finally {
    store?.close();
    cleanup(p);
  }
});

// 8. The engine forwards the option (invalid values surface) and works with it.
test("createFts5Engine accepts cacheSizeKib", () => {
  const p = tempDbPath("engine");
  let reopened;
  try {
    assert.throws(
      () => createFts5Engine({ path: p, cacheSizeKib: -5 }),
      (err) => err instanceof TypeError && /cacheSizeKib/.test(err.message),
    );

    const engine = createFts5Engine({ path: p, cacheSizeKib: 16384 });
    engine.addMany(CORPUS);
    const ids = engine.search("server", { tone: "both" }).map((r) => r.id);
    assert.ok(ids.includes(3), `engine searches correctly: ${ids}`);
    engine.close();

    reopened = openFts5Store({ path: p, cacheSizeKib: 16384 });
    assert.equal(reopened.metaStatus, "verified");
    assert.equal(cacheSize(reopened), -16384);
  } finally {
    reopened?.close();
    cleanup(p);
  }
});
