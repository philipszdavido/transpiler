"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const BIN = path.join(__dirname, "..", "bin", "transpile.js");

function cli(args, { input, cwd } = {}) {
  return spawnSync(process.execPath, [BIN, ...args], { input, cwd, encoding: "utf8" });
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "transpile-test-"));
}

test("reads stdin and writes stdout", () => {
  const r = cli([], { input: "class A {}\n" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /var A = \/\*#__PURE__\*\/\(function \(\) \{/);
});

test("--out-file writes a single file", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "in.js"), "class A {}\n");
  const r = cli(["in.js", "-o", "out/a.js"], { cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(path.join(dir, "out/a.js"), "utf8"), /function A\(\)/);
});

test("--out-dir mirrors relative paths", () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, "src/lib"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src/a.js"), "class A {}\n");
  fs.writeFileSync(path.join(dir, "src/lib/b.js"), "const b = 1;\n");
  const r = cli(["src/a.js", "src/lib/b.js", "-d", "dist"], { cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(path.join(dir, "dist/src/a.js"), "utf8"), /function A\(\)/);
  assert.equal(fs.readFileSync(path.join(dir, "dist/src/lib/b.js"), "utf8"), "const b = 1;\n");
});

test("syntax errors exit 1 with a code frame", () => {
  const r = cli([], { input: "class A {\n  #x = 1;\n}\n" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /<stdin>:2:3: error: Private class members/);
  assert.match(r.stderr, /> 2 \|   #x = 1;/);
});

test("usage errors exit 2", () => {
  assert.equal(cli(["--bogus"]).status, 2);
  assert.equal(cli(["a.js", "b.js", "-o", "x.js"]).status, 2);
  assert.equal(cli(["-o"]).status, 2);
});

test("missing input file exits 1", () => {
  const r = cli(["does-not-exist.js"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /cannot read does-not-exist\.js/);
});

test("--print-helpers emits valid helper source", () => {
  const r = cli(["--print-helpers"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /function _callSuper/);
  new (require("vm").Script)(r.stdout);
});

test("--help and --version", () => {
  assert.match(cli(["--help"]).stdout, /Usage: transpile/);
  assert.match(cli(["--version"]).stdout, /^\d+\.\d+\.\d+\n$/);
});
