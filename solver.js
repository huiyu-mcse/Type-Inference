#!/usr/bin/env node
"use strict";

const BASE_TYPES = new Set(["str", "num", "bool", "void"]);
const isBaseType = (t) => BASE_TYPES.has(t);
const isEmptyObj = (t) => t === "{}";
const isObjWithFlds = (t) => t.startsWith("{") && t !== "{}";
const isArray = (t) => t.startsWith("Array<") && t.endsWith(">");
const parseArrayElem = (t) => t.slice(6, -1).trim();
const isFunc = (t) => t.startsWith("Func<");
const isLiteral = (t) =>
  isBaseType(t) || isEmptyObj(t) || isObjWithFlds(t) || isArray(t) || isFunc(t);
const isTypeVar = (t) => !isLiteral(t);

// Parse Func<name>{p1 -> p2 -> ... -> ret}  or  Func<name>{() -> ret}
function parseFunc(t) {
  const nameEnd = t.indexOf(">{");
  const name = t.slice(5, nameEnd); // after "Func<"
  const body = t.slice(nameEnd + 2, -1); // inside {}
  if (body.startsWith("()")) {
    const ret = body.slice(body.indexOf("->") + 2).trim();
    return { name, params: [], ret };
  }
  const parts = body.split(" -> ");
  return { name, params: parts.slice(0, -1), ret: parts[parts.length - 1] };
}

function parseFields(t) {
  const inner = t.slice(1, -1).trim();
  if (!inner) return new Map();
  const fields = new Map();
  let depth = 0,
    start = 0;
  for (let i = 0; i <= inner.length; i++) {
    const ch = inner[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if ((ch === "," || i === inner.length) && depth === 0) {
      const part = inner.slice(start, i).trim();
      if (part) {
        const colon = part.indexOf(":");
        fields.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim());
      }
      start = i + 1;
    }
  }
  return fields;
}

// ── Estado ────────────────────────────────────────────────────────────────────
class State {
  constructor() {
    this.parent = new Map(); // typeVar → parent
    this.rank = new Map();
    this.baseType = new Map(); // rep → 'str'|'num'|'bool'
    this.isObj = new Map(); // rep → true
    this.objShape = new Map(); // rep → Map<field, typeVar>  ← UMA var por campo
    this.isArr = new Map(); // rep → true
    this.arrElem = new Map(); // rep → typeVar for element type
    this.isFuncType = new Map(); // rep → true
    this.funcInfo = new Map(); // rep → { name, params: string[], ret: string }
    this.errors = [];

    this.displayList = []; // todos os nós em ordem de aparição
    this.seenNodes = new Set();
    this.consumedLits = new Set(); // literais já absorvidos
  }

  _reg(node) {
    if (!this.seenNodes.has(node)) {
      this.seenNodes.add(node);
      this.displayList.push(node);
    }
    if (isTypeVar(node) && !this.parent.has(node)) {
      this.parent.set(node, node);
      this.rank.set(node, 0);
    }
  }

  regConstraint(lhs, rhs) {
    this._reg(lhs);
    this._reg(rhs);
  }

  // ── Union-Find ─────────────────────────────────────────────────────────────
  find(x) {
    if (!this.parent.has(x)) {
      this.parent.set(x, x);
      this.rank.set(x, 0);
    }
    if (this.parent.get(x) !== x)
      this.parent.set(x, this.find(this.parent.get(x)));
    return this.parent.get(x);
  }

  // Returns true (and pushes an error) if ra and rb have concrete types that
  // cannot be merged.  Called before any structural mutation in union().
  _conflictCheck(ra, rb, a, b) {
    const kindOf = (rx) => {
      if (this.baseType.has(rx)) return this.baseType.get(rx);
      if (this.isObj.get(rx)) return "obj";
      if (this.isArr.get(rx)) return "arr";
      if (this.isFuncType.get(rx)) return "func";
      return null;
    };
    const ka = kindOf(ra), kb = kindOf(rb);
    if (!ka || !kb) return false; // at least one side still unknown
    if (ka === kb) return false;  // same kind — can be merged
    this.errors.push(`CONFLICT: ${ka} vs ${kb}  (union(${a},${b}))`);
    return true;
  }

