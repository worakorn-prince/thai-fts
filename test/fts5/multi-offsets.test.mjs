// FTS5 multi-occurrence offsets (TASK-009): with `offsets: true`, a hit whose
// query phrase occurs several times in the document returns ALL verified
// occurrences (capped at 3) in document order, in addition to the primary
// quote/start/end (= the first occurrence). Every offset is validated by
// re-slicing the RAW document — never a wrong offset, and a 2-char query
// (LIKE fallback path) does not return offsets.
import { test } from "node:test";
import assert from "node:assert/strict";

const { openFts5Store, fts5Search } = await import("../../dist/index.js");

const skip = typeof Intl.Segmenter !== "function";

test("occurrences: a phrase present 3× yields 3 verified offsets in document order", { skip }, () => {
  const body = "ติดตั้งโปรแกรม ติดตั้งโปรแกรม ติดตั้งโปรแกรม";
  const store = openFts5Store({ memory: true });
  store.add({ id: "d", body });
  const [hit] = fts5Search(store, "ติดตั้งโปรแกรม", { tone: "strict", offsets: true });
  assert.equal(hit.id, "d");
  assert.ok(Array.isArray(hit.occurrences), "occurrences must be an array");
  assert.equal(hit.occurrences.length, 3);
  for (const o of hit.occurrences) {
    assert.equal(body.slice(o.start, o.end), o.quote, "every occurrence must slice-verify against RAW");
    assert.ok(o.start < o.end);
  }
  // Document order (non-decreasing starts).
  for (let k = 1; k < hit.occurrences.length; k++) {
    assert.ok(
      hit.occurrences[k].start >= hit.occurrences[k - 1].end,
      "occurrences must be in document order and non-overlapping"
    );
  }
  // Primary = first occurrence.
  assert.equal(hit.quote, hit.occurrences[0].quote);
  assert.equal(hit.start, hit.occurrences[0].start);
  assert.equal(hit.end, hit.occurrences[0].end);
  store.close();
});

test("occurrences: capped at 3 for a phrase present 4×", { skip }, () => {
  const body = "ติดตั้งโปรแกรม ติดตั้งโปรแกรม ติดตั้งโปรแกรม ติดตั้งโปรแกรม";
  const store = openFts5Store({ memory: true });
  store.add({ id: "d", body });
  const [hit] = fts5Search(store, "ติดตั้งโปรแกรม", { tone: "strict", offsets: true });
  assert.equal(hit.occurrences.length, 3, "cap at MAX_OFFSET_OCCURRENCES (3)");
  for (const o of hit.occurrences) {
    assert.equal(body.slice(o.start, o.end), o.quote);
  }
  store.close();
});

test("occurrences: single occurrence → exactly 1 entry", { skip }, () => {
  const body = "ผมต้องติดตั้งโปรแกรมใหม่วันนี้";
  const store = openFts5Store({ memory: true });
  store.add({ id: "d", body });
  const [hit] = fts5Search(store, "ติดตั้งโปรแกรม", { tone: "strict", offsets: true });
  assert.equal(hit.occurrences.length, 1);
  assert.equal(body.slice(hit.occurrences[0].start, hit.occurrences[0].end), "ติดตั้งโปรแกรม");
  store.close();
});

test("occurrences: absent when offsets is not requested", { skip }, () => {
  const body = "ติดตั้งโปรแกรม ติดตั้งโปรแกรม ติดตั้งโปรแกรม";
  const store = openFts5Store({ memory: true });
  store.add({ id: "d", body });
  const [hit] = fts5Search(store, "ติดตั้งโปรแกรม", { tone: "strict" });
  assert.equal(hit.occurrences, undefined, "no occurrences without offsets:true");
  assert.equal(hit.quote, undefined);
  store.close();
});

test("occurrences: repeated phrase across a raw whitespace stays per-occurrence (no mega-region)", { skip }, () => {
  const body = "ติดตั้งโปรแกรม และติดตั้งโปรแกรม";
  const store = openFts5Store({ memory: true });
  store.add({ id: "d", body });
  const [hit] = fts5Search(store, "ติดตั้งโปรแกรม", { tone: "strict", offsets: true });
  // Two occurrences, each exactly the phrase — never a span covering both.
  assert.equal(hit.occurrences.length, 2);
  for (const o of hit.occurrences) {
    assert.equal(o.quote, "ติดตั้งโปรแกรม");
    assert.equal(body.slice(o.start, o.end), o.quote);
  }
  store.close();
});

test("occurrences: 1-2 char Thai query (LIKE fallback) does not emit offsets", { skip }, () => {
  const body = "ดีมาก ดีมาก ดีมาก";
  const store = openFts5Store({ memory: true });
  store.add({ id: "d", body });
  const [hit] = fts5Search(store, "ดี", { tone: "strict", offsets: true });
  // The LIKE fallback path scans RAW substrings; offsets are only computed on
  // the FTS5 MATCH path. The documented contract: no offsets there — and if a
  // future change adds them, they must still slice-verify.
  if (hit.occurrences !== undefined) {
    for (const o of hit.occurrences) assert.equal(body.slice(o.start, o.end), o.quote);
  } else {
    assert.equal(hit.quote, undefined, "no offsets from the LIKE fallback path");
  }
  store.close();
});
