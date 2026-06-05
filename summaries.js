"use strict";

// Demand-driven type summaries for known modules.
// Each entry: summaries[moduleName][methodName] = { params: TypeSpec[], ret: TypeSpec }
//
// TypeSpec:
//   'str' | 'num' | 'bool' | 'void' | '{}'
//   { kind: 'func', name: string, params: TypeSpec[], ret: TypeSpec }
//   { kind: 'array', elem: TypeSpec }
//
// Only methods actually accessed in the analysed file get instantiated.

function buildTypeTV(spec, name, fresh, addCons) {
  if (typeof spec === "string") {
    const v = fresh();
    addCons(v, spec);
    return v;
  }
  if (spec.optional && spec.type) {
    return buildTypeTV(spec.type, name, fresh, addCons);
  }
  if (spec.kind === "func") {
    const label = spec.name ?? name;
    const pTVs = spec.params.map((p, i) =>
      buildTypeTV(p, `${label}_p${i}`, fresh, addCons),
    );
    const r = buildTypeTV(spec.ret, `${label}_ret`, fresh, addCons);
    const fn = fresh();
    if (pTVs.length === 0) {
      addCons(fn, `Func<${label}>{() -> ${r}}`);
    } else {
      addCons(fn, `Func<${label}>{${[...pTVs, r].join(" -> ")}}`);
    }
    return fn;
  }
  if (spec.kind === "array") {
    const elem = buildTypeTV(spec.elem, `${name}_elem`, fresh, addCons);
    const v = fresh();
    addCons(v, `Array<${elem}>`);
    return v;
  }
  if (spec.kind === "obj") {
    // Return a shared TV that accumulates only the fields actually used at call sites.
    // Initialised to {} so it shows as an object (not bot) when the optional param
    // is omitted entirely. Field constraints are added demand-driven in infer.js.
    if (!spec._sharedTV) {
      spec._sharedTV = fresh();
      addCons(spec._sharedTV, "{}");
    }
    return spec._sharedTV;
  }
  return fresh();
}

function buildMethodTV(modName, propName, sig, fresh, addCons) {
  return buildTypeTV(
    { kind: "func", name: propName, params: sig.params, ret: sig.ret },
    `${modName}_${propName}`,
    fresh,
    addCons,
  );
}

const summaries = {};
summaries.buildMethodTV = buildMethodTV;
summaries.buildTypeTV = buildTypeTV;

// ── Node.js built-ins ─────────────────────────────────────────────────────────

const CHILD_PROCESS_OPTS = {
  kind: "obj",
  optional: true,
  fields: {
    cwd: "str",
    env: "{}",
    timeout: "num",
    encoding: "str",
    shell: "str",
    maxBuffer: "num",
  },
};

summaries["child_process"] = {
  exec: {
    params: [
      "str",
      CHILD_PROCESS_OPTS,
      {
        kind: "func",
        name: "exec_cb",
        params: ["bool", "str", "str"],
        ret: "void",
      },
    ],
    ret: "void",
  },
  execSync: { params: ["str", CHILD_PROCESS_OPTS], ret: "str" },
  spawn: { params: ["str", { kind: "array", elem: "str" }], ret: "{}" },
};

summaries["path"] = {
  join: { params: ["str"], ret: "str" },
  resolve: { params: ["str"], ret: "str" },
  dirname: { params: ["str"], ret: "str" },
  basename: { params: ["str"], ret: "str" },
  extname: { params: ["str"], ret: "str" },
  normalize: { params: ["str"], ret: "str" },
  relative: { params: ["str", "str"], ret: "str" },
  isAbsolute: { params: ["str"], ret: "bool" },
  parse: { params: ["str"], ret: "{}" },
  format: { params: ["{}"], ret: "str" },
};

summaries["vm"] = {
  createContext: { params: ["{}"], ret: "{}" },
  runInContext: { params: ["str", "{}", CHILD_PROCESS_OPTS], ret: "{}" },
  runInNewContext: { params: ["str", "{}", CHILD_PROCESS_OPTS], ret: "{}" },
  runInThisContext: { params: ["str", CHILD_PROCESS_OPTS], ret: "{}" },
  isContext: { params: ["{}"], ret: "bool" },
  compileFunction: { params: ["str", "{}"], ret: "{}" },
};

