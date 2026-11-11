# Changelog

All notable changes to **thai-fts** are documented here. The format is based
on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **In-memory adapter** (`thai-fts/engine`) — `createMemoryEngine`, a
  zero-dependency `ThaiSearchEngine` (`type: "memory"`, registered as
  `"memory"`) for tests/offline/small data; mirrors the fts5 reference
  semantics (strict-then-loose merge, dedupe by id, `clampLimit`,
  caller-owned `filter` hook, verified offsets).
- **Meilisearch / Elasticsearch reference adapters** —
  `createMeilisearchEngine` / `createElasticsearchEngine` (also re-exported at
  the package root), minimal fetch-based `HttpSearchEngine`s (async
  `add`/`remove`/`search`, static `apiKey` header only, strict+loose
  two-channel preserved server-side via two docs / two token fields, merged
  strict-then-loose client-side). **Offsets are NOT supported**; no snippets.
  Registered as `"meilisearch"` / `"elasticsearch"`. Tested hermetically
  against a fake `node:http` server.
- **Opt-in Porter stemming** — `stemEn(word)` in `thai-fts/core` (classic
  Porter stemmer, ASCII-only, idempotent) plus a symmetric `stem` option on
  the fts5 and memory adapters (index + query side alike). **OPT-IN,
  index-changing → rebuild required, default off.**
- **Multi-occurrence offsets** — with `offsets: true`, fts5 and memory hits
  now carry up to 3 verified `occurrences: [{ quote, start, end }]` (document
  order, each `raw.slice(start, end) === quote`; first = primary offset).
- **Legal / literary seed lists** — `THAI_LEGAL_WORDS`,
  `THAI_LITERARY_WORDS` (and `THAI_DEFAULT_WORDS` / `THAI_DEFAULT_SYNONYMS`
  merged with the domain seeds).
- **Segmenter bridge example** — `examples/segmenter-bridge.mjs` (HTTP bridge
  to a local PyThaiNLP service + sync dict stub + restore).
- **Bulk indexing** — `addMany(docs)`, an optional engine method (fts5 +
  memory) for all-or-nothing bulk indexing with rollback on failure (fts5:
  a single transaction; memory: snapshot rollback); feature-detect with
  `typeof engine.addMany === "function"`, otherwise fall back to `add()`.
- **`allTerms: true`** — opt-in AND-join across whitespace-delimited chunks;
  synonym expansions stay parenthesized (`(a OR b) AND c`) because FTS5
  precedence is `NOT > AND > OR`; the default OR-join is unchanged.
- **`meta.truncated`** — hits carry `meta.truncated: true` when a query exceeds
  `MAX_QUERY_CHUNKS` (8) and gets truncated, omitted when false; also surfaced
  by the Meilisearch / Elasticsearch adapters.
- **`BuiltQuery.truncated`** — the exported `BuiltQuery` now carries
  `truncated: boolean` (additive field) next to `match` / `looseMatch`.
- **`ThaiAsyncEngine` + async registry** — the registry now records which kind
  owns a name: `registerAsyncEngine` / `createAsyncEngine` /
  `listAsyncEngines` / `isAsyncEngine` alongside the sync
  `registerEngine` / `createEngine`. Calling the wrong creator throws an error
  naming the right one instead of returning a Promise typed as an engine.
- **`addMany()` on Meilisearch / Elasticsearch** — accepts
  `Iterable | AsyncIterable`; an empty batch sends no request. Meilisearch
  sends one atomic `POST /indexes/{index}/documents` array; Elasticsearch
  sends one `POST /_bulk` NDJSON that is **not** atomic — successful items
  stay indexed, and the thrown error names the failed ids.
- **`searchWithMeta()` + `ThaiSearchOutcome`** — returns `{ hits, truncated }`
  so a query capped at the 8-chunk analyzer limit is visible even when it
  produced zero hits; implemented by fts5, memory, Meilisearch and
  Elasticsearch (optional method, feature-detect like `addMany`).
- **Typed `ThaiSearchMeta`** — `ThaiSearchResult.meta` is now the shared
  `ThaiSearchMeta` (`method`, `channel`, `truncated?: true`) intersected with
  `Record<string, unknown>`, so the common diagnostics are typed while
  adapter-specific keys remain allowed.
- **Runtime capability check** (`thai-fts/fts5`) — `checkSqliteSupport()` returns
  `{ ok, runtime, sqliteVersion?, segmenter, missing, guidance? }` by probing the
  built-in `node:sqlite` module, its `DatabaseSync` export and a real FTS5
  create + Thai `MATCH` round-trip on a throwaway `:memory:` database (always
  closed). `openFts5Store()` / `createFts5Engine()` now resolve `node:sqlite`
  lazily at open time instead of at import, so `thai-fts` and `thai-fts/core`
  still load on a runtime without it; opening a store there throws the new
  `SqliteSupportError` (`.runtime`, `.missing`) naming the fix in the package's
  `engines` range (`>= 22.13.0`). No version constraints changed.