  union(a, b) {
    const ra = this.find(a),
      rb = this.find(b);
    if (ra === rb) return;

    if (this._conflictCheck(ra, rb, a, b)) return;

    let root, child;
    if ((this.rank.get(ra) ?? 0) >= (this.rank.get(rb) ?? 0)) {
      root = ra;
      child = rb;
    } else {
      root = rb;
      child = ra;
    }
    if (this.rank.get(root) === this.rank.get(child))
      this.rank.set(root, (this.rank.get(root) ?? 0) + 1);

    this.parent.set(child, root);

    // Propaga base type do child para o root
    const btc = this.baseType.get(child);
    if (btc) this._setBase(root, btc, `union(${a},${b})`);

    // Propaga objShape do child para o root
    if (this.isObj.get(child)) {
      const rootWasObj = this.isObj.get(root);
      this._initObj(root);
      const sc = this.objShape.get(child) ?? new Map();
      const sr = this.objShape.get(root);

      if (rootWasObj) {
        // Both were already objects → intersection: keep only common fields
        for (const [f, tv] of sc) {
          if (sr.has(f)) {
            this.union(sr.get(f), tv);
          }
        }
        for (const f of sr.keys()) {
          if (!sc.has(f)) sr.delete(f);
        }
      } else {
        // Root was a plain type var → copy all fields from child
        for (const [f, tv] of sc) {
          sr.set(f, tv);
        }
      }
    }

    // Propaga arrElem do child para o root
    if (this.isArr.get(child)) {
      const childElem = this.arrElem.get(child);
      if (this.isArr.get(root)) {
        this.union(this.arrElem.get(root), childElem);
      } else {
        this._initArr(root, childElem);
      }
    }

    // Propaga funcInfo do child para o root
    if (this.isFuncType.get(child)) {
      this._initFunc(root, this.funcInfo.get(child));
    }
  }

  // ── Tipos concretos ────────────────────────────────────────────────────────
  _setBase(rx, type, ctx) {
    const cur = this.baseType.get(rx);
    if (cur && cur !== type)
      this.errors.push(`CONFLICT: ${cur} vs ${type}  (${ctx})`);
    else if (!cur) {
      if (this.isObj.get(rx))
        this.errors.push(`CONFLICT: obj vs ${type}  (${ctx})`);
      else if (this.isArr.get(rx))
        this.errors.push(`CONFLICT: Array vs ${type}  (${ctx})`);
      else if (this.isFuncType.get(rx))
        this.errors.push(`CONFLICT: Func vs ${type}  (${ctx})`);
      else this.baseType.set(rx, type);
    }
  }

  _initObj(rx) {
    if (this.baseType.has(rx)) {
      this.errors.push(`CONFLICT: ${this.baseType.get(rx)} vs obj`);
      return;
    }
    if (this.isArr.get(rx)) {
      this.errors.push(`CONFLICT: Array vs obj`);
      return;
    }
    this.isObj.set(rx, true);
    if (!this.objShape.has(rx)) this.objShape.set(rx, new Map());
  }

  _initArr(rx, elemTV) {
    if (this.baseType.has(rx)) {
      this.errors.push(`CONFLICT: ${this.baseType.get(rx)} vs Array`);
      return;
    }
    if (this.isObj.get(rx)) {
      this.errors.push(`CONFLICT: obj vs Array`);
      return;
    }
    this.isArr.set(rx, true);
    if (this.arrElem.has(rx)) {
      this.union(this.arrElem.get(rx), elemTV);
    } else {
      this.arrElem.set(rx, elemTV);
    }
  }

