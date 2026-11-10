/**
 * Zero-dependency Thai lexical utilities: word segmentation for unspaced Thai,
 * a tone-tolerant `looseForm`, and Thai detection. Pure — imports no Node
 * built-in modules, no database, no npm packages. This is the single source of
 * truth for
 * Thai lexical handling in thai-fts and stays dependency-free so every
 * subpath/engine can import it without dragging in anything else.
 *
 * ```ts
 * import { hasThai, segmentForIndex, looseForm, wordTokens } from "thai-fts";
 * hasThai("ติดตั้งโปรแกรม");        // → true
 * hasThai("hello world");           // → false
 * looseForm("ติดตั้ง");              // → "ติดตัง" (tone marks stripped)
 * wordTokens("ติดตั้งโปรแกรม");      // → ≥2 tokens that rejoin to the input
 * segmentForIndex("ติดตั้ง");        // → " ติด ตั้ง " (space-delimited run)
 * ```
 *
 * `wordTokens`/`segmentForIndex` prefer `Intl.Segmenter` (full ICU) and fall
 * back to a built-in dict + syllable heuristic on small-icu runtimes — the
 * exact token split differs by runtime, but tokens never drop characters.
 *
 * Thai is written without spaces between words, and SQLite's default FTS5
 * tokenizer (unicode61) treats Thai combining marks as separators — so the
 * two-sided fix is: `segmentForIndex()` inserts spaces between words at index
 * time, and `buildFtsMatch()` (query.ts) turns each Thai query chunk into an
 * ordered FTS5 phrase of its words at query time. With a mark-aware tokenizer
 * the tone marks stay significant, so "ติดตัง" never collides with "ติดตั้ง".
 */

const THAI_RE = /[\u0E00-\u0E7F]/;
const THAI_RUN_RE = /[\u0E00-\u0E7F]+/g;

// Tone-level marks only, dropped by looseForm(): ่ ้ ๊ ๋ (U+0E48..U+0E4B) are
// the four English-tone marks; ์ (U+0E4C, thanthakhat) is the cancellation
// sign (drop the mark, keep the consonant); ํ (U+0E4D, nikhahit) sits at the
// same level. Vowel marks (เ แ โ ใ ไ ำ ิ ี ึ ื ุ ู ะ ั ็ ...) are NOT in this
// class — looseForm keeps vowels intact and only strips tone-level marks.
const THAI_TONE_MARK_RE = /[\u0E48\u0E49\u0E4A\u0E4B\u0E4C\u0E4D]/g;

// Zero-width / format characters stripped by `normalizeThaiInput` so hidden
// characters can never split a Thai word or a Latin token: U+200B ZERO WIDTH
// SPACE, U+200C ZERO WIDTH NON-JOINER, U+200D ZERO WIDTH JOINER and U+FEFF
// BYTE ORDER MARK / ZERO WIDTH NO-BREAK SPACE. Deliberately minimal — only
// these four are removed; everything else passes through untouched.
const ZERO_WIDTH_RE = /[\u200B\u200C\u200D\uFEFF]/g;

/**
 * Normalize Thai (and mixed) input before lexical processing: Unicode NFC
 * canonical composition first, then strip the four zero-width/format
 * characters (U+200B U+200C U+200D U+FEFF) that otherwise behave like
 * separators and split a Thai run or a Latin token mid-word.
 *
 * The transform is an idempotent fixed point: NFC of an NFC string is the same
 * string, and every zero-width char is removed in a single pass, so applying it
 * again is a no-op. Because it runs *before* the Thai-run regex, a zero-width
 * character embedded inside a Thai word no longer splits it — index and query
 * sides both call it, keeping them symmetric.
 *
 * Non-Thai text is effectively unchanged: NFC composition is ASCII/UTF-16
 * No-op-agnostic for Latin, and there are no zero-width chars to strip, so
 * pure-Latin passthrough keeps its exact bytes.
 */
export function normalizeThaiInput(text: string): string {
  return String(text ?? "").normalize("NFC").replace(ZERO_WIDTH_RE, "");
}

interface SegmentLike {
  segment: string;
  isWordLike?: boolean;
}
type Segmenter = { segment(text: string): Iterable<SegmentLike> };

/**
 * Validates a candidate custom segmenter at the API boundary. A segmenter must
 * be a non-null object exposing a `.segment(text)` function that returns an
 * iterable of `{ segment, isWordLike? }` records (`Intl.Segmenter`'s own shape).
 * Throws a clear TypeError otherwise so misconfiguration fails fast.
 */
function assertSegmenter(segmenter: unknown): asserts segmenter is Segmenter {
  const ok =
    segmenter !== null &&
    typeof segmenter === "object" &&
    typeof (segmenter as { segment?: unknown }).segment === "function";
  if (!ok) {
    throw new TypeError(
      "setThaiSegmenter: expected a segmenter object implementing { segment(text) -> iterable of { segment, isWordLike? } }, got " +
        (segmenter === null ? "null" : typeof segmenter)
    );
  }
}

let cached: Segmenter | null | undefined;

/**
 * Public custom segmenter set via `setThaiSegmenter`. `undefined` = none set
 * (auto-detection); a non-null object = that segmenter is in use; the value is
 * never stored as `null` because passing `null` to `setThaiSegmenter` restores
 * auto-detection instead of forcing the dictionary fallback.
 */
let custom: Segmenter | undefined;

/**
 * @internal test hook — when set, `getSegmenter()` returns it verbatim and
 * skips auto-detection (including the public custom slot).
 */
let forced: Segmenter | null | undefined;

function getSegmenter(): Segmenter | null {
  if (forced !== undefined) return forced;
  if (custom !== undefined) return custom;
  if (cached !== undefined) return cached;
  try {
    const Ctor = (
      Intl as unknown as {
        Segmenter?: new (
          locale: string,
          opts: { granularity: "word" }
        ) => Segmenter;
      }
    ).Segmenter;
    cached = typeof Ctor === "function" ? new Ctor("th", { granularity: "word" }) : null;
  } catch {
    cached = null;
  }
  return cached;
}

