# thai-fts — Design & Architecture

This document explains *why* `thai-fts` is shaped the way it is: the
two-sided problem of indexing unspaced, tone-significant Thai, the pipeline
that solves it, the seams that keep the library extensible, and the
zero-dependency constraint that governs every choice.

## 1. Problem

Thai script has two properties that generic Unicode search stacks get wrong:

1. **No inter-word spaces.** `ติดตั้งโปรแกรมใหม่` is a single unbroken run. A
   naive tokenizer either slices mid-word (destroying recall) or leaves the run
   as one giant "word" (destroying precision).
2. **Tone marks carry meaning.** `ติดตั้ง` (install) and `ติดตัง` (tone typo)
   differ by a single combining mark (`U+0E49 ้`). A search index that strips
   or ignores combining marks conflates them. Worse, SQLite's default FTS5
   tokenizer (`unicode61`) treats **Unicode category M** (all combining marks)
   as separators — so the marks themselves would split a word into consonant
   fragments and erase the difference anyway.

The solution is two-sided: **fix the index** (`segmentForIndex` + a mark-aware
tokenizer) and **fix the query** (`buildFtsMatch` ordered phrases). The loose
channel adds a deliberate, distance-free tone-tolerance fallback without
weakening the authoritative strict channel.

## 2. Segmentation

`wordTokens` / `segmentForIndex` drive index- and query-time word boundaries.

1. **`Intl.Segmenter` first** (`th` locale, word granularity). When available,
   it gives full-ICU, standards-grade word boundaries. Detected lazily and
   cached; `forceSegmenter`/`resetSegmenter` are `@internal` test hooks.
2. **Dictionary + syllable fallback** (`dictSegment`). On runtimes without
   `Intl.Segmenter` (small-icu), a curated deterministic longest-match
   dictionary (`THAI_DEFAULT_WORDS`, dev/tech domain) segments the run; unknown
   runs fall to a pseudo-syllable heuristic that never drops characters and
   always advances, so scanning terminates.
3. **Override merges** (`applyOverrideMerges`). A registered dictionary can pin
   a term — if the segmenter split a term across tokens, the tokens are re-joined
   into one (whole-token-aligned only, deterministic, idempotent).

**Invariant:** segmentation never drops characters. Re-tokenizing the joined
tokens is a byte fixed point (`segmentForIndex` is byte-idempotent).

## 3. Index-time pipeline (FTS5)

For each document field, the store applies the same transform chain on both
channels (`store.ts → insert`):

```
raw text
  → segmentForIndex()      # spaces between Thai words
  → expandIndexedText()    # append transliteration counterparts (whole-term)
  → strict channel rows    # mark-aware payload stored verbatim
  → loose channel rows     # looseForm() of that SAME payload
```

Two FTS5 virtual tables shadow the raw `documents` table (which powers
snippets, dedupe, and `rebuild`):

```sql
CREATE VIRTUAL TABLE fts5_strict USING fts5(
  id UNINDEXED, title, body,
  tokenize = "unicode61 categories 'L* N* Co M*'"
);
```

**Why `M*` matters:** `unicode61` by default treats category `M` (Thai
combining marks — vowels `U+0E31..U+0E3A` and tone marks `U+0E47..U+0E4E`) as
separators. Adding `M*` keeps marks **inside** tokens so the tone marks stay
significant — `ติดตั้ง` and `ติดตัง` are different tokens on this channel.
The `categories` directive *replaces* the default category list, so letters,
numbers and private use are restated (`L* N* Co M*`). `id` is `UNINDEXED` so
document ids never pollute the term index.

The loose table is the strict DDL with only the table renamed — the tokenizer
stays in lockstep forever. Its rows store `looseForm` of the strict payload;
`looseForm` strips **only** tone-level marks `\u0E48 \u0E49 \u0E4A \u0E4B \u0E4C \u0E4D`
(and lowercases), keeping all vowels intact. Both `expandIndexedText` and
`looseForm` are byte-idempotent, so re-indexing an id is a fixed point.

