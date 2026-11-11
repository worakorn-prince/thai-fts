/**
 * Classic Porter stemming algorithm (Porter, 1980, "An algorithm for suffix
 * stripping", Program, Vol. 14, no. 3) — a zero-dependency TypeScript port of
 * the author's canonical ANSI C implementation (release 3, including its
 * documented DEPARTURE points). Public domain; the only change is language
 * (C → TypeScript, strings instead of a mutable buffer).
 *
 * This module is an OPT-IN search feature for thai-fts: `stemEn` is only ever
 * applied when a caller explicitly enables `stem` (store-level option on the
 * adapters, `MatchBuildOptions.stem` on the query builders). It is
 * ASCII-only by construction — non-ASCII (e.g. Thai) input passes through
 * unchanged (lowercased, no letter is altered) — so enabling it can never
 * affect Thai tokens, and the default (off) keeps every existing payload and
 * query byte-identical.
 *
 * Enabling `stem` on an adapter changes the indexed payload: existing indexes
 * must be rebuilt after toggling it (same contract as the opt-in stopwords).
 *
 * ```ts
 * import { stemEn } from "thai-fts";
 * stemEn("running");   // → "run"
 * stemEn("cats");      // → "cat"
 * stemEn("ติดตั้ง");   // → "ติดตั้ง" (unchanged — not ASCII)
 * ```
 */

/** True when `ch` is a single ASCII letter a–z. */
function isAsciiLetter(ch: string): boolean {
  return ch >= "a" && ch <= "z";
}

/**
 * Stem ONE word with the classic Porter algorithm.
 *
 * Input is trimmed and lowercased first (the C reference requires lowercase;
 * stemming is case-insensitive by design). Words without any ASCII letter
 * (Thai, digits, punctuation) or words of length 1–2 are returned unchanged
 * (lowercased) — the C early-return `k <= k0+1` and its letter-only scope.
 * The result is always a lowercase ASCII string no longer than the input.
 */
export function stemEn(word: string): string {
  const w = String(word ?? "").trim().toLowerCase();
  if (w.length < 3) return w;
  let allLetters = true;
  for (let i = 0; i < w.length; i++) {
    if (!isAsciiLetter(w[i] as string)) {
      allLetters = false;
      break;
    }
  }
  if (!allLetters) return w;
  return porter(w);
}

