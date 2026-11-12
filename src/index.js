"use strict";

const { Parser } = require("./parser");
const { Visitor } = require("./visitor");
const { tokenize } = require("./scanner");
const { TranspileError } = require("./errors");
const { helpersSource } = require("./helpers");

/**
 * Transpiles `source`, lowering class syntax to ES5.
 *
 * Pipeline: scanner (tokens) → parser (bracket matching, class AST on demand)
 * → visitor (ES5 output, copying all non-class source verbatim).
 *
 * @param {string} source
 * @param {{ filename?: string, helpers?: boolean }} [options]
 *   helpers: inject runtime helpers into the output (default true). Set to
 *   false when the helper functions are provided globally.
 * @returns {{ code: string, helpers: string[], classes: number }}
 */
function transpile(source, options = {}) {
  if (typeof source !== "string") throw new TypeError("transpile(source): source must be a string");
  const visitor = new Visitor(new Parser(source, options.filename));
  const { head, helpers, body, tail } = visitor.visitProgram();
  const inject = options.helpers !== false && helpers;
  const code = inject ? `${head}${helpers}\n\n${body}${tail}` : `${head}${body}${tail}`;
  return {
    code,
    helpers: [...visitor.usedHelpers].map((key) => visitor.helperNames[key]),
    classes: visitor.classCount,
  };
}

module.exports = { transpile, TranspileError, tokenize, helpersSource };
