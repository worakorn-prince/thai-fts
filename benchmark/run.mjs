#!/usr/bin/env node
/**
 * thai-fts benchmark harness (TASK-011a).
 *
 * Measures three things against the built `dist/` bundle only (never `src/`),
 * mirroring how `test/*.test.mjs` imports the package:
 *
 *  1. Segmentation throughput (MiB/s) — the `Intl.Segmenter` path vs the
 *     built-in dictionary fallback. The fallback is forced with
 *     `forceSegmenter(null)`; `setThaiSegmenter(null)` is NOT equivalent (it
 *     restores auto-detection, i.e. `Intl.Segmenter` again — see segment.ts).
 *  2. Index throughput (docs/s) — per-document `store.add()` (one transaction
 *     per doc) vs bulk `store.rebuild(docs)` (a single transaction).
 *  3. Search latency (p50/p95/mean, ms) — strict / loose / prefix channels,
 *     plus the real `like_fallback` path (1–2 Thai-char query, validated by
 *     checking `meta.method === "like_fallback"` on the returned hits).
 *
 * The corpus is deterministic: fixed Thai paragraphs copied verbatim from
 * `README.th.md` (see POOL below), combined by a seeded PRNG so every run on
 * the same build produces byte-identical documents.
 *
 * Modes: --quick (N=500) | --full (N=3000, default). Override doc count with
 * `--n=<int>` or THAI_FTS_BENCH_N. Results land in benchmark/results/*.json.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const DIST = join(ROOT, "dist", "index.js");

if (!existsSync(DIST)) {
  console.error("thai-fts benchmark: dist/index.js not found — run `npm run build` first.");
  process.exit(1);
}

// Single bundle on purpose: dist/core + dist/fts5 each bundle their own copy
// of core, so importing both would give two independent module instances and
// forceSegmenter() would not reach the store's indexing path.
const {
  openFts5Store,
  fts5Search,
  forceSegmenter,
  resetSegmenter,
  getThaiSegmenterInfo,
  segmentForIndex,
  THAI_DEFAULT_WORDS,
} = await import(pathToFileURL(DIST).href);

// --- corpus ---------------------------------------------------------------
// Thai paragraphs copied verbatim from README.th.md (markdown syntax stripped).
const POOL = [
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

const SEED = 20261111;
const PREFIX_INDEX = [2, 3];

function mulberry32(a) {
  let s = a >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic document set: seeded picks of POOL paragraphs per doc. */
function buildDocs(n) {
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

function corpusBytes(docs) {
  let b = 0;
  for (const d of docs) b += Buffer.byteLength(d.title, "utf8") + Buffer.byteLength(d.body, "utf8");
  return b;
}

/** Seeded buffer of ~target bytes for the segmentation microbenchmark. */
function segBuffer(target) {
  const out = [];
  let bytes = 0;
  for (let i = 0; bytes < target; i++) {
    const p = POOL[i % POOL.length];
    out.push(p);
    bytes += Buffer.byteLength(p + " ", "utf8");
  }
  return out.join(" ");
}

// --- helpers --------------------------------------------------------------

const percentile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((x, y) => x + y, 0) / samples.length;
  return {
    p50_ms: +percentile(sorted, 0.5).toFixed(3),
    p95_ms: +percentile(sorted, 0.95).toFixed(3),
    mean_ms: +mean.toFixed(3),
    min_ms: +sorted[0].toFixed(3),
    max_ms: +sorted[sorted.length - 1].toFixed(3),
  };
}

// Mirrors search.ts's Thai-character counting (marks fold into their base),
// so the derived like_fallback query really does trip that path.
const THAI_MARK_RE = /[\u0E31\u0E34-\u0E3A\u0E47-\u0E4E]/;
function thaiCharCount(s) {
  let count = 0;
  let prevThai = false;
  for (const ch of s) {
    if (ch < "\u0E00" || ch > "\u0E7F") {
      prevThai = false;
      continue;
    }
    if (prevThai && THAI_MARK_RE.test(ch)) continue;
    count += 1;
    prevThai = true;
  }
  return count;
}

/** Multi-word Thai phrases sliced out of the corpus so every query hits. */
function buildQueries(docs, count) {
  const rnd = mulberry32(SEED + 5);
  const out = [];
  for (let i = 0; i < count; i++) {
    const d = docs[Math.floor(rnd() * docs.length)];
    const words = d.body.split(/\s+/).filter((w) => /[\u0E00-\u0E7F]/.test(w));
    if (words.length < 2) continue;
    const at = Math.floor(rnd() * (words.length - 1));
    out.push(`${words[at]} ${words[at + 1]}`);
  }
  return [...new Set(out)];
}

