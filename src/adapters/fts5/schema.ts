/**
 * Mark-aware FTS5 table definitions for the SQLite adapter. Single source of
 * truth for the two index channels; the store opens both tables from these
 * constants, so a tokenizer change here is automatically applied everywhere.
 *
 * Tokenizer choice: the default FTS5 `unicode61` tokenizer treats Unicode
 * category M (Thai combining marks — vowels/tone marks U+0E31..U+0E4E) as
 * separators, which would split a segmented Thai word such as "ติดตั้ง" into
 * consonant fragments and destroy tone sensitivity. Adding `M*` keeps marks
 * inside tokens, so a whole word becomes one token and tone marks stay
 * significant: "ติดตัง" does not match "ติดตั้ง" on this channel.
 *
 * The `categories` directive REPLACES the default category list, so letters,
 * numbers and private use must be restated (`L* N* Co`) alongside `M*`.
 *
 * `id` is UNINDEXED: it is stored as a regular column (usable in JOIN/WHERE,
 * and returned by queries) but never tokenized, so document ids do not pollute
 * the term index.
 *
 * ## Prefix indexes (opt-in, TASK-006)
 *
 * Passing `prefix` (an array of token-prefix lengths, e.g. `[2, 3]`) adds an
 * FTS5 `prefix='2 3'` option so trailing-`*` autocomplete queries are served
 * from the prefix index instead of a full scan. The exported constants are the
 * no-prefix defaults (backward compatible); use `buildStrictSchema` /
 * `buildLooseSchema` to bake prefix indexes into a store.
 */
/** Build the strict-channel DDL, optionally with FTS5 prefix indexes. */
export function buildStrictSchema(prefix?: readonly number[]): string {
  const p = (prefix ?? []).filter((n) => Number.isFinite(n) && n > 0);
  const clause = p.length > 0 ? `,\n  prefix = '${p.join(" ")}'` : "";
  return `CREATE VIRTUAL TABLE IF NOT EXISTS fts5_strict USING fts5(
  id UNINDEXED, title, body,
  tokenize = "unicode61 categories 'L* N* Co M*'"${clause}
);`;
}

/**
 * LOOSE fallback channel: identical columns and the SAME mark-aware tokenizer
 * as the strict channel, but rows store the de-accented `looseForm()`
 * (lexicographically, only tone marks stripped) of the strict payload — so a
 * tone-mark typo (ติดตัง) can still match a correctly-marked document
 * (ติดตั้ง), always ranked BELOW the strict channel. Derived from the strict
 * DDL by renaming only the table, keeping the tokenizer (and any prefix
 * indexes) in lockstep forever.
 */
export function buildLooseSchema(prefix?: readonly number[]): string {
  return buildStrictSchema(prefix).replace(
    "CREATE VIRTUAL TABLE IF NOT EXISTS fts5_strict USING fts5(",
    "CREATE VIRTUAL TABLE IF NOT EXISTS fts5_loose USING fts5("
  );
}

/** Default strict-channel schema (no prefix indexes). */
export const FTS5_STRICT_SCHEMA = buildStrictSchema();

/** Default loose-channel schema (no prefix indexes). */
export const FTS5_LOOSE_SCHEMA = buildLooseSchema();
