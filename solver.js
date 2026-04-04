#!/usr/bin/env node
'use strict';

/**
 * Solver passo-a-passo.
 *
 * Literais concretos: str, num, bool, {}, {field: T}
 *   → são TIPOS, não type variables. Nunca entram no union-find.
 *   → X <= str  significa "X tem tipo str", não "X e str são a mesma var".
 *
 * Type variables: tudo o resto (a__global, T1, T2, b__global, …)
 *   → entram no union-find.
 *   → X <= Y une as duas classes.
 */

// ── Reconhecimento de nós ─────────────────────────────────────────────────────
const BASE_TYPES = new Set(['str', 'num', 'bool']);
const isBaseType    = t => BASE_TYPES.has(t);
const isEmptyObj    = t => t === '{}';
const isObjWithFlds = t => t.startsWith('{') && t !== '{}';
const isLiteral     = t => isBaseType(t) || isEmptyObj(t) || isObjWithFlds(t);
const isTypeVar     = t => !isLiteral(t);

function parseFields(t) {
  // "{foo: T1, bar: T2}" → Map { foo→T1, bar→T2 }
  const inner = t.slice(1, -1).trim();
  if (!inner) return new Map();
  const fields = new Map();
  let depth = 0, start = 0;
  for (let i = 0; i <= inner.length; i++) {
    const ch = inner[i];
    if      (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if ((ch === ',' || i === inner.length) && depth === 0) {
      const part = inner.slice(start, i).trim();
      if (part) {
        const colon = part.indexOf(':');
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
    this.parent   = new Map();  // typeVar → parent (union-find)
    this.rank     = new Map();
    this.baseType = new Map();  // rep → 'str'|'num'|'bool'
    this.isObj    = new Map();  // rep → true se for objeto
    this.objShape = new Map();  // rep → Map<field, Set<typeVar>>
    this.errors   = [];

    // Display
    this.displayList    = [];       // nós em ordem de aparição
    this.seenNodes      = new Set();
    this.seenBaseLits   = new Set(); // dedup de str/num/bool/{} no display
    this.consumedNodes  = new Set(); // removidos do display
  }

  // ── Registo de nós (para display inicial) ──────────────────────────────────
  _reg(node) {
    const isBaseLit = isBaseType(node) || isEmptyObj(node);
    if (isBaseLit) {
      // Mostra cada base literal uma só vez no display
      if (this.seenBaseLits.has(node)) return;
      this.seenBaseLits.add(node);
    }
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
    if (!this.parent.has(x)) { this.parent.set(x, x); this.rank.set(x, 0); }
    if (this.parent.get(x) !== x)
      this.parent.set(x, this.find(this.parent.get(x)));
    return this.parent.get(x);
  }

  _union(a, b) {
    const ra = this.find(a), rb = this.find(b);
    if (ra === rb) return;
    let root, child;
    if ((this.rank.get(ra) ?? 0) >= (this.rank.get(rb) ?? 0)) { root = ra; child = rb; }
    else                                                         { root = rb; child = ra; }
    if (this.rank.get(root) === this.rank.get(child))
      this.rank.set(root, (this.rank.get(root) ?? 0) + 1);
    this.parent.set(child, root);
    // Propaga tipo do child para o root
    const btc = this.baseType.get(child);
    if (btc) this._setBase(root, btc, `union(${a},${b})`);
    if (this.isObj.get(child)) {
      this._initObj(root);
      const sc = this.objShape.get(child) ?? new Map();
      const sr = this.objShape.get(root);
      for (const [f, tvs] of sc) {
        if (!sr.has(f)) sr.set(f, new Set());
        for (const tv of tvs) sr.get(f).add(tv);
      }
    }
  }

  // ── Aplicação de tipos concretos ───────────────────────────────────────────
  _setBase(rx, type, ctx) {
    const cur = this.baseType.get(rx);
    if (cur && cur !== type)
      this.errors.push(`CONFLICT: ${cur} vs ${type}  (${ctx})`);
    else if (!cur) {
      if (this.isObj.get(rx))
        this.errors.push(`CONFLICT: obj vs ${type}  (${ctx})`);
      else
        this.baseType.set(rx, type);
    }
  }

  _initObj(rx) {
    if (this.baseType.has(rx)) {
      this.errors.push(`CONFLICT: ${this.baseType.get(rx)} vs obj`);
      return;
    }
    this.isObj.set(rx, true);
    if (!this.objShape.has(rx)) this.objShape.set(rx, new Map());
  }

  // ── Processa uma constraint ────────────────────────────────────────────────
  process(lhs, rhs) {
    if (isBaseType(rhs)) {
      // X <= str / num / bool
      this._setBase(this.find(lhs), rhs, `${lhs} <= ${rhs}`);
      // Consome do display (só na primeira vez)
      this.consumedNodes.add(rhs);

    } else if (isEmptyObj(rhs)) {
      // X <= {}  →  X torna-se objeto vazio (independente de outros X <= {})
      this._initObj(this.find(lhs));
      this.consumedNodes.add(rhs);

    } else if (isObjWithFlds(rhs)) {
      // X <= {field: T}
      const rx = this.find(lhs);
      this._initObj(rx);
      if (!this.errors.length || !this.baseType.has(rx)) {
        const shape = this.objShape.get(rx) ?? new Map();
        for (const [f, tv] of parseFields(rhs)) {
          if (!shape.has(f)) shape.set(f, new Set());
          shape.get(f).add(tv);
        }
        this.objShape.set(rx, shape);
      }
      this.consumedNodes.add(rhs);

    } else {
      // X <= Y  (ambos type vars)
      this._union(lhs, rhs);
    }
  }

  // ── Tipo imediato (com type vars por resolver) ─────────────────────────────
  immediateType(rep) {
    const bt = this.baseType.get(rep);
    if (bt) return bt;
    if (this.isObj.get(rep)) {
      const shape = this.objShape.get(rep) ?? new Map();
      if (shape.size === 0) return '{}';
      const inner = [...shape.entries()]
        .map(([f, tvs]) => `${f}: ${[...tvs].join('|')}`)
        .join(', ');
      return `{${inner}}`;
    }
    return null; // bot
  }

  // ── Tipo final (resolve type vars transitivamente) ─────────────────────────
  resolveType(rep, visited = new Set()) {
    if (visited.has(rep)) return rep;
    visited.add(rep);
    const bt = this.baseType.get(rep);
    if (bt) return bt;
    if (this.isObj.get(rep)) {
      const shape = this.objShape.get(rep) ?? new Map();
      if (shape.size === 0) return '{}';
      const inner = [...shape.entries()].map(([f, tvs]) => {
        const resolved = [...new Set(
          [...tvs].map(tv => this.resolveType(this.find(tv), new Set(visited)))
        )];
        return `${f}: ${resolved.join('|')}`;
      }).join(', ');
      return `{${inner}}`;
    }
    return 'bot';
  }

  // ── Display ────────────────────────────────────────────────────────────────
  displayState() {
    const parts    = [];
    const shownRep = new Set();

    for (const node of this.displayList) {
      if (this.consumedNodes.has(node)) continue;

      if (isLiteral(node)) {
        // Nó literal ainda não consumido
        parts.push(`${node}:bot`);
        continue;
      }

      // Type variable
      const rep = this.find(node);
      if (shownRep.has(rep)) continue;
      shownRep.add(rep);

      const type = this.immediateType(rep);
      if (!type) {
        parts.push(`${node}:bot`);
      } else if (type === '{}') {
        parts.push(`${node}:{}`);
      } else if (isBaseType(type)) {
        parts.push(`${node}:${type}`);
      } else {
        parts.push(`(${node}: ${type})`);
      }
    }
    return parts.join(', ');
  }
}

// ── Parsing ───────────────────────────────────────────────────────────────────
function parseConstraint(line) {
  const clean = line.replace(/^\s*C\d+:\s*/, '').trim();
  const idx   = clean.indexOf(' <= ');
  if (idx === -1) return null;
  return { lhs: clean.slice(0, idx).trim(), rhs: clean.slice(idx + 4).trim() };
}

// ── Main ──────────────────────────────────────────────────────────────────────
function solve(input) {
  const parsed = [];
  for (const line of input.split('\n')) {
    if (!line.includes(' <= ')) continue;
    const c = parseConstraint(line);
    if (c) parsed.push(c);
  }
  if (!parsed.length) { console.log('(sem constraints)'); return; }

  const SEP = '─'.repeat(54);
  const st  = new State();

  // Regista todos os nós para o display inicial
  for (const c of parsed) st.regConstraint(c.lhs, c.rhs);

  console.log('\nConstraints:');
  const pad = String(parsed.length).length;
  parsed.forEach((c, i) =>
    console.log(`  C${String(i+1).padStart(pad,'0')}: ${c.lhs} <= ${c.rhs}`)
  );

  console.log('\n' + SEP);
  console.log('Inicio:');
  console.log(' ' + st.displayState());

  for (let i = 0; i < parsed.length; i++) {
    const { lhs, rhs } = parsed[i];
    st.process(lhs, rhs);
    console.log(`\n${i + 1}: [${lhs} <= ${rhs}]`);
    console.log(' ' + st.displayState());
  }

  console.log('\n' + SEP);
  if (st.errors.length) {
    console.log('⚠  ERROS DE TIPO:');
    st.errors.forEach(e => console.log('   ' + e));
  } else {
    console.log('✓  Sem conflitos.');
  }

  console.log('\nFINAL:');
  const progVars = [...st.seenNodes].filter(k => k.includes('__')).sort();
  const maxLen = progVars.length ? Math.max(...progVars.map(v => v.length)) : 0;
  for (const v of progVars)
    console.log(`  ${v.padEnd(maxLen)}  :  ${st.resolveType(st.find(v))}`);
  console.log();
}

const args = process.argv.slice(2);
if (args[0]) {
  solve(require('fs').readFileSync(args[0], 'utf8'));
} else if (!process.stdin.isTTY) {
  const chunks = [];
  process.stdin.on('data', d => chunks.push(d));
  process.stdin.on('end', () => solve(chunks.join('')));
}
