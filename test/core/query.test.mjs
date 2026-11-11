// buildFtsMatch / buildLooseFtsMatch / buildSearchQuery — pure query-building
// layer. Thai → single ordered phrase; ASCII → OR its TH counterpart; escaping;
// ติดตั้ง ≠ ติดตัง on the strict channel; 8-chunk cap; buildSearchQuery shape.
import { test } from "node:test";
import assert from "node:assert/strict";

const {
  buildFtsMatch,
  buildLooseFtsMatch,
  buildSearchQuery,
  quoteFtsToken,
  hasThai,
} = await import("../../dist/index.js");

const skip = typeof Intl.Segmenter !== "function";

test("Thai chunk stays a single ordered phrase (even when a known synonym)", () => {
  const thai = buildFtsMatch("ติดตั้ง");
  assert.ok(thai.startsWith('"') && thai.endsWith('"'), `expected a phrase: ${thai}`);
  assert.ok(!thai.includes(" OR "), `Thai chunk must stay a single phrase: ${thai}`);
  assert.equal(thai.slice(1, -1).replace(/\s+/g, ""), "ติดตั้ง");
  assert.ok(!thai.includes("ติดตัง"), "strict phrase must never contain the de-accented form");
});

test("known ASCII chunks OR their TH transliteration phrase", { skip }, () => {
  assert.equal(buildFtsMatch("deploy"), '"deploy" OR "ดี พลอย"');
});

test("unknown ASCII chunks are untouched", () => {
  assert.equal(buildFtsMatch("pnpm npm"), '"pnpm" OR "npm"');
  assert.equal(buildFtsMatch("Omise"), '"Omise"');
});

test("strict vs loose: ติดตั้ง and ติดตัง diverge strict, agree loose", () => {
  const strictInstall = buildFtsMatch("ติดตั้ง");
  const strictWrong = buildFtsMatch("ติดตัง");
  assert.notEqual(strictInstall, strictWrong, "strict channel keeps tone marks significant");

  const looseInstall = buildLooseFtsMatch("ติดตั้ง");
  const looseWrong = buildLooseFtsMatch("ติดตัง");
  assert.equal(looseInstall, looseWrong, "loose channel collapses tone-mark typos");
  assert.equal(looseInstall.slice(1, -1).replace(/\s+/g, ""), "ติดตัง");
});

test("loose match mirrors strict shape for pure-ASCII queries", () => {
  assert.equal(buildLooseFtsMatch("pnpm npm"), '"pnpm" OR "npm"');
  assert.equal(buildLooseFtsMatch("Omise"), '"omise"');
});

test("escaping: double-quotes and backslashes inside tokens are quoted", () => {
  assert.equal(quoteFtsToken(""), "");
  assert.equal(quoteFtsToken('a"b'), 'a""b');
  assert.equal(quoteFtsToken("a\\b"), "a\\\\b");
  assert.equal(buildFtsMatch('a"b'), '"a""b"');
  assert.equal(buildFtsMatch("a\\b"), '"a\\\\b"');
  assert.equal(buildFtsMatch('a"b c\\d'), '"a""b" OR "c\\\\d"');
});

test("chunks are capped at the first 8 tokens", () => {
  const many = Array.from({ length: 12 }, (_, i) => `w${i}`).join(" ");
  const parts = buildFtsMatch(many).split(" OR ");
  assert.equal(parts.length, 8);
  assert.equal(parts[0], '"w0"');
  assert.equal(parts[7], '"w7"');
  assert.ok(!buildFtsMatch(many).includes("w8"), "chunk #9 must be dropped");
});

test("buildSearchQuery: structured { mode, chunks, match, looseMatch } shape", () => {
  const q = buildSearchQuery("deploy ติดตั้ง");
  assert.equal(q.mode, "both", "default tone mode is strict-first dual-channel");
  assert.equal(q.match, buildFtsMatch("deploy ติดตั้ง"));
  assert.equal(q.looseMatch, buildLooseFtsMatch("deploy ติดตั้ง"));

  assert.equal(q.chunks.length, 2);
  const [ascii, thai] = q.chunks;
  assert.deepEqual(
    { raw: ascii.raw, thai: ascii.thai, words: ascii.words, synonyms: ascii.synonyms },
    { raw: "deploy", thai: false, words: ["deploy"], synonyms: ["ดีพลอย"] }
  );
  assert.equal(thai.raw, "ติดตั้ง");
  assert.equal(thai.thai, true);
  assert.ok(hasThai(thai.words.join("")), "Thai chunk words must be Thai");
  assert.equal(thai.words.join(""), "ติดตั้ง");
  assert.deepEqual(thai.synonyms, [], "Thai chunks are never OR-expanded");
});

test("buildSearchQuery: honors an explicit tone mode override", () => {
  assert.equal(buildSearchQuery("a", "loose").mode, "loose");
  assert.equal(buildSearchQuery("a", "strict").mode, "strict");
  assert.equal(buildSearchQuery("a", { mode: "both" }).mode, "both");
  assert.equal(buildSearchQuery("a", "bogus").mode, "both");
});

test("buildSearchQuery: unknown chunk keeps words/synonyms minimal", () => {
  const q = buildSearchQuery("zzz");
  assert.deepEqual(q.chunks, [{ raw: "zzz", thai: false, words: ["zzz"], synonyms: [] }]);
  assert.equal(q.match, '"zzz"');
  assert.equal(q.looseMatch, '"zzz"');
});

