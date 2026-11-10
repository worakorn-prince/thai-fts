export const version = "0.1.0";

export const core = { version } as const;

export const engine = { version } as const;

export const fts5 = { version } as const;

// Full core public API, re-exported from the single public entry. Engine and
// FTS5 subpaths (./engine, ./fts5) land in a later milestone; src/index.ts is
// the single public entry for core + the FTS5 adapter this round.
export * from "./core/segment.js";
export * from "./core/synonyms.js";
export * from "./core/query.js";
export * from "./core/dictionaries.js";
export * from "./core/tone.js";
export * from "./core/types.js";

// Adapter layer: engine interface/registry plus the reference SQLite FTS5
// adapter (store, search, engine factory). Also re-exports createFts5Engine
// at the root as the default convenience entry.
export * from "./adapters/engine.js";
export * from "./adapters/fts5/index.js";
export { createFts5Engine } from "./adapters/fts5/index.js";