summaries["fs"] = {
  readFileSync: { params: ["str", "str"], ret: "str" },
  writeFileSync: { params: ["str", "str"], ret: "void" },
  readFile: {
    params: [
      "str",
      { type: "str", optional: true },
      {
        kind: "func",
        name: "readFile_cb",
        params: ["bool", "str"],
        ret: "void",
      },
    ],
    ret: "void",
  },
  writeFile: {
    params: [
      "str",
      "str",
      { kind: "func", name: "writeFile_cb", params: [], ret: "void" },
    ],
    ret: "void",
  },
  stat: {
    params: [
      "str",
      { kind: "func", name: "stat_cb", params: ["bool", "{}"], ret: "void" },
    ],
    ret: "void",
  },
  createWriteStream: { params: ["str", "{}"], ret: "{}" },
};

summaries["util"] = {
  format: { params: ["str", "str"], ret: "str" },
};

summaries["http"] = {
  createServer: {
    params: [
      {
        kind: "func",
        name: "requestListener",
        params: ["{}", "{}"],
        ret: "void",
      },
    ],
    ret: "{}",
  },
  request: {
    params: [
      "{}",
      { kind: "func", name: "http_request_cb", params: ["{}"], ret: "void" },
    ],
    ret: "{}",
  },
  get: {
    params: [
      "str",
      { kind: "func", name: "http_get_cb", params: ["{}"], ret: "void" },
    ],
    ret: "{}",
  },
};

summaries["https"] = {
  createServer: {
    params: [
      "{}",
      {
        kind: "func",
        name: "https_requestListener",
        params: ["{}", "{}"],
        ret: "void",
      },
    ],
    ret: "{}",
  },
  request: {
    params: [
      "{}",
      { kind: "func", name: "https_request_cb", params: ["{}"], ret: "void" },
    ],
    ret: "{}",
  },
  get: {
    params: [
      "str",
      { kind: "func", name: "https_get_cb", params: ["{}"], ret: "void" },
    ],
    ret: "{}",
  },
};

// ── JS built-in globals ───────────────────────────────────────────────────────
// These are pre-declared in the initial environment (not via require()).

summaries["JSON"] = {
  stringify: { params: ["{}"], ret: "str" },
  parse: { params: ["str"], ret: "{}" },
};

summaries["Math"] = {
  abs: { params: ["num"], ret: "num" },
  ceil: { params: ["num"], ret: "num" },
  floor: { params: ["num"], ret: "num" },
  round: { params: ["num"], ret: "num" },
  sqrt: { params: ["num"], ret: "num" },
  pow: { params: ["num", "num"], ret: "num" },
  max: { params: ["num", "num"], ret: "num" },
  min: { params: ["num", "num"], ret: "num" },
  log: { params: ["num"], ret: "num" },
  random: { params: [], ret: "num" },
  trunc: { params: ["num"], ret: "num" },
};

summaries["console"] = {
  log: { params: ["{}"], ret: "void" },
  error: { params: ["{}"], ret: "void" },
  warn: { params: ["{}"], ret: "void" },
  info: { params: ["{}"], ret: "void" },
  debug: { params: ["{}"], ret: "void" },
};

summaries["process"] = {
  exit: { params: ["num"], ret: "void" },
  cwd: { params: [], ret: "str" },
  chdir: { params: ["str"], ret: "void" },
  env: { kind: "prop", type: "stringmap" },
  argv: { kind: "prop", type: { kind: "array", elem: "str" } },
  platform: { kind: "prop", type: "str" },
  version: { kind: "prop", type: "str" },
  pid: { kind: "prop", type: "num" },
  stdout: { kind: "prop", type: "{}" },
  stderr: { kind: "prop", type: "{}" },
};

summaries["Array"] = {
  isArray: { params: ["{}"], ret: "bool" },
  from: { params: ["{}"], ret: { kind: "array", elem: "{}" } },
  of: { params: ["{}"], ret: { kind: "array", elem: "{}" } },
};

