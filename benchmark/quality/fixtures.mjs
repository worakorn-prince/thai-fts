/**
 * Synthetic retrieval-quality benchmark fixtures (TASK-018).
 *
 * Provenance: SYNTHETIC — hand-authored Thai fixtures, not real-world accuracy.
 *
 * Corpus = 150 deterministic bulk docs from benchmark/lib.mjs buildDocs(150)
 * + 30 hand-authored docs (string ids "h1".."h30"). Every relevant list is
 * computed deterministically from document text (substring containment), so
 * bulk-doc collisions are caught automatically — no hand-maintained id lists.
 */

import { buildDocs, POOL } from "../lib.mjs";

const BULK_COUNT = 150;
const bulk = buildDocs(BULK_COUNT);

// Canonical surface forms referenced by both docs and queries below. Tone-mark
// placement is fragile to type by hand, so every reference goes through these.
const DOC_INSTALL = "\u0E15\u0E34\u0E14\u0E15\u0E31\u0E49\u0E07";
const DOC_SETUP = "\u0E15\u0E31\u0E49\u0E07\u0E04\u0E48\u0E32";
const DOC_FILE = "\u0E44\u0E1F\u0E25\u0E4C";
const DOC_DATA = "\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25";
const DOC_USER = "\u0E1C\u0E39\u0E49\u0E43\u0E0A\u0E49";
const DOC_SEARCH = "\u0E04\u0E49\u0E19\u0E2B\u0E32";
const DOC_PAY = "\u0E0A\u0E33\u0E23\u0E30\u0E40\u0E07\u0E34\u0E19";
const DOC_ONLINE = "\u0E2D\u0E2D\u0E19\u0E44\u0E25\u0E19\u0E4C";
const DOC_CONFIRM = "\u0E22\u0E37\u0E19\u0E22\u0E31\u0E19";
const DOC_MSG = "\u0E02\u0E49\u0E2D\u0E04\u0E27\u0E32\u0E21";
const DOC_BACKUP = "\u0E2A\u0E33\u0E23\u0E2D\u0E07";

