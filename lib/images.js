'use strict';
// Software images: what the loader modules put into memory, where it lands,
// and whether that makes sense. Uses fs but not VS Code.

const fs = require('fs');
const path = require('path');
const { evalInt, hex } = require('./core');

const MACHINES = { 3: 'x86', 40: 'ARM', 62: 'x86-64', 183: 'AArch64', 243: 'RISC-V' };
const ADDRESS = /^(0x[0-9A-Fa-f]+|\d+|\$\{[A-Za-z_]\w*\}(\s*[+-]\s*(0x[0-9A-Fa-f]+|\d+))?)$/;

/** Expand ${TOP} to the directory of the platform file. Returns null if other variables remain. */
function resolveTemplate(s, topDir) {
  if (typeof s !== 'string' || s === '') return null;
  const out = s.replace(/\$\{TOP\}/g, topDir.endsWith(path.sep) ? topDir : topDir + path.sep);
  if (/\$\{/.test(out)) return null;
  return path.isAbsolute(out) ? path.normalize(out) : path.resolve(topDir, out);
}

/** Express an absolute path relative to the platform file, as the description stores it. */
function toTemplate(absPath, topDir) {
  const rel = path.relative(topDir, absPath).split(path.sep).join('/');
  return '${TOP}' + rel;
}

function isElf(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const b = Buffer.alloc(4);
      return fs.readSync(fd, b, 0, 4, 0) === 4 && b[0] === 0x7f && b.toString('latin1', 1, 4) === 'ELF';
    } finally { fs.closeSync(fd); }
  } catch (e) { return false; }
}

/** Whether a file is an arm64 Linux kernel Image (magic "ARM\x64" at 0x38, Documentation/arch/arm64/booting.rst). */
function isArm64Image(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const b = Buffer.alloc(64);
      return fs.readSync(fd, b, 0, 64, 0) === 64 && b.readUInt32LE(0x38) === 0x644d5241;
    } finally { fs.closeSync(fd); }
  } catch (e) { return false; }
}

/**
 * The arm64 Linux Image header (Documentation/arch/arm64/booting.rst):
 * text_offset (0x08) and image_size (0x10), the memory the kernel needs once
 * running, BSS included; null for other files. image_size is 0 before Linux 3.17.
 */
function arm64Header(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const b = Buffer.alloc(64);
      if (fs.readSync(fd, b, 0, 64, 0) !== 64 || b.readUInt32LE(0x38) !== 0x644d5241) return null;
      return { textOffset: b.readBigUInt64LE(0x08), imageSize: b.readBigUInt64LE(0x10), flags: b.readBigUInt64LE(0x18) };
    } finally { fs.closeSync(fd); }
  } catch (e) { return null; }
}

/** Read the ELF header and PT_LOAD segments (32/64-bit, either endianness). */
function readElf(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(64);
    const got = fs.readSync(fd, head, 0, 64, 0);
    if (got < 52 || head[0] !== 0x7f || head.toString('latin1', 1, 4) !== 'ELF') throw new Error('not an ELF file');
    const is64 = head[4] === 2;
    const le = head[5] !== 2;
    const u16 = (b, o) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
    const u32 = (b, o) => BigInt(le ? b.readUInt32LE(o) : b.readUInt32BE(o));
    const u64 = (b, o) => (le ? b.readBigUInt64LE(o) : b.readBigUInt64BE(o));
    const word = is64 ? u64 : u32;
    const machine = u16(head, 18);
    const entry = word(head, 24);
    const phoff = is64 ? u64(head, 32) : u32(head, 28);
    const phentsize = u16(head, is64 ? 54 : 42);
    const phnum = u16(head, is64 ? 56 : 44);
    const segments = [];
    if (phnum > 0 && phentsize >= (is64 ? 56 : 32)) {
      const ph = Buffer.alloc(phentsize * phnum);
      if (fs.readSync(fd, ph, 0, ph.length, Number(phoff)) < ph.length) throw new Error('truncated program headers');
      for (let k = 0; k < phnum; k++) {
        const o = k * phentsize;
        if (u32(ph, o) !== 1n) continue; // PT_LOAD
        const seg = is64
          ? { vaddr: u64(ph, o + 16), paddr: u64(ph, o + 24), filesz: u64(ph, o + 32), memsz: u64(ph, o + 40) }
          : { vaddr: u32(ph, o + 8), paddr: u32(ph, o + 12), filesz: u32(ph, o + 16), memsz: u32(ph, o + 20) };
        if (seg.memsz > 0n) segments.push(seg);
      }
    }
    return { bits: is64 ? 64 : 32, machine: MACHINES[machine] || `machine ${machine}`, entry, segments };
  } finally { fs.closeSync(fd); }
}

