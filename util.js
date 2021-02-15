// util.js
const operators = ["=", "+", "-", "*", "/", ">", "<", ">=", "<=", "==", "!="];
const keywords = ["class", "function", "prototype", "static", "var", "typeof"];

function isOp(v) {
  for (var i = 0; i < operators.length; i++) {
    if (operators[i] == v) return true;
  }
  return false;
}

function isNum(v) {
  return !isNaN(parseFloat(v)) && isFinite(v);
}

function isDigit(str) {
  return str >= "0" && str <= "9";
}

function isAlpha(str) {
  return (str > "a" && str <= "z") || (str >= "A" && str <= "Z") || str == "_";
}

function isAlphaNumeric(str) {
  return isAlpha(str) || isDigit(str);
}

function isKeyword(v) {
  for (var i = 0; i < keywords.length; i++) {
    if (keywords[i] == v) return true;
  }
  return false;
}

exports.isOp = isOp;
exports.isNum = isNum;
exports.isAlphaNumeric = isAlphaNumeric;
exports.isKeyword = isKeyword;
