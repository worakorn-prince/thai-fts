/**
 * SQLite FTS5 document store built on the Node built-in `node:sqlite`
 * (`DatabaseSync`) — zero external runtime dependency. This is the reference
 * adapter that operationalizes the tone-sensitivity promise:
 *
 *  - a STRICT channel (fts5_strict) indexes the mark-aware segmented payload
 *    (`expandIndexedText(segmentForIndex(title|body))`), so ติดตั้ง and ติดตัง
 *    never collide;
 *  - a LOOSE channel (fts5_loose) stores `looseForm` of the SAME strict
 *    payload, so a tone-mark typo can still surface a correctly-marked
 *    document (dual-channel ranking is the search layer's job, see search.ts).
 *
 * A plain `documents` table shadows the two FTS tables so the store can
 * re-serve raw text (snippets), dedupe, and rebuild without an external
 * source of truth. All public mutation methods are transactional and
 * idempotent (re-adding an id replaces it; re-indexing is a byte fixed point).
 *
 * ```ts
 * import { openFts5Store } from "thai-fts";
 * const store = openFts5Store({ memory: true });
 * store.add({ id: 1, title: "คู่มือ", body: "ผมต้องติดตั้งโปรแกรม" });
 * store.close();
 * ```
 */
import type { DatabaseSync } from "node:sqlite";
import { looseForm } from "../../core/segment.js";
import { THAI_DEFAULT_STOPWORDS } from "../../core/stopwords.js";
import { registerThaiDictionary } from "../../core/dictionaries.js";
import type { ThaiDictionaryDef } from "../../core/types.js";
import type { ThaiSearchDoc } from "../engine.js";
import { buildIndexPayload } from "../_align.js";
import { buildLooseSchema, buildStrictSchema } from "./schema.js";
import { requireSqlite } from "./capability.js";
import {
  buildIndexConfig,
  computeFingerprint,
  CURRENT_META_VERSION,
  diffCategories,
  Fts5ConfigMismatchError,
  publishMetaOnce,
  publishMetaUpsert,
  readMeta,
  tableExists,
} from "./meta.js";
import type { ConfigCategory, IndexConfig, MetaStatus } from "./meta.js";

/** Options for opening a memory- or file-backed FTS5 store. */
export interface OpenFts5StoreOptions {
  /** File path to open/reuse. Mutually exclusive with `memory`; defaults to
   * `:memory:` when neither `path` nor `memory` is given. */
  path?: string;
  /** Force an in-memory database (ignores `path`). */
  memory?: boolean;
  /** Thai dictionaries to register at open time (see
   * `registerThaiDictionary`). Registers are global to the core registry, so
   * this is a convenience for wiring them in one call. */
  dictionaries?: readonly ThaiDictionaryDef[];
  /** FTS5 prefix-index lengths (e.g. `[2, 3]` → `prefix='2 3'`) on both
   * channels, powering autocomplete `*` queries. Only affects tables created
   * at this open; opening an existing file DB with a different `prefix` does
   * not rebuild it (call `rebuild()` or reopen a fresh database). */
  prefix?: readonly number[];
  /** Opt-in symmetric stopword filtering. `true` uses the curated
   * `THAI_DEFAULT_STOPWORDS`; a string[] uses that exact list; `false`/absent
   * disables it. Stopword tokens are removed from the indexed payload on BOTH
   * channels, and search applies the same filter to query phrases. **Enabling
   * this changes the indexed payload — existing on-disk databases must be
   * rebuilt** (re-index via `rebuild()` or recreate the file). Default off. */
  stopwords?: boolean | readonly string[];
  /** Opt-in English Porter stemming (`stemEn`) on ASCII tokens of the indexed
   * payload (Thai tokens pass through unchanged). Symmetric with the
   * query-side `MatchBuildOptions.stem`: search threads `store.stem` into the
   * MATCH builders automatically. **Enabling this changes the indexed payload
   * — existing on-disk databases must be rebuilt** (re-index via `rebuild()`
   * or recreate the file). Default off. */
  stem?: boolean;
  /** What to do when a reopened file database carries persisted metadata whose
   * fingerprint disagrees with the config this store is opened with. `"throw"`
   * (default) raises `Fts5ConfigMismatchError` naming the drifted categories;
   * `"ignore"` opens anyway and reports `metaStatus: "mismatch-ignored"`, leaving
   * the stale index untouched until you call `rebuild()` to adopt the new config.
   * Databases created before metadata existed are ALWAYS opened (they report
   * `"legacy-unverified"`), regardless of this setting. */
  onConfigMismatch?: "throw" | "ignore";
  /** SQLite page-cache cap for FILE-backed stores in KiB. Default **65536**
   * (64 MiB); `0` keeps SQLite's default. Ignored for memory stores. The cache
   * is per-connection and lazily allocated, so it does not change index bytes,
   * durability, journaling or search results. Not part of the config
   * fingerprint: changing it never triggers a rebuild or a mismatch error. */
  cacheSizeKib?: number;
}

