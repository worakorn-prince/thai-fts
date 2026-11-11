// Core Porter stemming: `stemEn` — the classic Porter stemmer, ASCII-only.
// OPT-IN feature (default off everywhere): it must never touch Thai tokens,
// must be idempotent, and must fold simple English inflections so an
// index/query pair built with `stem: true` matches across run/running, cat/cats…
import { test } from "node:test";
import assert from "node:assert/strict";

const { stemEn } = await import("../../dist/index.js");

test("stemEn folds common English inflections", () => {
  assert.equal(stemEn("running"), "run");
  assert.equal(stemEn("cats"), "cat");
  // Single-token contract: a whitespace-bearing string is not a word —
  // it passes through unchanged (callers stem per token).
  assert.equal(stemEn("running the installer"), "running the installer");
});

test("stemEn is idempotent on a spread of words", () => {
  const words = [
    "running",
    "caresses",
    "ponies",
    "relieved",
    "motorized",
    "blushed",
    "install",
    "installer",
    "installed",
    "search",
    "searching",
  ];
  for (const w of words) {
    const once = stemEn(w);
    assert.equal(stemEn(once), once, `stemEn(${w}) = ${once} must be a fixed point`);
  }
});

test("stemEn leaves Thai and non-stemable input unchanged", () => {
  assert.equal(stemEn("ติดตั้ง"), "ติดตั้ง", "Thai passes through untouched");
  assert.equal(stemEn("เซิร์ฟเวอร์"), "เซิร์ฟเวอร์");
  assert.equal(stemEn("a"), "a", "single letters are too short to stem");
  assert.equal(stemEn(""), "");
});

test("stemEn is case-insensitive (output lowercased)", () => {
  assert.equal(stemEn("Running"), "run");
  assert.equal(stemEn("CATS"), "cat");
});
