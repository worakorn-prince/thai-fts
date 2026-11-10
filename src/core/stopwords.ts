/**
 * Curated Thai stopword list + symmetric token/payload filter helpers.
 * Pure — imports only `./segment.js`, no Node built-ins, no database.
 *
 * Stopwords are an OPT-IN search feature: a caller opts into removal on BOTH
 * sides (index-time payload filter in the store, query-time word-list filter in
 * `buildFtsMatch`/`buildLooseFtsMatch`) so index and query stay symmetric. The
 * default is off, and enabling it changes the indexed payload — an existing
 * on-disk database must be rebuilt after toggling it (see `openFts5Store`).
 *
 * ```ts
 * import { filterStopwords, applyStopwords, THAI_DEFAULT_STOPWORDS } from "thai-fts";
 * filterStopwords(["การ", "ติด", "ตั้ง"]);          // → ["ติด", "ตั้ง"]
 * applyStopwords(" การ ติด ตั้ง ");                  // → "ติด ตั้ง" ("การ" dropped)
 * THAI_DEFAULT_STOPWORDS.length                     // → >= 75
 * ```
 */
import { looseForm } from "./segment.js";

/**
 * Default high-frequency Thai grammatical/function words — the set used when a
 * store is opened with `stopwords: true` (or a query builder is handed none).
 * Every entry is a common connector, particle, pronoun or determiner; content
 * words (ติดตั้ง, โปรแกรม, ...) are deliberately absent so search meaning stays.
 */
export const THAI_DEFAULT_STOPWORDS: readonly string[] = [
  // connectors / conjunctions
  "และ", "หรือ", "แต่", "เพราะ", "จึง", "แล้ว", "ว่า", "ซึ่ง", "ต่อ", "รวมทั้ง",
  "เนื่องจาก", "อีกทั้ง", "เพราะว่า",
  // prepositions / relations
  "ของ", "ใน", "บน", "ใต้", "จาก", "กับ", "โดย", "ตาม", "เพื่อ", "ด้วย",
  "ระหว่าง", "เกี่ยวกับ", "สำหรับ", "ข้าง",
  // demonstratives / pronouns
  "นี้", "นั้น", "นั่น", "ที่นี่", "ใคร", "อะไร", "เรา", "ผม", "ฉัน", "คุณ",
  "เขา", "มัน", "ท่าน",
  // negatives / modals / auxiliaries
  "ไม่", "ไม่ได้", "ได้", "จะ", "คง", "ต้อง", "ยัง", "แค่", "เพียง", "เท่าไหร่",
  "ไหน", "ไหม", "มากกว่า",
  // particles / politeness / fillers
  "ครับ", "ค่ะ", "คะ", "ครับผม", "นะ", "จ้า", "เลย", "ละ", "แล้วก็",
  // aspects / time
  "ไป", "มา", "อยู่", "เป็น", "คือ", "ก็", "ขึ้น", "ลง", "ก่อน", "หลัง",
  "เมื่อ", "ตั้งแต่",
  // determiners / quantifiers
  "ทุก", "บาง", "หลาย", "ทั้ง", "ทั้งหมด", "แต่ละ", "อีก", "แห่ง",
  // manner / misc function words
  "อย่าง", "เช่น", "เอง", "ประมาณ", "ขอ", "ว่าไง", "ทำไม",
  // nominalizers / relativizers (high-frequency function words)
  "การ", "อัน", "สิ่ง",
];

const THAI_STOPWORD_SET: ReadonlySet<string> = new Set(
  THAI_DEFAULT_STOPWORDS.map((w) => w.toLowerCase())
);

/**
 * Remove stopword tokens from a token list (the array form of the symmetric
 * index/query filter). When `list` is omitted the curated
 * `THAI_DEFAULT_STOPWORDS` is used; an empty list disables filtering entirely.
 * Tokens are compared case-insensitively; no other normalization is applied.
 */
export function filterStopwords(
  tokens: readonly string[],
  list?: readonly string[]
): string[] {
  const set = list
    ? new Set(list.map((w) => String(w).toLowerCase()))
    : THAI_STOPWORD_SET;
  if (set.size === 0) return [...tokens];
  return tokens.filter((t) => !set.has(String(t).toLowerCase()));
}

/**
 * Loose-channel twin of `filterStopwords`: stopwords are compared in their
 * de-accented (`looseForm`) form so a tone-mark typo in a query still drops the
 * same tokens the index removed. Mirrors how the loose index rows are stored
 * (`looseForm` of the strict payload), keeping both sides symmetric. Used by
 * `buildLooseFtsMatch`; on the strict channel `filterStopwords` is used.
 */
export function filterStopwordsLoose(
  tokens: readonly string[],
  list?: readonly string[]
): string[] {
  const base = (list ?? THAI_DEFAULT_STOPWORDS).map(looseForm);
  const set = new Set(base);
  if (set.size === 0) return [...tokens];
  return tokens.filter((t) => !set.has(looseForm(t)));
}

/**
 * Apply the stopword filter to a space-delimited FTS payload (the
 * `segmentForIndex` output shape stored by the store before synonym
 * expansion). Stopword tokens are removed and leftover whitespace is collapsed
 * to single spaces. Returns the input verbatim when nothing is removed (so the
 * default off path is byte-identical).
 */
export function applyStopwords(
  segmented: string,
  list?: readonly string[]
): string {
  const text = String(segmented ?? "");
  const tokens = text.split(/\s+/).filter(Boolean);
  const kept = filterStopwords(tokens, list);
  if (kept.length === tokens.length) return text;
  return kept.join(" ");
}
