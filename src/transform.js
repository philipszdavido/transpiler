"use strict";

const { tokenize } = require("./tokenizer");
const { TranspileError } = require("./errors");
const { renderHelpers } = require("./helpers");

/**
 * Lowers ES2015+ class syntax to ES5 constructor functions.
 *
 * This is a source-to-source rewrite over the token stream, not a full parse:
 * only `class` declarations/expressions and `super` references inside them are
 * rewritten. Every other byte (including comments and whitespace) is copied
 * through unchanged, so non-class syntax is left for the target engine.
 */

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
const EXPRESSION_KEYWORDS = new Set([
  ...NON_TERMINAL_KEYWORDS, "return", "throw", "case", "default",
]);

const OPENERS = { "(": ")", "[": "]", "{": "}" };

function isPunct(tok, value) {
  return tok !== undefined && tok.type === "punct" && tok.value === value;
}

function isName(tok, value) {
  return tok !== undefined && tok.type === "name" && (value === undefined || tok.value === value);
}

function isValidBindingName(name) {
  return /^[$_\p{ID_Start}][$‌‍\p{ID_Continue}]*$/u.test(name) && !RESERVED.has(name);
}

class Transformer {
  constructor(source, options) {
    this.source = source;
    this.filename = options.filename;
    this.tokens = tokenize(source, this.filename);
    this.match = this.matchBrackets();
    this.names = new Set(this.tokens.filter((t) => t.type === "name").map((t) => t.value));
    this.usedHelpers = new Set();
    this.helperNames = {};
    this.classCount = 0;
  }

  error(message, tokenIndex) {
    const tok = this.tokens[tokenIndex];
    return new TranspileError(message, this.source, tok ? tok.start : this.source.length, this.filename);
  }

  // Precomputes the index of the closing bracket for every opening bracket.
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

  uniqueName(base) {
    let name = base;
    for (let n = 2; this.names.has(name); n++) name = `${base}${n}`;
    this.names.add(name);
    return name;
  }

  helper(key) {
    this.usedHelpers.add(key);
    if (key === "createClass") this.helper("defineProperties");
    if (!this.helperNames[key]) this.helperNames[key] = this.uniqueName(`_${key}`);
    return this.helperNames[key];
  }

  run() {
    const { tokens, source } = this;
    const eof = tokens.length - 1;

    // Keep shebang, leading comments and the directive prologue ahead of helpers.
    let p = 0;
    while (tokens[p].type === "string") {
      const next = tokens[p + 1];
      if (isPunct(next, ";")) p += 2;
      else if (next.type === "eof" || next.nl || isPunct(next, "}")) p += 1;
      else break;
    }

    const body = this.emitRange(p, eof, null);
    const head = source.slice(0, tokens[p].start);
    const tail = eof > p ? source.slice(tokens[eof - 1].end) : source.slice(tokens[p].start);

    const helpers = this.usedHelpers.size ? renderHelpers(this.usedHelpers, this.helperNames) : "";
    return { head, helpers, body, tail };
  }

  /** Emits tokens [from, to) with the original gaps between them. */
  emitRange(from, to, scope) {
    const { tokens, source } = this;
    if (from >= to) return "";
    let out = "";
    let cursor = tokens[from].start;
    let k = from;
    while (k < to) {
      const tok = tokens[k];
      out += source.slice(cursor, tok.start);

      if (this.isExportDefaultClassDecl(k)) {
        const r = this.emitClass(k + 2, scope, { exportDefault: true });
        out += r.code;
        cursor = tokens[r.end - 1].end;
        k = r.end;
        continue;
      }
      if (this.isClassStart(k)) {
        const r = this.emitClass(k, scope, {});
        out += r.code;
        cursor = tokens[r.end - 1].end;
        k = r.end;
        continue;
      }
      if (isName(tok, "super") && !this.isPropertyName(k)) {
        const r = this.emitSuper(k, scope);
        out += r.code;
        cursor = tokens[r.end - 1].end;
        k = r.end;
        continue;
      }

      // Derived constructors refer to the instance through an alias (see emitClass).
      if (scope && scope.thisAlias) {
        const r = this.emitAliased(k, scope);
        if (r) {
          out += r.code;
          cursor = tokens[r.end - 1].end;
          k = r.end;
          continue;
        }
      }

      out += tok.value;
      cursor = tok.end;
      k++;
    }
    return out;
  }

