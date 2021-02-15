// index.js
const log = console.log;
const fs = require("fs");

const { Scanner } = require("./scanner.js");
const { Parser } = require("./parser.js");
const { Visitor } = require("./visitor");

const args = process.argv[2];

const buffer = fs.readFileSync(args).toString();
const scanner = Scanner.getInst();
const tokens = scanner.tokenize(buffer);
const parser = Parser.getInst();
const asts = parser.parse(tokens);
const result = new Visitor().visitStatements(asts);

fs.writeFileSync("test/cls-transpiled.js", result);
log(args, " successfully transpiled!!");