/** The Porter algorithm on a lowercased a–z word of length ≥ 3. */
function porter(input: string): string {
  const b: string[] = input.split("");
  const k0 = 0;
  let k = b.length - 1;
  let j = 0;

  /** `cons(i)`: b[i] is a consonant. 'y' is a consonant only when the
   * preceding char is one too (or it is the first char). */
  const cons = (i: number): boolean => {
    const c = b[i] as string;
    if (c === "a" || c === "e" || c === "i" || c === "o" || c === "u") return false;
    if (c === "y") return i === k0 ? true : !cons(i - 1);
    return true;
  };

  /** `m()`: number of consonant sequences between k0 and j — counts <c>vc
   * pairs; <c>vcvc gives 2, and so on. */
  const m = (): number => {
    let n = 0;
    let i = k0;
    for (;;) {
      if (i > j) return n;
      if (!cons(i)) break;
      i++;
    }
    i++;
    for (;;) {
      for (;;) {
        if (i > j) return n;
        if (cons(i)) break;
        i++;
      }
      i++;
      n++;
      for (;;) {
        if (i > j) return n;
        if (!cons(i)) break;
        i++;
      }
      i++;
    }
  };

  /** `vowelinstem()`: k0..j contains a vowel. */
  const vowelinstem = (): boolean => {
    for (let i = k0; i <= j; i++) {
      if (!cons(i)) return true;
    }
    return false;
  };

  /** `doublec(ii)`: b[ii], b[ii-1] are a double consonant. */
  const doublec = (ii: number): boolean => {
    if (ii < k0 + 1) return false;
    if ((b[ii] as string) !== (b[ii - 1] as string)) return false;
    return cons(ii);
  };

  /** `cvc(ii)`: ii-2, ii-1, ii have the form C V C and the second C is not
   * w, x, y (used to restore an e on short words: cave, love, hop, but not
   * snow, box, tray). */
  const cvc = (ii: number): boolean => {
    if (ii < k0 + 2 || !cons(ii) || cons(ii - 1) || !cons(ii - 2)) return false;
    const ch = b[ii] as string;
    if (ch === "w" || ch === "x" || ch === "y") return false;
    return true;
  };

  /** `ends(s)`: the buffer ends with s; sets `j` to the stem's last index. */
  const ends = (s: string): boolean => {
    const length = s.length;
    if (length > k - k0 + 1) return false;
    for (let t = 0; t < length; t++) {
      if ((b[k - length + 1 + t] as string) !== s[t]) return false;
    }
    j = k - length;
    return true;
  };

  /** `setto(s)`: replace the suffix just consumed by `ends` with s. */
  const setto = (s: string): void => {
    const length = s.length;
    for (let t = 0; t < length; t++) {
      b[j + 1 + t] = s[t] as string;
    }
    k = j + length;
  };

  /** `r(s)`: `setto(s)` when m() > 0. */
  const r = (s: string): void => {
    if (m() > 0) setto(s);
  };

  /** Step 1a/1b: plurals and -ed/-ing. */
  const step1ab = (): void => {
    if ((b[k] as string) === "s") {
      if (ends("sses")) k -= 2;
      else if (ends("ies")) setto("i");
      else if ((b[k - 1] as string) !== "s") k--;
    }
    if (ends("eed")) {
      if (m() > 0) k--;
    } else if ((ends("ed") || ends("ing")) && vowelinstem()) {
      k = j;
      if (ends("at")) setto("ate");
      else if (ends("bl")) setto("ble");
      else if (ends("iz")) setto("ize");
      else if (doublec(k)) {
        k--;
        const ch = b[k] as string;
        if (ch === "l" || ch === "s" || ch === "z") k++;
      } else if (m() === 1 && cvc(k)) setto("e");
    }
  };

  /** Step 1c: terminal y → i when there is another vowel in the stem. */
  const step1c = (): void => {
    if (ends("y") && vowelinstem()) b[k] = "i";
  };

  /** Step 2: double suffixes to single ones (requires m() > 0). */
  const step2 = (): void => {
    switch (b[k - 1] as string) {
      case "a":
        if (ends("ational")) {
          r("ate");
          break;
        }
        if (ends("tional")) {
          r("tion");
          break;
        }
        break;
      case "c":
        if (ends("enci")) {
          r("ence");
          break;
        }
        if (ends("anci")) {
          r("ance");
          break;
        }
        break;
      case "e":
        if (ends("izer")) {
          r("ize");
          break;
        }
        break;
      case "l":
        // -DEPARTURE- (kept, per the canonical C reference): the published
        // algorithm checks "abli"; the reference implementation checks "bli".
        if (ends("bli")) {
          r("ble");
          break;
        }
        if (ends("alli")) {
          r("al");
          break;
        }
        if (ends("entli")) {
          r("ent");
          break;
        }
        if (ends("eli")) {
          r("e");
          break;
        }
        if (ends("ousli")) {
          r("ous");
          break;
        }
        break;
      case "o":
        if (ends("ization")) {
          r("ize");
          break;
        }
        if (ends("ation")) {
          r("ate");
          break;
        }
        if (ends("ator")) {
          r("ate");
          break;
        }
        break;
      case "s":
        if (ends("alism")) {
          r("al");
          break;
        }
        if (ends("iveness")) {
          r("ive");
          break;
        }
        if (ends("fulness")) {
          r("ful");
          break;
        }
        if (ends("ousness")) {
          r("ous");
          break;
        }
        break;
      case "t":
        if (ends("aliti")) {
          r("al");
          break;
        }
        if (ends("iviti")) {
          r("ive");
          break;
        }
        if (ends("biliti")) {
          r("ble");
          break;
        }
        break;
      case "g":
        // -DEPARTURE- (kept, per the canonical C reference): the published
        // algorithm has no -logi rule.
        if (ends("logi")) {
          r("log");
          break;
        }
        break;
      default:
        break;
    }
  };

  /** Step 3: -ic-, -ful, -ness etc. (requires m() > 0). */
  const step3 = (): void => {
    switch (b[k] as string) {
      case "e":
        if (ends("icate")) {
          r("ic");
          break;
        }
        if (ends("ative")) {
          r("");
          break;
        }
        if (ends("alize")) {
          r("al");
          break;
        }
        break;
      case "i":
        if (ends("iciti")) {
          r("ic");
          break;
        }
        break;
      case "l":
        if (ends("ical")) {
          r("ic");
          break;
        }
        if (ends("ful")) {
          r("");
          break;
        }
        break;
      case "s":
        if (ends("ness")) {
          r("");
          break;
        }
        break;
      default:
        break;
    }
  };

  /** Step 4: -ant, -ence etc., in context <c>vcvc<v> (requires m() > 1). */
  const step4 = (): void => {
    let matched = false;
    switch (b[k - 1] as string) {
      case "a":
        matched = ends("al");
        break;
      case "c":
        matched = ends("ance") || ends("ence");
        break;
      case "e":
        matched = ends("er");
        break;
      case "i":
        matched = ends("ic");
        break;
      case "l":
        matched = ends("able") || ends("ible");
        break;
      case "n":
        matched = ends("ant") || ends("ement") || ends("ment") || ends("ent");
        break;
      case "o":
        // `j >= k0` guards the b[j] read (release 2 fix, kept verbatim).
        matched =
          (ends("ion") && j >= k0 && ((b[j] as string) === "s" || (b[j] as string) === "t")) ||
          ends("ou");
        break;
      case "s":
        matched = ends("ism");
        break;
      case "t":
        matched = ends("ate") || ends("iti");
        break;
      case "u":
        matched = ends("ous");
        break;
      case "v":
        matched = ends("ive");
        break;
      case "z":
        matched = ends("ize");
        break;
      default:
        break;
    }
    if (matched && m() > 1) k = j;
  };

  /** Step 5: final -e when m() > 1 (or m() = 1 and not a short CVC), and
   * -ll → -l when m() > 1. */
  const step5 = (): void => {
    j = k;
    if ((b[k] as string) === "e") {
      const a = m();
      if (a > 1 || (a === 1 && !cvc(k - 1))) k--;
    }
    if ((b[k] as string) === "l" && doublec(k) && m() > 1) k--;
  };

  if (k <= k0 + 1) return input; // length 1–2: never stemmed (C early return)

  step1ab();
  // Release 3 fix, kept verbatim: when step 1a/b leaves a one-letter result
  // (ied → i, aing → a, …) the later steps would read before the first
  // letter — skip them unless k > k0.
  if (k > k0) {
    step1c();
    step2();
    step3();
    step4();
    step5();
  }
  return b.slice(0, k + 1).join("");
}