  /** Emits everything strictly between two bracket tokens, gaps included. */
  emitBetween(open, close, scope) {
    const { tokens, source } = this;
    if (open + 1 === close) return source.slice(tokens[open].end, tokens[close].start);
    return (
      source.slice(tokens[open].end, tokens[open + 1].start) +
      this.emitRange(open + 1, close, scope) +
      source.slice(tokens[close - 1].end, tokens[close].start)
    );
  }

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

  lineIndent(pos) {
    const lineStart = this.source.lastIndexOf("\n", pos - 1) + 1;
    return /^[ \t]*/.exec(this.source.slice(lineStart, pos))[0];
  }

  // `const Foo = class {}` names the class "Foo".
  inferName(k) {
    const t = this.tokens;
    if (isPunct(t[k - 1], "=") && isName(t[k - 2]) && !this.isPropertyName(k - 2)) {
      if (isValidBindingName(t[k - 2].value)) return t[k - 2].value;
    }
    return null;
  }

  // ---------------------------------------------------------------- parsing

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
        i = t[i].type === "punct" && OPENERS[t[i].value] ? this.match[i] + 1 : i + 1;
      }
      if (start === i) throw this.error("Expected an expression after 'extends'", i);
      heritage = { start, end: i };
    }

    if (!isPunct(t[i], "{")) throw this.error("Expected '{' to start the class body", i);
    const bodyOpen = i;
    const bodyClose = this.match[i];
    const members = this.parseMembers(bodyOpen + 1, bodyClose);
    return { name, heritage, bodyOpen, bodyClose, members };
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

      const member = {
        isStatic: false,
        isAsync: false,
        isGenerator: false,
        kind: "method",
        key: null,
        startToken: m,
      };

      if (isName(t[m], "static") && !this.isModifierName(m + 1)) {
        member.isStatic = true;
        m++;
        if (isPunct(t[m], "{")) {
          members.push({ kind: "staticBlock", open: m, close: this.match[m] });
          m = this.match[m] + 1;
          continue;
        }
      }
      if (isName(t[m], "async") && !this.isModifierName(m + 1) && !t[m + 1].nl) {
        member.isAsync = true;
        m++;
      }
      if (isPunct(t[m], "*")) {
        member.isGenerator = true;
        m++;
      }
      if (
        (isName(t[m], "get") || isName(t[m], "set")) &&
        !member.isAsync &&
        !member.isGenerator &&
        !this.isModifierName(m + 1)
      ) {
        member.kind = t[m].value;
        m++;
      }

      const keyTok = t[m];
      if (keyTok.type === "private") {
        throw this.error(`Private class members ('${keyTok.value}') are not supported`, m);
      } else if (isPunct(keyTok, "[")) {
        member.key = { type: "computed", open: m, close: this.match[m] };
        m = this.match[m] + 1;
      } else if (keyTok.type === "name") {
        member.key = { type: "ident", value: keyTok.value };
        m++;
      } else if (keyTok.type === "string" || keyTok.type === "num") {
        member.key = { type: keyTok.type, value: keyTok.value };
        m++;
      } else {
        throw this.error(`Unexpected token '${keyTok.value}' in class body`, m);
      }

      if (isPunct(t[m], "(")) {
        member.paramsOpen = m;
        member.paramsClose = this.match[m];
        m = member.paramsClose + 1;
        if (!isPunct(t[m], "{")) throw this.error("Expected '{' to start the method body", m);
        member.bodyOpen = m;
        member.bodyClose = this.match[m];
        m = member.bodyClose + 1;
        member.isConstructor =
          !member.isStatic &&
          member.kind === "method" &&
          (member.key.type === "ident"
            ? member.key.value === "constructor"
            : member.key.type === "string" && member.key.value.slice(1, -1) === "constructor");
        if (member.isConstructor && (member.isAsync || member.isGenerator)) {
          throw this.error("Class constructor may not be async or a generator", member.startToken);
        }
        members.push(member);
        continue;
      }

      // Class field.
      if (member.kind !== "method" || member.isAsync || member.isGenerator) {
        throw this.error("Expected '(' after method name", m);
      }
      member.kind = "field";
      if (isPunct(t[m], "=")) {
        member.initStart = m + 1;
        m = this.scanFieldInitializer(m + 1, end);
        member.initEnd = m;
        if (member.initStart === member.initEnd) throw this.error("Expected a field initializer", m);
      }
      if (isPunct(t[m], ";")) m++;
      else if (m !== end && !t[m].nl) throw this.error(`Unexpected token '${t[m].value}' in class body`, m);
      members.push(member);
    }
    return members;
  }

  // Returns the token index that ends a field initializer (exclusive).
  scanFieldInitializer(i, end) {
    const t = this.tokens;
    const start = i;
    while (i < end) {
      const tok = t[i];
      if (isPunct(tok, ";")) return i;
      if (i > start && tok.nl && this.endsExpression(t[i - 1]) && this.startsMember(tok)) return i;
      i = tok.type === "punct" && OPENERS[tok.value] ? this.match[i] + 1 : i + 1;
    }
    return i;
  }

  endsExpression(tok) {
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

  startsMember(tok) {
    if (tok.type === "name" || tok.type === "string" || tok.type === "num" || tok.type === "private") return true;
    return isPunct(tok, "*") || isPunct(tok, "@");
  }

  // --------------------------------------------------------------- emitting

  emitClass(k, outerScope, { exportDefault }) {
    const t = this.tokens;
    const cls = this.parseClass(k);
    const startTok = exportDefault ? k - 2 : k;
    const isDeclaration = Boolean(cls.name) && (exportDefault || this.isStatementPosition(k));
    const ind = this.lineIndent(t[startTok].start);
    const I = ind + "  ";

    const name = cls.name || this.inferName(k) || this.uniqueName("_class");
    const superName = cls.heritage ? this.uniqueName("_super") : null;
    const ctor = cls.members.find((m) => m.isConstructor);
    const fields = cls.members.filter((m) => m.kind === "field" && !m.isStatic);
    const initName = fields.length ? this.uniqueName("_initFields") : null;
    const classCallCheck = this.helper("classCallCheck");
    const createClass = this.helper("createClass");

    const instanceScope = {
      superBase: superName ? `${superName}.prototype` : "Object.prototype",
      isConstructor: false,
    };
    const staticScope = { superBase: superName || "Function.prototype", isConstructor: false };
    // Derived constructors bind the instance returned by the parent constructor
    // to an alias, so natively-constructed parents (Error, Map, ES classes) work.
    const thisAlias = superName ? this.uniqueName("_this") : null;
    const ctorScope = {
      ...instanceScope,
      isConstructor: true,
      superCtor: superName,
      initFields: initName,
      thisAlias,
      rewriteReturn: Boolean(thisAlias),
    };

    const lines = [];
    lines.push(`${I}"use strict";`);
    if (superName) lines.push(`${I}${this.helper("inherits")}(${name}, ${superName});`);

    // Computed field keys are evaluated once, at class definition time.
    let usesOuterThis = false;
    for (const f of cls.members) {
      if (f.kind !== "field" || f.key.type !== "computed") continue;
      if (this.rangeHas(f.key.open, f.key.close, "this")) usesOuterThis = true;
      f.key.ref = this.uniqueName("_key");
      lines.push(`${I}var ${f.key.ref} = ${this.emitBetween(f.key.open, f.key.close, outerScope).trim()};`);
    }

    // Instance fields run once per construction, with `this` as the instance.
    if (initName) {
      const assigns = fields.map((f) => {
        const value = f.initStart !== undefined ? this.emitRange(f.initStart, f.initEnd, instanceScope) : "void 0";
        return `${I}  ${this.memberTarget("this", f.key)} = ${value};`;
      });
      lines.push(`${I}function ${initName}() {\n${assigns.join("\n")}\n${I}}`);
    }

    // Constructor.
    const prelude = [`${classCallCheck}(this, ${name});`];
    if (ctor) {
      if (!superName && initName) prelude.push(`${initName}.call(this);`);
      if (thisAlias) prelude.push(`var ${thisAlias};`);
      const params = this.emitBetween(ctor.paramsOpen, ctor.paramsClose, ctorScope);
      let body = this.emitBetween(ctor.bodyOpen, ctor.bodyClose, ctorScope);
      if (thisAlias) body = `${body.replace(/\s*$/, "")}\n${I}  return ${thisAlias};\n${I}`;
      else if (!body.trim()) body = `\n${I}`;
      lines.push(`${I}function ${name}(${params}) {\n${prelude.map((p) => `${I}  ${p}`).join("\n")}${body}}`);
    } else {
      if (thisAlias) prelude.push(`var ${thisAlias} = ${this.helper("callSuper")}(this, ${superName}, arguments);`);
      if (initName) prelude.push(`${initName}.call(${thisAlias || "this"});`);
      if (thisAlias) prelude.push(`return ${thisAlias};`);
      lines.push(`${I}function ${name}() {\n${prelude.map((s) => `${I}  ${s}`).join("\n")}\n${I}}`);
    }

    // Methods and accessors become non-enumerable properties via createClass.
    const protoDescs = [];
    const staticDescs = [];
    for (const m of cls.members) {
      if (m.kind !== "method" && m.kind !== "get" && m.kind !== "set") continue;
      if (m.isConstructor) continue;
      if (m.key.type === "computed" && this.rangeHas(m.key.open, m.key.close, "this")) usesOuterThis = true;
      const scope = m.isStatic ? staticScope : instanceScope;
      const key = this.descriptorKey(m.key, outerScope);
      const fn = this.emitFunction(m, scope);
      const prop = m.kind === "method" ? "value" : m.kind;
      (m.isStatic ? staticDescs : protoDescs).push(`{ key: ${key}, ${prop}: ${fn} }`);
    }
    const descList = (list) => (list.length ? `[\n${list.map((d) => `${I}  ${d}`).join(",\n")}\n${I}]` : "null");
    if (staticDescs.length) {
      lines.push(`${I}${createClass}(${name}, ${descList(protoDescs)}, ${descList(staticDescs)});`);
    } else {
      lines.push(`${I}${createClass}(${name}, ${descList(protoDescs)});`);
    }

    // Static fields and static blocks run in source order with `this` as the class.
    let hasStaticSideEffects = false;
    for (const m of cls.members) {
      if (m.kind === "staticBlock") {
        hasStaticSideEffects = true;
        const body = this.emitBetween(m.open, m.close, staticScope);
        lines.push(`${I}(function () {${body}}).call(${name});`);
      } else if (m.kind === "field" && m.isStatic) {
        hasStaticSideEffects = true;
        const target = this.memberTarget(name, m.key);
        if (m.initStart === undefined) {
          lines.push(`${I}${target} = void 0;`);
          continue;
        }
        const value = this.emitRange(m.initStart, m.initEnd, staticScope);
        const needsThis =
          this.rangeHas(m.initStart, m.initEnd - 1, "this") || this.rangeHas(m.initStart, m.initEnd - 1, "super");
        lines.push(
          needsThis
            ? `${I}${target} = function () { return ${value}; }.call(${name});`
            : `${I}${target} = ${value};`
        );
      }
    }
    lines.push(`${I}return ${name};`);

    const heritage = cls.heritage ? this.emitRange(cls.heritage.start, cls.heritage.end, outerScope) : "";
    const pure = hasStaticSideEffects ? "" : "/*#__PURE__*/";
    const invoke = usesOuterThis ? `.call(this${heritage ? `, ${heritage}` : ""})` : `(${heritage})`;
    const iife = `${pure}(function (${superName || ""}) {\n${lines.join("\n")}\n${ind}})${invoke}`;

    this.classCount++;
    let code;
    if (exportDefault) code = `var ${name} = ${iife};\n${ind}export default ${name};`;
    else if (isDeclaration) code = `var ${name} = ${iife};`;
    else code = iife;
    return { code, end: cls.bodyClose + 1 };
  }

  emitFunction(m, scope) {
    let fnName = "";
    if (
      m.kind === "method" &&
      m.key.type === "ident" &&
      isValidBindingName(m.key.value) &&
      !this.rangeHas(m.paramsOpen, m.bodyClose, m.key.value)
    ) {
      fnName = ` ${m.key.value}`;
    }
    const head = `${m.isAsync ? "async " : ""}function${m.isGenerator ? "*" : ""}${fnName || " "}`;
    const params = this.emitBetween(m.paramsOpen, m.paramsClose, scope);
    const body = this.emitBetween(m.bodyOpen, m.bodyClose, scope);
    return `${head}(${params}) {${body}}`;
  }

  descriptorKey(key, outerScope) {
    if (key.type === "ident") return `"${key.value}"`;
    if (key.type === "computed") return this.emitBetween(key.open, key.close, outerScope).trim();
    return key.value;
  }

  memberTarget(object, key) {
    if (key.type === "ident") return `${object}.${key.value}`;
    if (key.type === "computed") return `${object}[${key.ref}]`;
    return `${object}[${key.value}]`;
  }

  // Whether tokens (from, to] contain the identifier `name` (not as a property name).
  rangeHas(from, to, name) {
    for (let i = from; i <= to && i < this.tokens.length; i++) {
      if (isName(this.tokens[i], name) && !this.isPropertyName(i)) return true;
    }
    return false;
  }

  emitSuper(k, scope) {
    const t = this.tokens;
    // Outside a class (e.g. object literal methods) `super` is native ES2015; leave it.
    if (!scope) return { code: "super", end: k + 1 };
    const next = t[k + 1];

    // super(...) — only in a derived constructor.
    if (isPunct(next, "(")) {
      if (!scope.isConstructor || !scope.superCtor) {
        throw this.error("'super()' is only valid in the constructor of a derived class", k);
      }
      const close = this.match[k + 1];
      const alias = scope.thisAlias;
      const assign = `${alias} = ${this.helper("callSuper")}(this, ${scope.superCtor}, ${this.argsArray(k + 1, close, scope)})`;
      const code = scope.initFields ? `(${assign}, ${scope.initFields}.call(${alias}), ${alias})` : `(${assign})`;
      return { code, end: close + 1 };
    }

    // super.prop / super[expr], optionally called.
    let member;
    let after;
    if (isPunct(next, ".") && isName(t[k + 2])) {
      member = `.${t[k + 2].value}`;
      after = k + 3;
    } else if (isPunct(next, "[")) {
      const close = this.match[k + 1];
      member = `[${this.emitBetween(k + 1, close, scope)}]`;
      after = close + 1;
    } else {
      throw this.error("'super' must be followed by a call or property access", k);
    }

    const target = `${scope.superBase}${member}`;
    if (isPunct(t[after], "(")) {
      const close = this.match[after];
      return { code: this.superCall(target, after, close, scope), end: close + 1 };
    }
    if (isPunct(t[after], "?.") && isPunct(t[after + 1], "(")) {
      const close = this.match[after + 1];
      const call = this.superCall(target, after + 1, close, scope).replace(/^(.*?)\.call\(/s, "$1?.call(");
      return { code: call, end: close + 1 };
    }
    return { code: target, end: after };
  }

  // Emits `fn.call(this, args)`, or `fn.apply(this, x)` for a lone `...x` spread.
  superCall(fn, open, close, scope) {
    const t = this.tokens;
    const self = scope.thisAlias || "this";
    if (close === open + 3 && isPunct(t[open + 1], "...") && isName(t[open + 2])) {
      return `${fn}.apply(${self}, ${t[open + 2].value})`;
    }
    const args = this.emitBetween(open, close, scope);
    return args.trim() ? `${fn}.call(${self}, ${args.trim()})` : `${fn}.call(${self})`;
  }

  // Call arguments `(a, b)` as an array expression; a lone `...x` spread is passed as `x`.
  argsArray(open, close, scope) {
    const t = this.tokens;
    if (close === open + 3 && isPunct(t[open + 1], "...") && isName(t[open + 2])) return t[open + 2].value;
    const args = this.emitBetween(open, close, scope).trim();
    return `[${args}]`;
  }

  /**
   * Inside a derived constructor: rewrites `this` to the alias and bare
   * `return` to `return <alias>`, while leaving nested regular functions and
   * object-literal methods (which have their own `this`) untouched.
   */
  emitAliased(k, scope) {
    const t = this.tokens;
    const tok = t[k];
    if (this.isPropertyName(k)) return null;

    if (isName(tok, "this")) return { code: scope.thisAlias, end: k + 1 };

    if (isName(tok, "return") && scope.rewriteReturn) {
      const next = t[k + 1];
      if (isPunct(next, ";") || isPunct(next, "}") || next.nl || next.type === "eof") {
        return { code: `return ${scope.thisAlias}`, end: k + 1 };
      }
      return null;
    }

    if (isName(tok, "function")) {
      let p = k + 1;
      while (p < t.length - 1 && !isPunct(t[p], "(")) p++;
      const bodyOpen = this.match[p] + 1;
      if (!isPunct(t[bodyOpen], "{")) return null;
      const end = this.match[bodyOpen] + 1;
      return { code: this.emitRange(k, end, null), end };
    }

    if (isPunct(tok, "(") && this.isMethodShorthand(k)) {
      const end = this.match[this.match[k] + 1] + 1;
      return { code: this.emitRange(k, end, null), end };
    }

    // Arrow functions keep the alias for `this`, but `return` returns from the arrow.
    if (isPunct(tok, "=>") && isPunct(t[k + 1], "{") && scope.rewriteReturn) {
      const end = this.match[k + 1] + 1;
      const inner = this.emitRange(k + 1, end, { ...scope, rewriteReturn: false });
      return { code: `=>${this.source.slice(tok.end, t[k + 1].start)}${inner}`, end };
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
}

/**
 * Transpiles `source`, lowering class syntax to ES5.
 *
 * @param {string} source
 * @param {{ filename?: string, helpers?: boolean }} [options]
 *   helpers: inject runtime helpers into the output (default true). Set to
 *   false when the helper functions are provided globally.
 * @returns {{ code: string, helpers: string[], classes: number }}
 */
function transpile(source, options = {}) {
  if (typeof source !== "string") throw new TypeError("transpile(source): source must be a string");
  const tr = new Transformer(source, options);
  const { head, helpers, body, tail } = tr.run();
  const inject = options.helpers !== false && helpers;
  const code = inject ? `${head}${helpers}\n\n${body}${tail}` : `${head}${body}${tail}`;
  return {
    code,
    helpers: [...tr.usedHelpers].map((key) => tr.helperNames[key] || `_${key}`),
    classes: tr.classCount,
  };
}

module.exports = { transpile };
