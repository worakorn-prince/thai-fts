// Dictionary registry: register custom words (forced compounds), synonyms,
// and overrides; list; clear. The registry rewires the pure segment/synonym
// provider seams, so registration is observable through segmentForIndex /
// wordTokens / expandSynonyms / buildFtsMatch.
import { test, after } from "node:test";
import assert from "node:assert/strict";

const {
  registerThaiDictionary,
  listDictionaries,
  clearRegisteredDictionaries,
  THAI_DEFAULT_WORDS,
  THAI_DEFAULT_SYNONYMS,
  expandSynonyms,
  expandChunkSynonyms,
  buildFtsMatch,
  segmentForIndex,
  wordTokens,
  forceSegmenter,
  resetSegmenter,
} = await import("../../dist/index.js");

after(() => {
  clearRegisteredDictionaries();
  resetSegmenter();
});

test("default seed lists are exported with the stable public names", () => {
  assert.ok(Array.isArray(THAI_DEFAULT_WORDS) && THAI_DEFAULT_WORDS.length > 0);
  assert.ok(THAI_DEFAULT_WORDS.includes("ติดตั้ง"), "dev/tech seed words present");
  assert.ok(
    THAI_DEFAULT_SYNONYMS.length >= 15 && THAI_DEFAULT_SYNONYMS.length <= 25,
    `expected 15-25 curated synonym pairs, got ${THAI_DEFAULT_SYNONYMS.length}`
  );
});

test("listDictionaries is empty by default and returns registered ids", () => {
  assert.deepEqual(listDictionaries(), []);
  registerThaiDictionary({ id: "a", words: ["นิติกรรม"] });
  registerThaiDictionary({ id: "b", synonyms: [["attorney", "ทนายความ"]] });
  const ids = listDictionaries().map((d) => d.id).sort();
  assert.deepEqual(ids, ["a", "b"]);
  clearRegisteredDictionaries();
  assert.deepEqual(listDictionaries(), []);
});

test("registering a word keeps it one token on the deterministic fallback path", () => {
  registerThaiDictionary({ id: "legal", words: ["นิติกรรม"] });
  const found = listDictionaries().find((d) => d.id === "legal");
  assert.ok(found, "registered dictionary is listed");

  forceSegmenter(null);
  try {
    const toks = wordTokens("นิติกรรม");
    assert.deepEqual(toks, ["นิติกรรม"], `custom word must stay a single token, got ${toks}`);
    const seg = segmentForIndex("ทำนิติกรรม");
    assert.ok(seg.includes(" นิติกรรม "), `expected merged token: ${seg}`);
    assert.equal(seg.replace(/ +/g, ""), "ทำนิติกรรม", "no characters dropped");
  } finally {
    resetSegmenter();
  }
});

test("without the word registered the same term splits on the fallback path", () => {
  clearRegisteredDictionaries();
  forceSegmenter(null);
  try {
    const toks = wordTokens("นิติกรรม");
    assert.ok(toks.length > 1, `expected the unregistered term to split, got ${toks}`);
  } finally {
    resetSegmenter();
  }
});

test("custom synonym fires end-to-end through expandSynonyms and buildFtsMatch", () => {
  clearRegisteredDictionaries();
  assert.deepEqual(expandSynonyms("attorney"), ["attorney"], "no leak before registration");
  registerThaiDictionary({ id: "legal2", synonyms: [["attorney", "ทนายความ"]] });
  assert.deepEqual(expandSynonyms("attorney"), ["attorney", "ทนายความ"]);
  assert.deepEqual(expandChunkSynonyms("attorney"), ["attorney", "ทนายความ"]);

  const m = buildFtsMatch("attorney");
  assert.ok(m.startsWith('"attorney"'), m);
  assert.ok(m.includes(" OR "), m);
  assert.ok(/[\u0E00-\u0E7F]/.test(m), `expected a Thai counterpart phrase: ${m}`);
});

test("registering a word also feeds the Intl.Segmenter path when it splits apart", () => {
  // A compound ICU tiles into syllables; the override must re-merge them.
  registerThaiDictionary({
    id: "compound",
    overrides: [{ term: "สัญญาเช่า", fixed: "สัญญาเช่า" }],
  });
  const tok = wordTokens("ทำสัญญาเช่า");
  assert.equal(tok.join(""), "ทำสัญญาเช่า", "no characters dropped");
  assert.ok(tok.includes("สัญญาเช่า"), `expected merged compound token: ${tok}`);
});

test("clearRegisteredDictionaries removes custom terms and synonyms", () => {
  clearRegisteredDictionaries();
  registerThaiDictionary({
    id: "temp",
    words: ["นิติกรรม"],
    synonyms: [["draft", "ร่าง"]],
    overrides: [{ term: "สัญญาเช่า", fixed: "สัญญาเช่า" }],
  });
  assert.deepEqual(expandSynonyms("draft"), ["draft", "ร่าง"]);
  clearRegisteredDictionaries();
  assert.deepEqual(listDictionaries(), []);
  assert.deepEqual(expandSynonyms("draft"), ["draft"], "synonyms cleared");
});

test("registerThaiDictionary validates the id", () => {
  assert.throws(() => registerThaiDictionary({ id: "", words: [] }), /non-empty id/);
  assert.throws(() => registerThaiDictionary({ id: "   ", words: [] }), /non-empty id/);
});
