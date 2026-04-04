#!/usr/bin/env node
'use strict';

const esprima = require('esprima');
const fs      = require('fs');
const path    = require('path');

// fresh variable
let _cnt = 0;
const fresh = () => `T${++_cnt}`;

// constraint
const constraints = [];

const addCons = (a, b) => constraints.push(`${a} <= ${b}`);

// environment helpers
const mkTV = (name, scope) => `${name}__${scope}`;  //env = { "x" => "x__global" }

function envGet(env, name, scope) {                 //envGet(env, "x", "global");
  if (!env.has(name)) env.set(name, mkTV(name, scope));
  return env.get(name);
}

// Force declaration in the current scope, shadowing outer variables
function envDeclare(env, name, scope) {
  const tv = mkTV(name, scope);
  env.set(name, tv);
  return tv;
}

// ── Expression inference ──────────────────────────────────────────────────────
// inferExpr(node, env, scope) → typeVar
// Generates constraints for the expression and returns its type variable.

function inferExpr(node, env, scope) {
  if (!node) return fresh();

  switch (node.type) {

    case 'Literal': {
      const X = fresh();
      if      (typeof node.value === 'number')  addCons(X, 'num');
      else if (typeof node.value === 'string')  addCons(X, 'str');
      else if (typeof node.value === 'boolean') addCons(X, 'bool');
      // null / regex / etc. → unconstrained fresh var
      return X;
    }

    // var
    case 'Identifier': {
      // Γ(x)
      return envGet(env, node.name, scope);
    }

    // binary operation
    case 'BinaryExpression':
    case 'LogicalExpression': {
      const X1 = inferExpr(node.left,  env, scope);
      const X2 = inferExpr(node.right, env, scope);
      const Xr = fresh();
      const op = node.operator;

      if (['+', '-', '*', '/', '%'].includes(op)) {
        // OP(X1, X2) for arithmetic: both operands ↔ num, result == num
        addCons(X1, 'num');
        addCons(X2, 'num');
        addCons(Xr, 'num');
      } else if (['<', '>', '<=', '>=', '==', '===', '!=', '!=='].includes(op)) {
        // Todo: check
        addCons(X1, X2);
        addCons(X2, X1);

        addCons(Xr, 'bool');
      } else if (['&&', '||'].includes(op)) {
        addCons(X1, 'bool');
        addCons(X2, 'bool');
        addCons(Xr, 'bool');
      }

      return Xr;
    }

    // unary operation
    case 'UnaryExpression': {
      const Xa = inferExpr(node.argument, env, scope);
      if (node.operator === '!') {
        addCons(Xa, 'bool');
        const Xr = fresh();
        addCons(Xr, 'bool');
        return Xr;
      }
      if (['-', '+'].includes(node.operator)) {
        addCons(Xa, 'num');
        const Xr = fresh();
        addCons(Xr, 'num');
        return Xr;
      }
      return Xa;
    }

    // TODO: is this correct?
    // ── Member expression used inside a larger expression (C-PropRead) ─────
    case 'MemberExpression': {
      const Xobj = inferExpr(node.object, env, scope);
      const X3   = fresh();
      const prop = node.computed
        ? String(node.property.name ?? node.property.value)
        : node.property.name;
      addCons(Xobj, `{${prop}: ${X3}}`);
      return X3;
    }

    // objeto
    case 'ObjectExpression': {
      const Xobj = fresh();
      if (node.properties.length === 0) {
        addCons(Xobj, '{}');
      } else {
        for (const p of node.properties) {
          const Xval = inferExpr(p.value, env, scope);
          const key  = String(p.key.name ?? p.key.value);
          addCons(Xobj, `{${key}: ${Xval}}`);
        }
      }
      return Xobj;
    }

    // Update expression used as sub-expression (x++, --x)
    case 'UpdateExpression': {
      const Xa = inferExpr(node.argument, env, scope);
      addCons(Xa, 'num');
      const Xr = fresh();
      addCons(Xr, 'num');
      return Xr;
    }

    default:
      return fresh();   // unsupported sub-expression → unconstrained fresh var
  }
}