## 4. Query-time pipeline

`buildFtsMatch(query)` / `buildLooseFtsMatch(query)` mirror the index transform:

- a **Thai chunk** becomes an *ordered FTS5 phrase* of its words
  (`"ติด ตั้ง"`), never OR-expanded — a tone typo can't collide on strict;
- an **ASCII chunk** ORs its transliteration counterpart phrase(s) in
  (`deploy` also matches `"ดี พลอย"`), covered by `expandIndexedText` at index
  time and `expandChunkSynonyms` at query time;
- every chunk is quote-escaped via `quoteFtsToken` (FTS5 backslash/quote
  doubling) so adversarial input (`*`, `-`, `NEAR`, `drop table;--`, quotes)
  can never throw or inject — SQL-injection-safe **by construction**.

`buildLooseFtsMatch` runs every chunk through `looseForm` first, so `ติดตั้ง`
and `ติดตัง` collapse to the same loose phrase and match the de-accented loose
rows. Structured `buildSearchQuery` returns `{ mode, chunks, match, looseMatch }`
for future adapters.

**Short-query policy:** 1–2 character pure-Thai queries are unreliable as FTS
phrases, so `fts5Search` switches to a SQL `LIKE` scan (escaped) reported as
`meta.method: "like_fallback"` — never a silent empty result. The LIKE scan
reads the raw documents (not the de-accented loose channel), so a tone typo in
a 1–2-char query can't be rescued there — tone-typo rescue via the loose
channel applies to longer (3+ char) queries.

## 5. Strict-primary + loose fallback (dual-channel merge)

`fts5Search` implements the tiered retrieval contract with a deterministic,
order-stable merge:

1. Run the **strict** channel (`fts5_strict MATCH`), ordered by FTS5 rank.
2. **Only while strict is short of `limit`**, run the **loose** channel
   (`fts5_loose MATCH`), dedupe by id, append below.
3. A loose-only hit **never displaces** a strict hit: the strict window is
   honored first, and loose fills only the remaining slots.

Consequences:

- Searching `ติดตั้ง` matches only the correctly-toned doc on the strict
  channel; a tone-typo doc can surface *below* via loose.
- Searching `ติดตั้ง` when the strict result list already fills `limit`: loose is
  not consulted at all.
- `tone: "strict"` / `tone: "loose"` select a single channel; the default
  `"both"` is strict-first. `resolveToneMode` is the policy seam used by any
  adapter.

## 6. Dictionary registry seam

`registerThaiDictionary({ id, words?, synonyms?, overrides? })` wires three
providers through dependency inversion — `segment.ts` and `synonyms.ts` stay
pure and never import the registry:

- `setSegmentOverrideProvider` — forced compounds for the segmenter;
- `setSynonymProvider` — bi-directional TH↔EN synonym lookup;
- refresh is immediate: a registry write re-sets the provider identity, which
  invalidates the seams' caches.

Built-in dev/tech defaults (`THAI_DEFAULT_WORDS`, `THAI_DEFAULT_SYNONYMS`)
are always active underneath; registered dictionaries only add on top.

**Module instances & subpaths:** the build emits one bundle per subpath
(`thai-fts`, `thai-fts/core`, …), and each bundle is a separate module instance,
so the global registry is per-instance. Two correct usage patterns:

1. **Engine (recommended):** pass dictionaries to `createFts5Engine({ dictionaries:
   [...] })` / `openFts5Store` — self-contained, no global state.
2. **Pure core:** import `registerThaiDictionary` and all consuming functions
   from the same entry/subpath (all `"thai-fts"`, or all `"thai-fts/core"`) so
   they share one instance.

## 7. Engine adapter interface

`ThaiSearchEngine` is the minimal pluggable surface every backend implements:

