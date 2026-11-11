#!/usr/bin/env node
/**
 * thai-fts performance diagnosis (TASK-019, audit PATCH 5).
 *
 * Measures the FTS5 store on a seeded, controlled corpus. Every phase is timed
 * separately (index build vs query), memory snapshots are taken at phase
 * boundaries only (NOT peak RSS), and quick/medium/full results are explicitly
 * not comparable to each other.
 *
 *   node benchmark/perf/diagnose.mjs             # --quick  (N=1000, default)
 *   node benchmark/perf/diagnose.mjs --medium    # N=3000
 *   node benchmark/perf/diagnose.mjs --full      # N=20000 (opt-in, ~10 min)
 *
 * Machine-readable output: benchmark/results/perf-<ISO>.json
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { POOL, PREFIX_INDEX, SEED, corpusBytes, mulberry32 } from "../lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const DIST = join(ROOT, "dist", "index.js");

if (!existsSync(DIST)) {
  console.error("thai-fts diagnosis: dist/index.js not found — run `npm run build` first.");
  process.exit(1);
}

const {
  applyStopwords,
  expandIndexedText,
  fts5Search,
  getThaiSegmenterInfo,
  looseForm,
  openFts5Store,
  segmentForIndex,
  version,
  wordTokens,
} = await import(pathToFileURL(DIST).href);

const TONE_MARK_RE = /[\u0E48-\u0E4B\u0E4C\u0E4D]/;
const BATCH = 500;
const QUERY_LIMIT = 10;
const QUERY_REPS = 3;
const PER_DOC_CAP = 3000;

// --- small helpers (mirrors benchmark/run.mjs; run.mjs self-executes) ------

const percentile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((x, y) => x + y, 0) / samples.length;
  const r3 = (x) => +x.toFixed(3);
  return {
    n: samples.length,
    p50_ms: r3(percentile(sorted, 0.5)),
    p95_ms: r3(percentile(sorted, 0.95)),
    p99_ms: r3(percentile(sorted, 0.99)),
    mean_ms: r3(mean),
    min_ms: r3(sorted[0]),
    max_ms: r3(sorted[sorted.length - 1]),
  };
}

const round = (x, d = 1) => +x.toFixed(d);

function memSnapshot() {
  const m = process.memoryUsage();
  return {
    rss_mib: round(m.rss / 1048576, 2),
    heap_used_mib: round(m.heapUsed / 1048576, 2),
    heap_total_mib: round(m.heapTotal / 1048576, 2),
    external_mib: round(m.external / 1048576, 2),
  };
}

function pragmaNumber(db, name) {
  const row = db.prepare(`PRAGMA ${name}`).get();
  return Number(row ? Object.values(row)[0] : 0);
}

function pageStats(db) {
  const pageCount = pragmaNumber(db, "page_count");
  const pageSize = pragmaNumber(db, "page_size");
  return { page_count: pageCount, page_size: pageSize, bytes: pageCount * pageSize };
}

function fnv1a(input) {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function gitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

// --- controlled deterministic dataset --------------------------------------

function buildVocabulary(limit = 500) {
  const seen = new Set();
  for (const raw of wordTokens(POOL.join(" "))) {
    const w = String(raw ?? "").trim();
    if (!w || !/[\u0E00-\u0E7F]/.test(w)) continue;
    seen.add(w);
  }
  return [...seen].sort().slice(0, limit);
}

/** Zipf-like sampler: weight 1/(i+1)^s over a fixed vocabulary order. */
function zipfSampler(rnd, n, s = 0.8) {
  const cum = new Float64Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += 1 / Math.pow(i + 1, s);
    cum[i] = acc;
  }
  const total = acc;
  return () => {
    const r = rnd() * total;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] < r) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
}

const LENGTH_PROFILE = [
  { share: 0.4, chars: 300 },
  { share: 0.4, chars: 800 },
  { share: 0.2, chars: 1600 },
];

function lengthTarget(i) {
  const bucket = i % 10;
  if (bucket < 4) return LENGTH_PROFILE[0].chars;
  if (bucket < 8) return LENGTH_PROFILE[1].chars;
  return LENGTH_PROFILE[2].chars;
}