// ── Assignment helpers ────────────────────────────────────────────────────────
/**
 * Handle  xTarget = rhs  where xTarget is already a resolved type variable.
 * Dispatches to C-EmptyObj / C-BinOp / C-PropRead / C-Assign.
 */
function handleRHS(xTarget, rhs, env, scope) {

  // ── C-EmptyObj :  x = {} ────────────────────────────────────────────────
  if (rhs.type === 'ObjectExpression' && rhs.properties.length === 0) {
    addCons(xTarget, '{}');
    return;
  }

  // ── C-BinOp   :  x = e1 op e2  (arithmetic operators) ──────────────────
  if (rhs.type === 'BinaryExpression' &&
      ['+', '-', '*', '/', '%'].includes(rhs.operator)) {
    const X1 = inferExpr(rhs.left,  env, scope);  // Γ → e1 : X1
    const X2 = inferExpr(rhs.right, env, scope);  // Γ → e2 : X2
    const X3 = fresh();                            // X3 = Xres (result)
    // OP(X1, X2) = !3
    addCons(X1, 'num');
    addCons(X2, 'num');
    addCons(X3, 'num');
    // X3 ↔ X0  where X0 = Γ(x)
    addCons(X3, xTarget);
    return;
  }

  // ── C-PropRead :  x = e.p ───────────────────────────────────────────────
  if (rhs.type === 'MemberExpression' && !rhs.computed) {
    const X1   = inferExpr(rhs.object, env, scope);  // Γ → e : X1
    const X3   = fresh();                              // X3 fresh
    const prop = rhs.property.name;
    // { X3 ↔ X2 ,  X1 ↔ {p : X3} }   where X2 = xTarget = Γ(x)
    addCons(X3, xTarget);
    addCons(X1, `{${prop}: ${X3}}`);
    return;
  }

  // ── C-Assign  :  x = e  (general case) ──────────────────────────────────
  const X1 = inferExpr(rhs, env, scope);
  addCons(X1, xTarget);
}

// ── Statement inference ───────────────────────────────────────────────────────
// inferStmt(node, env, scope)  – generates constraints, no return value.

function inferStmt(node, env, scope) {
  if (!node) return;

  switch (node.type) {

    // ── Program root / block ────────────────────────────────────────────────
    case 'Program':
    case 'BlockStatement':
      // C-Seq applied repeatedly
      for (const s of node.body) inferStmt(s, env, scope);
      break;

    // ── Variable declaration  (var / let / const) ───────────────────────────
    case 'VariableDeclaration':
      for (const decl of node.declarations) {
        //const xVar = envGet(env, decl.id.name, scope);
        const xVar = envDeclare(env, decl.id.name, scope);
        if (decl.init) handleRHS(xVar, decl.init, env, scope);
      }
      break;

    // ── Expression statement  (assignments, updates, calls …) ───────────────
    case 'ExpressionStatement':
      inferExprStmt(node.expression, env, scope);
      break;

    // ── C-If ────────────────────────────────────────────────────────────────
    case 'IfStatement': {
      const Xcond = inferExpr(node.test, env, scope);
      addCons(Xcond, 'bool');                           // {X1 == bool}
      inferStmt(node.consequent, env, scope);
      if (node.alternate) inferStmt(node.alternate, env, scope);
      break;
    }

    // ── C-While ─────────────────────────────────────────────────────────────
    case 'WhileStatement': {
      const Xcond = inferExpr(node.test, env, scope);
      addCons(Xcond, 'bool');                           // {X1 == bool}
      inferStmt(node.body, env, scope);
      break;
    }

  /*
    // ── For loop  (desugar: init ; while(test){ body ; update }) ────────────
    case 'ForStatement': {
      if (node.init)   inferStmt(node.init, env, scope);
      if (node.test) {
        const Xc = inferExpr(node.test, env, scope);
        addCons(Xc, 'bool');
      }
      inferStmt(node.body, env, scope);
      if (node.update) inferExprStmt(node.update, env, scope);
      break;
    }
      */

    // ── Function declaration  →  new scope ──────────────────────────────────
    case 'FunctionDeclaration': {
      const fnName = node.id ? node.id.name : `anon${fresh()}`;
      const fnEnv  = new Map(env);          // inherit outer env (closure semantics)
      for (const p of node.params) envGet(fnEnv, p.name, fnName);
      //for (const p of node.params) envDeclare(fnEnv, p.name, fnName);
      inferStmt(node.body, fnEnv, fnName);
      break;
    }

    // ── Return statement ─────────────────────────────────────────────────────
    case 'ReturnStatement':
      if (node.argument) inferExpr(node.argument, env, scope);
      break;

    default:
      break;
  }
}

