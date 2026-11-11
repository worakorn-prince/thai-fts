# Performance diagnosis — TASK-019 (audit PATCH 5)

Status: **measure-first diagnosis complete for quick + medium + full.** Full mode
(`--full`, N=20000, digest `40e7ab29`) numbers are below; no production code was changed.

Harness: `benchmark/perf/diagnose.mjs` (zero new dependencies). Raw JSON artifacts:
`benchmark/results/perf-<ISO>.json` (gitignored). Long runs are not wired into `npm test`
or CI.

```
node benchmark/perf/diagnose.mjs            # --quick, N=1000, ~40 s
node benchmark/perf/diagnose.mjs --medium   # N=3000, ~3 min
node benchmark/perf/diagnose.mjs --full     # N=20000, opt-in, ~46 min (file-store copy ≈30 min)
```

## Environment

| Field | Value |
| --- | --- |
| Node | v26.12.1 |
| Platform / arch | win32 / x64 |
| CPU | AMD Ryzen 7 2700U with Radeon Vega Mobile Gfx (8 logical) |
| Total RAM | 14.9 GiB |
| Package version | 0.1.0 |
| Git commit | 9b08fed |
| SQLite (`sqlite_version()`) | 3.54.0 |
| Segmenter source | `intl` (full ICU) |
| Store config | in-memory, `prefix: [2, 3]`, stopwords off, stem off |

## Methodology

### Dataset (deterministic, seeded; no `Math.random`, no `Date.now` in generation)

* Vocabulary: `wordTokens(POOL.join(" "))` from `benchmark/lib.mjs`, filtered to
  Thai-containing tokens, deduplicated, sorted, first **314** unique words (the pool
  produced fewer than the 500 cap).
* Documents: N seeded picks with a Zipf-like skew (weight `1/(i+1)^0.8`); title = 3
  seeded words. Length profile fixed by document index (`i % 10`): 40 % ≈300 chars,
  40 % ≈800 chars, 20 % ≈1600 chars. Because the profile period (10) divides the batch
  size (500), every batch has an identical length mix.
* Queries: 100 deduplicated queries — 50 one-word, 30 two-word, 15 three-word from the
  first 200 vocabulary words, plus 5 tone-marked vocabulary terms (0 synthetic fallbacks
  were needed). All queries returned 10/10 hits (`limit=10`) on every channel; no
  zero-hit calls.
* Reproducibility: the corpus digest is a FNV-1a hash over ids + title/body lengths +
  vocabulary size + the query list. Repeated runs of the same mode printed the same
  digest:
  * quick: `b47c6f71` (all three runs), N=1000, 1.93 MiB, dataset build 59 ms
  * medium: `8daeef9c` (all three runs), N=3000, 5.80 MiB, dataset build 107 ms

### Phases (kept separate, never mixed)

1. **Index build** — `addMany()` in 500-doc batches into a fresh in-memory store,
   per-batch timing. `PRAGMA page_count`/`page_size` before/after, and the index is
   verified with a real query before closing.
2. **Per-doc vs bulk** — `add()` once per doc vs `addMany()` in 500-doc batches over the
   *same* subset (`min(N, 3000)`) in fresh stores.
3. **Path split** — store-free timing of the same documents through
   `segmentForIndex` (segment-only) and
   `applyStopwords(expandIndexedText(segmentForIndex(...)))` + `looseForm` (the exact
   transform chain `store.insert()` runs), plus per-batch transform timing to separate
   JS drift from SQLite drift.
4. **Write probes (diagnostic only, production options unchanged)** — same batched
   workload under default 8 MiB page cache, 64 MiB page cache, prefix index off, and one
   transaction for the whole subset.
5. **Queries** — one discarded warm-up pass per channel, then 3 repetitions × 100
   queries for `strict`, `loose`, `both`, `limit=10`. p50/p95/p99 over 300 samples per
   channel, plus per-repetition p50 for stability.
6. **Index size** — in-memory `page_count × page_size` and the same corpus written to a
   temporary file store (deleted afterwards).
7. **Memory** — `process.memoryUsage()` at phase boundaries only.

### Limitations (read before quoting numbers)

* **Phase-boundary memory only.** Snapshots are taken at boundaries; they are not peak
  RSS. No "peak" claim is made anywhere.
* **Quick ≠ medium ≠ full.** Different N (and therefore different corpus size, cache
  pressure, and derived shares) — never compare across modes.
* **Stage split is derived by subtraction**, not a profiler. The JS transform and the
  SQLite call share the event loop and IPC, so the "estimated FTS5 write share" is an
  estimate. It is triangulated by the store-free per-batch transform trend, not claimed
  as a profile.
