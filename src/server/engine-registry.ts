/**
 * Server-side engine registry — manages engine instances for the HTTP server.
 * Handles both sync and async engines, graceful shutdown.
 */

import {
  createEngine,
  createAsyncEngine,
  listEngines,
  listAsyncEngines,
  registerEngine,
  type ThaiSearchEngine,
  type ThaiAsyncEngine,
} from "../adapters/engine.js";
import { createMemoryEngine } from "../adapters/memory/index.js";
import { createFts5Engine } from "../adapters/fts5/index.js";
import type { EngineRegistration } from "./types.js";

/** Union of sync and async engine types for internal storage. */
export type AnyEngine = ThaiSearchEngine | ThaiAsyncEngine;

/** Factory-name aliases → engine names in the library's shared registry.
 * `EngineRegistration.factory` accepts either spelling. */
const FACTORY_ALIASES: Record<string, string> = {
  createMemoryEngine: "memory",
  createFts5Engine: "fts5",
};

/** Engine instance with metadata. A discriminated union — `async` is the
 * discriminant, so narrowing on it also narrows `engine` to the right
 * interface (a plain boolean field would keep `engine` as the union). */
export type EngineInstance =
  | { name: string; engine: ThaiSearchEngine; async: false; type: string }
  | { name: string; engine: ThaiAsyncEngine; async: true; type: string };

/**
 * ServerEngineRegistry manages multiple named engine instances.
 * Engines are created at startup and closed on shutdown.
 */
export class ServerEngineRegistry {
  private engines = new Map<string, EngineInstance>();
  private defaultEngineName: string | null = null;
  private closed = false;

  constructor() {
    // Pre-register built-in engine factories
    registerEngine("memory", createMemoryEngine);
    registerEngine("fts5", createFts5Engine);
  }

  /**
   * Register and create engines from configuration.
   * @param registrations Array of engine registration configs
   * @param defaultEngineName Optional explicit default engine name
   */
  async registerEngines(
    registrations: EngineRegistration[],
    defaultEngineName?: string
  ): Promise<void> {
    if (this.closed) {
      throw new Error("Registry is closed");
    }

    for (const reg of registrations) {
      await this.createAndRegisterEngine(reg);
    }

    // Determine default engine
    if (defaultEngineName) {
      if (!this.engines.has(defaultEngineName)) {
        throw new Error(`Default engine "${defaultEngineName}" not registered`);
      }
      this.defaultEngineName = defaultEngineName;
    } else if (this.defaultEngineName === null) {
      // Auto-select: first sync engine, or first engine if no sync engines
      const syncEngines = Array.from(this.engines.values()).filter((e) => !e.async);
      this.defaultEngineName = (syncEngines[0] ?? Array.from(this.engines.values())[0])?.name ?? null;
    }
  }

  /**
   * Create a single engine instance from registration config. The shared
   * library registry is the source of truth for what exists and whether it is
   * async, so user-registered engines work without name heuristics.
   */
  private async createAndRegisterEngine(reg: EngineRegistration): Promise<void> {
    const engineName = FACTORY_ALIASES[reg.factory] ?? reg.factory;
    const isAsync = listAsyncEngines().includes(engineName);
    if (!isAsync && !listEngines().includes(engineName)) {
      throw new Error(`Unknown engine factory: ${reg.factory}`);
    }

    try {
      if (isAsync) {
        const engine = createAsyncEngine(engineName, reg.options ?? {});
        this.engines.set(reg.name, { name: reg.name, engine, async: true, type: engine.type });
        return;
      }
      const engine = createEngine(engineName, reg.options ?? {});
      this.engines.set(reg.name, { name: reg.name, engine, async: false, type: engine.type });
      // Set as default if it's the first sync engine
      if (this.defaultEngineName === null) {
        this.defaultEngineName = reg.name;
      }
    } catch (e) {
      throw new Error(
        `Failed to create engine "${reg.name}" (${reg.factory}): ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  /** Get an engine by name. */
  getEngine(name: string): EngineInstance | undefined {
    return this.engines.get(name);
  }

  /** Get the default engine instance. */
  getDefaultEngine(): EngineInstance | undefined {
    if (!this.defaultEngineName) return undefined;
    return this.engines.get(this.defaultEngineName);
  }

  /** Get default engine name. */
  getDefaultEngineName(): string | null {
    return this.defaultEngineName;
  }

  /** List all registered engine names. */
  listEngineNames(): string[] {
    return Array.from(this.engines.keys()).sort();
  }

  /** List all engine instances with metadata. */
  listEngines(): EngineInstance[] {
    return Array.from(this.engines.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Check if an engine is async. */
  isAsync(name: string): boolean {
    return this.engines.get(name)?.async ?? false;
  }

  /** Close all engines (idempotent). */
  close(): void {
    if (this.closed) return;
    this.closed = true;

    for (const instance of this.engines.values()) {
      try {
        instance.engine.close();
      } catch {
        // Best effort - continue closing others
      }
    }
    this.engines.clear();
  }

  /** Check if registry is closed. */
  isClosed(): boolean {
    return this.closed;
  }
}