/**
 * Find a real 1–2 Thai-char query that reports `meta.method ===
 * "like_fallback"` and returns hits — never a placeholder.
 */
function findLikeFallbackQuery(store, docs) {
  const haystack = docs.map((d) => `${d.title}\n${d.body}`).join("\n");
  const cands = [...new Set(THAI_DEFAULT_WORDS)]
    .filter((w) => /^[\u0E00-\u0E7F\s]+$/.test(w) && thaiCharCount(w) > 0 && thaiCharCount(w) <= 2)
    .sort();
  for (const w of cands) {
    if (!haystack.includes(w)) continue;
    const hits = fts5Search(store, w, { limit: 10 });
    if (hits.length && hits[0].meta?.method === "like_fallback") {
      return { query: w, hits: hits.length, candidates: cands.length };
    }
  }
  throw new Error("no dictionary word triggered the like_fallback path");
}

// --- measurements ---------------------------------------------------------

function measureSegmentation(bytes, iters) {
  const buf = segBuffer(bytes);
  const target = Buffer.byteLength(buf, "utf8");
  const runs = {};
  for (const mode of ["intl", "dict"]) {
    if (mode === "dict") forceSegmenter(null);
    else resetSegmenter();
    const source = getThaiSegmenterInfo().source;
    segmentForIndex(buf);
    const t = performance.now();
    for (let i = 0; i < iters; i++) segmentForIndex(buf);
    const ms = (performance.now() - t) / iters;
    runs[mode] = {
      segmenter_source: source,
      mib_per_sec: +(target / (ms / 1000) / (1024 * 1024)).toFixed(2),
      ms_per_pass: +ms.toFixed(1),
    };
  }
  resetSegmenter();
  return { buffer_kib: +(target / 1024).toFixed(1), iterations: iters, ...runs };
}

function openStore() {
  return openFts5Store({ memory: true, prefix: PREFIX_INDEX });
}

function measureBulk(docs) {
  const store = openStore();
  try {
    const t = performance.now();
    store.rebuild(docs);
    const ms = performance.now() - t;
    return { ms: +ms.toFixed(0), docs_per_sec: +(docs.length / (ms / 1000)).toFixed(0) };
  } finally {
    store.close();
  }
}

function measurePerDoc(docs) {
  const store = openStore();
  try {
    const t = performance.now();
    for (const d of docs) store.add(d);
    const ms = performance.now() - t;
    return { ms: +ms.toFixed(0), docs_per_sec: +(docs.length / (ms / 1000)).toFixed(0) };
  } finally {
    store.close();
  }
}

function measureSearch(store, queries, opts, samples, warmup) {
  for (let i = 0; i < warmup; i++) fts5Search(store, queries[i % queries.length], opts);
  const lat = [];
  let hitsMin = Infinity;
  for (let i = 0; i < samples; i++) {
    const q = queries[i % queries.length];
    const t = performance.now();
    const res = fts5Search(store, q, opts);
    lat.push(performance.now() - t);
    hitsMin = Math.min(hitsMin, res.length);
  }
  return { ...stats(lat), hits_min: hitsMin === Infinity ? 0 : hitsMin };
}

// --- reporting ------------------------------------------------------------