/** A row of raw document text as returned by the store. */
export interface Fts5DocRow {
  /** The document id, reconstructed to its original string|number type. */
  id: string | number;
  title: string;
  body: string;
}

/** The FTS5 store handle. `db` is exposed read-only for power users (direct
 * queries, migrations); go through the methods for indexed mutations. */
export interface Fts5Store {
  readonly type: "fts5";
  /** The underlying `node:sqlite` DatabaseSync handle. */
  readonly db: DatabaseSync;
  /** The resolved stopword list this store was opened with (empty = off).
   * Search reads it to keep query-side filtering symmetric with the index. */
  readonly stopwords: readonly string[];
  /** Whether opt-in English Porter stemming was enabled at open time.
   * Search reads it so the query-side `stem` stays symmetric with the index. */
  readonly stem: boolean;
  /** How confidently this store believes its on-disk index matches the config
   * it was opened with. `"verified"` only when we recorded the config that
   * built the index; legacy/baseline states never claim verification. */
  readonly metaStatus: MetaStatus;
  /** Fingerprint of the effective index-affecting config in use right now. */
  readonly configFingerprint: string;
  /** Categories that drifted on a `mismatch-ignored` reopen, or `null` when
   * nothing drifted (or the state is fresh/legacy). */
  readonly configMismatch: readonly ConfigCategory[] | null;
  /** Index (or re-index) a document on both channels; replaces any prior row
   * with the same id atomically. Uses registered Thai dictionaries if any. */
  add(doc: ThaiSearchDoc): void;
  /** Index a batch of documents in ONE transaction — equivalent to `add` for
   * each entry, but either the whole batch lands or none of it does (a failure
   * part-way rolls back every insert, including replacements of existing ids).
   * An empty iterable is a no-op. The iterable is consumed LAZILY inside the
   * transaction (no eager `[...batch]` materialization), so a generator of many
   * documents never has to fit in memory at once. */
  addMany(docs: Iterable<ThaiSearchDoc>): void;
  /** Drop the document (and its FTS rows) by id. No-op when absent. */
  remove(id: string | number): void;
  /** Convenience for replace-then-index (identical semantics to `add`). */
  update(doc: ThaiSearchDoc): void;
  /** Rebuild the FTS indexes. With no args, re-indexes the stored raw
   * documents (fixes drift, e.g. after a schema/tokenizer change). With
   * `docs`, replaces the whole store with exactly those documents. */
  rebuild(docs?: readonly ThaiSearchDoc[]): void;
  /** Close the underlying database. Idempotent. */
  close(): void;
  /** Read a stored document's raw text by id, or undefined when absent. */
  get(id: string | number): Fts5DocRow | undefined;
  /** Raw text of every stored document (insertion order). */
  allRows(): Fts5DocRow[];
}

interface DocRowRecord {
  id: string;
  is_num: number;
  title: string;
  body: string;
}

const DEFAULT_PRAGMAS = [
  "PRAGMA busy_timeout = 5000",
  "PRAGMA foreign_keys = ON",
  "PRAGMA synchronous = NORMAL",
];

