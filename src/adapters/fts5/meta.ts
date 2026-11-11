/**
 * Persisted index-metadata + deterministic fingerprinting for the SQLite FTS5
 * adapter (audit PATCH 2). The store writes a single-row `thai_fts_meta` record
 * the first time it successfully indexes, capturing only the settings that
 * affect the INDEXED representation (tokenizer/schema, prefix indexes,
 * stopwords, stemming, dictionaries, segmenter). Query-only options (`limit`,
 * `tone`, autocomplete `*` matching, ...) are deliberately excluded so that
 * changing them never trips a compatibility check.
 *
 * On reopen the store recomputes the current fingerprint and compares it to the
 * stored one. A mismatch raises {@link Fts5ConfigMismatchError} naming the
 * MISMATCH CATEGORY (not an opaque hash) rather than silently serving stale
 * results or rebuilding behind the user's back.
 */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ThaiDictionaryDef } from "../../core/types.js";
import { buildStrictSchema } from "./schema.js";
import type { SegmenterSupport } from "./capability.js";

/** Bumped whenever the fingerprint SCHEMA (the shape below) changes. Checked
 * before any field diff, so an old database is reported as a version mismatch
 * rather than a confusing per-field diff against a different meaning. */
export const CURRENT_META_VERSION = 1;

/** Table that stores the single metadata row. Name is stable. */
export const META_TABLE = "thai_fts_meta";
const META_KEY = "index";

/** The DDL that creates the metadata table (idempotent). It is run lazily —
 * only when metadata is actually written — so opening a legacy database never
 * creates it and thereby masks the legacy state. */
export const META_DDL = `CREATE TABLE IF NOT EXISTS ${META_TABLE} (
  key TEXT PRIMARY KEY,
  metaVersion INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  configJson TEXT NOT NULL,
  origin TEXT NOT NULL
)`;

/** Field-level identity of the fingerprint (and thus of the stored config). */
export interface IndexConfig {
  /** Normalized schema signature (tokenizer + column structure, prefix stripped). */
  schema: string;
  /** FTS5 prefix-index lengths, sorted + de-duplicated (order-insensitive). */
  prefix: number[];
  /** Effective stopword list, de-duplicated + sorted (order-insensitive). */
  stopwords: string[];
  /** Opt-in English Porter stemming. */
  stem: boolean;
  /** Declared dictionaries, in DECLARATION ORDER (order can change precedence). */
  dictionaries: DictionaryRef[];
  /** Which segmentation path the runtime exposes at open time. */
  segmenter: SegmenterSupport;
}

/** A single dictionary's stable identity. `id` is required by the registry;
 * `version` is optional; `hash` is a content digest that catches drift when no
 * `version` is bumped. */
export interface DictionaryRef {
  id: string;
  version?: string;
  hash: string;
}

/** Stored metadata as read back from disk. */
export interface StoredMeta {
  metaVersion: number;
  fingerprint: string;
  config: IndexConfig;
  origin: "created" | "attached-baseline";
}

/** Which category of an index-affecting setting drifted. */
export type ConfigCategory =
  | "meta-version"
  | "schema"
  | "prefix"
  | "stopwords"
  | "stem"
  | "dictionary"
  | "segmenter";

/** How confident the store is that its on-disk index matches the current
 * config. Never claims more than it can actually verify. */
export type MetaStatus =
  | "verified"
  | "unknown-baseline"
  | "legacy-unverified"
  | "fresh"
  | "mismatch-ignored";

/** Raised when a reopened database's stored config disagrees with the config
 * the store was just opened with. Names the categories, not just a hash. */
export class Fts5ConfigMismatchError extends Error {
  /** Categories that differ (empty only if the fingerprint somehow diverged
   * without a field diff — reported as a whole-config mismatch). */
  readonly categories: readonly ConfigCategory[];
  /** Fingerprint recorded in the database. */
  readonly expected: string;
  /** Fingerprint of the config just opened with. */
  readonly actual: string;
  /** Metadata version recorded in the database. */
  readonly metaVersion: number;

