// TASK-017 dispatch 2 — semantics documentation-as-test suite.
// Locks down the strict/loose dual-channel contract AS IMPLEMENTED TODAY:
// every expectation below was reproduced against dist (HEAD 9e5aaa3) before
// being pinned. Where intuition and implementation diverge, the ACTUAL
// behavior is pinned and the divergence is called out in a comment — this
// file documents, it does not wish.
import { test } from "node:test";
import assert from "node:assert/strict";

const {
  openFts5Store,
  fts5Search,
  fts5SearchWithMeta,
  buildFtsMatch,
  buildLooseFtsMatch,
  segmentQueryChunk,
} = await import("../../dist/index.js");

const mk = (...docs) => {
  const store = openFts5Store({ memory: true });
  for (const [id, body] of docs) store.add({ id, body });
  return store;
};
const ids = (hits) => hits.map((h) => h.id);

// A built MATCH expression must parse against a real FTS5 table; the
// assertion is "does not throw", the row count is irrelevant here.
const assertValidMatch = (store, table, expr) => {
  assert.doesNotThrow(
    () => store.db.prepare(`SELECT id FROM ${table} WHERE ${table} MATCH ?`).all(expr),
    `expression must be valid FTS5 MATCH syntax: ${expr}`
  );
};

/* ------------------------------------------------------------------ *
 * 1. Spaced tone fixtures — deterministic token boundaries
 * ------------------------------------------------------------------ */

test("strict spaced-tone query hits every doc via the shared chunk, exact tone leads", () => {
  const store = mk([1, "แมว ป่า นอน"], [2, "แมว ป้า นอน"], [3, "แมว ปา นอน"]);
  // Chunk OR: "แมว" matches all three docs, so the tone-distinct chunk only
  // decides who LEADS, never who is excluded. Pinned current ranking.
  assert.deepEqual(ids(fts5Search(store, "แมว ป่า", { tone: "strict" })), [1, 2, 3]);
  assert.equal(fts5Search(store, "แมว ป่า", { tone: "strict" })[0].id, 1);
  store.close();
});

test("strict tone-marked queries lead with the matching tone", () => {
  const store = mk([1, "แมว ป่า นอน"], [2, "แมว ป้า นอน"], [3, "แมว ปา นอน"]);
  assert.deepEqual(ids(fts5Search(store, "แมว ป้า", { tone: "strict" })), [2, 1, 3]);
  assert.deepEqual(ids(fts5Search(store, "แมว ปา", { tone: "strict" })), [3, 1, 2]);
  store.close();
});

test("both mode agrees with strict on the spaced-tone fixtures (strict-first merge)", () => {
  const store = mk([1, "แมว ป่า นอน"], [2, "แมว ป้า นอน"], [3, "แมว ปา นอน"]);
  assert.deepEqual(ids(fts5Search(store, "แมว ป่า", { tone: "both" })), [1, 2, 3]);
  assert.deepEqual(ids(fts5Search(store, "แมว ป้า", { tone: "both" })), [2, 1, 3]);
  store.close();
});

test("loose channel matches all tone variants of the spaced fixture", () => {
  const store = mk([1, "แมว ป่า นอน"], [2, "แมว ป้า นอน"], [3, "แมว ปา นอน"]);
  const hits = fts5Search(store, "แมว ปา", { tone: "loose" });
  assert.deepEqual(ids(hits), [1, 2, 3]);
  assert.ok(hits.every((h) => h.meta.channel === "loose"));
  store.close();
});

test("both-mode dedupe: the strict hit appears exactly once, tagged strict", () => {
  const store = mk([1, "แมว ป่า นอน"], [2, "แมว ป้า นอน"], [3, "แมว ปา นอน"]);
  const hits = fts5Search(store, "แมว ป่า", { tone: "both" });
  assert.equal(hits.filter((h) => h.id === 1).length, 1, "no duplicate ids from the merge");
  assert.equal(hits[0].meta.channel, "strict");
  assert.equal(hits[0].meta.method, "fts5");
  store.close();
});

/* ------------------------------------------------------------------ *
 * 2. Unspaced vs spaced Thai
 * ------------------------------------------------------------------ */