summaries["Object"] = {
  keys: { params: ["{}"], ret: { kind: "array", elem: "str" } },
  values: { params: ["{}"], ret: { kind: "array", elem: "{}" } },
  entries: { params: ["{}"], ret: { kind: "array", elem: "{}" } },
  assign: { params: ["{}"], ret: "{}" },
  freeze: { params: ["{}"], ret: "{}" },
  seal: { params: ["{}"], ret: "{}" },
  create: { params: ["{}"], ret: "{}" },
  fromEntries: { params: ["{}"], ret: "{}" },
  hasOwn: { params: ["{}", "str"], ret: "bool" },
  is: { params: ["{}", "{}"], ret: "bool" },
  getOwnPropertyNames: { params: ["{}"], ret: { kind: "array", elem: "str" } },
  getPrototypeOf: { params: ["{}"], ret: "{}" },
  defineProperty: { params: ["{}", "str", "{}"], ret: "{}" },
};

// Methods inherited from Object.prototype — present on every value, so accessing
// them must never add a structural field to the receiver's type.
summaries.__objectProtoMethods__ = {
  hasOwnProperty: { params: ["str"], ret: "bool" },
  isPrototypeOf: { params: ["{}"], ret: "bool" },
  propertyIsEnumerable: { params: ["str"], ret: "bool" },
  toString: { params: [], ret: "str" },
  valueOf: { params: [], ret: "{}" },
};

// Names of all globals that should be pre-declared in the initial environment.
summaries.__globals__ = [
  "JSON",
  "Math",
  "console",
  "process",
  "Object",
  "Array",
];

// Globals that are callable functions themselves (not objects with methods).
// String(x) → str, Number(x) → num, Boolean(x) → bool.
summaries.__globalCallables__ = {
  String: { params: ["{}"], ret: "str" },
  Number: { params: ["{}"], ret: "num" },
  Boolean: { params: ["{}"], ret: "bool" },
};

// ── Built-in type methods ─────────────────────────────────────────────────────
// Dispatch table for methods on str / num / bool values.
// Array methods are handled inline in infer.js (_accessArrayMethod).

summaries.__typeMethods__ = {
  str: {
    split: { params: ["str"], ret: { kind: "array", elem: "str" } },
    trim: { params: [], ret: "str" },
    trimEnd: { params: [], ret: "str" },
    trimStart: { params: [], ret: "str" },
    toLowerCase: { params: [], ret: "str" },
    toUpperCase: { params: [], ret: "str" },
    toLocaleLowerCase: { params: [], ret: "str" },
    toLocaleUpperCase: { params: [], ret: "str" },
    slice: { params: ["num", "num"], ret: "str" },
    substring: { params: ["num", "num"], ret: "str" },
    replace: { params: ["str", "str"], ret: "str" },
    replaceAll: { params: ["str", "str"], ret: "str" },
    concat: { params: ["str"], ret: "str" },
    includes: { params: ["str"], ret: "bool" },
    startsWith: { params: ["str"], ret: "bool" },
    endsWith: { params: ["str"], ret: "bool" },
    indexOf: { params: ["str"], ret: "num" },
    lastIndexOf: { params: ["str"], ret: "num" },
    charAt: { params: ["num"], ret: "str" },
    charCodeAt: { params: ["num"], ret: "num" },
    padStart: { params: ["num", "str"], ret: "str" },
    padEnd: { params: ["num", "str"], ret: "str" },
    repeat: { params: ["num"], ret: "str" },
    toString: { params: [], ret: "str" },
    match: { params: ["{}"], ret: { kind: "array", elem: "str" } },
    search: { params: ["{}"], ret: "num" },
    at: { params: ["num"], ret: "str" },
  },
  num: {
    toString: { params: [], ret: "str" },
    toFixed: { params: ["num"], ret: "str" },
    toPrecision: { params: ["num"], ret: "str" },
    toLocaleString: { params: [], ret: "str" },
  },
  bool: {
    toString: { params: [], ret: "str" },
  },
};

// Non-callable properties on built-in types.
summaries.__typeProps__ = {
  str: { length: "num" },
  arr: { length: "num" },
  num: {},
  bool: {},
};

module.exports = summaries;