/**
 * @internal Force the module to segment with a specific segmenter, or pass
 * `null` to exercise the built-in dictionary fallback. Never blocks the default
 * Intl.Segmenter path on real runtimes: pairs with `resetSegmenter()` and is
 * only meaningful inside tests.
 */
export function forceSegmenter(seg: Segmenter | null): void {
  forced = seg;
  cached = undefined;
}

/** @internal Undo `forceSegmenter()` and resume Intl.Segmenter auto-detection. */
export function resetSegmenter(): void {
  forced = undefined;
  cached = undefined;
}

/**
 * Public seam to plug in an external Thai segmenter (e.g. a wasm attacut
 * wrapper or PyThaiNLP RPC bridge) that implements `Intl.Segmenter`'s shape:
 *
 * ```ts
 * setThaiSegmenter({
 *   segment(text) {
 *     return [{ segment: text, isWordLike: true }]; // per-word records
 *   },
 * });
 * ```
 *
 * `wordTokens`/`segmentForIndex`/`segmentQueryChunk` all route through this
 * segmenter. Passing `null` restores auto-detection (`Intl.Segmenter` when the
 * runtime provides it, otherwise the built-in dictionary fallback). Works even
 * after the module already cached a segmenter — the cache is invalidated, so
 * re-calling it with a different segmenter also takes effect immediately.
 *
 * @throws {TypeError} when `segmenter` is not `null` and does not implement
 *   `{ segment(text): Iterable<{ segment, isWordLike? }> }`.
 */
export function setThaiSegmenter(segmenter: Segmenter | null): void {
  if (segmenter !== null) assertSegmenter(segmenter);
  custom = segmenter ?? undefined;
  cached = undefined;
}

/**
 * Introspection for debugging/docs: which segmenter is powering Thai
 * segmentation right now.
 *
 * `source` is:
 * - `"custom"` — a segmenter set via `setThaiSegmenter()` is in use;
 * - `"intl"` — `Intl.Segmenter` auto-detection is in use;
 * - `"dict"` — the built-in dictionary + syllable fallback is in use
 *   (no `Intl.Segmenter` on this runtime, or `forceSegmenter(null)` in tests);
 * - `"none"` — reserved for a future runtime with neither (today the
 *   dictionary fallback always guarantees at least `"dict"`).
 *
 * `hasSegmenter` is `true` when a real segmenter object (custom or Intl) is in
 * play and `false` when segmentation falls back to the dictionary.
 */
export function getThaiSegmenterInfo(): {
  source: "intl" | "custom" | "dict" | "none";
  hasSegmenter: boolean;
} {
  if (forced !== undefined) {
    return { source: forced === null ? "dict" : "custom", hasSegmenter: forced !== null };
  }
  if (custom !== undefined) return { source: "custom", hasSegmenter: true };
  const seg = getSegmenter();
  if (seg === null) return { source: "dict", hasSegmenter: false };
  return { source: "intl", hasSegmenter: true };
}

// --- built-in dictionary fallback (small-icu runtimes) ---