/**
 * Handle expressions that appear at statement level
 * (assignments, compound assignments, update expressions, calls).
 */
function inferExprStmt(node, env, scope) {
  if (!node) return;

  switch (node.type) {

    // ── x = rhs  or  x.p = rhs ──────────────────────────────────────────
    case 'AssignmentExpression': {
      const lhs = node.left;
      const rhs = node.right;

      // x = rhs
      if (lhs.type === 'Identifier') {
        const xVar = envGet(env, lhs.name, scope);
        handleRHS(xVar, rhs, env, scope);
        return;
      }

      // x.p = e   →   C-PropWrite2
      if (lhs.type === 'MemberExpression' && !lhs.computed &&
          lhs.object.type === 'Identifier') {
        const X1   = inferExpr(rhs, env, scope);          // Γ → e : X1
        const X2   = envGet(env, lhs.object.name, scope); // X2 = Γ(x)
        const prop = lhs.property.name;
        // { X2 ↔ {p : X1} }
        addCons(X2, `{${prop}: ${X1}}`);
        return;
      }

      // Compound assignments  (+=, -=, …)  – desugar to BinOp + assign
      if (node.operator !== '=') {
        const baseOp = node.operator.slice(0, -1); // '+=' → '+'
        if (['+', '-', '*', '/', '%'].includes(baseOp)) {
          const X1  = inferExpr(lhs, env, scope);
          const X2  = inferExpr(rhs, env, scope);
          const Xr  = fresh();
          addCons(X1, 'num');
          addCons(X2, 'num');
          addCons(Xr, 'num');
          if (lhs.type === 'Identifier') {
            const xVar = envGet(env, lhs.name, scope);
            addCons(Xr, xVar);
          }
        }
        return;
      }

      // Fallback for other LHS shapes
      inferExpr(rhs, env, scope);
      break;
    }

    // ── i++  /  --i  ─────────────────────────────────────────────────────
    case 'UpdateExpression': {
      const Xa = inferExpr(node.argument, env, scope);
      addCons(Xa, 'num');
      break;
    }

    // ── Anything else (call expressions, etc.) ────────────────────────────
    default:
      inferExpr(node, env, scope);
      break;
  }
}






































// ── Entry point ───────────────────────────────────────────────────────────────
const filePath = process.argv[2];

if (!filePath) {
  console.error('Usage: node infer.js <source-file.js>');
  process.exit(1);
}

let src;
try {
  src = fs.readFileSync(filePath, 'utf8');
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
inferStmt(ast, new Map(), 'global');

// ── Output ────────────────────────────────────────────────────────────────────
const SEP = '─'.repeat(60);
console.log(`\nType Inference Constraints`);
console.log(`File : ${path.resolve(filePath)}`);
console.log(SEP);

if (constraints.length === 0) {
  console.log('  (no constraints generated)');
} else {
  const pad = String(constraints.length).length;
  constraints.forEach((c, i) =>
    console.log(`  C${String(i + 1).padStart(pad, '0')}: ${c}`)
  );
}

console.log(SEP);
console.log(`Total: ${constraints.length} constraint(s)\n`);
