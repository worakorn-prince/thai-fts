/**
 * Tone-handling policy helpers. A tiny seam that lets adapters pick between the
 * strict (mark-aware) channel, the loose (de-accented) channel, or both —
 * without re-implementing the decision.
 */
import { looseForm } from "./segment.js";
import type { ToneMode } from "./types.js";

export { looseForm };
export type { ToneMode };

/** Default resolution: dual-channel, strict tried first. */
const DEFAULT_TONE_MODE: ToneMode = "both";

export interface ToneOptions {
  tone?: ToneMode;
}

/**
 * Resolve the effective tone mode from an optional override.
 *
 * Accepts either a bare `ToneMode` or a `{ tone }` options object. Anything
 * unset, mismatched, or unknown falls back to the default "both" (strict-first
 * dual-channel) so callers get tone-tolerant behavior unless they explicitly
 * opt into a single channel.
 */
export function resolveToneMode(opts?: ToneOptions | ToneMode | null): ToneMode {
  if (opts == null) return DEFAULT_TONE_MODE;
  const t = typeof opts === "string" ? opts : opts.tone;
  if (t === "strict" || t === "loose" || t === "both") return t;
  return DEFAULT_TONE_MODE;
}
