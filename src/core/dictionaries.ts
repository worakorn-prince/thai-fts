/**
 * Public registry for Thai dictionaries, DB-free. Let consumers register extra
 * words, synonym pairs, and forced-compound overrides; the registry rewires the
 * pure provider seams in `segment.ts` / `synonyms.ts` with the merged data, so
 * the segmenter and synonym layer stay dependency-free while picking up
 * registered terms.
 *
 * The default dev/tech data is always active underneath (see
 * `THAI_DEFAULT_WORDS` in segment.ts and `THAI_DEFAULT_SYNONYMS` in
 * synonyms.ts); registered dictionaries only ADD on top. No database, no Node
 * built-in imports.
 */
import {
  setSegmentOverrideProvider,
  THAI_DEFAULT_WORDS,
  type SegmentOverride,
} from "./segment.js";
import { setSynonymProvider, THAI_DEFAULT_SYNONYMS, type SynonymPair } from "./synonyms.js";
import type { ThaiDictionaryDef } from "./types.js";

export { THAI_DEFAULT_WORDS, THAI_DEFAULT_SYNONYMS };

/**
 * Parse a free-form word list into a clean array of unique words. Accepts
 * newline-separated, space-separated (or mixed) text, trims each entry, drops
 * blank lines/segments, and de-duplicates while preserving first-occurrence
 * order. Pure — no I/O, no Node built-ins.
 *
 * ```ts
 * loadThaiWordsFromText("สัญญา\nเช่า ซื้อขาย จำนอง");
 * // → ["สัญญา", "เช่า", "ซื้อขาย", "จำนอง"]
 * ```
 */
export function loadThaiWordsFromText(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of String(text ?? "").split(/\s+/)) {
    const w = raw.trim();
    if (w && !seen.has(w)) {
      seen.add(w);
      out.push(w);
    }
  }
  return out;
}

const registrations = new Map<string, ThaiDictionaryDef>();

function collectWords(def: ThaiDictionaryDef): SegmentOverride[] {
  const out: SegmentOverride[] = [];
  for (const w of def.words ?? []) {
    const t = String(w ?? "").trim();
    if (t) out.push({ term: t, fixed: t });
  }
  for (const o of def.overrides ?? []) {
    const t = String(o?.term ?? "").trim();
    const f = String(o?.fixed ?? "").trim();
    if (t && f) out.push({ term: t, fixed: f });
  }
  return out;
}

function collectPairs(def: ThaiDictionaryDef): SynonymPair[] {
  const out: SynonymPair[] = [];
  for (const p of def.synonyms ?? []) {
    const a = String(p?.[0] ?? "").trim();
    const b = String(p?.[1] ?? "").trim();
    if (a && b) out.push([a, b] as const);
  }
  return out;
}

function refreshProviders(): void {
  const defs = [...registrations.values()];
  const overrides: SegmentOverride[] = [];
  const pairs: SynonymPair[] = [];
  for (const def of defs) {
    overrides.push(...collectWords(def));
    pairs.push(...collectPairs(def));
  }
  // Re-set the provider every refresh: setSegmentOverrideProvider /
  // setSynonymProvider invalidate their internal caches, so a registry write
  // is reflected immediately. The provider closures capture the snapshot, and
  // the seams' cache key is the provider function identity.
  setSegmentOverrideProvider(overrides.length > 0 ? () => overrides : null);
  setSynonymProvider(pairs.length > 0 ? () => pairs : null);
}

/**
 * Register (or overwrite) a Thai dictionary by id. `words` are kept whole as
 * forced compounds, `synonyms` feed the bidirectional transliteration layer,
 * `overrides` give explicit term → fixed token mappings. Re-registering the
 * same id replaces the previous definition; effects are applied immediately.
 */
export function registerThaiDictionary(def: ThaiDictionaryDef): void {
  if (!def || typeof def.id !== "string" || !def.id.trim()) {
    throw new TypeError("registerThaiDictionary requires a non-empty id");
  }
  registrations.set(def.id.trim(), {
    ...def,
    id: def.id.trim(),
  });
  refreshProviders();
}

/** Read-only list of currently registered dictionary definitions (id order). */
export function listDictionaries(): ThaiDictionaryDef[] {
  return [...registrations.values()];
}

/** Remove every registered dictionary and rewire the seams back to defaults. */
export function clearRegisteredDictionaries(): void {
  registrations.clear();
  refreshProviders();
}
