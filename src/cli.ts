#!/usr/bin/env node
/**
 * thai-fts CLI — tone-aware Thai full-text utilities + a small dual-channel
 * FTS5 index/search interface. Zero runtime dependencies (Intl.Segmenter +
 * node:sqlite built-ins), pipe-friendly plain output, optional `--json`
 * wrapping as `{ ok, data }` (mcp-compatible). Exit codes: 0 ok (including an
 * empty search), 2 error.
 *
 * FTS5 commands share ONE engine per invocation (created lazily on the first
 * index/search, closed on exit), so an `:memory:` database can be indexed and
 * searched within a single run:
 *
 *   thai-fts index "ต้องติดตั้งโปรแกรมใหม่" --id a \
 *              index "ติดตังค่าบริการ" --id b \
 *              search "ติดตั้ง" --db :memory:
 */
import { hasThai, looseForm, wordTokens } from "./core/segment.js";
import { expandSynonyms } from "./core/synonyms.js";
import { createFts5Engine } from "./adapters/fts5/index.js";
import type { ThaiSearchEngine, ThaiSearchResult } from "./adapters/engine.js";
import type { ToneMode } from "./core/types.js";
import { createServer } from "./server/index.js";

const USAGE = `thai-fts v0.3.0 - tone-aware Thai full-text search for Node (zero dependencies)

Usage:
  thai-fts <command> [<text>] [options]
  thai-fts --json <command> [<text>] [options]   wrap output as { ok, data }

Commands may be chained in order; FTS5 commands share one engine per run (so
:memory: databases can be indexed and searched in the same invocation).

Core commands (pure, no database):
  segment "<text>"        word tokens, one per line
  loose   "<text>"        tone-tolerant (de-accented) form, e.g. ติดตั้ง -> ติดตัง
  synonyms "<term>"       transliteration/meaning partners, one per line
  check   "<text>"        1 if Thai is present, else 0

FTS5 commands (SQLite FTS5 via node:sqlite):
  index   "<text>" [--id <id>]    segment + store a document (silent on success;
          [--json]                     --json returns the stored id)
  search  "<query>" [--limit N]   dual-channel search; prints "id<TAB>rank" per
          [--tone strict|loose|both]   hit, plus "<TAB>snippet" when one exists.
          [--loose]               --loose is shorthand for --tone loose.
                                  No hits prints nothing (exit 0).

Server commands:
  serve                   start REST API server (HTTP wrapper for engines)
      [--port <N>]        port to listen on (default 3000, env PORT)
      [--host <host>]     host to bind (default 0.0.0.0, env HOST)
      [--engine <name>]   register engine (repeatable): memory, fts5:memory, fts5:file
                          memory        → createMemoryEngine({})
                          fts5:memory   → createFts5Engine({ memory: true })
                          fts5:file     → createFts5Engine({ path: "./data.db" })
      [--default <name>]  default engine name (default: first sync engine)

Options:
  --db <path>       database path (default :memory:)
  --id <id>         document id for an index command (default: running ordinal
                     1, 2, 3... in this invocation)
  --limit <N>       max results (default 10)
  --tone <mode>     strict | loose | both (default both: strict first, loose
                     rescue appended below while under the limit)
  --json            wrap each command's output as { ok, data }
  -h, --help        show this help

Exit codes:
  0   ok (including an empty search)
  2   error (usage / unknown command / evaluated failure)

Examples:
  thai-fts segment "ติดตั้งโปรแกรม"          # ติดตั้ง, โปรแกรม (per line)
  thai-fts loose "ติดตั้ง"                  # -> ติดตัง
  thai-fts synonyms deploy                 # -> ดีพลอย
  thai-fts check "hello"                   # -> 0
  thai-fts index "ต้องติดตั้งโปรแกรมใหม่" --id first --db fts.db
  thai-fts search "ติดตั้ง" --db fts.db --tone strict
  thai-fts index "ติดตังค่าบริการ" --id b search "ติดตัง" --tone both --db :memory:
  thai-fts serve --port 3000 --engine memory --engine fts5:memory
  thai-fts serve --engine memory --engine fts5:file --default memory
`;

const COMMANDS = new Set([
  "segment",
  "loose",
  "synonyms",
  "check",
  "index",
  "search",
  "serve",
]);

class CliError extends Error {}

