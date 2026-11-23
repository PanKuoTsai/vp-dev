'use strict';
// Peripheral registers: the descriptions VP Studio ships (registers/*.json)
// and those of modeling-wizard models (*.model.json), which peripherals of a
// platform they describe, and how register and field values are read from and
// written as the bytes the sim agent's mem.read / mem.write use. No VS Code
// dependency.
//
// A description: { registersVersion: 1, title?, types: [module type...], port,
// registers: [Register], fieldSets?: {name: [Field]} }. A Register follows the
// model schema (name, offset, size 1|2|4|8 = 4, access rw|ro|wo|w1c = rw,
// description, fields [{name, bits "msb:lsb", description}]) plus:
//   readSideEffect: true   reading changes the device (a FIFO pops): not read by itself
//   count, stride          an array: name0, name1, ... at offset + i * stride
//   fieldsLike             the fields of fieldSets[fieldsLike]

const fs = require('fs');
const path = require('path');
const trace = require('./trace');

const num = (v) => {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === 'string' && /^(0x[0-9a-f]+|\d+)$/i.test(v.trim())) return BigInt(v.trim());
  return undefined;
};
const SIZES = [1, 2, 4, 8];
const ACCESS = ['rw', 'ro', 'wo', 'w1c'];

/** "7:4" -> {msb: 7, lsb: 4}; "3" -> {msb: 3, lsb: 3}; undefined when malformed. */
function parseBits(bits) {
  const m = /^\s*(\d+)\s*(?::\s*(\d+)\s*)?$/.exec(String(bits));
  if (!m) return undefined;
  const msb = Number(m[1]);
  const lsb = m[2] === undefined ? msb : Number(m[2]);
  return msb >= lsb ? { msb, lsb } : undefined;
}

/**
 * A description to its flat list of registers:
 * [{name, offset (BigInt), size, access, description, readSideEffect, fields: [{name, msb, lsb, description}]}].
 * Throws Error naming the first problem.
 */
function expand(desc, where = 'description') {
  if (!desc || !Array.isArray(desc.registers)) throw new Error(`${where}: no "registers" array`);
  const out = [];
  const seen = new Set();
  for (const r of desc.registers) {
    const at = `${where}: register ${r && r.name}`;
    if (!r || typeof r.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(r.name)) throw new Error(`${where}: a register has no valid name`);
    const offset = num(r.offset);
    if (offset === undefined) throw new Error(`${at}: offset must be a number such as "0x10"`);
    const size = r.size === undefined ? 4 : r.size;
    if (!SIZES.includes(size)) throw new Error(`${at}: size must be 1, 2, 4 or 8`);
    const access = r.access || 'rw';
    if (!ACCESS.includes(access)) throw new Error(`${at}: access must be rw, ro, wo or w1c`);
    let fieldDefs = r.fields || [];
    if (r.fieldsLike !== undefined) {
      fieldDefs = desc.fieldSets && desc.fieldSets[r.fieldsLike];
      if (!Array.isArray(fieldDefs)) throw new Error(`${at}: no field set ${r.fieldsLike}`);
    }
    const fields = fieldDefs.map((f) => {
      const b = parseBits(f.bits);
      if (!b || b.msb >= size * 8) throw new Error(`${at}: field ${f.name} has bits "${f.bits}", outside the ${size * 8}-bit register`);
      return { name: f.name, msb: b.msb, lsb: b.lsb, description: f.description || '' };
    });
    const count = r.count === undefined ? 1 : r.count;
    if (!Number.isInteger(count) || count < 1 || count > 1024) throw new Error(`${at}: count must be 1 to 1024`);
    const stride = r.stride === undefined ? BigInt(size) : num(r.stride);
    if (stride === undefined) throw new Error(`${at}: stride must be a number`);
    for (let i = 0; i < count; i++) {
      const name = r.count === undefined ? r.name : `${r.name}${i}`;
      if (seen.has(name)) throw new Error(`${where}: two registers named ${name}`);
      seen.add(name);
      out.push({
        name, offset: offset + BigInt(i) * stride, size, access, description: r.description || '',
        readSideEffect: !!r.readSideEffect, fields,
      });
    }
  }
  return out.sort((a, b) => (a.offset < b.offset ? -1 : a.offset > b.offset ? 1 : 0));
}

/** The descriptions in these files: [{file, title, types, port, registers}]. Bad files are reported in problems. */
function loadFiles(files) {
  const descs = [];
  const problems = [];
  for (const file of files) {
    const f = path.basename(file);
    try {
      const d = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(d.types) || !d.types.length || typeof d.port !== 'string') throw new Error('needs "types" and "port"');
      descs.push({ file, title: d.title || f, types: d.types, port: d.port, registers: expand(d, f) });
    } catch (e) {
      problems.push(`${f}: ${e.message}`);
    }
  }
  return { descs, problems };
}

/** The descriptions in a folder (every *.json in it). */
function loadDir(dir) {
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); } catch (e) { return { descs: [], problems: [] }; }
  return loadFiles(files.map((f) => path.join(dir, f)));
}

