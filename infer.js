#!/usr/bin/env node
"use strict";

const acorn = require("acorn");
const fs = require("fs");
const path = require("path");
const Module = require("module");
const stubs = require("./stubs");
const { buildStub } = require("./gen_stubs");

// fresh type variable
let _cnt = 0;
const fresh = () => `T${++_cnt}`;

// constraint
const constraints = [];
const addCons = (a, b) => constraints.push(`${a} <= ${b}`);

// build a Func type string: Func<qualName>{p1 -> p2 -> ... -> ret}
const funcType = (qualName, paramTVs, retTV) =>
  paramTVs.length === 0
    ? `Func<${qualName}>{() -> ${retTV}}`
    : `Func<${qualName}>{${[...paramTVs, retTV].join(" -> ")}}`;

// function parameter names
const functionParams = new Map();
// save function type variables
const functionTypes = new Map();
// resolver/rejector TV → promise resolve/reject target TV
const resolverTargets = new Map();
const rejectorTargets = new Map();
// qualNames of async functions (return type is wrapped in Promise)
const asyncScopes = new Set();
// class methods: className -> [{name, params, ret}]
const classMethods = new Map();
// instance type variable -> className
const instanceClasses = new Map();

// environment
const mkTV = (name, scope) => `${name}__${scope}`; //env = { "x" => "x__global" }

// Γ(x)
function envGet(env, name, scope) {
  if (!env.has(name)) env.set(name, mkTV(name, scope));
  return env.get(name);
}

// force declaration in the current scope
function envDeclare(env, name, scope) {
  const tv = mkTV(name, scope);
  env.set(name, tv);
  return tv;
}

// -- parameter binding helper ------------------------------------------------
// Returns Array<{ name, tv }>.  ObjectPattern flattens to multiple entries.
function declareParam(p, fnEnv, qualName) {
  switch (p.type) {
    case "Identifier":
      return [{ name: p.name, tv: envDeclare(fnEnv, p.name, qualName) }];

    case "AssignmentPattern": {
      if (p.left.type === "ObjectPattern") {
        // e.g. { a = 0 } = {}
        return declareParam(p.left, fnEnv, qualName);
      }
      // e.g.  x = 0
      const [{ name, tv }] = declareParam(p.left, fnEnv, qualName);
      const defTV = inferExpr(p.right, fnEnv, qualName);
      addCons(defTV, tv);
      return [{ name, tv }];
    }

    case "ObjectPattern": {
      // e.g.  { a ...b = 0,}
      // Each field becomes its own positional param; defaults add constraints.
      const results = [];
      for (const prop of p.properties) {
        if (prop.type === "RestElement") continue;
        results.push(...declareParam(prop.value, fnEnv, qualName));
      }
      return results;
    }

    case "RestElement":
      return [
        {
          name: p.argument.name,
          tv: envDeclare(fnEnv, p.argument.name, qualName),
        },
      ];

    default: {
      const n = `_unk${fresh()}`;
      return [{ name: n, tv: fresh() }];
    }
  }
}

// -- function node helper ----------------------------------------------------
// for FunctionExpression, ArrowFunctionExpression,
// and the FunctionExpression-as-property case inside ObjectExpression.
function inferFuncNode(funcNode, fnName, fnScope, env, xTarget) {
  const qualName = `${fnName}__${fnScope}`;

  if (funcNode.async) {
    asyncScopes.add(qualName);
    const X_rej = fresh();
    addCons(`ret__${qualName}`, `Promise<async_inner__${qualName},${X_rej}>`);
  }

  const fnEnv = new Map(env);
  const paramNames = [];
  const paramTVs = [];
  for (const p of funcNode.params) {
    for (const { name, tv } of declareParam(p, fnEnv, qualName)) {
      paramNames.push(name);
      paramTVs.push(tv);
    }
  }
  functionParams.set(qualName, paramNames);

  let hasReturn;
  if (
    funcNode.type === "ArrowFunctionExpression" &&
    funcNode.body.type !== "BlockStatement"
  ) {
    const Xbody = inferExpr(funcNode.body, fnEnv, qualName);
    addCons(
      Xbody,
      funcNode.async ? `async_inner__${qualName}` : `ret__${qualName}`,
    );
    hasReturn = true;
  } else {
    hasReturn = inferStmt(funcNode.body, fnEnv, qualName);
  }

  if (!hasReturn) {
    addCons(
      "void",
      funcNode.async ? `async_inner__${qualName}` : `ret__${qualName}`,
    );
  }

  const retTV = `ret__${qualName}`;
  functionTypes.set(qualName, { params: paramTVs, ret: retTV });

  if (xTarget) {
    addCons(xTarget, funcType(qualName, paramTVs, retTV));
  }

  return;
}