// Curated, deterministic longest-match dictionary. The dev/tech + command
// cluster (kept as-is) is extended with general everyday vocabulary
// (numbers, time, people, family, body, food, animals, nature, direction,
// colors, feelings, places, daily verbs), plus curated legal seeds and
// literary seeds. Entries are stored with their real tone marks because the
// fallback runs on raw (un-de-accented) text; tone tolerance is
// `looseForm()`'s job.
export const THAI_DEFAULT_WORDS = [
  // dev / tech / infrastructure
  "ระบบ", "เซิร์ฟเวอร์", "ฐานข้อมูล", "ข้อมูล", "ความจำ", "หน่วยความจำ",
  "โปรแกรม", "แอปพลิเคชัน", "แอป", "ไฟล์", "โฟลเดอร์", "โค้ด",
  "ฟังก์ชัน", "คลาส", "เมธอด", "ตัวแปร", "โมดูล", "มอดูล",
  "สตริง", "อาร์เรย์", "แพ็กเกจ", "แพ็กเก็ต", "ไลบรารี", "รันไทม์",
  "เวอร์ชัน", "สคริปต์", "เอพีไอ", "เอ็นจิน", "คีย์", "ค่า",
  "โทเคน", "ตาราง", "คอลัมน์", "แถว", "ดัชนี", "สคีมา",
  "เคียวรี", "ควิวรี", "ทรานแซกชัน", "เครือข่าย", "อินเทอร์เน็ต", "เบราว์เซอร์",
  "เว็บไซต์", "รหัสผ่าน", "ผู้ใช้", "บัญชี", "อีเมล", "ล็อก",
  "ล็อกอิน", "ดีบั๊ก", "บั๊ก", "บัค", "โอเพนซอร์ส", "เดสก์ท็อป",
  "โมบาย", "คลาวด์", "โปรเซส", "เธรด", "พาร์เซอร์", "คอมไพเลอร์",
  "ลิงก์", "แมป", "เครื่องมือ", "ภาษา", "พร้อม", "รองรับ",
  // commands / actions
  "ติดตั้ง", "ถอนการติดตั้ง", "ติดตัง", "เปิดใช้งาน", "ปิดใช้งาน",
  "อัปเดต", "อัปเกรด", "ดาวน์เกรด", "ดาวน์โหลด", "อัปโหลด",
  "กู้คืน", "สำรอง", "บันทึก", "ลบ", "แก้ไข", "สร้าง",
  "เขียน", "อ่าน", "ค้นหา", "กรอง", "เรียง", "จัดเรียง",
  "เชื่อมต่อ", "แยก", "รวม", "เพิ่ม", "ลด", "คูณ",
  "หาร", "บวก", "ส่ง", "รับ", "เปิด", "ปิด",
  "หยุด", "พัก", "ต่อ", "ข้าม", "ยกเลิก", "กด",
  "คลิก", "พิมพ์", "ใส่", "แทรก", "คัดลอก", "วาง",
  "ย้าย", "เปลี่ยน", "แปลง", "แปล", "รัน", "เทสต์",
  "ทดสอบ", "เรียก", "เรียกใช้", "แสดง", "ซ่อน", "ตรวจ",
  "ตรวจสอบ", "ตั้งค่า", "กำหนด", "อนุญาต", "ปฏิเสธ", "เริ่ม",
  "เริ่มต้น", "คืนค่า", "รีเซ็ต", "เรียนรู้", "จำ", "ทำงาน",
  "พยายาม", "ลอง", "ต้องการ", "อยากได้", "เข้าใจ", "ตอบ",
  "ถาม", "ช่วย", "ดีพลอย",
  // generic common words
  "เวลา", "งาน", "คน", "วัน", "ศุกร์", "บ่าย",
  "โมง", "สาม", "หลัง", "ใหม่", "เก่า", "เร็ว",
  "ช้า", "ดี", "ง่าย", "ยาก", "ใหญ่", "เล็ก",
  "มาก", "น้อย", "ทุก", "บาง", "เสร็จ", "การ",
  "ของ", "และ", "หรือ", "ที่", "ให้", "ไม่",
  "ใน", "มี", "คือ", "ไป", "มา", "ด้วย",
  "อะไร", "ทำ", "เป็น", "อยู่", "จาก", "กับ",
  "ว่า", "นี้", "นั้น", "โดย", "ครับ", "ค่ะ",
  "ต้อง", "ยัง", "เพื่อ", "แบบ", "นะ", "เลย",
  "ก็", "แต่", "ถ้า", "ผม", "ฉัน", "คุณ",
  "เรา", "เขา", "มัน", "ใช้", "ข้าว", "ผัด",
  "อร่อย", "แมว", "กิน", "ปลา", "น้ำ", "บ้าน",
  "เมือง", "เพื่อน", "ร้าน", "เงิน", "บริการ", "รายเดือน",
  "อาหาร", "ทะเล", "นั่ง", "กลางวัน", "ดื้อ", "ยอม",
  "ฟัง", "ใคร", "แพ้", "เผ็ด",

  // numbers & quantities
  "ศูนย์", "หนึ่ง", "สอง", "สี่", "ห้า", "หก",
  "เจ็ด", "แปด", "เก้า", "สิบ", "ยี่สิบ", "สามสิบ",
  "สี่สิบ", "ห้าสิบ", "ร้อย", "พัน", "หมื่น", "แสน",
  "ล้าน", "ครึ่ง", "คู่", "เดี่ยว", "เดียว", "เท่า",
  "เท่ากับ", "มากกว่า", "น้อยกว่า", "ครึ่งหนึ่ง", "หนึ่งเดียว",
  // time
  "เช้า", "สาย", "เที่ยง", "เย็น", "ค่ำ", "กลางคืน",
  "เที่ยงคืน", "เที่ยงวัน", "ตอนเช้า", "ตอนเย็น", "กลางดึก", "รุ่งเช้า",
  "ยามเช้า", "ยามเย็น", "พรุ่งนี้", "มะรืน", "เมื่อวาน", "วานนี้",
  "วันนี้", "วันวาน", "วันพรุ่งนี้", "อาทิตย์", "จันทร์", "อังคาร",
  "พุธ", "พฤหัสบดี", "เสาร์", "เดือน", "ปี", "สัปดาห์",
  "นาที", "วินาที", "ชั่วโมง", "ปัจจุบัน", "อดีต", "อนาคต",
  "ทันที", "ภายหลัง", "ต่อมา", "ก่อนหน้า", "บ่อย", "บ่อยครั้ง",
  "เสมอ", "บางครั้ง", "บางที", "นาน", "เนิ่นนาน", "ชั่วครู่",
  "เดี๋ยว", "ตลอด", "ต่อเนื่อง", "ช่วง", "ระยะ", "ตอน",
  "ต้นเดือน", "กลางเดือน", "ปลายเดือน",
  "วันอาทิตย์", "วันจันทร์", "วันอังคาร", "วันพุธ", "วันพฤหัสบดี", "วันศุกร์", "วันเสาร์",

  // pronouns & people
  "เธอ", "ท่าน", "ทุกคน", "ตัวเอง", "ตัวฉัน", "ตัวคุณ",
  "บางคน", "พวกเขา", "พวกเรา", "นักเรียน", "นักศึกษา", "อาจารย์",
  "ครู", "หมอ", "พยาบาล", "ตำรวจ", "ทหาร", "ประชาชน",
  "ชาวบ้าน", "เพื่อนบ้าน", "เพื่อนร่วมงาน", "ลูกค้า", "ผู้ซื้อ", "ผู้ขาย",
  "เจ้าของ", "ผู้จัดการ", "พนักงาน", "ประชากร", "ผู้ใหญ่", "เด็ก",
  "ผู้หญิง", "ผู้ชาย", "ชาย", "หญิง", "นักกีฬา", "นักร้อง",
  "นักแสดง", "นักเขียน", "ศิลปิน", "ช่าง", "พ่อครัว", "ผู้นำ",
  // family
  "พ่อ", "แม่", "พี่", "น้อง", "ปู่", "ย่า",
  "ตา", "ยาย", "ลุง", "ป้า", "น้า", "อา",
  "ลูก", "หลาน", "สามี", "ภรรยา", "ครอบครัว", "ญาติ",
  "พี่ชาย", "พี่สาว", "น้องชาย", "น้องสาว", "ลูกชาย", "ลูกสาว",
  "ลูกสะใภ้", "ลูกเขย", "พ่อตา", "แม่ยาย", "เชื้อสาย",
  "วงศ์ตระกูล",
  // body
  "ศีรษะ", "หัว", "ขน",
  "หู", "จมูก", "ปาก", "ฟัน", "ลิ้น", "คาง",
  "แก้ม", "คิ้ว", "หน้าผาก", "คอ", "ไหล่", "แขน",
  "มือ", "นิ้ว", "ฝ่ามือ", "ข้อมือ", "อก", "ท้อง",
  "สะโพก", "ขา", "เข่า", "เท้า", "ส้นเท้า", "หัวใจ",
  "ปอด", "ตับ", "ไต", "กระเพาะ", "ลำไส้", "สมอง",
  "กระดูก", "กล้ามเนื้อ", "ผิวหนัง", "เลือด", "เนื้อ", "ตัว",
  "ร่างกาย", "เอว", "หน้าแข้ง",

  // food & drink
  "ผัก", "ผลไม้", "เนื้อหมู", "เนื้อวัว", "เนื้อไก่", "ไข่",
  "นม", "เนย", "เกลือ", "ซอส", "น้ำปลา",
  "น้ำมัน", "พริก", "กระเทียม", "หัวหอม", "ขิง", "ตะไคร้",
  "ใบมะกรูด", "มะนาว", "มะพร้าว", "กล้วย", "มะม่วง", "ส้ม",
  "แอปเปิล", "องุ่น", "ทุเรียน", "มังคุด", "เงาะ", "ลำไย",
  "ขนุน", "ขนม", "ขนมปัง", "เค้ก", "ชา", "กาแฟ",
  "น้ำแข็ง", "เครื่องดื่ม", "ก๋วยเตี๋ยว", "ผัดไทย", "ส้มตำ", "ต้มยำ",
  "แกงเขียวหวาน", "แกงเผ็ด", "ข้าวผัด", "ข้าวต้ม", "ข้าวมันไก่", "ไข่เจียว",
  "ไข่ดาว", "ไก่ย่าง", "สลัด", "ซุป", "ต้มจืด", "ข้าวเหนียว",
  "เส้นหมี่", "วุ้นเส้น", "ข้าวโพด", "ถั่ว", "แป้ง", "กับข้าว",
  "ของหวาน", "ของว่าง", "อาหารเช้า", "อาหารกลางวัน", "อาหารเย็น", "เครื่องปรุง",
  "ใบโหระพา", "สะระแหน่", "แตงกวา", "มะเขือเทศ", "ฟักทอง", "บวบ",
  // animals
  "หมา", "สุนัข", "วัว", "ควาย", "หมู", "ไก่",
  "เป็ด", "ห่าน", "นก", "แมลง", "มด", "ผึ้ง",
  "แมงมุม", "กุ้ง", "ปู", "ปลาหมึก", "หอย", "กบ",
  "คางคก", "เต่า", "งู", "จระเข้", "กิ้งก่า", "หนู",
  "กระต่าย", "ช้าง", "เสือ", "สิงโต", "เสือโคร่ง", "เสือดาว",
  "แรด", "ยีราฟ", "ม้าลาย", "ม้า", "อูฐ", "กวาง",
  "ค้างคาว", "นกฮูก", "นกแก้ว", "นกพิราบ", "นกกระจอก", "หงส์",
  "ผีเสื้อ", "จิ้งหรีด", "ปลวก", "แมลงสาบ", "ยุง", "แมลงวัน",
  "งูเหลือม", "งูเห่า", "ตะขาบ", "กุ้งฝอย", "ปลาไหล", "ลิง",
  // nature & environment
  "ป่า", "ภูเขา", "แม่น้ำ", "ลำธาร", "คลอง", "บึง",
  "หนอง", "ทุ่งนา", "นาข้าว", "ไพร", "สวน", "ต้นไม้",
  "ใบไม้", "ดอกไม้", "หญ้า", "ราก", "ลำต้น", "กิ่ง",
  "พืช", "ดิน", "ทราย", "โคลน", "หิน", "ศิลา",
  "ท้องฟ้า", "ดาว", "ดวงจันทร์", "พระจันทร์", "พระอาทิตย์", "แสงแดด",
  "แดด", "รุ้ง", "หมอก", "น้ำค้าง", "ฝน", "หิมะ",
  "ลม", "พายุ", "ฟ้าร้อง", "ฟ้าผ่า", "ฟ้าแลบ", "พายุฝน",
  "น้ำท่วม", "ภัยแล้ง", "แผ่นดินไหว", "ธรรมชาติ", "สิ่งแวดล้อม", "ระบบนิเวศ",
  "อากาศ", "ภูมิอากาศ", "ป่าไม้",
  // weather & temperature
  "ร้อน", "หนาว", "อบอุ่น", "ชื้น", "แห้ง", "ฝนตก",
  "แดดจัด", "มืดครึ้ม", "ปลอดโปร่ง",

  // directions & positions
  "เหนือ", "ใต้", "ออก", "ตก", "ตะวันออก", "ตะวันตก",
  "ทิศ", "ซ้าย", "ขวา", "บน", "ล่าง",
  "นอก", "ข้าง", "ข้างใน", "ข้างนอก", "ฝั่ง", "กลาง",
  "ตรงกลาง", "ริม", "ขอบ", "มุม", "ปลาย", "เชิง",
  "ยอด", "ฐาน", "ก้น", "ลึก", "ตื้น", "สูง",
  "ต่ำ", "ไกล", "ใกล้", "ที่นี่", "ที่นั่น", "ที่ไหน",
  "ทาง", "ด้าน", "ต้น", "ท้าย",
  // colors
  "แดง", "ชมพู", "เหลือง", "เขียว", "น้ำเงิน",
  "ฟ้า", "ม่วง", "เทา", "ดำ", "ขาว",
  "ครีม", "ทอง", "สี", "สีสัน", "เข้ม", "จาง",
  "สว่าง", "มืด", "หลากสี",
  // feelings & emotions
  "ดีใจ", "เสียใจ", "สุขใจ", "ทุกข์ใจ", "สนุก", "เบื่อ",
  "เหนื่อย", "เพลีย", "สบายใจ", "ท้อ", "แค้น", "โกรธ",
  "เกลียด", "รัก", "ชอบ", "กลัว", "กังวล", "ห่วง",
  "ตื่นเต้น", "ตกใจ", "อาย", "เขิน", "อิจฉา", "สงสาร",
  "สงบใจ", "ใจเย็น", "ใจร้อน", "อารมณ์ดี", "อารมณ์เสีย", "หงุดหงิด",
  "ร้องไห้", "หัวเราะ", "ยิ้ม", "ยิ้มแย้ม", "เหงา", "เศร้า",
  "คิดถึง", "ปลื้ม", "พอใจ", "ผิดหวัง", "สมหวัง", "เจ็บใจ",
  "คับแค้น", "ทุกข์", "ทุกข์ร้อน",
  // abstract nouns
  "ความคิด", "ความจริง", "ความหมาย", "ความสุข", "ความทุกข์", "ความรัก",
  "ความกลัว", "ความหวัง", "ความฝัน", "เป้าหมาย", "จุดประสงค์", "วัตถุประสงค์",
  "เหตุผล", "หลักการ", "กฎเกณฑ์", "แนวคิด", "มุมมอง", "ความเห็น",
  "ความรู้สึก", "ประสบการณ์", "โอกาส", "ปัญหา", "ทางออก", "ทางแก้",
  "ความเชื่อ", "ความคิดสร้างสรรค์", "แรงบันดาลใจ", "แรงใจ", "กำลังใจ",
  "โชค", "เคราะห์", "บุญ", "บาป", "กรรม", "ชะตา", "วาสนา",

  // descriptive adjectives
  "สวย", "หล่อ", "น่ารัก", "เก่ง", "ฉลาด", "โง่",
  "ขยัน", "เกียจคร้าน", "ขี้เกียจ", "ซื่อสัตย์", "จริงใจ", "ใจดี",
  "ใจร้าย", "ใจกว้าง", "ใจแคบ", "เงียบ", "ดัง", "ค่อย",
  "นิ่ง", "วุ่นวาย", "สงบ", "เรียบร้อย", "สะอาด", "สกปรก",
  "สดใส", "มืดมน",
  // question words & connector particles
  "ทำไม", "อย่างไร", "ยังไง", "เมื่อไหร่", "เท่าไหร่", "กี่",
  "ไหน", "ไหม", "มั้ย", "หรอ", "รึ",
  "หรือเปล่า", "สิ", "หน่อย", "เถอะ", "ละ", "นะคะ",
  "คะ",
  // connectives & prepositions
  "ภายใน", "ภายนอก", "ระหว่าง", "ตาม", "ด้วยกัน",
  "จน", "จนกระทั่ง", "ตั้งแต่", "จนกว่า", "เว้นแต่", "นอกจาก",
  "นอกเหนือ", "แม้", "แม้แต่", "แม้กระทั่ง", "ทั้ง", "ทั้งหมด",
  "ทั้งสิ้น", "ต่าง", "เช่น", "ประมาณ", "เกือบ",
  "ราว", "เฉพาะ", "เท่านั้น", "เอง", "หาก", "ถึงแม้",
  "ทั้งนี้", "ฉะนั้น", "ดังนั้น", "จึง", "ย่อม", "คง",
  "น่าจะ", "อาจ",
  // places
  "ตลาด", "โรงพยาบาล", "คลินิก", "ร้านยา", "ร้านอาหาร", "ร้านกาแฟ",
  "ร้านสะดวกซื้อ", "ห้างสรรพสินค้า", "ซูเปอร์มาร์เก็ต", "ไปรษณีย์", "ธนาคาร", "สถานีตำรวจ",
  "สถานีดับเพลิง", "อุทยาน", "สวนสาธารณะ", "วัด", "โบสถ์", "มัสยิด",
  "วิหาร", "เจดีย์", "พระราชวัง", "วัง", "ปราสาท", "คุก",
  "เรือนจำ", "สำนักงาน", "อาคาร", "ตึก", "หมู่บ้าน", "ชุมชน",
  "ตำบล", "อำเภอ", "จังหวัด", "ภาค", "ประเทศ", "ต่างประเทศ",
  "ชนบท", "ชายแดน", "ท่าเรือ", "สนามบิน", "สถานีรถไฟ", "โรงแรม",
  "รีสอร์ต", "สวนสนุก", "พิพิธภัณฑ์", "ห้องสมุด", "โรงละคร", "โรงภาพยนตร์",
  "สระว่ายน้ำ", "ฟิตเนส", "มหาวิทยาลัย", "วิทยาลัย", "โรงเรียน", "อนุบาล",
  "ประถม", "มัธยม", "สนามกีฬา", "สนามเด็กเล่น", "คาเฟ่", "ร้านค้า",

  // house & furniture
  "ประตู", "หน้าต่าง", "ผนัง", "กำแพง", "หลังคา", "พื้น",
  "เพดาน", "บันได", "ระเบียง", "สนาม", "ห้อง", "ครัว",
  "ห้องนอน", "ห้องน้ำ", "ห้องนั่งเล่น", "ห้องทำงาน", "เฟอร์นิเจอร์", "เตียง",
  "หมอน", "ผ้าห่ม", "ตู้", "ตู้เย็น", "โต๊ะ", "เก้าอี้",
  "โซฟา", "กระจก", "โคมไฟ", "พัดลม", "แอร์", "เครื่องซักผ้า",
  "เตารีด", "ไมโครเวฟ", "อ่างล้างหน้า", "อ่างอาบน้ำ", "ฝักบัว", "ชักโครก",
  // school & learning
  "หนังสือ", "สมุด", "ปากกา", "ดินสอ", "ยางลบ", "ไม้บรรทัด",
  "กระดาษ", "ตำรา", "แบบฝึกหัด", "ข้อสอบ", "สอบ", "วิชา",
  "เรียน", "สอน", "จดบันทึก", "การบ้าน", "ห้องเรียน", "ตารางเรียน",
  "บทเรียน", "ความรู้", "ท่องจำ", "ฝึก", "ฝึกฝน",
  // health & medicine
  "ยา", "ไข้", "ป่วย", "เจ็บ", "บาดเจ็บ", "แผล",
  "หวัด", "ไอ", "จาม", "ฉีดยา", "ตรวจร่างกาย", "ผ่าตัด",
  "สุขภาพ", "แข็งแรง", "อ่อนแอ", "เจ็บปวด", "ปวดหัว", "ปวดท้อง",
  // clothing & accessories
  "เสื้อ", "กางเกง", "กระโปรง", "ชุด", "เดรส", "กระเป๋า",
  "รองเท้า", "ถุงเท้า", "ถุงมือ", "หมวก", "เข็มขัด", "ผ้าพันคอ",
  "แว่นตา", "นาฬิกา", "สร้อย", "แหวน", "ต่างหู", "กำไล",
  "เสื้อผ้า", "เสื้อยืด", "เสื้อเชิ้ต", "กางเกงยีนส์", "ชุดนอน", "ชุดว่ายน้ำ",
  "ผ้าไหม", "ผ้าฝ้าย", "ผ้า",
  // work & business
  "ประชุม", "หารือ", "ปรึกษา", "วางแผน", "กำหนดการ", "ตารางงาน",
  "งบประมาณ", "รายรับ", "รายจ่าย", "กำไร", "ขาดทุน", "ทุน",
  "ราคา", "ค่าใช้จ่าย", "ต้นทุน", "ภาษี", "ใบเสร็จ", "ใบกำกับ",
  "จัดส่ง", "ขนส่ง", "สต็อก", "สินค้า", "ต่อรอง", "ขายส่ง",
  "ขายปลีก", "โปรโมชัน", "ส่วนลด", "ซัพพลายเออร์",
  // travel & transport
  "ตั๋ว", "เครื่องบิน", "รถไฟ", "รถทัวร์", "รถไฟฟ้า", "รถเมล์",
  "แท็กซี่", "รถยนต์", "รถจักรยานยนต์", "จักรยาน", "เรือ", "เรือข้ามฟาก",
  "ล่องเรือ", "บิน", "เช็คอิน", "ที่พัก", "นักท่องเที่ยว", "แผนที่",
  "กระเป๋าเดินทาง", "เดินทาง", "จุดหมาย", "เส้นทาง", "ถนน", "ทางหลวง",
  "สะพาน", "อุโมงค์", "ป้ายรถเมล์", "ทางแยก", "สี่แยก", "ไฟแดง",
  "ไฟเขียว", "เข็มขัดนิรภัย", "หมวกกันน็อก", "ปั๊มน้ำมัน", "ขับรถ",

  // verbs of daily life
  "ดื่ม", "นอน", "ตื่น", "อาบน้ำ", "แปรงฟัน", "ล้างหน้า",
  "แต่งตัว", "กลับบ้าน", "พักผ่อน", "ล้างจาน", "กวาดบ้าน", "ถูบ้าน",
  "ซักผ้า", "รีดผ้า", "เก็บของ", "จ่ายเงิน", "ถอนเงิน", "โอนเงิน",
  "ฝากเงิน", "กู้ยืม", "เดิน", "วิ่ง", "กระโดด", "ว่ายน้ำ",
  "ปั่นจักรยาน", "ขี่จักรยาน", "เล่นกีฬา", "ออกกำลังกาย", "ดูทีวี", "ฟังเพลง",
  "อ่านหนังสือ", "วาดรูป", "ระบายสี", "ร้องเพลง", "เต้นรำ", "เล่นดนตรี",
  "เล่นเกม", "โทรหา", "รับสาย", "ส่งข้อความ", "ถ่ายรูป", "ถ่ายวิดีโอ",
  "โพสต์", "แชร์", "คุย", "แชท", "สนทนา", "พูด",
  "บอก", "เล่า", "อธิบาย", "ทักทาย", "ขอบคุณ", "ขอโทษ",
  "ให้อภัย", "พบ", "เจอ", "ไปเที่ยว", "ท่องเที่ยว", "เที่ยวชม",
  "เลี้ยว", "จอด", "รอ", "คอย", "นัดหมาย", "เลื่อน",
  "เลิก", "ฉลอง", "จอง", "ซื้อ", "ขาย", "ชำระ",
  "จ่าย", "ชำระเงิน", "ประหยัด", "ออม", "หยุดงาน", "ลาป่วย",
  "ลากิจ", "ลาพักร้อน", "ลงทะเบียน", "ต่ออายุ", "ทำธุระ", "ไปส่ง",
  "ไปรับ", "รีบ", "เร่ง", "ทำให้", "ช่วยเหลือ",

  // legal seeds (single lexical words / established legal compounds only)
  "กฎหมาย", "รัฐธรรมนูญ", "ประมวล", "ระเบียบ", "ข้อบังคับ", "ประกาศ",
  "คำสั่ง", "คำพิพากษา", "คำร้อง", "คำฟ้อง", "ฎีกา", "อุทธรณ์",
  "ศาล", "ตุลาการ", "ผู้พิพากษา", "โจทก์", "จำเลย", "ทนายความ",
  "ทนาย", "พยาน", "ไต่สวน", "สืบพยาน", "นำสืบ", "คำให้การ",
  "ให้การ", "กำหนดโทษ", "จำคุก", "โทษ", "ปรับ", "รอลงอาญา",
  "ประกันตัว", "ปล่อยชั่วคราว", "อาชญากรรม", "คดี", "คดีแพ่ง", "คดีอาญา",
  "ละเมิด", "ผู้เสียหาย", "สิทธิ", "เสรีภาพ", "ทรัพย์สิน", "กรรมสิทธิ์",
  "ครอบครอง", "ผู้ถือกรรมสิทธิ์", "อายุความ", "นิติกรรม", "นิติบุคคล", "บุคคลธรรมดา",
  "ผู้เยาว์", "สภาพบุคคล", "ภูมิลำเนา", "ทะเบียน", "ทะเบียนบ้าน", "ทะเบียนราษฎร",
  "บัตรประชาชน", "สูติบัตร", "ทะเบียนสมรส", "ทะเบียนหย่า", "หย่า", "มรดก",
  "พินัยกรรม", "ทายาท", "ผู้รับมรดก", "ผู้ทำพินัยกรรม", "ทรัพย์", "สังหาริมทรัพย์",
  "อสังหาริมทรัพย์", "สิทธิเรียกร้อง", "ใบอนุญาต", "ใบขับขี่", "ทะเบียนรถ", "ป้ายทะเบียน",
  "หนังสือเดินทาง", "วีซ่า", "สัญญา", "สัญญาเช่า", "สัญญาจ้าง", "รับจ้าง",
  "จ้างทำของ", "เช่า", "เช่าซื้อ", "ซื้อขาย", "ขายฝาก", "จำนอง",

  "จำนำ", "ค้ำประกัน", "ผู้ค้ำประกัน", "หลักประกัน", "ประกันภัย", "ประกันชีวิต",
  "ประกันสุขภาพ", "หนี้", "หนี้สิน", "ลูกหนี้", "เจ้าหนี้", "ใช้หนี้",
  "ชำระหนี้", "ค้างชำระ", "ผิดนัด", "ดอกเบี้ย", "เงินต้น", "ต้นเงิน",
  "ล้มละลาย", "พิทักษ์ทรัพย์", "ฟื้นฟูกิจการ", "ฟ้อง", "ฟ้องแย้ง", "ฟ้องร้อง",
  "ผู้ร้อง", "ผู้คัดค้าน", "ลงโทษ", "บทลงโทษ", "ตักเตือน", "มาตรการ",
  "อายัด", "ยึดทรัพย์", "ขายทอดตลาด", "บังคับคดี", "หมายศาล", "หมายเรียก",
  "สอบสวน", "สืบสวน", "จับกุม", "ควบคุมตัว", "ฝากขัง", "พิสูจน์",
  "ศาลชั้นต้น", "ศาลอุทธรณ์", "ศาลฎีกา", "หน่วยงาน", "ราชการ", "รัฐมนตรี",
  "กระทรวง", "กรม", "ข้าราชการ", "พนักงานราชการ", "คณะรัฐมนตรี", "รัฐสภา",
  "สภานิติบัญญัติ", "ผู้ตรวจการแผ่นดิน", "เทศบาล", "อัยการ", "อัยการสูงสุด",
  "พนักงานอัยการ", "เจ้าพนักงาน", "พนักงานสอบสวน",

  // literary seeds
  "อักษร", "อักขรวิธี", "ร้อยแก้ว", "ร้อยกรอง", "ฉันท์", "กาพย์",
  "กลอน", "กลอนแปด", "กลอนสุภาพ", "นิราศ", "นิทาน", "นิทานพื้นบ้าน",
  "พงศาวดาร", "จารึก", "ตำนาน", "ตัวละคร", "สำนวน", "โวหาร",
  "อุปมา", "อุปมาอุปไมย", "นามนัย", "รจนา", "รังสรรค์", "สรรค์",
  "ประพันธ์", "ผู้ประพันธ์", "บทประพันธ์", "คำประพันธ์", "กวี", "กวีนิพนธ์",
  "ฉันทลักษณ์", "สัมผัส", "วาทศิลป์", "วาทะ", "คำคม", "สุภาษิต",
  "คำพังเพย", "คติ", "เรื่องสั้น", "นวนิยาย", "บทละคร", "ละคร",
  "ชีวประวัติ", "อัตชีวประวัติ", "จดหมายเหตุ", "วรรณคดี", "วรรณกรรม",
  "บทกวี", "บทเพลง", "เพลง", "เพลงกล่อมเด็ก", "บทร้อง", "รำพึง",
  "ครวญ", "คร่ำครวญ", "พรรณนา", "บรรยาย", "เปรียบเทียบ", "ปรัมปรา",
  "พิจารณา", "พินิจ", "ไตร่ตรอง",
];

