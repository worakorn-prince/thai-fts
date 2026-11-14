/**
 * Direct-run entry for the thai-fts REST API server — `node dist/server/main.js`.
 *
 * This is a SEPARATE file from `index.ts` on purpose: the CLI bundle
 * (`dist/cli.js`) imports `createServer` from `index.ts`, and tsup inlines
 * every import into that single file. An auto-start block living in
 * `index.ts` would therefore execute inside EVERY CLI invocation
 * (`import.meta.url === pathToFileURL(argv[1]).href` is true for the bundle),
 * making `thai-fts loose "..."` try to listen on port 3000 and hang.
 * Only `main.ts` — never imported by the CLI — may auto-start the server.
 */

import { createServer } from "./index.js";

const args = process.argv.slice(2);
const port =
  Number(args.find((a) => a.startsWith("--port="))?.split("=")[1]) ||
  Number(process.env.PORT) ||
  3000;
const host =
  args.find((a) => a.startsWith("--host="))?.split("=")[1] ||
  process.env.HOST ||
  "0.0.0.0";

// Parse engine args: --engine memory --engine fts5:memory
const engineArgs = args.filter((a) => a.startsWith("--engine=")).map((a) => a.split("=")[1]);
const engines = engineArgs.map((name) => ({
  name: name ?? "memory",
  factory: name?.includes("fts5") ? "createFts5Engine" : "createMemoryEngine",
}));

createServer({ port, host, engines }).catch((err) => {
  console.error("[thai-fts-server] Failed to start:", err);
  process.exit(1);
});
