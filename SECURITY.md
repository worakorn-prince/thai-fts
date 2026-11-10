# Security Policy

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Instead, report privately to the maintainer. While a dedicated security channel
is being set up, email the repository owner through the contact listed on the
[GitHub profile](https://github.com/worakorn-prince) — or open a private
advisory via GitHub's **Security → Report a vulnerability** flow for this
repository.

Please include, when possible:

- the affected version(s) and how you installed the package;
- a minimal reproduction (code / CLI invocation);
- the impact you observed.

You should expect an acknowledgment within a few days and a fix or a clear
mitigation plan from there.

## Security model

- **Query construction is injection-safe by design.** User input is never
  concatenated into raw SQL or FTS5 `MATCH` text. Every token is routed through
  `quoteFtsToken` (FTS5 backslash/quote escaping) by `buildFtsMatch` /
  `buildLooseFtsMatch`, and SQL parameters are bound via prepared statements on
  `node:sqlite`. Adversarial inputs (`*`, `-`, `NEAR`, `"`, `\`, `;`, `--`,
  `drop table`) are exercised in the test suite and cannot throw or escape.
- **`LIKE` fallback is escaped.** The short pure-Thai `LIKE` scan escapes
  `\ % _`, so raw query text cannot act as a wildcard pattern.
- **Zero runtime dependencies.** The library depends only on Node built-ins
  (`Intl.Segmenter`, `node:sqlite`), which keeps the supply-chain surface that
  ships to consumers effectively empty.
- **Explicit resource lifecycle.** Engines/stores require an explicit
  `close()` and are idempotent; the CLI closes its engine in a `finally` block.

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | ✅ |