const DICT: ReadonlySet<string> = new Set(THAI_DEFAULT_WORDS);
let DICT_MAX = 0;
for (const w of THAI_DEFAULT_WORDS) {
  if (w.length > DICT_MAX) DICT_MAX = w.length;
}

/** Thai consonants U+0E01..U+0E2E (ก .. ฮ). */
function isThaiConsonant(ch: string): boolean {
  const c = ch.codePointAt(0) ?? 0;
  return c >= 0x0e01 && c <= 0x0e2e;
}

/**
 * Best-effort cluster for a run position where no dictionary word matches:
 * take the leading character together with every following non-consonant
 * (vowels/marks) up to the next consonant — a pseudo-syllable. Never drops
 * characters and always advances, so the scan terminates.
 */
function heuristicWord(run: string, start: number): { word: string; next: number } {
  let i = start + 1;
  let word = run[start] ?? "";
  while (i < run.length) {
    const ch = run[i] ?? "";
    if (isThaiConsonant(ch)) break;
    word += ch;
    i++;
  }
  return { word, next: i };
}

/**
 * Deterministic maximal-munch segmentation of one Thai run using the built-in
 * dictionary, falling back to the syllable heuristic for unknown runs. The
 * result is a pure function of the input, which keeps `segmentForIndex`
 * byte-idempotent even on the fallback path.
 */
