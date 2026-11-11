#!/usr/bin/env node
/**
 * thai-fts benchmark harness (TASK-011a).
 *
 * Measures three things against the built `dist/` bundle only (never `src/`),
 * mirroring how `test/*.test.mjs` imports the package:
 *
 *  1. Segmentation throughput (MiB/s) — the `Intl.Segmenter` path vs the
 *     built-in dictionary fallback. The fallback is forced with
 *     `forceSegmenter(null)`; `setThaiSegmenter(null)` is NOT equivalent (it
 *     restores auto-detection, i.e. `Intl.Segmenter` again — see segment.ts).
 *  2. Index throughput (docs/s) — per-document `store.add()` (one transaction
 *     per doc) vs bulk `store.rebuild(docs)` (a single transaction).
 *  3. Search latency (p50/p95/mean, ms) — strict / loose / prefix channels,
 *     plus the real `like_fallback` path (1–2 Thai-char query, validated by
 *     checking `meta.method === "like_fallback"` on the returned hits).
 *
 * The corpus is deterministic: fixed Thai paragraphs copied verbatim from
 * `README.th.md`, combined by a seeded PRNG so every run on the same build
 * produces byte-identical documents. The corpus and its seed helpers live in
 * `benchmark/lib.mjs`, shared with `benchmark/addmany-vs-add.mjs`.
 *
 * Modes: --quick (N=500) | --full (N=3000, default). Override doc count with
 * `--n=<int>` or THAI_FTS_BENCH_N. Results land in benchmark/results/*.json.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Corpus + seed helpers (POOL / SEED / PREFIX_INDEX / buildDocs / corpusBytes /
// segBuffer), shared with benchmark/addmany-vs-add.mjs. Importing lib.mjs has
// no side effects — it defines data and pure functions only.
import {
  POOL,
  SEED,
  PREFIX_INDEX,
  mulberry32,
  buildDocs,
  corpusBytes,
  segBuffer,
} from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const DIST = join(ROOT, "dist", "index.js");

if (!existsSync(DIST)) {
  console.error("thai-fts benchmark: dist/index.js not found — run `npm run build` first.");
  process.exit(1);
}

// Single bundle on purpose: dist/core + dist/fts5 each bundle their own copy
// of core, so importing both would give two independent module instances and
// forceSegmenter() would not reach the store's indexing path.
const {
  openFts5Store,
  fts5Search,
  forceSegmenter,
  resetSegmenter,
  getThaiSegmenterInfo,
  segmentForIndex,
  THAI_DEFAULT_WORDS,
} = await import(pathToFileURL(DIST).href);

// --- helpers --------------------------------------------------------------

const percentile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((x, y) => x + y, 0) / samples.length;
  return {
    p50_ms: +percentile(sorted, 0.5).toFixed(3),
    p95_ms: +percentile(sorted, 0.95).toFixed(3),
    mean_ms: +mean.toFixed(3),
    min_ms: +sorted[0].toFixed(3),
    max_ms: +sorted[sorted.length - 1].toFixed(3),
  };
}

// Mirrors search.ts's Thai-character counting (marks fold into their base),
// so the derived like_fallback query really does trip that path.
const THAI_MARK_RE = /[\u0E31\u0E34-\u0E3A\u0E47-\u0E4E]/;
function thaiCharCount(s) {
  let count = 0;
  let prevThai = false;
  for (const ch of s) {
    if (ch < "\u0E00" || ch > "\u0E7F") {
      prevThai = false;
      continue;
    }
    if (prevThai && THAI_MARK_RE.test(ch)) continue;
    count += 1;
    prevThai = true;
  }
  return count;
}

/** Multi-word Thai phrases sliced out of the corpus so every query hits. */
function buildQueries(docs, count) {
  const rnd = mulberry32(SEED + 5);
  const out = [];
  for (let i = 0; i < count; i++) {
    const d = docs[Math.floor(rnd() * docs.length)];
    const words = d.body.split(/\s+/).filter((w) => /[\u0E00-\u0E7F]/.test(w));
    if (words.length < 2) continue;
    const at = Math.floor(rnd() * (words.length - 1));
    out.push(`${words[at]} ${words[at + 1]}`);
  }
  return [...new Set(out)];
}

