'use strict';
// IP-XACT import (G-10): the register map of an IP-XACT component
// (SPIRIT 1.4/1.5, IEEE 1685-2009, -2014, -2022) to the registers of a
// modeling-wizard model (*.model.json) or of a register description
// (*.registers.json, the Peripheral Registers view).
//
// Read: component parameters, memoryMaps/memoryMap/addressBlock, register,
// registerFile (nested, with dim), field (bitOffset, bitWidth, access,
// modifiedWriteValue, readAction, resets). Values may be numbers in any
// IP-XACT form or simple expressions of parameters. Anything else (banks,
// subspace maps, 2022 type definitions, alternate registers) is skipped with
// a note. SystemRDL is not read: convert it with PeakRDL (peakrdl ip-xact).
// No VS Code dependency.

const xml = require('./xml');
const modelgen = require('./modelgen');

const { kids, kid, childText, attr, localName } = xml;
const MAX_REGISTERS = 4096;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const hex = (n) => '0x' + BigInt(n).toString(16);

// ---------------------------------------------------------------- values

/**
 * One IP-XACT number: 42, 0x2A, 'h2A, 8'h2A, 'b101, 'd42, 'o52, #2A (SPIRIT hex),
 * 4K / 1M / 2G / 1T (SPIRIT scaled integers), with _ separators. BigInt or undefined.
 */
