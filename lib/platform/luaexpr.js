'use strict';
// Evaluate the small Lua expressions platforms use for parameters, such as
// "(math.floor(i / 8) << 8) | (i % 8)" or 'ACCEL == "kvm" and "hvc" or "smc"'.
// Supports numbers, strings, true/false/nil, names looked up in an
// environment, math.floor/ceil/max/min/abs, arithmetic, bitwise operators,
// comparisons, and/or/not, with Lua's precedence and truthiness. Anything else
// (function calls, tables, field access) throws, so a caller can fall back.
// No VS Code dependency.

const MATH = {
  floor: Math.floor, ceil: Math.ceil, abs: Math.abs,
  max: (...a) => Math.max(...a), min: (...a) => Math.min(...a),
};

function tokenize(src) {
  const toks = [];
  const re = /\s*(?:(0[xX][0-9a-fA-F]+|\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|([A-Za-z_]\w*)|(\/\/|<<|>>|==|~=|<=|>=|\.\.|[-+*/%^&|~<>()#,.]))/y;
  let pos = 0;
  while (pos < src.length) {
    if (/^\s*$/.test(src.slice(pos))) break;
    re.lastIndex = pos;
    const m = re.exec(src);
    if (!m) throw new Error(`cannot read Lua at "${src.slice(pos).trim().slice(0, 20)}"`);
    pos = re.lastIndex;
    if (m[1] !== undefined) toks.push({ t: 'num', v: Number(m[1]) });
    else if (m[2] !== undefined) toks.push({ t: 'str', v: m[2].slice(1, -1).replace(/\\(.)/g, (_, c) => ({ n: '\n', t: '\t' }[c] || c)) });
    else if (m[3] !== undefined) toks.push({ t: ['and', 'or', 'not', 'true', 'false', 'nil'].includes(m[3]) ? m[3] : 'name', v: m[3] });
    else toks.push({ t: m[4] });
  }
  return toks;
}

const truthy = (v) => v !== false && v !== null && v !== undefined;
const int = (v, op) => {
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new Error(`${op} needs integers`);
  return BigInt(v);
};
const num = (v, op) => {
  if (typeof v !== 'number') throw new Error(`${op} needs numbers`);
  return v;
};

// Binary operators by precedence level, lowest first (Lua 5.4 manual §3.4.8).
const LEVELS = [
  ['or'], ['and'], ['<', '>', '<=', '>=', '~=', '=='], ['|'], ['~'], ['&'], ['<<', '>>'], ['..'], ['+', '-'], ['*', '/', '//', '%'],
];
const RIGHT = new Set(['..']);

function binop(op, a, b) {
  switch (op) {
  case '==': return a === b;
  case '~=': return a !== b;
  case '<': return num(a, op) < num(b, op);
  case '>': return num(a, op) > num(b, op);
  case '<=': return num(a, op) <= num(b, op);
  case '>=': return num(a, op) >= num(b, op);
  case '|': return Number(BigInt.asIntN(64, int(a, op) | int(b, op)));
  case '~': return Number(BigInt.asIntN(64, int(a, op) ^ int(b, op)));
  case '&': return Number(BigInt.asIntN(64, int(a, op) & int(b, op)));
  case '<<': return Number(BigInt.asIntN(64, int(a, op) << int(b, op)));
  case '>>': return Number(BigInt.asUintN(64, int(a, op)) >> int(b, op));
  case '..': return String(a) + String(b);
  case '+': return num(a, op) + num(b, op);
  case '-': return num(a, op) - num(b, op);
  case '*': return num(a, op) * num(b, op);
  case '/': return num(a, op) / num(b, op);
  case '//': return Math.floor(num(a, op) / num(b, op));
  case '%': { const x = num(a, op), y = num(b, op); return x - Math.floor(x / y) * y; }
  default: throw new Error(`operator ${op} is not supported`);
  }
}

/** Value of a Lua expression; env maps names to numbers, strings or booleans. Throws when it cannot. */
function evaluate(src, env = {}) {
  const toks = tokenize(String(src));
  let i = 0;
  const peek = () => toks[i] || { t: 'eof' };
  const expect = (t) => { if (peek().t !== t) throw new Error(`expected ${t} in Lua expression`); return toks[i++]; };

  function level(n) {
    if (n === LEVELS.length) return unary();
    let left = level(n + 1);
    while (LEVELS[n].includes(peek().t)) {
      const op = toks[i++].t;
      if (op === 'and' || op === 'or') {
        const right = level(n + 1);
        left = op === 'and' ? (truthy(left) ? right : left) : (truthy(left) ? left : right);
      } else {
        const right = RIGHT.has(op) ? level(n) : level(n + 1);
        left = binop(op, left, right);
      }
    }
    return left;
  }
  function unary() {
    const t = peek().t;
    if (t === 'not') { i++; return !truthy(unary()); }
    if (t === '-') { i++; return -num(unary(), '-'); }
    if (t === '~') { i++; return Number(BigInt.asIntN(64, ~int(unary(), '~'))); }
    return power();
  }
  function power() {
    const base = primary();
    if (peek().t === '^') { i++; return Math.pow(num(base, '^'), num(unary(), '^')); }
    return base;
  }
  function primary() {
    const tk = toks[i++] || { t: 'eof' };
    switch (tk.t) {
    case 'num': case 'str': return tk.v;
    case 'true': return true;
    case 'false': return false;
    case 'nil': return null;
    case '(': { const v = level(0); expect(')'); return v; }
    case 'name': {
      if (tk.v === 'math' && peek().t === '.') {
        i++;
        const fn = expect('name').v;
        if (!MATH[fn]) throw new Error(`math.${fn} is not supported`);
        expect('(');
        const args = [level(0)];
        while (peek().t === ',') { i++; args.push(level(0)); }
        expect(')');
        return MATH[fn](...args.map((a) => num(a, `math.${fn}`)));
      }
      if (!Object.prototype.hasOwnProperty.call(env, tk.v)) throw new Error(`${tk.v} is not known here`);
      return env[tk.v];
    }
    default: throw new Error('incomplete Lua expression');
    }
  }
  const v = level(0);
  if (i < toks.length) throw new Error(`unexpected "${toks[i].v || toks[i].t}" in Lua expression`);
  return v;
}

module.exports = { evaluate };