test("zero-width chars inside a Thai query word match the clean phrase", () => {
  // Index and query are normalized symmetrically, so a hidden separator that
  // would otherwise split "ติดตั้ง" behaves exactly like the clean input.
  assert.equal(buildFtsMatch("ติด\u200Bตั้ง"), buildFtsMatch("ติดตั้ง"));
  assert.equal(buildFtsMatch("ติด\u200Cตั้ง\u200Dโปร"), buildFtsMatch("ติดตั้งโปร"));
  assert.equal(buildLooseFtsMatch("ติด\u200Bตั้ง"), buildLooseFtsMatch("ติดตั้ง"));
  assert.equal(buildSearchQuery("ติด\u200Bตั้ง").match, buildSearchQuery("ติดตั้ง").match);
  assert.equal(buildSearchQuery("ติด\u200Bตั้ง").looseMatch, buildSearchQuery("ติดตั้ง").looseMatch);
});

test("NFC invariance on the query side (precomposed vs decomposed)", () => {
  assert.equal(buildFtsMatch("caf\u00e9"), buildFtsMatch("cafe\u0301"));
  assert.equal(buildLooseFtsMatch("caf\u00e9"), buildLooseFtsMatch("cafe\u0301"));
  assert.equal(buildSearchQuery("ใช้e\u0301").match, buildSearchQuery("ใช้\u00e9").match);
});

/* ------------------------------------------------------------------ *
 * TASK-012: AND-mode (`allTerms`) + truncation visibility
 * ------------------------------------------------------------------ */

// The expected group text is DERIVED from the default builder, never retyped:
// that proves AND-mode reuses the exact same per-chunk expression and only
// changes how the chunks are joined.
const deployGroup = buildFtsMatch("deploy");
const deployGroupLoose = buildLooseFtsMatch("deploy");

test("allTerms off: every builder stays byte-identical to the default path", { skip }, () => {
  // The regression gate for the whole task: without the flag nothing moves —
  // no parentheses, OR-join, same phrase order.
  assert.equal(buildFtsMatch("deploy program"), `${deployGroup} OR "program"`);
  assert.equal(buildFtsMatch("pnpm npm"), '"pnpm" OR "npm"');
  assert.equal(buildLooseFtsMatch("deploy program"), `${deployGroupLoose} OR "program"`);
  assert.equal(buildFtsMatch("deploy", { allTerms: false }), buildFtsMatch("deploy"));
  assert.equal(buildLooseFtsMatch("deploy", { allTerms: false }), buildLooseFtsMatch("deploy"));
  assert.equal(buildSearchQuery("deploy program").match, `${deployGroup} OR "program"`);
});

test("allTerms on: multi-chunk queries AND-join, synonym groups stay grouped", { skip }, () => {
  // A synonym-expanded chunk is ONE unit: `(a OR b) AND c`, never `a OR b AND c`
  // (which would leak `b` out of the AND or widen the whole query).
  assert.equal(
    buildFtsMatch("deploy program", { allTerms: true }),
    `(${deployGroup}) AND "program"`
  );
  assert.equal(
    buildLooseFtsMatch("deploy program", { allTerms: true }),
    `(${deployGroupLoose}) AND "program"`
  );
  const thaiPhrase = buildFtsMatch("ติดตั้้ง");
  assert.equal(
    buildFtsMatch(`deploy ${thaiPhrase.slice(1, -1).replace(/\s/g, "")}`, { allTerms: true }),
    `(${deployGroup}) AND ${thaiPhrase}`
  );
});

test("allTerms on: no redundant parens when a chunk is already a bare phrase", { skip }, () => {
  // Two bare phrases need no grouping — `"a" AND "b"` is already correct — and
  // a lone Thai chunk is untouched, so the AND output stays minimal.
  assert.equal(buildFtsMatch("pnpm npm", { allTerms: true }), '"pnpm" AND "npm"');
  assert.equal(buildFtsMatch("zzz", { allTerms: true }), '"zzz"');
  assert.equal(buildFtsMatch("ติดตั้้ง", { allTerms: true }), buildFtsMatch("ติดตั้้ง"));
});

test("buildSearchQuery: allTerms is threaded into both match expressions", { skip }, () => {
  const q = buildSearchQuery("deploy program", { allTerms: true });
  assert.equal(q.match, `(${deployGroup}) AND "program"`);
  assert.equal(q.looseMatch, `(${deployGroupLoose}) AND "program"`);
});

test("buildSearchQuery.truncated flags the 8-chunk cap (MAX_QUERY_CHUNKS)", () => {
  // MAX_QUERY_CHUNKS is exported from `thai-fts/core` (asserted in
  // smoke.test.mjs), so the cap is also asserted through the observable
  // `truncated` flag + chunk count.
  const words = (n) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
  const atCap = buildSearchQuery(words(8));
  const pastCap = buildSearchQuery(words(9));
  assert.equal(atCap.truncated, false, "exactly at the cap is not truncated");
  assert.equal(atCap.chunks.length, 8);
  assert.equal(pastCap.truncated, true, "one chunk past the cap must be flagged");
  assert.equal(pastCap.chunks.length, 8, "the dropped chunk is gone from the expressions");
  assert.ok(!pastCap.match.includes("w8"), `w8 must not appear: ${pastCap.match}`);
});
