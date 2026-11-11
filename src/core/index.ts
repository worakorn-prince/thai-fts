/**
 * `thai-fts/core` subpath entry — the pure, dependency-free core surface:
 * segmentation, tone tolerance, synonyms, query building, dictionaries.
 * No Node built-ins, no database, no npm packages.
 */
export * from "./segment.js";
export * from "./synonyms.js";
export * from "./stopwords.js";
export * from "./stem.js";
export * from "./query.js";
export * from "./dictionaries.js";
export * from "./seeds/legal.js";
export * from "./seeds/literary.js";
export * from "./tone.js";
export * from "./types.js";