test("unspaced query hits the unspaced doc (strict), nothing else", () => {
  const store = mk([1, "โปรแกรมเซิรฟเวอร์"], [2, "โปรแกรม เซิรฟเวอร์"]);
  assert.deepEqual(ids(fts5Search(store, "โปรแกรมเซิรฟเวอร์", { tone: "strict" })), [1]);
  assert.deepEqual(ids(fts5Search(store, "โปรแกรมเซิรฟเวอร์", { tone: "both" })), [1]);
  store.close();
});

test("spaced query ranks the spaced doc ahead of the unspaced one", () => {
  const store = mk([1, "โปรแกรมเซิรฟเวอร์"], [2, "โปรแกรม เซิรฟเวอร์"]);
  assert.deepEqual(ids(fts5Search(store, "โปรแกรม เซิรฟเวอร์", { tone: "strict" })), [2, 1]);
  assert.deepEqual(ids(fts5Search(store, "โปรแกรม เซิรฟเวอร์", { tone: "both" })), [2, 1]);
  store.close();
});

/* ------------------------------------------------------------------ *
 * 3. Zero-width space — documented, NOT fixed
 *
 * Asymmetry pinned here: a U+200B that splits "โปรแกรม" into "โปร|รกม"
 * changes the built phrase ("โปร รกม" ≠ "โปรแกรม") and loses the match,
 * while test/core/query.test.mjs pins zwsp EQUALITY for "ติด\u200Bตั้ง"
 * (different position/shape — the pieces re-segment identically there).
 * The inconsistency is a known quirk of where the hidden separator falls
 * relative to dictionary word boundaries; only the current behavior is
 * pinned below.
 * ------------------------------------------------------------------ */

test("zwsp inside Thai loses the match and changes the built phrase", () => {
  const store = mk([1, "โปรแกรม"]);
  const zwsp = "โปร\u200bรกม";
  assert.deepEqual(ids(fts5Search(store, zwsp, { tone: "strict" })), []);
  assert.deepEqual(ids(fts5Search(store, zwsp, { tone: "both" })), []);
  assert.equal(buildFtsMatch(zwsp), '"โปร รกม"');
  assert.notEqual(buildFtsMatch(zwsp), buildFtsMatch("โปรแกรม"));
  // The other shape really does collapse (see test/core/query.test.mjs):
  assert.equal(buildFtsMatch("ติด\u200Bตั้ง"), buildFtsMatch("ติดตั้ง"));
  store.close();
});

/* ------------------------------------------------------------------ *
 * 4. Operators & punctuation are literal user text
 * ------------------------------------------------------------------ */

test("FTS operators and punctuation are literal text, never syntax", () => {
  const store = mk(
    [1, "status (!!)"],
    [2, 'the "exact phrase" here'],
    [3, "AND OR NOT NEAR as words"],
    [4, "โปรแกรม."]
  );
  // Punctuation-only: nothing to index, nothing to find.
  assert.deepEqual(ids(fts5Search(store, "(!!)", { tone: "both" })), []);
  // Quotes pass through as real FTS phrase syntax and hit the doc that
  // literally contains the phrase.
  assert.deepEqual(ids(fts5Search(store, '"exact phrase"', { tone: "both" })), [2]);
  // AND/OR/NOT/NEAR as a query do NOT act as operators — each word is quoted
  // as a literal term and OR-joined, so only the doc containing them hits.
  assert.deepEqual(ids(fts5Search(store, "AND OR NOT NEAR", { tone: "both" })), [3]);
  // Thai + trailing punctuation still hits (punct becomes its own token).
  assert.deepEqual(ids(fts5Search(store, "โปรแกรม.", { tone: "strict" })), [4]);
  store.close();
});