// -- Promise helpers ---------------------------------------------------------
function inferNewPromise(node, env, scope) {
  const X_res = fresh();
  const X_rej = fresh();
  const X_p = fresh();
  addCons(X_p, `Promise<${X_res},${X_rej}>`);

  const executor = node.arguments[0];
  if (!executor) return X_p;

  const execName = executor.id?.name ?? `executor_${fresh()}`;
  const execQualName = `${execName}__${scope}`;
  const execEnv = new Map(env);
  const [resParam, rejParam] = executor.params ?? [];

  if (resParam?.type === "Identifier") {
    const resTV = envDeclare(execEnv, resParam.name, execQualName);
    resolverTargets.set(resTV, X_res);
    addCons(resTV, `Resolver<${X_res}>`);
  }

  if (rejParam?.type === "Identifier") {
    const rejTV = envDeclare(execEnv, rejParam.name, execQualName);
    rejectorTargets.set(rejTV, X_rej);
    addCons(rejTV, `Rejector<${X_rej}>`);
  }

  if (executor.body?.type === "BlockStatement") {
    inferStmt(executor.body, execEnv, execQualName);
  } else if (executor.body) {
    inferExpr(executor.body, execEnv, execQualName);
  }

  return X_p;
}

function inferPromiseThen(node, env, scope) {
  const X_promise = inferExpr(node.callee.object, env, scope);
  const X_res = fresh();
  const X_rej = fresh();
  addCons(X_promise, `Promise<${X_res},${X_rej}>`);

  const cb = node.arguments[0];
  let X_cb_ret = fresh();

  if (
    cb &&
    (cb.type === "FunctionExpression" || cb.type === "ArrowFunctionExpression")
  ) {
    const cbName = cb.id?.name ?? `then_cb_${fresh()}`;
    const cbQualName = `${cbName}__${scope}`;
    const cbEnv = new Map(env);
    const paramNames = [],
      paramTVs = [];
    for (const p of cb.params)
      for (const { name, tv } of declareParam(p, cbEnv, cbQualName)) {
        paramNames.push(name);
        paramTVs.push(tv);
      }
    functionParams.set(cbQualName, paramNames);
    if (paramTVs.length > 0) addCons(X_res, paramTVs[0]);

    let hasReturn;
    if (
      cb.type === "ArrowFunctionExpression" &&
      cb.body.type !== "BlockStatement"
    ) {
      addCons(inferExpr(cb.body, cbEnv, cbQualName), `ret__${cbQualName}`);
      hasReturn = true;
    } else {
      hasReturn = inferStmt(cb.body, cbEnv, cbQualName);
    }
    if (!hasReturn) addCons("void", `ret__${cbQualName}`);
    X_cb_ret = `ret__${cbQualName}`;
    functionTypes.set(cbQualName, { params: paramTVs, ret: X_cb_ret });
  } else if (cb) {
    inferExpr(cb, env, scope);
  }

  const X_result = fresh();
  addCons(X_result, `Promise<${X_cb_ret},${X_rej}>`);
  return X_result;
}

function inferPromiseCatch(node, env, scope) {
  const X_promise = inferExpr(node.callee.object, env, scope);
  const X_res = fresh();
  const X_rej = fresh();
  addCons(X_promise, `Promise<${X_res},${X_rej}>`);

  const cb = node.arguments[0];
  let X_cb_ret = fresh();

  if (
    cb &&
    (cb.type === "FunctionExpression" || cb.type === "ArrowFunctionExpression")
  ) {
    const cbName = cb.id?.name ?? `catch_cb_${fresh()}`;
    const cbQualName = `${cbName}__${scope}`;
    const cbEnv = new Map(env);
    const paramNames = [],
      paramTVs = [];
    for (const p of cb.params)
      for (const { name, tv } of declareParam(p, cbEnv, cbQualName)) {
        paramNames.push(name);
        paramTVs.push(tv);
      }
    functionParams.set(cbQualName, paramNames);
    if (paramTVs.length > 0) addCons(X_rej, paramTVs[0]);

    let hasReturn;
    if (
      cb.type === "ArrowFunctionExpression" &&
      cb.body.type !== "BlockStatement"
    ) {
      addCons(inferExpr(cb.body, cbEnv, cbQualName), `ret__${cbQualName}`);
      hasReturn = true;
    } else {
      hasReturn = inferStmt(cb.body, cbEnv, cbQualName);
    }
    if (!hasReturn) addCons("void", `ret__${cbQualName}`);
    X_cb_ret = `ret__${cbQualName}`;
    functionTypes.set(cbQualName, { params: paramTVs, ret: X_cb_ret });
  } else if (cb) {
    inferExpr(cb, env, scope);
  }

  const X_result = fresh();
  addCons(X_result, `Promise<${X_res},${X_cb_ret}>`);
  return X_result;
}

