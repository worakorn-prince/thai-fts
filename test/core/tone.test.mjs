// Tone policy helpers: resolveToneMode defaults (strict-first "both" dual
// channel) and explicit overrides, plus the looseForm re-export.
import { test } from "node:test";
import assert from "node:assert/strict";

const { resolveToneMode, looseForm } = await import("../../dist/index.js");

test("resolveToneMode defaults to both (strict-first dual-channel)", () => {
  assert.equal(resolveToneMode(), "both");
  assert.equal(resolveToneMode(undefined), "both");
  assert.equal(resolveToneMode(null), "both");
  assert.equal(resolveToneMode({}), "both");
  assert.equal(resolveToneMode({ tone: undefined }), "both");
});

test("resolveToneMode honors explicit overrides", () => {
  assert.equal(resolveToneMode("strict"), "strict");
  assert.equal(resolveToneMode("loose"), "loose");
  assert.equal(resolveToneMode("both"), "both");
  assert.equal(resolveToneMode({ tone: "strict" }), "strict");
  assert.equal(resolveToneMode({ tone: "loose" }), "loose");
  assert.equal(resolveToneMode({ tone: "both" }), "both");
});

test("resolveToneMode falls back to the default on unknown values", () => {
  assert.equal(resolveToneMode("nope"), "both");
  assert.equal(resolveToneMode({ tone: "nope" }), "both");
  assert.equal(resolveToneMode({}), "both");
});

test("tone re-exports looseForm from segment", () => {
  assert.equal(typeof looseForm, "function");
  assert.equal(looseForm("ติดตั้ง"), "ติดตัง");
  assert.equal(looseForm("Hello WORLD"), "hello world");
});