  constructor(
    categories: readonly ConfigCategory[],
    expected: string,
    actual: string,
    metaVersion: number,
  ) {
    const named = categories.length > 0 ? categories.join(", ") : "config";
    super(
      `thai-fts FTS5 index configuration mismatch (categories: ${named}). ` +
        `Stored fingerprint ${expected} vs current ${actual} (metaVersion ${metaVersion}). ` +
        `The on-disk index was NOT rebuilt. Reopen with a compatible configuration, ` +
        `or call rebuild() to re-index under the new settings.`,
    );
    this.name = "Fts5ConfigMismatchError";
    this.categories = Object.freeze([...categories]);
    this.expected = expected;
    this.actual = actual;
    this.metaVersion = metaVersion;
  }
}

/**
 * Canonical JSON: object keys are sorted (genuinely order-insensitive maps),
 * arrays keep their order (positional settings like dictionaries). This is the
 * single serialization used both to build the fingerprint and to persist the
 * config, so equivalence reduces to a byte comparison.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** SHA-256 hex digest of the canonical config. Deterministic across runs.
 * Normalizes the order-insensitive fields (prefix, stopwords) first, so callers
 * who hand in a reordered or duplicated list still get the same fingerprint —
 * equivalence is a property of the settings, not of how they were typed. */
export function computeFingerprint(config: IndexConfig): string {
  return createHash("sha256")
    .update(canonicalJson(normalizeConfig(config)), "utf8")
    .digest("hex");
}

/** Re-normalizes the order-insensitive parts of a config in place-equivalent
 * form, leaving positional fields (schema, dictionaries) untouched. */
function normalizeConfig(config: IndexConfig): IndexConfig {
  return {
    schema: config.schema,
    prefix: normalizePrefix(config.prefix),
    stopwords: normalizeStopwords(config.stopwords),
    stem: config.stem === true,
    dictionaries: config.dictionaries,
    segmenter: config.segmenter,
  };
}

/** Field-by-field diff of two configs, returning the categories that differ.
 * Used to name the problem in the error instead of dumping two hashes. The
 * order-insensitive fields are compared in normalized form, so a reordered or
 * duplicated list is correctly seen as equivalent (matching the fingerprint). */
export function diffCategories(stored: IndexConfig, current: IndexConfig): ConfigCategory[] {
  const out: ConfigCategory[] = [];
  if (stored.schema !== current.schema) out.push("schema");
  if (canonicalJson(normalizePrefix(stored.prefix)) !== canonicalJson(normalizePrefix(current.prefix))) {
    out.push("prefix");
  }
  if (
    canonicalJson(normalizeStopwords(stored.stopwords)) !==
    canonicalJson(normalizeStopwords(current.stopwords))
  ) {
    out.push("stopwords");
  }
  if (stored.stem !== current.stem) out.push("stem");
  if (canonicalJson(stored.dictionaries) !== canonicalJson(current.dictionaries)) {
    out.push("dictionary");
  }
  if (stored.segmenter !== current.segmenter) out.push("segmenter");
  return out;
}

/** Stable content digest for a dictionary definition, so a definition that
 * keeps its `id` but changes its words/synonyms/overrides is still detected. */
export function dictionaryHash(def: ThaiDictionaryDef): string {
  const shape = {
    words: [...(def.words ?? [])],
    synonyms: (def.synonyms ?? []).map((p) => [p[0], p[1]]),
    overrides: [...(def.overrides ?? [])],
  };
  return createHash("sha256").update(canonicalJson(shape), "utf8").digest("hex");
}

/** Snapshot the declared dictionaries into fingerprint refs, preserving order. */
export function dictionaryRefs(defs: readonly ThaiDictionaryDef[]): DictionaryRef[] {
  return defs.map((def) => {
    const ref: DictionaryRef = { id: def.id, hash: dictionaryHash(def) };
    const version = (def as { version?: unknown }).version;
    if (typeof version === "string" && version.trim()) ref.version = version.trim();
    return ref;
  });
}

