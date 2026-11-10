// Engine interface + registry: registerEngine / createEngine lifecycle and the
// built-in "fts5" registration. Exercises the pluggable seam that future
// adapters (Meilisearch, Elasticsearch, in-memory…) will register against.
import { test } from "node:test";
import assert from "node:assert/strict";

const {
  registerEngine,
  createEngine,
  listEngines,
  createFts5Engine,
  unregisterAllEngines,
} = await import("../dist/index.js");

const skip = typeof Intl.Segmenter !== "function";

test("built-in fts5 engine is registered under its name", () => {
  assert.ok(listEngines().includes("fts5"), `expected fts5 in ${listEngines()}`);
});

test("registerEngine + createEngine lifecycle: add -> search -> remove -> close", { skip }, () => {
  registerEngine("test:lifecycle", (opts) => createFts5Engine({ ...opts, memory: true }));

  const engine = createEngine("test:lifecycle", { tone: "both", limit: 10 });
  assert.equal(engine.type, "fts5");

  engine.add({ id: "doc1", title: "คู่มือติดตั้ง", body: "ขั้นตอนการติดตั้งโปรแกรม" });
  engine.add({ id: "doc2", title: "ติดตังค่าบริการ", body: "รายเดือน" });

  const res = engine.search("ติดตั้ง", { limit: 10 });
  assert.ok(res.some((r) => r.id === "doc1"), `doc1 should rank: ${JSON.stringify(res)}`);
  assert.ok(res.length >= 1);

  engine.remove("doc1");
  const after = engine.search("ติดตั้ง", { tone: "strict", limit: 10 });
  assert.ok(
    !after.some((r) => r.id === "doc1"),
    `removed doc must not appear: ${JSON.stringify(after)}`
  );

  engine.close();
  assert.throws(() => engine.add({ id: "x", body: "y" }), /closed/i);
});

test("unregistered name throws with a helpful message", () => {
  assert.throws(() => createEngine("no-such-engine"), /no search engine registered/i);
});

test("re-registering a name swaps the factory (seam for test doubles)", () => {
  registerEngine("test:swap", (opts) => createFts5Engine({ ...opts, memory: true }));
  const before = createEngine("test:swap", { memory: true });
  assert.equal(before.type, "fts5");

  registerEngine("test:swap", () => ({
    type: "fake",
    add: () => {},
    remove: () => {},
    search: () => [],
    close: () => {},
  }));
  const after = createEngine("test:swap");
  assert.equal(after.type, "fake", "later registration must win");
});

test("createFts5Engine works directly and by registry with defaults", { skip }, () => {
  const direct = createFts5Engine({ memory: true, tone: "strict", limit: 5 });
  direct.add({ id: 1, body: "deploy release" });
  assert.ok(direct.search("deploy").length === 1);
  direct.close();

  const viaRegistry = createEngine("fts5", { memory: true });
  viaRegistry.add({ id: "a", body: "ติดตั้ง" });
  assert.ok(viaRegistry.search("ติดตั้ง").length >= 1);
  viaRegistry.close();
});

test("registry cleanup after the suite", () => {
  unregisterAllEngines();
  assert.deepEqual(listEngines(), []);
  registerEngine("fts5", (opts) => createFts5Engine({ ...opts, memory: true }));
  assert.ok(listEngines().includes("fts5"), "re-register fts5 for other suites");
});

test("BUG-2: engine.search after close throws the same clear error as add", () => {
  const eng = createFts5Engine({ memory: true });
  eng.add({ id: "a", body: "โปรแกรมติดตั้ง" });
  eng.close();
  assert.throws(() => eng.search("โปรแกรม"), /Search engine is closed/);
  assert.throws(() => eng.add({ id: "b", body: "x" }), /Search engine is closed/);
  assert.doesNotThrow(() => eng.close(), "engine.close is idempotent");
});
