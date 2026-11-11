// Unit tests for the pure retrieval-quality metrics (TASK-018).
// metrics.mjs is plain ESM with no build step, so it is imported directly.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  precisionAtK,
  recallAtK,
  mrrAtK,
  ndcgAtK,
  zeroResultRate,
  rescueWins,
  addedIrrelevant,
  meanOf,
} from "../../benchmark/quality/metrics.mjs";

const hits = (...ids) => ids.map((id) => ({ id }));

test("precisionAtK: empty hit list scores 0 over k, not null", () => {
  const r = precisionAtK([], ["a"], 5);
  assert.equal(r.value, 0);
  assert.equal(r.denominator, 5);
  assert.equal(r.excluded, false);
  assert.match(r.note, /only 0 result/);
});

test("precisionAtK: fewer-than-k hits keep k as the denominator", () => {
  const r = precisionAtK(hits("a", "b"), ["a", "b"], 5);
  assert.equal(r.value, 2 / 5);
  assert.equal(r.denominator, 5);
  assert.match(r.note, /precision@5 = 2\/5/);
  assert.match(r.note, /missing slots counted non-relevant/);
});

test("precisionAtK: only top-k hits are counted", () => {
  const r = precisionAtK(hits("x", "x", "x", "a"), ["a"], 3);
  assert.equal(r.value, 0);
  const r2 = precisionAtK(hits("a", "x", "a"), ["a"], 3);
  assert.equal(r2.value, 2 / 3);
});

test("precisionAtK: no relevant docs -> null + excluded", () => {
  const r = precisionAtK(hits("a"), [], 5);
  assert.equal(r.value, null);
  assert.equal(r.excluded, true);
  assert.equal(r.denominator, 0);
});

test("recallAtK: empty hits score 0 over the relevant-set size", () => {
  const r = recallAtK([], ["a", "b"], 20);
  assert.equal(r.value, 0);
  assert.equal(r.denominator, 2);
  assert.equal(r.excluded, false);
});

test("recallAtK: fewer-than-k returned is measured over available hits", () => {
  const r = recallAtK(hits("a", "x"), ["a", "b", "c"], 20);
  assert.equal(r.value, 1 / 3);
  assert.match(r.note, /fewer than k/);
});

test("recallAtK: duplicate ids in relevant are counted once", () => {
  const r = recallAtK(hits("a"), ["a", "a", "b"], 5);
  assert.equal(r.value, 1 / 2);
  assert.equal(r.denominator, 2);
  assert.match(r.note, /1 duplicate id/);
});

test("recallAtK: no relevant docs -> null + excluded", () => {
  const r = recallAtK(hits("a"), [], 5);
  assert.equal(r.value, null);
  assert.equal(r.excluded, true);
});

test("mrrAtK: reciprocal rank of the first relevant hit", () => {
  assert.equal(mrrAtK(hits("x", "a"), ["a"], 10).value, 1 / 2);
  assert.equal(mrrAtK(hits("a", "x"), ["a"], 10).value, 1);
  assert.equal(mrrAtK(hits("x", "y"), ["a"], 10).value, 0);
  assert.equal(mrrAtK([], ["a"], 10).value, 0);
});

test("mrrAtK: relevant hit beyond k does not count", () => {
  const r = mrrAtK(hits("x", "y", "a"), ["a"], 2);
  assert.equal(r.value, 0);
  assert.match(r.note, /top 2/);
});

test("mrrAtK: no relevant docs -> null + excluded", () => {
  const r = mrrAtK(hits("a"), [], 10);
  assert.equal(r.value, null);
  assert.equal(r.excluded, true);
});

test("ndcgAtK: perfect ranking scores 1", () => {
  const r = ndcgAtK(hits("a", "b"), { a: 3, b: 1 }, 10);
  assert.equal(r.excluded, false);
  assert.ok(Math.abs(r.value - 1) < 1e-12, `expected 1, got ${r.value}`);
});