/** Normalized prefix list: positive finite integers, de-duplicated, ascending. */
export function normalizePrefix(prefix?: readonly number[]): number[] {
  const seen = new Set<number>();
  for (const n of prefix ?? []) {
    if (Number.isFinite(n) && n > 0) seen.add(n);
  }
  return [...seen].sort((a, b) => a - b);
}

/** Normalized stopword list: de-duplicate (first occurrence wins), then sort by
 * lowercased value so a reordered list collapses to the same fingerprint. */
export function normalizeStopwords(stopwords: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of stopwords) {
    if (!seen.has(w)) {
      seen.add(w);
      out.push(w);
    }
  }
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Normalized schema signature: tokenizer + column structure, with any
 * `prefix='...'` clause removed (prefix is captured separately) and whitespace
 * collapsed so formatting never affects the fingerprint. */
export function schemaSignature(): string {
  return buildStrictSchema()
    .replace(/,\s*prefix\s*=\s*'[^']*'/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Current effective config for a given set of store options. */
export function buildIndexConfig(input: {
  prefix?: readonly number[];
  stopwords: readonly string[];
  stem: boolean;
  dictionaries?: readonly ThaiDictionaryDef[];
}): IndexConfig {
  return {
    schema: schemaSignature(),
    prefix: normalizePrefix(input.prefix),
    stopwords: normalizeStopwords(input.stopwords),
    stem: input.stem === true,
    dictionaries: dictionaryRefs(input.dictionaries ?? []),
    segmenter: typeof Intl.Segmenter === "function" ? "native" : "fallback",
  };
}

/** True when `name` is a real table in this database (right now). */
export function tableExists(db: DatabaseSync, name: string): boolean {
  const row = db
    .prepare("SELECT count(*) AS c FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { c?: number } | undefined;
  return !!row && Number(row.c) > 0;
}

/** Read the stored metadata row, or `undefined` when there is none (legacy DB,
 * brand-new DB, or an unreadable/corrupt record — all treated as "no metadata"). */
export function readMeta(db: DatabaseSync): StoredMeta | undefined {
  if (!tableExists(db, META_TABLE)) return undefined;
  const row = db
    .prepare(`SELECT metaVersion, fingerprint, configJson, origin FROM ${META_TABLE} WHERE key = ?`)
    .get(META_KEY) as
    | { metaVersion?: number; fingerprint?: string; configJson?: string; origin?: string }
    | undefined;
  if (!row) return undefined;
  let config: IndexConfig;
  try {
    config = JSON.parse(String(row.configJson)) as IndexConfig;
  } catch {
    return undefined;
  }
  return {
    metaVersion: Number(row.metaVersion),
    fingerprint: String(row.fingerprint),
    config,
    origin: row.origin === "attached-baseline" ? "attached-baseline" : "created",
  };
}

/** Write the metadata row ONLY if none exists yet (publish-once semantics used
 * by plain add/addMany). Never overwrites existing metadata. */
export function publishMetaOnce(
  db: DatabaseSync,
  config: IndexConfig,
  origin: "created" | "attached-baseline",
): void {
  db.exec(META_DDL);
  db.prepare(
    `INSERT OR IGNORE INTO ${META_TABLE}(key, metaVersion, fingerprint, configJson, origin)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(META_KEY, CURRENT_META_VERSION, computeFingerprint(config), canonicalJson(config), origin);
}

/** Force-write the metadata row to the current config (used by rebuild(), which
 * is the documented way to adopt a new config after a `mismatch-ignored` open). */
export function publishMetaUpsert(
  db: DatabaseSync,
  config: IndexConfig,
  origin: "created" | "attached-baseline",
): void {
  db.exec(META_DDL);
  db.prepare(
    `INSERT INTO ${META_TABLE}(key, metaVersion, fingerprint, configJson, origin)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       metaVersion = excluded.metaVersion,
       fingerprint = excluded.fingerprint,
       configJson = excluded.configJson,
       origin = excluded.origin`,
  ).run(META_KEY, CURRENT_META_VERSION, computeFingerprint(config), canonicalJson(config), origin);
}
