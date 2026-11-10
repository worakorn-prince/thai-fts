// Core opt-in stopword helpers: the curated default list, the strict token
// filter, its de-accented loose twin (a tone typo still drops the token on the
// loose channel), and applyStopwords (payload-space removal that returns the
// input verbatim when nothing is removed).
import { test } from "node:test";
import assert from "node:assert/strict";

const {
  THAI_DEFAULT_STOPWORDS,
  filterStopwords,
  filterStopwordsLoose,
  applyStopwords,
} = await import("../../dist/index.js");

test("THAI_DEFAULT_STOPWORDS is a non-trivial function-word list incl. การ", () => {
  assert.ok(
    THAI_DEFAULT_STOPWORDS.length >= 75,
    `at least 75 curated words, got ${THAI_DEFAULT_STOPWORDS.length}`
  );
  assert.ok(
    THAI_DEFAULT_STOPWORDS.includes("การ"),
    '"การ" (Thai nominalizer) must be a default stopword'
  );
  assert.ok(
    !THAI_DEFAULT_STOPWORDS.includes("ติดตั้ง"),
    "content words must never be stopwords"
  );
});

test("filterStopwords drops stopword tokens from a token list", () => {
  assert.deepEqual(filterStopwords(["การ", "ติด", "ตั้ง"]), ["ติด", "ตั้ง"]);
  assert.deepEqual(
    filterStopwords(["ติด", "ตั้ง"]),
    ["ติด", "ตั้ง"],
    "no stopwords present → unchanged"
  );
  assert.deepEqual(filterStopwords([]), []);
});

test("filterStopwordsLoose drops a tone-typo'd stopword that strict keeps", () => {
  assert.deepEqual(filterStopwordsLoose(["แต่", "ติด"]), ["ติด"]);
  // "ไม" is "ไม่" with the tone mark dropped: the loose (de-accented) form
  // matches the stopword, so the typo is still removed on the loose channel.
  assert.deepEqual(filterStopwordsLoose(["ไม", "ติด", "ปัญหา"]), ["ติด", "ปัญหา"]);
  // The strict filter compares exact forms and must NOT drop the tone typo.
  assert.deepEqual(filterStopwords(["ไม", "ติด"]), ["ไม", "ติด"]);
});

test("applyStopwords removes stopwords from a segmented FTS payload", () => {
  assert.equal(applyStopwords(" การ ติด ตั้ง "), "ติด ตั้ง");
  assert.equal(
    applyStopwords("ติด ตั้ง"),
    "ติด ตั้ง",
    "nothing removed → returned verbatim"
  );
});