function inferPromiseSettle(node, env, scope, slot) {
  const arg = node.arguments[0];
  const X_arg = arg ? inferExpr(arg, env, scope) : "void";
  const X_res = fresh();
  const X_rej = fresh();
  addCons(X_arg, slot === "resolve" ? X_res : X_rej);
  const X_p = fresh();
  addCons(X_p, `Promise<${X_res},${X_rej}>`);
  return X_p;
}

function inferPromiseAll(node, env, scope) {
  const arg = node.arguments[0];
  const X_arr = arg ? inferExpr(arg, env, scope) : fresh();
  const X_elem = fresh();
  const X_res = fresh();
  const X_rej = fresh();
  addCons(X_arr, `Array<${X_elem}>`);
  addCons(X_elem, `Promise<${X_res},${X_rej}>`);
  const X_result_arr = fresh();
  addCons(X_result_arr, `Array<${X_res}>`);
  const X_p = fresh();
  addCons(X_p, `Promise<${X_result_arr},${X_rej}>`);
  return X_p;
}

// for function as a property of the object
function inferObjectExpr(node, env, scope, ownerName) {
  const Xobj = fresh();

  if (node.properties.length === 0) {
    addCons(Xobj, "{}");
    return Xobj;
  }

  for (const p of node.properties) {
    if (p.type === "SpreadElement") {
      inferExpr(p.argument, env, scope);
      continue;
    }
    const key = String(p.key.name ?? p.key.value);
    let Xval;

    if (
      p.value.type === "FunctionExpression" ||
      p.value.type === "ArrowFunctionExpression"
    ) {
      const localName = p.value.id?.name ?? key;
      const fnName = ownerName ? `${ownerName}.${localName}` : localName;
      const fnScope = scope;
      const Xval_fn = fresh();
      inferFuncNode(p.value, fnName, fnScope, env, Xval_fn);
      Xval = Xval_fn;
    } else {
      Xval = inferExpr(p.value, env, scope);
    }

    addCons(Xobj, `{${key}: ${Xval}}`);
  }

  return Xobj;
}

// -- Class node helper --------------------------------------------------------
function inferClassNode(node, className, env) {
  const methods = [];

  if (node.superClass?.type === "Identifier") {
    const parentName = node.superClass.name;
    if (classMethods.has(parentName)) {
      methods.push(...classMethods.get(parentName));
    }
  }

  // Pass 1: declare params + return TVs for every method, then pre-register
  // the class. Bodies are NOT processed yet, so that self-references like
  // `new Counter()` or `new NamedClass()` inside a body already find the
  // class in classMethods with its full method list.
  const methodEntries = [];
  for (const m of node.body.body) {
    if (m.type !== "MethodDefinition") continue;
    const methodName = m.key.name;
    const qualName = `${methodName}__${className}`;
    const fnEnv = new Map(env);
    const paramNames = [], paramTVs = [];
    for (const p of m.value.params) {
      for (const { name: pn, tv } of declareParam(p, fnEnv, qualName)) {
        paramNames.push(pn);
        paramTVs.push(tv);
      }
    }
    functionParams.set(qualName, paramNames);
    const retTV = `ret__${qualName}`;
    functionTypes.set(qualName, { params: paramTVs, ret: retTV });
    const entry = { name: methodName, params: paramTVs, ret: retTV };
    const idx = methods.findIndex((x) => x.name === methodName);
    if (idx >= 0) methods[idx] = entry; else methods.push(entry);
    methodEntries.push({ m, fnEnv, qualName });
  }

  // Pre-register so bodies can resolve `new ClassName()`.
  classMethods.set(className, methods);
  // Named class expression alias: `const X = class NamedClass { ... }`
  // — NamedClass is only visible inside the body, alias it so it resolves too.
  if (node.id?.name && node.id.name !== className) {
    classMethods.set(node.id.name, methods);
  }

  // Pass 2: process method bodies now that the class is fully registered.
  for (const { m, fnEnv, qualName } of methodEntries) {
    if (m.value.async) {
      asyncScopes.add(qualName);
      const X_rej = fresh();
      addCons(`ret__${qualName}`, `Promise<async_inner__${qualName},${X_rej}>`);
    }
    let hasReturn;
    if (
      m.value.type === "ArrowFunctionExpression" &&
      m.value.body.type !== "BlockStatement"
    ) {
      const Xbody = inferExpr(m.value.body, fnEnv, qualName);
      addCons(Xbody, m.value.async ? `async_inner__${qualName}` : `ret__${qualName}`);
      hasReturn = true;
    } else {
      hasReturn = inferStmt(m.value.body, fnEnv, qualName);
    }
    if (!hasReturn) {
      addCons("void", m.value.async ? `async_inner__${qualName}` : `ret__${qualName}`);
    }
  }

  return methods
    .map((m) => `${m.name}: ${[...m.params, m.ret].join(" -> ")}`)
    .join(", ");
}

