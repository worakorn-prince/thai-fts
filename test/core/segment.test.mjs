// Core segment: looseForm (tone-tolerant form), dictionary fallback
// segmentation (small-icu runtimes), and the mixed TH/EN wordTokens tokenizer.
// Pure unit tests — no DB. Exercises dist via the exported test hooks.
import { test, after } from "node:test";
import assert from "node:assert/strict";

const {
  hasThai,
  segmentForIndex,
  segmentQueryChunk,
  wordTokens,
  looseForm,
  normalizeThaiInput,
  THAI_DEFAULT_WORDS,
  forceSegmenter,
  resetSegmenter,
  setThaiSegmenter,
  getThaiSegmenterInfo,
} = await import("../../dist/index.js");

const ICU_AVAILABLE = typeof Intl.Segmenter === "function";

after(() => {
  resetSegmenter();
  setThaiSegmenter(null);
});

test("looseForm: strips tone-level marks only, keeps vowels", () => {
  // ติดตั้ง collapses to ติดตัง — exactly the fallback-match equivalence the
  // LOOSE channel relies on (FTS itself keeps them distinct).
  assert.equal(looseForm("ติดตั้ง"), "ติดตัง");
  assert.equal(looseForm("ติดตั้ง"), looseForm("ติดตัง"));
  assert.equal(looseForm("กู้คืน"), "กูคืน");
  assert.equal(looseForm("แก้ม"), "แกม");
  assert.equal(looseForm("ตั้งค่า"), "ตังคา", "tones ้ and ่ stripped, vowel ั and า kept");

  // Each tone-level mark alone is dropped while the consonant survives.
  for (const ch of ["่", "้", "๊", "๋", "์"]) {
    assert.equal(looseForm("ก" + ch), "ก", `mark ${ch}`);
  }
  // U+0E4D nikhahit is the same level mark.
  assert.equal(looseForm("\u0E1E\u0E4D\u0E32"), "\u0E1E\u0E32"); // พํา -> พา

  // Vowel marks (ิ ี ึ ื ุ ู ะ ั ็ เ แ โ ใ ไ ำ) survive.
  assert.equal(looseForm("เกาะ"), "เกาะ");
  assert.equal(looseForm("เก็"), "เก็");
  assert.equal(looseForm("กระติก"), "กระติก");
  assert.equal(looseForm("เสาร์"), "เสาร", "cancellation ์ dropped, consonant kept");

  // Non-Thai goes through lowercase only; empty stays empty.
  assert.equal(looseForm("Hello WORLD"), "hello world");
  assert.equal(looseForm("ใช้pnpm"), "ใชpnpm", "tone ้ inside ใช้ is stripped too");
  assert.equal(looseForm(""), "");
});

test("looseForm: idempotent", () => {
  const cases = ["ติดตั้ง", "กู้คืน", "แก้ม", "Hello WORLD", "", "ใช้pnpm", "เสาร์"];
  for (const s of cases) {
    assert.equal(looseForm(looseForm(s)), looseForm(s), `idempotent for ${s}`);
  }
});

test("wordTokens: mixed TH/EN, pure EN, idempotent", () => {
  const mixed = wordTokens("ใช้pnpm");
  assert.ok(mixed.includes("ใช้"), `expected ใช้ in ${mixed}`);
  assert.ok(mixed.includes("pnpm"), `expected pnpm in ${mixed}`);

  assert.deepEqual(wordTokens("Hello  World!"), ["hello", "world"]);
  assert.deepEqual(wordTokens("use 2-space indent"), ["use", "2", "space", "indent"]);
  assert.deepEqual(wordTokens("The project uses SQLite"), ["the", "project", "uses", "sqlite"]);
  assert.deepEqual(wordTokens(""), []);

  const en = wordTokens("The project uses SQLite");
  assert.deepEqual(wordTokens(en.join(" ")), en, "en tokenization is a fixed point");

  const th = wordTokens("โปรแกรมติดตั้ง");
  assert.ok(th.length >= 2, `expected 2+ words, got ${th}`);
  assert.equal(th.join(""), "โปรแกรมติดตั้ง", "Thai tokenization must not drop characters");
});

test("fallback dictionary: known Thai run splits into words", () => {
  forceSegmenter(null);
  try {
    const clause = "ผมต้องติดตั้งโปรแกรมบนเซิร์ฟเวอร์ใหม่";
    const once = segmentForIndex(clause);
    const words = once.trim().split(/\s+/).filter(Boolean);
    assert.ok(words.length > 1, `expected several words, got: ${once}`);
    assert.equal(words.join(""), clause, "fallback must never drop characters");
  } finally {
    resetSegmenter();
  }
});

