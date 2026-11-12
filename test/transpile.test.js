"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { transpile, TranspileError } = require("../src");
const { run } = require("./helpers");

test("leaves code without classes byte-identical", () => {
  const src = `// comment\nconst a = { class: 1 }; a.class; const re = /class {}/g;\nconst s = "class X {}"; \`class \${a.class}\`;\n`;
  assert.equal(transpile(src).code, src);
});

test("basic class with methods and static methods", () => {
  const r = run(`
    class Book {
      constructor(title) { this.title = title; }
      describe() { return "Book: " + this.title; }
      static create(t) { return new Book(t); }
    }
    const b = Book.create("Dune");
    [b.describe(), b instanceof Book, typeof Book];
  `);
  assert.deepEqual([...r], ["Book: Dune", true, "function"]);
});

test("methods are non-enumerable and prototype is not writable", () => {
  const r = run(`
    class A { m() {} static s() {} }
    [Object.keys(A.prototype).length, Object.keys(A).length,
     Object.getOwnPropertyDescriptor(A, "prototype").writable,
     Object.getOwnPropertyDescriptor(A.prototype, "m").writable];
  `);
  assert.deepEqual([...r], [0, 0, false, true]);
});

test("calling a class without new throws", () => {
  assert.throws(() => run(`class A {} A();`), /Cannot call a class as a function/);
});

test("inheritance with super() and super.method()", () => {
  const r = run(`
    class Animal {
      constructor(name) { this.name = name; }
      speak() { return this.name + " makes a sound"; }
      static kind() { return "animal"; }
    }
    class Dog extends Animal {
      constructor(name) { super(name); this.dog = true; }
      speak() { return super.speak() + " (woof)"; }
      static kind() { return "dog < " + super.kind(); }
    }
    const d = new Dog("Rex");
    [d.speak(), d instanceof Animal, d instanceof Dog, Dog.kind(), d.dog, d.constructor === Dog];
  `);
  assert.deepEqual([...r], ["Rex makes a sound (woof)", true, true, "dog < animal", true, true]);
});

test("extending native built-ins (Error, Map)", () => {
  const r = run(`
    class HttpError extends Error {
      constructor(status, msg) { super(msg); this.status = status; }
      describe() { return this.status + " " + this.message; }
    }
    class NotFound extends HttpError { constructor() { super(404, "nope"); } }
    class Registry extends Map { register(k) { return this.set(k, true); } }
    class Plain extends Error {}
    const e = new NotFound();
    const reg = new Registry().register("a");
    [e.describe(), e instanceof NotFound, e instanceof HttpError, e instanceof Error,
     typeof e.stack, reg.get("a"), reg instanceof Registry, new Plain("x").message];
  `);
  assert.deepEqual([...r], ["404 nope", true, true, true, "string", true, true, "x"]);
});

test("extending a native (untranspiled) ES class", () => {
  class Native {
    constructor(x) { this.x = x; }
    double() { return this.x * 2; }
  }
  const r = run(`class Sub extends Native { triple() { return this.x * 3; } } const s = new Sub(2); [s.double(), s.triple(), s instanceof Native];`, { Native });
  assert.deepEqual([...r], [4, 6, true]);
});

test("derived constructors keep nested function this, arrow this, and bare return", () => {
  const r = run(`
    class A {}
    class B extends A {
      constructor(early) {
        super();
        this.arrow = (() => this)();
        this.fn = (function () { return this; }).call("own");
        this.obj = { m() { return this; } }.m();
        this.cb = [1].map((x) => { if (x) return x + 1; });
        if (early) return;
        this.late = true;
      }
    }
    const b = new B(false), e = new B(true);
    [b.arrow === b, String(b.fn), b.obj !== b, b.cb[0], b.late, e instanceof B, e.late];
  `);
  assert.deepEqual([...r], [true, "own", true, 2, true, true, undefined]);
});

test("constructors returning an object", () => {
  const r = run(`
    class A { constructor() { return { from: "A" }; } }
    class B extends A { constructor() { super(); this.b = 1; } }
    const b = new B();
    [b.from, b.b, b instanceof B];
  `);
  assert.deepEqual([...r], ["A", 1, false]);
});

test("derived class without constructor forwards arguments", () => {
  const r = run(`
    class A { constructor(a, b) { this.sum = a + b; } }
    class B extends A {}
    new B(2, 3).sum;
  `);
  assert.equal(r, 5);
});

test("static methods are inherited", () => {
  const r = run(`
    class A { static hello() { return "hi from " + this.name; } }
    class B extends A {}
    B.hello();
  `);
  assert.equal(r, "hi from B");
});