// -- Expression inference ----------------------------------------------------
function inferExpr(node, env, scope) {
  if (!node) return fresh();

  switch (node.type) {
    // -- Primitives and Variables ----------------------------------
    case "Literal": {
      // e.g. 3, "haha", true,...
      const X = fresh();
      if (typeof node.value === "number") addCons(X, "num");
      else if (typeof node.value === "string") addCons(X, "str");
      else if (typeof node.value === "boolean") addCons(X, "bool");
      return X;
    }

    // Templates are always strings. Tagged templates not so, but that is a different case
    case "TemplateLiteral": {
      const X = fresh();
      addCons(X, "str");
      return X;
    }

    // TODO: TaggedTemplateExpression

    case "Identifier": {
      // e.g. x, y,...
      return envGet(env, node.name, scope);
    }

    // -- Operations ------------------------------------------------
    case "BinaryExpression":
    case "LogicalExpression": {
      // e.g. a + b, a > b, a && b,...
      const X1 = inferExpr(node.left, env, scope);
      const X2 = inferExpr(node.right, env, scope);
      const Xr = fresh();
      const op = node.operator;

      if (["+", "-", "*", "/", "%"].includes(op)) {
        addCons(X1, "num");
        addCons(X2, "num");
        addCons(Xr, "num");
      } else if (
        ["<", ">", "<=", ">=", "==", "===", "!=", "!=="].includes(op)
      ) {
        addCons(X1, X2);
        addCons(X2, X1);
        addCons(Xr, "bool");
      } else if (["&&", "||"].includes(op)) {
        addCons(X1, "bool");
        addCons(X2, "bool");
        addCons(Xr, "bool");
      }
      return Xr;
    }

    case "UnaryExpression": {
      const Xa = inferExpr(node.argument, env, scope);
      if (node.operator === "!") {
        addCons(Xa, "bool");
        const Xr = fresh();
        addCons(Xr, "bool");
        return Xr;
      }
      if (["-", "+"].includes(node.operator)) {
        addCons(Xa, "num");
        const Xr = fresh();
        addCons(Xr, "num");
        return Xr;
      }
      return Xa;
    }

    case "UpdateExpression": {
      // e.g. x++, x--,...
      const Xa = inferExpr(node.argument, env, scope);
      addCons(Xa, "num");
      return Xa;
    }

    case "ConditionalExpression": {
      // e.g. e1 ? e2 : e3
      const Xcond = inferExpr(node.test, env, scope);
      addCons(Xcond, "bool");
      const X2 = inferExpr(node.consequent, env, scope);
      const X3 = inferExpr(node.alternate, env, scope);
      const Xr = fresh();
      // Unify the types of both branches
      addCons(X2, Xr);
      addCons(X3, Xr);
      return Xr;
    }

    case "SequenceExpression": {
      // (e1, e2, ..., en)
      let Xlast;
      for (const expr of node.expressions) {
        Xlast = inferExprStmt(expr, env, scope);
      }
      return Xlast;
    }

    // -- Objects, Arrays and Functions -----------------------------
    case "ObjectExpression": {
      // e.g. {e1, e2, ..., en}
      return inferObjectExpr(node, env, scope, null);
    }

    case "MemberExpression": {
      // e.g. obj.prop, arr[index], ...
      const Xobj = inferExpr(node.object, env, scope);
      const X3 = fresh();

      if (
        node.computed &&
        !(
          node.property.type === "Literal" &&
          typeof node.property.value === "string"
        )
      ) {
        // e.g. arr[i] or arr[0] → array index access
        const Xidx = inferExpr(node.property, env, scope);
        addCons(Xidx, "num");
        addCons(Xobj, `Array<${X3}>`);
      } else {
        // e.g. obj.prop or obj["prop"] → object property access
        const prop = node.computed
          ? String(node.property.value)
          : node.property.name;
        addCons(Xobj, `{${prop}: ${X3}}`);
      }
      return X3;
    }

    case "NewExpression": {
      // e.g. new Promise(executor)
      if (node.callee.type === "Identifier" && node.callee.name === "Promise") {
        return inferNewPromise(node, env, scope);
      }
      // e.g. new Foo(args)
      for (const arg of node.arguments) inferExpr(arg, env, scope);
      const className =
        node.callee.type === "Identifier" ? node.callee.name : null;
      const Xinst = fresh();
      if (className && classMethods.has(className)) {
        const methods = classMethods.get(className);
        const sig = methods
          .map((m) => `${m.name}: ${[...m.params, m.ret].join(" -> ")}`)
          .join(", ");
        addCons(Xinst, `Obj<${className}>[${sig}]`);
        instanceClasses.set(Xinst, className);
      }
      return Xinst;
    }

    case "CallExpression": {
      // ex: f(e1, e2, ..., en)
      if (
        node.callee.type === "MemberExpression" &&
        !node.callee.computed &&
        node.callee.object.type === "Identifier" &&
        node.callee.object.name === "Promise" &&
        (node.callee.property.name === "resolve" ||
          node.callee.property.name === "reject")
      )
        return inferPromiseSettle(node, env, scope, node.callee.property.name);

      if (
        node.callee.type === "MemberExpression" &&
        !node.callee.computed &&
        node.callee.object.type === "Identifier" &&
        node.callee.object.name === "Promise" &&
        node.callee.property.name === "all"
      )
        return inferPromiseAll(node, env, scope);

      if (
        node.callee.type === "MemberExpression" &&
        !node.callee.computed &&
        node.callee.property.name === "then"
      )
        return inferPromiseThen(node, env, scope);

      if (
        node.callee.type === "MemberExpression" &&
        !node.callee.computed &&
        node.callee.property.name === "catch"
      )
        return inferPromiseCatch(node, env, scope);

      // require('module') — dispatch to stub if available
      if (
        node.callee.type === "Identifier" &&
        node.callee.name === "require" &&
        node.arguments.length === 1 &&
        node.arguments[0].type === "Literal" &&
        typeof node.arguments[0].value === "string"
      ) {
        const moduleName = node.arguments[0].value;
        if (stubs[moduleName]) return stubs[moduleName](fresh, addCons);

        // Fallback: introspect from node_modules (file-relative first, then global)
        const label = moduleName.replace(/[^a-zA-Z0-9_]/g, "_");
        const tryLoad = (load) => {
          try {
            const tv = buildStub(load(), label, fresh, addCons);
            if (tv) return tv;
          } catch (_e) {
            /* try next */
          }
          return null;
        };
        const tv =
          tryLoad(() =>
            Module.createRequire(path.resolve(filePath))(moduleName),
          ) ?? tryLoad(() => require(moduleName));
        if (tv) return tv;
      }
      // Static method call: ClassName.method(args)  — must come before the
      // generic MemberExpression fallback to avoid generating {method: T} on
      // the class variable (which would conflict with Class<ClassName>).
      if (
        node.callee.type === "MemberExpression" &&
        !node.callee.computed &&
        node.callee.object.type === "Identifier" &&
        classMethods.has(node.callee.object.name)
      ) {
        const methodName = node.callee.property.name;
        const method = classMethods
          .get(node.callee.object.name)
          .find((m) => m.name === methodName);
        if (method) {
          node.arguments.forEach((arg, i) => {
            const Xi = inferExpr(arg, env, scope);
            if (method.params[i]) addCons(Xi, method.params[i]);
          });
          return method.ret;
        }
      }

      // Instance method call: o.bar(args)
      if (
        node.callee.type === "MemberExpression" &&
        !node.callee.computed &&
        node.callee.object.type === "Identifier"
      ) {
        const Xobj = inferExpr(node.callee.object, env, scope);
        const className = instanceClasses.get(Xobj);
        const methodName = node.callee.property.name;
        if (className && classMethods.has(className)) {
          const method = classMethods
            .get(className)
            .find((m) => m.name === methodName);
          if (method) {
            node.arguments.forEach((arg, i) => {
              const Xi = inferExpr(arg, env, scope);
              if (method.params[i]) addCons(Xi, method.params[i]);
            });
            return method.ret;
          }
        }
      }

      const fname = node.callee.type === "Identifier" ? node.callee.name : null;
      if (!fname) {
        // e.g. obj.method(a, b), (function(x){})(5)
        const Xcallee = inferExpr(node.callee, env, scope);
        const Xret = fresh();
        const paramTVs = node.arguments.map(() => fresh());
        addCons(Xcallee, funcType(fresh(), paramTVs, Xret));
        node.arguments.forEach((arg, i) => {
          const Xi = inferExpr(arg, env, scope);
          addCons(Xi, paramTVs[i]);
        });
        return Xret;
      }

      const fnVar = envGet(env, fname, scope);

      if (resolverTargets.has(fnVar)) {
        const targetTV = resolverTargets.get(fnVar);
        for (const arg of node.arguments)
          addCons(inferExpr(arg, env, scope), targetTV);
        return fresh();
      }
      if (rejectorTargets.has(fnVar)) {
        const targetTV = rejectorTargets.get(fnVar);
        for (const arg of node.arguments)
          addCons(inferExpr(arg, env, scope), targetTV);
        return fresh();
      }

      // from current scope upward to global
      const qualName = functionParams.has(`${fname}__${scope}`)
        ? `${fname}__${scope}`
        : `${fname}__global`;
      const paramNames = functionParams.get(qualName);
      const callParamTVs = (paramNames ?? []).map((p) => `${p}__${qualName}`);
      addCons(fnVar, funcType(qualName, callParamTVs, `ret__${qualName}`));
      node.arguments.forEach((arg, i) => {
        const Xi = inferExpr(arg, env, scope);
        if (paramNames?.[i]) {
          addCons(Xi, `${paramNames[i]}__${qualName}`);
        }
      });
      return `ret__${qualName}`;
    }

    case "ArrayExpression": { // e.g. [e1, e2, ..., en]
      const Xelem = fresh();
      const Xarr = fresh();
      for (const elem of node.elements) {
        if (elem) {
          const Xi = inferExpr(elem, env, scope);
          addCons(Xi, Xelem);
        }
      }
      addCons(Xarr, `Array<${Xelem}>`);
      return Xarr;
    }

    case "AwaitExpression": {
      const X_expr = inferExpr(node.argument, env, scope);
      const X_res = fresh();
      const X_rej = fresh();
      addCons(X_expr, `Promise<${X_res},${X_rej}>`);
      return X_res;
    }

    case "ClassExpression": {
      const className = node.id?.name ?? `class_${fresh()}`;
      const sig = inferClassNode(node, className, env);
      const Xcls = fresh();
      addCons(Xcls, `Class<${className}>[${sig}]`);
      return Xcls;
    }

    case "FunctionExpression": // e.g. function(a) { return a; }
    case "ArrowFunctionExpression": {
      // e.g. (n) => n * 2
      const fnName = node.id?.name ?? `fun_${fresh()}`;
      const fnTV = mkTV(fnName, scope);
      inferFuncNode(node, fnName, scope, env, fnTV);
      return fnTV;
    }

    default:
      return fresh();
  }
}

