"use strict";

/**
 * Runtime helpers injected at the top of transpiled output. Each is ES5 and
 * emitted only when used. `$name` placeholders are replaced with the
 * collision-free names chosen for this file.
 */
const HELPERS = {
  classCallCheck: {
    deps: [],
    code: `function $classCallCheck(instance, Constructor) {
  if (!(instance instanceof Constructor)) {
    throw new TypeError("Cannot call a class as a function");
  }
}`,
  },

  defineProperties: {
    deps: [],
    code: `function $defineProperties(target, props) {
  for (var i = 0; i < props.length; i++) {
    var prop = props[i];
    var desc = { enumerable: false, configurable: true };
    if ("value" in prop) {
      desc.value = prop.value;
      desc.writable = true;
    } else {
      var prev = Object.getOwnPropertyDescriptor(target, prop.key);
      var merge = prev && !("value" in prev);
      desc.get = prop.get || (merge ? prev.get : undefined);
      desc.set = prop.set || (merge ? prev.set : undefined);
    }
    Object.defineProperty(target, prop.key, desc);
  }
}`,
  },

  createClass: {
    deps: ["defineProperties"],
    code: `function $createClass(Constructor, protoProps, staticProps) {
  if (protoProps) $defineProperties(Constructor.prototype, protoProps);
  if (staticProps) $defineProperties(Constructor, staticProps);
  Object.defineProperty(Constructor, "prototype", { writable: false });
  return Constructor;
}`,
  },

  callSuper: {
    deps: [],
    code: `function $callSuper(self, Super, args) {
  var src = Function.prototype.toString.call(Super);
  var result = /\\[native code\\]|^class[\\s{]/.test(src) && typeof Reflect !== "undefined" && Reflect.construct
    ? Reflect.construct(Super, args, self.constructor)
    : Super.apply(self, args);
  return result !== null && (typeof result === "object" || typeof result === "function") ? result : self;
}`,
  },

  inherits: {
    deps: [],
    code: `function $inherits(subClass, superClass) {
  if (typeof superClass !== "function" && superClass !== null) {
    throw new TypeError("Class extends value " + String(superClass) + " is not a constructor or null");
  }
  subClass.prototype = Object.create(superClass && superClass.prototype, {
    constructor: { value: subClass, writable: true, configurable: true }
  });
  if (superClass) {
    if (Object.setPrototypeOf) Object.setPrototypeOf(subClass, superClass);
    else subClass.__proto__ = superClass;
  }
}`,
  },
};

// Dependencies first so every helper is defined before use.
const ORDER = ["classCallCheck", "defineProperties", "createClass", "callSuper", "inherits"];

function renderHelpers(used, names) {
  const all = new Set();
  const visit = (key) => {
    if (all.has(key)) return;
    all.add(key);
    HELPERS[key].deps.forEach(visit);
  };
  used.forEach(visit);
  return ORDER.filter((key) => all.has(key))
    .map((key) => HELPERS[key].code.replace(/\$(\w+)/g, (m, k) => (k in names ? names[k] : m)))
    .join("\n\n");
}

/** Source for all helpers under their default names, for use with `helpers: false`. */
function helpersSource() {
  const names = {};
  for (const key of ORDER) names[key] = `_${key}`;
  return `${renderHelpers(ORDER, names)}\n`;
}

module.exports = { HELPERS, renderHelpers, helpersSource };
