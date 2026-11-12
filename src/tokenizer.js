"use strict";

const { TranspileError } = require("./errors");

/**
 * Lexes modern JavaScript into a flat token list. Whitespace and comments are
 * not emitted as tokens; the transformer copies them verbatim from the source
 * gaps between tokens, which is what keeps untouched code byte-identical.
 *
 * Token: { type, value, start, end, nl }
 *   type: "name" | "private" | "num" | "string" | "template" | "regex" | "punct" | "eof"
 *   nl:   true when a line terminator precedes the token (needed for ASI)
 *
 * Template literals are split into chunks so that `${ ... }` contents are
 * ordinary tokens: "`a${", "}b${", "}c`". A chunk's `tail` flag marks the
 * closing chunk.
 */

const PUNCTUATORS = [
  ">>>=", "...", "===", "!==", "**=", "<<=", ">>=", ">>>", "&&=", "||=", "??=",
  "=>", "==", "!=", "<=", ">=", "&&", "||", "??", "?.", "++", "--", "+=", "-=",
  "*=", "/=", "%=", "&=", "|=", "^=", "<<", ">>", "**",
  "{", "}", "(", ")", "[", "]", ";", ",", "<", ">", "+", "-", "*", "/", "%",
  "&", "|", "^", "!", "~", "?", ":", "=", ".", "@",
];

// Keywords after which a `/` starts a regular expression rather than division.
const REGEX_AFTER_KEYWORD = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
  "throw", "case", "do", "else", "yield", "await", "extends",
]);

const PAREN_KEYWORDS = new Set(["if", "while", "for", "with"]);

const ID_PART = String.raw`(?:[$‌‍\p{ID_Continue}]|\\u[0-9a-fA-F]{4}|\\u\{[0-9a-fA-F]+\})`;
const ID_START = String.raw`(?:[$_\p{ID_Start}]|\\u[0-9a-fA-F]{4}|\\u\{[0-9a-fA-F]+\})`;
const IDENT_RE = new RegExp(`${ID_START}${ID_PART}*`, "uy");
const NUMBER_RE =
  /(?:0[xX][\da-fA-F_]+n?|0[oO][0-7_]+n?|0[bB][01_]+n?|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?n?)/y;

function isLineTerminator(ch) {
  return ch === "\n" || ch === "\r" || ch === "\u2028" || ch === "\u2029";
}

