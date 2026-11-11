# thai-fts

[![npm](https://img.shields.io/npm/v/thai-fts.svg)](https://www.npmjs.com/package/thai-fts)
[![npm downloads](https://img.shields.io/npm/dm/thai-fts.svg)](https://www.npmjs.com/package/thai-fts)
[![CI](https://img.shields.io/github/actions/workflow/status/worakorn-prince/thai-fts/ci.yml?branch=master&label=CI)](https://github.com/worakorn-prince/thai-fts/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2022.13-brightgreen)](package.json)
[![npm types](https://img.shields.io/npm/types/thai-fts.svg)](https://www.npmjs.com/package/thai-fts)
[![runtime deps: 0](https://img.shields.io/badge/runtime%20deps-0-brightgreen.svg)](package.json)
[![GitHub stars](https://img.shields.io/github/stars/worakorn-prince/thai-fts.svg)](https://github.com/worakorn-prince/thai-fts)

[English](README.md) · [ภาษาไทย](README.th.md)

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

- `ThaiSearchEngine` — `{ add(doc), remove(id), search(query, opts?), close() }`; bulk `addMany(docs)` and `searchWithMeta(query, opts?)` are optional on the interface (see below)
- `ThaiAsyncEngine` — the async twin (`add`/`remove`/`search` return Promises, `close()` stays sync) implemented by the HTTP adapters
- `ThaiSearchDoc`, `ThaiSearchResult`, `ThaiSearchMeta`, `ThaiSearchOutcome`, `ThaiEngineOptions`, `ThaiEngineFactory`, `ThaiAsyncEngineFactory`
- `registerEngine(name, factory)`, `createEngine(name, opts?)`, `listEngines()`, `unregisterAllEngines()` — sync registry
- `registerAsyncEngine(name, factory)`, `createAsyncEngine(name, opts?)`, `listAsyncEngines()`, `isAsyncEngine(engine)` — async registry (see [Sync and async engines](#sync-and-async-engines))
- `createMemoryEngine(opts?)` → zero-dependency in-memory `ThaiSearchEngine` (tests / offline / small data), registered as `"memory"`
- `createMeilisearchEngine({ endpoint, index, apiKey?, ... })`, `createElasticsearchEngine({ endpoint, index, apiKey?, ... })` → minimal REFERENCE HTTP adapters (async `add`/`remove`/`search` — see `ThaiAsyncEngine`), registered as `"meilisearch"` / `"elasticsearch"` via `registerAsyncEngine`
- `HttpSearchEngine` — alias of `ThaiAsyncEngine`, kept for existing imports

#### Bulk indexing — `addMany()` (optional)

`addMany(docs)` indexes many documents in **one backend request or one
transaction**, all-or-nothing wherever the backend can provide it. It exists on
BOTH engine kinds and is optional on both interfaces, so feature-detect it and
fall back to `add`:

```js
if (typeof engine.addMany === "function") await engine.addMany(docs);
else for (const doc of docs) await engine.add(doc);
```

- **`fts5` / `memory` (sync)** — one SQLite transaction (fts5) or a snapshot
  rollback (memory): if a document throws mid-batch the whole batch rolls back,
  so a failed load leaves the index exactly as it was. Takes any `Iterable`
  (fts5 consumes it lazily; memory materializes the batch eagerly so it can
  restore the snapshot).
- **`meilisearch` / `elasticsearch` (async)** — accepts `Iterable |
  AsyncIterable`; an empty batch sends **no** HTTP request. Meilisearch sends
  ONE `POST /indexes/{index}/documents` whose body is the JSON array of both
  tone-channel docs per logical document — Meilisearch applies a documents
  request atomically, so the batch lands whole or not at all. Elasticsearch
  sends ONE `POST /_bulk` NDJSON request, and that request is **NOT atomic**:
  successful items stay indexed, and the call throws an `Error` listing the
  failed ids. Replaying the batch is safe — ids are explicit, so re-indexing is
  idempotent.

Bulk indexing removes per-document transaction overhead, but on large corpora
that is not the bottleneck: 20,000 seeded documents index at ≈ 73 docs/s
per-doc vs ≈ 77 docs/s batched (1.05×) on this machine — take the win on hot
paths, don't expect an order of magnitude (see
[Benchmarks](#benchmarks)).

#### `searchWithMeta()` — the truncation signal

`searchWithMeta(query, opts?)` returns `{ hits, truncated }` — the same hits
`search()` would return plus a query-level flag. It is the only way to tell a
**capped query that matched nothing** (`{ hits: [], truncated: true }`) from a
genuinely empty result set. Like `addMany`, it is optional, so feature-detect:

```js
const { hits, truncated } = typeof engine.searchWithMeta === "function"
  ? await engine.searchWithMeta(query)
  : { hits: await engine.search(query), truncated: false };
```

Hits also carry a typed `meta` object — `ThaiSearchMeta`:
`method` (`"fts5"`, `"memory"`, `"like_fallback"`, adapter name, …),
`channel` (`"strict" | "loose"`), and `truncated?: true` (omitted when false),
plus any adapter-specific keys.

### FTS5 — `thai-fts/fts5`

- `createFts5Engine({ path?, memory?, tone?, limit?, prefix?, stopwords?, cacheSizeKib? })` → `ThaiSearchEngine`
- `openFts5Store({ path?, memory?, prefix?, stopwords?, dictionaries?, cacheSizeKib? })` → `{ db, add, remove, update, rebuild, close, get, allRows }`
- `fts5Search(store, query, opts?)` → `ThaiSearchResult[]` (dual-channel, `filter` hook, `prefix`/`offsets`/`titleWeight`)
- `FTS5_STRICT_SCHEMA`, `FTS5_LOOSE_SCHEMA` — mark-aware DDL (`unicode61 categories 'L* N* Co M*'`)
- `checkSqliteSupport()` → `{ ok, runtime, sqliteVersion?, segmenter, missing, guidance? }` — opt-in
  runtime capability probe (see [Checking runtime support](#checking-runtime-support))

#### Checking runtime support

The FTS5 adapter resolves `node:sqlite` where a store is opened, never at import
time, so `thai-fts/core` and `thai-fts/engine` keep working on a runtime without
the built-in module. Ask ahead of time with the capability probe — it opens a
throwaway `:memory:` database, creates an FTS5 table, runs a Thai `MATCH`, and
closes it again:

```js
import { checkSqliteSupport } from "thai-fts";

const support = checkSqliteSupport();
if (!support.ok) {
  // support.missing === ["node:sqlite"] | ["node:sqlite DatabaseSync"] | ["FTS5"]
  console.error(support.runtime, support.missing, support.guidance);
}
console.log(support.sqliteVersion); // e.g. "3.54.0"
```

`openFts5Store()` / `createFts5Engine()` on such a runtime raise
`SqliteSupportError` (`.runtime`, `.missing`) whose message names the detected
runtime, the missing capability and the fix — a Node.js release inside the
package's `engines` range (`>= 22.13.0`).

#### Reopening a database: configuration drift

When you reopen a file-backed FTS5 store, it compares the settings in use against
the fingerprint persisted at first indexing (`thai_fts_meta`). A change that
alters the indexed payload is reported by category — `schema` / `prefix` /
`stopwords` / `stem` / `dictionary` / `segmenter` — and by default raises
`Fts5ConfigMismatchError` instead of serving stale results. Pass
`onConfigMismatch: "ignore"` to open anyway (`metaStatus: "mismatch-ignored"`);
databases written before metadata existed always open as `legacy-unverified`.
Adopt the new settings deliberately with `rebuild()`, which republishes metadata
only after a successful re-index.

#### File-store page cache

File-backed stores open with a **64 MiB SQLite page-cache cap** by default
(`cacheSizeKib: 65536`). It is per-connection and lazily allocated, does not
change stored bytes, durability (WAL + `synchronous = NORMAL`) or search
results, and is **not** part of the config fingerprint — changing it never
triggers a rebuild. It removes the disk-bound penalty on batch indexing
(measured 2.2× at 3K docs / 2.9× at 10K docs on the same seeded corpus). Pass a
smaller value to bound memory, or `cacheSizeKib: 0` to keep SQLite's default;
memory stores ignore it. See [`docs/perf_diagnosis.md`](docs/perf_diagnosis.md).

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

**All terms (AND-join)** — OPT-IN: `allTerms: true` requires **every**
whitespace-delimited chunk of a multi-word query to be present, instead of the
default OR-join. A chunk that expands into several synonym phrases stays grouped
— `(a OR b) AND c` — because FTS5 precedence is `NOT > AND > OR`, so an
unparenthesized `a OR b AND c` would silently re-associate:

```js
engine.search("ติดตั้ง โปรแกรม", { allTerms: true }); // both chunks required
```

Default off keeps the OR-join output byte-identical, and a single-chunk query is
byte-identical too (no redundant parentheses). Set it per search as above, or as
an engine default (`createFts5Engine({ allTerms: true })`).

**Query truncation** — only the first 8 chunks of a query are used (the exported
`MAX_QUERY_CHUNKS` cap); the rest are dropped from every expression. When that
happens the hits carry `meta.truncated: true` (omitted when false), so a narrowed
query never reads as if it were complete. Use `searchWithMeta()` when you need
that signal even with zero hits.

### Sync and async engines

The registry holds two kinds of engine, and the kind belongs to the
registration, not to the name:

```js
import { createEngine, createAsyncEngine, isAsyncEngine, listAsyncEngines } from "thai-fts";

createEngine("fts5", { memory: true });        // sync: fts5, memory
createEngine("memory");
createAsyncEngine("meilisearch", { endpoint, index }); // async: meilisearch, elasticsearch
createAsyncEngine("elasticsearch", { endpoint, index });

listAsyncEngines();                            // ["elasticsearch", "meilisearch"]
```

- `createEngine(name)` builds a **sync** `ThaiSearchEngine` (`add`/`remove`/
  `search` return values directly). Registered sync names: `fts5`, `memory`.
- `createAsyncEngine(name)` builds a **`ThaiAsyncEngine`** whose `add`/`remove`/
  `search` return Promises (`close()` stays sync). Registered async names:
  `meilisearch`, `elasticsearch`.
- `isAsyncEngine(engine)` is the runtime discriminator for code that accepts
  either kind (e.g. a service that may hold a local or a remote index). It
  never calls `add`, so it cannot mutate an index.
- Calling the wrong creator is an error, not a half-usable engine:
  `createEngine("meilisearch")` throws a message naming
  `createAsyncEngine` (and `createAsyncEngine("fts5")` names `createEngine`).

Both kinds support the optional `addMany()` and `searchWithMeta()` methods
described above; the async half additionally accepts an `AsyncIterable`.

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
  (`ThaiAsyncEngine`, exported alias `HttpSearchEngine`; `close()` stays sync),
  one static `apiKey` header
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
- FTS: `node:sqlite` `DatabaseSync` + FTS5 virtual tables (built into Node ≥ 22.5),
  resolved lazily when a store opens — `checkSqliteSupport()` reports availability
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
node benchmark/addmany-vs-add.mjs --quick   # per-doc add() vs bulk addMany() — smoke (500 docs)
node benchmark/addmany-vs-add.mjs           # same harness at 20,000 docs (~9 min)
npm run benchmark:quality                   # retrieval quality (P@5 / R@20 / MRR@10 / nDCG@10)
npm run benchmark:perf                      # performance diagnosis — phased, p50/p95/p99 (~40 s)
```

Measured results are written to `benchmark/results/` (performance) and
`benchmark/quality/results/` (quality). Numbers move with the
machine (CPU, storage, OS), so read them as **relative** signals — compare run
against run on the same machine — rather than as a guaranteed floor.

Retrieval quality is scored against **SYNTHETIC** hand-authored Thai fixtures
(`benchmark/quality/`) — sealed corpus + 30 queries with per-query relevance
judgments, scored per tone variant (strict / loose / both) with explicit
denominators for fewer-than-k results and no-relevant queries. The scores
demonstrate is/regression behavior on these fixtures; they are **not** a
real-world accuracy claim. It runs as its own script, never as a CI gate.

Phase-separated performance numbers (index-build vs warm-up vs query, p50/p95/p99,
index size, phase-boundary memory) come from `npm run benchmark:perf`; the measured
diagnosis and verdict live in [`docs/perf_diagnosis.md`](docs/perf_diagnosis.md).

Single-machine sample (Node 26, one dev laptop, seeded corpus — a sample, not a
fleet average). Full mode segments a 2.41 MiB corpus and indexes 3,000 documents
of ≈ 840 bytes each, with 250 search samples; quick mode shrinks that to
0.39 MiB / 500 documents.

| Metric (full mode) | Measured | Notes |
| --- | --- | --- |
| Segmentation, `Intl.Segmenter` | ≈ 4.26 MiB/s (235 ms) | full-ICU word boundaries |
| Segmentation, dictionary + syllable fallback | ≈ 3.03 MiB/s (329.8 ms) | slightly **slower** on this corpus |
| Indexing, bulk `rebuild()` | ≈ 210 docs/s | JS segment + synonym pipeline + the FTS5 index writes it feeds |
| Indexing, per-doc `add()` | ≈ 309 docs/s | same work, plus per-call / per-transaction overhead |
| Search, `strict` | p50 3.39 / p95 7.53 ms | |
| Search, `loose` | p50 3.07 / p95 6.76 ms | |
| Search, `prefix` | p50 3.35 / p95 7.47 ms | |
| Search, `like_fallback` | p50 1.36 / p95 2.06 ms | cheapest path |

Quick mode, for comparison: segmentation 4.29 vs 3.41 MiB/s, indexing
1112 (`rebuild`) / 787 (`add`) docs/s, and search p50/p95 of 1.72/4.19 (strict),
2.18/3.32 (loose), 1.99/4.41 (prefix), 1.45/2.30 ms (`like_fallback`).

Two caveats worth stating plainly:

- **Indexing is not transaction-bound.** Collapsing one-transaction-per-doc into
  a single batch transaction (`benchmark/addmany-vs-add.mjs`: 20,000 seeded
  documents / 16.35 MiB) moves only ≈ 73 → ≈ 77 docs/s — a 1.05× speedup — so the
  cost sits in the JS-side segment + synonym pipeline and the FTS5 index writes it
  feeds. Throughput therefore tracks corpus size (≈ 309 docs/s at 3,000 documents,
  ≈ 73 docs/s at 20,000), and quick mode's higher numbers reflect smaller/fewer
  documents, not a faster tokenizer.
- **Segmentation throughput is not a leaderboard entry.** We measured ≈ 4.3 MiB/s
  on this machine; Charabia publishes ~22 MiB/s for Thai segmentation as an
  external reference point. Different corpora and machines — and the figures here
  cover throughput and latency only: `thai-fts` makes **no ranking-quality claim**
  against any other Thai segmenter or search stack.

## Comparing with other Thai tools

Reference points, not a leaderboard — different corpora, machines and measurement
sessions, and **no ranking-quality claim** is made against any other tool.

| Segmenter | Throughput (MiB/s) | Runtime cost |
| --- | --- | --- |
| wordcut (native C++) | ≈ 0.32 | native binding |
| thai-fts — `Intl.Segmenter` path | ≈ 3.23 | zero-dependency |
| thai-fts — dictionary + syllable fallback | ≈ 1.82 | zero-dependency |
| Charabia (WASM) | ≈ 22 | WASM payload |

Source pointer: the wordcut ≈ 0.32 MiB/s row comes from a segmenter-comparison
session that used this repo's `benchmark/run.mjs` harness shape; raw result
files live under `benchmark/results/` (`npm run benchmark` regenerates only the
thai-fts paths). The thai-fts rows come from a separate measurement session and
differ slightly from the `run.mjs` samples quoted above (≈ 4.26 / 3.03 MiB/s on
this machine) — corpora and hardware differ, and both samples keep the same
ordering. Charabia's figure is published externally (WASM path, ~22 MiB/s for
Thai segmentation).

So thai-fts is **not** the fastest Thai segmenter — Charabia's WASM path clearly
wins raw segmentation. The trade is everything else in the box: fast enough for
full-text indexing, zero runtime dependencies (no WASM, no native bindings), and
full-text search with BM25 ranking plus tone-sensitive strict/loose dual-channel
merging in one package — none of the comparison tools offer that combination
in-package.

## License

MIT — see [LICENSE](LICENSE).
