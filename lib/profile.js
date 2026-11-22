'use strict';
// Sampling profile (G-05): the sim agent's samples (translated-block start
// addresses with counts) summed per function of a symbol file, kernel and
// user space apart, and the KASLR offset of an arm64 Linux kernel found from
// guest memory. No VS Code dependency.

const elfsym = require('./elfsym');

const KERNEL_BASE = 0xffff000000000000n; // arm64: upper half of the address space
const ARM64_IMAGE_MAGIC = '41524d64'; // "ARM\x64" at offset 0x38 of an arm64 Image, as bytes

/** Whether bytes read at an Image's offset 0x38 (hex, memory order) are the arm64 Image magic. */
const isArm64Image = (hex) => String(hex).toLowerCase() === ARM64_IMAGE_MAGIC;

/**
 * Where to read the running kernel's own idea of its address: at boot, an
 * arm64 kernel relocates kimage_vaddr to the address it runs at (KASLR or
 * not). Its physical place is the Image's load address plus its offset in the
 * image. Returns { offset } (from the Image's start) or undefined when the
 * symbol file lacks _text or kimage_vaddr.
 */
function kimageVaddrOffset(symbols) {
  const text = symbols.find('_text');
  const kv = symbols.find('kimage_vaddr');
  if (text === undefined || kv === undefined || kv < text) return undefined;
  return { offset: kv - text, text };
}

/** KASLR offset: the runtime _text (kimage_vaddr's value, hex bytes little-endian) minus the linked one. */
function kaslrOffset(kimageVaddrHex, linkedText) {
  let v = 0n;
  for (let i = kimageVaddrHex.length - 2; i >= 0; i -= 2) v = (v << 8n) | BigInt(parseInt(kimageVaddrHex.slice(i, i + 2), 16));
  return v - linkedText;
}

/**
 * Sum the samples per function.
 * blocks: [[addressHex, samples]] (profile.read); functions: elfsym functions or [];
 * offset: BigInt added to symbol addresses (KASLR), applied to kernel addresses only.
 * Returns { total, rows: [{name, samples, space: 'kernel'|'user', resolved}], kernel: {samples, resolved} }
 * sorted by samples. Kernel addresses without a symbol are one row, "[kernel, no symbol]";
 * user-space addresses one row, "[user space]" (their programs' symbols are not loaded).
 */
function summarize(blocks, functions = [], offset = 0n) {
  const rows = new Map();
  let total = 0;
  let kSamples = 0;
  let kResolved = 0;
  const add = (name, space, n, resolved) => {
    const r = rows.get(name) || { name, samples: 0, space, resolved };
    r.samples += n;
    rows.set(name, r);
  };
  for (const [hex, n] of blocks) {
    total += n;
    const pc = BigInt(hex);
    if (pc < KERNEL_BASE) { add('[user space]', 'user', n, false); continue; }
    kSamples += n;
    const f = functions.length ? elfsym.lookup(functions, pc - offset) : undefined;
    if (f) { kResolved += n; add(f.name, 'kernel', n, true); } else add('[kernel, no symbol]', 'kernel', n, false);
  }
  return {
    total,
    rows: [...rows.values()].sort((a, b) => b.samples - a.samples),
    kernel: { samples: kSamples, resolved: kResolved },
  };
}

/** A warning when the symbols do not fit the kernel samples, or '' when they do. */
function symbolWarning(summary, hasSymbols) {
  const k = summary.kernel;
  if (!k.samples) return '';
  if (!hasSymbols) return 'No symbol file: kernel samples are not split by function. Choose the kernel\'s symbol file (vmlinux).';
  const share = k.resolved / k.samples;
  if (share < 0.5) {
    return `Only ${Math.round(share * 100)}% of the kernel samples fall in a function of the symbol file: it is probably not the kernel that runs, or its KASLR offset is unknown.`;
  }
  return '';
}

module.exports = { isArm64Image, kimageVaddrOffset, kaslrOffset, summarize, symbolWarning, KERNEL_BASE };