function pad(s, w) {
  s = String(s);
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

function table(rows, headers) {
  const widths = headers.map((h, i) =>
    Math.max(String(h).length, ...rows.map((r) => String(r[i]).length))
  );
  const line = (cells) => "  " + cells.map((c, i) => pad(c, widths[i])).join("  ");
  const sep = "  " + widths.map((w) => "-".repeat(w)).join("  ");
  return [line(headers), sep, ...rows.map(line)].join("\n");
}

function parseArgs(argv) {
  const args = { mode: "full", n: null, help: false };
  for (const a of argv) {
    if (a === "--quick") args.mode = "quick";
    else if (a === "--full") args.mode = "full";
    else if (a.startsWith("--n=")) args.n = Number(a.slice(4));
    else if (a === "--help" || a === "-h") args.help = true;
    else if (!a.startsWith("-")) args.mode = a === "quick" ? "quick" : "full";
  }
  const envN = Number(process.env.THAI_FTS_BENCH_N);
  if (Number.isFinite(envN) && envN > 0) args.n = envN;
  if (process.env.THAI_FTS_BENCH_MODE === "quick") args.mode = "quick";
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      [
        "thai-fts benchmark",
        "  --quick          N=500 docs, fewer samples (~<15s)",
        "  --full           N=3000 docs (default, ~<60s)",
        "  --n=<int>        override document count",
        "  env THAI_FTS_BENCH_N / THAI_FTS_BENCH_MODE also work",
      ].join("\n")
    );
    return;
  }

  const quick = args.mode === "quick";
  const n = Number.isFinite(args.n) && args.n > 0 ? Math.trunc(args.n) : quick ? 500 : 3000;
  const segBytes = quick ? 256 * 1024 : 1024 * 1024;
  const segIters = quick ? 2 : 3;
  const samples = quick ? 60 : 250;
  const warmup = quick ? 15 : 40;

  const t0 = performance.now();
  const docs = buildDocs(n);
  const bytes = corpusBytes(docs);

  console.log(`\nthai-fts benchmark  mode=${args.mode}  docs=${n}  corpus=${(bytes / 1048576).toFixed(2)} MiB`);
  console.log(`node=${process.version}  platform=${process.platform}  segmenter=${getThaiSegmenterInfo().source}\n`);

  const seg = measureSegmentation(segBytes, segIters);
  console.log(
    table(
      [
        ["Intl.Segmenter", seg.intl.segmenter_source, seg.intl.mib_per_sec, seg.intl.ms_per_pass],
        ["dictionary fallback", seg.dict.segmenter_source, seg.dict.mib_per_sec, seg.dict.ms_per_pass],
      ],
      ["segmentation path", "source", "MiB/s", "ms/pass"]
    )
  );

  const bulk = measureBulk(docs);
  console.log(`\nindexing (bulk rebuild)   ${bulk.docs_per_sec} docs/s  (${bulk.ms} ms)`);
  const perDoc = measurePerDoc(docs);
  console.log(`indexing (per-doc add)    ${perDoc.docs_per_sec} docs/s  (${perDoc.ms} ms)`);

  const store = openStore();
  store.rebuild(docs);
  const queries = buildQueries(docs, 8);
  const like = findLikeFallbackQuery(store, docs);
  console.log(`\nqueries=${queries.length}  like_fallback query="${like.query}" hits=${like.hits}\n`);

  const sets = {
    strict: { opts: { tone: "strict", limit: 10 }, label: "strict" },
    loose: { opts: { tone: "loose", limit: 10 }, label: "loose" },
    prefix: { opts: { tone: "strict", limit: 10, prefix: true }, label: "prefix" },
    like_fallback: { opts: { tone: "both", limit: 10 }, label: "like_fallback", queries: [like.query] },
  };
  const search = {};
  for (const [key, cfg] of Object.entries(sets)) {
    const qs = cfg.queries ?? queries;
    search[key] = { label: cfg.label, queries: qs.length, ...measureSearch(store, qs, cfg.opts, samples, warmup) };
  }
  store.close();

  console.log(
    table(
      Object.entries(search).map(([k, s]) => [k, s.queries, samples, s.p50_ms, s.p95_ms, s.mean_ms, s.hits_min]),
      ["search set", "queries", "samples", "p50 ms", "p95 ms", "mean ms", "min hits"]
    )
  );

  const total_s = +((performance.now() - t0) / 1000).toFixed(1);
  console.log(`\ntotal ${total_s}s`);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(ROOT, "benchmark", "results");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `bench-${stamp}-${args.mode}.json`);
  writeFileSync(
    file,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        node: process.version,
        platform: process.platform,
        mode: args.mode,
        config: {
          docs: n,
          corpus_bytes: bytes,
          seed: SEED,
          prefix_index: PREFIX_INDEX,
          seg_buffer_kib: seg.buffer_kib,
          seg_iterations: seg.iterations,
          search_samples: samples,
          search_warmup: warmup,
        },
        segmentation: {
          buffer_kib: seg.buffer_kib,
          iterations: seg.iterations,
          intl: seg.intl,
          dict: seg.dict,
        },
        indexing: { bulk_rebuild: bulk, per_doc_add: perDoc },
        search: { like_fallback_query: like.query, sets: search },
        total_s,
      },
      null,
      2
    )
  );
  console.log(`wrote ${file.replace(ROOT + "\\", "")}`);
}

await main();