function tokenize(source, filename) {
  const tokens = [];
  const len = source.length;
  // Tracks `{` (brace) vs `${` (template) so a `}` knows whether it resumes a template.
  const braceStack = [];
  // Tracks whether each open `(` followed if/while/for/with.
  const parenStack = [];
  let pos = 0;
  let nl = false;

  const fail = (msg, at) => {
    throw new TranspileError(msg, source, at === undefined ? pos : at, filename);
  };

  const push = (type, start, end, extra) => {
    const tok = { type, value: source.slice(start, end), start, end, nl };
    if (extra) Object.assign(tok, extra);
    tokens.push(tok);
    nl = false;
    return tok;
  };

  const regexAllowed = () => {
    const prev = tokens[tokens.length - 1];
    if (!prev) return true;
    switch (prev.type) {
      case "num":
      case "string":
      case "regex":
      case "private":
        return false;
      case "template":
        return !prev.tail;
      case "name": {
        // `obj.return / 2` is a property access, not the keyword.
        const before = tokens[tokens.length - 2];
        if (before && before.type === "punct" && (before.value === "." || before.value === "?.")) return false;
        return REGEX_AFTER_KEYWORD.has(prev.value);
      }
      case "punct":
        if (prev.value === ")") return Boolean(prev.parenKeyword);
        if (prev.value === "]") return false;
        if (prev.value === "++" || prev.value === "--") return false;
        return true;
      default:
        return true;
    }
  };

  // Scans template characters from `pos` (just after "`" or "}") to the next "${" or "`".
  const scanTemplate = (start) => {
    while (pos < len) {
      const ch = source[pos];
      if (ch === "\\") {
        pos += 2;
        continue;
      }
      if (ch === "`") {
        pos++;
        push("template", start, pos, { tail: true });
        return;
      }
      if (ch === "$" && source[pos + 1] === "{") {
        pos += 2;
        push("template", start, pos, { tail: false });
        braceStack.push("template");
        return;
      }
      pos++;
    }
    fail("Unterminated template literal", start);
  };

  if (source.startsWith("#!")) {
    while (pos < len && !isLineTerminator(source[pos])) pos++;
  }

  while (pos < len) {
    const ch = source[pos];
    const next = source[pos + 1];

    // Whitespace and line terminators.
    if (isLineTerminator(ch)) {
      nl = true;
      pos++;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\v" || ch === "\f" || ch === "﻿" || /\s/.test(ch)) {
      pos++;
      continue;
    }

    // Comments.
    if (ch === "/" && next === "/") {
      while (pos < len && !isLineTerminator(source[pos])) pos++;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", pos + 2);
      if (end === -1) fail("Unterminated comment");
      const body = source.slice(pos, end);
      if (/[\n\r\u2028\u2029]/.test(body)) nl = true;
      pos = end + 2;
      continue;
    }

    const start = pos;

    // Strings.
    if (ch === '"' || ch === "'") {
      pos++;
      while (pos < len && source[pos] !== ch) {
        if (source[pos] === "\\") pos++;
        else if (source[pos] === "\n") fail("Unterminated string literal", start);
        pos++;
      }
      if (pos >= len) fail("Unterminated string literal", start);
      pos++;
      push("string", start, pos);
      continue;
    }

    // Templates.
    if (ch === "`") {
      pos++;
      scanTemplate(start);
      continue;
    }

    // Numbers (including leading-dot decimals such as `.5`).
    if ((ch >= "0" && ch <= "9") || (ch === "." && next >= "0" && next <= "9")) {
      NUMBER_RE.lastIndex = pos;
      const m = NUMBER_RE.exec(source);
      pos += m[0].length;
      push("num", start, pos);
      continue;
    }

    // Private names.
    if (ch === "#") {
      IDENT_RE.lastIndex = pos + 1;
      const m = IDENT_RE.exec(source);
      if (!m) fail("Unexpected character '#'");
      pos += 1 + m[0].length;
      push("private", start, pos);
      continue;
    }

    // Identifiers and keywords.
    IDENT_RE.lastIndex = pos;
    const ident = IDENT_RE.exec(source);
    if (ident) {
      pos += ident[0].length;
      push("name", start, pos);
      continue;
    }

    // Regular expressions.
    if (ch === "/" && regexAllowed()) {
      pos++;
      let inClass = false;
      while (true) {
        if (pos >= len || isLineTerminator(source[pos])) fail("Unterminated regular expression", start);
        const c = source[pos];
        if (c === "\\") {
          pos += 2;
          continue;
        }
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) break;
        pos++;
      }
      pos++;
      IDENT_RE.lastIndex = pos;
      const flags = IDENT_RE.exec(source);
      if (flags) pos += flags[0].length;
      push("regex", start, pos);
      continue;
    }

    // `}` closing a template substitution resumes the template.
    if (ch === "}" && braceStack[braceStack.length - 1] === "template") {
      braceStack.pop();
      pos++;
      scanTemplate(start);
      continue;
    }

    // Punctuators.
    let punct = null;
    for (const p of PUNCTUATORS) {
      if (source.startsWith(p, pos)) {
        punct = p;
        break;
      }
    }
    // `a?.5:b` is a conditional, not optional chaining.
    if (punct === "?." && source[pos + 2] >= "0" && source[pos + 2] <= "9") punct = "?";
    if (!punct) fail(`Unexpected character '${ch}'`);
    pos += punct.length;
    const tok = push("punct", start, pos);

    if (punct === "{") braceStack.push("brace");
    else if (punct === "}") braceStack.pop();
    else if (punct === "(") {
      const prev = tokens[tokens.length - 2];
      parenStack.push(Boolean(prev && prev.type === "name" && PAREN_KEYWORDS.has(prev.value)));
    } else if (punct === ")") {
      tok.parenKeyword = parenStack.pop() || false;
    }
  }

  tokens.push({ type: "eof", value: "", start: len, end: len, nl });
  return tokens;
}

module.exports = { tokenize };