* Generated documents are space-separated word runs. Real prose gives `Intl.Segmenter`
  more work per character; the harness prints a natural-text reference
  (≈1.4–2.5 M chars/s) alongside the per-doc calls.
* Queries are all corpus-hit queries by construction; miss-path (`no hits`) cost is
  partly represented only through the `zero_hit_calls` field (0 here).
* Run-to-run variance is real and reported below (20–40 % on total build time between
  runs on this laptop-class CPU).
* **Full-mode wall time is dominated by the file-backed size measurement**: 1 776 s of
  the 2 770 s total. The in-memory build itself was 390 s. Do not read `total 2769.6s`
  as indexing throughput.

## Raw numbers — index build

Quick, N=1000 (`perf-2026-11-11T19-09-55-475Z.json`):

| Metric | Value |
| --- | --- |
| Corpus | 1.93 MiB, digest `b47c6f71` |
| Total build (500-doc batches) | **3 026 ms → 330.4 docs/s** |
| Batch 1 / batch 2 | 382.1 / 291.1 docs/s |
| Per-doc `add()` (1 000 docs) | 326.8 docs/s (3 060 ms) |
| `addMany()` same subset | 332.8 docs/s (3 005 ms) |
| Batching speedup | **1.02×** |
| In-memory pages after build | 2 676 × 4 096 B = 10 960 896 B |

Medium, N=3000 (`perf-2026-11-11T19-06-46-180Z.json`):

| Metric | Value |
| --- | --- |
| Corpus | 5.80 MiB, digest `8daeef9c` |
| Total build (500-doc batches) | **16 959 ms → 176.9 docs/s** |
| Batches 1–6 | 360.2 · 255.2 · 214.7 · 158.0 · 116.1 · 131.2 docs/s |
| Per-doc `add()` (3 000 docs) | 203.0 docs/s (14 778 ms) |
| `addMany()` same subset | 212.3 docs/s (14 131 ms) |
| Batching speedup | **1.05×** |
| In-memory pages after build | 7 951 × 4 096 B = 32 567 296 B |

Repeat runs (same code, same digests):

| Mode | Run | Total build | Throughput |
| --- | --- | --- | --- |
| quick | 18:59:44 | 3.12 s | 320.2 docs/s |
| quick | 19:02:55 | 3.09 s | 323.9 docs/s |
| quick | 19:09:55 | 3.03 s | 330.4 docs/s |
| medium | 19:00:15 | 14.74 s | 203.6 docs/s |
| medium | 19:03:35 | 14.80 s | 202.7 docs/s |
| medium | 19:06:46 | 16.96 s | 176.9 docs/s |

Full, N=20000 (`perf-2026-11-11T19-12-49-902Z.json`):

| Metric | Value |
| --- | --- |
| Corpus | 38.66 MiB, digest `40e7ab29` |
| Total build (500-doc batches) | **390.03 s → 51.3 docs/s** |
| Batch 1 → batch 40 | 345.4 → 27.4 docs/s (**12.6× decline**) |
| Per-doc `add()` (3 000-doc subset) | 202.8 docs/s |
| `addMany()` same subset | 214.7 docs/s (**1.06×**) |
| In-memory pages after build | 52 827 × 4 096 B = 216 379 392 B |
| Store-free full transform (20 000 docs) | 26 409.9 ms → 757.3 docs/s, flat 0.93× first→last batch |
| Derived SQLite write share | **93.2 %** (390 030 − 26 410 = 363 620 ms) |

Full, N=20000: **complete** (46 min wall time; 29.6 min of that is the file-backed
size copy — see Index size). The decline continues far beyond the 1K→3K trend: from
345 docs/s in the first batch to 27 docs/s in the last, while the store-free transform
stays flat at ~757 docs/s. That rules out the JS pipeline and points at FTS5 write
maintenance growing superlinearly with index size.

## Raw numbers — path split

| Metric | Quick (N=1000) | Medium (N=3000) | Full (N=20000) |
| --- | --- | --- | --- |
| `segmentForIndex` only, mean | 1 246.9 ms | 3 550.2 ms | 23 649.1 ms |
| Full JS transform (segment + synonyms + stopwords + loose), mean | 1 378.3 ms | 4 038.4 ms | 26 409.9 ms |
| Derived SQLite write share | 54.5 % (1 648 ms) | **76.2 % (12 921 ms)** | **93.2 % (363 620 ms)** |
| Derived JS share | 45.5 % | 23.8 % | 6.8 % |
| Transform throughput, batch 1 → last | 731.1 → 724.4 docs/s (1.01×) | 755.3 → 749.5 docs/s (1.01×) | 757.3 docs/s overall (0.93×) |
| Natural-text segmentation reference | 2.02 M chars/s | 2.07 M chars/s | 2.35 M chars/s |