test("operator/punctuation queries build valid MATCH expressions with literal terms", () => {
  const store = mk([1, 'the "exact phrase" here'], [2, "โปรแกรม"]);
  assert.equal(buildFtsMatch("(!!)"), '"(!!)"');
  assert.equal(buildFtsMatch("โปรแกรม."), '"โปรแกรม ."');
  assert.equal(buildFtsMatch("AND OR NOT NEAR"), '"AND" OR "OR" OR "NOT" OR "NEAR"');
  assert.equal(buildFtsMatch('"exact phrase"'), '"""exact" OR "phrase"""');
  // All of the above must parse against a real FTS5 table (no syntax errors).
  assertValidMatch(store, "fts5_strict", buildFtsMatch("(!!)"));
  assertValidMatch(store, "fts5_strict", buildFtsMatch('"exact phrase"'));
  assertValidMatch(store, "fts5_strict", buildFtsMatch("AND OR NOT NEAR"));
  assertValidMatch(store, "fts5_strict", buildFtsMatch("โปรแกรม."));
  store.close();
});

/* ------------------------------------------------------------------ *
 * 5. Short-query fallback gate
 *
 * Gate (search.ts): pure-Thai query whose folded Thai-char count is 1–2
 * (combining marks fold into their base, so "ดึก" is 3 code points but
 * 2 chars) skips FTS5 phrases and runs a raw LIKE scan instead, tagged
 * meta.method = "like_fallback". The builder itself is gate-free.
 * ------------------------------------------------------------------ */

test("three-char Thai query clears the gate and runs through FTS5", () => {
  const store = mk([1, "แมว"], [2, "แมว นอน"], [3, "ดึก ดื่น"], [4, "ลา นอน"], [5, "ดี ดิด"]);
  const out = fts5SearchWithMeta(store, "แมว", { tone: "both" });
  assert.deepEqual(ids(out.hits), [1, 2]);
  assert.equal(out.hits[0].meta.method, "fts5", "3 Thai chars > gate, no fallback");
  store.close();
});

test("one- and two-char Thai queries route to the LIKE fallback (strict and both agree)", () => {
  const store = mk([1, "แมว"], [2, "แมว นอน"], [3, "ดึก ดื่น"], [4, "ลา นอน"], [5, "ดี ดิด"]);
  for (const tone of ["strict", "both"]) {
    assert.deepEqual(ids(fts5Search(store, "แม", { tone })), [1, 2]);
    assert.deepEqual(ids(fts5Search(store, "ลา", { tone })), [4]);
    assert.deepEqual(ids(fts5Search(store, "ดึก", { tone })), [3]);
    assert.deepEqual(ids(fts5Search(store, "ดี", { tone })), [5]);
  }
  // The method tag proves the gate fired, including the mark-folding rule:
  // "ดึก" is 3 code points but the mark folds, so it counts as 2.
  assert.equal(fts5Search(store, "แม", { tone: "strict" })[0].meta.method, "like_fallback");
  assert.equal(fts5Search(store, "ดึก", { tone: "strict" })[0].meta.method, "like_fallback");
  store.close();
});

test("the fallback gate lives in search, not in the MATCH builders", () => {
  // Builders are gate-free: even the sub-gate query builds a normal phrase.
  assert.equal(buildFtsMatch("แมว"), '"แมว"');
  assert.equal(buildFtsMatch("แม"), '"แม"');
});

/* ------------------------------------------------------------------ *
 * 6. Determinism + CRUD consistency
 * ------------------------------------------------------------------ */

test("repeated identical queries return identical id order", () => {
  const store = mk([1, "แมว ป่า นอน"], [2, "แมว ป้า นอน"], [3, "แมว ปา นอน"], [4, "โปรแกรม"]);
  for (const query of ["แมว", "แมว นอน"]) {
    const runs = Array.from({ length: 4 }, () =>
      ids(fts5Search(store, query, { tone: "both" }))
    );
    assert.deepEqual(runs[0], [1, 2, 3]);
    for (const run of runs) assert.deepEqual(run, runs[0]);
  }
  store.close();
});

test("CRUD keeps the index in lockstep with the document table", () => {
  const store = mk([1, "โปรแกรม"]);
  assert.deepEqual(ids(fts5Search(store, "โปรแกรม", { tone: "strict" })), [1]);
  store.update({ id: 1, body: "เซิรฟเวอร์" });
  // Old text is gone from the index, new text found, still ONE row for the id.
  assert.deepEqual(ids(fts5Search(store, "โปรแกรม", { tone: "strict" })), []);
  assert.deepEqual(ids(fts5Search(store, "เซิรฟเวอร์", { tone: "strict" })), [1]);
  assert.equal(store.allRows().length, 1);
  store.remove(1);
  assert.deepEqual(ids(fts5Search(store, "เซิรฟเวอร์", { tone: "strict" })), []);
  store.add({ id: 1, body: "เซิรฟเวอร์" });
  assert.deepEqual(ids(fts5Search(store, "เซิรฟเวอร์", { tone: "strict" })), [1]);
  assert.equal(store.allRows().length, 1);
  store.close();
});

