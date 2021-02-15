// scanner.js
const { isNum, isOp, isAlphaNumeric, isKeyword } = require("./util");
const log = console.log;

class Scanner {
  constructor() {
    this.inst = null;
    this.tokens = [];
  }

  static getInst() {
    if (!this.inst) this.inst = new Scanner();
    return this.inst;
  }

  tokenize(str) {
    //log(str);
    //log(str.length);
    var s = "";
    for (var index = 0; index < str.length; index++) {
      s += str[index];
      s = s.trim();

      const peek = str[index + 1];
      log("s:", s, " str:", str[index]);

      if (isNum(s.trim()) && !isNum(peek)) {
        this.tokens.push({ type: "NUM", value: s.trim() });
        s = "";
        continue;
      }

      if (s.trim() == "(" || s.trim() == ")") {
        s.trim() == "("
          ? this.tokens.push({ type: "LPAREN" })
          : this.tokens.push({ type: "RPAREN" });
        s = "";
        continue;
      }

      if (s.trim() == "{") {
        this.tokens.push({ type: "LBRACE" });
        s = "";
        continue;
      }

      if (s.trim() == "}") {
        this.tokens.push({ type: "RBRACE" });
        s = "";
        continue;
      }

      if (isAlphaNumeric(s.trim()) && !isAlphaNumeric(peek)) {
        if (isKeyword(s.trim())) {
          this.tokens.push({ type: "KEYWORD", value: s });
        } else {
          this.tokens.push({ type: "IDENTIFIER", value: s });
        }
        s = "";
        continue;
      }

      if (isOp(s.trim()) && !isOp(peek)) {
        this.tokens.push({ type: "OP", value: s.trim() });
        s = "";
        continue;
      }

      if (s == ";" || s == "\n") {
        this.tokens.push({ type: "EOL" });
        s = "";
        continue;
      }
    }
    this.tokens.push({ type: "EOF" });
    return this.tokens;
  }
}
exports.Scanner = Scanner;
