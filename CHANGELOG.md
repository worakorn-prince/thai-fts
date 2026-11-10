# Changelog

All notable changes to **thai-fts** are documented here. The format is based
on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
