# thai-fts

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
| `thai-fts` (root) | everything below, plus `createFts5Engine` |
| `thai-fts/core` | pure lexical core (no DB) |
| `thai-fts/engine` | search-engine interface + registry |
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

**Dictionaries** (`dictionaries.ts`) — registry seam

- `THAI_DEFAULT_WORDS`, `THAI_DEFAULT_SYNONYMS` (dev/tech defaults, always active)
- `registerThaiDictionary({ id, words?, synonyms?, overrides? })`
- `listDictionaries()`, `clearRegisteredDictionaries()`

### Engine — `thai-fts/engine`

- `ThaiSearchEngine` — `{ add(doc), remove(id), search(query, opts?), close() }`
- `ThaiSearchDoc`, `ThaiSearchResult`, `ThaiEngineOptions`, `ThaiEngineFactory`
- `registerEngine(name, factory)`, `createEngine(name, opts?)`, `listEngines()`, `unregisterAllEngines()`

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

## Adapters roadmap

`ThaiSearchEngine` is a minimal pluggable contract; the registry is the seam for
future backends. Today: `fts5` (reference, `node:sqlite`). Planned next:

- **Meilisearch** / **Elasticsearch** — map `add`/`remove`/`search` over their REST APIs
- **In-memory** — a small JS index for tests and offline tooling
- **Vector / hybrid** — embeddings appended as a scoring layer, keeping the same interface

```js
import { registerEngine, createEngine } from "thai-fts";

registerEngine("meilisearch", (opts) => new MeiliEngine(opts));
const engine = createEngine("meilisearch", { host: "http://localhost:7700" });
```

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

## License

MIT — see [LICENSE](LICENSE).
