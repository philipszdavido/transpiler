"use strict";

/**
 * AST nodes for class syntax. The tree is deliberately shallow: nodes record
 * token indices (into the scanner's token list) for the parts the visitor
 * re-emits — heritage, keys, params, bodies, initializers — rather than
 * parsing those expressions. Ranges are `[start, end)` unless named
 * `open`/`close`, which index a matching bracket pair.
 */

class ClassNode {
  constructor({ start, name, heritage, bodyOpen, bodyClose, members }) {
    this.start = start; // index of the `class` token
    this.name = name; // string | null
    this.heritage = heritage; // { start, end } | null
    this.bodyOpen = bodyOpen;
    this.bodyClose = bodyClose;
    this.members = members; // Array<MethodNode | FieldNode | StaticBlockNode>
  }
}

/**
 * A property key.
 *   type "ident" | "string" | "num": `value` is the raw source text
 *   type "computed": `open`/`close` index the `[` `]` brackets; `ref` is set by
 *   the visitor when it hoists the key into a variable
 */
class KeyNode {
  constructor(type, props) {
    this.type = type;
    Object.assign(this, props);
  }

  is(name) {
    if (this.type === "ident") return this.value === name;
    if (this.type === "string") return this.value.slice(1, -1) === name;
    return false;
  }
}

class MethodNode {
  constructor({ kind, isStatic, isAsync, isGenerator, key, paramsOpen, paramsClose, bodyOpen, bodyClose }) {
    this.kind = kind; // "method" | "get" | "set"
    this.isStatic = isStatic;
    this.isAsync = isAsync;
    this.isGenerator = isGenerator;
    this.key = key;
    this.paramsOpen = paramsOpen;
    this.paramsClose = paramsClose;
    this.bodyOpen = bodyOpen;
    this.bodyClose = bodyClose;
    this.isConstructor = !isStatic && kind === "method" && key.is("constructor");
  }
}

class FieldNode {
  constructor({ isStatic, key, initStart, initEnd }) {
    this.kind = "field";
    this.isStatic = isStatic;
    this.key = key;
    this.initStart = initStart; // null when the field has no initializer
    this.initEnd = initEnd;
  }
}

class StaticBlockNode {
  constructor({ open, close }) {
    this.kind = "staticBlock";
    this.isStatic = true;
    this.open = open;
    this.close = close;
  }
}

module.exports = { ClassNode, KeyNode, MethodNode, FieldNode, StaticBlockNode };
