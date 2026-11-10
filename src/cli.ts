#!/usr/bin/env node

const USAGE = `thai-fts - Thai lexical utilities for Node (zero-dependency)

Usage:
  thai-fts --help                show this help

Commands (segment|loose|synonyms|check) arrive with the first milestone.
`;

function main(argv: string[]): number {
  process.stdout.write(USAGE + "\n");
  return 0;
}

process.exitCode = main(process.argv.slice(2));
