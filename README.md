# thai-fts

[![CI](https://img.shields.io/github/actions/workflow/status/worakorn-prince/thai-fts/ci.yml?branch=master&label=CI)](https://github.com/worakorn-prince/thai-fts/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2022.13-brightgreen)](package.json)

**Tone-aware Thai full-text search for Node.js — zero runtime dependencies.**

`thai-fts` solves two problems that trip up generic search stacks on Thai:

1. **Thai is written without spaces between words.** `Intl.Segmenter` (full ICU)
   is used first for word segmentation, with a built-in dictionary + syllable
   heuristic as a small-icu fallback — so a document is indexed as
   space-delimited words, and a query is turned into an ordered phrase of its
   words.
2. **Tone marks are semantically significant.** `ติดตั้ง` (install) is *not* the
   same as `ติดตัง` (tone typo). The strict channel keeps tone marks significant;
   an optional loose channel strips only `่ ้ ๊ ๋ ์ ํ` and rescues tone typos
   **below** strict hits, never displacing them.

Everything runs on Node built-ins — `Intl.Segmenter` and `node:sqlite`
(FTS5). No native modules, no WASM, no npm runtime dependencies.

```text
docs, code, and tone examples:  ติดตั้ง ≠ ติดตัง  (strict)
                                "ติดตั้ง" loose → "ติดตัง" (fallback)
```

## Features

- ✂️ Thai word segmentation (`Intl.Segmenter` first, dict + syllable fallback)
- 🎵 Tone-handling policy: **strict-primary** with an optional **loose** rescue channel
- 🔎 FTS5 index + query via the Node built-in `node:sqlite`, mark-aware tokenizer
- 🔁 TH↔EN transliteration synonyms (`deploy` ↔ `ดีพลอย`)
- 📚 Dictionary registry seam (add words / synonyms / overrides at runtime)
- 🔌 Pluggable engine interface + registry (`registerEngine` / `createEngine`)
- 📦 Dual ESM + CJS, type declarations, no runtime dependencies, Node ≥ 22.13.0

## Install

```sh
npm install thai-fts
# Node 22.13+ required (node:sqlite)
```

## Quickstart

### Full-text search (SQLite FTS5, memory-backed)

```js
import { createFts5Engine } from "thai-fts";

const engine = createFts5Engine({ memory: true });          // tone: "both"

engine.add({ id: "guide", title: "คู่มือติดตั้ง", body: "ขั้นตอนการติดตั้งโปรแกรม" });
engine.add({ id: "billing", title: "ติดตังค่าบริการ", body: "รายเดือน 49 บาท" });

engine.search("ติดตั้ง", { tone: "both" });
// [
//   { id: "guide",  rank: 1, snippet: "ขั้นตอนการติดตั้งโปรแกรม" },  // strict
//   { id: "billing", rank: 2, snippet: "ติดตังค่าบริการ" },         // loose rescue
// ]

engine.close();
```

The dual-channel contract (default `tone: "both"`):

- **strict channel** — mark-aware, exact: `ติดตัง` never collides with `ติดตั้ง`;
- **loose channel** — de-accented (`looseForm`): a tone typo can still surface a
  correctly-marked document, **always ranked below** strict hits and never when
  the strict result list is already full (`limit` saturated).

### Core only (no database)

```js
import { wordTokens, segmentForIndex, looseForm, hasThai, expandSynonyms } from "thai-fts/core";

wordTokens("ติดตั้งโปรแกรม");        // ["ติดตั้ง", "โปรแกรม", …] (Intl.Segmenter)
segmentForIndex("ติดตั้ง");          // " ติด ตั้ง "  space-delimited for an index
looseForm("ติดตั้ง");                // "ติดตัง"     tone marks stripped
hasThai("hello");                    // false
expandSynonyms("deploy");            // ["deploy", "ดีพลอย"]
```

## CLI

The `thai-fts` binary ships with the package. Pipe-friendly plain output,
`--json` wraps output as `{ ok, data }`, exit codes are `0` ok / `2` error.

```sh
thai-fts segment "ติดตั้งโปรแกรม"            # word tokens, one per line
thai-fts loose "ติดตั้ง"                    # -> ติดตัง
thai-fts synonyms deploy                   # -> ดีพลอย
thai-fts check "สวัสดี"                     # -> 1

# FTS5 commands share one engine per invocation, so :memory: works end-to-end:
thai-fts index "ต้องติดตั้งโปรแกรมใหม่" --id first \
           index "ติดตังค่าบริการ" --id second \
           search "ติดตั้ง" --db :memory:
# first	1	ต้องติดตั้งโปรแกรมใหม่
# second	2	ติดตังค่าบริการ

thai-fts search "ติดตั้ง" --tone strict --db db.sqlite   # strict channel only
thai-fts search "ติดตั้ง" --limit 5 --tone both --db db.sqlite
thai-fts --json search "ติดตั้ง" --db db.sqlite          # { ok: true, data: [...] }
```

Run `thai-fts --help` for the full command reference.

## API summary

| Subpath | Surface |
| --- | --- |
| `thai-fts` (root) | everything below, plus `createFts5Engine`, `createMemoryEngine`, `createMeilisearchEngine`, `createElasticsearchEngine` |
| `thai-fts/core` | pure lexical core (no DB) |
| `thai-fts/engine` | search-engine interface + registry + in-memory & reference HTTP adapters |
| `thai-fts/fts5` | `node:sqlite` FTS5 store / search / schemas |

### Core — `thai-fts/core`

**Segmentation** (`segment.ts`)

- `wordTokens(text)` → `string[]` — mixed Thai/English word tokens (lowercased)
- `segmentForIndex(text)` → `string` — Thai runs get spaces between words (idempotent)
- `segmentQueryChunk(chunk)` → `string[]` — words of one whitespace chunk
- `hasThai(text)` → `boolean`
- `looseForm(text)` → `string` — strips only tone-level marks `่ ้ ๊ ๋ ์ ํ`, keeps vowels
- `normalizeThaiInput(text)` → `string` — NFC composition + strips zero-width chars
  (`U+200B U+200C U+200D U+FEFF`), idempotent. Applied automatically at the start of
  every segmentation/query path so a hidden separator inside a Thai word can never
  split it — index and query stay symmetric.
- `setThaiSegmenter(segmenter)` — plug in an external Thai segmenter; `null` restores
  auto-detection. Throws `TypeError` on a malformed segmenter.
- `getThaiSegmenterInfo()` → `{ source: "intl" | "custom" | "dict" | "none", hasSegmenter }`

**Bridging an external segmenter** — any object implementing `Intl.Segmenter`'s shape
(a `.segment(text)` method returning an iterable of `{ segment, isWordLike? }`) can
replace the built-in splitter, e.g. a wasm attacut wrapper or a PyThaiNLP RPC bridge:

```js
import { setThaiSegmenter } from "thai-fts";
setThaiSegmenter({
  segment(text) {
    return wasmAttacut.segment(text); // [{ segment: "ติดตั้ง", isWordLike: true }, ...]
  },
});
// `null` restores Intl.Segmenter (or the dict + syllable fallback):
setThaiSegmenter(null);
```

A runnable worked example (HTTP bridge to a local **PyThaiNLP** service + a
synchronous dictionary stub + restore) lives in
[`examples/segmenter-bridge.mjs`](examples/segmenter-bridge.mjs) — not shipped
in the npm package, but a faithful starting point for an attacut-wasm or
PyThaiNLP integration: `node examples/segmenter-bridge.mjs`.

**Synonyms** (`synonyms.ts`) — TH↔EN transliteration/semantic synonyms

- `expandSynonyms(term)` → `string[]` — term + every known counterpart
- `expandChunkSynonyms(chunk)` → `string[]` — whole-chunk expansion (enquiry side)
- `expandIndexedText(segmented)` → `string` — append synonym forms to a FTS payload (idempotent)

**Query building** (`query.ts`) — adapter-agnostic MATCH expression builders

- `buildFtsMatch(query)` / `buildLooseFtsMatch(query)` → FTS5 MATCH expression
- `buildSearchQuery(query, mode?)` → `{ mode, chunks, match, looseMatch }`
- `quoteFtsToken(token)` → quote/escape-safe token (FTS5)

**Tone policy** (`tone.ts`)

- `resolveToneMode(opts?)` → `"both" | "strict" | "loose"` (default `both`)

**English stemming** (`stem.ts`)

- `stemEn(word)` → `string` — the classic Porter stemmer on ASCII words (Thai
  tokens pass through unchanged; idempotent). OPT-IN and symmetric: pass
  `stem: true` to a store/engine so BOTH the indexed payload and the query
  phrases are stemmed.

**Dictionaries** (`dictionaries.ts`) — registry seam

- `THAI_DEFAULT_WORDS`, `THAI_DEFAULT_SYNONYMS` (dev/tech defaults, always active)
- `registerThaiDictionary({ id, words?, synonyms?, overrides? })`
- `listDictionaries()`, `clearRegisteredDictionaries()`

### Engine — `thai-fts/engine`

- `ThaiSearchEngine` — `{ add(doc), remove(id), search(query, opts?), close() }`
- `ThaiSearchDoc`, `ThaiSearchResult`, `ThaiEngineOptions`, `ThaiEngineFactory`
- `registerEngine(name, factory)`, `createEngine(name, opts?)`, `listEngines()`, `unregisterAllEngines()`
- `createMemoryEngine(opts?)` → zero-dependency in-memory `ThaiSearchEngine` (tests / offline / small data), registered as `"memory"`
- `createMeilisearchEngine({ endpoint, index, apiKey?, ... })`, `createElasticsearchEngine({ endpoint, index, apiKey?, ... })` → minimal REFERENCE HTTP adapters (async `add`/`remove`/`search` — see `HttpSearchEngine`), registered as `"meilisearch"` / `"elasticsearch"`
- `HttpSearchEngine` — the async engine contract the HTTP adapters implement (`close()` stays sync)

### FTS5 — `thai-fts/fts5`

- `createFts5Engine({ path?, memory?, tone?, limit?, prefix?, stopwords? })` → `ThaiSearchEngine`
- `openFts5Store({ path?, memory?, prefix?, stopwords?, dictionaries? })` → `{ db, add, remove, update, rebuild, close, get, allRows }`
- `fts5Search(store, query, opts?)` → `ThaiSearchResult[]` (dual-channel, `filter` hook, `prefix`/`offsets`/`titleWeight`)
- `FTS5_STRICT_SCHEMA`, `FTS5_LOOSE_SCHEMA` — mark-aware DDL (`unicode61 categories 'L* N* Co M*'`)

#### Opt-in search features (all default off)

**Prefix / autocomplete** — open the store with a prefix index, then search with
`prefix: true` (the final token of each phrase gets an FTS5 trailing `*`):

```js
const store = openFts5Store({ memory: true, prefix: [2, 3] });
fts5Search(store, "ติดตั้งโ", { prefix: true }); // partial word matches
```

**Offsets** — `offsets: true` adds verified `quote` / `start` / `end` per hit in
RAW document coordinates (`raw.slice(start, end) === quote`; never guessed):

```js
const [hit] = fts5Search(store, "ติดตั้ง", { offsets: true });
// hit.quote === "ติดตั้ง", hit.start/hit.end are raw indices
```

**Title weighting** — `titleWeight: N` ranks by `titleRank * N + bodyRank`, so a
title match can outrank a body match:

```js
fts5Search(store, "ติดตั้ง", { titleWeight: 2 });
```

**Stopwords** — OPT-IN and symmetric: `stopwords: true` (or your own `string[]`)
removes function words on BOTH the index and the query side. Toggling it changes
the indexed payload, so an existing on-disk database must be rebuilt (`rebuild()`
or re-open the file):

```js
const engine = createFts5Engine({ memory: true, stopwords: true });
engine.add({ id: "x", body: "การติดตั้งโปรแกรม" });
engine.search("การติดตั้ง"); // matches — "การ" is dropped on both sides
```

**Multi-occurrence offsets** — with `offsets: true`, every hit also carries up
to 3 verified `occurrences: [{ quote, start, end }]` (document order, each
`raw.slice(start, end) === quote`); the first entry equals the primary
`quote`/`start`/`end`. Useful for literature/legal citing:

```js
const [hit] = fts5Search(store, "ติดตั้ง", { offsets: true });
// 3 occurrences in the doc → hit.occurrences.length === 3
```

**English stemming** — OPT-IN and symmetric: `stem: true` runs `stemEn` (classic
Porter, ASCII-only — Thai tokens are untouched) on the indexed payload AND the
query phrases, so `running` matches `run`. Toggling it changes the indexed
payload → an existing on-disk database must be rebuilt (or documents re-added
for memory/HTTP engines). Default off:

```js
const engine = createFts5Engine({ memory: true, stem: true });
engine.add({ id: "x", body: "we are running the tests" });
engine.search("run"); // matches — both sides stem to "run"
```

## Tone policy

Thai tone marks are meaningful (`ติดตั้ง` install ≠ `ติดตัง` typo). Default
behavior is **strict-primary, loose-assist**:

1. **strict** — the mark-aware index. Authoritative and exact.
2. **loose** (only while strict is short of `limit`) — `looseForm` of the *same*
   indexed payload, deduped by id, ranked after all strict hits.

`tone: "strict"` gives exact-only matching; `tone: "loose"` gives de-accented
matching only; `tone: "both"` (default) is the two-tier merge above. Short
(1–2 char) pure-Thai queries use a LIKE fallback instead of FTS phrases and
report `meta.method: "like_fallback"`.

Note: the 1–2 char LIKE fallback scans the raw documents (not the de-accented
channel), so a tone typo in a 1–2-char query can't be rescued there; tone-typo
rescue via the loose channel applies to longer (3+ char) queries.

## Dictionaries

Registration is additive on top of the built-in dev/tech defaults
(`ติดตั้ง`, `เซิร์ฟเวอร์`, `ฐานข้อมูล`, `deploy` ↔ `ดีพลอย`, …):

```js
import { registerThaiDictionary } from "thai-fts";

registerThaiDictionary({
  id: "my-app",
  words: ["ตากลม"],                                  // forced single token
  synonyms: [["display", "จอภาพ"]],                  // bi-directional
  overrides: [{ term: "โปรเจกต์", fixed: "โปรเจกต์" }],
});
```

**Module instances & subpaths:** each build subpath (`thai-fts`, `thai-fts/core`,
…) is its own module instance, so the global dictionary registry is per-instance.
For an engine, pass dictionaries to `createFts5Engine({ dictionaries: [...] })`
(or `openFts5Store`) — self-contained, no global state needed (recommended).
For pure core use, import `registerThaiDictionary` **and** every function that
consumes it (segmentation/synonyms) from the **same** entry/subpath (all from
`"thai-fts"`, or all from `"thai-fts/core"`), so they share one module instance.

**Domain seed lists** — three ready-to-use exports cover the curated vocabulary:

- `THAI_DEFAULT_WORDS` — the combined default (dev/tech + general + modest
  legal/literary subset, ~1.4k entries), always active underneath;
- `THAI_LEGAL_WORDS` — a curated legal-domain list (procedures, persons,
  instruments, enforcement);
- `THAI_LITERARY_WORDS` — a curated literary-domain list (genres, prosody,
  figures of speech).

For a legal or literary app, load just your domain on top of the defaults:

```js
import { registerThaiDictionary, THAI_LEGAL_WORDS } from "thai-fts";
registerThaiDictionary({ id: "legal", words: THAI_LEGAL_WORDS });
```

**Loading a domain word list from a file** — `loadThaiWordsFromText` splits a
free-form list (newlines/spaces), trims, and dedupes, so you can ship a plain
word file per domain (legal, literary, …):

```js
import { loadThaiWordsFromText, registerThaiDictionary } from "thai-fts";
import { readFile } from "node:fs/promises";

const words = loadThaiWordsFromText(await readFile("legal-words.txt", "utf8"));
registerThaiDictionary({ id: "legal-app", words });
```

Prefer `words` when a term should simply be kept as **one forced token** (the
most common case for compounds/names), and `overrides` only to **re-map** a
specific segmented term to a different fixed token (`{ term, fixed }`).
`THAI_DEFAULT_WORDS` (1,368 entries incl. legal/literary seeds) and
`THAI_DEFAULT_SYNONYMS` (38 pairs) are always active underneath.

## Adapters

`ThaiSearchEngine` is a minimal pluggable contract; the registry is the seam
for backends. Shipped today:

- **`fts5`** and **`memory`** — the fully-tested LOCAL engines: the FTS5
  reference adapter on `node:sqlite`, and the zero-dependency in-memory
  `ThaiSearchEngine` (tests, offline, small data). Synchronous API, verified
  offsets, full opt-in feature set.
- **`meilisearch`** and **`elasticsearch`** — minimal REFERENCE HTTP adapters:
  fetch-based (Node 18+, no SDK), **async** `add`/`remove`/`search`
  (`HttpSearchEngine`; `close()` stays sync), one static `apiKey` header
  (Meilisearch `Authorization: Bearer <key>`, Elasticsearch
  `Authorization: Basic base64(apiKey)`). The strict+loose two-channel is
  preserved SERVER-SIDE (two documents / two token fields) and merged
  strict-then-loose client-side. **Offsets are NOT supported** (no
  verified `quote`/`start`/`end`) and hits carry no snippet. Treat them as
  "works with a live server" starting points, not tuned integrations.

```js
import { createMeilisearchEngine, createElasticsearchEngine } from "thai-fts";

const meili = createMeilisearchEngine({ endpoint: "http://localhost:7700", index: "docs", apiKey: "key" });
await meili.add({ id: 1, title: "คู่มือ", body: "ติดตั้งโปรแกรม" });
await meili.search("ติดตั้ง"); // ThaiSearchResult[] (async)
meili.close();

const es = createElasticsearchEngine({ endpoint: "http://localhost:9200", index: "docs" });
// same surface: add / remove / search (async) / close
```

Still on the roadmap: **Vector / hybrid** — embeddings appended as a scoring
layer, keeping the same interface.

## Zero runtime dependencies

- Segmentation: `Intl.Segmenter` (built into Node full-icu), dict+syllable fallback
- FTS: `node:sqlite` `DatabaseSync` + FTS5 virtual tables (built into Node ≥ 22.5)
- Tests: `node:test`; build: `tsup` (dev-only)

## Development

```sh
npm install
npm run build      # tsup -> dist/ (ESM + CJS + d.ts) for 4 subpaths
npm test           # build + node --test (docs + CLI + core + FTS5)
npm run pack:check # npm pack --dry-run (only dist + docs + READMEs ship)
npx tsc --noEmit   # typecheck
```

## Benchmarks

```sh
npm run benchmark        # full suite — segmentation, indexing, search latency (~40 s)
npm run benchmark:quick  # fast subset — same shapes, smaller corpus / fewer iterations (~3 s)
```

Measured results are written to `benchmark/results/`. Numbers move with the
machine (CPU, storage, OS), so read them as **relative** signals — compare run
against run on the same machine — rather than as a guaranteed floor.

Single-machine sample (Node 26, one dev laptop, seeded corpus — a sample, not a
fleet average). Full mode segments a 2.41 MiB corpus and indexes 3,000 documents
of ≈ 840 bytes each, with 250 search samples; quick mode shrinks that to
0.39 MiB / 500 documents.

| Metric (full mode) | Measured | Notes |
| --- | --- | --- |
| Segmentation, `Intl.Segmenter` | ≈ 4.26 MiB/s (235 ms) | full-ICU word boundaries |
| Segmentation, dictionary + syllable fallback | ≈ 3.03 MiB/s (329.8 ms) | slightly **slower** on this corpus |
| Indexing, bulk `rebuild()` | ≈ 210 docs/s | dominated by SQLite FTS5 inserts |
| Indexing, per-doc `add()` | ≈ 309 docs/s | same bottleneck, plus per-call overhead |
| Search, `strict` | p50 3.39 / p95 7.53 ms | |
| Search, `loose` | p50 3.07 / p95 6.76 ms | |
| Search, `prefix` | p50 3.35 / p95 7.47 ms | |
| Search, `like_fallback` | p50 1.36 / p95 2.06 ms | cheapest path |

Quick mode, for comparison: segmentation 4.29 vs 3.41 MiB/s, indexing
1112 (`rebuild`) / 787 (`add`) docs/s, and search p50/p95 of 1.72/4.19 (strict),
2.18/3.32 (loose), 1.99/4.41 (prefix), 1.45/2.30 ms (`like_fallback`).

Two caveats worth stating plainly:

- **Indexing is not Thai-tokenization-bound.** It is bounded by SQLite FTS5
  inserts, so throughput tracks document size — docs/s scales *down* as documents
  get bigger, and quick mode's higher numbers reflect smaller/fewer documents,
  not a faster tokenizer.
- **Segmentation throughput is not a leaderboard entry.** We measured ≈ 4.3 MiB/s
  on this machine; Charabia publishes ~22 MiB/s for Thai segmentation as an
  external reference point. Different corpora and machines — and the figures here
  cover throughput and latency only: `thai-fts` makes **no ranking-quality claim**
  against any other Thai segmenter or search stack.

## License

MIT — see [LICENSE](LICENSE).