  _initFunc(rx, info) {
    if (this.baseType.has(rx)) {
      this.errors.push(`CONFLICT: ${this.baseType.get(rx)} vs Func`);
      return;
    }
    if (this.isObj.get(rx)) {
      this.errors.push(`CONFLICT: obj vs Func`);
      return;
    }
    if (this.isArr.get(rx)) {
      this.errors.push(`CONFLICT: Array vs Func`);
      return;
    }
    if (this.isFuncType.get(rx)) {
      // Already a Func — unify params and ret pairwise
      const existing = this.funcInfo.get(rx);
      const n = Math.min(existing.params.length, info.params.length);
      for (let i = 0; i < n; i++) this.union(existing.params[i], info.params[i]);
      this.union(existing.ret, info.ret);
      return;
    }
    this.isFuncType.set(rx, true);
    this.funcInfo.set(rx, info);
  }

  // ── Processa uma constraint ────────────────────────────────────────────────
  process(lhs, rhs) {
    // case if base type literal appears at the left
    if (isBaseType(lhs)) {
      if (isTypeVar(rhs)) {
        this._setBase(this.find(rhs), lhs, `${lhs} <= ${rhs}`);
      }
      return;
    }

    if (isBaseType(rhs)) {
      this._setBase(this.find(lhs), rhs, `${lhs} <= ${rhs}`);
      this.consumedLits.add(rhs);
    } else if (isEmptyObj(rhs)) {
      this._initObj(this.find(lhs));
      this.consumedLits.add(rhs);
    } else if (isArray(rhs)) {
      const rx = this.find(lhs);
      const elemTV = parseArrayElem(rhs);
      this._initArr(rx, elemTV);
      this.consumedLits.add(rhs);
    } else if (isObjWithFlds(rhs)) {
      const rx = this.find(lhs);
      this._initObj(rx);
      const shape = this.objShape.get(rx) ?? new Map();
      for (const [f, tv] of parseFields(rhs)) {
        if (shape.has(f)) {
          this.union(shape.get(f), tv);
        } else {
          shape.set(f, tv);
        }
        this.objShape.set(rx, shape);
      }
      this.consumedLits.add(rhs);
    } else if (isFunc(rhs)) {
      this._initFunc(this.find(lhs), parseFunc(rhs));
      this.consumedLits.add(rhs);
    } else {
      // lhs <= rhs  (ambos type vars) → union
      this.union(lhs, rhs);
    }
  }

  // ── Tipo imediato de um nó (sem resolver recursivamente) ──────────────────
  immediateType(node) {
    const rep = this.find(node);
    const bt = this.baseType.get(rep);
    if (bt) return bt;
    if (this.isArr.get(rep)) {
      const elem = this.arrElem.get(rep);
      return `Array<${this.find(elem)}>`;
    }
    if (this.isObj.get(rep)) {
      const shape = this.objShape.get(rep) ?? new Map();
      if (shape.size === 0) return "{}";
      const inner = [...shape.entries()]
        .map(([f, tv]) => `${f}: ${this.find(tv)}`)
        .join(", ");
      return `{${inner}}`;
    }
    if (this.isFuncType.get(rep)) {
      const { name, params, ret } = this.funcInfo.get(rep);
      const parts = [...params.map((p) => this.find(p)), this.find(ret)];
      return params.length === 0
        ? `Func<${name}>{() -> ${this.find(ret)}}`
        : `Func<${name}>{${parts.join(" -> ")}}`;
    }
    return null; // bot
  }

  // ── Tipo final resolvido ───────────────────────────────────────────────────
  resolveType(node, visited = new Set()) {
    const rep = this.find(node);
    if (visited.has(rep)) return rep;
    visited.add(rep);
    const bt = this.baseType.get(rep);
    if (bt) return bt;
    if (this.isArr.get(rep)) {
      const elem = this.arrElem.get(rep);
      return `Array<${this.resolveType(elem, new Set(visited))}>`;
    }
    if (this.isObj.get(rep)) {
      const shape = this.objShape.get(rep) ?? new Map();
      if (shape.size === 0) return "{}";
      const inner = [...shape.entries()]
        .map(([f, tv]) => `${f}: ${this.resolveType(tv, new Set(visited))}`)
        .join(", ");
      return `{${inner}}`;
    }
    if (this.isFuncType.get(rep)) {
      const { name, params, ret } = this.funcInfo.get(rep);
      const resolvedRet = this.resolveType(ret, new Set(visited));
      if (params.length === 0) return `Func<${name}>{() -> ${resolvedRet}}`;
      const resolvedParams = params.map((p) =>
        this.resolveType(p, new Set(visited)),
      );
      return `Func<${name}>{${[...resolvedParams, resolvedRet].join(" -> ")}}`;
    }
    return "bot";
  }

