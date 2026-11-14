/**
 * Shared request/response types for the thai-fts REST API server.
 */

import type { ThaiEngineOptions, ToneMode } from "../adapters/engine.js";

/** Search parameters accepted via query string or JSON body. */
export interface SearchParams {
  q: string;
  limit?: number;
  tone?: ToneMode;
  prefix?: boolean;
  offsets?: boolean;
  allTerms?: boolean;
  titleWeight?: number;
}

/** Document add/update request body. */
export interface AddRequest {
  id: string | number;
  title?: string;
  body?: string;
  [key: string]: unknown;
}

/** Standardized API response envelope. */
export interface ApiResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  message?: string;
}

/** Health check response. */
export interface HealthResponse {
  ok: true;
  engines: string[];
  default: string;
  version: string;
}

/** Bulk add response. */
export interface AddManyResponse {
  added: number;
}

/** Search response (hits only). */
export interface SearchResponse {
  hits: Array<{
    id: string | number;
    rank: number;
    snippet?: string;
    meta?: Record<string, unknown>;
  }>;
}

/** Search with meta response (includes truncated flag). */
export interface SearchWithMetaResponse extends SearchResponse {
  truncated: boolean;
}

/** Engine info for health endpoint. */
export interface EngineInfo {
  name: string;
  type: string;
  async: boolean;
}

/** Server configuration options. */
export interface ServerOptions {
  port?: number;
  host?: string;
  /** Maximum request body size in bytes (default: 1MB). */
  maxBodySize?: number;
  /** Default engine name (first registered sync engine if not specified). */
  defaultEngine?: string;
}

/** Engine registration config for CLI/env. */
export interface EngineRegistration {
  name: string;
  factory: string; // e.g., "createMemoryEngine" or "createFts5Engine"
  options?: Record<string, unknown>;
}