/**
 * HTTP server entry point for thai-fts REST API.
 * Exports createServer function and starts server when run directly.
 */

import { createServer as createHttpServer, IncomingMessage, ServerResponse, Server } from "node:http";
import { pathToFileURL } from "node:url";
import { ServerEngineRegistry } from "./engine-registry.js";
import { routeRequest } from "./routes.js";
import type { ServerOptions, EngineRegistration } from "./types.js";
import { version } from "../index.js";

export interface CreateServerOptions extends ServerOptions {
  /** Pre-configured engine registrations. */
  engines?: EngineRegistration[];
  /** Explicit default engine name. */
  defaultEngine?: string;
}

export interface ThaiFtsServer {
  server: Server;
  registry: ServerEngineRegistry;
  close: () => Promise<void>;
  address: () => string;
}

/**
 * Create and start the thai-fts HTTP server.
 * @param options Server configuration options
 * @returns Server instance with close method for graceful shutdown
 */
export async function createServer(options: CreateServerOptions = {}): Promise<ThaiFtsServer> {
  const {
    port = Number(process.env.PORT) || 3000,
    host = process.env.HOST || "0.0.0.0",
    maxBodySize = 1024 * 1024, // 1MB
    engines = [],
    defaultEngine,
  } = options;

  const registry = new ServerEngineRegistry();

  // Register engines
  await registry.registerEngines(engines, defaultEngine);

  // If no engines registered, register default memory engine
  if (registry.listEngineNames().length === 0) {
    await registry.registerEngines([{ name: "memory", factory: "createMemoryEngine" }], "memory");
  }

  const httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Set default CORS headers for all responses
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Thai-Fts-Engine");

    try {
      await routeRequest(req, res, registry, version);
    } catch (e) {
      // Should not reach here as routeRequest handles errors, but safety net
      const message = e instanceof Error ? e.message : String(e);
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.writeHead(500);
      res.end(JSON.stringify({ ok: false, error: "Internal Error", message }));
    }
  });

  // Graceful shutdown handling. `close()` must actually close: awaiting a
  // promise that only resolves on SIGINT/SIGTERM would hang every programmatic
  // caller (and the test suite) forever. Signal handlers race `close()` and are
  // removed afterwards, so many servers per process don't leak listeners.
  let closingPromise: Promise<void> | null = null;
  let onSigint: (() => void) | null = null;
  let onSigterm: (() => void) | null = null;

  const close = (): Promise<void> => {
    if (closingPromise) return closingPromise;
    closingPromise = new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
      // Node keeps idle keep-alive sockets open, which would delay (or block)
      // the close callback. Force them shut for a deterministic shutdown.
      httpServer.closeAllConnections();
    }).then(() => {
      registry.close();
      if (onSigint) process.off("SIGINT", onSigint);
      if (onSigterm) process.off("SIGTERM", onSigterm);
      console.error("[thai-fts-server] Closed (engines released)");
    });
    return closingPromise;
  };

  const shutdown = (signal: string): void => {
    if (closingPromise) return;
    console.error(`[thai-fts-server] Received ${signal}, shutting down...`);
    void close();
  };
  onSigint = () => shutdown("SIGINT");
  onSigterm = () => shutdown("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  // Start listening
  await new Promise<void>((resolve, reject) => {
    httpServer.listen(port, host, () => {
      console.error(`[thai-fts-server] Listening on http://${host}:${port}`);
      console.error(`[thai-fts-server] Engines: ${registry.listEngineNames().join(", ")}`);
      console.error(`[thai-fts-server] Default engine: ${registry.getDefaultEngineName()}`);
      resolve();
    });

    httpServer.on("error", (err) => {
      reject(err);
    });
  });

  return {
    server: httpServer,
    registry,
    close,
    address: () => {
      const addr = httpServer.address();
      if (typeof addr === "object" && addr) {
        return `http://${addr.address === "::" ? "localhost" : addr.address}:${addr.port}`;
      }
      return `http://${host}:${port}`;
    },
  };
}
