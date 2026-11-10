import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/cli.ts",
    "src/core/index.ts",
    "src/engine/index.ts",
    "src/fts5/index.ts",
  ],
  format: ["esm", "cjs"],
  dts: true,
  outDir: "dist",
  clean: true,
  target: "es2022",
  sourcemap: false,
  splitting: false,
  platform: "node",
  // node:sqlite must survive the bundle verbatim: Node resolves built-ins only
  // through the `node:` protocol, so esbuild must treat it as external rather
  // than stripping the prefix (which would produce a broken bare `sqlite`).
  external: ["node:sqlite"],
  // tsup defaults to removeNodeProtocol:true, which would strip the `node:`
  // prefix from the external import above and emit a broken bare `sqlite`.
  // This overrides that default (tsup spreads config-file options last).
  removeNodeProtocol: false,
});