// -- Assignment helpers ------------------------------------------------------
/**
 * Handle  xTarget = rhs  where xTarget is already a resolved type variable.
 * Dispatches to C-EmptyObj / C-BinOp / C-PropRead / C-Assign.
 */
function handleRHS(name, rhs, env, scope) {
  const xTarget = envGet(env, name, scope);

  if (rhs.type === "ObjectExpression" && rhs.properties.length === 0) {
    // x = {}
    addCons(xTarget, "{}");
    return;
  }

  if (rhs.type === "ObjectExpression") {
    // x = {e1, ...}
    const Xobj = inferObjectExpr(rhs, env, scope, name);
    addCons(Xobj, xTarget);
    return;
  }

  if (
    rhs.type === "BinaryExpression" &&
    ["+", "-", "*", "/", "%"].includes(rhs.operator)
  ) {
    // x = e1 op e2
    const X1 = inferExpr(rhs.left, env, scope);
    const X2 = inferExpr(rhs.right, env, scope);
    const X3 = fresh();
    addCons(X1, "num");
    addCons(X2, "num");
    addCons(X3, "num");
    addCons(X3, xTarget);
    return;
  }

  if (rhs.type === "MemberExpression" && !rhs.computed) {
    // x = e.p
    const X1 = inferExpr(rhs.object, env, scope);
    const X3 = fresh();
    const prop = rhs.property.name;
    addCons(X3, xTarget);
    addCons(X1, `{${prop}: ${X3}}`);
    return;
  }

  if (
    rhs.type === "FunctionExpression" ||
    rhs.type === "ArrowFunctionExpression"
  ) {
    const fnName = rhs.id?.name ?? name;
    inferFuncNode(rhs, fnName, scope, env, xTarget);
    return;
  }

  if (rhs.type === "ClassExpression") {
    const sig = inferClassNode(rhs, name, env);
    addCons(xTarget, `Class<${name}>[${sig}]`);
    return;
  }

  if (rhs.type === "NewExpression" && rhs.callee.type === "Identifier") {
    const className = rhs.callee.name;
    if (classMethods.has(className)) {
      for (const arg of rhs.arguments) inferExpr(arg, env, scope);
      const methods = classMethods.get(className);
      const sig = methods
        .map((m) => `${m.name}: ${[...m.params, m.ret].join(" -> ")}`)
        .join(", ");
      addCons(xTarget, `Obj<${className}>[${sig}]`);
      instanceClasses.set(xTarget, className);
      return;
    }
  }

  const X1 = inferExpr(rhs, env, scope); // Assign
  addCons(X1, xTarget);
}