function kindOf(entry) {
  if (typeof entry.bin_file === 'string') return 'bin';
  if (typeof entry.elf_file === 'string') return 'elf';
  return 'raw';
}

/** Highest-priority mapped region containing addr (a lower priority number wins). */
function regionAt(memoryMap, addr) {
  return memoryMap.filter((m) => addr >= m.start && addr <= m.end).sort((a, b) => a.priority - b.priority)[0];
}

/**
 * Collect loader entries with resolved files and target ranges, plus problems.
 * analysis: result of core.analyze(doc). topDir: directory of the platform file.
 * options.catalog: the component catalog, for parameter defaults (has_el3).
 */
function collect(doc, analysis, topDir, options = {}) {
  const problems = [];
  const types = new Map(analysis.instances.map((i) => [i.name, i.type]));
  const loaders = [];
  const placed = []; // {label, start, end, base, reserved}
  // reserve: memory the image needs once running when that is more than the
  // file (an arm64 kernel's image_size, BSS included); it is checked for
  // overlaps and the end of memory like the file itself.
  const place = (label, base, start, size, reserve) => {
    const fileEnd = start + size - 1n;
    const end = reserve && reserve > size ? start + reserve - 1n : fileEnd;
    const what = end > fileEnd ? ' (image_size from the kernel header, BSS included)' : '';
    const region = regionAt(analysis.memoryMap, start);
    if (!region) {
      problems.push({ severity: 'warning', module: base, message: `${label} loads at ${hex(start)}, which is not mapped on any bus` });
    } else {
      if (end > region.end) {
        problems.push({ severity: 'warning', module: base,
          message: `${label} [${hex(start)}..${hex(end)}]${what} runs past the end of ${region.instance}.${region.port} (${hex(region.end)})` });
      }
      if (types.get(region.instance) !== 'gs_memory') {
        problems.push({ severity: 'info', module: base, message: `${label} loads into ${region.instance}, which is not a memory module` });
      }
    }
    for (const other of placed) {
      if (start <= other.end && other.start <= end) {
        const mine = `${label} [${hex(start)}..${hex(end)}]${what}`;
        const theirs = `${other.label} [${hex(other.start)}..${hex(other.end)}]${other.what}`;
        problems.push({ severity: 'warning', module: base,
          message: `${mine} overlaps ${theirs}${what || other.what ? '. The kernel clears its BSS when it starts, so whatever is loaded there is lost' : ''}` });
      }
    }
    placed.push({ label, start, end, base, what });
    const r = { start, end: fileEnd, region: region ? `${region.instance}.${region.port}` : null };
    if (end > fileEnd) r.reserveEnd = end;
    return r;
  };

  for (const [base, mod] of Object.entries(require('./core').modulesOf(doc))) {
    if (mod.type !== 'loader' && !Array.isArray(mod.entries)) continue;
    const entries = (mod.entries || []).map((e, index) => {
      const kind = kindOf(e);
      const row = { index, kind, file: kind === 'bin' ? e.bin_file : kind === 'elf' ? e.elf_file : null, ranges: [] };
      if (kind === 'raw') {
        row.summary = Object.keys(e).join(', ');
        row.addressRaw = e.address;
        return row;
      }
      const label = `${base}[${index}] ${path.posix.basename(row.file.replace(/\\/g, '/')) || '(no file)'}`;
      row.resolved = resolveTemplate(row.file, topDir);
      if (kind === 'bin') {
        row.addressRaw = e.address;
        if (e.address === undefined) problems.push({ severity: 'error', module: base, message: `${label}: a binary image needs a load address` });
      }
      if (row.file === '') {
        problems.push({ severity: 'warning', module: base, message: `${base}[${index}]: no file selected` });
        return row;
      }
      if (row.resolved === null) {
        row.note = 'path depends on a variable';
        return row;
      }
      let st;
      try { st = fs.statSync(row.resolved); } catch (e2) { st = null; }
      row.exists = !!st && st.isFile();
      if (!row.exists) {
        problems.push({ severity: 'warning', module: base, message: `${label}: file not found (${row.resolved})` });
        return row;
      }
      row.size = BigInt(st.size);
      if (kind === 'bin') {
        const kernel = arm64Header(row.resolved);
        if (kernel) row.linux = 'arm64';
        if (isElf(row.resolved)) {
          problems.push({ severity: 'warning', module: base, message: `${label} is an ELF file but is loaded as a raw binary; headers would be copied into memory` });
        }
        const addr = e.address !== undefined ? evalInt(e.address, analysis.env) : null;
        if (addr === null) row.note = 'address is not a constant';
        else if (row.size > 0n) {
          row.ranges.push(place(label, base, addr, row.size, kernel ? kernel.imageSize : undefined));
          if (kernel) {
            row.kernel = { textOffset: kernel.textOffset, imageSize: kernel.imageSize };
            const MiB2 = 0x200000n;
            if ((addr - kernel.textOffset) % MiB2 !== 0n) {
              problems.push({ severity: 'warning', module: base,
                message: `${label} is an arm64 Linux kernel at ${hex(addr)}; it must be ${hex(kernel.textOffset)} (text_offset) above a 2 MiB-aligned address, or it does not boot` });
            }
          }
        }
      } else {
        try {
          const elf = readElf(row.resolved);
          row.elf = { bits: elf.bits, machine: elf.machine, entry: elf.entry };
          if (elf.segments.length === 0) problems.push({ severity: 'warning', module: base, message: `${label} has no loadable segments` });
          elf.segments.forEach((s, k) => row.ranges.push(place(`${label} segment ${k}`, base, s.paddr, s.memsz)));
        } catch (err) {
          problems.push({ severity: 'error', module: base, message: `${label}: ${err.message}` });
        }
      }
      return row;
    });
    loaders.push({ module: base, entries });
  }

  const symbols = ((doc.debug && doc.debug.symbols) || []).map((s) => {
    const resolved = resolveTemplate(s, topDir);
    const exists = resolved !== null && fs.existsSync(resolved);
    if (resolved !== null && !exists) problems.push({ severity: 'warning', message: `Debug symbol file not found (${resolved})` });
    else if (exists && !isElf(resolved)) problems.push({ severity: 'warning', message: `Debug symbol file is not an ELF file (${resolved})` });
    return { file: s, resolved, exists };
  });

  // Files a debugger should read symbols from: explicit symbol files first, then loaded ELF images.
  const symbolFiles = symbols.filter((s) => s.exists).map((s) => s.resolved);
  for (const l of loaders) for (const e of l.entries) if (e.kind === 'elf' && e.exists) symbolFiles.push(e.resolved);

  problems.push(...el3Problems(doc, analysis, loaders, options.catalog));

  // Where a new binary image would sensibly go: start of the largest plain memory.
  const mems = analysis.memoryMap.filter((m) => types.get(m.instance) === 'gs_memory' && m.priority === 0);
  mems.sort((a, b) => (a.size < b.size ? 1 : a.size > b.size ? -1 : 0));
  return { loaders, symbols, symbolFiles: [...new Set(symbolFiles)], problems, defaultAddress: mems.length ? hex(mems[0].start) : '0x0' };
}