The store-free transform is **flat across batches and across N** (≈750 docs/s; 1.01×
quick/medium, 0.93× full), while the same batches slow down 2.6–2.75× inside the store
at 1K–3K and **12.6×** at 20K. The degradation is therefore on the SQLite/FTS5 side,
and its share grows with corpus size (54.5 % → 76.2 % → 93.2 %).

## Raw numbers — write-path probes (same subset)

Medium, 3 000 docs:

| Probe | Throughput | vs baseline |
| --- | --- | --- |
| 500-doc batches, default 8 MiB cache | 212.8 docs/s | — |
| 500-doc batches, 64 MiB cache | 215.7 docs/s | +1.4 % |
| 500-doc batches, prefix index off | 226.6 docs/s | +6.4 % |
| One transaction for all 3 000 docs | 211.5 docs/s | −0.6 % |

Quick, 1 000 docs: 342.9 / 354.8 (+3.5 %) / 396.1 (+15.5 %) / 363.8 (+6.1 %).
The prefix-index and transaction effects are small and inconsistent between sizes; the
page-cache probe shows the decline is not cache thrash.

## Raw numbers — queries (warm-up discarded)

Quick, 300 samples per channel:

| Channel | p50 | p95 | p99 | mean | min / max | hits |
| --- | --- | --- | --- | --- | --- | --- |
| strict | 1.816 ms | 3.278 ms | 3.882 ms | 1.954 ms | 0.675 / 4.909 ms | 10 / 10 |
| loose | 1.906 ms | 3.562 ms | 4.830 ms | 2.059 ms | 0.641 / 5.093 ms | 10 / 10 |
| both | 1.879 ms | 3.589 ms | 4.530 ms | 2.065 ms | 0.886 / 7.210 ms | 10 / 10 |

Medium, 300 samples per channel:

| Channel | p50 | p95 | p99 | mean | min / max | hits |
| --- | --- | --- | --- | --- | --- | --- |
| strict | 2.730 ms | 6.383 ms | 9.322 ms | 3.135 ms | 0.680 / 10.333 ms | 10 / 10 |
| loose | 2.860 ms | 6.128 ms | 7.547 ms | 3.158 ms | 0.783 / 9.431 ms | 10 / 10 |
| both | 2.855 ms | 6.435 ms | 7.704 ms | 3.139 ms | 0.663 / 7.908 ms | 10 / 10 |

Per-repetition p50 stability (medium, last run): strict 2.87 / 2.80 / 2.70 ms,
loose 2.90 / 2.95 / 2.73 ms, both 2.62 / 2.80 / 2.95 ms. Across the three medium runs
the strict p50 was 2.94 / 3.17 / 2.73 ms. No warm-up contamination (warm-up is a
separate discarded pass) and no channel degrades faster than the others.

Full, N=20000, 300 samples per channel:

| Channel | p50 | p95 | p99 | mean | min / max | hits |
| --- | --- | --- | --- | --- | --- | --- |
| strict | 13.783 ms | 33.759 ms | 39.563 ms | 14.668 ms | 0.680 / 52.175 ms | 10 / 10 |
| loose | 13.460 ms | 33.433 ms | 39.057 ms | 14.392 ms | 0.649 / 42.414 ms | 10 / 10 |
| both | 13.677 ms | 32.609 ms | 40.583 ms | 14.465 ms | 0.606 / 41.076 ms | 10 / 10 |

Per-repetition strict p50: 13.924 / 13.908 / 13.650 ms — stable. P50 grows ≈5× from
3K→20K (6.7× more documents), i.e. close to linear, with p99 ≈ 39–41 ms. No channel is
an outlier; there is no query hot spot to attack before the write path is addressed.

## Index size

| Metric | Quick (N=1000) | Medium (N=3000) | Full (N=20000) |
| --- | --- | --- | --- |
| Corpus bytes | 2 027 012 (1.93 MiB) | 6 080 913 (5.80 MiB) | 40 537 834 (38.66 MiB) |
| In-memory `page_count × page_size` | 10 960 896 B (10.45 MiB) | 32 567 296 B (31.05 MiB) | 216 379 392 B (206.36 MiB) |
| File store size after close | 10 960 896 B (10.45 MiB) | 32 567 296 B (31.06 MiB) | 216 387 584 B (206.36 MiB) |
| Bytes per document | 10 961 B | 10 853 B | 10 819 B |
| Index / text ratio | ≈5.4× | ≈5.4× | ≈5.34× |
| File-store build time (same corpus) | — | — | **1 776 119 ms (29.6 min)** |