/** A modeling-wizard model (its *.model.json) as a description of its target_socket. */
function fromModelSpec(spec, file) {
  return {
    file, title: spec.description || spec.name, types: [spec.name], port: 'target_socket',
    registers: expand({ registers: spec.registers || [] }, path.basename(file || spec.name)),
  };
}

/**
 * Peripherals of a platform that a description covers: bus-mapped ports
 * (not of replicated modules), first description of the type and port wins.
 * buses: the platform's routers, in the order the agent's bus_N sockets are bound.
 * Returns [{id, module, port, type, address (BigInt), size, bus, busIndex, title, registers}].
 */
function peripherals(doc, descs, buses) {
  const out = [];
  for (const p of trace.tracePoints(doc)) {
    if (p.address === null || p.address === undefined) continue;
    const d = descs.find((x) => x.types.includes(p.type) && x.port === p.port);
    if (!d) continue;
    const busIndex = buses.indexOf(p.bus);
    if (busIndex < 0) continue;
    out.push({
      id: p.id, module: p.module, port: p.port, type: p.type, address: BigInt(p.address), size: p.size,
      bus: p.bus, busIndex, title: d.title, registers: d.registers,
    });
  }
  return out;
}

/** Bytes as hex in memory order (mem.read's data) to a little-endian value. */
function fromBytes(hex) {
  let v = 0n;
  for (let i = hex.length - 2; i >= 0; i -= 2) v = (v << 8n) | BigInt(parseInt(hex.slice(i, i + 2), 16));
  return v;
}

/** A value to size bytes, little-endian, as hex in memory order (mem.write's data). */
function toBytes(value, size) {
  let v = BigInt(value);
  let hex = '';
  for (let i = 0; i < size; i++) {
    hex += (v & 0xffn).toString(16).padStart(2, '0');
    v >>= 8n;
  }
  return hex;
}

const fieldMask = (f) => ((1n << BigInt(f.msb - f.lsb + 1)) - 1n) << BigInt(f.lsb);
const fieldValue = (value, f) => (value & fieldMask(f)) >> BigInt(f.lsb);

/** A register value with its fields: {value, fields: [{name, msb, lsb, value}]}. */
function decode(reg, value) {
  return { value, fields: reg.fields.map((f) => Object.assign({}, f, { value: fieldValue(value, f) })) };
}

/** "0x0000_0030" for a 4-byte register (digits grouped by 4). */
function hexOf(value, size) {
  const digits = BigInt(value).toString(16).padStart(size * 2, '0');
  return '0x' + digits.replace(/\B(?=(.{4})+$)/g, '_');
}

/** Bits text of a field: "[7:4]" or "[3]". */
const bitsText = (f) => (f.msb === f.lsb ? `[${f.lsb}]` : `[${f.msb}:${f.lsb}]`);

/** Value typed for a register or a field: BigInt in range, or throws Error with a message for the input box. */
function parseValue(text, bits) {
  const t = String(text).trim().replace(/_/g, '');
  if (!/^(0x[0-9a-f]+|0b[01]+|\d+)$/i.test(t)) throw new Error('Enter a number: 0x30, 48 or 0b110000');
  const v = BigInt(t);
  const max = (1n << BigInt(bits)) - 1n;
  if (v > max) throw new Error(`Too large: ${bits} ${bits > 1 ? 'bits hold' : 'bit holds'} at most 0x${max.toString(16)}`);
  return v;
}

/** The register value after setting one field (read-modify-write). */
function withField(regValue, f, fieldVal) {
  return (BigInt(regValue) & ~fieldMask(f)) | ((BigInt(fieldVal) << BigInt(f.lsb)) & fieldMask(f));
}

/** Why a register is not read by itself, or '' when it is. */
function notReadReason(reg) {
  if (reg.access === 'wo') return 'write-only';
  if (reg.readSideEffect) return 'reading it changes the device';
  return '';
}

/** Fields whose value differs between two register values (both BigInt): [{name, now, was}]. */
function changedFields(reg, value, was) {
  if (value === undefined || was === undefined || value === was) return [];
  return reg.fields.filter((f) => fieldValue(value, f) !== fieldValue(was, f)).map((f) => ({ name: f.name, now: fieldValue(value, f), was: fieldValue(was, f) }));
}

/**
 * The register at a bus address, from peripherals(): {periph, reg} or
 * undefined. A register covers [address, address + size).
 */
function registerAt(periphs, address) {
  const a = BigInt(address);
  for (const p of periphs) {
    for (const r of p.registers) {
      const at = p.address + r.offset;
      if (a >= at && a < at + BigInt(r.size)) return { periph: p, reg: r };
    }
  }
  return undefined;
}

module.exports = { changedFields, registerAt, parseBits, expand, loadFiles, loadDir, fromModelSpec, peripherals, fromBytes, toBytes, decode, hexOf, bitsText, parseValue, withField, notReadReason, fieldValue };
