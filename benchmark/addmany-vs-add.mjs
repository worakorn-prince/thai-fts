#!/usr/bin/env node
/**
 * thai-fts benchmark: per-doc `engine.add()` loop vs bulk `engine.addMany()`
 * (TASK-012).
 *
 * Indexes N seeded documents two ways into freshly opened in-memory FTS5
 * engines and compares throughput:
 *
 *   loop    — `engine.add(doc)` once per doc   (one SQLite transaction per doc)
 *   addMany — `engine.addMany(docs)` once      (one transaction for the batch)
 *
 * Both paths run the same JS-side segment + synonym + payload pipeline; the
 * only difference is transaction overhead, so the delta isolates what bulk
 * indexing buys. Measured against the built `dist/` bundle only, mirroring
 * `benchmark/run.mjs`.
 *
 * The corpus (POOL), SEED, PREFIX_INDEX and the seed helpers (mulberry32,
 * buildDocs, corpusBytes) come from `benchmark/lib.mjs` — the same module
 * `benchmark/run.mjs` imports — so both harnesses index byte-identical
 * documents from one source of truth.
 *
 * Modes: --n=<int> (default 20000) | --quick (N=500). Env
 * THAI_FTS_BENCH_N also works. Results land in
 * benchmark/results/addmany-<stamp>.json.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  PREFIX_INDEX,
  SEED,
  buildDocs,
  corpusBytes,
} from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const DIST = join(ROOT, "dist", "index.js");

if (!existsSync(DIST)) {
  console.error("thai-fts addmany benchmark: dist/index.js not found — run `npm run build` first.");
  process.exit(1);
}

const { createFts5Engine, getThaiSegmenterInfo } = await import(pathToFileURL(DIST).href);

// --- measurement -----------------------------------------------------------

function openEngine() {
  return createFts5Engine({ memory: true, prefix: PREFIX_INDEX });
}

/** First >=3-char Thai word in the corpus — a probe that must hit after indexing. */
function probeWord(docs) {
  for (const d of docs) {
    for (const w of d.body.split(/\s+/)) {
      if (/^[\u0E00-\u0E7F]{3,}$/.test(w)) return w;
    }
  }
  throw new Error("no Thai probe word found in corpus");
}

/** Index for real, then verify the engine answers a probe query before closing. */
function timedAddLoop(docs, probe) {
  const engine = openEngine();
  try {
    const t = performance.now();
    let done = 0;
    for (const d of docs) {
      engine.add(d);
      done += 1;
      if (done % 5000 === 0) console.error(`  add() loop: ${done}/${docs.length}`);
    }
    const ms = performance.now() - t;
    const hits = engine.search(probe, { tone: "strict", limit: 5 }).length;
    if (!hits) throw new Error(`add() loop verification failed: probe "${probe}" found nothing`);
    return { ms: +ms.toFixed(0), docs_per_sec: +(docs.length / (ms / 1000)).toFixed(0) };
  } finally {
    engine.close();
  }
}

function timedAddMany(docs, probe) {
  const engine = openEngine();
  try {
    if (typeof engine.addMany !== "function") {
      throw new Error("engine.addMany is not a function — rebuild dist/ (`npm run build`)");
    }
    const t = performance.now();
    engine.addMany(docs);
    const ms = performance.now() - t;
    const hits = engine.search(probe, { tone: "strict", limit: 5 }).length;
    if (!hits) throw new Error(`addMany() verification failed: probe "${probe}" found nothing`);
    return { ms: +ms.toFixed(0), docs_per_sec: +(docs.length / (ms / 1000)).toFixed(0) };
  } finally {
    engine.close();
  }
}

function parseArgs(argv) {
  const args = { n: 20000 };
  for (const a of argv) {
    if (a === "--quick") args.n = 500;
    else if (a.startsWith("--n=")) args.n = Number(a.slice(4));
    else if (a === "--help" || a === "-h") args.help = true;
  }
  const envN = Number(process.env.THAI_FTS_BENCH_N);
  if (Number.isFinite(envN) && envN > 0) args.n = envN;
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      [
        "thai-fts addmany-vs-add benchmark",
        "  --n=<int>    document count (default 20000)",
        "  --quick      N=500 smoke run",
        "  env THAI_FTS_BENCH_N also works",
      ].join("\n")
    );
    return;
  }
  const n = Number.isFinite(args.n) && args.n > 0 ? Math.trunc(args.n) : 20000;

  const t0 = performance.now();
  const docs = buildDocs(n);
  const bytes = corpusBytes(docs);
  const probe = probeWord(docs);

  console.log(`\nthai-fts addmany-vs-add  docs=${n}  corpus=${(bytes / 1048576).toFixed(2)} MiB  seed=${SEED}`);
  console.log(`node=${process.version}  platform=${process.platform}  segmenter=${getThaiSegmenterInfo().source}\n`);

  // JIT + SQLite warmup on a throwaway engine, then the measured rounds.
  const warm = buildDocs(Math.min(400, n));
  timedAddLoop(warm, probe);
  timedAddMany(warm, probe);

  const loop = timedAddLoop(docs, probe);
  console.log(`add() loop (1 txn/doc)      ${loop.docs_per_sec} docs/s  (${loop.ms} ms)`);
  const bulk = timedAddMany(docs, probe);
  console.log(`addMany() (1 txn/batch)     ${bulk.docs_per_sec} docs/s  (${bulk.ms} ms)`);
  const speedup = +(bulk.docs_per_sec / loop.docs_per_sec).toFixed(2);
  console.log(`speedup                     ${speedup}x`);

  const total_s = +((performance.now() - t0) / 1000).toFixed(1);
  console.log(`\ntotal ${total_s}s`);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(ROOT, "benchmark", "results");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `addmany-${stamp}.json`);
  writeFileSync(
    file,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        node: process.version,
        platform: process.platform,
        config: {
          docs: n,
          corpus_bytes: bytes,
          seed: SEED,
          prefix_index: PREFIX_INDEX,
          warmup_docs: Math.min(400, n),
          probe: { query: probe },
        },
        indexing: { per_doc_add: loop, add_many: bulk, speedup },
        total_s,
      },
      null,
      2
    )
  );
  console.log(`wrote ${file.replace(ROOT + "\\", "")}`);
}

await main();