Size is linear in N (≈10.8 KB/doc) and dominated by the stored structure (two FTS5
channels + the `documents` shadow copy). **The file-backed build of the 20K corpus
took 1 776 s — 4.55× the in-memory build (390 s) and 29.6 min of the 46-min full run.**
That penalty comes from disk journal/sync work, not from indexing logic, and the harness
does not attempt to reduce it. The harness deletes the temporary database afterwards.

## Memory (phase boundaries, NOT peak)

| Snapshot | Quick | Medium | Full |
| --- | --- | --- | --- |
| RSS after dataset | 50.18 MiB | 58.34 MiB | 131.09 MiB |
| RSS after index build | 78.73 MiB | 128.82 MiB | 351.12 MiB |
| RSS after query phase (store closed) | 111.30 MiB | 117.89 MiB | 229.39 MiB |
| heapUsed after build | 9.94 MiB | 18.85 MiB | 50.56 MiB |
| ΔRSS dataset → build | +28.55 MiB | +70.48 MiB | +220.03 MiB |

The post-query RSS includes retained JIT/heap the process does not return; it is not a
leak signal and not a peak. No true peak-RSS instrumentation is included.

## Verdict

**OPTIMIZE: NO** — no safe library-code optimization is justified by these
measurements. The full run does confirm a real, size-dependent bottleneck; it is on the
SQLite/FTS5 write side, not in the library's own pipeline, and the safe levers were
measured to be neutral:

1. **The JS side is flat and becomes negligible at scale.** The store-free transform
   holds at ≈750 docs/s (1.01× quick/medium, 0.93× full first→last) and drops from
   45.5 % (1K) to 23.8 % (3K) to **6.8 %** (20K) of build time. There is no
   segment/synonym hot spot to fix.
2. **The reproducible slowdown is FTS5 write maintenance, and it is superlinear.**
   In-memory build throughput falls 12.6× from the first to the last 500-doc batch at
   20K (345 → 27 docs/s), while the same transform stays flat. At 3K the decline is
   2.75×; at 1K 1.3×. Controlled probes at 3K show it is not page-cache pressure
   (+1.4 % at 64 MiB), not transaction granularity (one big transaction −0.6 %), and
   only partly the opt-in prefix index (+6.4 % medium / +15.5 % quick, inconsistent).
   The measured residual is FTS5 index growth/segment maintenance, not our JS.
3. **File-backed stores pay a large disk-sync penalty on top.** The same 20K corpus
   took **1 776 s (29.6 min) file-backed vs 390 s in-memory — 4.55× slower** — i.e.
   most of the 46-minute full run. Any fix there (e.g. `synchronous`/`journal_mode`
   trade-offs) would weaken durability and must be explicit opt-in API, not a silent
   patch; that is a product decision outside a diagnosis-driven micro-optimization.
4. **Batching is already close to neutral in-memory** (1.02× quick, 1.05–1.06×
   medium/full), so there is no large win hiding in transaction sizing; the earlier
   20K result (≈73 vs 77 docs/s) told the same story.
5. **Query latency is predictable and stable**: p50 1.8–1.9 ms at 1K, 2.7–3.2 ms at 3K,
   13.7–14.0 ms at 20K (≈linear with N), p99 3.9–9.3 ms quick/medium and 39–41 ms at
   20K; per-repetition p50 spread is small. There is no query hot spot to attack.

Per the contract, no optimization patch is proposed. Changing the harness config
(prefix index, cache, transaction size) produced no consistent win on the same workload,
so a change would be speculative.

What would justify reopening this: a profiler trace isolating a specific FTS5 stage, a
user-reported SLA breach at a concrete workload, or a decision to expose durability
knobs (`synchronous`, `journal_mode`) as documented opt-in options with measured
trade-offs and unchanged defaults. A full 20K run has now been done: the growth is
superlinear, so any future work should target the write path (or document the
file-backed cost) rather than segmentation.

## Files

* `benchmark/perf/diagnose.mjs` — harness (quick default, `--medium`, `--full`)
* `benchmark/results/perf-<ISO>.json` — raw artifacts from the runs quoted above
* `docs/perf_diagnosis.md` — this report
