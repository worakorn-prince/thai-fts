/**
 * Runtime capability check for the SQLite FTS5 adapter.
 *
 * `thai-fts/core` and `thai-fts/engine` never touch `node:sqlite`; only the FTS5
 * store does. So that importing `thai-fts` on a runtime without the built-in
 * module stays harmless, support is resolved lazily where a store is opened, and
 * `checkSqliteSupport()` exposes the same answer as an opt-in report.
 *
 * ```ts
 * import { checkSqliteSupport } from "thai-fts";
 * const support = checkSqliteSupport();
 * if (!support.ok) console.warn(support.missing, support.guidance);
 * ```
 */

/** Which Thai segmentation path the current runtime exposes. */
export type SegmenterSupport = "native" | "fallback";

/** Outcome of probing the runtime for the FTS5 adapter's requirements. */
export interface SqliteSupportReport {
  /** True when the FTS5 adapter can open a store here. */
  ok: boolean;
  /** Detected runtime, e.g. `node 22.13.0`. */
  runtime: string;
  /** SQLite version reported by the probe, present once it ran. */
  sqliteVersion?: string;
  /** `native` when `Intl.Segmenter` exists, otherwise `fallback`. */
  segmenter: SegmenterSupport;
  /** Unmet capabilities; empty when `ok` is true. */
  missing: string[];
  /** Remediation hint, present only when `ok` is false. */
  guidance?: string;
}

/** Options for {@link checkSqliteSupport}. */
export interface CheckSqliteSupportOptions {
  /** Seam for tests or exotic hosts: returns the `node:sqlite` module. */
  load?: () => unknown;
}

/** Raised when a store is opened without the runtime support it needs. */
export class SqliteSupportError extends Error {
  /** Runtime detected when the requirement failed. */
  readonly runtime: string;
  /** Capabilities the runtime does not provide. */
  readonly missing: readonly string[];

  constructor(missing: readonly string[], runtime = describeRuntime()) {
    super(
      `thai-fts needs the built-in ${SQLITE_MODULE} module with FTS5, which this runtime does not provide ` +
        `(detected ${runtime}; missing: ${missing.join(", ")}). ${GUIDANCE}`,
    );
    this.name = "SqliteSupportError";
    this.runtime = runtime;
    this.missing = Object.freeze([...missing]);
  }
}

const SQLITE_MODULE = "node:sqlite";
const DATABASE_SYNC = "node:sqlite DatabaseSync";
const FTS5 = "FTS5";
const GUIDANCE =
  "Run a Node.js release inside the package's engines range (>= 22.13.0), where the built-in " +
  "node:sqlite module and its FTS5 support ship with the runtime.";

const PROBE_TABLE = "thai_fts_capability_probe";
const PROBE_COLUMN = "body";
const PROBE_TEXT = "โปรแกรม";

/** Minimal shape of `DatabaseSync` used by the probe. */
interface ProbeDatabase {
  exec(sql: string): void;
  prepare(sql: string): ProbeStatement;
  close(): void;
}

interface ProbeStatement {
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): unknown;
}

type ProbeConstructor = new (location: string) => ProbeDatabase;

interface ProbeResult {
  sqliteVersion?: string;
  missing?: string;
}

/**
 * Report whether this runtime can run the FTS5 adapter. Never throws: an
 * unavailable module, a missing `DatabaseSync` export, or an engine without FTS5
 * all come back as `ok: false` with the unmet entries listed in `missing`.
 */
export function checkSqliteSupport(
  options: CheckSqliteSupportOptions = {},
): SqliteSupportReport {
  const runtime = describeRuntime();
  const segmenter: SegmenterSupport =
    typeof Intl.Segmenter === "function" ? "native" : "fallback";

  let loaded: unknown;
  try {
    loaded = (options.load ?? defaultLoad)();
  } catch {
    return failure(runtime, segmenter, [SQLITE_MODULE]);
  }
  if (loaded === null || loaded === undefined) {
    return failure(runtime, segmenter, [SQLITE_MODULE]);
  }

  const DatabaseSync = (loaded as { DatabaseSync?: unknown }).DatabaseSync;
  if (typeof DatabaseSync !== "function") {
    return failure(runtime, segmenter, [DATABASE_SYNC]);
  }

  const probe = probeFts5(DatabaseSync as ProbeConstructor);
  if (probe.missing) return failure(runtime, segmenter, [probe.missing], probe.sqliteVersion);
  return { ok: true, runtime, sqliteVersion: probe.sqliteVersion, segmenter, missing: [] };
}

/**
 * Resolve the `DatabaseSync` constructor, or throw {@link SqliteSupportError}
 * carrying the detected runtime, the missing capability and how to fix it. Only
 * the module and its interface are checked here — the full FTS5 probe belongs to
 * {@link checkSqliteSupport}, so opening a store stays cheap.
 */
export function requireSqlite(load: () => unknown = defaultLoad): unknown {
  const runtime = describeRuntime();

  let loaded: unknown;
  try {
    loaded = load();
  } catch {
    throw new SqliteSupportError([SQLITE_MODULE], runtime);
  }
  if (loaded === null || loaded === undefined) throw new SqliteSupportError([SQLITE_MODULE], runtime);

  const DatabaseSync = (loaded as { DatabaseSync?: unknown }).DatabaseSync;
  if (typeof DatabaseSync !== "function") throw new SqliteSupportError([DATABASE_SYNC], runtime);
  return DatabaseSync;
}

function failure(
  runtime: string,
  segmenter: SegmenterSupport,
  missing: string[],
  sqliteVersion?: string,
): SqliteSupportReport {
  const report: SqliteSupportReport = { ok: false, runtime, segmenter, missing, guidance: GUIDANCE };
  if (sqliteVersion) report.sqliteVersion = sqliteVersion;
  return report;
}

/** Load `node:sqlite` without importing it, so this module stays import-safe. */
function defaultLoad(): unknown {
  const proc = globalThis.process;
  const getBuiltin = proc?.getBuiltinModule;
  if (typeof getBuiltin !== "function") {
    throw new Error(`${SQLITE_MODULE} cannot be resolved in this runtime`);
  }
  return getBuiltin.call(proc, SQLITE_MODULE);
}

function describeRuntime(): string {
  const proc = globalThis.process;
  return `${proc?.release?.name ?? "node"} ${proc?.version ?? "unknown"}`;
}

function probeFts5(DatabaseSync: ProbeConstructor): ProbeResult {
  let db: ProbeDatabase;
  try {
    db = new DatabaseSync(":memory:");
  } catch {
    return { missing: DATABASE_SYNC };
  }

  try {
    db.exec(`CREATE VIRTUAL TABLE ${PROBE_TABLE} USING fts5(${PROBE_COLUMN})`);
    db.prepare(`INSERT INTO ${PROBE_TABLE}(${PROBE_COLUMN}) VALUES (?)`).run(PROBE_TEXT);
    const hits = db
      .prepare(`SELECT count(*) AS hits FROM ${PROBE_TABLE} WHERE ${PROBE_TABLE} MATCH ?`)
      .get(PROBE_TEXT) as { hits?: number } | undefined;
    if (!hits || Number(hits.hits) < 1) return { missing: FTS5 };

    const version = db.prepare("SELECT sqlite_version() AS version").get() as
      | { version?: string }
      | undefined;
    return { sqliteVersion: version?.version };
  } catch {
    return { missing: FTS5 };
  } finally {
    try {
      db.close();
    } catch {
      // The probe database is already gone; nothing to release.
    }
  }
}
