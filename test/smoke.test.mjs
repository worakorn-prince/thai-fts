import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { version, core, engine, fts5, createFts5Engine, wordTokens, createEngine, MAX_QUERY_CHUNKS } from "thai-fts";

test("thai-fts root ESM export exposes a version string via self-reference", () => {
  assert.equal(typeof version, "string");
  assert.match(version, /^\d+\.\d+\.\d+$/);
});

test("version namespaces expose the same version", () => {
  assert.equal(core.version, version);
  assert.equal(engine.version, version);
  assert.equal(fts5.version, version);
});

test("thai-fts CJS entry (require condition) exposes the same version", () => {
  const require = createRequire(import.meta.url);
  const cjs = require("thai-fts");
  assert.equal(cjs.version, version);
  assert.equal(cjs.core.version, version);
});

test("root re-exports the full public surface (core + engine + fts5)", () => {
  assert.equal(typeof createFts5Engine, "function");
  assert.equal(typeof wordTokens, "function");
  assert.equal(typeof createEngine, "function");
  assert.equal(MAX_QUERY_CHUNKS, 8, "MAX_QUERY_CHUNKS is a public constant equal to 8");
});

async function assertSubpath(importPath, expectations) {
  const mod = await import(importPath);
  for (const name of expectations) {
    assert.notEqual(typeof mod[name], "undefined", `${importPath}: ${name} missing`);
  }
  return mod;
}

test("all four exports subpaths resolve in ESM (import time)", async () => {
  await assertSubpath("thai-fts", [
    "wordTokens", "looseForm", "expandSynonyms",
    "registerEngine", "createEngine", "createFts5Engine", "openFts5Store",
  ]);
  await assertSubpath("thai-fts/core", [
    "wordTokens", "looseForm", "expandSynonyms",
    "registerThaiDictionary", "buildSearchQuery",
  ]);
  await assertSubpath("thai-fts/engine", [
    "registerEngine", "createEngine", "listEngines", "unregisterAllEngines",
  ]);
  await assertSubpath("thai-fts/fts5", [
    "createFts5Engine", "openFts5Store", "fts5Search",
    "FTS5_STRICT_SCHEMA", "FTS5_LOOSE_SCHEMA",
  ]);
});

test("subpaths resolve in CJS (require time) — ./core and ./fts5", () => {
  const require = createRequire(import.meta.url);
  const coreCjs = require("thai-fts/core");
  assert.equal(typeof coreCjs.wordTokens, "function", "./core (CJS)");
  const engineCjs = require("thai-fts/engine");
  assert.equal(typeof engineCjs.createEngine, "function", "./engine (CJS)");
  const fts5Cjs = require("thai-fts/fts5");
  assert.equal(typeof fts5Cjs.createFts5Engine, "function", "./fts5 (CJS)");
});

test("./core loads without dragging in node:sqlite (pure core only)", async () => {
  const coreMod = await import("thai-fts/core");
  // The core bundle must not reference the sqlite adapter or DatabaseSync.
  assert.equal(typeof coreMod.openFts5Store, "undefined", "core must not expose fts5 store");
  assert.equal(typeof coreMod.createFts5Engine, "undefined", "core must not expose fts5 engine");
});
