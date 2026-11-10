import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { version, core, engine, fts5 } from "thai-fts";

test("thai-fts root ESM export exposes a version string via self-reference", () => {
  assert.equal(typeof version, "string");
  assert.match(version, /^\d+\.\d+\.\d+$/);
});

test("stub namespaces expose the same version", () => {
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
