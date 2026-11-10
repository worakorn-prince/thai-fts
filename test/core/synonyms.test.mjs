// Curated transliteration synonyms TH<->EN at index + query, pure layer.
// Precision first: synonyms only ADD equivalent terms; the strict Thai channel
// keeps tone-mark exactness (ติดตั้ง != ติดตัง). Ported from the mcp suite minus
// the database-layer tests (core has no DB).
import { test } from "node:test";
import assert from "node:assert/strict";

const {
  THAI_DEFAULT_SYNONYMS,
  expandSynonyms,
  expandChunkSynonyms,
  expandIndexedText,
  segmentForIndex,
} = await import("../../dist/index.js");

const skip = typeof Intl.Segmenter !== "function";

test("THAI_DEFAULT_SYNONYMS: curated size and bidirectional shape", () => {
  assert.ok(
    Array.isArray(THAI_DEFAULT_SYNONYMS) &&
      THAI_DEFAULT_SYNONYMS.length >= 15 &&
      THAI_DEFAULT_SYNONYMS.length <= 25,
    `expected 15-25 curated pairs, got ${THAI_DEFAULT_SYNONYMS.length}`
  );
  for (const [en, th] of THAI_DEFAULT_SYNONYMS) {
    assert.ok(/^[a-z0-9-]+$/.test(en), `EN key should be a plain token: ${en}`);
    assert.ok(/[\u0E00-\u0E7F]/.test(th), `TH value should contain Thai: ${th}`);
  }
  const enKeys = new Set(THAI_DEFAULT_SYNONYMS.map(([en]) => en));
  assert.ok(enKeys.has("deploy") && enKeys.has("install") && enKeys.has("memory"));
  assert.ok(
    !enKeys.has("the") && !enKeys.has("use") && !enKeys.has("run"),
    "hyper-common ambiguous words excluded"
  );
});

test("expandSynonyms: TH->EN and EN->TH, lowercase, unknown passes through", () => {
  assert.deepEqual(expandSynonyms("ดีพลอย"), ["ดีพลอย", "deploy"]);
  assert.deepEqual(expandSynonyms("deploy"), ["deploy", "ดีพลอย"]);
  assert.deepEqual(expandSynonyms("ติดตั้ง"), ["ติดตั้ง", "install"]);
  assert.deepEqual(expandSynonyms("install"), ["install", "ติดตั้ง"]);
  // multi-variant dedup for repository
  assert.deepEqual(expandSynonyms("repository"), ["repository", "รีโพสิทอรี", "รีโพ"]);
  // one-to-many on the TH side
  assert.deepEqual(expandSynonyms("memory"), ["memory", "ความจำ", "หน่วยความจำ"]);
  // unknown term returns just itself
  assert.deepEqual(expandSynonyms("zzz"), ["zzz"]);
  assert.deepEqual(expandSynonyms(""), [""]);
  // uppercase input is lowercased in the output
  assert.deepEqual(expandSynonyms("DEPLOY"), ["deploy", "ดีพลอย"]);
  // dynamic extra pairs are merged (the per-call seam)
  assert.deepEqual(expandSynonyms("rollout", [["rollout", "โรลเอาต์"]]), [
    "rollout",
    "โรลเอาต์",
  ]);
});

test("expandChunkSynonyms: chunk verbatim + variants; unknown stays just the chunk", () => {
  assert.deepEqual(expandChunkSynonyms("deploy"), ["deploy", "ดีพลอย"]);
  assert.deepEqual(expandChunkSynonyms("ดีพลอย"), ["ดีพลอย", "deploy"]);
  assert.deepEqual(expandChunkSynonyms("zzz"), ["zzz"]);
  // the chunk keeps its original case; variants are lowercased
  assert.deepEqual(expandChunkSynonyms("DEPLOY"), ["DEPLOY", "ดีพลอย"]);
});

test("expandIndexedText: appends counterparts, no drift on unknown text", { skip }, () => {
  // English known term -> TH counterpart appended (segmented form).
  const en = expandIndexedText(segmentForIndex("deploy the app"));
  assert.ok(en.includes("deploy"), `expected deploy kept: ${en}`);
  assert.ok(en.includes("ดี พลอย"), `expected TH counterpart appended: ${en}`);

  // Thai known term -> EN counterpart appended (boundary exact, syllable-safe).
  const th = expandIndexedText(segmentForIndex("เวลาดีพลอยโค้ดบนเซิร์ฟเวอร์"));
  assert.ok(th.includes("server"), `expected server appended: ${th}`);
  assert.ok(th.includes("deploy"), `expected deploy appended: ${th}`);

  // Non-Thai text with no known term stays byte-identical to segmentForIndex output.
  const plain = expandIndexedText(segmentForIndex("use 2-space indent"));
  assert.equal(plain, "use 2-space indent");

  // Precision: ติดตัง (wrong tone) never fires, and ความจำเป็น never trips ความจำ.
  assert.ok(!expandIndexedText(segmentForIndex("ติดตังค่าบริการ")).includes("install"));
  assert.ok(!expandIndexedText(segmentForIndex("ความจำเป็น")).includes("memory"));
});

test("expandIndexedText: byte-idempotent under a second pass", { skip }, () => {
  const cases = [
    "deploy the app",
    "เวลาดีพลอยโค้ดบนเซิร์ฟเวอร์",
    "use 2-space indent",
    "ผมติดตั้งโปรแกรมบนเซิร์ฟเวอร์ใหม่",
    "ติดตังค่าบริการรายเดือน",
  ];
  for (const s of cases) {
    const once = expandIndexedText(segmentForIndex(s));
    const twice = expandIndexedText(segmentForIndex(once));
    assert.equal(twice, once, `idempotent for ${s}`);
  }
});
