/**
 * Pure retrieval-quality metrics (TASK-018). Zero deps, no I/O, no engine.
 * Every function returns an explicit { value, denominator, excluded, note }
 * struct so aggregates never silently divide by nothing:
 *   - value: number | null (null when the metric is undefined for this query)
 *   - denominator: what value was divided by (relevant-set size, k, 1, …)
 *   - excluded: true → skip this query in aggregate means
 *   - note: human-readable edge-case accounting
 */

function relSet(relevant) {
  const list = Array.isArray(relevant) ? relevant : [];
  return { set: new Set(list), dupes: list.length - new Set(list).size };
}

function idsOf(hits) {
  return (hits ?? []).map((h) => (h && typeof h === "object" ? h.id : h));
}

/** TP within top-k / k. Missing slots (fewer than k returned) count as non-relevant. */
export function precisionAtK(hits, relevant, k) {
  const { set, dupes } = relSet(relevant);
  if (set.size === 0) {
    return { value: null, denominator: 0, excluded: true, note: "no relevant docs declared — precision undefined" };
  }
  const list = hits ?? [];
  const top = list.slice(0, k);
  const tp = top.reduce((n, h) => n + (set.has(h.id) ? 1 : 0), 0);
  const notes = [`precision@${k} = ${tp}/${k}`];
  if (list.length < k) notes.push(`only ${list.length} result(s) returned (< ${k}) — missing slots counted non-relevant`);
  if (dupes) notes.push(`${dupes} duplicate id(s) in relevant list — counted once`);
  return { value: tp / k, denominator: k, excluded: false, note: notes.join("; ") };
}

/** |relevant ∩ top-k| / |relevant|. Duplicates in relevant counted once. */
export function recallAtK(hits, relevant, k) {
  const { set, dupes } = relSet(relevant);
  if (set.size === 0) {
    return { value: null, denominator: 0, excluded: true, note: "no relevant docs declared — recall undefined" };
  }
  const list = hits ?? [];
  const got = new Set(idsOf(list.slice(0, k)));
  const found = [...set].filter((id) => got.has(id)).length;
  const notes = [`recall@${k} = ${found}/${set.size}`];
  if (list.length < k) notes.push("fewer than k results returned — measured over available hits");
  if (dupes) notes.push(`${dupes} duplicate id(s) in relevant list — counted once`);
  return { value: found / set.size, denominator: set.size, excluded: false, note: notes.join("; ") };
}

/** Reciprocal rank of the first relevant hit within top-k, else 0. */
export function mrrAtK(hits, relevant, k) {
  const { set, dupes } = relSet(relevant);
  if (set.size === 0) {
    return { value: null, denominator: 1, excluded: true, note: "no relevant docs declared — MRR undefined" };
  }
  const top = (hits ?? []).slice(0, k);
  const at = top.findIndex((h) => set.has(h.id));
  const notes = [];
  if (dupes) notes.push(`${dupes} duplicate id(s) in relevant list — counted once`);
  if (at === -1) {
    notes.push(`no relevant hit in top ${k} — reciprocal rank 0`);
    return { value: 0, denominator: 1, excluded: false, note: notes.join("; ") };
  }
  notes.push(`first relevant hit at rank ${at + 1}`);
  return { value: 1 / (at + 1), denominator: 1, excluded: false, note: notes.join("; ") };
}

/**
 * nDCG@k with binary-or-graded labels: gain = 2^grade − 1.
 * Ideal side = all declared grades sorted desc, truncated to k.
 * Returns excluded=true when no positive grades exist.
 */
export function ndcgAtK(hits, grades, k) {
  const g = grades && typeof grades === "object" ? grades : {};
  const positive = Object.values(g).filter((x) => Number.isFinite(x) && x > 0);
  if (positive.length === 0) {
    return { value: null, denominator: 0, excluded: true, note: "no positive graded labels — nDCG skipped" };
  }
  const gain = (id) => {
    const gr = g[id];
    return Number.isFinite(gr) && gr > 0 ? Math.pow(2, gr) - 1 : 0;
  };
  const top = (hits ?? []).slice(0, k);
  let dcg = 0;
  top.forEach((h, i) => {
    dcg += gain(h.id) / Math.log2(i + 2);
  });
  const ideal = [...positive].sort((a, b) => b - a).slice(0, k);
  let idcg = 0;
  ideal.forEach((gr, i) => {
    idcg += (Math.pow(2, gr) - 1) / Math.log2(i + 2);
  });
  const beyond = positive.length > k ? `${positive.length - k} graded doc(s) beyond top-${k} (ideal truncated)` : "";
  const note = [`dcg=${dcg.toFixed(4)} idcg=${idcg.toFixed(4)}`, beyond].filter(Boolean).join("; ");
  return { value: idcg === 0 ? null : dcg / idcg, denominator: 1, excluded: idcg === 0, note };
}

/** Fraction of queries whose result list is empty. perQueryHits = array of arrays. */
export function zeroResultRate(perQueryHits) {
  const total = perQueryHits.length;
  const zeros = perQueryHits.filter((h) => !h || h.length === 0).length;
  return {
    value: total ? zeros / total : null,
    denominator: total,
    excluded: total ? 0 : total,
    note: total ? `${zeros}/${total} queries returned zero results` : "no queries supplied",
  };
}

/**
 * Queries where loose or both surfaced a relevant doc that strict missed.
 * queries: [{ id, relevant }]; hitsByVariant: { strict|loose|both: {qid: [ids]} }
 */
export function rescueWins(queries, hitsByVariant) {
  let wins = 0;
  let eligible = 0;
  let excluded = 0;
  for (const q of queries) {
    const rel = [...new Set(q.relevant ?? [])];
    if (rel.length === 0) {
      excluded++;
      continue;
    }
    const strict = new Set(hitsByVariant.strict?.[q.id] ?? []);
    const loose = hitsByVariant.loose?.[q.id] ?? [];
    const both = hitsByVariant.both?.[q.id] ?? [];
    const rescued = rel.some((id) => !strict.has(id) && (loose.includes(id) || both.includes(id)));
    if (rescued) wins++;
    eligible++;
  }
  return {
    value: wins,
    denominator: eligible,
    excluded,
    note: "queries where loose/both recovered a relevant doc strict missed",
  };
}

/**
 * Hits present under `variant` but absent under `baseline` AND not relevant.
 * Sums per query; denominator = number of queries compared.
 */
export function addedIrrelevant(queries, hitsByVariant, variant, baseline = "strict") {
  let added = 0;
  let queriesWithAdded = 0;
  let excluded = 0;
  for (const q of queries) {
    const rel = new Set(q.relevant ?? []);
    if (rel.size === 0) {
      excluded++;
      continue;
    }
    const base = new Set(hitsByVariant[baseline]?.[q.id] ?? []);
    const extra = (hitsByVariant[variant]?.[q.id] ?? []).filter((id) => !base.has(id) && !rel.has(id));
    if (extra.length) queriesWithAdded++;
    added += extra.length;
  }
  return {
    value: added,
    denominator: queries.length,
    excluded,
    note: `${added} irrelevant hit(s) added by ${variant} over ${baseline}, across ${queriesWithAdded} query result set(s)`,
  };
}

/** Mean of non-null values; {value:null,...} entries are skipped. */
export function meanOf(structs) {
  const vals = structs.map((s) => s?.value).filter((v) => v !== null && v !== undefined);
  return {
    value: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null,
    denominator: vals.length,
    excluded: structs.length - vals.length,
    note: `${vals.length} query metric(s) averaged (${structs.length - vals.length} excluded)`,
  };
}
