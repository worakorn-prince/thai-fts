export const version = "0.1.0";

export const core = { version } as const;
export const engine = { version } as const;
export const fts5 = { version } as const;

// Single public entry bundling every subpath: ./core (pure lexical core),
// ./engine (search-engine abstraction/registry), ./fts5 (SQLite FTS5 adapter).
// Each is also published as its own subpath entry (src/<sub>/index.ts), and
// this file is the one-stop `thai-fts` import that re-exports all of them.
export * from "./core/index.js";
export * from "./engine/index.js";
export * from "./fts5/index.js";

// Root convenience: the reference adapter's factory is available directly as
// `createFts5Engine` so a typical consumer needs exactly one import.
export { createFts5Engine } from "./fts5/index.js";
