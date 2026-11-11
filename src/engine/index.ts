/**
 * `thai-fts/engine` subpath entry — the search-engine abstraction + registry
 * (ThaiSearchEngine / registerEngine / createEngine) and the adapters: the
 * zero-dependency in-memory adapter (createMemoryEngine, registered as
 * "memory") and the minimal fetch-based REFERENCE HTTP adapters
 * (createMeilisearchEngine / createElasticsearchEngine, registered as
 * "meilisearch" / "elasticsearch" — async add/remove/search, see
 * HttpSearchEngine). Pure: no database, no node: imports.
 */
export * from "../adapters/engine.js";
export * from "../adapters/memory/index.js";
export * from "../adapters/meilisearch/index.js";
export * from "../adapters/elasticsearch/index.js";
