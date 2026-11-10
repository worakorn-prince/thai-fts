// CLI test suite: spawns the built dist/cli.js (node:child_process) and
// exercises the core commands, --json wrapping, exit codes, and the
// end-to-end dual-channel FTS5 search flow on :memory: (a single invocation
// shares one engine, so index and search can see the same in-memory DB).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, "..", "dist", "cli.js");
const node = process.execPath;

function run(args = []) {
  return spawnSync(node, [cli, ...args], { encoding: "utf8" });
}

// Full-ICU segmentation is optional on small-icu runtimes; semantic Thai
// assertions (token spelling, FTS phrase isolation) skip then, mirroring the
// core suite. The rest of the surface is runtime-independent.
const skip = typeof Intl.Segmenter !== "function";

test("check: 1 for Thai text, 0 otherwise, exit 0", () => {
  const yes = run(["check", "สวัสดีครับ"]);
  assert.equal(yes.status, 0);
  assert.equal(yes.stdout.trim(), "1");

  const no = run(["check", "hello world"]);
  assert.equal(no.status, 0);
  assert.equal(no.stdout.trim(), "0");
});

test("loose: ติดตั้ง -> ติดตัง (tone marks stripped, vowels kept)", () => {
  const res = run(["loose", "ติดตั้ง"]);
  assert.equal(res.status, 0);
  assert.equal(res.stdout.trim(), "ติดตัง");
});

test("segment: word tokens are line-delimited and never drop characters", { skip }, () => {
  const input = "ติดตั้งโปรแกรมบนเซิร์ฟเวอร์ใหม่";
  const res = run(["segment", input]);
  assert.equal(res.status, 0);
  const tokens = res.stdout.split("\n").filter(Boolean);
  assert.ok(tokens.length >= 2, `expected >= 2 tokens, got ${JSON.stringify(tokens)}`);
  assert.equal(tokens.join(""), input.toLowerCase(), "tokens must rejoin to the lowercased input");
});

test("synonyms: expandSynonyms partners, line-delimited", () => {
  const res = run(["synonyms", "deploy"]);
  assert.equal(res.status, 0);
  assert.equal(res.stdout.trim(), "ดีพลอย");
});

test("--json wraps plain command output as { ok, data }", () => {
  const res = run(["--json", "check", "foo"]);
  assert.equal(res.status, 0);
  assert.deepEqual(JSON.parse(res.stdout), { ok: true, data: "0" });
});

test("--json wraps multi-line segment output as a data string", (t) => {
  const res = run(["--json", "segment", "ติดตั้งโปรแกรม", "เร็วมาก"]);
  assert.equal(res.status, 0);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.ok, true);
  assert.ok(
    typeof parsed.data === "string" && parsed.data.split("\n").length >= 2,
    `segment data should be newline-delimited tokens: ${JSON.stringify(parsed.data)}`
  );
});

test("--json: index returns the stored id as data", { skip }, () => {
  const res = run(["--json", "index", "ต้องติดตั้งโปรแกรมใหม่", "--id", "doc-1", "--db", ":memory:"]);
  assert.equal(res.status, 0);
  assert.deepEqual(JSON.parse(res.stdout), { ok: true, data: "doc-1" });
});

test("unknown command -> exit 2 with an error on stderr (plain mode)", () => {
  const res = run(["frobnicate", "x"]);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /error:/);
  assert.match(res.stderr, /frobnicate/);
});

test("--json wraps errors as { ok:false, data } with a 2 exit code", () => {
  const res = run(["--json", "frobnicate", "x"]);
  assert.equal(res.status, 2);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.ok, false);
  assert.match(parsed.data, /unknown command/i);
});

test("invalid --tone value -> exit 2", () => {
  const res = run(["search", "x", "--tone", "banana"]);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /--tone must be strict, loose or both/i);
});

test("--help exits 0 and lists every command", () => {
  const res = run(["--help"]);
  assert.equal(res.status, 0);
  for (const cmd of ["segment", "loose", "synonyms", "check", "index", "search"]) {
    assert.ok(res.stdout.includes(cmd), `--help should mention ${cmd}`);
  }
});

test("no args prints help and exits 0", () => {
  const res = run([]);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /Usage:/);
});