/* ------------------------------------------------------------------ *
 * 7. Empty / degenerate input
 * ------------------------------------------------------------------ */

test("empty, whitespace-only and punctuation-only queries return nothing without throwing", () => {
  const store = mk([1, "โปรแกรม"]);
  for (const query of ["", "   ", "\t\n ", "!!!", "...", "()"]) {
    assert.doesNotThrow(() => fts5Search(store, query, { tone: "both" }));
    assert.deepEqual(
      ids(fts5Search(store, query, { tone: "both" })),
      [],
      `query ${JSON.stringify(query)} must hit nothing`
    );
  }
  store.close();
});

test("a store with zero documents searches cleanly to an empty result", () => {
  const store = mk();
  assert.deepEqual(ids(fts5Search(store, "โปรแกรม", { tone: "both" })), []);
  assert.deepEqual(ids(fts5Search(store, "แมว", { tone: "both" })), []);
  store.close();
});

/* ------------------------------------------------------------------ *
 * 8. Channel purity (contract assertions)
 * ------------------------------------------------------------------ */

test("strict never applies loose normalization — tone-distinct docs stay out", () => {
  const store = mk([1, "ปา"], [2, "ป้า"]);
  // "ปา" is 2 Thai chars, so it hits the LIKE fallback — but the fallback is
  // a RAW substring scan, not a de-accented one, so strict tone semantics are
  // preserved even on the fallback path: only the tone-exact doc surfaces.
  const hits = fts5Search(store, "ปา", { tone: "strict" });
  assert.deepEqual(ids(hits), [1]);
  assert.equal(hits[0].meta.method, "like_fallback");
  // Tone-distinct query finds nothing strict-side, and both-mode adds no
  // loose noise for this single-doc pair.
  assert.deepEqual(ids(fts5Search(store, "ป่า", { tone: "strict" })), []);
  assert.deepEqual(ids(fts5Search(store, "ปา", { tone: "both" })), [1]);
  store.close();
});

test("strict and loose builders diverge on tone-marked Thai, both stay valid", () => {
  const store = mk([1, "ป้าไปตลาด"], [2, "ป้าไป"], [3, "ปาไป"]);
  assert.equal(buildFtsMatch("ป้าไป"), '"ป้า ไป"');
  assert.equal(buildLooseFtsMatch("ป้าไป"), '"ปา ไป"');
  assert.notEqual(buildFtsMatch("ป้าไป"), buildLooseFtsMatch("ป้าไป"));
  // Both expressions parse against their real channel tables (no unescaped
  // quotes, no syntax errors).
  assertValidMatch(store, "fts5_strict", buildFtsMatch("ป้าไป"));
  assertValidMatch(store, "fts5_loose", buildLooseFtsMatch("ป้าไป"));
  store.close();
});

test("both-mode merge yields unique ids even with unspaced tone compounds", () => {
  const store = mk([1, "ป้าไปตลาด"], [2, "ป้าไป"], [3, "ปาไป"]);
  const hits = fts5Search(store, "ป้าไป", { tone: "both" });
  assert.deepEqual(ids(hits), [2, 1]);
  assert.ok(hits.every((h) => h.meta.channel === "strict"));
  assert.equal(new Set(ids(hits)).size, ids(hits).length, "no duplicate ids across channels");
  // Pinned surprise: doc 3 ("ปาไป") never surfaces, not even via the loose
  // channel, because segmentQueryChunk("ปาไป") is a SINGLE token "ปาไป" while
  // the loose query is the two-token phrase "ปา ไป" — the phrase form can
  // never match the single-token document form. Documented, not fixed.
  assert.deepEqual(segmentQueryChunk("ปาไป"), ["ปาไป"]);
  store.close();
});