function makeDocs(n, vocab) {
  const rnd = mulberry32(SEED + 101);
  const pick = zipfSampler(rnd, vocab.length);
  const docs = [];
  let bodyChars = 0;
  let titleChars = 0;
  for (let i = 0; i < n; i++) {
    const target = lengthTarget(i);
    const words = [];
    let len = 0;
    while (len < target) {
      const w = vocab[pick()];
      words.push(w);
      len += w.length + 1;
    }
    const body = words.join(" ");
    const title = [vocab[pick()], vocab[pick()], vocab[pick()]].join(" ");
    bodyChars += body.length;
    titleChars += title.length;
    docs.push({ id: i, title, body });
  }
  return { docs, bodyChars, titleChars };
}

function makeQueries(vocab) {
  const rnd = mulberry32(SEED + 202);
  const head = vocab.slice(0, Math.min(200, vocab.length));
  const pickHead = () => head[Math.floor(rnd() * head.length)];
  const toned = vocab.filter((w) => TONE_MARK_RE.test(w));
  const seen = new Set();
  const push = (q) => {
    const v = q.trim();
    if (!v || seen.has(v)) return false;
    seen.add(v);
    return true;
  };
  const queries = [];
  const addBucket = (label, count, make) => {
    let made = 0;
    let attempts = 0;
    while (made < count && attempts < count * 40) {
      attempts += 1;
      if (push(make())) made += 1;
    }
    queries.push({ label, count: made });
  };

  addBucket("one_word", 50, () => pickHead());
  addBucket("two_word", 30, () => `${pickHead()} ${pickHead()}`);
  addBucket("three_word", 15, () => `${pickHead()} ${pickHead()} ${pickHead()}`);
  let toneSynthetic = 0;
  addBucket("tone_marked", 5, () => {
    if (toned.length) return toned[Math.floor(rnd() * toned.length)];
    toneSynthetic += 1;
    return pickHead() + "\u0E49";
  });

  return {
    queries,
    distribution: {
      one_word: 50,
      two_word: 30,
      three_word: 15,
      tone_marked: 5,
      actual_total: queries.length,
      tone_marked_vocab_available: toned.length,
      tone_marked_synthetic: toneSynthetic,
      source_vocab: "first 200 Zipf-ordered words for 1/2/3-word buckets",
    },
    list: [...seen],
  };
}

// --- phases ----------------------------------------------------------------

function measureIndexBuild(docs) {
  const store = openFts5Store({ memory: true, prefix: PREFIX_INDEX });
  try {
    const empty = pageStats(store.db);
    const memBefore = memSnapshot();
    const batches = [];
    const t0 = performance.now();
    for (let start = 0; start < docs.length; start += BATCH) {
      const chunk = docs.slice(start, start + BATCH);
      const tb = performance.now();
      store.addMany(chunk);
      const ms = performance.now() - tb;
      batches.push({
        batch: batches.length + 1,
        docs: chunk.length,
        ms: round(ms, 1),
        docs_per_sec: round(chunk.length / (ms / 1000), 1),
      });
    }
    const totalMs = performance.now() - t0;
    const after = pageStats(store.db);
    const memAfter = memSnapshot();

    const probe = docs[0].body.split(/\s+/).find((w) => w.length >= 3) ?? docs[0].title;
    const hits = fts5Search(store, probe, { tone: "strict", limit: 5 }).length;
    if (!hits) throw new Error(`index verification failed: probe "${probe}" returned no hits`);

    const rates = batches.map((b) => b.docs_per_sec);
    return {
      batches,
      total_docs: docs.length,
      total_ms: round(totalMs, 1),
      total_s: round(totalMs / 1000, 2),
      docs_per_sec: round(docs.length / (totalMs / 1000), 1),
      batch_trend: {
        first_batch_docs_per_sec: rates[0],
        last_batch_docs_per_sec: rates[rates.length - 1],
        first_quartile_avg: round(rates.slice(0, Math.max(1, Math.ceil(rates.length / 4))).reduce((a, b) => a + b, 0) / Math.max(1, Math.ceil(rates.length / 4)), 1),
        last_quartile_avg: round(rates.slice(-Math.max(1, Math.ceil(rates.length / 4))).reduce((a, b) => a + b, 0) / Math.max(1, Math.ceil(rates.length / 4)), 1),
        monotonic_decline: rates.every((r, i) => i === 0 || r <= rates[i - 1] * 1.02),
      },
      pages: { empty, after_build: after },
      memory: { phase_start: memBefore, phase_end_build: memAfter },
      verify_probe: { query: probe, hits },
      sqlite_version: String(Object.values(store.db.prepare("SELECT sqlite_version() AS v").get())[0]),
    };
  } finally {
    store.close();
  }
}

