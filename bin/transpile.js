#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { transpile, TranspileError, helpersSource } = require("../src");
const pkg = require("../package.json");

const USAGE = `Usage: transpile [options] [file ...]

Lowers ES2015+ class syntax to ES5 constructor functions.
Reads from stdin when no file is given (or the file is "-").

Options:
  -o, --out-file <file>  Write output to <file> (single input only)
  -d, --out-dir <dir>    Write each input to <dir>, keeping its relative path
      --no-helpers       Don't inject runtime helpers (provide them globally)
      --print-helpers    Print all runtime helpers and exit (pair with --no-helpers)
  -h, --help             Show this help
  -v, --version          Show version

Without -o or -d, output is written to stdout.`;

function parseArgs(argv) {
  const opts = { files: [], outFile: null, outDir: null, helpers: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) fail(`Missing value for ${arg}`);
      return v;
    };
    if (arg === "-h" || arg === "--help") opts.help = true;
    else if (arg === "-v" || arg === "--version") opts.version = true;
    else if (arg === "-o" || arg === "--out-file") opts.outFile = value();
    else if (arg === "-d" || arg === "--out-dir") opts.outDir = value();
    else if (arg === "--no-helpers") opts.helpers = false;
    else if (arg === "--print-helpers") opts.printHelpers = true;
    else if (arg.startsWith("-") && arg !== "-") fail(`Unknown option: ${arg}`);
    else opts.files.push(arg);
  }
  return opts;
}

function fail(message) {
  process.stderr.write(`transpile: ${message}\n`);
  process.exit(2);
}

function compile(code, filename, helpers) {
  try {
    return transpile(code, { filename, helpers }).code;
  } catch (err) {
    if (err instanceof TranspileError) {
      process.stderr.write(`${err.filename}:${err.line}:${err.column}: error: ${err.reason}\n${err.frame}\n`);
      return null;
    }
    throw err;
  }
}

function writeFile(file, code) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, code);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return void process.stdout.write(`${USAGE}\n`);
  if (opts.version) return void process.stdout.write(`${pkg.version}\n`);
  if (opts.printHelpers) return void process.stdout.write(helpersSource());
  if (opts.outFile && opts.outDir) fail("Use either --out-file or --out-dir, not both");
  if (opts.outFile && opts.files.length > 1) fail("--out-file accepts a single input; use --out-dir");

  const inputs = opts.files.length ? opts.files : ["-"];
  if (opts.outDir && inputs.includes("-")) fail("--out-dir requires file inputs, not stdin");

  let failed = false;
  for (const input of inputs) {
    let source;
    try {
      source = input === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(input, "utf8");
    } catch (err) {
      process.stderr.write(`transpile: cannot read ${input}: ${err.message}\n`);
      failed = true;
      continue;
    }
    const filename = input === "-" ? "<stdin>" : input;
    const code = compile(source, filename, opts.helpers);
    if (code === null) {
      failed = true;
      continue;
    }

    if (opts.outFile) writeFile(opts.outFile, code);
    else if (opts.outDir) writeFile(path.join(opts.outDir, path.relative(process.cwd(), path.resolve(input))), code);
    else process.stdout.write(code);
  }
  process.exitCode = failed ? 1 : 0;
}

main();
