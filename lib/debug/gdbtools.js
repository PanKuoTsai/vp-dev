'use strict';
// Helpers for the gdb conveniences in the debug menu: searching memory for a
// pattern, the QEMU monitor presets, a type cast of an address, loading a
// symbol file at an address, and the CPU stepping modes.
// No VS Code dependency.

const MAX_SEARCH = { virtual: 256 * 1024 * 1024, physical: 64 * 1024 * 1024 };

/** "0x1000", "4096", "1M", "64k" -> BigInt; throws. */
function parseSize(text) {
  const s = String(text || '').trim();
  const m = /^(0x[0-9a-f]+|\d+)\s*([kmg]i?b?)?$/i.exec(s);
  if (!m) throw new Error('a size such as 0x100000, 4096 or 64k');
  const mul = { k: 1024n, m: 1024n ** 2n, g: 1024n ** 3n }[(m[2] || '').charAt(0).toLowerCase()] || 1n;
  return BigInt(m[1]) * mul;
}

/**
 * What to search for:
 *   "text"           the bytes of the text (UTF-8)
 *   hex: d0 0d fe ed  these bytes, in this order
 *   0xd00dfeed       a number as the target stores it: little-endian, as wide
 *                    as its digits (8, 16, 32 or 64 bits); add :be for big-endian
 * Returns { bytes: Buffer, text } (text: the bytes, for the user); throws.
 */
function parsePattern(input) {
  const s = String(input || '').trim();
  let bytes;
  const str = /^"(.*)"$/s.exec(s) || /^'(.*)'$/s.exec(s);
  if (str) bytes = Buffer.from(str[1], 'utf8');
  else if (/^hex:/i.test(s)) {
    const h = s.slice(4).replace(/[\s,]/g, '');
    if (!h || h.length % 2 || /[^0-9a-f]/i.test(h)) throw new Error('hex: needs pairs of hex digits, e.g. hex: d0 0d fe ed');
    bytes = Buffer.from(h, 'hex');
  } else {
    const m = /^(0x[0-9a-f]+|\d+)(?::(be|le))?$/i.exec(s);
    if (!m) throw new Error('"text", hex: d0 0d fe ed, or a number such as 0xd00dfeed');
    const v = BigInt(m[1]);
    const digits = /^0x/i.test(m[1]) ? m[1].length - 2 : v.toString(16).length;
    const width = digits <= 2 ? 1 : digits <= 4 ? 2 : digits <= 8 ? 4 : digits <= 16 ? 8 : 0;
    if (!width) throw new Error('a number of at most 64 bits');
    bytes = Buffer.alloc(width);
    for (let i = 0; i < width; i++) bytes[i] = Number((v >> BigInt(8 * i)) & 0xffn);
    if ((m[2] || '').toLowerCase() === 'be') bytes.reverse();
  }
  if (!bytes.length) throw new Error('an empty pattern');
  return { bytes, text: bytes.toString('hex').replace(/(..)(?!$)/g, '$1 ') };
}

/**
 * Search memory read in chunks: read(address BigInt, size) -> Promise<Buffer
 * | null> (null: unreadable). Chunks overlap by pattern length - 1, so a match
 * across two chunks is found. Returns { hits: BigInt[], unreadable: bytes,
 * truncated }; stops after `max` hits or when cancelled() is true.
 * @param {(address: bigint, size: number) => Promise<Buffer | null>} read
 * @param {bigint} start
 * @param {bigint} length
 * @param {Buffer} pattern
 * @param {{chunk?: number, max?: number, cancelled?: () => boolean, progress?: (done: number, total: number) => void}} [opts]
 */
async function search(read, start, length, pattern, opts = {}) {
  const { chunk = 65536, max = 200, cancelled = () => false, progress = () => {} } = opts;
  const hits = [];
  let unreadable = 0n;
  const p = pattern.length;
  const end = start + length;
  let prev = Buffer.alloc(0); // the last p - 1 bytes of the previous chunk
  for (let at = start; at < end; at += BigInt(chunk)) {
    if (cancelled()) break;
    const size = Number(end - at < BigInt(chunk) ? end - at : BigInt(chunk));
    const data = await read(at, size);
    progress(Number(at - start), Number(length));
    if (!data) { unreadable += BigInt(size); prev = Buffer.alloc(0); continue; }
    const buf = Buffer.concat([prev, data]);
    const base = at - BigInt(prev.length);
    for (let i = buf.indexOf(pattern); i >= 0; i = buf.indexOf(pattern, i + 1)) {
      hits.push(base + BigInt(i));
      if (hits.length >= max) return { hits, unreadable, truncated: true };
    }
    prev = p > 1 ? buf.subarray(Math.max(0, buf.length - (p - 1))) : Buffer.alloc(0);
  }
  return { hits, unreadable, truncated: false };
}

/** The QEMU monitor commands offered, through gdb's monitor (QBox's libqemu answers HMP). */
const MONITOR = [
  { label: 'info mtree -f', detail: 'Memory map of every address space, flattened (what each CPU and device sees)' },
  { label: 'info mtree', detail: 'Memory regions as QEMU nests them' },
  { label: 'info registers -a', detail: 'Registers of every CPU' },
  { label: 'info cpus', detail: 'The CPUs and their host threads' },
  { label: 'info qom-tree', detail: 'QEMU\'s object tree' },
  { label: 'xp', detail: 'Physical memory: xp /<count><format><size> <address>, e.g. xp /16xw 0x80000000', ask: true },
];

/** gdb's monitor command for an xp request: address (hex or decimal) and a count of 32-bit words. */
function xpCommand(address, words = 64) {
  const a = String(address).trim();
  if (!/^(0x[0-9a-f]+|\d+)$/i.test(a)) throw new Error('a physical address such as 0x80000000');
  return `xp /${Math.max(1, Math.min(4096, words))}xw ${a}`;
}

/** The expression that shows `address` as `type`: *(struct x *)(0x1000). */
function castExpression(type, address) {
  const t = String(type || '').trim().replace(/\s*\*\s*$/, '');
  const a = String(address || '').trim();
  if (!t || /[;{}]/.test(t)) throw new Error('a C type such as struct task_struct');
  if (!a) throw new Error('an address or an expression');
  // Through unsigned long: gdb will not cast some register values (such as $sp_el0) to a pointer directly.
  return `*(${t} *)(unsigned long)(${a})`;
}

/** gdb's add-symbol-file for an ELF whose .text is at `address`. */
function addSymbolFileCommand(file, address) {
  const a = String(address || '').trim();
  if (!a || /["\n]/.test(a)) throw new Error('the address of the file\'s .text, e.g. 0xffff800008000000');
  if (/["\n]/.test(String(file))) throw new Error('a file name without quotes');
  return `add-symbol-file "${file}" ${a}`;
}

/** gdb's scheduler-locking modes, as offered. */
const STEPPING = [
  { mode: 'off', label: 'Every CPU runs', detail: 'Stepping one CPU lets the others run too (the default)' },
  { mode: 'step', label: 'Only the selected CPU steps', detail: 'While stepping, the other CPUs stay stopped; Continue runs them all (set scheduler-locking step)' },
];

/** The mode from gdb's "show scheduler-locking" output. */
function parseLocking(text) {
  const m = /scheduler.*is "(\w+)"/i.exec(String(text || ''));
  return m ? m[1] : undefined;
}

module.exports = { MAX_SEARCH, parseSize, parsePattern, search, MONITOR, xpCommand, castExpression, addSymbolFileCommand, STEPPING, parseLocking };
