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
import { DatabaseSync } from "node:sqlite";
import { expandIndexedText } from "../../core/synonyms.js";
import { looseForm, segmentForIndex } from "../../core/segment.js";
import { applyStopwords, THAI_DEFAULT_STOPWORDS } from "../../core/stopwords.js";
import { registerThaiDictionary } from "../../core/dictionaries.js";
import type { ThaiDictionaryDef } from "../../core/types.js";
import type { ThaiSearchDoc } from "../engine.js";
import { buildLooseSchema, buildStrictSchema } from "./schema.js";

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
  /** Index (or re-index) a document on both channels; replaces any prior row
   * with the same id atomically. Uses registered Thai dictionaries if any. */
  add(doc: ThaiSearchDoc): void;
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
 * Open (or create) an FTS5 document store. File databases use WAL + NORMAL
 * synchronous for crash safety with low write latency; memory databases get
 * the same busy/foreign-key tuning without WAL (a no-op in-memory).
 */
export function openFts5Store(opts: OpenFts5StoreOptions = {}): Fts5Store {
  const isMemory = opts.memory === true || !opts.path || opts.path === ":memory:";
  const db = new DatabaseSync(isMemory ? ":memory:" : (opts.path as string));

  for (const pragma of DEFAULT_PRAGMAS) db.exec(pragma);
  if (!isMemory) db.exec("PRAGMA journal_mode = WAL");

  // Prefix indexes + stopword list are fixed at open time. Applying stopwords
  // changes the indexed payload, so documents must be re-indexed (rebuild) if
  // this option toggles on an existing on-disk database.
  const prefix = opts.prefix;
  const stopwords: readonly string[] =
    opts.stopwords === undefined || opts.stopwords === false
      ? []
      : opts.stopwords === true
        ? THAI_DEFAULT_STOPWORDS
        : [...opts.stopwords];

  db.exec(DOCUMENTS_DDL);
  db.exec(buildStrictSchema(prefix));
  db.exec(buildLooseSchema(prefix));

  for (const def of opts.dictionaries ?? []) {
    registerThaiDictionary(def);
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
    // segmentThai -> expand synonyms -> stopword filter (when enabled) -> store
    // the mark-aware payload strict, and looseForm of THAT SAME payload on the
    // loose channel, so query and index sides always agree. expandIndexedText,
    // applyStopwords and looseForm are byte idempotent, so re-indexing an
    // already-indexed id is a fixed point. When stopwords is empty (default)
    // applyStopwords returns the payload verbatim, keeping the pipeline
    // byte-identical to the no-stopword path.
    const strictTitle = applyStopwords(expandIndexedText(segmentForIndex(title)), stopwords);
    const strictBody = applyStopwords(expandIndexedText(segmentForIndex(body)), stopwords);
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

  const store: Fts5Store = {
    type: "fts5",
    db,
    stopwords,
    add(doc: ThaiSearchDoc): void {
      assertOpen();
      db.exec("BEGIN");
      try {
        insert(doc);
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    remove(id: string | number): void {
      assertOpen();
      db.exec("BEGIN");
      try {
        removeRow(id);
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
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
        db.exec("ROLLBACK");
        throw e;
      }
    },
    close(): void {
      if (closed) return;
      closed = true;
      db.close();
    },
    get(id: string | number): Fts5DocRow | undefined {
      const row = selDoc.get(String(id)) as unknown as DocRowRecord | undefined;
      return row ? { id: decodeId(row), title: row.title, body: row.body } : undefined;
    },
    allRows(): Fts5DocRow[] {
      return allRaws().map((r) => ({ id: decodeId(r), title: r.title, body: r.body }));
    },
  };

  return store;
}