function dictSegment(run: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < run.length) {
    const max = Math.min(DICT_MAX, run.length - i);
    let matched = "";
    for (let len = max; len >= 1; len--) {
      const cand = run.slice(i, i + len);
      if (DICT.has(cand)) {
        matched = cand;
        break;
      }
    }
    if (matched) {
      out.push(matched);
      i += matched.length;
      continue;
    }
    const cluster = heuristicWord(run, i);
    out.push(cluster.word);
    i = cluster.next;
  }
  return out;
}

/** Split one run of Thai characters into words (shared core of the module). */
function thaiTokens(run: string, seg: Segmenter | null): string[] {
  const out: string[] = [];
  if (seg) {
    for (const s of seg.segment(run)) {
      const w = s.segment.trim();
      if (w) out.push(w);
    }
  } else {
    out.push(...dictSegment(run));
  }
  return applyOverrideMerges(run, out);
}

// --- segment-override provider seam -----------------------------------------
//
// A dependency-inverted injection point: dictionaries.ts registers a provider
// that hands back the list of FORCED compounds (term → the single token it
// must stay). This module stays pure — it never imports the registry; it only
// calls `provider()` for a cached in-memory list. When no provider is set
// (default), every function below behaves byte-identically to before.
//
// Semantics: when a segmented Thai run contains the registered `term` as a
// contiguous token-aligned sequence (the segmenter split it apart), those
// tokens are re-merged into one token (`fixed`, normally == `term`). Only
// whole-token-aligned matches merge — a term that straddles a token boundary
// is skipped (safe no-op), so segmentation never drops characters and is
// deterministic and idempotent: after a merge the run holds the single forced
// token, and a second pass re-finds it as one token.
export type SegmentOverride = { term: string; fixed: string };
export type SegmentOverrideProvider = () => SegmentOverride[] | null;

