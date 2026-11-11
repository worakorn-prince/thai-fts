/**
 * Shared benchmark corpus + seed helpers (TASK-013).
 *
 * Both benchmark harnesses import the SAME deterministic documents from here:
 *
 *   - `benchmark/run.mjs`            segmentation / indexing / search latency
 *   - `benchmark/addmany-vs-add.mjs` per-doc `add()` vs bulk `addMany()`
 *
 * Importing this module only defines data and pure helpers — it never opens a
 * database, reads `dist/`, or runs a measurement. (Earlier the addMany
 * harness regex-scraped these declarations out of `run.mjs` because that
 * file self-executes its suite on import; this module is the shared source of
 * truth instead.)
 *
 * `benchmark/run.mjs` is still the canonical corpus definition; edit POOL /
 * SEED / PREFIX_INDEX here and both harnesses index byte-identical documents.
 */

// --- corpus ---------------------------------------------------------------
// Thai paragraphs copied verbatim from README.th.md (markdown syntax stripped).
export const POOL = [
  "การค้นหาแบบข้อความเต็ม (full-text search) ภาษาไทยที่คำนึงถึงวรรณยุกต์ สำหรับ Node.js — ไม่มีการพึ่งพาไลบรารีอื่นตอนรันไทม์ (zero runtime dependencies)",
  "thai-fts แก้ปัญหาสองอย่างที่เสิร์ชเอนจินทั่วไปจัดการภาษาไทยได้ไม่ดี:",
  "1. ภาษาไทยเขียนติดกันโดยไม่มีเว้นวรรคระหว่างคำ — ใช้ Intl.Segmenter (full ICU) ก่อนเป็นหลักในการตัดคำ โดยมีพจนานุกรมในตัว + การเดาแบบพยางค์เป็นทางเลือกสำรองสำหรับรันไทม์แบบ small-icu ดังนั้นเอกสารจึงถูกจัดทำดัชนีเป็นคำที่มีช่องว่างคั่น และคำค้นหาจะถูกแปลงเป็นลำดับคำแบบ phrase ที่เรียงตามลำดับ",
  "2. วรรณยุกต์มีความสำคัญเชิงความหมาย — ติดตั้ง (install) ต่างจาก ติดตัง (พิมพ์วรรณยุกต์ผิด) แชนแนลแบบ strict จะคงวรรณยุกต์ไว้ให้ตรงเป๊ะ ส่วนแชนแนลแบบ loose (ทางเลือก) จะตัดเฉพาะ ่ ้ ๊ ๋ ์ ํ แล้วช่วย \"กู้คืน\" ผลลัพธ์ที่ใส่วรรณยุกต์ผิด โดยจัดอันดับอยู่ต่ำกว่าผลลัพธ์แบบ strict เสมอ ไม่มีทางแซงขึ้นมา",
  "ทุกอย่างทำงานบนบิวด์อินของ Node — Intl.Segmenter และ node:sqlite (FTS5) ไม่มีเนทีฟโมดูล ไม่มี WASM ไม่มี npm dependencies ตอนรันไทม์",
  "engine.add({ id: \"guide\", title: \"คู่มือติดตั้ง\", body: \"ขั้นตอนการติดตั้งโปรแกรม\" });",
  "engine.add({ id: \"billing\", title: \"ติดตังค่าบริการ\", body: \"รายเดือน 49 บาท\" });",
  "// { id: \"guide\", rank: 1, snippet: \"ขั้นตอนการติดตั้งโปรแกรม\" }, // strict",
  "// { id: \"billing\", rank: 2, snippet: \"ติดตังค่าบริการ\" }, // loose rescue",
  "wordTokens(\"ติดตั้งโปรแกรม\"); // [\"ติดตั้ง\", \"โปรแกรม\", …] (Intl.Segmenter)",
  "segmentForIndex(\"ติดตั้ง\"); // \" ติด ตั้ง \" เติมช่องว่างระหว่างคำเพื่อทำดัชนี",
  "looseForm(\"ติดตั้ง\"); // \"ติดตัง\" ตัดเครื่องหมายวรรณยุกต์ทิ้ง",
  "แพ็กเกจมาพร้อมไบนารี thai-fts — ผลลัพธ์แบบข้อความล้วนเหมาะกับการ pipe, --json ห่อผลลัพธ์เป็น { ok, data }, รหัสออก 0 = สำเร็จ / 2 = ผิดพลาด",
  "thai-fts segment \"ติดตั้งโปรแกรม\" คำที่ตัดได้ บรรทัดละหนึ่งคำ",
  "thai-fts search \"ติดตั้ง\" --tone strict --db db.sqlite เฉพาะแชนแนล strict",
  "thai-fts search \"ติดตั้ง\" --limit 5 --tone both --db db.sqlite",
  "thai-fts --json search \"ติดตั้ง\" --db db.sqlite { ok: true, data: [...] }",
  "การต่อ segmenter ภายนอก — วัตถุใดก็ตามที่เข้ารูป Intl.Segmenter (มีเมธอด .segment(text) คืน iterable ของ { segment, isWordLike? }) แทนที่ตัวตัดคำในตัวได้ ตัวอย่างรันจริง (HTTP bridge ไปบริการ PyThaiNLP ล้อคัล + สตัมพจนานุกรมแบบซิงโครนัส + การคืนค่าเดิม) อยู่ใน examples/segmenter-bridge.mjs — ไม่ถูกแพ็กใน npm แต่ใช้เป็นจุดเริ่มต้นของการต่อ attacut/PyThaiNLP ได้ทันที: node examples/segmenter-bridge.mjs",
  "คำพ้อง (synonyms.ts) — คำพ้องเสียง/ความหมายแบบทับศัพท์ ไทย↔อังกฤษ",
  "สร้างคำค้นหา (query.ts) — ตัวสร้าง MATCH expression ที่ใช้กับเอนจินใดก็ได้",
  "Prefix / พิมพ์ค้นหาอัตโนมัติ — เปิด store พร้อมดัชนี prefix แล้วค้นด้วย prefix: true (token สุดท้ายของแต่ละ phrase ได้ ต่อท้ายแบบ FTS5):",
  "fts5Search(store, \"ติดตั้งโ\", { prefix: true }); // คำที่พิมพ์แค่บางส่วนก็เจอ",
  "Offsets — ใช้ offsets: true เพิ่ม quote / start / end ที่ตรวจสอบแล้วต่อ hit ในพิกัดเอกสารต้นฉบับ (raw.slice(start, end) === quote; ไม่เดา):",
  "const [hit] = fts5Search(store, \"ติดตั้ง\", { offsets: true });",
  "// hit.quote === \"ติดตั้ง\", hit.start/hit.end เป็น index ของข้อความต้นฉบับ",
  "ถ่วงน้ำหนัก title — titleWeight: N จัดอันดับด้วย titleRank N + bodyRank ทำให้ผลลัพธ์ที่อยู่ title ชนะผลลัพธ์ที่อยู่ body ได้:",
  "Stopwords — เลือกเปิด (OPT-IN) และสมมาตร: stopwords: true (หรือส่ง string[] ของตัวเอง) จะตัดคำฟังก์ชันทั้งฝั่งดัชนีและฝั่งคำค้นพร้อมกัน การสลับตัวเลือกนี้เปลี่ยน payload ในดัชนี ดังนั้นฐานข้อมูลแบบไฟล์ที่มีอยู่ต้อง rebuild (rebuild() หรือเปิดไฟล์ใหม่):",
  "engine.search(\"การติดตั้ง\"); // เจอ — \"การ\" ถูกตัดทั้งสองฝั่ง",
  "multi-occurrence offsets — เมื่อใช้ offsets: true แต่ละ hit จะได้ occurrences: [{ quote, start, end }] ที่ตรวจสอบแล้วสูงสุด 3 รายการ (ตามลำดับในเอกสาร แต่ละรายการ raw.slice(start, end) === quote) รายการแรกเท่ากับ quote/start/end หลัก เหมาะสำหรับการอ้างอิงงานวิชาการ/กฎหมาย:",
  "// เอกสารมี \"ติดตั้ง\" 3 ครั้ง → hit.occurrences.length === 3",
  "การย่อคำอังกฤษ (stemming) — OPT-IN แบบสมมาตร: stem: true รัน stemEn (Porter คลาสสิก เฉพาะ ASCII — คำไทยไม่ถูกแตะ) ทั้งฝั่ง payload ในดัชนีและฝั่งคำค้น ทำให้ running ตรงกับ run การสลับตัวเลือกนี้เปลี่ยน payload ในดัชนี → ฐานข้อมูลไฟล์ที่มีอยู่ต้อง rebuild (หรือเพิ่มเอกสารใหม่สำหรับ memory/HTTP engine) ปิดตามค่าเริ่มต้น:",
  "วรรณยุกต์ไทยมีความหมายในเชิงความหมาย (ติดตั้ง ≠ ติดตัง ที่พิมพ์ผิด) พฤติกรรมเริ่มต้นคือ strict เป็นหลัก, loose ช่วยเสริม:",
  "2. loose (ต่อเมื่อผล strict ยังไม่เต็ม limit) — looseForm ของ payload เดียวกันกับที่ทำดัชนี ตัด id ซ้ำ และจัดอันดับตามหลังผล strict ทั้งหมด",
  "tone: \"strict\" ให้การจับคู่แบบตรงทุกอย่าง tone: \"loose\" ให้การจับคู่แบบตัดวรรณยุกต์เท่านั้น tone: \"both\" (ค่าเริ่มต้น) คือการรวมสองชั้นด้านบน คำค้นภาษาไทยสั้น (1–2 ตัวอักษร) จะใช้การสแกนแบบ LIKE แทน FTS phrase และรายงาน meta.method: \"like_fallback\"",
  "หมายเหตุ: การสแกน LIKE สำหรับคำค้นสั้น (1–2 ตัวอักษร) อ่านจากเอกสารต้นฉบับ (ไม่ใช่ช่องแบบตัดวรรณยุกต์) ดังนั้นคำค้น 1–2 ตัวอักษรที่พิมพ์วรรณยุกต์ผิดจะไม่ถูกกู้คืนในเส้นทางนี้ การกู้คืนวรรณยุกต์ที่ผิดผ่านช่องแบบ loose ใช้ได้กับคำค้นที่ยาวกว่า (3 ตัวอักษรขึ้นไป)",
  "การลงทะเบียนเป็นการเพิ่มทับบนค่าเริ่มต้นสาย dev/tech ที่มีในตัว (ติดตั้ง, เซิร์ฟเวอร์, ฐานข้อมูล, deploy ↔ ดีพลอย, …):",
  "โมดูลอินสแตนซ์กับซับพาธ: แต่ละซับพาธที่บิลด์ (thai-fts, thai-fts/core, …) เป็นโมดูลอินสแตนซ์แยกกัน ทะเบียนพจนานุกรมจึงเป็นแบบ per-instance กรณีใช้เอนจิน ให้ส่งพจนานุกรมผ่าน createFts5Engine({ dictionaries: [...] }) (หรือ openFts5Store) — ครบในตัวเอง ไม่ต้องพึ่ง global state (แนะนำ) กรณีใช้ core โดยตรง ต้อง import registerThaiDictionary พร้อมกับทุกฟังก์ชันที่ใช้มัน (การตัดคำ/คำพ้อง) จาก entry/ซับพาธ เดียวกัน (มาจาก \"thai-fts\" ทั้งหมด หรือ \"thai-fts/core\" ทั้งหมด) เพื่อให้แชร์โมดูลอินสแตนซ์เดียวกัน",
  "รายการคำ seed ต่อโดเมน — มี 3 การส่งออกพร้อมใช้ครอบคลุมคำศัพท์ที่คัดเลือกแล้ว:",
  "แอปสายกฎหมาย/วรรณกรรมโหลดเฉพาะโดเมนทับบนค่าเริ่มต้นได้ทันที:",
  "โหลดรายการคำจากไฟล์ (word list ต่อโดเมน) — loadThaiWordsFromText แยกคำจากข้อความอิสระ (คั่นด้วยบรรทัดใหม่/เว้นวรรค), ตัดช่องว่างและตัดรายการซ้ำ ให้ใช้ไฟล์คำธรรมดาต่อโดเมน (กฎหมาย, วรรณกรรม, …) ได้ทันที:",
  "ใช้ words เมื่อต้องการให้คำนั้นถูกบังคับให้เป็น หนึ่งโทเคน (กรณีทั่วไปสำหรับคำประสม/ชื่อเฉพาะ) และใช้ overrides เฉพาะเมื่อต้อง รีแมป คำที่ถูกตัดแล้วไปเป็นโทเคนตายตัวอื่น ({ term, fixed }) ส่วน THAI_DEFAULT_WORDS (1,368 คำ รวม seed กฎหมาย/วรรณกรรม) และ THAI_DEFAULT_SYNONYMS (38 คู่) ทำงานอยู่ข้างใต้เสมอ",
  "ThaiSearchEngine คือคอนแทรกต์แบบ pluggable ขั้นต่ำ และทะเบียนคือช่องต่อสำหรับแบ็กเอนด์ สิ่งที่มีอยู่ในปัจจุบัน:",
  "await meili.add({ id: 1, title: \"คู่มือ\", body: \"ติดตั้งโปรแกรม\" });",
  "await meili.search(\"ติดตั้ง\"); // ThaiSearchResult[] (async)",
  "ยังเหลือในแผน: Vector / hybrid — ใส่ embeddings เพิ่มเป็นชั้นให้คะแนน โดยยังใช้อินเทอร์เฟซเดิม",
  "npm run build tsup -> dist/ (ESM + CJS + d.ts) สำหรับ 4 subpaths",
  "npm run pack:check npm pack --dry-run (จัดส่งเฉพาะ dist + docs + READMEs)"
];

export const SEED = 20261111;
export const PREFIX_INDEX = [2, 3];

export function mulberry32(a) {
  let s = a >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic document set: seeded picks of POOL paragraphs per doc. */
export function buildDocs(n) {
  const rnd = mulberry32(SEED);
  const docs = [];
  for (let i = 0; i < n; i++) {
    const parts = [];
    const k = 2 + Math.floor(rnd() * 2);
    for (let j = 0; j < k; j++) parts.push(POOL[Math.floor(rnd() * POOL.length)]);
    docs.push({ id: i, title: POOL[i % POOL.length].slice(0, 60), body: parts.join(" ") });
  }
  return docs;
}

export function corpusBytes(docs) {
  let b = 0;
  for (const d of docs) b += Buffer.byteLength(d.title, "utf8") + Buffer.byteLength(d.body, "utf8");
  return b;
}

/** Seeded buffer of ~target bytes for the segmentation microbenchmark. */
export function segBuffer(target) {
  const out = [];
  let bytes = 0;
  for (let i = 0; bytes < target; i++) {
    const p = POOL[i % POOL.length];
    out.push(p);
    bytes += Buffer.byteLength(p + " ", "utf8");
  }
  return out.join(" ");
}
