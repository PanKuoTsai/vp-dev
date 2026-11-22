'use strict';
// CPU registers of the target, read from gdb (MI) through the debug session:
// which group a register belongs to, the AArch64 PSTATE decoded, and which
// values changed since the last stop. No VS Code dependency.

/**
 * general (x0..x30, sp, pc, cpsr), fp (v0..v31, SVE, fpsr, fpcr), system (the
 * rest QEMU describes), or alias: gdb's narrower views of other registers
 * (w0..w30 of x0..x30; q, d, s, h, b of v0..v31), which are not listed.
 */
function classify(name) {
  const n = String(name).toLowerCase();
  if (/^(w\d+|[qdshb]\d+)$/.test(n)) return 'alias';
  if (/^(x\d+|sp|pc|cpsr|fp|lr)$/.test(n)) return 'general';
  if (/^(v\d+|z\d+|p\d+|ffr|vg|fpsr|fpcr)$/.test(n)) return 'fp';
  return 'system';
}

const BIT = (v, n) => Number((v >> BigInt(n)) & 1n);

/**
 * AArch64 PSTATE as gdb shows it in cpsr: NZCV flags, DAIF masks, the
 * exception level and stack pointer (EL1h = EL1 using SP_EL1, EL1t = SP_EL0).
 * value: BigInt or a number string; null when it cannot be read.
 */
function decodePstate(value) {
  let v;
  try { v = typeof value === 'bigint' ? value : BigInt(String(value).trim()); } catch (e) { return null; }
  const aarch32 = BIT(v, 4) === 1;
  const el = Number((v >> 2n) & 3n);
  const sp = BIT(v, 0) ? 'h' : 't';
  return {
    n: BIT(v, 31), z: BIT(v, 30), c: BIT(v, 29), v: BIT(v, 28),
    d: BIT(v, 9), a: BIT(v, 8), i: BIT(v, 7), f: BIT(v, 6),
    aarch32, el, sp, mode: aarch32 ? `AArch32 mode 0x${(v & 0x1fn).toString(16)}` : `EL${el}${sp}`,
  };
}

/**
 * The registers from -data-list-register-names and -data-list-register-values,
 * in gdb's order: [{ name, value, group, changed }]. prev: Map(name -> value)
 * of the last stop of the same CPU (none: nothing is marked changed).
 */
function snapshot(namesResult, valuesResult, prev) {
  const names = (namesResult && namesResult['register-names']) || [];
  const out = [];
  for (const rv of (valuesResult && valuesResult['register-values']) || []) {
    const name = names[Number(rv.number)];
    if (!name || classify(name) === 'alias') continue;
    const value = compactValue(rv.value);
    out.push({ name, value, group: classify(name), changed: !!prev && prev.has(name) && prev.get(name) !== value });
  }
  return out;
}

/**
 * A register value short enough to read: gdb prints a SIMD register as a union
 * ({d = {...}, ..., q = {u = {0x...}, s = {...}}}); its 128-bit q.u is shown.
 * Other compound values are cut to 120 characters.
 */
function compactValue(value) {
  const v = String(value);
  if (!v.startsWith('{')) return v;
  const q = /q = \{u = \{(0x[0-9a-f]+|\d+)\}/i.exec(v);
  if (q) return q[1];
  return v.length > 120 ? v.slice(0, 119) + '…' : v;
}

/** MI command for the register values of one CPU (gdb thread), in hex. */
const valuesCommand = (thread) => `-data-list-register-values --thread ${Number(thread)} --frame 0 x`;

module.exports = { classify, decodePstate, snapshot, valuesCommand, compactValue };