test("fallback dictionary: byte-idempotent and robust on arbitrary text", () => {
  forceSegmenter(null);
  try {
    const clause = "ผมต้องติดตั้งโปรแกรมบนเซิร์ฟเวอร์ใหม่";
    const once = segmentForIndex(clause);
    assert.equal(segmentForIndex(once), once, "fallback must be byte-idempotent");

    // Non-Thai / empty inputs are returned verbatim.
    assert.equal(segmentForIndex(""), "");
    assert.equal(segmentForIndex("hello world"), "hello world");
    assert.equal(segmentForIndex("  a  b  "), "  a  b  ");

    // Arbitrary mixed input never throws and stays idempotent.
    const mixed = "foo ไทย bar 123 !!!";
    assert.doesNotThrow(() => segmentForIndex(mixed));
    assert.doesNotThrow(() => wordTokens(["x", "แมวซน", "use pnpm"].join(" ")));
    const s = "ใช้pnpm และ Omise";
    assert.equal(segmentForIndex(segmentForIndex(s)), segmentForIndex(s));

    // Unknown clusters still tokenize without dropping characters.
    const toks = wordTokens("แมวซน");
    assert.ok(toks.length >= 1);
    assert.equal(toks.join(""), "แมวซน");
  } finally {
    resetSegmenter();
  }
});

test("fallback dictionary: hasThai and segmentQueryChunk stay correct", () => {
  forceSegmenter(null);
  try {
    assert.equal(hasThai("สวัสดี"), true);
    assert.equal(hasThai("hello 123"), false);
    assert.equal(hasThai(""), false);

    assert.deepEqual(segmentQueryChunk("ใช้pnpm"), ["ใช้", "pnpm"]);
    const q = segmentQueryChunk("ติดตั้ง");
    assert.ok(q.length >= 1, `expected at least one word, got ${q}`);
    assert.equal(q.join(""), "ติดตั้ง");
  } finally {
    resetSegmenter();
  }
});

test("default path (no override): splits, byte-idempotent, mixed tokens", () => {
  resetSegmenter();
  const clause = "ผมต้องติดตั้งโปรแกรมบนเซิร์ฟเวอร์ใหม่ทุกวันศุกร์";
  const once = segmentForIndex(clause);
  const words = once.trim().split(/\s+/).filter(Boolean);
  assert.ok(words.length > 1, `expected several words, got: ${once}`);
  assert.equal(words.join(""), clause);
  assert.equal(segmentForIndex(once), once);
  assert.deepEqual(wordTokens("ใช้pnpm"), ["ใช้", "pnpm"]);
});

test("resetSegmenter restores the Intl.Segmenter path", { skip: !ICU_AVAILABLE }, () => {
  forceSegmenter(null);
  resetSegmenter();
  const run = "ผมต้องติดตั้งโปรแกรม";
  const seg = new Intl.Segmenter("th", { granularity: "word" });
  const expectWords = [...seg.segment(run)]
    .map((s) => s.segment.trim())
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  assert.deepEqual(wordTokens(run), expectWords);
});

test("normalizeThaiInput: NFC composition + zero-width strip, idempotent, passthrough", () => {
  // NFC composition: decomposed e + acute -> precomposed é (both inputs agree).
  assert.equal(normalizeThaiInput("e\u0301"), "\u00e9");
  assert.equal(normalizeThaiInput("\u00e9"), "\u00e9");
  // Each supported zero-width / format character is removed (ZWSP ZWNJ ZWJ BOM).
  assert.equal(normalizeThaiInput("ติด\u200Bตั้ง"), "ติดตั้ง");
  assert.equal(normalizeThaiInput("ติด\u200Cตั้ง"), "ติดตั้ง");
  assert.equal(normalizeThaiInput("ติด\u200Dตั้ง"), "ติดตั้ง");
  assert.equal(normalizeThaiInput("ติด\uFEFFตั้ง"), "ติดตั้ง");
  // Non-Thai passthrough keeps exact bytes; empty stays empty.
  assert.equal(normalizeThaiInput("Hello WORLD"), "Hello WORLD");
  assert.equal(normalizeThaiInput("  a  b  "), "  a  b  ");
  assert.equal(normalizeThaiInput(""), "");
  // Idempotent fixed point on messy input.
  const messy = "ใช้e\u0301\u200Bpnpm \uFEFF";
  assert.equal(normalizeThaiInput(normalizeThaiInput(messy)), normalizeThaiInput(messy));
});

test("segmentForIndex: zero-width inside a Thai word no longer splits it", () => {
  const clean = segmentForIndex("ติดตั้งโปรแกรม");
  const hidden = segmentForIndex("ติด\u200Bตั้ง\u200Cโปร\u200Dแกรม\uFEFF");
  assert.equal(hidden, clean, "hidden zero-width chars must not change segmentation");
  assert.ok(!hidden.includes("\u200B"), "zero-width chars are gone from the result");
  assert.ok(![...hidden].some((c) => ["\u200B", "\u200C", "\u200D", "\uFEFF"].includes(c)));
});

