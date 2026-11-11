// Runtime capability check (audit PATCH 1): a report for every way the built-in
// `node:sqlite` module can be missing, the typed error an unsupported runtime
// raises when a store is opened, and the probe database being released in all
// paths. Failure modes are driven through the injectable loader seam so they can
// be asserted on a supported runtime.
import { test } from "node:test";
import assert from "node:assert/strict";

const { checkSqliteSupport, SqliteSupportError, openFts5Store } = await import(
  "../../dist/index.js"
);

const SQLITE_MODULE = "node:sqlite";
const DATABASE_SYNC = "node:sqlite DatabaseSync";
const FTS5 = "FTS5";

/** Stub `node:sqlite` module whose DatabaseSync records calls and can fail. */
function stubModule(behaviour = {}) {
  const calls = { constructed: 0, exec: 0, prepared: [], closed: 0 };
  class DatabaseSync {
    constructor(location) {
      calls.constructed += 1;
      calls.location = location;
      if (behaviour.constructThrows) throw new Error("no sqlite engine");
    }
    exec(sql) {
      calls.exec += 1;
      if (behaviour.execThrows) throw new Error("no such module: fts5");
    }
    prepare(sql) {
      calls.prepared.push(sql);
      return {
        get() {
          calls.get = (calls.get ?? 0) + 1;
          if (behaviour.getThrows) throw new Error("statement finalized");
          if (sql.includes("MATCH")) return behaviour.matchRows ?? { hits: 1 };
          if (sql.includes("sqlite_version")) return { version: "3.99.9" };
          return undefined;
        },
        run() {
          calls.run = (calls.run ?? 0) + 1;
          return { changes: 1 };
        },
      };
    }
    close() {
      calls.closed += 1;
      if (behaviour.closeThrows) throw new Error("already closed");
    }
  }
  return { module: { DatabaseSync }, calls, behaviour };
}

test("checkSqliteSupport: real runtime is supported", () => {
  const report = checkSqliteSupport();
  assert.equal(report.ok, true, `expected support, missing: ${report.missing.join(", ")}`);
  assert.equal(report.runtime, `node ${process.version}`);
  assert.match(String(report.sqliteVersion), /^\d+\.\d+\.\d+$/);
  assert.deepEqual(report.missing, []);
  assert.ok(["native", "fallback"].includes(report.segmenter));
  assert.equal(report.guidance, undefined, "supported runtime needs no guidance");
});

test("checkSqliteSupport: is exposed on the public surface", () => {
  assert.equal(typeof checkSqliteSupport, "function");
  assert.equal(typeof SqliteSupportError, "function");
  const error = new SqliteSupportError([FTS5], "node 21.0.0");
  assert.ok(error instanceof Error);
  assert.ok(error instanceof SqliteSupportError);
  assert.equal(error.name, "SqliteSupportError");
  assert.equal(error.runtime, "node 21.0.0");
  assert.deepEqual([...error.missing], [FTS5]);
});

test("checkSqliteSupport: loader throwing reports node:sqlite missing", () => {
  const report = checkSqliteSupport({
    load: () => {
      throw new Error("ERR_UNKNOWN_BUILTIN_MODULE");
    },
  });
  assert.equal(report.ok, false);
  assert.deepEqual(report.missing, [SQLITE_MODULE]);
  assert.match(report.guidance, /22\.13\.0/);
  assert.match(report.runtime, /^node /);
  assert.equal(report.sqliteVersion, undefined);
});

test("checkSqliteSupport: module resolving to undefined reports node:sqlite missing", () => {
  const report = checkSqliteSupport({ load: () => undefined });
  assert.equal(report.ok, false);
  assert.deepEqual(report.missing, [SQLITE_MODULE]);
});

test("checkSqliteSupport: module without DatabaseSync reports the interface missing", () => {
  const report = checkSqliteSupport({ load: () => ({}) });
  assert.equal(report.ok, false);
  assert.deepEqual(report.missing, [DATABASE_SYNC]);
  assert.match(report.guidance, /22\.13\.0/);
});

test("checkSqliteSupport: DatabaseSync that cannot be constructed reports it missing", () => {
  const { module, calls } = stubModule({ constructThrows: true });
  const report = checkSqliteSupport({ load: () => module });
  assert.equal(report.ok, false);
  assert.deepEqual(report.missing, [DATABASE_SYNC]);
  assert.equal(calls.constructed, 1);
  assert.equal(calls.exec, 0);
});

test("checkSqliteSupport: failing FTS5 DDL reports FTS5 missing and closes the probe", () => {
  const { module, calls } = stubModule({ execThrows: true });
  const report = checkSqliteSupport({ load: () => module });
  assert.equal(report.ok, false);
  assert.deepEqual(report.missing, [FTS5]);
  assert.equal(calls.exec, 1);
  assert.equal(calls.closed, 1, "probe database must be closed after a failed exec");
});

test("checkSqliteSupport: a failing statement reports FTS5 missing and closes the probe", () => {
  const { module, calls } = stubModule({ getThrows: true });
  const report = checkSqliteSupport({ load: () => module });
  assert.equal(report.ok, false);
  assert.deepEqual(report.missing, [FTS5]);
  assert.equal(calls.closed, 1);
});

test("checkSqliteSupport: zero Thai MATCH hits reports FTS5 missing", () => {
  const { module, calls } = stubModule({ matchRows: { hits: 0 } });
  const report = checkSqliteSupport({ load: () => module });
  assert.equal(report.ok, false);
  assert.deepEqual(report.missing, [FTS5]);
  assert.equal(calls.closed, 1);
});

test("checkSqliteSupport: a successful stubbed probe closes the database and reports the version", () => {
  const { module, calls } = stubModule();
  const report = checkSqliteSupport({ load: () => module });
  assert.equal(report.ok, true);
  assert.equal(report.sqliteVersion, "3.99.9");
  assert.equal(calls.location, ":memory:", "probe must never touch the filesystem");
  assert.equal(calls.closed, 1);
  assert.ok(
    calls.prepared.some((sql) => /INSERT INTO .*\(body\) VALUES \(\?\)/.test(sql)),
    "probe must insert the Thai sample",
  );
  assert.ok(
    calls.prepared.some((sql) => /WHERE \w+ MATCH \?/.test(sql)),
    "probe must verify a Thai MATCH query",
  );
});

test("checkSqliteSupport: an uncloseable probe database still reports support", () => {
  const { module } = stubModule({ closeThrows: true });
  const report = checkSqliteSupport({ load: () => module });
  assert.equal(report.ok, true);
});

test("openFts5Store: raises SqliteSupportError with guidance when node:sqlite is unavailable", () => {
  const original = process.getBuiltinModule;
  try {
    process.getBuiltinModule = () => {
      throw new Error("ERR_UNKNOWN_BUILTIN_MODULE");
    };
    let thrown;
    try {
      openFts5Store({ memory: true });
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof SqliteSupportError, `got ${thrown?.constructor?.name}`);
    assert.equal(thrown.name, "SqliteSupportError");
    assert.deepEqual([...thrown.missing], [SQLITE_MODULE]);
    assert.match(thrown.message, /node:sqlite/);
    assert.match(thrown.message, /22\.13\.0/);
    assert.match(thrown.message, /node /);
  } finally {
    process.getBuiltinModule = original;
  }
  const restored = openFts5Store({ memory: true });
  try {
    assert.ok(restored.db, "support returns once the module resolves again");
  } finally {
    restored.close();
  }
});