// -- Statement inference -----------------------------------------------------
function inferStmt(node, env, scope) {
  let hasReturn = false;
  if (!node) return hasReturn;

  switch (node.type) {
    // -- Control Flow --------------------------------------------------------
    case "Program":
    case "BlockStatement": {
      for (const s of node.body) {
        if (inferStmt(s, env, scope)) {
          hasReturn = true;
        }
      }
      return hasReturn;
    }

    case "IfStatement": {
      // e.g. if (test) {consequent} (else {alternate})
      const Xcond = inferExpr(node.test, env, scope);
      addCons(Xcond, "bool");
      inferStmt(node.consequent, env, scope);
      if (node.alternate) inferStmt(node.alternate, env, scope);
      break;
    }

    case "WhileStatement": {
      // e.g. while (test) {body}
      const Xcond = inferExpr(node.test, env, scope);
      addCons(Xcond, "bool");
      inferStmt(node.body, env, scope);
      break;
    }

    case "DoWhileStatement": {
      // e.g. do {body} while (test)
      inferStmt(node.body, env, scope);
      const Xcond = inferExpr(node.test, env, scope);
      addCons(Xcond, "bool");
      break;
    }

    case "SwitchStatement": {
      // e.g. switch (discriminant) {cases}
      // Infer the discriminant — its type variable is registered but not
      // constrained to any particular base type (switch works over any type).
      const Xdisc = inferExpr(node.discriminant, env, scope);
      // Each case test is compared to the discriminant via strict equality,
      // so we unify their type variables (same rule as ===).
      for (const cas of node.cases) {
        if (cas.test) {
          const Xtest = inferExpr(cas.test, env, scope);
          addCons(Xdisc, Xtest);
          addCons(Xtest, Xdisc);
        }

        // process the body of each case
        for (const s of cas.consequent) inferStmt(s, env, scope);
      }
      break;
    }

    case "ForStatement": {
      // e.g. for (init; test; update) {body}
      if (node.init) {
        if (node.init.type === "VariableDeclaration") {
          inferStmt(node.init, env, scope);
        } else {
          // e.g. i = 0
          inferExprStmt(node.init, env, scope);
        }
      }

      if (node.test) {
        const Xcond = inferExpr(node.test, env, scope);
        addCons(Xcond, "bool");
      }

      inferStmt(node.body, env, scope);

      if (node.update) {
        inferExprStmt(node.update, env, scope);
      }
      break;
    }

    case "ForInStatement": {
      // e.g. for (left in right) {body}
      inferExpr(node.right, env, scope);

      let keyVar;
      if (node.left.type === "VariableDeclaration") {
        // e.g., for (var key in obj)
        const decl = node.left.declarations[0];
        keyVar = envDeclare(env, decl.id.name, scope);
      } else if (node.left.type === "Identifier") {
        // e.g., for (key in obj)
        keyVar = envGet(env, node.left.name, scope);
      }

      // Constrain the iteration key to be a string
      if (keyVar) {
        addCons(keyVar, "str");
      }

      inferStmt(node.body, env, scope);
      break;
    }

    case "LabeledStatement": {
      inferStmt(node.body, env, scope);
      break;
    }

    case "ForOfStatement": {
      // e.g. for (left of right) {body}
      inferExpr(node.right, env, scope);

      let valVar;
      if (node.left.type === "VariableDeclaration") {
        // e.g. for (const item of iterable)
        const decl = node.left.declarations[0];
        valVar = envDeclare(env, decl.id.name, scope);
      } else if (node.left.type === "Identifier") {
        // e.g. for (item of iterable)
        valVar = envGet(env, node.left.name, scope);
      }

      // TODO: Constrain valVar by the iterable's element type once
      // the solver supports Iterable<T> for both Array<T> and str.

      inferStmt(node.body, env, scope);
      break;
    }

    // -- Declarations --------------------------------------------------------
    case "VariableDeclaration": {
      // e.g. kind identifier (= init)
      for (const decl of node.declarations) {
        envDeclare(env, decl.id.name, scope);
        if (decl.init) handleRHS(decl.id.name, decl.init, env, scope);
      }
      break;
    }

    case "FunctionDeclaration": {
      // e.g. function id(params) {body}
      const fnName = node.id.name;
      const qualName = `${fnName}__${scope}`;

      if (node.async) {
        asyncScopes.add(qualName);
        const X_rej = fresh();
        addCons(
          `ret__${qualName}`,
          `Promise<async_inner__${qualName},${X_rej}>`,
        );
      }

      const fnEnv = new Map(env);
      const paramNames = [];
      const paramTVs = [];
      for (const p of node.params) {
        for (const { name, tv } of declareParam(p, fnEnv, qualName)) {
          paramNames.push(name);
          paramTVs.push(tv);
        }
      }
      functionParams.set(qualName, paramNames);

      const retTV = `ret__${qualName}`;
      const hasReturn = inferStmt(node.body, fnEnv, qualName);
      if (!hasReturn) {
        addCons("void", node.async ? `async_inner__${qualName}` : retTV);
      }

      functionTypes.set(qualName, {
        params: paramTVs,
        ret: retTV,
      });

      const fnTV = envDeclare(env, fnName, scope);
      addCons(fnTV, funcType(qualName, paramTVs, retTV));
      break;
    }

    case "ClassDeclaration": { // e.g. class Id { method(params) {body} ... }
      const className = node.id.name;
      const sig = inferClassNode(node, className, env);
      const Xclass = envDeclare(env, className, scope);
      addCons(Xclass, `Class<${className}>[${sig}]`);
      break;
    }

    // -- Others --------------------------------------------------------------
    case "ExpressionStatement": {
      // e.g. assignments, updates, calls
      inferExprStmt(node.expression, env, scope);
      break;
    }

    case "ReturnStatement": {
      // e.g. return (argument)
      const retTarget = asyncScopes.has(scope)
        ? `async_inner__${scope}`
        : `ret__${scope}`;
      if (node.argument) {
        const X1 = inferExpr(node.argument, env, scope);
        addCons(X1, retTarget);
      } else {
        addCons("void", retTarget);
      }
      return true;
    }

    case "ThrowStatement": {
      // e.g. throw argument;
      inferExpr(node.argument, env, scope);
      break;
    }

    case "TryStatement": {
      // e.g. try {block} (catch (param) {handler}) (finally {finalizer})
      inferStmt(node.block, env, scope);
      if (node.handler) {
        if (node.handler.param) {
          envDeclare(env, node.handler.param.name, scope);
        }
        inferStmt(node.handler.body, env, scope);
      }
      if (node.finalizer) inferStmt(node.finalizer, env, scope);
      break;
    }

    default:
      return hasReturn;
  }
}