let overrideProvider: SegmentOverrideProvider | null = null;
let overrideProviderCached: SegmentOverrideProvider | null | undefined;
let overrideTermMap: Map<string, string> | null = null;

/** Set the forced-compound provider (no argument / null clears it → built-in
 * behavior). Re-set to invalidate the cached list after a registry write. */
export function setSegmentOverrideProvider(fn?: SegmentOverrideProvider | null): void {
  overrideProvider = fn ?? null;
  overrideProviderCached = undefined;
  overrideTermMap = null;
}

/** Cached term → fixed map from the provider; null when unset/empty. */
function getOverrideTermMap(): Map<string, string> | null {
  const provider = overrideProvider;
  if (!provider) return null;
  if (overrideProviderCached !== provider) {
    let list: SegmentOverride[] | null = null;
    try {
      list = provider() ?? null;
    } catch {
      list = null;
    }
    const map = new Map<string, string>();
    if (list) {
      for (const o of list) {
        const t = String(o?.term ?? "").trim();
        const f = String(o?.fixed ?? "").trim();
        if (t && f) map.set(t, f);
      }
    }
    overrideTermMap = map;
    overrideProviderCached = provider;
  }
  return overrideTermMap;
}

function mergeForcedTokens(
  tokens: readonly string[],
  term: string,
  fixed: string
): readonly string[] | null {
  const out: string[] = [];
  let changed = false;
  let i = 0;
  while (i < tokens.length) {
    const head = tokens[i] ?? "";
    if (head === term) {
      out.push(fixed);
      changed = true;
      i += 1;
      continue;
    }
    if (head.length < term.length) {
      let acc = head;
      let j = i + 1;
      while (j < tokens.length && acc.length < term.length) {
        acc += tokens[j] ?? "";
        j += 1;
      }
      if (acc === term) {
        out.push(fixed);
        changed = true;
        i = j;
        continue;
      }
    }
    out.push(head);
    i += 1;
  }
  return changed ? out : null;
}

