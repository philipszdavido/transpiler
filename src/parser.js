"use strict";

const { tokenize } = require("./scanner");
const { TranspileError } = require("./errors");
const { ClassNode, KeyNode, MethodNode, FieldNode, StaticBlockNode } = require("./ast");
const {
  NON_TERMINAL_KEYWORDS,
  EXPRESSION_KEYWORDS,
  OPENERS,
  isPunct,
  isName,
  isOpener,
  isValidBindingName,
} = require("./util");

/**
 * Wraps the token stream with bracket matching and the syntactic queries the
 * visitor needs. It is not a full JS parser: only class bodies are parsed into
 * AST nodes (on demand, via `parseClass`); everything else stays as tokens.
 */
class Parser {
  constructor(source, filename) {
    this.source = source;
    this.filename = filename;
    this.tokens = tokenize(source, filename);
    this.match = this.matchBrackets();
  }

  error(message, tokenIndex) {
    const tok = this.tokens[tokenIndex];
    return new TranspileError(message, this.source, tok ? tok.start : this.source.length, this.filename);
  }

  // Precomputes the index of the closing bracket for every opening bracket (and vice versa).
  matchBrackets() {
    const match = new Int32Array(this.tokens.length).fill(-1);
    const stack = [];
    this.tokens.forEach((tok, i) => {
      if (tok.type !== "punct") return;
      if (OPENERS[tok.value]) {
        stack.push(i);
      } else if (tok.value === ")" || tok.value === "]" || tok.value === "}") {
        const open = stack.pop();
        if (open === undefined || OPENERS[this.tokens[open].value] !== tok.value) {
          throw this.error(`Unexpected '${tok.value}'`, i);
        }
        match[open] = i;
        match[i] = open;
      }
    });
    if (stack.length) {
      const open = stack.pop();
      throw this.error(`Unclosed '${this.tokens[open].value}'`, open);
    }
    return match;
  }

  // Index just past the directive prologue ("use strict"; …) at the top of the file.
  prologueEnd() {
    const t = this.tokens;
    let p = 0;
    while (t[p].type === "string") {
      const next = t[p + 1];
      if (isPunct(next, ";")) p += 2;
      else if (next.type === "eof" || next.nl || isPunct(next, "}")) p += 1;
      else break;
    }
    return p;
  }

  // ------------------------------------------------------------- token queries

  isPropertyName(k) {
    const prev = this.tokens[k - 1];
    return isPunct(prev, ".") || isPunct(prev, "?.");
  }

  isClassStart(k) {
    const tok = this.tokens[k];
    if (!isName(tok, "class") || this.isPropertyName(k)) return false;
    const next = this.tokens[k + 1];
    return isPunct(next, "{") || isName(next);
  }

  isExportDefaultClassDecl(k) {
    const t = this.tokens;
    return (
      isName(t[k], "export") &&
      !this.isPropertyName(k) &&
      isName(t[k + 1], "default") &&
      this.isClassStart(k + 2) &&
      isName(t[k + 3]) &&
      t[k + 3].value !== "extends"
    );
  }

  // A named class is a declaration when it begins a statement. `class` can't
  // continue a completed expression, so after `)`, `]`, a literal or an
  // identifier it must start a new statement (via ASI).
  isStatementPosition(k) {
    const prev = this.tokens[k - 1];
    if (!prev) return true;
    switch (prev.type) {
      case "punct":
        return [";", "{", "}", ")", "]", "++", "--"].includes(prev.value);
      case "name":
        return prev.value === "export" || this.isPropertyName(k - 1) || !EXPRESSION_KEYWORDS.has(prev.value);
      case "template":
        return prev.tail;
      default:
        return true;
    }
  }

  // `const Foo = class {}` names the class "Foo".
  inferName(k) {
    const t = this.tokens;
    if (isPunct(t[k - 1], "=") && isName(t[k - 2]) && !this.isPropertyName(k - 2)) {
      if (isValidBindingName(t[k - 2].value)) return t[k - 2].value;
    }
    return null;
  }

  // `name(...) {` outside a class body can only be an object-literal method.
  isMethodShorthand(k) {
    const t = this.tokens;
    const prev = t[k - 1];
    if (!prev || !isPunct(t[this.match[k] + 1], "{")) return false;
    if (prev.type === "string" || prev.type === "num" || isPunct(prev, "]")) return true;
    return prev.type === "name" && !["if", "for", "while", "switch", "catch", "with", "function"].includes(prev.value);
  }

  // Whether tokens [from, to] contain the identifier `name` (not as a property name).
  rangeHas(from, to, name) {
    for (let i = from; i <= to && i < this.tokens.length; i++) {
      if (isName(this.tokens[i], name) && !this.isPropertyName(i)) return true;
    }
    return false;
  }

  // Whether `[open, close]` is `( ...ident )`.
  isLoneSpread(open, close) {
    const t = this.tokens;
    return close === open + 3 && isPunct(t[open + 1], "...") && isName(t[open + 2]);
  }

  // ---------------------------------------------------------- class parsing