const HAND = [
  { id: "h1", title: "บัญชีผู้ใช้", body: "สร้างบัญชีผู้ใช้ใหม่ด้วยอีเมลและรหัสผ่านครั้งแรก" },
  { id: "h2", title: "ผู้ดูแลระบบ", body: "ผู้ดูแลระบบกำหนดสิทธิ์ผู้ใช้ในแต่ละบัญชีองค์กร" },
  { id: "h3", title: "อีเมลแจ้งเตือน", body: "ส่งอีเมลแจ้งเตือนเมื่อมีกิจกรรมในบัญชีผู้ใช้" },
  { id: "h4", title: "รหัสผ่านปลอดภัย", body: "ตั้งรหัสผ่านให้ยาวขึ้นและเปลี่ยนรหัสผ่านทุกสามเดือน" },
  { id: "h5", title: "การตั้งค่าเริ่มต้น", body: "การตั้งค่าเริ่มต้นของแอปปรับแก้ได้ตามใจผู้ใช้งาน" },
  { id: "h6", title: "ตั้งค่าการแจ้งเตือน", body: "ตั้งค่าการแจ้งเตือนแบบพุชหรือทางอีเมลก็ได้" },
  { id: "h7", title: "แก้ไขข้อมูลส่วนตัว", body: "แก้ไขข้อมูลส่วนตัวในหน้าโปรไฟล์ของบัญชีผู้ใช้" },
  { id: "h8", title: "โปรไฟล์ผู้ใช้", body: "โปรไฟล์แสดงชื่อและรูปภาพถ่ายของผู้ใช้แต่ละคน" },
  { id: "h9", title: "สัญญาเช่าสำนักงาน", body: "สัญญาเช่าสำนักงานแห่งใหม่จะหมดอายุในช่วงสิ้นปีนี้" },
  { id: "h10", title: "API key", body: "สร้าง API key สำหรับเชื่อมต่อระบบภายนอกเข้ากับแอป" },
  { id: "h11", title: "ไดรเวอร์เครื่องพิมพ์", body: "ไดรเวอร์เครื่องพิมพ์ต้องอัปเดตไดรเวอร์ก่อนใช้งานทุกครั้ง" },
  { id: "h12", title: "แคชเบราว์เซอร์", body: "ล้างแคชเบราว์เซอร์เมื่อโหลดหน้าเว็บได้ไม่สมบูรณ์" },
  { id: "h13", title: "สายสะพายหลัง", body: "สายสะพายหลังแบบผ้าทอระบายอากาศเหมาะกับเดินป่า" },
  { id: "h14", title: "ระบบชำระเงิน", body: "ระบบชำระเงินออนไลน์รองรับบัตรเครดิตและพร้อมเพย์" },
  { id: "h15", title: "ชำระเงินปลายทาง", body: "ลูกค้าเลือกชำระเงินปลายทางได้ทุกคำสั่งซื้อ" },
  { id: "h16", title: "ชำระเงินออนไลน์", body: "ช่องทางชำระเงินออนไลน์ผ่าน Mobile Banking" },
  { id: "h17", title: "ซื้อขายออนไลน์", body: "ซื้อของออนไลน์อย่างปลอดภัยด้วยรหัสยืนยันตัวตน" },
  { id: "h18", title: "ส่งข้อความยืนยัน", body: "ส่งข้อความยืนยันคำสั่งซื้อไปยังลูกค้าทันที" },
  { id: "h19", title: "ยืนยันตัวตนสองชั้น", body: "ยืนยันตัวตนด้วยรหัสชั่วคราวก่อนเข้าสู่ระบบทุกครั้ง" },
  { id: "h20", title: "แมวและสุนัข", body: "แมวต้องการพื้นที่ปีนป่ายและของเล่นเสริมทักษะ" },
  { id: "h21", title: "ลาและม้า", body: "ลาและม้าเลี้ยงรวมกันได้ในทุ่งกว้างริมภูเขา" },
  { id: "h22", title: "บริษัทขนส่ง", body: "บริษัทขยายสาขาในปีหน้าเพื่อรองรับยอดขายที่เติบโต" },
  { id: "h23", title: "ร้านเช่ายืมดีวีดี", body: "ร้านเช่ายืมดีวีดีหนังเก่าราคากับโปรโมชั่นดี ๆ" },
  { id: "h24", title: "สำรองข้อมูล", body: "สำรองข้อมูลขึ้นคลาวด์อัตโนมัติทุกเที่ยงคืน" },
  { id: "h25", title: "ข้อมูลลูกค้า", body: "ข้อมูลลูกค้าถูกเข้ารหัสเก็บไว้เสมอตามมาตรฐาน" },
  { id: "h26", title: "รายงานประจำสัปดาห์", body: "รายงานประจำสัปดาห์สรุปยอดขายและสถานะการเงิน" },
  { id: "h27", title: "กู้คืนไฟล์", body: "กู้คืนไฟล์ที่ลบผิดกลับมาจากถังขยะภายในเจ็ดวัน" },
  { id: "h28", title: "ผู้ดูแลคลังสินค้า", body: "ผู้ดูแลคลังสินค้าตรวจนับสต๊อกสินค้าทุกเช้า" },
  { id: "h29", title: "เอกสารราชการ", body: "เอกสารราชการต้องประทับตราและลงลายมือชื่อผู้มีอำนาจ" },
  { id: "h30", title: "ระบบฐานข้อมูล", body: "ระบบฐานข้อมูลหลักล่มเมื่อเซิร์ฟเวอร์หยุดทำงานกะทันหัน" },
];

export const DOCS = [...bulk, ...HAND];

const text = (d) => `${d.title} ${d.body}`;
const cmpId = (a, b) => String(a).localeCompare(String(b), "en", { numeric: true });
const sortIds = (ids) => [...new Set(ids)].sort(cmpId);

/** Docs whose raw text contains every given term (substring containment). */
function idsWith(...terms) {
  return sortIds(DOCS.filter((d) => terms.every((t) => text(d).includes(t))).map((d) => d.id));
}

/** Union of docs matching any of several surface forms. */
function idsUnion(...termLists) {
  return sortIds(termLists.flat().flatMap((t) => idsWith(t)));
}

// looseForm() strips these marks — a query typed without them is the canonical
// tone-typo the loose channel is documented to rescue.
const TONE_MARKS = /[\u0E48\u0E49\u0E4A\u0E4B\u0E4C\u0E4D]/g;
const typo = (s) => s.replace(TONE_MARKS, "");