test("ndcgAtK: reversed ranking scores below 1", () => {
  const r = ndcgAtK(hits("b", "a"), { a: 3, b: 1 }, 10);
  assert.ok(r.value > 0 && r.value < 1, `expected (0,1), got ${r.value}`);
  const ideal = ndcgAtK(hits("a", "b"), { a: 3, b: 1 }, 10).value;
  assert.ok(r.value < ideal);
});

test("ndcgAtK: ungraded and grade-0 hits contribute no gain", () => {
  const r = ndcgAtK(hits("z", "a"), { a: 2, z: 0 }, 10);
  assert.ok(r.value > 0 && r.value < 1);
  assert.match(r.note, /dcg=/);
});

test("ndcgAtK: no positive grades -> null + excluded", () => {
  for (const grades of [{}, { a: 0 }, null, undefined]) {
    const r = ndcgAtK(hits("a"), grades, 10);
    assert.equal(r.value, null);
    assert.equal(r.excluded, true);
  }
});

test("ndcgAtK: ideal side is truncated at k", () => {
  const r = ndcgAtK(hits("a", "b", "c"), { a: 3, b: 2, c: 1 }, 2);
  assert.ok(r.value > 0 && r.value <= 1);
  assert.match(r.note, /beyond top-2/);
});

test("zeroResultRate: fraction of empty result sets", () => {
  const r = zeroResultRate([[], [{ id: "a" }], []]);
  assert.equal(r.value, 2 / 3);
  assert.equal(r.denominator, 3);
});

test("zeroResultRate: no queries -> null", () => {
  const r = zeroResultRate([]);
  assert.equal(r.value, null);
  assert.equal(r.denominator, 0);
  assert.equal(r.excluded, 0);
});

test("rescueWins: counts queries recovered by loose/both", () => {
  const queries = [
    { id: "q1", relevant: ["a"] },
    { id: "q2", relevant: ["b"] },
    { id: "q3", relevant: [] },
  ];
  const r = rescueWins(queries, {
    strict: { q1: [], q2: [] },
    loose: { q1: ["a"], q2: [] },
    both: { q1: [], q2: [] },
  });
  assert.equal(r.value, 1);
  assert.equal(r.denominator, 2);
  assert.equal(r.excluded, 1);
});

test("rescueWins: already-found strict hits are not rescues", () => {
  const queries = [{ id: "q1", relevant: ["a", "b"] }];
  const r = rescueWins(queries, {
    strict: { q1: ["a"] },
    loose: { q1: ["b"] },
    both: { q1: [] },
  });
  assert.equal(r.value, 1);
});

test("rescueWins: no win when loose finds only irrelevant docs", () => {
  const queries = [{ id: "q1", relevant: ["a"] }];
  const r = rescueWins(queries, {
    strict: { q1: [] },
    loose: { q1: ["x"] },
    both: { q1: ["y"] },
  });
  assert.equal(r.value, 0);
  assert.equal(r.denominator, 1);
});

test("addedIrrelevant: counts new non-relevant hits over the baseline", () => {
  const queries = [{ id: "q1", relevant: ["a"] }];
  const r = addedIrrelevant(
    queries,
    {
      strict: { q1: ["a"] },
      loose: { q1: ["a", "x", "y"] },
    },
    "loose",
    "strict"
  );
  assert.equal(r.value, 2);
  assert.equal(r.denominator, 1);
});

test("addedIrrelevant: no extra hits -> 0", () => {
  const queries = [{ id: "q1", relevant: ["a"] }];
  const r = addedIrrelevant(
    queries,
    { strict: { q1: ["a"] }, loose: { q1: ["a"] } },
    "loose",
    "strict"
  );
  assert.equal(r.value, 0);
  assert.match(r.note, /across 0 query/);
});

test("meanOf: averages non-null values and skips excluded metrics", () => {
  const r = meanOf([
    { value: 0.5 },
    { value: null, excluded: true },
    { value: 1 },
    { value: undefined },
  ]);
  assert.equal(r.value, 0.75);
  assert.equal(r.denominator, 2);
  assert.equal(r.excluded, 2);
});

test("meanOf: all-null input -> null", () => {
  const r = meanOf([{ value: null }, { value: null }]);
  assert.equal(r.value, null);
  assert.equal(r.denominator, 0);
});