test("getters and setters, including a get/set pair", () => {
  const r = run(`
    class Temp {
      constructor() { this._c = 0; }
      get f() { return this._c * 9 / 5 + 32; }
      set f(v) { this._c = (v - 32) * 5 / 9; }
      static get unit() { return "F"; }
    }
    const t = new Temp(); t.f = 212;
    [t._c, t.f, Temp.unit];
  `);
  assert.deepEqual([...r], [100, 212, "F"]);
});

test("computed, string and numeric method keys", () => {
  const r = run(`
    const k = "dyn";
    class A { [k + "amic"]() { return 1; } "quoted key"() { return 2; } 42() { return 3; } }
    const a = new A();
    [a.dynamic(), a["quoted key"](), a[42]()];
  `);
  assert.deepEqual([...r], [1, 2, 3]);
});

test("super property access in getters and via computed member", () => {
  const r = run(`
    class A { get v() { return 1; } m() { return "m"; } }
    class B extends A { get v() { return super.v + 1; } n() { return super["m"](); } }
    const b = new B();
    [b.v, b.n()];
  `);
  // super.v reads A.prototype.v with A.prototype as receiver (documented limitation),
  // which is fine for getters that don't depend on instance state.
  assert.deepEqual([...r], [2, "m"]);
});

test("instance fields, including arrow functions capturing this", () => {
  const r = run(`
    class Counter {
      count = 0;
      step = 2
      label
      inc = () => { this.count += this.step; return this; };
    }
    const c = new Counter();
    const inc = c.inc; inc(); inc();
    [c.count, c.label, "label" in c];
  `);
  assert.deepEqual([...r], [4, undefined, true]);
});

test("instance fields in derived classes initialize after super()", () => {
  const r = run(`
    class A { constructor() { this.seen = this.x; } }
    class B extends A { x = 5; constructor() { super(); this.after = this.x; } }
    class C extends A { x = 7; }
    const b = new B(), c = new C();
    [b.seen, b.after, c.seen, c.x];
  `);
  assert.deepEqual([...r], [undefined, 5, undefined, 7]);
});

test("base class fields initialize before constructor body", () => {
  const r = run(`class A { x = 1; constructor() { this.y = this.x + 1; } } new A().y;`);
  assert.equal(r, 2);
});

test("computed field keys are evaluated once at definition", () => {
  const r = run(`
    let n = 0;
    const kState = Symbol("state");
    class A { [kState] = { ok: true }; static [(n++, "s")] = 1; ["f" + n] = 2; }
    const a = new A(), b = new A();
    [a[kState].ok, a[kState] !== b[kState], A.s, a.f1, n];
  `);
  assert.deepEqual([...r], [true, true, 1, 2, 1]);
});

test("static fields and static blocks run in order with this = class", () => {
  const r = run(`
    class Config {
      static a = 1;
      static b = this.a + 1;
      static { this.c = this.b + 1; }
      static d;
    }
    [Config.a, Config.b, Config.c, "d" in Config];
  `);
  assert.deepEqual([...r], [1, 2, 3, true]);
});

test("class expressions: anonymous, named, and inferred names", () => {
  const r = run(`
    const Anon = class { hi() { return "a"; } };
    const Named = class Inner { self() { return Inner; } };
    const x = [class {}, class Y {}];
    [new Anon().hi(), Anon.name, new Named().self() === Named, Named.name, typeof x[0], x[1].name];
  `);
  assert.deepEqual([...r], ["a", "Anon", true, "Inner", "function", "Y"]);
});

test("nested classes inside methods get their own super binding", () => {
  const r = run(`
    class A { who() { return "A"; } }
    class B extends A {
      make() {
        class C extends B { who() { return "C<" + super.who(); } }
        return new C().who() + "|" + super.who();
      }
      who() { return "B<" + super.who(); }
    }
    new B().make();
  `);
  assert.equal(r, "C<B<A|A");
});

test("super() with spread arguments", () => {
  const r = run(`
    class A { constructor(...xs) { this.n = xs.length; } }
    class B extends A { constructor(...args) { super(...args); } }
    new B(1, 2, 3).n;
  `);
  assert.equal(r, 3);
});

test("method names that would shadow outer bindings stay anonymous", () => {
  const r = run(`
    function helper() { return "outer"; }
    class A { helper() { return helper(); } }
    new A().helper();
  `);
  assert.equal(r, "outer");
});

test("reserved-word method names work", () => {
  const r = run(`class A { delete() { return "d"; } static new() { return "n"; } } [new A().delete(), A.new()];`);
  assert.deepEqual([...r], ["d", "n"]);
});

