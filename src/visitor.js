"use strict";

const { renderHelpers } = require("./helpers");
const { isPunct, isName, isValidBindingName, lineIndent } = require("./util");

/**
 * Generates ES5 output from the parser's token stream.
 *
 * `emitRange` copies source verbatim (the gaps between tokens included, so
 * comments and formatting survive) and intercepts only:
 *   - `class` → `visitClass` (an IIFE building a constructor function)
 *   - `super` → `visitSuper`, rewritten against the current scope
 *   - `this` / bare `return` inside derived constructors → `visitAliased`
 *
 * A scope describes the method being emitted:
 *   { superBase, isConstructor, superCtor?, initFields?, thisAlias?, rewriteReturn? }
 * It is null outside class members.
 */
class Visitor {
  constructor(parser) {
    this.parser = parser;
    this.source = parser.source;
    this.tokens = parser.tokens;
    this.match = parser.match;
    this.names = new Set(this.tokens.filter((t) => t.type === "name").map((t) => t.value));
    this.usedHelpers = new Set();
    this.helperNames = {};
    this.classCount = 0;
  }

  /** Returns a name that collides with no identifier in the file, and reserves it. */
  uniqueName(base) {
    let name = base;
    for (let n = 2; this.names.has(name); n++) name = `${base}${n}`;
    this.names.add(name);
    return name;
  }

  /** Marks a runtime helper as used and returns its name in this file. */
  helper(key) {
    this.usedHelpers.add(key);
    if (key === "createClass") this.helper("defineProperties");
    if (!this.helperNames[key]) this.helperNames[key] = this.uniqueName(`_${key}`);
    return this.helperNames[key];
  }

  /** Emits the whole program, split so helpers can go after the prologue. */
  visitProgram() {
    const { tokens, source } = this;
    const eof = tokens.length - 1;
    // Keep shebang, leading comments and the directive prologue ahead of helpers.
    const p = this.parser.prologueEnd();

    const body = this.emitRange(p, eof, null);
    const head = source.slice(0, tokens[p].start);
    const tail = eof > p ? source.slice(tokens[eof - 1].end) : source.slice(tokens[p].start);
    const helpers = this.usedHelpers.size ? renderHelpers(this.usedHelpers, this.helperNames) : "";
    return { head, helpers, body, tail };
  }

