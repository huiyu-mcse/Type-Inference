#!/usr/bin/env node
"use strict";

const esprima = require("esprima");
const fs = require("fs");
const path = require("path");

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

// -- function node helper ----------------------------------------------------
// for FunctionExpression, ArrowFunctionExpression,
// and the FunctionExpression-as-property case inside ObjectExpression.
function inferFuncNode(funcNode, fnName, fnScope, env, xTarget) {
  const qualName = `${fnName}__${fnScope}`;

  const paramNames = funcNode.params.map((p) => p.name);
  functionParams.set(qualName, paramNames);

  const fnEnv = new Map(env);
  const paramTVs = [];
  for (const p of funcNode.params) {
    paramTVs.push(envDeclare(fnEnv, p.name, qualName));
  }

  let hasReturn;
  if (
    funcNode.type === "ArrowFunctionExpression" &&
    funcNode.body.type !== "BlockStatement"
  ) {
    const Xbody = inferExpr(funcNode.body, fnEnv, qualName);
    addCons(Xbody, `ret__${qualName}`);
    hasReturn = true;
  } else {
    hasReturn = inferStmt(funcNode.body, fnEnv, qualName);
  }

  if (!hasReturn) {
    addCons("void", `ret__${qualName}`);
  }

  const retTV = `ret__${qualName}`;
  functionTypes.set(qualName, { params: paramTVs, ret: retTV });

  if (xTarget) {
    addCons(xTarget, funcType(qualName, paramTVs, retTV));
  }

  return;
}

