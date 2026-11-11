#!/usr/bin/env node
/**
 * Retrieval-quality benchmark (TASK-018).
 *
 * Runs the hand-authored SYNTHETIC fixtures in `benchmark/quality/fixtures.mjs`
 * against ONE in-memory FTS5 store, under all three tone variants
 * (strict / loose / both, limit 20), and scores every query with the pure
 * metrics in `metrics.mjs`. The per-query "declared" block uses the query's
 * own `mode`; every variant is also scored so escapes/regressions are visible.
 *
 * Aggregates per category and overall:
 *   Precision@5, Recall@20, MRR@10, nDCG@10 (graded queries only),
 *   zero-result rate (per variant), rescue wins (strict → loose/both) and
 *   added-irrelevant hits (loose / both vs strict).
 *
 * Output: `benchmark/quality/results/quality-<ISO>.json` (every per-query
 * struct preserved, explicit denominators included) + console tables.
 *
 * Deterministic: fixed fixtures, sorted query iteration, no timing-dependent
 * output. Results reflect the build in `dist/` — run `npm run build` first.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { FIXTURES } from "./fixtures.mjs";
import {
  precisionAtK,
  recallAtK,
  mrrAtK,
  ndcgAtK,
  zeroResultRate,
  rescueWins,
  addedIrrelevant,
  meanOf,
} from "./metrics.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const DIST = join(ROOT, "dist", "index.js");

if (!existsSync(DIST)) {
  console.error("thai-fts quality benchmark: dist/index.js not found — run `npm run build` first.");
  process.exit(1);
}

// Single bundle on purpose (same reason as benchmark/run.mjs): importing both
// dist/index and a subpath would create two core module instances.
const { openFts5Store, fts5Search } = await import(pathToFileURL(DIST).href);

const LIMIT = 20;
const K = { precision: 5, recall: 20, mrr: 10, ndcg: 10 };
const VARIANTS = ["strict", "loose", "both"];

// --- helpers --------------------------------------------------------------

const fmt = (v) => (v === null || v === undefined ? "  —  " : v.toFixed(3));
const stringWidth = (s) => [...String(s)].length;

function pad(s, w) {
  s = String(s);
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

function table(rows, headers) {
  const widths = headers.map((h, i) =>
    Math.max(stringWidth(h), ...rows.map((r) => stringWidth(r[i])))
  );
  const line = (cells) => "  " + cells.map((c, i) => pad(c, widths[i])).join("  ");
  const sep = "  " + widths.map((w) => "-".repeat(w)).join("  ");
  return [line(headers), sep, ...rows.map(line)].join("\n");
}

function metricBlock(results, q) {
  return {
    precision_at_5: precisionAtK(results, q.relevant, K.precision),
    recall_at_20: recallAtK(results, q.relevant, K.recall),
    mrr_at_10: mrrAtK(results, q.relevant, K.mrr),
    ndcg_at_10: q.grades
      ? ndcgAtK(results, q.grades, K.ndcg)
      : { value: null, denominator: 0, excluded: true, note: "no graded labels declared — nDCG not applicable" },
  };
}

function aggregate(entries, pick) {
  const metrics = entries.map(pick);
  return {
    queries: entries.length,
    precision_at_5: meanOf(metrics.map((m) => m.precision_at_5)),
    recall_at_20: meanOf(metrics.map((m) => m.recall_at_20)),
    mrr_at_10: meanOf(metrics.map((m) => m.mrr_at_10)),
    ndcg_at_10: meanOf(metrics.map((m) => m.ndcg_at_10)),
  };
}

// --- run ------------------------------------------------------------------

const queries = [...FIXTURES.queries].sort((a, b) => a.id.localeCompare(b.id, "en"));
const docs = FIXTURES.docs;

const store = openFts5Store({ memory: true });
store.rebuild(docs);

const hitsByVariant = { strict: {}, loose: {}, both: {} };
const entries = [];

for (const q of queries) {
  const variants = {};
  for (const variant of VARIANTS) {
    const results = fts5Search(store, q.text, { tone: variant, limit: LIMIT });
    const ids = results.map((h) => h.id);
    hitsByVariant[variant][q.id] = ids;
    variants[variant] = {
      ids,
      count: ids.length,
      method: results[0]?.meta?.method ?? "fts5",
      ...metricBlock(results, q),
    };
  }

  const chosen = variants[q.mode];
  entries.push({
    id: q.id,
    category: q.category,
    text: q.text,
    mode: q.mode,
    relevant_count: q.relevant.length,
    graded: q.grades ? Object.keys(q.grades).length : 0,
    declared: {
      mode: q.mode,
      precision_at_5: chosen.precision_at_5,
      recall_at_20: chosen.recall_at_20,
      mrr_at_10: chosen.mrr_at_10,
      ndcg_at_10: chosen.ndcg_at_10,
    },
    variants,
  });
}

store.close();

// --- aggregates -----------------------------------------------------------

const categories = [...new Set(entries.map((e) => e.category))].sort((a, b) =>
  a.localeCompare(b, "en")
);

const byCategory = {};
for (const category of categories) {
  const group = entries.filter((e) => e.category === category);
  byCategory[category] = {
    declared: aggregate(group, (e) => e.declared),
    declared_zero_result: zeroResultRate(group.map((e) => e.variants[e.mode].ids)),
    per_variant_zero_result: Object.fromEntries(
      VARIANTS.map((v) => [v, zeroResultRate(group.map((e) => e.variants[v].ids))])
    ),
  };
}

const overall = {
  docs: docs.length,
  queries: entries.length,
  limit: LIMIT,
  k: K,
  declared: {
    ...aggregate(entries, (e) => e.declared),
    zero_result_rate: zeroResultRate(entries.map((e) => e.variants[e.mode].ids)),
  },
};

overall.variants = {};
for (const variant of VARIANTS) {
  overall.variants[variant] = {
    ...aggregate(entries, (e) => e.variants[variant]),
    zero_result_rate: zeroResultRate(entries.map((e) => e.variants[variant].ids)),
  };
}

overall.rescue_wins = rescueWins(queries, hitsByVariant);
overall.added_irrelevant = {
  loose_vs_strict: addedIrrelevant(queries, hitsByVariant, "loose", "strict"),
  both_vs_strict: addedIrrelevant(queries, hitsByVariant, "both", "strict"),
};
overall.categories = byCategory;

// --- reporting ------------------------------------------------------------

const overallRow = [
  "overall",
  overall.declared.queries,
  fmt(overall.declared.precision_at_5.value),
  fmt(overall.declared.recall_at_20.value),
  fmt(overall.declared.mrr_at_10.value),
  fmt(overall.declared.ndcg_at_10.value),
  fmt(overall.declared.zero_result_rate.value),
];

const categoryRows = categories.map((c) => [
  c,
  byCategory[c].declared.queries,
  fmt(byCategory[c].declared.precision_at_5.value),
  fmt(byCategory[c].declared.recall_at_20.value),
  fmt(byCategory[c].declared.mrr_at_10.value),
  fmt(byCategory[c].declared.ndcg_at_10.value),
  fmt(byCategory[c].declared_zero_result.value),
]);

const variantRows = VARIANTS.map((v) => [
  v,
  overall.variants[v].queries,
  fmt(overall.variants[v].zero_result_rate.value),
  fmt(overall.variants[v].precision_at_5.value),
  fmt(overall.variants[v].recall_at_20.value),
  fmt(overall.variants[v].mrr_at_10.value),
  fmt(overall.variants[v].ndcg_at_10.value),
]);

const pinned = entries
  .filter(
    (e) =>
      e.variants.strict.count === 0 &&
      (e.variants.loose.count > 0 || e.variants.both.count > 0)
  )
  .map((e) => `${e.id}: strict=0, loose=${e.variants.loose.count}, both=${e.variants.both.count} (tone rescue)`);

// Queries no variant can answer at all. Kept as-is (no fixture tuning): the
// loose channel matches the mark-stripped INDEX payload, so a tone-less query
// only rescues when it tokenizes the same way the dictionary did.
const zeroAll = entries
  .filter((e) => e.variants.strict.count === 0 && e.variants.loose.count === 0 && e.variants.both.count === 0)
  .map((e) => `${e.id} (${e.category}): 0 hits in strict/loose/both — pinned as-is`);

const likeQueries = entries
  .filter((e) => e.variants[e.mode].method === "like_fallback")
  .map((e) => `${e.id} (${e.category})`);

console.log(
  `\nthai-fts retrieval-quality benchmark (SYNTHETIC fixtures)\n` +
    `docs=${docs.length}  queries=${entries.length}  limit=${LIMIT}  ` +
    `P@${K.precision} R@${K.recall} MRR@${K.mrr} nDCG@${K.ndcg}\n` +
    `node=${process.version}  platform=${process.platform}`
);

console.log("\nper category (each query scored in its declared mode):");
console.log(
  table([...categoryRows, overallRow], [
    "category",
    "queries",
    "P@5",
    "R@20",
    "MRR@10",
    "nDCG@10",
    "zero%",
  ])
);

console.log("\ntone variants (all queries, same store):");
console.log(
  table(variantRows, ["variant", "queries", "zero-result", "P@5", "R@20", "MRR@10", "nDCG@10"])
);

console.log(
  `\nrescue wins: ${overall.rescue_wins.value}/${overall.rescue_wins.denominator} eligible queries ` +
    `(${overall.rescue_wins.excluded} excluded: no relevant docs)`
);
console.log(
  `added irrelevant (vs strict): loose ${overall.added_irrelevant.loose_vs_strict.value} hit(s) over ` +
    `${overall.added_irrelevant.loose_vs_strict.denominator} queries; ` +
    `both ${overall.added_irrelevant.both_vs_strict.value} hit(s)`
);
console.log(`like_fallback declared-mode queries: ${likeQueries.length ? likeQueries.join(", ") : "none"}`);
if (pinned.length) console.log(`pinned tone rescues:\n  ${pinned.join("\n  ")}`);
if (zeroAll.length) console.log(`pinned zero-result queries:\n  ${zeroAll.join("\n  ")}`);

// --- results JSON ---------------------------------------------------------

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const dir = join(HERE, "results");
mkdirSync(dir, { recursive: true });
const file = join(dir, `quality-${stamp}.json`);

writeFileSync(
  file,
  JSON.stringify(
    {
      timestamp: new Date().toISOString(),
      node: process.version,
      platform: process.platform,
      fixtures: {
        provenance: FIXTURES.provenance,
        docs: docs.length,
        queries: entries.length,
      },
      config: { limit: LIMIT, k: K, variants: VARIANTS },
      overall,
      per_query: entries,
      pinned: { tone_rescues: pinned, zero_result_queries: zeroAll, like_fallback_queries: likeQueries },
    },
    null,
    2
  )
);

console.log(`\nwrote ${file.replace(ROOT + "\\", "")}\n`);