function literal(s) {
  let t = String(s).trim().replace(/_/g, '');
  if (!t) return undefined;
  let m;
  if ((m = /^(\d+)?'[sS]?([hHbBdDoO])([0-9a-fA-FxXzZ?]+)$/.exec(t))) {
    if (/[xXzZ?]/.test(m[3])) return undefined;
    const base = { h: 16, b: 2, d: 10, o: 8 }[m[2].toLowerCase()];
    const digits = m[3];
    if (base === 16) return BigInt('0x' + digits);
    if (base === 2) return /^[01]+$/.test(digits) ? BigInt('0b' + digits) : undefined;
    if (base === 8) return /^[0-7]+$/.test(digits) ? BigInt('0o' + digits) : undefined;
    return /^\d+$/.test(digits) ? BigInt(digits) : undefined;
  }
  if ((m = /^#([0-9a-fA-F]+)$/.exec(t))) return BigInt('0x' + m[1]);
  if (/^0[xX][0-9a-fA-F]+$/.test(t)) return BigInt(t);
  if ((m = /^(\d+)([kKmMgGtT])?$/.exec(t))) {
    const scale = { k: 10n, m: 20n, g: 30n, t: 40n }[(m[2] || '').toLowerCase()];
    return scale ? BigInt(m[1]) << scale : BigInt(m[1]);
  }
  return undefined;
}

const OPS = [
  ['?'], ['||'], ['&&'], ['|'], ['^'], ['&'], ['==', '!='], ['<', '<=', '>', '>='], ['<<', '>>'], ['+', '-'], ['*', '/', '%'], ['**'],
];

/**
 * Evaluate an IP-XACT expression (SystemVerilog subset): literals, parameter
 * references, unary - ~ !, binary arithmetic, shifts, bitwise, comparisons,
 * logic, ?: and $clog2(). lookup(name) returns the BigInt of a parameter or
 * undefined. Returns a BigInt; throws Error for anything else.
 */
function evaluate(expr, lookup = () => undefined) {
  const src = String(expr);
  const toks = [];
  const re = /\s*(\d+'[sS]?[hHbBdDoO][0-9a-fA-F_]+|'[sS]?[hHbBdDoO][0-9a-fA-F_]+|0[xX][0-9a-fA-F_]+|#[0-9a-fA-F]+|\d[\d_]*[kKmMgGtT]?|\$?[A-Za-z_][A-Za-z0-9_]*|\*\*|<<|>>|<=|>=|==|!=|&&|\|\||[-+*/%&|^~!?:()<>])/y;
  let p = 0;
  while (p < src.length) {
    if (/^\s*$/.test(src.slice(p))) break;
    re.lastIndex = p;
    const m = re.exec(src);
    if (!m) throw new Error(`cannot read "${src.slice(p).trim()}" in ${src.trim()}`);
    toks.push(m[1]);
    p = re.lastIndex;
  }
  let i = 0;
  const peek = () => toks[i];
  const next = () => toks[i++];
  const expect = (t) => { if (next() !== t) throw new Error(`expected "${t}" in ${src.trim()}`); };
  const truth = (v) => (v !== 0n ? 1n : 0n);
  function primary() {
    const t = next();
    if (t === undefined) throw new Error(`incomplete expression ${src.trim()}`);
    if (t === '(') { const v = ternary(); expect(')'); return v; }
    if (t === '-') return -primary();
    if (t === '+') return primary();
    if (t === '~') return ~primary();
    if (t === '!') return primary() === 0n ? 1n : 0n;
    if (t === '$clog2') {
      expect('(');
      const v = ternary();
      expect(')');
      let n = 0n;
      while ((1n << n) < v) n++;
      return n;
    }
    const lit = literal(t);
    if (lit !== undefined) return lit;
    if (IDENT.test(t)) {
      const v = lookup(t);
      if (v === undefined) throw new Error(`unknown parameter ${t}`);
      return v;
    }
    throw new Error(`unexpected "${t}" in ${src.trim()}`);
  }
  function binary(level) {
    if (level >= OPS.length) return primary();
    if (OPS[level][0] === '?') return ternary();
    let v = binary(level + 1);
    while (OPS[level].includes(peek())) {
      const op = next();
      const r = binary(level + 1);
      switch (op) {
        case '||': v = truth(v) | truth(r); break;
        case '&&': v = truth(v) & truth(r); break;
        case '|': v |= r; break;
        case '^': v ^= r; break;
        case '&': v &= r; break;
        case '==': v = v === r ? 1n : 0n; break;
        case '!=': v = v !== r ? 1n : 0n; break;
        case '<': v = v < r ? 1n : 0n; break;
        case '<=': v = v <= r ? 1n : 0n; break;
        case '>': v = v > r ? 1n : 0n; break;
        case '>=': v = v >= r ? 1n : 0n; break;
        case '<<': v <<= r; break;
        case '>>': v >>= r; break;
        case '+': v += r; break;
        case '-': v -= r; break;
        case '*': v *= r; break;
        case '/': if (r === 0n) throw new Error(`division by zero in ${src.trim()}`); v /= r; break;
        case '%': if (r === 0n) throw new Error(`division by zero in ${src.trim()}`); v %= r; break;
        case '**': v **= r; break;
        default: break;
      }
    }
    return v;
  }
  function ternary() {
    const c = binary(1);
    if (peek() !== '?') return c;
    next();
    const a = ternary();
    expect(':');
    const b = ternary();
    return c !== 0n ? a : b;
  }
  const v = ternary();
  if (i < toks.length) throw new Error(`unexpected "${toks[i]}" in ${src.trim()}`);
  return v;
}

// ---------------------------------------------------------------- names

/** A C++ identifier for an IP-XACT name: invalid characters to _, never reserved. */
function identOf(name, fallback = 'r') {
  let s = String(name || '').trim().replace(/[^A-Za-z0-9_]/g, '_');
  if (!s) s = fallback;
  if (/^[0-9]/.test(s)) s = `${fallback}_${s}`;
  if (modelgen.RESERVED.has(s)) s += '_';
  return s;
}

const oneLine = (s) => (s === undefined ? '' : String(s).replace(/\s+/g, ' ').trim());

// ---------------------------------------------------------------- reading

const STANDARDS = [
  [/1685-2022/, 'IEEE 1685-2022'],
  [/1685-2014/, 'IEEE 1685-2014'],
  [/1685-2009/, 'IEEE 1685-2009'],
  [/SPIRIT\/1\.5/, 'SPIRIT 1.5'],
  [/SPIRIT\/1\.4/, 'SPIRIT 1.4'],
];

function standardOf(root) {
  const ns = Object.entries(root.attrs).filter(([k]) => k === 'xmlns' || k.startsWith('xmlns:')).map(([, v]) => v).join(' ');
  for (const [re, name] of STANDARDS) if (re.test(ns)) return name;
  return 'IP-XACT (unknown version)';
}

/** Component parameters: by parameterId and by name, values kept as text until used. */
function paramTable(component) {
  const table = new Map();
  const add = (keys, value) => { for (const k of keys) if (k && !table.has(k)) table.set(k, value); };
  const collect = (holder) => {
    for (const p of kids(kid(holder, 'parameters'), 'parameter')) {
      const valueEl = kid(p, 'value');
      const value = xml.textOf(valueEl);
      if (value === undefined) continue;
      add([attr(p, 'parameterId'), childText(p, 'name'), attr(valueEl, 'id')], value);
    }
  };
  collect(component);
  // SPIRIT 1.x / 2009 model parameters: <model><modelParameters><modelParameter spirit:id=..>
  for (const mp of kids(kid(kid(component, 'model'), 'modelParameters'), 'modelParameter')) {
    add([childText(mp, 'name'), attr(kid(mp, 'value'), 'id')], childText(mp, 'value'));
  }
  return { table, collect };
}

/**
 * Parse an IP-XACT document. Returns
 * { standard, vlnv: {vendor, library, name, version}, description,
 *   blocks: [{memoryMap, name, key, baseAddress (BigInt), range (BigInt), width, description,
 *             registers: [{name, offset (BigInt), size, access, reset (BigInt), description,
 *                          readSideEffect, fields: [{name, msb, lsb, description, access}]}],
 *             notes: [string]}],
 *   notes: [string] }.
 * Throws Error when the text is not XML or not an IP-XACT component.
 */
function parse(text) {
  const root = xml.parse(text);
  if (localName(root.name) !== 'component') {
    throw new Error(`Not an IP-XACT component: the root element is <${root.name}>${localName(root.name) === 'design' ? ' (a design; import the components it instantiates)' : ''}.`);
  }
  const standard = standardOf(root);
  const vlnv = {
    vendor: childText(root, 'vendor') || '', library: childText(root, 'library') || '',
    name: childText(root, 'name') || '', version: childText(root, 'version') || '',
  };
  const notes = [];
  const { table } = paramTable(root);
  const cache = new Map();
  const resolving = new Set();
  const lookup = (name) => {
    if (cache.has(name)) return cache.get(name);
    if (!table.has(name) || resolving.has(name)) return undefined;
    resolving.add(name);
    let v;
    try { v = evaluate(table.get(name), lookup); } catch (e) { v = undefined; }
    resolving.delete(name);
    cache.set(name, v);
    return v;
  };
  const value = (el, what, fallback) => {
    const t = xml.textOf(el);
    if (t === undefined || t === '') {
      if (fallback !== undefined) return fallback;
      throw new Error(`${what} is missing`);
    }
    try { return evaluate(t, lookup); } catch (e) { throw new Error(`${what}: ${e.message}`); }
  };

  const blocks = [];
  const maps = kids(kid(root, 'memoryMaps'), 'memoryMap');
  if (!maps.length) notes.push('The component has no memoryMaps.');
  for (const map of maps) {
    const mapName = childText(map, 'name') || 'memoryMap';
    if (kid(map, 'memoryMapDefinitionRef')) notes.push(`${mapName}: refers to a memoryMapDefinition (IP-XACT 2022 type definitions), which is not read.`);
    for (const b of kids(map, 'bank')) notes.push(`${mapName}: bank ${childText(b, 'name') || ''} is not read; flatten banks into address blocks.`);
    for (const s of kids(map, 'subspaceMap')) notes.push(`${mapName}: subspaceMap ${childText(s, 'name') || ''} is not read.`);
    for (const ab of kids(map, 'addressBlock')) {
      const name = childText(ab, 'name') || 'addressBlock';
      const block = { memoryMap: mapName, name, key: `${mapName}.${name}`, description: oneLine(childText(ab, 'description')), registers: [], notes: [] };
      try {
        block.baseAddress = value(kid(ab, 'baseAddress'), `${name}: baseAddress`, 0n);
        block.range = value(kid(ab, 'range'), `${name}: range`);
        block.width = Number(value(kid(ab, 'width'), `${name}: width`, 32n));
      } catch (e) {
        notes.push(`${mapName}.${name}: skipped, ${e.message}.`);
        continue;
      }
      if (kid(ab, 'addressBlockDefinitionRef')) block.notes.push('Refers to an addressBlockDefinition (IP-XACT 2022), which is not read.');
      const usage = childText(ab, 'usage');
      if (usage && usage !== 'register') block.notes.push(`usage is ${usage}: the block is memory, not registers.`);
      const ctx = { block, value, blockAccess: childText(ab, 'access') };
      readRegisters(ab, 0n, '', ctx);
      finishBlock(block);
      blocks.push(block);
    }
  }
  return { standard, vlnv, description: oneLine(childText(root, 'description')), blocks, notes };
}

/** dim values of an element: <dim> children (2009, 2014) or <array><dim> (2022); stride for 2022 arrays. */
function dimsOf(el, value, what) {
  const array = kid(el, 'array');
  const holder = array || el;
  const dims = kids(holder, 'dim').map((d) => Number(value(d, `${what}: dim`)));
  const strideEl = array && kid(array, 'stride');
  const stride = strideEl ? value(strideEl, `${what}: stride`) : undefined;
  return { dims, stride };
}

/** Every index tuple of dims: [[0,0], [0,1], ...]; [[]] for no dims. */
function indexTuples(dims) {
  let out = [[]];
  for (const d of dims) {
    const next = [];
    for (const t of out) for (let k = 0; k < d; k++) next.push(t.concat(k));
    out = next;
  }
  return out;
}

function readRegisters(holder, base, prefix, ctx) {
  const { block, value } = ctx;
  for (const el of holder.children) {
    if (typeof el === 'string') continue;
    const kind = localName(el.name);
    if (kind !== 'register' && kind !== 'registerFile') continue;
    const rawName = childText(el, 'name') || kind;
    const what = `${prefix}${rawName}`;
    try {
      if (kind === 'register' && kid(el, 'registerDefinitionRef')) {
        block.notes.push(`${what}: refers to a registerDefinition (IP-XACT 2022), which is not read; skipped.`);
        continue;
      }
      if (kid(el, 'alternateRegisters')) block.notes.push(`${what}: alternate registers are not read; only the main view is imported.`);
      const offset = value(kid(el, 'addressOffset'), `${what}: addressOffset`);
      const { dims, stride } = dimsOf(el, value, what);
      const tuples = indexTuples(dims);
      let step;
      if (kind === 'register') {
        const bits = Number(value(kid(el, 'size'), `${what}: size`));
        if (![8, 16, 32, 64].includes(bits)) {
          block.notes.push(`${what}: ${bits}-bit registers are not supported (8, 16, 32 or 64); skipped.`);
          continue;
        }
        step = stride !== undefined ? stride : BigInt(bits / 8);
        tuples.forEach((t, k) => {
          const name = identOf(prefix.replace(/\./g, '_') + rawName + t.map((x) => `_${x}`).join(''));
          if (block.registers.length >= MAX_REGISTERS) throw new Error(`more than ${MAX_REGISTERS} registers`);
          const reg = readRegister(el, name, base + offset + BigInt(k) * step, bits / 8, ctx, what);
          if (reg) block.registers.push(reg);
        });
      } else {
        const range = value(kid(el, 'range'), `${what}: range`);
        step = stride !== undefined ? stride : range;
        tuples.forEach((t, k) => {
          readRegisters(el, base + offset + BigInt(k) * step, `${prefix}${rawName}${t.map((x) => `_${x}`).join('')}.`, ctx);
        });
      }
    } catch (e) {
      block.notes.push(`${what}: skipped, ${e.message}.`);
    }
  }
}

const ACCESS_NAMES = ['read-write', 'read-only', 'write-only', 'read-writeOnce', 'writeOnce'];

function readRegister(el, name, offset, size, ctx, what) {
  const { block, value } = ctx;
  const regAccess = childText(el, 'access') || ctx.blockAccess || 'read-write';
  if (!ACCESS_NAMES.includes(regAccess)) block.notes.push(`${what}: access "${regAccess}" is not an IP-XACT access; read-write assumed.`);
  const width = size * 8;
  // Register-level reset (SPIRIT, 2009): <reset><value>..</value><mask>..</mask></reset>
  let reset = 0n;
  const regReset = kid(el, 'reset');
  if (regReset) reset = value(kid(regReset, 'value'), `${what}: reset value`, 0n);
  const fields = [];
  let fieldReset = 0n;
  let haveFieldReset = false;
  let readSideEffect = false;
  let used = 0n;
  for (const f of kids(el, 'field')) {
    const fname = identOf(childText(f, 'name'), 'f');
    const fw = `${what}.${childText(f, 'name') || fname}`;
    let lsb, bw;
    try {
      lsb = Number(value(kid(f, 'bitOffset'), `${fw}: bitOffset`));
      bw = Number(value(kid(f, 'bitWidth'), `${fw}: bitWidth`));
    } catch (e) {
      block.notes.push(`${e.message}; field skipped.`);
      continue;
    }
    const msb = lsb + bw - 1;
    if (bw < 1 || msb >= width) { block.notes.push(`${fw}: bits ${msb}:${lsb} are outside the ${width}-bit register; field skipped.`); continue; }
    const mask = ((1n << BigInt(bw)) - 1n) << BigInt(lsb);
    if (used & mask) { block.notes.push(`${fw}: overlaps another field; skipped.`); continue; }
    if (fields.some((x) => x.name === fname)) { block.notes.push(`${fw}: a second field named ${fname}; skipped.`); continue; }
    used |= mask;
    const access = childText(f, 'access') || regAccess;
    const mwv = childText(f, 'modifiedWriteValue');
    const readAction = childText(f, 'readAction');
    if (readAction) readSideEffect = true;
    // Field reset: 2014/2022 <resets><reset><value>; SPIRIT 1.x/2009 field <reset> is rare but allowed.
    const resetsEl = kid(f, 'resets');
    const resetEl = resetsEl ? (kids(resetsEl, 'reset').find((r) => !attr(r, 'resetTypeRef')) || kid(resetsEl, 'reset')) : kid(f, 'reset');
    if (resetEl) {
      const rv = value(kid(resetEl, 'value'), `${fw}: reset value`, 0n);
      fieldReset |= (rv << BigInt(lsb)) & mask;
      haveFieldReset = true;
    }
    fields.push({ name: fname, msb, lsb, description: oneLine(childText(f, 'description')), access, mwv, readAction });
  }
  if (haveFieldReset) reset = fieldReset;
  reset &= (1n << BigInt(width)) - 1n;
  return {
    name, offset, size, access: accessOf(regAccess, fields, block, what), reset,
    description: oneLine(childText(el, 'description') || childText(el, 'displayName')),
    readSideEffect, volatile: childText(el, 'volatile') === 'true',
    fields: fields.map(({ name: n, msb, lsb, description }) => ({ name: n, msb, lsb, description })),
  };
}

/**
 * The model's register-level access from IP-XACT register and field access:
 * all read-only -> ro, all write-only -> wo, every writable field one-to-clear -> w1c,
 * otherwise rw. A register mixing kinds is noted.
 */
function accessOf(regAccess, fields, block, what) {
  const kindOf = (access, mwv) => {
    if (access === 'read-only') return 'ro';
    if (access === 'write-only' || access === 'writeOnce') return 'wo';
    if (mwv === 'oneToClear') return 'w1c';
    return 'rw';
  };
  const kinds = fields.length ? fields.map((f) => kindOf(f.access, f.mwv)) : [kindOf(regAccess)];
  const set = new Set(kinds);
  if (set.size === 1) {
    const k = kinds[0];
    for (const f of fields) {
      if (f.mwv && !['oneToClear', 'modify'].includes(f.mwv)) block.notes.push(`${what}.${f.name}: modifiedWriteValue ${f.mwv} is imported as a plain write; add it in the write hook.`);
      if (f.access === 'read-writeOnce' || f.access === 'writeOnce') block.notes.push(`${what}.${f.name}: ${f.access} is imported as rw/wo; add the write-once rule in the write hook.`);
    }
    return k;
  }
  if (set.has('w1c') && [...set].every((k) => k === 'w1c' || k === 'ro')) {
    block.notes.push(`${what}: one-to-clear and read-only fields; imported as w1c (writes cannot set read-only bits, but writing 1 to them clears them: adjust the write hook if that matters).`);
    return 'w1c';
  }
  block.notes.push(`${what}: fields of different access (${[...set].join(', ')}); imported as rw. Use the write hook for the read-only and one-to-clear fields.`);
  return 'rw';
}

function finishBlock(block) {
  const regs = block.registers.sort((a, b) => (a.offset < b.offset ? -1 : a.offset > b.offset ? 1 : 0));
  const seen = new Map();
  for (const r of regs) {
    let n = r.name;
    for (let k = 2; seen.has(n); k++) n = `${r.name}_${k}`;
    if (n !== r.name) block.notes.push(`Two registers would be named ${r.name}; the one at ${hex(r.offset)} is ${n}.`);
    r.name = n;
    seen.set(n, r);
  }
  for (let i = 1; i < regs.length; i++) {
    const a = regs[i - 1], b = regs[i];
    if (a.offset + BigInt(a.size) > b.offset) block.notes.push(`${a.name} (${hex(a.offset)}) and ${b.name} (${hex(b.offset)}) overlap.`);
  }
  const last = regs[regs.length - 1];
  if (last && last.offset + BigInt(last.size) > block.range) block.notes.push(`${last.name} ends at ${hex(last.offset + BigInt(last.size))}, beyond the block's range ${hex(block.range)}.`);
  if (!regs.length) block.notes.push('No registers.');
}

// ---------------------------------------------------------------- output

const bitsText = (f) => (f.msb === f.lsb ? String(f.lsb) : `${f.msb}:${f.lsb}`);

/** Registers in *.model.json form (no readSideEffect: the schema does not allow it). */
function modelRegisters(block) {
  return block.registers.map((r) => {
    const o = { name: r.name, offset: hex(r.offset), size: r.size, access: r.access, reset: hex(r.reset) };
    let d = r.description;
    if (r.readSideEffect) d = (d ? d + ' ' : '') + '(Reading changes it: implement in the read hook.)';
    if (d) o.description = d;
    if (r.fields.length) {
      o.fields = r.fields.map((f) => {
        const x = { name: f.name, bits: bitsText(f) };
        if (f.description) x.description = f.description;
        return x;
      });
    }
    return o;
  });
}

/** A model name for a block: the component's name, or the block's. */
function modelNameFor(doc, block) {
  const base = doc.blocks.length > 1 && doc.vlnv.name ? `${doc.vlnv.name}_${block.name}` : (doc.vlnv.name || block.name);
  return identOf(base.toLowerCase(), 'm');
}

/**
 * A modeling-wizard model from a block. With existing (a model description),
 * its registers and regionSize are replaced and everything else is kept.
 * Returns { spec, problems } (modelgen.check of the result).
 */
function toModel(doc, block, { name, existing } = {}) {
  const src = `${[doc.vlnv.vendor, doc.vlnv.library, doc.vlnv.name, doc.vlnv.version].filter(Boolean).join(':')} ${block.key}`.trim();
  let spec;
  if (existing) {
    spec = Object.assign({}, existing, { regionSize: hex(block.range), registers: modelRegisters(block) });
  } else {
    spec = {
      modelVersion: 1,
      name: name || modelNameFor(doc, block),
      description: block.description || doc.description || `Imported from IP-XACT ${src}`,
      regionSize: hex(block.range),
      unmapped: 'ignore',
      registers: modelRegisters(block),
      params: [],
      outputs: [],
      inputs: [],
    };
  }
  return { spec, problems: modelgen.check(spec).problems, source: src };
}

/** A register description (registers form) of a module type's port from a block. */
function toDescription(doc, block, { types, port = 'target_socket', title } = {}) {
  return {
    registersVersion: 1,
    title: title || `${doc.vlnv.name || block.name} (IP-XACT ${block.key})`,
    types,
    port,
    registers: block.registers.map((r) => {
      const o = { name: r.name, offset: hex(r.offset), size: r.size, access: r.access };
      if (r.description) o.description = r.description;
      if (r.readSideEffect) o.readSideEffect = true;
      if (r.fields.length) {
        o.fields = r.fields.map((f) => {
          const x = { name: f.name, bits: bitsText(f) };
          if (f.description) x.description = f.description;
          return x;
        });
      }
      return o;
    }),
  };
}

/** One line per block for a picker: "regs (memoryMap) — 12 registers, 0x1000 bytes". */
function blockSummary(block) {
  return `${block.registers.length} register${block.registers.length === 1 ? '' : 's'}, ${hex(block.range)} bytes${block.notes.length ? `, ${block.notes.length} note${block.notes.length === 1 ? '' : 's'}` : ''}`;
}

module.exports = { literal, evaluate, identOf, parse, toModel, toDescription, modelRegisters, modelNameFor, blockSummary };