function applyOverrideMerges(run: string, tokens: readonly string[]): string[] {
  const map = getOverrideTermMap();
  if (map === null || map.size === 0) return [...tokens];
  const terms = [...map.keys()]
    .filter((t) => run.includes(t))
    .sort((a, b) => b.length - a.length);
  if (terms.length === 0) return [...tokens];
  let out: readonly string[] = tokens;
  for (const term of terms) {
    const merged = mergeForcedTokens(out, term, map.get(term) ?? term);
    if (merged) out = merged;
  }
  return [...out];
}

export function hasThai(text: string): boolean {
  return THAI_RE.test(text);
}

/**
 * Tone-tolerant / de-accented form of `text` (query-expansion fallback
 * matching): strips only Thai tone-level marks (่ ้ ๊ ๋ ์ ํ), keeps all vowels
 * intact, and lowercases. Powers the LOOSE matcher: "ติดตั้ง" → "ติดตัง"
 * equivalence is used for relaxed fallback lookups only, never for FTS index
 * content (tone marks stay significant there). Pure and idempotent.
 */
export function looseForm(text: string): string {
  return normalizeThaiInput(text).toLowerCase().replace(THAI_TONE_MARK_RE, "");
}

/**
 * Tokenize mixed Thai/English text into word tokens (lowercased, trimmed).
 * The single core path an indexer uses: pure-English text is a plain
 * whitespace/alpha split, Thai runs go through the segmenter (or the fallback
 * dictionary). Deterministic → re-tokenizing the joined tokens is a fixed point.
 */