function measurePerDoc(docs) {
  const limited = docs.slice(0, Math.min(docs.length, PER_DOC_CAP));
  const store = openFts5Store({ memory: true, prefix: PREFIX_INDEX });
  try {
    const t = performance.now();
    for (const d of limited) store.add(d);
    const ms = performance.now() - t;
    return {
      docs: limited.length,
      total_ms: round(ms, 1),
      docs_per_sec: round(limited.length / (ms / 1000), 1),
    };
  } finally {
    store.close();
  }
}

function measureBulkSameN(docs) {
  const limited = docs.slice(0, Math.min(docs.length, PER_DOC_CAP));
  const store = openFts5Store({ memory: true, prefix: PREFIX_INDEX });
  try {
    const t = performance.now();
    for (let start = 0; start < limited.length; start += BATCH) {
      store.addMany(limited.slice(start, start + BATCH));
    }
    const ms = performance.now() - t;
    return {
      docs: limited.length,
      total_ms: round(ms, 1),
      docs_per_sec: round(limited.length / (ms / 1000), 1),
    };
  } finally {
    store.close();
  }
}

function measureProcessing(docs, reps = 2) {
  const processDoc = (doc, withSynonyms) => {
    if (!withSynonyms) {
      segmentForIndex(doc.title);
      segmentForIndex(doc.body);
      return;
    }
    const t = applyStopwords(expandIndexedText(segmentForIndex(doc.title)), []);
    const b = applyStopwords(expandIndexedText(segmentForIndex(doc.body)), []);
    looseForm(t);
    looseForm(b);
  };
  for (let i = 0; i < Math.min(200, docs.length); i++) processDoc(docs[i], true);

  const repsOut = [];
  for (let r = 0; r < reps; r++) {
    const seg = performance.now();
    for (const d of docs) processDoc(d, false);
    const segMs = performance.now() - seg;

    const full = performance.now();
    for (const d of docs) processDoc(d, true);
    const fullMs = performance.now() - full;

    repsOut.push({
      rep: r + 1,
      segment_only_ms: round(segMs, 1),
      segment_plus_synonyms_and_loose_ms: round(fullMs, 1),
    });
  }
  const segMean = repsOut.reduce((a, r) => a + r.segment_only_ms, 0) / repsOut.length;
  const fullMean = repsOut.reduce((a, r) => a + r.segment_plus_synonyms_and_loose_ms, 0) / repsOut.length;
  return {
    reps: repsOut,
    segment_only_mean_ms: round(segMean, 1),
    full_transform_mean_ms: round(fullMean, 1),
    docs_per_sec_full_transform: round(docs.length / (fullMean / 1000), 1),
  };
}

function measureTransformBatches(docs) {
  const out = [];
  for (let start = 0; start < docs.length; start += BATCH) {
    const chunk = docs.slice(start, start + BATCH);
    const t = performance.now();
    for (const d of chunk) {
      const title = applyStopwords(expandIndexedText(segmentForIndex(d.title)), []);
      const body = applyStopwords(expandIndexedText(segmentForIndex(d.body)), []);
      looseForm(title);
      looseForm(body);
    }
    const ms = performance.now() - t;
    out.push({
      batch: out.length + 1,
      docs: chunk.length,
      ms: round(ms, 1),
      docs_per_sec: round(chunk.length / (ms / 1000), 1),
    });
  }
  const rates = out.map((x) => x.docs_per_sec);
  return {
    batches: out,
    first_batch_docs_per_sec: rates[0],
    last_batch_docs_per_sec: rates[rates.length - 1],
    trend_ratio: round(rates[0] / rates[rates.length - 1], 2),
    note: "store-free transform on the same batches, same order — isolates JS from SQLite",
  };
}