const DOCUMENTS_DDL = `CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  is_num INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT ''
)`;

function decodeId(r: Pick<DocRowRecord, "id" | "is_num">): string | number {
  return r.is_num ? Number(r.id) : r.id;
}

/**
 * `node:sqlite` is resolved at open time rather than at import, so a runtime
 * without the built-in module can still load `thai-fts` and its core modules.
 */
type SqliteDatabaseConstructor = { new (location: string): DatabaseSync };

/**
 * Open (or create) an FTS5 document store. File databases use WAL + NORMAL
 * synchronous for crash safety with low write latency and a bounded page cache
 * (`cacheSizeKib`) for multi-hundred-docs/s batch indexing; memory databases
 * get the same busy/foreign-key tuning without WAL (a no-op in-memory).
 */
export function openFts5Store(opts: OpenFts5StoreOptions = {}): Fts5Store {
  const isMemory = opts.memory === true || !opts.path || opts.path === ":memory:";
  const cacheSizeKib = opts.cacheSizeKib ?? 65536;
  if (!Number.isInteger(cacheSizeKib) || cacheSizeKib < 0) {
    throw new TypeError("cacheSizeKib must be an integer >= 0");
  }
  const SqliteDatabase = requireSqlite() as unknown as SqliteDatabaseConstructor;
  const db = new SqliteDatabase(isMemory ? ":memory:" : (opts.path as string));

  for (const pragma of DEFAULT_PRAGMAS) db.exec(pragma);
  if (!isMemory) db.exec("PRAGMA journal_mode = WAL");
  // Page cache is per-connection and lazily allocated: a bounded cap removes the
  // disk-bound penalty of large batch indexing without touching stored bytes.
  if (!isMemory && cacheSizeKib !== 0) {
    db.exec(`PRAGMA cache_size = -${cacheSizeKib}`);
  }

  // Prefix indexes + stopword list + stemming are fixed at open time. Applying
  // stopwords or stemming changes the indexed payload, so documents must be
  // re-indexed (rebuild) if either option toggles on an existing on-disk
  // database.
  const prefix = opts.prefix;
  const stopwords: readonly string[] =
    opts.stopwords === undefined || opts.stopwords === false
      ? []
      : opts.stopwords === true
        ? THAI_DEFAULT_STOPWORDS
        : [...opts.stopwords];
  const stem = opts.stem === true;

  // Detect what already exists BEFORE running any DDL, so creating the tables
  // (or the metadata table) never masks a legacy database. A legacy DB is one
  // that already has data but predates the metadata table entirely.
  const hadMeta = tableExists(db, "thai_fts_meta");
  const hadDocs = tableExists(db, "documents");

  db.exec(DOCUMENTS_DDL);
  db.exec(buildStrictSchema(prefix));
  db.exec(buildLooseSchema(prefix));

  for (const def of opts.dictionaries ?? []) {
    registerThaiDictionary(def);
  }

  // Effective index-affecting config + its fingerprint, recomputed now so a
  // reopen can compare against whatever the file recorded.
  const currentConfig: IndexConfig = buildIndexConfig({
    prefix,
    stopwords,
    stem,
    dictionaries: opts.dictionaries ?? [],
  });
  const currentFingerprint = computeFingerprint(currentConfig);
  const onConfigMismatch = opts.onConfigMismatch ?? "throw";

  // metaStatus starts as "fresh" (nothing indexed yet) and is refined by the
  // verification below or by the first successful mutation.
  let metaStatus: MetaStatus = "fresh";
  let configMismatch: readonly ConfigCategory[] | null = null;

  if (hadMeta) {
    const stored = readMeta(db);
    if (!stored) {
      // Table existed but the row is missing/unreadable — never claim verified.
      metaStatus = "legacy-unverified";
    } else if (stored.metaVersion !== CURRENT_META_VERSION) {
      configMismatch = ["meta-version", ...diffCategories(stored.config, currentConfig)];
      if (onConfigMismatch === "throw") {
        db.close();
        throw new Fts5ConfigMismatchError(
          configMismatch,
          stored.fingerprint,
          currentFingerprint,
          stored.metaVersion,
        );
      }
      metaStatus = "mismatch-ignored";
    } else if (stored.fingerprint !== currentFingerprint) {
      configMismatch = diffCategories(stored.config, currentConfig);
      if (configMismatch.length === 0) configMismatch = ["schema"];
      if (onConfigMismatch === "throw") {
        db.close();
        throw new Fts5ConfigMismatchError(
          configMismatch,
          stored.fingerprint,
          currentFingerprint,
          stored.metaVersion,
        );
      }
      metaStatus = "mismatch-ignored";
    } else {
      // Fingerprint matches. A "created" origin means we built this index under
      // this exact config; an "attached-baseline" origin means the config was
      // adopted onto pre-existing rows we did not index ourselves — stay honest.
      metaStatus = stored.origin === "created" ? "verified" : "unknown-baseline";
    }
  } else if (hadDocs) {
    // Legacy database (data, no metadata): always openable regardless of the
    // mismatch policy, but compatibility is NOT verified.
    metaStatus = "legacy-unverified";
  }

  const insStrict = db.prepare(
    "INSERT INTO fts5_strict (id, title, body) VALUES (?, ?, ?)"
  );
  const insLoose = db.prepare(
    "INSERT INTO fts5_loose (id, title, body) VALUES (?, ?, ?)"
  );
  const delStrict = db.prepare("DELETE FROM fts5_strict WHERE id = ?");
  const delLoose = db.prepare("DELETE FROM fts5_loose WHERE id = ?");
  const upsertDoc = db.prepare(
    `INSERT INTO documents (id, is_num, title, body) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       is_num = excluded.is_num, title = excluded.title, body = excluded.body`
  );
  const delDoc = db.prepare("DELETE FROM documents WHERE id = ?");
  const selDoc = db.prepare(
    "SELECT id, is_num, title, body FROM documents WHERE id = ?"
  );
  const selAll = db.prepare(
    "SELECT id, is_num, title, body FROM documents ORDER BY rowid"
  );

  let closed = false;

  const assertOpen = (): void => {
    if (closed) throw new Error("FTS5 store is closed");
  };

  const insert = (doc: ThaiSearchDoc): void => {
    if (doc == null || doc.id === null || doc.id === undefined) {
      throw new TypeError("FTS5 store add() requires a document with an id");
    }
    const id = String(doc.id);
    const isNum = typeof doc.id === "number" ? 1 : 0;
    const title = String(doc.title ?? "");
    const body = String(doc.body ?? "");
    // Index-time transform chain (mirrors the core's documented pipeline):
    // segmentThai -> expand synonyms -> stopword filter (when enabled) ->
    // opt-in ASCII stem (when enabled) -> store the mark-aware payload strict,
    // and looseForm of THAT SAME payload on the loose channel, so query and
    // index sides always agree. buildIndexPayload wraps the first three steps
    // (byte-identical to the legacy path when stopwords is empty and stem is
    // off), and the whole chain is byte idempotent, so re-indexing an
    // already-indexed id is a fixed point.
    const strictTitle = buildIndexPayload(title, stopwords, stem);
    const strictBody = buildIndexPayload(body, stopwords, stem);
    delStrict.run(id);
    delLoose.run(id);
    upsertDoc.run(id, isNum, title, body);
    insStrict.run(id, strictTitle, strictBody);
    insLoose.run(id, looseForm(strictTitle), looseForm(strictBody));
  };

  const removeRow = (id: string | number): void => {
    const key = String(id);
    delStrict.run(key);
    delLoose.run(key);
    delDoc.run(key);
  };

  const allRaws = (): DocRowRecord[] =>
    selAll.all() as unknown as DocRowRecord[];

  // A failing ROLLBACK must never replace the error that caused the rollback:
  // the caller needs the original insert/batch failure, not the cleanup one.
  const rollbackQuietly = (): void => {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Swallowed on purpose — the original error is rethrown by the caller.
    }
  };

  // Publish metadata after a successful mutation, but only when there is no
  // usable row yet. A "fresh" store records the config as "created"; a legacy
  // store adopts it as "attached-baseline" (still unverified for its prior
  // rows). "verified", "unknown-baseline" and "mismatch-ignored" already have a
  // row we must not silently overwrite.
  const publishMetaOnMutation = (): void => {
    if (metaStatus === "fresh") {
      publishMetaOnce(db, currentConfig, "created");
      metaStatus = "verified";
    } else if (metaStatus === "legacy-unverified") {
      publishMetaOnce(db, currentConfig, "attached-baseline");
    }
  };

  const store: Fts5Store = {
    type: "fts5",
    db,
    stopwords,
    stem,
    get metaStatus(): MetaStatus {
      return metaStatus;
    },
    get configFingerprint(): string {
      return currentFingerprint;
    },
    get configMismatch(): readonly ConfigCategory[] | null {
      return configMismatch;
    },
    add(doc: ThaiSearchDoc): void {
      assertOpen();
      db.exec("BEGIN");
      try {
        insert(doc);
        db.exec("COMMIT");
      } catch (e) {
        rollbackQuietly();
        throw e;
      }
      publishMetaOnMutation();
    },
    addMany(docs: Iterable<ThaiSearchDoc>): void {
      assertOpen();
      // One transaction for the whole batch: the BEGIN is deferred until the
      // first doc so an empty (or immediately throwing) iterable never touches
      // the database, and the iterator is consumed lazily so a generator of a
      // million docs does not have to be materialized first.
      let open = false;
      try {
        for (const doc of docs) {
          if (!open) {
            db.exec("BEGIN");
            open = true;
          }
          insert(doc);
        }
      } catch (e) {
        if (open) rollbackQuietly();
        throw e;
      }
      if (!open) return;
      try {
        db.exec("COMMIT");
      } catch (e) {
        rollbackQuietly();
        throw e;
      }
      publishMetaOnMutation();
    },
    remove(id: string | number): void {
      assertOpen();
      db.exec("BEGIN");
      try {
        removeRow(id);
        db.exec("COMMIT");
      } catch (e) {
        rollbackQuietly();
        throw e;
      }
    },
    update(doc: ThaiSearchDoc): void {
      store.add(doc);
    },
    rebuild(docs?: readonly ThaiSearchDoc[]): void {
      assertOpen();
      db.exec("BEGIN");
      try {
        if (docs) {
          db.exec("DELETE FROM fts5_strict");
          db.exec("DELETE FROM fts5_loose");
          db.exec("DELETE FROM documents");
          for (const d of docs) insert(d);
        } else {
          // Re-index from the raw shadow table without dropping it.
          db.exec("DELETE FROM fts5_strict");
          db.exec("DELETE FROM fts5_loose");
          for (const r of allRaws()) {
            insert({ id: decodeId(r), title: r.title, body: r.body });
          }
        }
        db.exec("COMMIT");
      } catch (e) {
        rollbackQuietly();
        throw e;
      }
      // Rebuild is the documented way to adopt a new config: publish (or adopt)
      // the metadata ONLY after the re-index committed, so a failed rebuild
      // leaves the previous usable index and its metadata untouched.
      publishMetaUpsert(db, currentConfig, "created");
      metaStatus = "verified";
      configMismatch = null;
    },
    close(): void {
      if (closed) return;
      closed = true;
      db.close();
    },
    get(id: string | number): Fts5DocRow | undefined {
      assertOpen();
      const row = selDoc.get(String(id)) as unknown as DocRowRecord | undefined;
      return row ? { id: decodeId(row), title: row.title, body: row.body } : undefined;
    },
    allRows(): Fts5DocRow[] {
      assertOpen();
      return allRaws().map((r) => ({ id: decodeId(r), title: r.title, body: r.body }));
    },
  };

  return store;
}
