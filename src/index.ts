export const version = "0.1.0";

export const core = { version } as const;

export const engine = { version } as const;

export const fts5 = { version } as const;

// Full core public API, re-exported from the single public entry. Engine and
// FTS5 subpaths (./engine, ./fts5) land in later milestones; src/index.ts is
// the single public entry for the core this round.
export * from "./core/segment.js";
export * from "./core/synonyms.js";
export * from "./core/query.js";
export * from "./core/dictionaries.js";
export * from "./core/tone.js";
export * from "./core/types.js";