/**
 * Find a real 1–2 Thai-char query that reports `meta.method ===
 * "like_fallback"` and returns hits — never a placeholder.
 */
function findLikeFallbackQuery(store, docs) {
  const haystack = docs.map((d) => `${d.title}\n${d.body}`).join("\n");
  const cands = [...new Set(THAI_DEFAULT_WORDS)]
    .filter((w) => /^[\u0E00-\u0E7F\s]+$/.test(w) && thaiCharCount(w) > 0 && thaiCharCount(w) <= 2)
    .sort();
  for (const w of cands) {
    if (!haystack.includes(w)) continue;
    const hits = fts5Search(store, w, { limit: 10 });
    if (hits.length && hits[0].meta?.method === "like_fallback") {
      return { query: w, hits: hits.length, candidates: cands.length };
    }
  }
  throw new Error("no dictionary word triggered the like_fallback path");
}

// --- measurements ---------------------------------------------------------

function measureSegmentation(bytes, iters) {
  const buf = segBuffer(bytes);
  const target = Buffer.byteLength(buf, "utf8");
  const runs = {};
  for (const mode of ["intl", "dict"]) {
    if (mode === "dict") forceSegmenter(null);
    else resetSegmenter();
    const source = getThaiSegmenterInfo().source;
    segmentForIndex(buf);
    const t = performance.now();
    for (let i = 0; i < iters; i++) segmentForIndex(buf);
    const ms = (performance.now() - t) / iters;
    runs[mode] = {
      segmenter_source: source,
      mib_per_sec: +(target / (ms / 1000) / (1024 * 1024)).toFixed(2),
      ms_per_pass: +ms.toFixed(1),
    };
  }
  resetSegmenter();
  return { buffer_kib: +(target / 1024).toFixed(1), iterations: iters, ...runs };
}

function openStore() {
  return openFts5Store({ memory: true, prefix: PREFIX_INDEX });
}

function measureBulk(docs) {
  const store = openStore();
  try {
    const t = performance.now();
    store.rebuild(docs);
    const ms = performance.now() - t;
    return { ms: +ms.toFixed(0), docs_per_sec: +(docs.length / (ms / 1000)).toFixed(0) };
  } finally {
    store.close();
  }
}

function measurePerDoc(docs) {
  const store = openStore();
  try {
    const t = performance.now();
    for (const d of docs) store.add(d);
    const ms = performance.now() - t;
    return { ms: +ms.toFixed(0), docs_per_sec: +(docs.length / (ms / 1000)).toFixed(0) };
  } finally {
    store.close();
  }
}

function measureSearch(store, queries, opts, samples, warmup) {
  for (let i = 0; i < warmup; i++) fts5Search(store, queries[i % queries.length], opts);
  const lat = [];
  let hitsMin = Infinity;
  for (let i = 0; i < samples; i++) {
    const q = queries[i % queries.length];
    const t = performance.now();
    const res = fts5Search(store, q, opts);
    lat.push(performance.now() - t);
    hitsMin = Math.min(hitsMin, res.length);
  }
  return { ...stats(lat), hits_min: hitsMin === Infinity ? 0 : hitsMin };
}

// --- reporting ------------------------------------------------------------

