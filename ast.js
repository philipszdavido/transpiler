// ast.js
class ClassDecl {
  constructor(clsName, methods) {
    this.clsName = clsName;
    this.methods = methods;
  }
  visit(visitor) {
    return visitor.visitClassDecl(this);
  }
}

class Method {
  constructor(name, type, body) {
    this.name = name;
    this.type = type;
    this.body = body;
  }
}

exports.classDecl = ClassDecl;
exports.Method = Method;
