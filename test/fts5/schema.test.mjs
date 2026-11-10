// FTS5 schema: the exported DDL constants and the tables actually created by
// openFts5Store must carry the mark-aware tokenizer (categories 'L* N* Co M*').
// That directive is the whole trick that keeps tone marks significant — a
// regression here would silently re-enable ติดตั้ง/ติดตัง collisions.
import { test } from "node:test";
import assert from "node:assert/strict";

const { FTS5_STRICT_SCHEMA, FTS5_LOOSE_SCHEMA, openFts5Store } = await import(
  "../../dist/index.js"
);

test("exported FTS5_STRICT_SCHEMA tokenizer is mark-aware", () => {
  assert.match(FTS5_STRICT_SCHEMA, /categories/);
  assert.match(FTS5_STRICT_SCHEMA, /L\* N\* Co M\*/);
  assert.match(FTS5_STRICT_SCHEMA, /fts5_strict/);
  assert.match(FTS5_STRICT_SCHEMA, /unicode61/);
});

test("exported FTS5_LOOSE_SCHEMA shares the mark-aware tokenizer", () => {
  assert.match(FTS5_LOOSE_SCHEMA, /categories/);
  assert.match(FTS5_LOOSE_SCHEMA, /L\* N\* Co M\*/);
  assert.match(FTS5_LOOSE_SCHEMA, /fts5_loose/);
  // Only the table name differs from strict — the tokenizer stays in lockstep.
  assert.equal(
    FTS5_LOOSE_SCHEMA.replace(/fts5_loose/g, "fts5_strict"),
    FTS5_STRICT_SCHEMA
  );
});

test("sqlite_master rows for a freshly opened store keep the tokenizer", () => {
  const store = openFts5Store({ memory: true });
  for (const name of ["fts5_strict", "fts5_loose"]) {
    const row = store.db
      .prepare("SELECT sql FROM sqlite_master WHERE name = ?")
      .get(name);
    assert.ok(row && typeof row.sql === "string", `${name} SQL not found`);
    assert.match(row.sql, /categories/);
    assert.match(row.sql, /L\* N\* Co M\*/);
  }
  store.close();
});

test("PRAGMA table_info exposes the declared columns", () => {
  const store = openFts5Store({ memory: true });
  const cols = store.db.prepare("PRAGMA table_info(fts5_strict)").all();
  const names = cols.map((c) => c.name);
  for (const expected of ["id", "title", "body"]) {
    assert.ok(names.includes(expected), `expected column ${expected} in ${names}`);
  }
  // The strict and loose tables stay structurally identical.
  const loose = store.db.prepare("PRAGMA table_info(fts5_loose)").all();
  assert.deepEqual(
    loose.map((c) => c.name),
    names,
    "strict and loose channels must have identical columns"
  );
  store.close();
});