```ts
interface ThaiSearchEngine {
  readonly type: string;                    // e.g. "fts5"
  add(doc: ThaiSearchDoc): void;            // idempotent, replace-by id
  remove(id: string | number): void;        // no-op when absent
  search(query: string, opts?): ThaiSearchResult[];  // ranked hits + snippet
  close(): void;                            // idempotent
}
```

`registerEngine(name, factory)` / `createEngine(name, opts?)` form a registry;
re-registration overwrites (test doubles / hot-swap). The reference `fts5`
adapter pre-registers itself. **Future adapters** plug in here without touching
callers: Meilisearch / Elasticsearch (REST mapping of the same four methods),
an in-memory JS index, and a vector/hybrid layer that chains embeddings onto
the same interface.

## 8. Zero runtime dependencies

- **Segmentation** → `Intl.Segmenter` (Node built-in), dict+syllable fallback.
- **FTS** → `node:sqlite` `DatabaseSync` + FTS5 (Node built-in, ≥ 22.13).
- **Tests** → `node:test` (dev). **Build** → `tsup` (dev-only, not shipped).

Nothing in `files` requires a runtime install step beyond `npm install
thai-fts`. The core modules import no Node built-ins at all, so they are
portable to any JS runtime that has `Intl.Segmenter`.

## 9. Package layout & dual-format build

Four import subpaths resolve to real bundles (each shares the same code via
`src/<sub>/index.ts` re-export modules):

| subpath | bundle entry | ships |
| --- | --- | --- |
| `thai-fts` | `src/index.ts` | everything + `createFts5Engine` |
| `thai-fts/core` | `src/core/index.ts` | pure core, no DB, no `node:sqlite` |
| `thai-fts/engine` | `src/engine/index.ts` | engine interface + registry |
| `thai-fts/fts5` | `src/fts5/index.ts` | `node:sqlite` adapter |

`tsup` emits ESM (`.js`) + CJS (`.cjs`) + types (`.d.ts`/`.d.cts`) for every
entry from `dist/`, with `node:sqlite` kept **external** and the `node:`
protocol preserved (`removeNodeProtocol: false` — esbuild's default would strip
the prefix and emit a broken bare `sqlite` import). The `exports` map points
each subpath at its own files with `import`/`require`/`types` conditions;
top-level `main`/`module`/`types` provide interop for legacy resolvers. The CLI
(`src/cli.ts`) is a separate entry so `bin.thai-fts` → `dist/cli.js` is
self-contained.

## 10. CLI design

`thai-fts` (bin) is pipe-friendly plain output with an mcp-compatible
`--json` `{ ok, data }` wrapper and `0`/`2` exit codes. Commands are
keyword-delimited and may be chained in one invocation; FTS5 commands share a
**single `createFts5Engine` per invocation** (created lazily, closed in
`finally`), which is what makes an end-to-end `:memory:` run possible — index
and search see the same in-memory database within one process. `index` is
silent on success (exit 0) and returns the stored id via `--json`; `search`
prints `id<TAB>rank` (+ `TAB snippet`) per hit and nothing at all on no hits.

## 11. CI & benchmarks

**CI** lives in `.github/workflows/ci.yml` (workflow name `CI`). It triggers on
`push` to every branch and on `pull_request` targeting `master`, with
`fail-fast: false` and a per-job `timeout-minutes: 15`. One job, `build`, runs on
`ubuntu-latest` across a Node matrix of `22.x`, `24.x`, `26.x`: checkout →
`setup-node` with `cache: npm` → `npm ci --no-audit --no-fund` → `npm run build`
→ `npm test` → `npx tsc --noEmit` → `npm pack --dry-run`. The workflow needs no
secrets and publishes nothing; the README badges point at this file's status on
`master`.

**Benchmarks** (`benchmark/run.mjs`, driven by `npm run benchmark` ≈ 40 s and
`npm run benchmark:quick` ≈ 3 s) measure three things against a seeded synthetic
corpus and write results into `benchmark/results/`:

- **Segmentation throughput** in MiB/s for both paths. On the full-mode corpus
  (2.41 MiB) `Intl.Segmenter` reaches ≈ 4.26 MiB/s while the dictionary + syllable
  fallback lands slightly *lower* at ≈ 3.03 MiB/s — the ICU path is the faster one
  here, so nothing may claim the fallback wins on speed. Quick mode (0.39 MiB)
  reads 4.29 vs 3.41 MiB/s.
- **Indexing throughput** in docs/s, reported separately for bulk `rebuild()` and
  per-doc `add()`. Full mode (3,000 documents of ≈ 840 bytes) gives ≈ 210 and
  ≈ 309 docs/s, and quick mode (500 documents) reads much higher — 1112 / 787
  docs/s. Indexing is dominated by the JS-side segment + synonym pipeline (and
  the FTS5 index writes it feeds), **not** by per-document SQLite transaction
  overhead: `benchmark/addmany-vs-add.mjs` indexes 20,000 seeded documents
  (16.35 MiB) both ways and collapses one-transaction-per-doc into a single
  batch transaction for only 73 → 77 docs/s (1.05×). The corpus-size effect
  (≈ 309 docs/s at 3,000 documents → ≈ 73 docs/s at 20,000) tracks per-doc
  payload work and index growth, not the transaction count.
- **Search latency** percentiles per channel. Full mode, 250 samples: strict
  p50 3.39 / p95 7.53 ms, loose 3.07 / 6.76 ms, prefix 3.35 / 7.47 ms,
  `like_fallback` 1.36 / 2.06 ms. Quick mode: strict 1.72 / 4.19, loose
  2.18 / 3.32, prefix 1.99 / 4.41, `like_fallback` 1.45 / 2.30 ms.

Absolute numbers are machine-dependent (CPU, storage, OS); only run-to-run
comparisons on one machine carry meaning.

**Bulk indexing** (`benchmark/addmany-vs-add.mjs`, node v26.12.1, win32,
20,000 seeded documents / 16.35 MiB, same corpus generator as `run.mjs`): the
per-doc `engine.add()` loop reaches ≈ 73 docs/s (272 s) and the
single-transaction `engine.addMany()` ≈ 77 docs/s (260 s) — a 1.05× speedup.
Batching removes the per-doc transaction overhead and is still worth taking on
hot indexing paths, but it is not the bottleneck; the JS segment + synonym
pipeline is.

Segmentation throughput against other Thai tools (reference points, not a
leaderboard):

| Segmenter | Throughput (MiB/s) | Runtime cost |
| --- | --- | --- |
| wordcut (native C++) | ≈ 0.32 | native binding |
| thai-fts — `Intl.Segmenter` path | ≈ 3.23 | zero-dependency |
| thai-fts — dictionary + syllable fallback | ≈ 1.82 | zero-dependency |
| Charabia (WASM) | ≈ 22 | WASM payload |

The thai-fts figures in this table come from a separate measurement session
and differ slightly from the `run.mjs` samples quoted above (≈ 4.26 / 3.03
MiB/s on this machine) — corpora and hardware differ; both samples keep the
same ordering and order of magnitude. Charabia's ≈ 22 MiB/s is a published
figure cited as an external reference. No ranking-quality claim is made
against any other Thai segmenter or search stack.

Positioning: thai-fts is **not** the fastest Thai segmenter — Charabia's WASM
path clearly wins raw segmentation. The trade is everything else in the box:
thai-fts is fast enough for full-text indexing, zero-dependency (no WASM, no
native bindings, no runtime npm deps), and ships full-text search with BM25
ranking plus tone-sensitive strict/loose dual-channel merging in one package —
none of the comparison tools offer that combination in-package.

CI does not run benchmarks; it keeps the build/test/typecheck/pack signal fast
and deterministic.