// --- end-to-end dual-channel FTS5 search on :memory: ------------------------
// One invocation shares one engine (createFts5Engine per run), so the two
// index commands and the search command see the same in-memory database.

const INDEX_DOCS = [
  "index", "ต้องติดตั้งโปรแกรมใหม่", "--id", "first",
  "index", "ติดตังค่าบริการ", "--id", "second",
];

test("e2e strict: ติดตั้ง matches ONLY the first doc; ติดตัง ONLY the second", { skip }, () => {
  const first = run([...INDEX_DOCS, "search", "ติดตั้ง", "--tone", "strict", "--db", ":memory:"]);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(
    first.stdout.trim().split("\n").filter(Boolean).map((l) => l.split("\t")[0]),
    ["first"],
    `ติดตั้ง must match only the first doc\n${first.stdout}`
  );

  const second = run([...INDEX_DOCS, "search", "ติดตัง", "--tone", "strict", "--db", ":memory:"]);
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(
    second.stdout.trim().split("\n").filter(Boolean).map((l) => l.split("\t")[0]),
    ["second"],
    `ติดตัง must match only the second doc\n${second.stdout}`
  );
});

test("e2e both: strict-first ranking then loose rescue (strict-then-loose ordering)", { skip }, () => {
  const res = run([...INDEX_DOCS, "search", "ติดตัง", "--db", ":memory:"]);
  assert.equal(res.status, 0, res.stderr);
  const lines = res.stdout.trim().split("\n").filter(Boolean);
  assert.deepEqual(
    lines.map((l) => l.split("\t")[0]),
    ["second", "first"],
    "strict hit must lead, tone-typo doc must rescue below\n" + res.stdout
  );
  assert.ok(lines[1].startsWith("first\t2\t"), `loose-rescued doc ranks 2\n${res.stdout}`);

  const correct = run([...INDEX_DOCS, "search", "ติดตั้ง", "--db", ":memory:"]);
  assert.equal(correct.status, 0, correct.stderr);
  const correctLines = correct.stdout.trim().split("\n").filter(Boolean);
  assert.ok(
    correctLines[0].startsWith("first\t1\t"),
    `correct-tone doc must lead (strict) for its own query\n${correct.stdout}`
  );
});

test("e2e search prints id<TAB>rank<TAB>snippet and emits nothing on no results (exit 0)", { skip }, () => {
  const res = run([...INDEX_DOCS, "search", "ติดตัง", "--limit", "1", "--db", ":memory:"]);
  assert.equal(res.status, 0, res.stderr);
  const line = res.stdout.trim();
  assert.match(line, /^second\t1\t.+ค่าบริการ/, `expected id\\trank\\tsnippet line\n${line}`);

  const none = run([...INDEX_DOCS, "search", "zzz-no-such-term-999", "--db", ":memory:"]);
  assert.equal(none.status, 0, none.stderr);
  assert.equal(none.stdout.trim(), "", "no results must print nothing");
});

test("e2e --json search returns { ok:true, data:[{id,rank,snippet}] }", { skip }, () => {
  const res = run([...INDEX_DOCS, "search", "ติดตั้ง", "--db", ":memory:", "--json"]);
  assert.equal(res.status, 0, res.stderr);
  // Each command emits its own {ok,data} line (JSONL): two index ids then the
  // search result array on the last line.
  const lines = res.stdout.trim().split("\n").filter(Boolean);
  assert.deepEqual(JSON.parse(lines[0]), { ok: true, data: "first" });
  assert.deepEqual(JSON.parse(lines[1]), { ok: true, data: "second" });
  const search = JSON.parse(lines[lines.length - 1]);
  assert.equal(search.ok, true);
  assert.ok(Array.isArray(search.data) && search.data.length >= 1);
  const [first] = search.data;
  assert.equal(first.id, "first");
  assert.equal(first.rank, 1);
  assert.ok(typeof first.snippet === "string");
});

test("e2e --tone loose rescues the correct-tone doc even for a pure typo query", { skip }, () => {
  const res = run([...INDEX_DOCS, "search", "ติดตัง", "--tone", "loose", "--db", ":memory:"]);
  assert.equal(res.status, 0, res.stderr);
  const ids = res.stdout.trim().split("\n").filter(Boolean).map((l) => l.split("\t")[0]).sort();
  assert.deepEqual(ids, ["first", "second"], "loose channel should surface both docs");
});