- **Persisted index metadata + reopen compatibility check** (`thai-fts/fts5`) —
  the store records a single-row `thai_fts_meta` (`metaVersion` 1) the first time
  it indexes, holding a deterministic fingerprint of the index-affecting settings
  (schema/prefix/stopwords/stem/dictionaries/segmenter) and re-verifies it on
  reopen. A drifted config throws the typed `Fts5ConfigMismatchError` naming the
  MISMATCH CATEGORY rather than silently serving stale results or rebuilding;
  `onConfigMismatch: "throw" | "ignore"` (default `"throw"`) chooses the policy,
  with `"ignore"` opening anyway and reporting `metaStatus: "mismatch-ignored"`.
  Additive surface: `metaStatus` / `configFingerprint` / `configMismatch` store
  getters plus `computeFingerprint` / `canonicalJson` / `CURRENT_META_VERSION`.
  Legacy databases (no metadata) always open and report `legacy-unverified`.

### Fixed

- **Engine defaults merged by defined keys only** — an explicit `undefined`
  in per-search options (e.g. `{ allTerms: undefined }`) is treated as "not
  given", so it no longer clobbers an engine-level default such as
  `createFts5Engine({ allTerms: true })`; fts5 now mirrors the memory
  adapter's resolution.
- **Rollback no longer masks the original error** — a failed `ROLLBACK` in the
  fts5 store is swallowed, so the caller always sees the insert/batch failure
  that triggered it; `addMany` keeps its all-or-nothing contract.
- **One truncation source** — the 8-chunk cap is computed by the shared
  `planQueryChunks()` helper instead of two separate copies, so the fts5,
  memory, offset-align and HTTP paths cannot drift apart.
- **QA pass on the FTS5 adapter** — **BUG-1**: a query consisting only of
  stopwords no longer crashes `fts5Search` (empty-MATCH guard; an empty channel
  is skipped). **BUG-2**: `engine.search()` after `close()` now throws the same
  clear `"Search engine is closed"` error as `add`/`remove`. **BUG-3**:
  `store.get()` / `store.allRows()` after `close()` now throw a clear
  `"store is closed"` error instead of leaking
  `statement has been finalized`.
- **Loose-channel query chain order** — `buildLooseFtsMatch` applied
  `looseForm()` to a whole chunk *before* segmenting it, while loose index rows
  store `looseForm(segment(payload))` per token; an unspaced Thai query such as
  `ป้าไป` could therefore return zero loose hits while strict matched. The
  query side now segments the raw chunk first and de-accentuates each token,
  mirroring the index-side chain; `buildFtsMatch` (strict) is unchanged.

## [0.1.0] — 2026-11-11

Initial standalone release, extracted from the `thai-fts` work originally
developed inside `th-memory-mcp`.

### Added

- **Core** (`thai-fts/core`) — zero-dependency Thai lexical layer:
  - Word segmentation: `Intl.Segmenter` first, built-in dictionary + syllable
    fallback for small-icu runtimes, with override-merge support.
  - `wordTokens`, `segmentForIndex`, `segmentQueryChunk`, `hasThai`.
  - `looseForm` — tone-tolerant form stripping only tone-level marks
    (`่ ้ ๊ ๋ ์ ํ`), keeping vowels intact.
  - TH↔EN transliteration synonyms (`expandSynonyms`, `expandChunkSynonyms`,
    `expandIndexedText`) with built-in dev/tech defaults.
  - FTS query builders (`buildFtsMatch`, `buildLooseFtsMatch`,
    `buildSearchQuery`, `quoteFtsToken`) — injection-safe by construction.
  - Tone policy helper (`resolveToneMode`) and the dictionary registry seam
    (`registerThaiDictionary`, `listDictionaries`,
    `clearRegisteredDictionaries`).
- **Engine** (`thai-fts/engine`) — pluggable search-engine interface
  (`ThaiSearchEngine`) plus the registry (`registerEngine`, `createEngine`,
  `listEngines`, `unregisterAllEngines`) for future adapters.
- **FTS5** (`thai-fts/fts5`) — reference adapter on the Node built-in
  `node:sqlite`:
  - Mark-aware tokenizer (`unicode61 categories 'L* N* Co M*'`) so tone marks
    stay significant (ติดตั้ง ≠ ติดตัง).
  - Dual-channel store: strict + loose tables over a raw `documents` shadow
    table, with `add`/`remove`/`update`/`rebuild`/`get`/`allRows`.
  - Dual-channel search (`fts5Search`) with strict-primary + loose-fallback
    merge, LIKE fallback for 1–2 char pure-Thai queries, and a caller-owned
    `filter` hook.
  - `createFts5Engine` factory (also re-exported at the package root).
- **CLI** — `thai-fts` binary: `segment`, `loose`, `synonyms`, `check`,
  plus FTS5-backed `index` / `search` (one engine per invocation, `:memory:`
  supported end-to-end), pipe-friendly plain output, `--json` `{ ok, data }`
  wrapping, and `0`/`2` exit codes.
- **Packaging** — dual ESM + CJS via `tsup`, type declarations, four import
  subpaths (`.`, `./core`, `./engine`, `./fts5`), Node ≥ 22.13 requirement,
  zero runtime dependencies.
- **Docs** — English readme, Thai readme (`README.th.md`), this changelog,
  a security policy, and a design/architecture document (`docs/design.md`).