function measureWriteProbes(docs) {
  const limited = docs.slice(0, Math.min(docs.length, PER_DOC_CAP));
  const runBatched = (label, cachePages, prefix) => {
    const store = openFts5Store({
      memory: true,
      prefix: prefix === undefined ? PREFIX_INDEX : prefix,
    });
    try {
      if (cachePages) store.db.exec(`PRAGMA cache_size = -${cachePages}`);
      const t = performance.now();
      for (let start = 0; start < limited.length; start += BATCH) {
        store.addMany(limited.slice(start, start + BATCH));
      }
      const ms = performance.now() - t;
      return {
        label,
        cache_size_kib: cachePages ?? "default (-2000 pages = 8 MiB)",
        prefix_index: prefix === undefined ? PREFIX_INDEX : prefix.length ? prefix : "off",
        docs: limited.length,
        total_ms: round(ms, 1),
        docs_per_sec: round(limited.length / (ms / 1000), 1),
        page_count: pageStats(store.db).page_count,
      };
    } finally {
      store.close();
    }
  };
  const singleTxn = (() => {
    const store = openFts5Store({ memory: true, prefix: PREFIX_INDEX });
    try {
      const t = performance.now();
      store.addMany(limited);
      const ms = performance.now() - t;
      return {
        label: "one transaction, whole subset",
        docs: limited.length,
        total_ms: round(ms, 1),
        docs_per_sec: round(limited.length / (ms / 1000), 1),
      };
    } finally {
      store.close();
    }
  })();
  return {
    baseline_batched_default_cache: runBatched("500-doc batches, default cache"),
    batched_64mib_cache: runBatched("500-doc batches, 64 MiB cache", 65536),
    batched_no_prefix_index: runBatched("500-doc batches, prefix index off", undefined, []),
    single_transaction: singleTxn,
    note: "probes are diagnostic only; production store options are unchanged",
  };
}

function measureNaturalTextSegmentation(targetChars) {
  const unit = POOL.join(" ");
  const parts = [];
  let chars = 0;
  for (let i = 0; chars < targetChars; i++) {
    parts.push(POOL[i % POOL.length]);
    chars += POOL[i % POOL.length].length + 1;
  }
  const text = parts.join(" ");
  segmentForIndex(text.slice(0, Math.min(text.length, 20000)));
  const t = performance.now();
  segmentForIndex(text);
  const ms = performance.now() - t;
  return {
    chars: text.length,
    ms: round(ms, 1),
    chars_per_sec: round(text.length / (ms / 1000), 0),
  };
}

function measureQueries(store, queryList) {
  const channels = ["strict", "loose", "both"];
  const warm = {};
  for (const ch of channels) {
    let hits = 0;
    for (const q of queryList) hits += fts5Search(store, q, { tone: ch, limit: QUERY_LIMIT }).length;
    warm[ch] = hits;
  }

  const out = {};
  for (const ch of channels) {
    const perRep = [];
    const all = [];
    let hitsMin = Infinity;
    let hitsMax = -Infinity;
    let zeroHitQueries = 0;
    for (let rep = 0; rep < QUERY_REPS; rep++) {
      const samples = [];
      for (const q of queryList) {
        const t = performance.now();
        const hits = fts5Search(store, q, { tone: ch, limit: QUERY_LIMIT });
        samples.push(performance.now() - t);
        all.push(samples[samples.length - 1]);
        const n = hits.length;
        if (n < hitsMin) hitsMin = n;
        if (n > hitsMax) hitsMax = n;
        if (n === 0) zeroHitQueries += 1;
      }
      perRep.push(stats(samples));
    }
    out[ch] = {
      reps: QUERY_REPS,
      samples: all.length,
      discarded_warmup_hits: warm[ch],
      ...stats(all),
      per_rep: perRep,
      hits_min: hitsMin === Infinity ? 0 : hitsMin,
      hits_max: hitsMax === -Infinity ? 0 : hitsMax,
      zero_hit_calls: zeroHitQueries,
    };
  }
  return out;
}

function measureFileStore(docs, stamp) {
  const file = join(os.tmpdir(), `thai-fts-perf-${process.pid}-${stamp}.sqlite`);
  const cleanup = () => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        rmSync(file + suffix, { force: true });
      } catch {
        /* ignore */
      }
    }
  };
  cleanup();
  const store = openFts5Store({ path: file, prefix: PREFIX_INDEX });
  let pages;
  let buildMs = 0;
  try {
    const t = performance.now();
    for (let start = 0; start < docs.length; start += BATCH) {
      store.addMany(docs.slice(start, start + BATCH));
    }
    buildMs = performance.now() - t;
    pages = pageStats(store.db);
  } finally {
    store.close();
  }
  const sizeBytes = statSync(file).size;
  let walBytes = 0;
  try {
    walBytes = statSync(`${file}-wal`).size;
  } catch {
    walBytes = 0;
  }
  cleanup();
  return {
    file: "temp (deleted)",
    build_ms: round(buildMs, 1),
    file_bytes: sizeBytes,
    wal_bytes_after_close: walBytes,
    pages,
  };
}

