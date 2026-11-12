"use strict";

/**
 * Error raised for syntax we can't tokenize or class features we don't support.
 * Carries a 1-based line/column and a short code frame for CLI output.
 */
class TranspileError extends SyntaxError {
  constructor(message, source, pos, filename) {
    const { line, column } = locate(source, pos);
    const where = `${filename || "<input>"}:${line}:${column}`;
    super(`${message} (${where})`);
    this.name = "TranspileError";
    this.reason = message;
    this.filename = filename || "<input>";
    this.line = line;
    this.column = column;
    this.pos = pos;
    this.frame = codeFrame(source, line, column);
  }
}

function locate(source, pos) {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < pos && i < source.length; i++) {
    if (source[i] === "\n") {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: pos - lineStart + 1 };
}

function codeFrame(source, line, column) {
  const lines = source.split("\n");
  const from = Math.max(1, line - 2);
  const to = Math.min(lines.length, line + 1);
  const width = String(to).length;
  const out = [];
  for (let n = from; n <= to; n++) {
    const marker = n === line ? ">" : " ";
    out.push(`${marker} ${String(n).padStart(width)} | ${lines[n - 1]}`);
    if (n === line) {
      out.push(`  ${" ".repeat(width)} | ${" ".repeat(Math.max(0, column - 1))}^`);
    }
  }
  return out.join("\n");
}

module.exports = { TranspileError, locate };