interface Op {
  cmd: string;
  text: string[];
  id?: string;
  limit?: number;
  tone?: ToneMode;
}

interface Parsed {
  ops: Op[];
  db: string;
  json: boolean;
  help: boolean;
  // Server options
  port?: number;
  host?: string;
  engines: Array<{ name: string; factory: string; options?: Record<string, unknown> }>;
  defaultEngine?: string;
}

function jsonRequested(argv: string[]): boolean {
  for (const t of argv) {
    if (t === "--") break;
    if (t === "--json") return true;
  }
  return false;
}

function parseEngineSpec(spec: string): { name: string; factory: string; options?: Record<string, unknown> } {
  // Built-in engine specs
  switch (spec) {
    case "memory":
      return { name: "memory", factory: "createMemoryEngine", options: {} };
    case "fts5:memory":
      return { name: "fts5:memory", factory: "createFts5Engine", options: { memory: true } };
    case "fts5:file":
      return { name: "fts5:file", factory: "createFts5Engine", options: { path: "./data.db" } };
    default:
      throw new CliError(
        `unknown engine spec "${spec}" (expected: memory, fts5:memory, fts5:file)`
      );
  }
}

function parse(argv: string[]): Parsed {
  const ops: Op[] = [];
  let current: Op | null = null;
  let pending: Partial<Op> = {};
  let db = ":memory:";
  let json = false;
  let help = false;
  let port: number | undefined;
  let host: string | undefined;
  const engines: Parsed["engines"] = [];
  let defaultEngine: string | undefined;

  const attach = (part: Partial<Op>): void => {
    if (current) Object.assign(current, part);
    else Object.assign(pending, part);
  };
  const addText = (t: string): void => {
    if (!current) {
      throw new CliError(`unknown command "${t}" (run thai-fts --help)`);
    }
    current.text.push(t);
  };

  for (let i = 0; i < argv.length; i++) {
    const t = argv[i] as string;
    switch (t) {
      case "--": {
        for (let k = i + 1; k < argv.length; k++) addText(argv[k] as string);
        return { ops, db, json, help, port, host, engines, defaultEngine };
      }
      case "--json":
        json = true;
        break;
      case "--db":
        db = argv[++i] ?? "";
        break;
      case "--id": {
        const v = argv[++i] ?? "";
        attach({ id: v });
        break;
      }
      case "--limit": {
        const v = Number(argv[++i]);
        if (!Number.isInteger(v) || v < 1) {
          throw new CliError("--limit requires a positive integer");
        }
        attach({ limit: v });
        break;
      }
      case "--tone": {
        const v = (argv[++i] ?? "").toLowerCase();
        if (v !== "strict" && v !== "loose" && v !== "both") {
          throw new CliError(`--tone must be strict, loose or both (got ${JSON.stringify(v)})`);
        }
        attach({ tone: v });
        break;
      }
      case "--loose":
        attach({ tone: "loose" });
        break;
      case "--port": {
        const v = Number(argv[++i]);
        if (!Number.isInteger(v) || v < 1 || v > 65535) {
          throw new CliError("--port requires a valid port number (1-65535)");
        }
        port = v;
        break;
      }
      case "--host": {
        host = argv[++i] ?? "";
        break;
      }
      case "--engine": {
        const spec = argv[++i] ?? "";
        engines.push(parseEngineSpec(spec));
        break;
      }
      case "--default": {
        defaultEngine = argv[++i] ?? "";
        break;
      }
      case "-h":
      case "--help":
        help = true;
        break;
      default:
        if (COMMANDS.has(t)) {
          current = { cmd: t, text: [], ...pending };
          pending = {};
          ops.push(current);
        } else if (t.startsWith("-") && t !== "-") {
          throw new CliError(`unknown option "${t}"`);
        } else {
          addText(t);
        }
    }
  }

  return { ops, db, json, help, port, host, engines, defaultEngine };
}

function fail(message: string, asJson: boolean): number {
  if (asJson) {
    process.stdout.write(JSON.stringify({ ok: false, data: message }) + "\n");
  } else {
    process.stderr.write(`error: ${message}\n`);
  }
  return 2;
}

function emit(data: string, json: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify({ ok: true, data }) + "\n");
  } else {
    process.stdout.write(`${data}\n`);
  }
}