  /** Parses the class whose `class` keyword is at token `k`. */
  parseClass(k) {
    const t = this.tokens;
    let i = k + 1;
    let name = null;
    if (isName(t[i]) && t[i].value !== "extends") {
      name = t[i].value;
      if (!isValidBindingName(name)) throw this.error(`Invalid class name '${name}'`, i);
      i++;
    }

    let heritage = null;
    if (isName(t[i], "extends")) {
      i++;
      const start = i;
      while (i < t.length - 1 && !isPunct(t[i], "{")) {
        i = isOpener(t[i]) ? this.match[i] + 1 : i + 1;
      }
      if (start === i) throw this.error("Expected an expression after 'extends'", i);
      heritage = { start, end: i };
    }

    if (!isPunct(t[i], "{")) throw this.error("Expected '{' to start the class body", i);
    const bodyOpen = i;
    const bodyClose = this.match[i];
    const members = this.parseMembers(bodyOpen + 1, bodyClose);
    return new ClassNode({ start: k, name, heritage, bodyOpen, bodyClose, members });
  }

  // True when the token after a would-be modifier means the modifier is itself the member name.
  isModifierName(i) {
    const tok = this.tokens[i];
    return ["(", "=", ";", "}"].includes(tok.type === "punct" ? tok.value : "") || tok.type === "eof";
  }

  parseMembers(start, end) {
    const t = this.tokens;
    const members = [];
    let m = start;

    while (m < end) {
      if (isPunct(t[m], ";")) {
        m++;
        continue;
      }
      if (isPunct(t[m], "@")) throw this.error("Decorators are not supported", m);

      const startToken = m;
      let isStatic = false;
      let isAsync = false;
      let isGenerator = false;
      let kind = "method";

      if (isName(t[m], "static") && !this.isModifierName(m + 1)) {
        isStatic = true;
        m++;
        if (isPunct(t[m], "{")) {
          members.push(new StaticBlockNode({ open: m, close: this.match[m] }));
          m = this.match[m] + 1;
          continue;
        }
      }
      if (isName(t[m], "async") && !this.isModifierName(m + 1) && !t[m + 1].nl) {
        isAsync = true;
        m++;
      }
      if (isPunct(t[m], "*")) {
        isGenerator = true;
        m++;
      }
      if ((isName(t[m], "get") || isName(t[m], "set")) && !isAsync && !isGenerator && !this.isModifierName(m + 1)) {
        kind = t[m].value;
        m++;
      }

      const { key, next } = this.parseKey(m);
      m = next;

      if (isPunct(t[m], "(")) {
        const paramsOpen = m;
        const paramsClose = this.match[m];
        m = paramsClose + 1;
        if (!isPunct(t[m], "{")) throw this.error("Expected '{' to start the method body", m);
        const bodyOpen = m;
        const bodyClose = this.match[m];
        m = bodyClose + 1;
        const method = new MethodNode({
          kind, isStatic, isAsync, isGenerator, key, paramsOpen, paramsClose, bodyOpen, bodyClose,
        });
        if (method.isConstructor && (isAsync || isGenerator)) {
          throw this.error("Class constructor may not be async or a generator", startToken);
        }
        members.push(method);
        continue;
      }

      // Class field.
      if (kind !== "method" || isAsync || isGenerator) throw this.error("Expected '(' after method name", m);
      let initStart = null;
      let initEnd = null;
      if (isPunct(t[m], "=")) {
        initStart = m + 1;
        m = this.scanFieldInitializer(m + 1, end);
        initEnd = m;
        if (initStart === initEnd) throw this.error("Expected a field initializer", m);
      }
      if (isPunct(t[m], ";")) m++;
      else if (m !== end && !t[m].nl) throw this.error(`Unexpected token '${t[m].value}' in class body`, m);
      members.push(new FieldNode({ isStatic, key, initStart, initEnd }));
    }
    return members;
  }

  parseKey(m) {
    const tok = this.tokens[m];
    if (tok.type === "private") {
      throw this.error(`Private class members ('${tok.value}') are not supported`, m);
    }
    if (isPunct(tok, "[")) {
      return { key: new KeyNode("computed", { open: m, close: this.match[m] }), next: this.match[m] + 1 };
    }
    if (tok.type === "name") return { key: new KeyNode("ident", { value: tok.value }), next: m + 1 };
    if (tok.type === "string" || tok.type === "num") {
      return { key: new KeyNode(tok.type, { value: tok.value }), next: m + 1 };
    }
    throw this.error(`Unexpected token '${tok.value}' in class body`, m);
  }

  // Returns the token index that ends a field initializer (exclusive).
  scanFieldInitializer(i, end) {
    const t = this.tokens;
    const start = i;
    while (i < end) {
      const tok = t[i];
      if (isPunct(tok, ";")) return i;
      if (i > start && tok.nl && endsExpression(t[i - 1]) && startsMember(tok)) return i;
      i = isOpener(tok) ? this.match[i] + 1 : i + 1;
    }
    return i;
  }
}

function endsExpression(tok) {
  switch (tok.type) {
    case "name":
      return !NON_TERMINAL_KEYWORDS.has(tok.value);
    case "num":
    case "string":
    case "regex":
    case "private":
      return true;
    case "template":
      return tok.tail;
    case "punct":
      return [")", "]", "}", "++", "--"].includes(tok.value);
    default:
      return false;
  }
}

function startsMember(tok) {
  if (tok.type === "name" || tok.type === "string" || tok.type === "num" || tok.type === "private") return true;
  return isPunct(tok, "*") || isPunct(tok, "@");
}

module.exports = { Parser };
