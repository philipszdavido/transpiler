"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { tokenize, TranspileError } = require("../src");

const types = (src) => tokenize(src).slice(0, -1).map((t) => `${t.type}:${t.value}`);

test("punctuators use longest match", () => {
  assert.deepEqual(types("a >>>= b ?? c?.d ... e"), [
    "name:a", "punct:>>>=", "name:b", "punct:??", "name:c", "punct:?.", "name:d", "punct:...", "name:e",
  ]);
});

test("`?.` followed by a digit is a conditional", () => {
  assert.deepEqual(types("a?.5:b"), ["name:a", "punct:?", "num:.5", "punct::", "name:b"]);
});

test("numbers", () => {
  assert.deepEqual(types("0x1F 0b10 0o7 1_000 1.5e-3 10n .5"), [
    "num:0x1F", "num:0b10", "num:0o7", "num:1_000", "num:1.5e-3", "num:10n", "num:.5",
  ]);
});

test("regex vs division", () => {
  assert.deepEqual(types("a / b / c"), ["name:a", "punct:/", "name:b", "punct:/", "name:c"]);
  assert.deepEqual(types("x = /a[/]b/gi"), ["name:x", "punct:=", "regex:/a[/]b/gi"]);
  assert.deepEqual(types("return /x/"), ["name:return", "regex:/x/"]);
  assert.deepEqual(types("if (a) /x/.test(b)").slice(4, 5), ["regex:/x/"]);
  assert.deepEqual(types("(a) / 2"), ["punct:(", "name:a", "punct:)", "punct:/", "num:2"]);
  assert.deepEqual(types("o.return / 2"), ["name:o", "punct:.", "name:return", "punct:/", "num:2"]);
});

test("template literals split around substitutions", () => {
  assert.deepEqual(types("`a${ {b:1}.b }c${`d${e}`}`"), [
    "template:`a${", "punct:{", "name:b", "punct::", "num:1", "punct:}", "punct:.", "name:b",
    "template:}c${", "template:`d${", "name:e", "template:}`", "template:}`",
  ]);
});

test("comments and strings are skipped/atomic", () => {
  assert.deepEqual(types(`a /* class */ // x\n"cl\\"ass" 'b'`), ["name:a", "string:\"cl\\\"ass\"", "string:'b'"]);
});

test("newline flags", () => {
  const toks = tokenize("a\nb /*\n*/ c d");
  assert.deepEqual(toks.slice(0, 4).map((t) => t.nl), [false, true, true, false]);
});

test("private names and unicode identifiers", () => {
  assert.deepEqual(types("#x café \\u0061b"), ["private:#x", "name:café", "name:\\u0061b"]);
});

test("unterminated literals throw TranspileError", () => {
  for (const src of ['"abc', "`abc", "/* x", "x = /abc"]) {
    assert.throws(() => tokenize(src), TranspileError, src);
  }
});