function renderResult(r: ThaiSearchResult): string {
  let line = `${String(r.id)}\t${r.rank}`;
  if (r.snippet) line += `\t${r.snippet}`;
  return line;
}

async function runServe(
  port: number | undefined,
  host: string | undefined,
  engines: Parsed["engines"],
  defaultEngine: string | undefined
): Promise<number> {
  const serverPort = (port ?? Number(process.env.PORT)) || 3000;
  const serverHost = (host ?? process.env.HOST) || "0.0.0.0";

  // If no engines specified via CLI, check env var
  let serverEngines = engines;
  if (serverEngines.length === 0) {
    const envEngines = process.env.THAI_FTS_ENGINES;
    if (envEngines) {
      serverEngines = envEngines.split(",").map((s) => parseEngineSpec(s.trim()));
    }
  }

  // Default to memory engine if nothing specified
  if (serverEngines.length === 0) {
    serverEngines = [{ name: "memory", factory: "createMemoryEngine", options: {} }];
  }

  try {
    const server = await createServer({
      port: serverPort,
      host: serverHost,
      engines: serverEngines,
      defaultEngine,
    });

    console.error(`[thai-fts] Server running at ${server.address()}`);
    console.error(`[thai-fts] Press Ctrl+C to stop`);

    // Wait for shutdown signal
    await new Promise<void>((resolve) => {
      process.on("SIGINT", () => resolve());
      process.on("SIGTERM", () => resolve());
    });

    await server.close();
    console.error("[thai-fts] Server stopped");
    return 0;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    process.stderr.write(`error: ${message}\n`);
    return 2;
  }
}

function main(argv: string[]): number | Promise<number> {
  const asJson = jsonRequested(argv);
  let parsed: Parsed;
  try {
    parsed = parse(argv);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e), asJson);
  }

  if (parsed.help || parsed.ops.length === 0) {
    process.stdout.write(USAGE + "\n");
    return 0;
  }

  // Handle serve command specially (async, long-running)
  if (parsed.ops.some((op) => op.cmd === "serve")) {
    if (parsed.ops.length > 1) {
      return fail("serve command cannot be chained with other commands", asJson);
    }
    return runServe(parsed.port, parsed.host, parsed.engines, parsed.defaultEngine);
  }

  let engine: ThaiSearchEngine | null = null;
  let indexOrdinal = 0;

  try {
    for (const op of parsed.ops) {
      const text = op.text.join(" ").trim();
      switch (op.cmd) {
        case "segment":
          emit(wordTokens(text).filter(Boolean).join("\n"), parsed.json);
          break;
        case "loose":
          emit(looseForm(text), parsed.json);
          break;
        case "synonyms":
          emit(expandSynonyms(text).slice(1).join("\n"), parsed.json);
          break;
        case "check":
          emit(hasThai(text) ? "1" : "0", parsed.json);
          break;
        case "index": {
          if (!text) throw new CliError("index requires a non-empty <text>");
          if (!engine) engine = createFts5Engine({ path: parsed.db });
          const id = op.id ?? String(++indexOrdinal);
          engine.add({ id, body: text });
          if (parsed.json) emit(id, parsed.json);
          break;
        }
        case "search": {
          if (!engine) engine = createFts5Engine({ path: parsed.db });
          const results = engine.search(text, { tone: op.tone, limit: op.limit });
          if (parsed.json) {
            const data = results.map((r) =>
              r.snippet ? { id: r.id, rank: r.rank, snippet: r.snippet } : { id: r.id, rank: r.rank }
            );
            process.stdout.write(JSON.stringify({ ok: true, data }) + "\n");
          } else {
            for (const r of results) process.stdout.write(renderResult(r) + "\n");
          }
          break;
        }
        default:
          throw new CliError(`unknown command "${op.cmd}" (run thai-fts --help)`);
      }
    }
    return 0;
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e), asJson);
  } finally {
    if (engine) {
      try {
        engine.close();
      } catch {
        // close is best-effort on an already-failed run
      }
    }
  }
}

// `main` is sync for one-shot commands but returns a promise for `serve`
// (it resolves only on shutdown). Assigning the promise to process.exitCode
// throws ERR_INVALID_ARG_TYPE, so settle it explicitly instead.
const mainResult = main(process.argv.slice(2));
if (typeof mainResult === "number") {
  process.exitCode = mainResult;
} else {
  mainResult.then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 2;
    }
  );
}