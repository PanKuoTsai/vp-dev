'use strict';
// Function symbols of an ELF64 little-endian file (a vmlinux, a bare-metal
// image), for turning program counters into function names. Reads only the
// section headers, .symtab and .strtab, so a 300 MB vmlinux is quick.
// No VS Code dependency.

const fs = require('fs');

const STT_FUNC = 2;
const SHT_SYMTAB = 2;

/**
 * { functions: [{name, start (BigInt), size (BigInt)}] sorted by start,
 *   find(name) -> BigInt address of any symbol (functions and data), or undefined }.
 * Throws Error when the file is not an ELF64 little-endian file or has no symbol table.
 */
function readSymbols(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const read = (pos, len) => {
      const b = Buffer.alloc(len);
      const n = fs.readSync(fd, b, 0, len, pos);
      if (n !== len) throw new Error(`${file}: truncated`);
      return b;
    };
    if (fs.fstatSync(fd).size < 64) throw new Error(`${file} is not an ELF file`);
    const eh = read(0, 64);
    if (eh.readUInt32BE(0) !== 0x7f454c46) throw new Error(`${file} is not an ELF file`);
    if (eh[4] !== 2 || eh[5] !== 1) throw new Error(`${file} is not a 64-bit little-endian ELF file`);
    const shoff = Number(eh.readBigUInt64LE(0x28));
    const shentsize = eh.readUInt16LE(0x3a);
    const shnum = eh.readUInt16LE(0x3c);
    const sh = read(shoff, shentsize * shnum);
    const sec = (i) => ({
      type: sh.readUInt32LE(i * shentsize + 4),
      offset: Number(sh.readBigUInt64LE(i * shentsize + 0x18)),
      size: Number(sh.readBigUInt64LE(i * shentsize + 0x20)),
      link: sh.readUInt32LE(i * shentsize + 0x28),
      entsize: Number(sh.readBigUInt64LE(i * shentsize + 0x38)),
    });
    let symtab;
    for (let i = 0; i < shnum; i++) {
      const s = sec(i);
      if (s.type === SHT_SYMTAB) { symtab = s; break; }
    }
    if (!symtab) throw new Error(`${file} has no symbol table (stripped?)`);
    const strtab = sec(symtab.link);
    const syms = read(symtab.offset, symtab.size);
    const strs = read(strtab.offset, strtab.size);
    const nameAt = (o) => strs.toString('latin1', o, strs.indexOf(0, o));
    const functions = [];
    const all = new Map();
    const ent = symtab.entsize || 24;
    for (let off = 0; off + ent <= syms.length; off += ent) {
      const nameOff = syms.readUInt32LE(off);
      if (!nameOff) continue;
      const info = syms[off + 4];
      const shndx = syms.readUInt16LE(off + 6);
      const value = syms.readBigUInt64LE(off + 8);
      const size = syms.readBigUInt64LE(off + 16);
      if (shndx === 0) continue; // undefined
      const name = nameAt(nameOff);
      if (!all.has(name)) all.set(name, value);
      if ((info & 0xf) === STT_FUNC && value) functions.push({ name, start: value, size });
    }
    functions.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
    return { functions, find: (name) => all.get(name) };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The function containing addr (BigInt), or undefined. A symbol without a size
 * covers up to the next symbol, at most 64 KiB.
 */
function lookup(functions, addr) {
  let lo = 0;
  let hi = functions.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (functions[mid].start <= addr) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (best < 0) return undefined;
  const f = functions[best];
  const end = f.size ? f.start + f.size : best + 1 < functions.length ? functions[best + 1].start : f.start + 0x10000n;
  const limit = f.size ? end : (end - f.start > 0x10000n ? f.start + 0x10000n : end);
  return addr < limit ? f : undefined;
}

/**
 * The ELF type and the address of .text of an ELF64 little-endian file:
 * { type: 'exec' | 'dyn' | 'rel' | 'other', text (BigInt, or undefined) }.
 * An 'exec' file (linked at a fixed address, not position independent) runs
 * at its own addresses, so its .text address is where its symbols belong.
 * Throws Error when the file is not an ELF64 little-endian file.
 */
function elfInfo(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const read = (pos, len) => {
      const b = Buffer.alloc(len);
      if (fs.readSync(fd, b, 0, len, pos) !== len) throw new Error(`${file}: truncated`);
      return b;
    };
    if (fs.fstatSync(fd).size < 64) throw new Error(`${file} is not an ELF file`);
    const eh = read(0, 64);
    if (eh.readUInt32BE(0) !== 0x7f454c46) throw new Error(`${file} is not an ELF file`);
    if (eh[4] !== 2 || eh[5] !== 1) throw new Error(`${file} is not a 64-bit little-endian ELF file`);
    const type = { 1: 'rel', 2: 'exec', 3: 'dyn' }[eh.readUInt16LE(0x10)] || 'other';
    const shoff = Number(eh.readBigUInt64LE(0x28));
    const shentsize = eh.readUInt16LE(0x3a);
    const shnum = eh.readUInt16LE(0x3c);
    const shstrndx = eh.readUInt16LE(0x3e);
    if (!shoff || !shnum || shstrndx >= shnum) return { type, text: undefined };
    const sh = read(shoff, shentsize * shnum);
    const strOff = Number(sh.readBigUInt64LE(shstrndx * shentsize + 0x18));
    const strSize = Number(sh.readBigUInt64LE(shstrndx * shentsize + 0x20));
    const names = read(strOff, strSize);
    for (let i = 0; i < shnum; i++) {
      const nameAt = sh.readUInt32LE(i * shentsize);
      const end = names.indexOf(0, nameAt);
      if (names.toString('latin1', nameAt, end < 0 ? undefined : end) === '.text') {
        return { type, text: sh.readBigUInt64LE(i * shentsize + 0x10) };
      }
    }
    return { type, text: undefined };
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { readSymbols, lookup, elfInfo };
