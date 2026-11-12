# transpiler

A zero-dependency transpiler that lowers ES2015+ `class` syntax to ES5 constructor functions. Everything that isn't class syntax is copied through byte-for-byte, comments and formatting included.

```js
class Book {
  addBook() {}
  static getOneBook() {}
}
```

becomes

```js
var Book = /*#__PURE__*/(function () {
  "use strict";
  function Book() {
    _classCallCheck(this, Book);
  }
  _createClass(Book, [
    { key: "addBook", value: function addBook() {} }
  ], [
    { key: "getOneBook", value: function getOneBook() {} }
  ]);
  return Book;
})();
```

Requires Node.js 18 or later.

## CLI

```sh
transpile input.js                 # write to stdout
transpile input.js -o out.js       # write to a file
transpile src/*.js -d dist         # write each input under dist/, keeping relative paths
cat input.js | transpile           # read stdin
transpile --no-helpers input.js    # omit runtime helpers…
transpile --print-helpers > rt.js  # …and load them once from a shared file instead
```

It exits with 0 on success, 1 on a syntax or unsupported-feature error (printed as `file:line:col` with a code frame), and 2 on a usage error.

## API

```js
const { transpile, TranspileError, helpersSource } = require("transpiler");

const { code, helpers, classes } = transpile(source, { filename: "a.js", helpers: true });
```

- `helpers: false` leaves out the helper functions. `helpersSource()` returns all of them, so you can load them globally yourself.
- On error, it throws `TranspileError`, which has `line`, `column`, `reason` and `frame` properties.

## Supported

- Class declarations and expressions: named, anonymous, nested, and `export` / `export default`. A class assigned to a variable, as in `const A = class {}`, gets its name from the variable.
- `constructor`, instance and static methods, and getters and setters. Methods and accessors are non-enumerable, as in the spec.
- Computed, string and numeric keys, and reserved-word method names.
- `extends` with any expression, `super(...)`, `super.x` and `super.x(...)`, and `super[expr]` in methods, static methods and arrow functions.
- Subclassing native built-ins (`Error`, `Map`, …) and untranspiled ES classes. These use `Reflect.construct` when it's available.
- Instance fields, static fields (`this` refers to the class), computed field keys, and `static { }` blocks.
- `async`, generator and async generator methods. Their bodies are copied unchanged, so the target engine has to support them.
- Calling a class without `new` throws, and `.prototype` is non-writable.

## Not supported / limitations

- **Private members (`#x`) and decorators** raise a `TranspileError`.
- Only class syntax is lowered. Arrow functions, `let`/`const`, template literals and other ES2015+ syntax are left as they are, so use another tool if you need full ES5 output.
- Class declarations become `var`, which is function-scoped and has no temporal dead zone.
- Fields use assignment rather than `Object.defineProperty`, so setters inherited from the parent class will run.
- `super.prop` reads use the parent prototype as the receiver, so getters see the prototype rather than the instance.
- `super` inside an object-literal method that's nested in a class method is resolved against the class.
- No source maps.

## Development

```sh
npm test                                   # node:test, no dependencies
node --test test/transpile.test.js         # one file
node --test --test-name-pattern="getters"  # tests whose names match
```