// Names of files that are (or contain) firmware able to run at EL3 and drop to
// EL2/EL1 before Linux: TF-A, U-Boot, UEFI, OP-TEE...
const FIRMWARE = /(^|[^a-z0-9])(bl1|bl2|bl31|bl32|fip|tf-?a|atf|trusted|u-?boot|uefi|edk2?|qemu_efi|optee|tee|firmware|boot-?loader)([^a-z0-9]|$)/i;

/** A boolean parameter value (literal, "true"/"false", or ${VAR}); undefined when not constant. */
function boolValue(v, doc, depth = 0) {
  if (typeof v === 'boolean') return v;
  if (typeof v !== 'string' || depth > 8) return undefined;
  const t = v.trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  const m = /^\$\{([A-Za-z_]\w*)\}$/.exec(t);
  const def = m && (doc.variables || []).find((x) => x.name === m[1]);
  return def ? boolValue(def.value, doc, depth + 1) : undefined;
}

/**
 * K-03: an arm64 CPU that starts in EL3 (has_el3 true, which is the QBox
 * default) while the loader puts a Linux Image straight into memory, with no
 * EL3 firmware to drop to EL2/EL1. Linux must be entered at EL2 or EL1; from
 * EL3 it prints nothing and spins in its exception vectors.
 */
