// parser.js
const { ClassDecl, Method } = require("./ast.js");
const log = console.log;

class Parser {
  constructor() {
    this.inst;
    this.index = 0;
    this.tokens = null;
    this.expr = [];
  }

  static getInst() {
    if (!this.inst) this.inst = new Parser();
    return this.inst;
  }

  advance() {
    this.index++;
  }

  peep() {
    return this.tokens(this.index + 1);
  }

  current() {
    return this.tokens[this.index];
  }

  parse(tokens) {
    this.tokens = tokens;
    while (this.current().type == "EOF") {
      this.expr.push(this.statements());
    }
    return this.expr;
  }

  statements() {
    const current = this.current;
    if (current.value == "class") {
      return this.classDeclaration();
    }
  }

  expression() {
    return this.add();
  }

  classDeclaration() {
    this.advance();
    const className = this.current().value;
    while (this.current().type == "LBRACE") {
      this.advance();
    }
    this.advance();
    let methods = [];
    while (
      this.current().type != "RBRACE" &&
      this.tokens[this.index + 1].type != "EOF"
    ) {
      methods.push(this._classMethods);
    }
    this.advance();
    return new ClassDecl(className, methods);
  }

  _classMethods() {
    let type = null;
    if (this.current().value == "static") {
      type = this.current().value;
      this.advance();
    }
    let methodName = this.current().value;
    this.advance();
    while (this.current().type != "LBRACE") {
      this.advance();
    }
    return new Method(methodName, type, this.blockStatement());
  }

  blockStatement() {
    this.advance();
    let statements = [];
    while (
      this.current().type != "RBRACE" &&
      this.tokens[this.index + 1].type != "EOF"
    ) {
      statements.push(this.statements());
      this.advance();
    }
    this.advance();
    return [statements];
  }
}
exports.Parser = Parser;