  // ── Display ────────────────────────────────────────────────────────────────
  // Mostra TODOS os nós registados (não só o representante de cada classe).
  // Literais já consumidos são omitidos.
  // Type vars com mesmo representante mostram o mesmo tipo mas ambas aparecem.
  displayState() {
    const parts = [];

    for (const node of this.displayList) {
      // Omite literais já absorvidos
      if (this.consumedLits.has(node)) continue;
      // Omite literais ainda pendentes (str, num, {}, {f:T}) que estejam no display
      if (isLiteral(node)) {
        parts.push(`${node}:bot`);
        continue;
      }

      const type = this.immediateType(node);
      if (!type) {
        parts.push(`${node}:bot`);
      } else if (type === "{}") {
        parts.push(`${node}:{}`);
      } else if (isBaseType(type)) {
        parts.push(`${node}:${type}`);
      } else {
        parts.push(`(${node}: ${type})`);
      }
    }
    return parts.join(", ");
  }
}

// ── Parsing ───────────────────────────────────────────────────────────────────
function parseConstraint(line) {
  const clean = line.replace(/^\s*C\d+:\s*/, "").trim();
  const idx = clean.indexOf(" <= ");
  if (idx === -1) return null;
  return { lhs: clean.slice(0, idx).trim(), rhs: clean.slice(idx + 4).trim() };
}

// ── Main ──────────────────────────────────────────────────────────────────────
function solve(input, quiet = false) {
  const parsed = [];
  for (const line of input.split("\n")) {
    if (!line.includes(" <= ")) continue;
    const c = parseConstraint(line);
    if (c) parsed.push(c);
  }
  if (!parsed.length) {
    console.log("(sem constraints)");
    return;
  }

  const SEP = "─".repeat(54);
  const st = new State();

  for (const c of parsed) st.regConstraint(c.lhs, c.rhs);

  if (!quiet) {
    console.log("\nConstraints:");
    const pad = String(parsed.length).length;
    parsed.forEach((c, i) =>
      console.log(
        `  C${String(i + 1).padStart(pad, "0")}: ${c.lhs} <= ${c.rhs}`,
      ),
    );

    console.log("\n" + SEP);
    console.log("Inicio:");
    console.log(" " + st.displayState());

    for (let i = 0; i < parsed.length; i++) {
      const { lhs, rhs } = parsed[i];
      st.process(lhs, rhs);
      console.log(`\n${i + 1}: [${lhs} <= ${rhs}]`);
      console.log(" " + st.displayState());
    }
  } else {
    for (const { lhs, rhs } of parsed) st.process(lhs, rhs);
  }

  console.log("\n" + SEP);
  if (st.errors.length) {
    console.log("⚠  ERROS DE TIPO:");
    st.errors.forEach((e) => console.log("   " + e));
  } else {
    console.log("✓  Sem conflitos.");
  }

  console.log("\nFINAL:");
  const progVars = [...st.seenNodes]
    .filter((k) => k.includes("__") && !isLiteral(k))
    .sort();
  const maxLen = progVars.length
    ? Math.max(...progVars.map((v) => v.length))
    : 0;
  for (const v of progVars)
    console.log(`  ${v.padEnd(maxLen)}  :  ${st.resolveType(v)}`);
  console.log();
}

const args = process.argv.slice(2);
const quiet = args.includes("-q") || args.includes("--quiet");
const fileArg = args.find((a) => !a.startsWith("-"));

if (fileArg) {
  solve(require("fs").readFileSync(fileArg, "utf8"), quiet);
} else if (!process.stdin.isTTY) {
  const chunks = [];
  process.stdin.on("data", (d) => chunks.push(d));
  process.stdin.on("end", () => solve(chunks.join(""), quiet));
}