/**
 * Handle expressions that appear at statement level
 * (assignments, compound assignments, update expressions, calls).
 */
function inferExprStmt(node, env, scope) {
  if (!node) return;

  switch (node.type) {
    case "AssignmentExpression": {
      // x = rhs  or  x.p = rhs
      const lhs = node.left;
      const rhs = node.right;

      if (lhs.type === "Identifier") {
        // x = rhs
        handleRHS(lhs.name, rhs, env, scope);
        return;
      }

      if (
        // x.p = e
        lhs.type === "MemberExpression" &&
        !lhs.computed &&
        lhs.object.type === "Identifier"
      ) {
        const X1 = inferExpr(rhs, env, scope); // Γ |- e : X1
        const X2 = envGet(env, lhs.object.name, scope); // X2 = Γ(x)
        const prop = lhs.property.name;
        addCons(X2, `{${prop}: ${X1}}`); // { X2 <= {p : X1} }
        return;
      }

      if (node.operator !== "=") {
        // +=, -=, ... - desugar to BinOp + assign
        const baseOp = node.operator.slice(0, -1); // '+=' -> '+'
        if (["+", "-", "*", "/", "%"].includes(baseOp)) {
          const X1 = inferExpr(lhs, env, scope);
          const X2 = inferExpr(rhs, env, scope);
          const Xr = fresh();
          addCons(X1, "num");
          addCons(X2, "num");
          addCons(Xr, "num");
          if (lhs.type === "Identifier") {
            const xVar = envGet(env, lhs.name, scope);
            addCons(Xr, xVar);
          }
        }
        return;
      }
      inferExpr(rhs, env, scope);
      break;
    }

    case "UpdateExpression": {
      // i++, --i
      const Xa = inferExpr(node.argument, env, scope);
      addCons(Xa, "num");
      break;
    }

    default: // call expressions, ...
      return inferExpr(node, env, scope);
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────
const filePath = process.argv[2];

if (!filePath) {
  console.error("Usage: node infer.js <source-file.js>");
  process.exit(1);
}

let src;
try {
  src = fs.readFileSync(filePath, "utf8");
} catch (e) {
  console.error(`Cannot read file: ${filePath}\n${e.message}`);
  process.exit(1);
}

if (src.startsWith("#!")) src = "//" + src.slice(2);

let ast = null;
try {
  ast = acorn.parse(src, {
    ecmaVersion: 2020,
    sourceType: "script",
    allowReturnOutsideFunction: true,
  });
} catch (scriptErr) {
  try {
    ast = acorn.parse(src, {
      ecmaVersion: 2020,
      sourceType: "module",
      allowReturnOutsideFunction: true,
    });
  } catch (e) {
    process.stderr.write(
      `Parse error in ${path.basename(filePath)}: ${e.message}\n`,
    );
  }
}

// Run inference on the whole program (top-level scope = 'global')
if (ast) inferStmt(ast, new Map(), "global");

// ── Output ────────────────────────────────────────────────────────────────────
const SEP = "─".repeat(60);
console.log(`\nType Inference Constraints`);
console.log(`File : ${path.resolve(filePath)}`);
console.log(SEP);

if (constraints.length === 0) {
  console.log("  (no constraints generated)");
} else {
  const pad = String(constraints.length).length;
  constraints.forEach((c, i) =>
    console.log(`  C${String(i + 1).padStart(pad, "0")}: ${c}`),
  );
}

console.log(SEP);
console.log(`Total: ${constraints.length} constraint(s)\n`);

console.log("\nFunction Types");
console.log(SEP);

for (const [qualName, t] of functionTypes.entries()) {
  const params = t.params.join(", ");
  console.log(`  ${qualName} : (${params}) -> ${t.ret}`);
}
