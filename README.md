# thai-fts

Zero-dependency Thai tokenization & full-text search for Node — mark-aware
word segmentation, tone-tolerant matching, synonyms, and an SQLite FTS5 layer.
Built on Node built-ins only (`node:sqlite`, `node:test`, `node:fs`).

## Status

Skeleton (`v0.1.0`): dual ESM + CJS build, package CLI stub, smoke tests
wired. Core tokenizer, match engine, and FTS5 layer arrive in later
milestones.

## API (planned)

- `core` — `wordTokens()`, `segmentForIndex()`, `looseForm()`, `hasThai()`
- `engine` — FTS match builder + tone-tolerant fallback channel
- `fts5` — `node:sqlite` FTS5 table with a mark-aware tokenizer

## CLI

```
Usage:
  thai-fts --help                show this help
```

## Development

```sh
npm install
npm run build     # tsup -> dist/ (ESM + CJS + d.ts)
npm test          # build + node --test smoke tests
npm run pack:check
```

## License

MIT