export const QUERIES = [
  // --- exact: correctly-spelled terms, strict should work -------------------
  { id: "q-exact-1", text: "ฐานข้อมูล", mode: "both", category: "exact", relevant: idsWith("ฐานข้อมูล"), grades: { h30: 2 } },
  { id: "q-exact-2", text: "ค้นหา", mode: "strict", category: "exact", relevant: idsWith("ค้นหา") },
  { id: "q-exact-3", text: "บัญชีผู้ใช้", mode: "both", category: "exact", relevant: idsWith("บัญชีผู้ใช้"), grades: { h1: 2 } },
  { id: "q-exact-4", text: "อีเมล", mode: "both", category: "exact", relevant: idsWith("อีเมล"), grades: { h3: 2, h1: 1 } },
  { id: "q-exact-5", text: "รหัสผ่าน", mode: "strict", category: "exact", relevant: idsWith("รหัสผ่าน") },
  { id: "q-exact-6", text: "ค่าเริ่มต้น", mode: "both", category: "exact", relevant: idsWith("ค่าเริ่มต้น") },
  { id: "q-exact-7", text: "กู้คืน", mode: "both", category: "exact", relevant: idsWith("กู้คืน"), grades: { h27: 2 } },

  // --- tone_typo: query drops tone marks loose strips ------------------------
  { id: "q-tone-1", text: typo(DOC_INSTALL), mode: "both", category: "tone_typo", relevant: idsUnion(DOC_INSTALL, typo(DOC_INSTALL)) },
  { id: "q-tone-2", text: typo(DOC_SETUP), mode: "both", category: "tone_typo", relevant: idsUnion(DOC_SETUP, typo(DOC_SETUP)) },
  { id: "q-tone-3", text: typo(DOC_FILE), mode: "both", category: "tone_typo", relevant: idsUnion(DOC_FILE, typo(DOC_FILE)) },
  { id: "q-tone-4", text: typo(DOC_DATA), mode: "both", category: "tone_typo", relevant: idsUnion(DOC_DATA, typo(DOC_DATA)) },
  { id: "q-tone-5", text: typo(DOC_USER), mode: "both", category: "tone_typo", relevant: idsUnion(DOC_USER, typo(DOC_USER)) },
  { id: "q-tone-6", text: typo(DOC_SEARCH), mode: "both", category: "tone_typo", relevant: idsUnion(DOC_SEARCH, typo(DOC_SEARCH)) },

  // --- mixed_lang: Thai docs carrying English tokens / loanwords -------------
  { id: "q-mixed-1", text: "deploy", mode: "both", category: "mixed_lang", relevant: idsWith("deploy") },
  { id: "q-mixed-2", text: "install", mode: "strict", category: "mixed_lang", relevant: idsWith("install") },
  { id: "q-mixed-3", text: "API key", mode: "both", category: "mixed_lang", relevant: idsWith("API key") },
  { id: "q-mixed-4", text: "ไดรเวอร์", mode: "both", category: "mixed_lang", relevant: idsWith("ไดรเวอร์") },
  { id: "q-mixed-5", text: "แคช", mode: "both", category: "mixed_lang", relevant: idsWith("แคช") },

  // --- word_order: both terms present, any order is relevant -----------------
  { id: "q-order-1", text: `${DOC_PAY} ${DOC_ONLINE}`, mode: "both", category: "word_order", relevant: idsWith(DOC_PAY, DOC_ONLINE) },
  { id: "q-order-2", text: `${DOC_MSG} ${DOC_CONFIRM}`, mode: "both", category: "word_order", relevant: idsWith(DOC_MSG, DOC_CONFIRM) },
  { id: "q-order-3", text: `${DOC_BACKUP} ${DOC_DATA}`, mode: "both", category: "word_order", relevant: idsWith(DOC_BACKUP, DOC_DATA) },

  // --- short_query: 1-2 chars, like_fallback raw-substring scan --------------
  { id: "q-short-1", text: "ลา", mode: "both", category: "short_query", relevant: idsWith("ลา") },
  { id: "q-short-2", text: "ดี", mode: "both", category: "short_query", relevant: idsWith("ดี") },
  { id: "q-short-3", text: "ปี", mode: "both", category: "short_query", relevant: idsWith("ปี") },
  { id: "q-short-4", text: "แมว", mode: "both", category: "short_query", relevant: idsWith("แมว") },

  // --- bulk_distractor: verbatim POOL slices, bulk docs dominate -------------
  { id: "q-bulk-1", text: POOL[2].slice(0, 14), mode: "both", category: "bulk_distractor", relevant: idsWith(POOL[2].slice(0, 14)) },
  { id: "q-bulk-2", text: POOL[16].slice(0, 16), mode: "both", category: "bulk_distractor", relevant: idsWith(POOL[16].slice(0, 16)) },
  { id: "q-bulk-3", text: POOL[24].slice(0, 14), mode: "both", category: "bulk_distractor", relevant: idsWith(POOL[24].slice(0, 14)) },
  { id: "q-bulk-4", text: POOL[33].slice(0, 16), mode: "both", category: "bulk_distractor", relevant: idsWith(POOL[33].slice(0, 16)) },
  { id: "q-bulk-5", text: POOL[41].slice(0, 14), mode: "both", category: "bulk_distractor", relevant: idsWith(POOL[41].slice(0, 14)) },
];

export const FIXTURES = {
  provenance: "SYNTHETIC — hand-authored Thai fixtures, not real-world accuracy",
  docs: DOCS,
  queries: QUERIES,
};