test("segmentForIndex: byte-idempotent after normalization for messy input", () => {
  const once = segmentForIndex("ใช้\u200Bpnpm\u200C และ\uFEFF Omise");
  assert.equal(segmentForIndex(once), once);
});

test("normalizeThaiInput: precomposed and decomposed forms segment identically", () => {
  // Thai ไทย has no canonically decomposable code points, so a Latin é (U+00E9
  // vs e + U+0301) inside a mixed Thai/EN string proves NFC invariance on the
  // full pipeline: normalize runs before the Thai-run regex on both sides.
  assert.equal(segmentForIndex("ใช้e\u0301pnpm"), segmentForIndex("ใช้\u00e9pnpm"));
  assert.equal(looseForm("caf\u00e9"), looseForm("cafe\u0301"));
  assert.deepEqual(wordTokens("caf\u00e9"), wordTokens("cafe\u0301"));
});

test("setThaiSegmenter/getThaiSegmenterInfo: custom segmenter round-trip", () => {
  const infoDefault = getThaiSegmenterInfo();
  assert.equal(infoDefault.hasSegmenter, ICU_AVAILABLE);
  assert.equal(infoDefault.source, ICU_AVAILABLE ? "intl" : "dict");

  const stub = {
    segment: (text) => [{ segment: text, isWordLike: true }],
  };
  setThaiSegmenter(stub);
  assert.deepEqual(getThaiSegmenterInfo(), { source: "custom", hasSegmenter: true });
  assert.deepEqual(wordTokens("ติดตั้ง"), ["ติดตั้ง"]);
  assert.deepEqual(segmentQueryChunk("ติดตั้ง"), ["ติดตั้ง"]);

  // Re-setting after the module already cached a segmenter picks up the new one.
  const stub2 = {
    segment: (text) => [{ segment: text + "!", isWordLike: true }],
  };
  setThaiSegmenter(stub2);
  assert.deepEqual(wordTokens("ติดตั้ง"), ["ติดตั้ง!"]);

  // null restores auto-detection.
  setThaiSegmenter(null);
  const infoRestored = getThaiSegmenterInfo();
  assert.equal(infoRestored.source, ICU_AVAILABLE ? "intl" : "dict");
  assert.equal(infoRestored.hasSegmenter, ICU_AVAILABLE);
  assert.deepEqual(wordTokens("ใช้pnpm"), ["ใช้", "pnpm"]);
});

test("setThaiSegmenter: validates input and rejects malformed segmenters", () => {
  assert.doesNotThrow(() => setThaiSegmenter(null), "null restores auto-detection");
  assert.doesNotThrow(() => setThaiSegmenter({ segment: () => [] }));
  assert.throws(() => setThaiSegmenter(), TypeError);
  assert.throws(() => setThaiSegmenter({}), TypeError);
  assert.throws(() => setThaiSegmenter({ segment: 42 }), TypeError);
  assert.throws(() => setThaiSegmenter("segmenter"), TypeError);
  assert.throws(() => setThaiSegmenter(123), TypeError);
  setThaiSegmenter(null);
});

test("THAI_DEFAULT_WORDS is a broad seed dictionary (900-2200 entries)", () => {
  const n = THAI_DEFAULT_WORDS.length;
  assert.ok(n >= 900 && n <= 2200, `expected 900-2200 entries, got ${n}`);
  assert.equal(new Set(THAI_DEFAULT_WORDS).size, n, "seed words must be unique");
  // category representatives present after expansion
  for (const w of ["ติดตั้ง", "สัญญา", "โจทก์", "กลอน", "นิทาน", "จำเลย"]) {
    assert.ok(THAI_DEFAULT_WORDS.includes(w), `seed word ${w} expected in THAI_DEFAULT_WORDS`);
  }
});

test("fallback dict: legal & literary sentences segment without dropping characters", () => {
  forceSegmenter(null);
  try {
    const legal = "โจทก์ยื่นฟ้องคดีแพ่งต่อศาลและจำเลย";
    const lit = "กาพย์กลอนนิราศร้อยกรองและนิทาน";
    for (const s of [legal, lit]) {
      const once = segmentForIndex(s);
      const toks = once.trim().split(/\s+/).filter(Boolean);
      assert.ok(toks.length > 1, `expected several words, got: ${once}`);
      assert.equal(toks.join(""), s, `fallback must not drop characters: ${s}`);
    }
  } finally {
    resetSegmenter();
  }
});
