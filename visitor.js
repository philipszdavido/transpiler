class Visitor {
  visitClassDecl(clsDecl) {
    let ctx = "function ";
    ctx += clsDecl.clsName;
    ctx += "() {} \n";

    const methods = clsDecl.methods;
    for (const mth of methods) {
      ctx += this._visitMethod(mth, clsDecl);
    }
    return ctx;
  }

  _visitMethod(method, cls) {
    let ctx = cls.clsName;
    if (method.type == "static") {
      ctx += ".";
      ctx += method.name;
    } else {
      ctx += ".prototype.";
      ctx += method.name;
    }
    ctx += " = function() {";
    for (const bdy of method.body) {
    }
    ctx += "} \n";
    return ctx;
  }

  visitStatements(asts) {
    let ctx = "";
    for (const ast of asts) ctx += ast.visit(this);
    return ctx;
  }
}
exports.Visitor = Visitor;
