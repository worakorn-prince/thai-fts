export const version = "0.1.0";

export const core = { version } as const;
export const engine = { version } as const;
export const fts5 = { version } as const;
export const memory = { version } as const;

// Single public entry bundling every subpath: ./core (pure lexical core),
// ./engine (search-engine abstraction/registry + in-memory adapter), ./fts5
// (SQLite FTS5 adapter). Each is also published as its own subpath entry
// (src/<sub>/index.ts), and this file is the one-stop `thai-fts` import that
// re-exports all of them.
export * from "./core/index.js";
export * from "./engine/index.js";
export * from "./fts5/index.js";

// Root convenience: the reference adapter's factory is available directly as
// `createFts5Engine` so a typical consumer needs exactly one import, the
// zero-dependency in-memory factory as `createMemoryEngine`, and the
// reference HTTP adapters' factories as `createMeilisearchEngine` /
// `createElasticsearchEngine` (async surface — see HttpSearchEngine).
export { createFts5Engine } from "./fts5/index.js";
export { createMemoryEngine } from "./engine/index.js";
export {
  createMeilisearchEngine,
  createElasticsearchEngine,
} from "./engine/index.js";