// for function as a property of the object
function inferObjectExpr(node, env, scope, ownerName) {
  const Xobj = fresh();

  if (node.properties.length === 0) {
    addCons(Xobj, "{}");
    return Xobj;
  }

  for (const p of node.properties) {
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

// -- Expression inference ----------------------------------------------------
function inferExpr(node, env, scope) {
  if (!node) return fresh();

  switch (node.type) {
    // -- Primitives and Variables ----------------------------------
    case "Literal": { // e.g. 3, "haha", true,...
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

    case "Identifier": { // e.g. x, y,...
      return envGet(env, node.name, scope);
    }

    // -- Operations ------------------------------------------------
    case "BinaryExpression":
    case "LogicalExpression": { // e.g. a + b, a > b, a && b,...
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

    case "UpdateExpression": { // e.g. x++, x--,...
      const Xa = inferExpr(node.argument, env, scope);
      addCons(Xa, "num");
      return Xa;
    }

    case "ConditionalExpression": { // e.g. e1 ? e2 : e3
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

    case "SequenceExpression": { // (e1, e2, ..., en)
      let Xlast;
      for (const expr of node.expressions) {
        Xlast = inferExprStmt(expr, env, scope);
      }
      return Xlast;
    }

    // -- Objects, Arrays and Functions -----------------------------
    case "ObjectExpression": { // e.g. {e1, e2, ..., en}
      return inferObjectExpr(node, env, scope, null);
    }
      
    case "MemberExpression": { // e.g. obj.prop, arr[index], ...
      const Xobj = inferExpr(node.object, env, scope);
      const X3 = fresh();

      if (
        node.computed &&
        !(
          node.property.type === "Literal" &&
          typeof node.property.value === "string"
        )
      ) { // e.g. arr[i] or arr[0] → array index access
        const Xidx = inferExpr(node.property, env, scope);
        addCons(Xidx, "num");
        addCons(Xobj, `Array<${X3}>`);
      } else { // e.g. obj.prop or obj["prop"] → object property access
        const prop = node.computed
          ? String(node.property.value)
          : node.property.name;
        addCons(Xobj, `{${prop}: ${X3}}`);
      }
      return X3;
    }

    case "CallExpression": { // ex: f(e1, e2, ..., en)
      const fname = node.callee.type === "Identifier" ? node.callee.name : null;
      if (!fname) { // e.g. obj.method(1, 2), (function(x){})(5), ...
        for (const arg of node.arguments) inferExpr(arg, env, scope);
        return fresh();
      }

      // from current scope upward to global
      const qualName = functionParams.has(`${fname}__${scope}`)
        ? `${fname}__${scope}`
        : `${fname}__global`;

      const fnVar = envGet(env, fname, scope);
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

    case "FunctionExpression": // e.g. function(a) { return a; }
    case "ArrowFunctionExpression": { // e.g. (n) => n * 2
      const fnName = node.id?.name ?? `anon__${fresh()}`;
      inferFuncNode(node, fnName, scope, env, null);
      return fresh();
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
  
  if (rhs.type === "ObjectExpression" && 
    rhs.properties.length === 0) { // x = {}
    addCons(xTarget, "{}");
    return;
  }

  if (rhs.type === "ObjectExpression") { // x = {e1, ...}
    const Xobj = inferObjectExpr(rhs, env, scope, name);
    addCons(Xobj, xTarget);
    return;
  }

  if (
    rhs.type === "BinaryExpression" &&
    ["+", "-", "*", "/", "%"].includes(rhs.operator)
  ) { // x = e1 op e2
    const X1 = inferExpr(rhs.left, env, scope);
    const X2 = inferExpr(rhs.right, env, scope);
    const X3 = fresh();
    addCons(X1, "num");
    addCons(X2, "num");
    addCons(X3, "num");
    addCons(X3, xTarget);
    return;
  }

  if (rhs.type === "MemberExpression" && !rhs.computed) { // x = e.p
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

    case "IfStatement": { // e.g. if (test) {consequent} (else {alternate})
      const Xcond = inferExpr(node.test, env, scope);
      addCons(Xcond, "bool");
      inferStmt(node.consequent, env, scope);
      if (node.alternate) inferStmt(node.alternate, env, scope);
      break;
    }

    case "WhileStatement": { // e.g. while (test) {body}
      const Xcond = inferExpr(node.test, env, scope);
      addCons(Xcond, "bool");
      inferStmt(node.body, env, scope);
      break;
    }

    case "DoWhileStatement": { // e.g. do {body} while (test)
      inferStmt(node.body, env, scope);
      const Xcond = inferExpr(node.test, env, scope);
      addCons(Xcond, "bool");
      break;
    }

    case "SwitchStatement": { // e.g. switch (discriminant) {cases}
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

    case "ForStatement": { // e.g. for (init; test; update) {body}
      if (node.init) {
        if (node.init.type === "VariableDeclaration") {
          inferStmt(node.init, env, scope);
        } else { // e.g. i = 0
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

    case "ForInStatement": { // e.g. for (left in right) {body}
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
    
    case "ForOfStatement": { // e.g. for (left of right) {body}
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
    case "VariableDeclaration": { // e.g. kind identifier (= init)
      for (const decl of node.declarations) {
        envDeclare(env, decl.id.name, scope);
        if (decl.init) handleRHS(decl.id.name, decl.init, env, scope);
      }
      break;
    }

    case "FunctionDeclaration": { // e.g. function id(params) {body}
      const fnName = node.id.name;
      const qualName = `${fnName}__${scope}`;

      const paramNames = node.params.map((p) => p.name);
      functionParams.set(qualName, paramNames);

      const paramTVs = [];
      const fnEnv = new Map(env);
      for (const p of node.params) {
        paramTVs.push(envDeclare(fnEnv, p.name, qualName));
      }

      const retTV = `ret__${qualName}`;
      const hasReturn = inferStmt(node.body, fnEnv, qualName);
      if (!hasReturn) {
        addCons("void", retTV);
      }

      functionTypes.set(qualName, {
        params: paramTVs,
        ret: retTV,
      });

      const fnTV = envDeclare(env, fnName, scope);
      addCons(fnTV, funcType(qualName, paramTVs, retTV));
      break;
    }

    // -- Others --------------------------------------------------------------
    case "ExpressionStatement": { // e.g. assignments, updates, calls
      inferExprStmt(node.expression, env, scope);
      break;
    }

    case "ReturnStatement": { // e.g. return (argument)
      if (node.argument) {
        const X1 = inferExpr(node.argument, env, scope);
        addCons(X1, `ret__${scope}`);
      } else {
        addCons("void", `ret__${scope}`);
      }
      return true;
    }

    case "ThrowStatement": { // e.g. throw argument;
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
    case "AssignmentExpression": { // x = rhs  or  x.p = rhs
      const lhs = node.left;
      const rhs = node.right;

      if (lhs.type === "Identifier") { // x = rhs
        handleRHS(lhs.name, rhs, env, scope);
        return;
      }

      if ( // x.p = e
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

      if (node.operator !== "=") { // +=, -=, ... - desugar to BinOp + assign
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

    case "UpdateExpression": { // i++, --i
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

let ast;
try {
  ast = esprima.parseScript(src, { tolerant: true });
} catch (e) {
  console.error(`Parse error: ${e.description} (line ${e.lineNumber})`);
  process.exit(1);
}

// Run inference on the whole program (top-level scope = 'global')
inferStmt(ast, new Map(), "global");

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