function pad(s, w) {
  s = String(s);
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

function table(rows, headers) {
  const widths = headers.map((h, i) =>
    Math.max(String(h).length, ...rows.map((r) => String(r[i]).length))
  );
  const line = (cells) => "  " + cells.map((c, i) => pad(c, widths[i])).join("  ");
  const sep = "  " + widths.map((w) => "-".repeat(w)).join("  ");
  return [line(headers), sep, ...rows.map(line)].join("\n");
}

function parseArgs(argv) {
  const args = { mode: "full", n: null, help: false };
  for (const a of argv) {
    if (a === "--quick") args.mode = "quick";
    else if (a === "--full") args.mode = "full";
    else if (a.startsWith("--n=")) args.n = Number(a.slice(4));
    else if (a === "--help" || a === "-h") args.help = true;
    else if (!a.startsWith("-")) args.mode = a === "quick" ? "quick" : "full";
  }
  const envN = Number(process.env.THAI_FTS_BENCH_N);
  if (Number.isFinite(envN) && envN > 0) args.n = envN;
  if (process.env.THAI_FTS_BENCH_MODE === "quick") args.mode = "quick";
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      [
        "thai-fts benchmark",
        "  --quick          N=500 docs, fewer samples (~<15s)",
        "  --full           N=3000 docs (default, ~<60s)",
        "  --n=<int>        override document count",
        "  env THAI_FTS_BENCH_N / THAI_FTS_BENCH_MODE also work",
      ].join("\n")
    );
    return;
  }

  const quick = args.mode === "quick";
  const n = Number.isFinite(args.n) && args.n > 0 ? Math.trunc(args.n) : quick ? 500 : 3000;
  const segBytes = quick ? 256 * 1024 : 1024 * 1024;
  const segIters = quick ? 2 : 3;
  const samples = quick ? 60 : 250;
  const warmup = quick ? 15 : 40;

  const t0 = performance.now();
  const docs = buildDocs(n);
  const bytes = corpusBytes(docs);

  console.log(`\nthai-fts benchmark  mode=${args.mode}  docs=${n}  corpus=${(bytes / 1048576).toFixed(2)} MiB`);
  console.log(`node=${process.version}  platform=${process.platform}  segmenter=${getThaiSegmenterInfo().source}\n`);

  const seg = measureSegmentation(segBytes, segIters);
  console.log(
    table(
      [
        ["Intl.Segmenter", seg.intl.segmenter_source, seg.intl.mib_per_sec, seg.intl.ms_per_pass],
        ["dictionary fallback", seg.dict.segmenter_source, seg.dict.mib_per_sec, seg.dict.ms_per_pass],
      ],
      ["segmentation path", "source", "MiB/s", "ms/pass"]
    )
  );

  const bulk = measureBulk(docs);
  console.log(`\nindexing (bulk rebuild)   ${bulk.docs_per_sec} docs/s  (${bulk.ms} ms)`);
  const perDoc = measurePerDoc(docs);
  console.log(`indexing (per-doc add)    ${perDoc.docs_per_sec} docs/s  (${perDoc.ms} ms)`);

  const store = openStore();
  store.rebuild(docs);
  const queries = buildQueries(docs, 8);
  const like = findLikeFallbackQuery(store, docs);
  console.log(`\nqueries=${queries.length}  like_fallback query="${like.query}" hits=${like.hits}\n`);

  const sets = {
    strict: { opts: { tone: "strict", limit: 10 }, label: "strict" },
    loose: { opts: { tone: "loose", limit: 10 }, label: "loose" },
    prefix: { opts: { tone: "strict", limit: 10, prefix: true }, label: "prefix" },
    like_fallback: { opts: { tone: "both", limit: 10 }, label: "like_fallback", queries: [like.query] },
  };
  const search = {};
  for (const [key, cfg] of Object.entries(sets)) {
    const qs = cfg.queries ?? queries;
    search[key] = { label: cfg.label, queries: qs.length, ...measureSearch(store, qs, cfg.opts, samples, warmup) };
  }
  store.close();

  console.log(
    table(
      Object.entries(search).map(([k, s]) => [k, s.queries, samples, s.p50_ms, s.p95_ms, s.mean_ms, s.hits_min]),
      ["search set", "queries", "samples", "p50 ms", "p95 ms", "mean ms", "min hits"]
    )
  );

  const total_s = +((performance.now() - t0) / 1000).toFixed(1);
  console.log(`\ntotal ${total_s}s`);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(ROOT, "benchmark", "results");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `bench-${stamp}-${args.mode}.json`);
  writeFileSync(
    file,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        node: process.version,
        platform: process.platform,
        mode: args.mode,
        config: {
          docs: n,
          corpus_bytes: bytes,
          seed: SEED,
          prefix_index: PREFIX_INDEX,
          seg_buffer_kib: seg.buffer_kib,
          seg_iterations: seg.iterations,
          search_samples: samples,
          search_warmup: warmup,
        },
        segmentation: {
          buffer_kib: seg.buffer_kib,
          iterations: seg.iterations,
          intl: seg.intl,
          dict: seg.dict,
        },
        indexing: { bulk_rebuild: bulk, per_doc_add: perDoc },
        search: { like_fallback_query: like.query, sets: search },
        total_s,
      },
      null,
      2
    )
  );
  console.log(`wrote ${file.replace(ROOT + "\\", "")}`);
}

await main();