  /** Emits tokens [from, to) with the original gaps between them. */
  emitRange(from, to, scope) {
    const { tokens, source, parser } = this;
    if (from >= to) return "";
    let out = "";
    let cursor = tokens[from].start;
    let k = from;
    while (k < to) {
      const tok = tokens[k];
      out += source.slice(cursor, tok.start);

      let r = null;
      if (parser.isExportDefaultClassDecl(k)) r = this.visitClass(k + 2, scope, { exportDefault: true });
      else if (parser.isClassStart(k)) r = this.visitClass(k, scope, {});
      else if (isName(tok, "super") && !parser.isPropertyName(k)) r = this.visitSuper(k, scope);
      // Derived constructors refer to the instance through an alias (see visitClass).
      else if (scope && scope.thisAlias) r = this.visitAliased(k, scope);

      if (r) {
        out += r.code;
        cursor = tokens[r.end - 1].end;
        k = r.end;
      } else {
        out += tok.value;
        cursor = tok.end;
        k++;
      }
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

  // ------------------------------------------------------------------ classes

  visitClass(k, outerScope, { exportDefault }) {
    const { tokens: t, parser } = this;
    const cls = parser.parseClass(k);
    const startTok = exportDefault ? k - 2 : k;
    const isDeclaration = Boolean(cls.name) && (exportDefault || parser.isStatementPosition(k));
    const ind = lineIndent(this.source, t[startTok].start);
    const I = ind + "  ";

    const name = cls.name || parser.inferName(k) || this.uniqueName("_class");
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
      if (parser.rangeHas(f.key.open, f.key.close, "this")) usesOuterThis = true;
      f.key.ref = this.uniqueName("_key");
      lines.push(`${I}var ${f.key.ref} = ${this.emitBetween(f.key.open, f.key.close, outerScope).trim()};`);
    }

    // Instance fields run once per construction, with `this` as the instance.
    if (initName) {
      const assigns = fields.map((f) => {
        const value = f.initStart !== null ? this.emitRange(f.initStart, f.initEnd, instanceScope) : "void 0";
        return `${I}  ${memberTarget("this", f.key)} = ${value};`;
      });
      lines.push(`${I}function ${initName}() {\n${assigns.join("\n")}\n${I}}`);
    }

    lines.push(this.visitConstructor(ctor, { name, superName, initName, thisAlias, ctorScope, I }));

    // Methods and accessors become non-enumerable properties via createClass.
    const protoDescs = [];
    const staticDescs = [];
    for (const m of cls.members) {
      if (m.kind !== "method" && m.kind !== "get" && m.kind !== "set") continue;
      if (m.isConstructor) continue;
      if (m.key.type === "computed" && parser.rangeHas(m.key.open, m.key.close, "this")) usesOuterThis = true;
      const scope = m.isStatic ? staticScope : instanceScope;
      const key = this.descriptorKey(m.key, outerScope);
      const fn = this.visitMethod(m, scope);
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
        const target = memberTarget(name, m.key);
        if (m.initStart === null) {
          lines.push(`${I}${target} = void 0;`);
          continue;
        }
        const value = this.emitRange(m.initStart, m.initEnd, staticScope);
        const needsThis =
          parser.rangeHas(m.initStart, m.initEnd - 1, "this") || parser.rangeHas(m.initStart, m.initEnd - 1, "super");
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

  visitConstructor(ctor, { name, superName, initName, thisAlias, ctorScope, I }) {
    const prelude = [`${this.helper("classCallCheck")}(this, ${name});`];
    if (ctor) {
      if (!superName && initName) prelude.push(`${initName}.call(this);`);
      if (thisAlias) prelude.push(`var ${thisAlias};`);
      const params = this.emitBetween(ctor.paramsOpen, ctor.paramsClose, ctorScope);
      let body = this.emitBetween(ctor.bodyOpen, ctor.bodyClose, ctorScope);
      if (thisAlias) body = `${body.replace(/\s*$/, "")}\n${I}  return ${thisAlias};\n${I}`;
      else if (!body.trim()) body = `\n${I}`;
      return `${I}function ${name}(${params}) {\n${prelude.map((p) => `${I}  ${p}`).join("\n")}${body}}`;
    }
    if (thisAlias) prelude.push(`var ${thisAlias} = ${this.helper("callSuper")}(this, ${superName}, arguments);`);
    if (initName) prelude.push(`${initName}.call(${thisAlias || "this"});`);
    if (thisAlias) prelude.push(`return ${thisAlias};`);
    return `${I}function ${name}() {\n${prelude.map((s) => `${I}  ${s}`).join("\n")}\n${I}}`;
  }

  visitMethod(m, scope) {
    let fnName = "";
    if (
      m.kind === "method" &&
      m.key.type === "ident" &&
      isValidBindingName(m.key.value) &&
      !this.parser.rangeHas(m.paramsOpen, m.bodyClose, m.key.value)
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

  // -------------------------------------------------------------------- super

  visitSuper(k, scope) {
    const t = this.tokens;
    // Outside a class (e.g. object literal methods) `super` is native ES2015; leave it.
    if (!scope) return { code: "super", end: k + 1 };
    const next = t[k + 1];

    // super(...) — only in a derived constructor.
    if (isPunct(next, "(")) {
      if (!scope.isConstructor || !scope.superCtor) {
        throw this.parser.error("'super()' is only valid in the constructor of a derived class", k);
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
      throw this.parser.error("'super' must be followed by a call or property access", k);
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
    const self = scope.thisAlias || "this";
    if (this.parser.isLoneSpread(open, close)) return `${fn}.apply(${self}, ${this.tokens[open + 2].value})`;
    const args = this.emitBetween(open, close, scope);
    return args.trim() ? `${fn}.call(${self}, ${args.trim()})` : `${fn}.call(${self})`;
  }

  // Call arguments `(a, b)` as an array expression; a lone `...x` spread is passed as `x`.
  argsArray(open, close, scope) {
    if (this.parser.isLoneSpread(open, close)) return this.tokens[open + 2].value;
    return `[${this.emitBetween(open, close, scope).trim()}]`;
  }

  /**
   * Inside a derived constructor: rewrites `this` to the alias and bare
   * `return` to `return <alias>`, while leaving nested regular functions and
   * object-literal methods (which have their own `this`) untouched.
   */
  visitAliased(k, scope) {
    const { tokens: t, parser } = this;
    const tok = t[k];
    if (parser.isPropertyName(k)) return null;

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

    if (isPunct(tok, "(") && parser.isMethodShorthand(k)) {
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
}

// Assignment target for a field: `obj.name` or `obj[key]`.
function memberTarget(object, key) {
  if (key.type === "ident") return `${object}.${key.value}`;
  if (key.type === "computed") return `${object}[${key.ref}]`;
  return `${object}[${key.value}]`;
}

module.exports = { Visitor };