test("async and generator methods", async () => {
  const r = run(`
    class A {
      async get1() { return 1; }
      *gen() { yield 1; yield 2; }
      static async *agen() { yield 3; }
    }
    [new A().get1(), [...new A().gen()], A.agen()];
  `);
  assert.equal(await r[0], 1);
  assert.deepEqual([...r[1]], [1, 2]);
  assert.equal((await r[2].next()).value, 3);
});

test("members named like modifiers", () => {
  const r = run(`
    class A { static() { return "s"; } get() { return "g"; } async = 1; static static = 2; }
    const a = new A();
    [a.static(), a.get(), a.async, A.static];
  `);
  assert.deepEqual([...r], ["s", "g", 1, 2]);
});

test("extends arbitrary expressions", () => {
  const r = run(`
    const mixin = (Base) => class extends Base { m() { return "mixed"; } };
    class Base {}
    class Final extends mixin(Base) {}
    [new Final().m(), new Final() instanceof Base];
  `);
  assert.deepEqual([...r], ["mixed", true]);
});

test("extends null-ish values throws a helpful error", () => {
  assert.throws(() => run(`const X = 5; class A extends X {}`), /Class extends value 5 is not a constructor/);
});

test("class declarations after statements without semicolons (ASI)", () => {
  const r = run(`
    const ANY = Symbol("any")
    class A { k() { return ANY; } }
    const n = [1]
    class B {}
    let t = \`x\`
    class C {}
    const f = () => class D {}
    function g() { return class E {} }
    [typeof new A().k(), typeof B, typeof C, f().name, g().name];
  `);
  assert.deepEqual([...r], ["symbol", "function", "function", "D", "E"]);
});

test("export forms", () => {
  const out = transpile(`export class A {}\nexport default class B {}\n`).code;
  assert.match(out, /export var A = /);
  assert.match(out, /var B = [\s\S]*export default B;/);
  const anon = transpile(`export default class {}\n`).code;
  assert.match(anon, /export default \/\*#__PURE__\*\/\(function \(\) \{/);
});

test("helpers go after the directive prologue and shebang", () => {
  const out = transpile(`#!/usr/bin/env node\n"use strict";\nclass A {}\n`).code;
  assert.ok(out.startsWith(`#!/usr/bin/env node\n"use strict";\nfunction _classCallCheck`));
});

test("helpers: false omits runtime helpers", () => {
  const { code, helpers } = transpile(`class A extends B {}`, { helpers: false });
  assert.doesNotMatch(code, /function _classCallCheck/);
  assert.deepEqual(helpers.sort(), ["_callSuper", "_classCallCheck", "_createClass", "_defineProperties", "_inherits"]);
});

test("helpersSource() provides globals for helpers: false output", () => {
  const { helpersSource } = require("../src");
  const { code } = transpile(`class A { m() { return 1; } } class B extends A { m() { return super.m() + 1; } } new B().m();`, { helpers: false });
  assert.equal(require("vm").runInNewContext(helpersSource() + code), 2);
});

test("generated names avoid collisions with user identifiers", () => {
  const r = run(`
    var _super = "mine", _classCallCheck = "mine too";
    class A { m() { return 1; } }
    class B extends A { m() { return super.m() + 1; } }
    [new B().m(), _super, _classCallCheck];
  `);
  assert.deepEqual([...r], [2, "mine", "mine too"]);
});

test("regex and division are told apart around classes", () => {
  const r = run(`
    class A { m(x) { return x / 2 / 1; } r() { return /}/.test("}"); } }
    [new A().m(8), new A().r()];
  `);
  assert.deepEqual([...r], [4, true]);
});

test("template literals with nested braces inside class bodies", () => {
  const r = run("class A { m() { return `${ { a: '}' }.a }-${`${1}`}`; } } new A().m();");
  assert.equal(r, "}-1");
});

test("object literal methods using super are left untouched", () => {
  const src = `const o = { m() { return super.toString; } };`;
  assert.equal(transpile(src).code, src);
});

test("reports unsupported features with location", () => {
  const cases = [
    [`class A {\n  #x = 1;\n}`, /Private class members/, 2, 3],
    [`class A {\n  @dec m() {}\n}`, /Decorators are not supported/, 2, 3],
    [`class A {\n  m() { super(); }\n}`, /'super\(\)' is only valid/, 2, 9],
    [`class A {`, /Unclosed '\{'/, 1, 9],
  ];
  for (const [src, msg, line, column] of cases) {
    assert.throws(
      () => transpile(src),
      (err) => {
        assert.ok(err instanceof TranspileError, `expected TranspileError for ${src}`);
        assert.match(err.message, msg);
        assert.equal(err.line, line, src);
        assert.equal(err.column, column, src);
        assert.match(err.frame, /\^/);
        return true;
      }
    );
  }
});