export function wordTokens(text: string): string[] {
  const input = normalizeThaiInput(text);
  const seg = getSegmenter();
  const out: string[] = [];
  let last = 0;
  for (const m of input.matchAll(THAI_RUN_RE)) {
    const run = m[0] ?? "";
    const idx = m.index;
    pushLatinTokens(input.slice(last, idx), out);
    for (const w of thaiTokens(run, seg)) {
      if (w) out.push(w.toLowerCase());
    }
    last = idx + run.length;
  }
  pushLatinTokens(input.slice(last), out);
  return out;
}

/** Split a non-Thai segment into word tokens on whitespace/punctuation. */
function pushLatinTokens(segment: string, out: string[]): void {
  if (!segment) return;
  for (const tok of segment.toLowerCase().split(/[^a-z0-9]+/)) {
    if (tok) out.push(tok);
  }
}

/**
 * Text to store in FTS5: Thai runs get spaces between words, everything else
 * is left untouched.
 *
 * Only spaces are collapsed after the transform (never tabs/newlines), which
 * makes the function byte-idempotent: a second pass inserts boundary spaces
 * around every already-separated Thai word, and those runs collapse back to
 * the single spaces produced by the first pass. Non-Thai text keeps its exact
 * whitespace because inputs without Thai are returned verbatim.
 */
export function segmentForIndex(text: string): string {
  const input = normalizeThaiInput(text);
  if (!hasThai(input)) return input;
  const seg = getSegmenter();
  const out = input.replace(THAI_RUN_RE, (run) => ` ${thaiTokens(run, seg).join(" ")} `);
  return out.replace(/ {2,}/g, " ");
}

/**
 * Turn one whitespace-delimited query chunk into its word list. A chunk such
 * as "ใช้pnpm" yields ["ใช้", "pnpm"].
 */
export function segmentQueryChunk(chunk: string): string[] {
  const spaced = segmentForIndex(chunk);
  return spaced.split(/\s+/).filter(Boolean);
}
