"use strict";

// Words that can't be used as binding names in strict-mode ES5 output.
const RESERVED = new Set(
  (
    "break case catch class const continue debugger default delete do else enum export extends " +
    "false finally for function if implements import in instanceof interface let new null package " +
    "private protected public return static super switch this throw true try typeof var void while " +
    "with yield await arguments eval"
  ).split(" ")
);

// Keywords that cannot end an expression (used for class-field ASI).
const NON_TERMINAL_KEYWORDS = new Set([
  "typeof", "instanceof", "in", "of", "new", "delete", "void", "await", "yield", "extends",
]);

// Keywords that must be followed by an expression, so a following `class` is a class expression.
const EXPRESSION_KEYWORDS = new Set([...NON_TERMINAL_KEYWORDS, "return", "throw", "case", "default"]);

const OPENERS = { "(": ")", "[": "]", "{": "}" };

function isPunct(tok, value) {
  return tok !== undefined && tok.type === "punct" && tok.value === value;
}

function isName(tok, value) {
  return tok !== undefined && tok.type === "name" && (value === undefined || tok.value === value);
}

function isOpener(tok) {
  return tok !== undefined && tok.type === "punct" && Object.prototype.hasOwnProperty.call(OPENERS, tok.value);
}

function isValidBindingName(name) {
  return /^[$_\p{ID_Start}][$‌‍\p{ID_Continue}]*$/u.test(name) && !RESERVED.has(name);
}

function isLineTerminator(ch) {
  return ch === "\n" || ch === "\r" || ch === " " || ch === " ";
}

// Leading whitespace of the line containing `pos`.
function lineIndent(source, pos) {
  const lineStart = source.lastIndexOf("\n", pos - 1) + 1;
  return /^[ \t]*/.exec(source.slice(lineStart, pos))[0];
}

module.exports = {
  RESERVED,
  NON_TERMINAL_KEYWORDS,
  EXPRESSION_KEYWORDS,
  OPENERS,
  isPunct,
  isName,
  isOpener,
  isValidBindingName,
  isLineTerminator,
  lineIndent,
};