// --- run -------------------------------------------------------------------

function parseArgs(argv) {
  const args = { mode: "quick", n: 1000 };
  for (const a of argv) {
    if (a === "--quick") args.mode = "quick";
    else if (a === "--medium") args.mode = "medium";
    else if (a === "--full") args.mode = "full";
    else if (a.startsWith("--n=")) {
      args.n = Number(a.slice(4));
      args.mode = "custom";
    } else if (a === "--help" || a === "-h") args.help = true;
  }
  if (args.mode === "quick") args.n = Math.min(args.n, 1000);
  if (args.mode === "medium") args.n = 3000;
  if (args.mode === "full") args.n = 20000;
  return args;
}

function printTable(rows) {
  for (const [k, v] of rows) console.log(`  ${k.padEnd(40)} ${v}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      [
        "thai-fts performance diagnosis",
        "  (no flag)   --quick: N=1000, 3 query repetitions",
        "  --medium    N=3000",
        "  --full      N=20000 (opt-in, ~10 min)",
        "  --n=<int>   custom document count",
        "",
        "Writes benchmark/results/perf-<ISO>.json",
      ].join("\n")
    );
    return;
  }
  const n = args.n;
  const mode = args.mode === "custom" ? `custom(${n})` : args.mode;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const startedAt = performance.now();

  console.log(`\nthai-fts perf diagnosis — mode=${mode} docs=${n} seed=${SEED} batch=${BATCH}`);
  if (mode === "quick") {
    console.log("note: quick-mode numbers are NOT comparable to medium/full-mode numbers");
  }

  // dataset
  const tDataset = performance.now();
  const vocab = buildVocabulary(500);
  const { docs, bodyChars, titleChars } = makeDocs(n, vocab);
  const bytes = corpusBytes(docs);
  const { queries, distribution, list: queryList } = makeQueries(vocab);
  const digest = fnv1a(
    [
      ...docs.map((d) => `${d.id}:${d.title.length}:${d.body.length}`),
      `vocab=${vocab.length}`,
      ...queryList,
    ].join("|")
  );
  const dataset = {
    mode,
    n_docs: n,
    seed: SEED,
    vocab_size: vocab.length,
    length_profile: LENGTH_PROFILE,
    body_chars: bodyChars,
    title_chars: titleChars,
    corpus_bytes: bytes,
    corpus_mib: round(bytes / 1048576, 2),
    digest_fnv1a: digest,
    dataset_build_ms: round(performance.now() - tDataset, 1),
    queries: { ...distribution, list: queryList },
  };

  console.log(
    `corpus: ${n} docs, ${(bytes / 1048576).toFixed(2)} MiB, vocab=${vocab.length}, queries=${queryList.length}, digest=${digest}`
  );

  const memory = { after_dataset: memSnapshot() };

  // phase 1: index build
  const tBuild = performance.now();
  const build = measureIndexBuild(docs);
  const buildPhaseMs = performance.now() - tBuild;
  memory.after_index_build = memSnapshot();

  // phase 2: per-doc vs bulk on identical subset
  const perDoc = measurePerDoc(docs);
  const bulkSameN = measureBulkSameN(docs);
  memory.after_per_doc = memSnapshot();

  // phase 3: path split (no store)
  const processing = measureProcessing(docs);
  const transformBatches = measureTransformBatches(docs);
  const writeProbes = measureWriteProbes(docs);
  const derivedFtsMs = Math.max(0, build.total_ms - processing.full_transform_mean_ms);
  const stageSplit = {
    measured: processing,
    per_batch_transform: transformBatches,
    write_probes: writeProbes,
    natural_text_reference: measureNaturalTextSegmentation(Math.min(bodyChars + titleChars, 500000)),
    derived: {
      build_total_ms: build.total_ms,
      js_transform_mean_ms: processing.full_transform_mean_ms,
      estimated_fts5_write_ms: round(derivedFtsMs, 1),
      estimated_fts5_write_share_pct: round((derivedFtsMs / build.total_ms) * 100, 1),
      estimated_js_share_pct: round((processing.full_transform_mean_ms / build.total_ms) * 100, 1),
      note: "derived = build_total - measured JS transform; both share SQLite IPC, so this is an estimate, not a profile",
    },
  };

  // phase 4: queries (warm-up discarded inside measureQueries)
  const store = openFts5Store({ memory: true, prefix: PREFIX_INDEX });
  let queriesOut;
  let indexAfterQueries;
  try {
    store.addMany(docs);
    indexAfterQueries = pageStats(store.db);
    queriesOut = measureQueries(store, queryList);
  } finally {
    store.close();
  }
  memory.after_queries = memSnapshot();

  // phase 5: index size (file store), same corpus
  const fileStore = measureFileStore(docs, stamp);

  // phase 6: environment
  const env = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpu_model: os.cpus()[0]?.model ?? "unknown",
    cpu_count: os.cpus().length,
    totalmem_gib: round(os.totalmem() / 1073741824, 2),
    package_version: version,
    git_commit: gitCommit(),
    sqlite_version: build.sqlite_version,
    segmenter: getThaiSegmenterInfo().source,
    prefix_index: PREFIX_INDEX,
    query_reps: QUERY_REPS,
    query_limit: QUERY_LIMIT,
    batch_size: BATCH,
  };

  const totalS = round((performance.now() - startedAt) / 1000, 1);

  const memoryBlock = {
    ...memory,
    label: "phase-boundary snapshots from process.memoryUsage(); NOT peak RSS",
    deltas: {
      rss_dataset_to_build_mib: round(memory.after_index_build.rss_mib - memory.after_dataset.rss_mib, 2),
      rss_dataset_to_queries_mib: round(memory.after_queries.rss_mib - memory.after_dataset.rss_mib, 2),
    },
  };

  const result = {
    timestamp: new Date().toISOString(),
    task: "TASK-019 perf diagnosis (audit PATCH 5)",
    mode,
    total_s: totalS,
    environment: env,
    dataset,
    index_build: build,
    per_doc_vs_bulk: {
      per_doc_add: perDoc,
      add_many_batches: bulkSameN,
      speedup_add_many_x: round(bulkSameN.docs_per_sec / perDoc.docs_per_sec, 2),
      docs: perDoc.docs,
    },
    stage_split: stageSplit,
    queries: queriesOut,
    index_size: {
      in_memory_pages_after_query_build: indexAfterQueries,
      in_memory_bytes_estimate: indexAfterQueries.bytes,
      in_memory_bytes_per_doc: round(indexAfterQueries.bytes / n, 0),
      file_store: fileStore,
    },
    memory: memoryBlock,
    limitations: [
      "phase-boundary memory only: process.memoryUsage() at boundaries, not peak RSS",
      "quick/medium/full modes use different N and are not comparable to each other",
      "stage split is derived by subtraction, not a profiler; shares include SQLite IPC",
      "generated docs are space-separated word runs, so Intl.Segmenter work is lower than natural prose (see natural_text_reference)",
      "file-store bytes include WAL checkpoint effects and are measured after close",
    ],
  };

  // summary
  const b = build;
  console.log("\n== index build ==");
  printTable([
    ["docs", `${b.total_docs}`],
    ["total", `${b.total_s}s`],
    ["throughput", `${b.docs_per_sec} docs/s`],
    ["first batch", `${b.batch_trend.first_batch_docs_per_sec} docs/s`],
    ["last batch", `${b.batch_trend.last_batch_docs_per_sec} docs/s`],
    ["memory rss start→build", `${memory.after_dataset.rss_mib} → ${memory.after_index_build.rss_mib} MiB`],
    ["in-memory pages", `${b.pages.after_build.page_count} × ${b.pages.after_build.page_size} B = ${b.pages.after_build.bytes} B`],
  ]);
  console.log("  per batch:");
  for (const x of b.batches) console.log(`    #${String(x.batch).padStart(2)}  n=${x.docs}  ${x.ms} ms  ${x.docs_per_sec} docs/s`);

  console.log("\n== per-doc add() vs addMany() (same subset) ==");
  printTable([
    [`per-doc add (${perDoc.docs} docs)`, `${perDoc.docs_per_sec} docs/s (${perDoc.total_ms} ms)`],
    [`addMany batches (${bulkSameN.docs} docs)`, `${bulkSameN.docs_per_sec} docs/s (${bulkSameN.total_ms} ms)`],
    ["speedup", `${round(bulkSameN.docs_per_sec / perDoc.docs_per_sec, 2)}x`],
  ]);

  console.log("\n== stage split (JS transform, store-free) ==");
  printTable([
    ["segmentForIndex mean", `${processing.segment_only_mean_ms} ms`],
    ["segment+synonyms+loose mean", `${processing.full_transform_mean_ms} ms`],
    ["derived fts5 write share", `${stageSplit.derived.estimated_fts5_write_share_pct}% (${stageSplit.derived.estimated_fts5_write_ms} ms)`],
    ["derived JS share", `${stageSplit.derived.estimated_js_share_pct}%`],
    ["natural-text segment ref", `${stageSplit.natural_text_reference.chars_per_sec} chars/s`],
  ]);
  console.log("  per-batch transform (store-free):");
  for (const x of transformBatches.batches) {
    console.log(`    #${String(x.batch).padStart(2)}  n=${x.docs}  ${x.ms} ms  ${x.docs_per_sec} docs/s`);
  }
  console.log(`  transform first/last batch ratio ${transformBatches.trend_ratio}x`);

  console.log("\n== write path probes (same subset) ==");
  const wp = writeProbes;
  printTable([
    [wp.baseline_batched_default_cache.label, `${wp.baseline_batched_default_cache.docs_per_sec} docs/s (${wp.baseline_batched_default_cache.total_ms} ms)`],
    [wp.batched_64mib_cache.label, `${wp.batched_64mib_cache.docs_per_sec} docs/s (${wp.batched_64mib_cache.total_ms} ms)`],
    [wp.batched_no_prefix_index.label, `${wp.batched_no_prefix_index.docs_per_sec} docs/s (${wp.batched_no_prefix_index.total_ms} ms)`],
    [wp.single_transaction.label, `${wp.single_transaction.docs_per_sec} docs/s (${wp.single_transaction.total_ms} ms)`],
  ]);

  console.log("\n== queries (after discarded warm-up) ==");
  for (const ch of ["strict", "loose", "both"]) {
    const q = queriesOut[ch];
    printTable([
      [`${ch} p50/p95/p99`, `${q.p50_ms} / ${q.p95_ms} / ${q.p99_ms} ms`],
      [`${ch} mean / min / max`, `${q.mean_ms} / ${q.min_ms} / ${q.max_ms} ms`],
      [`${ch} samples`, `${q.samples} (${q.reps} reps × ${queryList.length} queries)`],
      [`${ch} hits min/max`, `${q.hits_min} / ${q.hits_max} (zero-hit calls: ${q.zero_hit_calls})`],
      [`${ch} per-rep p50`, q.per_rep.map((r) => `${r.p50_ms}`).join(" / ")],
    ]);
  }

  console.log("\n== index size ==");
  printTable([
    ["in-memory bytes", `${indexAfterQueries.bytes} B (${round(indexAfterQueries.bytes / 1048576, 2)} MiB)`],
    ["in-memory bytes/doc", `${round(indexAfterQueries.bytes / n, 0)} B`],
    ["file store bytes", `${fileStore.file_bytes} B (${round(fileStore.file_bytes / 1048576, 2)} MiB)`],
    ["file store pages", `${fileStore.pages.page_count} × ${fileStore.pages.page_size} B`],
  ]);

  console.log("\n== memory (phase boundaries, not peak) ==");
  printTable([
    ["rss after dataset", `${memory.after_dataset.rss_mib} MiB`],
    ["rss after index build", `${memory.after_index_build.rss_mib} MiB`],
    ["rss after queries", `${memory.after_queries.rss_mib} MiB`],
    ["heapUsed after build", `${memory.after_index_build.heap_used_mib} MiB`],
  ]);

  console.log(`\ntotal ${totalS}s`);

  const dir = join(ROOT, "benchmark", "results");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `perf-${stamp}.json`);
  writeFileSync(file, JSON.stringify(result, null, 2));
  console.log(`wrote ${file.replace(ROOT + "\\", "")}`);
}

await main();