function el3Problems(doc, analysis, loaders, catalog) {
  const linux = [];
  let firmware = false;
  for (const l of loaders) {
    for (const e of l.entries) {
      if (e.linux === 'arm64') linux.push({ module: l.module, index: e.index, file: e.file });
      else if (e.kind === 'elf' || (e.file && FIRMWARE.test(path.posix.basename(String(e.file).replace(/\\/g, '/'))))) firmware = true;
    }
  }
  if (!linux.length || firmware) return [];
  const byBase = new Map();
  for (const inst of analysis.instances) {
    const info = catalog && catalog.modules ? catalog.modules[inst.type] : undefined;
    const pdef = info && info.introspection && (info.introspection.params || []).find((p) => p.name === 'has_el3');
    if (!pdef) continue;
    const set = Object.prototype.hasOwnProperty.call(inst.params, 'has_el3');
    const v = set ? boolValue(inst.params.has_el3, doc) : boolValue(pdef.default, doc);
    if (v !== true) continue;
    if (!byBase.has(inst.base)) byBase.set(inst.base, { names: [], fromDefault: !set });
    const b = byBase.get(inst.base);
    b.names.push(inst.name);
    if (set) b.fromDefault = false;
  }
  const img = linux[0];
  const what = `${img.module}[${img.index}] ${path.posix.basename(String(img.file).replace(/\\/g, '/'))}`;
  return [...byBase].map(([base, b]) => ({
    severity: 'warning',
    module: base,
    message: `${b.names.length > 1 ? `${b.names[0]}..${b.names[b.names.length - 1]} start` : `${b.names[0]} starts`} in EL3 (has_el3 is true${b.fromDefault ? ', the model default' : ''}), `
      + `but ${what} is a Linux kernel loaded without EL3 firmware. Linux must be entered at EL2 or EL1; from EL3 the kernel prints nothing. `
      + 'Set has_el3 to false, or load EL3 firmware (for example TF-A BL31) that starts the kernel.',
  }));
}

/** Normalise a user-typed address; returns null when it is not acceptable. */
function normaliseAddress(s) {
  const t = String(s).trim();
  if (!ADDRESS.test(t)) return null;
  return /^\d+$/.test(t) ? hex(BigInt(t)) : t;
}

/**
 * Build the new entries array from form rows, keeping keys the form does not show.
 * rows: [{orig: index|null, kind: 'bin'|'elf'|'raw', file, address}]
 */
function rebuildEntries(oldEntries, rows) {
  return rows.map((r) => {
    const old = r.orig !== null && r.orig !== undefined ? oldEntries[r.orig] : undefined;
    if (r.kind === 'raw') {
      if (!old) throw new Error('A raw entry can only be kept, not created');
      return old;
    }
    const rest = Object.assign({}, old);
    delete rest.bin_file; delete rest.elf_file; delete rest.address;
    if (r.kind === 'elf') return Object.assign({ elf_file: r.file }, rest);
    const address = normaliseAddress(r.address);
    if (address === null) throw new Error(`"${r.address}" is not a valid address. Use hex (0x80000000), decimal, or \${NAME} with an optional offset.`);
    return Object.assign({ bin_file: r.file, address }, rest);
  });
}

/**
 * Files the loaders would fail on at start: [{ module, index, file, resolved }].
 * QBox's loader stops the simulator when a file is missing ("cannot get file size").
 */
function missingFiles(collected) {
  const out = [];
  for (const l of collected.loaders) {
    for (const e of l.entries) {
      if (e.kind !== 'raw' && e.resolved && e.exists === false) out.push({ module: l.module, index: e.index, file: e.file, resolved: e.resolved });
    }
  }
  return out;
}

module.exports = { missingFiles, collect, readElf, isElf, isArm64Image, arm64Header, el3Problems, boolValue, resolveTemplate, toTemplate, normaliseAddress, rebuildEntries, kindOf };
