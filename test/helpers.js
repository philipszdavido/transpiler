"use strict";

const vm = require("vm");
const { transpile, tokenize } = require("../src");

// Transpiles `source` and evaluates it in a fresh context; returns the value
// of the final expression statement.
function run(source, globals = {}) {
  const { code } = transpile(source);
  assertNoClassSyntax(code);
  return new vm.Script(code, { filename: "transpiled.js" }).runInNewContext({ ...globals });
}

// Output must not contain any `class` keyword (property names like `x.class` are fine).
function assertNoClassSyntax(code) {
  const tokens = tokenize(code);
  tokens.forEach((tok, i) => {
    const prev = tokens[i - 1];
    const isProp = prev && prev.type === "punct" && (prev.value === "." || prev.value === "?.");
    if (tok.type === "name" && tok.value === "class" && !isProp) {
      throw new Error(`Transpiled output still contains 'class' at ${tok.start}:\n${code}`);
    }
  });
}

module.exports = { run, assertNoClassSyntax };
