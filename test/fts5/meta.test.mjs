// TASK-016 (audit PATCH 2): persisted index metadata + deterministic
// fingerprint + reopen compatibility detection for the SQLite FTS5 store.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const {
  openFts5Store,
  createFts5Engine,
  Fts5ConfigMismatchError,
  computeFingerprint,
} = await import("../../dist/index.js");

function tempDbPath(tag) {
  return join(
    tmpdir(),
    `thai-fts-meta-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

function cleanup(p) {
  for (const s of ["", "-wal", "-shm"]) rmSync(`${p}${s}`, { force: true });
}

// Read the fingerprint that is actually persisted in the metadata table.
function storedFingerprint(store) {
  const row = store.db
    .prepare("SELECT fingerprint FROM thai_fts_meta WHERE key = 'index'")
    .get();
  return row ? row.fingerprint : undefined;
}

// 1. Same-config reopen OK — a database we indexed ourselves reopens "verified".
test("same-config reopen is verified and does not throw", () => {
  const p = tempDbPath("same");
  try {
    let store = openFts5Store({ path: p, prefix: [2, 3] });
    assert.equal(store.metaStatus, "fresh", "brand-new store is fresh");
    store.add({ id: "a", body: "ผมต้องติดตั้งโปรแกรม" });
    assert.equal(store.metaStatus, "verified", "publish-on-first-add verifies");
    const fp = store.configFingerprint;
    store.close();

    store = openFts5Store({ path: p, prefix: [2, 3] });
    assert.equal(store.metaStatus, "verified", "reopen under same config verifies");
    assert.equal(store.configFingerprint, fp);
    assert.equal(store.configMismatch, null);
    assert.equal(store.allRows().length, 1, "index survives reopen");
    store.close();
  } finally {
    cleanup(p);
  }
});

// 2. Equivalent config serializes identically — reordered / duplicated
// stopwords collapse to one fingerprint via canonicalization (no mismatch).
test("equivalent config (reordered/duplicate stopwords) fingerprints identically", () => {
  const p = tempDbPath("equiv");
  try {
    let store = openFts5Store({ path: p, stopwords: ["ข", "ก", "ก", "ข"] });
    store.add({ id: "a", body: "โปรแกรม" });
    const fpA = store.configFingerprint;
    store.close();

    // Same set, different order + duplicates — must NOT trip the check.
    store = openFts5Store({ path: p, stopwords: ["ก", "ข"] });
    assert.equal(store.metaStatus, "verified", "reordered stopword set is equivalent");
    assert.equal(store.configFingerprint, fpA);
    store.close();

    // The pure helper agrees: order-insensitive map/array normalization.
    assert.equal(
      computeFingerprint({
        schema: "s",
        prefix: [3, 2, 2],
        stopwords: ["ก", "ข"],
        stem: false,
        dictionaries: [],
        segmenter: "native",
      }),
      computeFingerprint({
        schema: "s",
        prefix: [2, 3],
        stopwords: ["ข", "ก"],
        stem: false,
        dictionaries: [],
        segmenter: "native",
      }),
    );
  } finally {
    cleanup(p);
  }
});

// 3. A relevant change is detected and NAMES the category (default: throw).
test("index-affecting change throws naming the category", () => {
  const p = tempDbPath("drift");
  try {
    let store = openFts5Store({ path: p });
    store.add({ id: "a", body: "โปรแกรม" });
    store.close();

    // Turning stopwords ON changes the indexed payload → must be rejected.
    assert.throws(
      () => openFts5Store({ path: p, stopwords: true }),
      (err) => {
        assert.ok(err instanceof Fts5ConfigMismatchError, "typed error");
        assert.equal(err.name, "Fts5ConfigMismatchError");
        assert.ok(err.categories.includes("stopwords"), "names the stopwords category");
        assert.match(err.message, /NOT rebuilt/);
        return true;
      },
    );

    // Same drift, but with the opt-in ignore policy: opens, reports mismatch.
    const ignored = openFts5Store({ path: p, stopwords: true, onConfigMismatch: "ignore" });
    assert.equal(ignored.metaStatus, "mismatch-ignored");
    assert.deepEqual(ignored.configMismatch, ["stopwords"]);
    ignored.close();
  } finally {
    cleanup(p);
  }
});

// 4. Query-only options never trip the compatibility check.
test("query-only option changes do not error on reopen", () => {
  const p = tempDbPath("queryonly");
  try {
    let engine = createFts5Engine({ path: p, tone: "strict", limit: 10 });
    engine.add({ id: "a", title: "คู่มือ", body: "ติดตั้งโปรแกรม" });
    engine.close();

    // Different tone / limit / autocomplete prefix — all query-only.
    assert.doesNotThrow(() => {
      const reopened = createFts5Engine({ path: p, tone: "loose", limit: 5, prefix: true });
      reopened.close();
    });
  } finally {
    cleanup(p);
  }
});

// 5. Dictionaries without a stable `version` are covered by a content hash.
test("dictionary drift without a version is caught by the content-hash backstop", () => {
  const p = tempDbPath("dict");
  try {
    let store = openFts5Store({ path: p, dictionaries: [{ id: "tech", words: ["โปรแกรม"] }] });
    store.add({ id: "a", body: "โปรแกรม" });
    const fp = store.configFingerprint;
    store.close();

    // Same id, no version, SAME content → still verified.
    store = openFts5Store({ path: p, dictionaries: [{ id: "tech", words: ["โปรแกรม"] }] });
    assert.equal(store.metaStatus, "verified", "identical dictionary content is stable");
    assert.equal(store.configFingerprint, fp);
    store.close();

    // Same id, no version, CHANGED content → the hash catches it ("dictionary").
    assert.throws(
      () => openFts5Store({ path: p, dictionaries: [{ id: "tech", words: ["โปรแกรม", "เซิร์ฟเวอร์"] }] }),
      (err) => {
        assert.ok(err instanceof Fts5ConfigMismatchError);
        assert.ok(err.categories.includes("dictionary"), "names the dictionary category");
        return true;
      },
    );
  } finally {
    cleanup(p);
  }
});

// 6. A legacy database (data, no metadata table) always opens — unverified.
test("legacy database opens as legacy-unverified regardless of policy", () => {
  const p = tempDbPath("legacy");
  try {
    // Simulate a database written before metadata existed: only `documents`.
    const raw = new DatabaseSync(p);
    raw.exec(
      "CREATE TABLE documents (id TEXT PRIMARY KEY, is_num INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '')",
    );
    raw
      .prepare("INSERT INTO documents (id, is_num, title, body) VALUES (?, 0, '', ?)")
      .run("legacy", "โปรแกรมเก่าสุดเก่า");
    raw.close();

    // Even under the strict default, a legacy DB must open (never claim verified).
    const store = openFts5Store({ path: p });
    assert.equal(store.metaStatus, "legacy-unverified");
    assert.equal(store.configMismatch, null);
    assert.equal(store.allRows().length, 1, "legacy rows remain readable");

    // First successful mutation adopts the baseline honestly (still unverified).
    store.add({ id: "new", body: "เพิ่่มใหม่" });
    assert.equal(store.metaStatus, "legacy-unverified", "adoption stays unverified");
    const origin = store.db
      .prepare("SELECT origin FROM thai_fts_meta WHERE key = 'index'")
      .get();
    assert.equal(origin.origin, "attached-baseline");
    store.close();
  } finally {
    cleanup(p);
  }
});

// 7. A FAILED rebuild must never publish the new metadata.
test("failed rebuild leaves the previously stored metadata untouched", () => {
  const p = tempDbPath("failrebuild");
  try {
    let store = openFts5Store({ path: p });
    store.add({ id: "a", body: "โปรแกรม" });
    const fpBefore = storedFingerprint(store);
    assert.ok(fpBefore, "metadata was published on first add");
    store.close();

    // Reopen with drifted (index-affecting) config, ignoring the mismatch.
    store = openFts5Store({ path: p, stopwords: true, onConfigMismatch: "ignore" });
    assert.equal(store.metaStatus, "mismatch-ignored");

    // A rebuild that throws mid-transaction must not publish the new config.
    assert.throws(() => store.rebuild([{ id: null, body: "x" }]), TypeError);
    assert.equal(storedFingerprint(store), fpBefore, "stored fingerprint unchanged after failure");
    assert.equal(store.metaStatus, "mismatch-ignored", "status unchanged after failed rebuild");

    // A SUCCESSFUL rebuild is the documented adoption path: publishes + verifies.
    store.rebuild([{ id: "a", body: "โปรแกรม" }]);
    assert.equal(store.metaStatus, "verified");
    assert.notEqual(storedFingerprint(store), fpBefore, "successful rebuild adopts new config");
    store.close();
  } finally {
    cleanup(p);
  }
});
