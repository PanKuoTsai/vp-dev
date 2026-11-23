'use strict';
// AArch64 stage 1 address translation (VMSAv8-64, EL1&0 regime) done the way
// the MMU does it: from the CPU's SCTLR_EL1, TCR_EL1, TTBR0/1_EL1 and
// MAIR_EL1, walk the translation tables in physical memory and report every
// descriptor read, the physical address, and the access rights at EL1 and EL0.
// 4 KB, 16 KB and 64 KB granules, 48-bit output addresses (no FEAT_LPA2 or
// 52-bit tables). Stage 2 (a hypervisor's) is not walked. No VS Code dependency.

const M = (n) => (1n << BigInt(n)) - 1n;
const bit = (v, n) => Number((v >> BigInt(n)) & 1n);
const bits = (v, hi, lo) => Number((v >> BigInt(lo)) & M(hi - lo + 1));
const hex = (v, w = 16) => '0x' + BigInt(v).toString(16).padStart(w, '0');
/** 0xffff_8000_0800_0000 style, for reading 64-bit values. */
const hexg = (v, w = 16) => '0x' + BigInt(v).toString(16).padStart(w, '0').replace(/(?!^)(?=(?:[0-9a-f]{4})+$)/g, '_');

/** The system registers translation needs, as gdb names them on QEMU (upper case). */
const REGISTERS = ['SCTLR_EL1', 'TCR_EL1', 'TTBR0_EL1', 'TTBR1_EL1', 'MAIR_EL1', 'HCR_EL2', 'cpsr'];

const IPS_BITS = [32, 36, 40, 42, 44, 48, 52];
const GRANULE0 = { 0: 12, 1: 16, 2: 14 }; // TG0
const GRANULE1 = { 1: 14, 2: 12, 3: 16 }; // TG1
const SIZE = (g) => ({ 12: '4 KB', 14: '16 KB', 16: '64 KB' }[g]);

/** TCR_EL1 decoded. */
function parseTcr(tcr) {
  const t = BigInt(tcr);
  const tg0 = bits(t, 15, 14);
  const tg1 = bits(t, 31, 30);
  const ips = bits(t, 34, 32);
  return {
    t0sz: bits(t, 5, 0), t1sz: bits(t, 21, 16),
    epd0: bit(t, 7), epd1: bit(t, 23),
    g0: GRANULE0[tg0] || 12, g1: GRANULE1[tg1] || 12, tg0Reserved: !(tg0 in GRANULE0), tg1Reserved: !(tg1 in GRANULE1),
    a1: bit(t, 22), as16: bit(t, 36),
    ips, paBits: IPS_BITS[ips] || 48,
    tbi0: bit(t, 37), tbi1: bit(t, 38), ha: bit(t, 39), hd: bit(t, 40),
    hpd0: bit(t, 41), hpd1: bit(t, 42), ds: bit(t, 59),
    e0pd0: bit(t, 55), e0pd1: bit(t, 56),
  };
}

/** SCTLR_EL1 bits that matter here. */
function parseSctlr(sctlr) {
  const s = BigInt(sctlr);
  return { m: bit(s, 0), wxn: bit(s, 19), span: bit(s, 23), ee: bit(s, 25) };
}

/** Memory attributes of one MAIR byte: 'Normal, write-back, read/write-allocate' or 'Device-nGnRE'. */
function decodeAttr(byte) {
  const b = Number(byte) & 0xff;
  const hi = b >> 4;
  const lo = b & 15;
  if (hi === 0) {
    if (lo & 3) return { device: true, text: `Device (reserved encoding 0x${b.toString(16).padStart(2, '0')})` };
    return { device: true, text: ['Device-nGnRnE', 'Device-nGnRE', 'Device-nGRE', 'Device-GRE'][lo >> 2] };
  }
  if (b === 0xf0) return { device: false, text: 'Normal, write-back, read/write-allocate, tagged (MTE)' };
  const half = (n) => {
    if (n === 4) return 'non-cacheable';
    const kind = (n >> 2) & 3;
    const alloc = [n & 2 ? 'read' : '', n & 1 ? 'write' : ''].filter(Boolean).join('/');
    const policy = { 0: 'write-through transient', 1: 'write-back transient', 2: 'write-through', 3: 'write-back' }[kind];
    return policy + (alloc ? `, ${alloc}-allocate` : ', no allocate');
  };
  const o = half(hi);
  const i = half(lo);
  return { device: false, text: o === i ? `Normal, ${o}` : `Normal, outer ${o}; inner ${i}`, cacheable: hi !== 4 || lo !== 4 };
}

const SHAREABILITY = ['non-shareable', 'reserved', 'outer shareable', 'inner shareable'];

/**
 * Which translation table base the address uses and how the walk goes:
 * { ttbr: 0|1, inputBits, g (granule bits), stride, startLevel, tbi, hpd } or { fault } when the address
 * lies in neither range (bits above the input size must all be equal to bit 55, except the top byte with TBI).
 */
function region(va, tcr) {
  const v = BigInt.asUintN(64, BigInt(va));
  const sel = bit(v, 55);
  const tsz = sel ? tcr.t1sz : tcr.t0sz;
  const notes = [];
  // QEMU (like most implementations) uses the nearest valid size when TxSZ is outside 16..39 (48 with TTST).
  const clamped = Math.min(Math.max(tsz, 16), 48);
  if (clamped !== tsz) notes.push(`T${sel}SZ = ${tsz} is out of range; ${clamped} is used.`);
  const inputBits = 64 - clamped;
  const g = sel ? tcr.g1 : tcr.g0;
  if (sel ? tcr.tg1Reserved : tcr.tg0Reserved) notes.push(`TG${sel} holds a reserved value; the 4 KB granule is assumed.`);
  const tbi = sel ? tcr.tbi1 : tcr.tbi0;
  const topBit = tbi ? 55 : 63;
  const want = sel ? M(topBit - inputBits + 1) : 0n;
  const top = (v >> BigInt(inputBits)) & M(topBit - inputBits + 1);
  const stride = g - 3;
  const levels = Math.ceil((inputBits - g) / stride);
  const base = { ttbr: sel, inputBits, g, stride, startLevel: 4 - levels, tbi, hpd: sel ? tcr.hpd1 : tcr.hpd0, epd: sel ? tcr.epd1 : tcr.epd0, notes };
  if (top !== want) {
    return Object.assign(base, {
      fault: { kind: 'translation', level: 0, text: `Bits [${topBit}:${inputBits}] must all be ${sel} for a TTBR${sel} address (T${sel}SZ = ${clamped}${tbi ? ', top byte ignored' : ''}): this address is in neither range.` },
    });
  }
  return base;
}

/**
 * The fields of the virtual address for this walk, from the top: what selects the table base,
 * one index per level, the offset in the page. [{ name, hi, lo, value }]
 */
function fields(va, r) {
  const v = BigInt.asUintN(64, BigInt(va));
  const out = [];
  const tbiTop = r.tbi ? 55 : 63;
  if (r.tbi) out.push({ name: 'tag (ignored)', hi: 63, lo: 56, value: bits(v, 63, 56) });
  if (tbiTop >= r.inputBits) out.push({ name: `TTBR${r.ttbr} select`, hi: tbiTop, lo: r.inputBits, value: Number((v >> BigInt(r.inputBits)) & M(tbiTop - r.inputBits + 1)) });
  for (let l = r.startLevel; l <= 3; l++) {
    const lo = r.g + (3 - l) * r.stride;
    const hi = l === r.startLevel ? r.inputBits - 1 : lo + r.stride - 1;
    out.push({ name: `L${l} index`, level: l, hi, lo, value: Number((v >> BigInt(lo)) & M(hi - lo + 1)) });
  }
  out.push({ name: 'page offset', hi: r.g - 1, lo: 0, value: Number(v & M(r.g)) });
  return out;
}

/** Can a level hold a block descriptor with this granule (48-bit tables)? */
const blockAllowed = (g, level) => (g === 12 ? level === 1 || level === 2 : level === 2);

/** One descriptor decoded: { type: 'invalid'|'table'|'block'|'page'|'reserved', ... }. */
function decodeDescriptor(desc, level, g) {
  const d = BigInt.asUintN(64, BigInt(desc));
  if (!bit(d, 0)) return { type: 'invalid' };
  const isTable = bit(d, 1) === 1;
  if (level === 3) {
    if (!isTable) return { type: 'reserved' };
  } else if (isTable) {
    return {
      type: 'table', next: d & M(48) & ~M(g),
      pxnTable: bit(d, 59), uxnTable: bit(d, 60), apTable: bits(d, 62, 61), nsTable: bit(d, 63),
    };
  } else if (!blockAllowed(g, level)) return { type: 'reserved' };
  const lsb = g + (3 - level) * (g - 3);
  return {
    type: level === 3 ? 'page' : 'block', lsb, output: d & M(48) & ~M(lsb),
    attrIndx: bits(d, 4, 2), ns: bit(d, 5), ap: bits(d, 7, 6), sh: bits(d, 9, 8), af: bit(d, 10), ng: bit(d, 11),
    gp: bit(d, 50), dbm: bit(d, 51), contiguous: bit(d, 52), pxn: bit(d, 53), uxn: bit(d, 54), software: bits(d, 58, 55),
  };
}

/**
 * Access rights from the leaf descriptor and what the tables above it allow (unless TCR.HPD turns those off).
 * { el1: { r, w, x }, el0: { r, w, x }, notes: [] }
 */
function permissions(leaf, table, sctlr, pstate) {
  const notes = [];
  const apT = table.apTable;
  const el0Access = (leaf.ap & 1) === 1 && !(apT & 1);
  const readOnly = (leaf.ap & 2) === 2 || (apT & 2) === 2;
  const el1 = { r: true, w: !readOnly, x: !(leaf.pxn || table.pxnTable) };
  const el0 = { r: el0Access, w: el0Access && !readOnly, x: !(leaf.uxn || table.uxnTable) };
  if (el0.w && el1.x) { el1.x = false; notes.push('EL1 cannot execute it: memory writable at EL0 is always privileged execute-never.'); }
  if (sctlr && sctlr.wxn) {
    if (el1.w && el1.x) { el1.x = false; notes.push('SCTLR_EL1.WXN: writable memory is execute-never.'); }
    if (el0.w && el0.x) { el0.x = false; if (!notes.some((n) => n.includes('WXN'))) notes.push('SCTLR_EL1.WXN: writable memory is execute-never.'); }
  }
  if (pstate && pstate.pan && el0Access) notes.push('PSTATE.PAN is set: EL1 loads and stores to this EL0-accessible page fault (unless they are LDTR/STTR).');
  if (table.apTable || table.pxnTable || table.uxnTable) notes.push(`Restricted by a table descriptor above it:${table.apTable & 1 ? ' no EL0 access' : ''}${table.apTable & 2 ? ' read-only' : ''}${table.pxnTable ? ' PXNTable' : ''}${table.uxnTable ? ' UXNTable' : ''}.`);
  return { el1, el0, notes };
}

/** 'rwx', 'r--', '---' */
const rwx = (p) => (p.r ? 'r' : '-') + (p.w ? 'w' : '-') + (p.x ? 'x' : '-');

/**
 * Translate va. regs: { SCTLR_EL1, TCR_EL1, TTBR0_EL1, TTBR1_EL1, MAIR_EL1, HCR_EL2?, cpsr? } as
 * BigInt (or strings gdb printed); read8(pa: BigInt) -> Promise<BigInt|null>, one 64-bit descriptor in
 * the CPU's byte order. Result:
 * { va, mmu: bool, ttbr, granule, inputBits, paBits, asid, fields, steps: [{ level, table, index, address,
 *   desc, decoded }], pa?, size?, leaf?, perms?, attr?, shareability?, fault?, notes }
 */
async function translate(va, regs, read8) {
  const need = ['SCTLR_EL1', 'TCR_EL1', 'TTBR0_EL1', 'TTBR1_EL1', 'MAIR_EL1'];
  const r = {};
  for (const k of Object.keys(regs || {})) if (regs[k] !== undefined && regs[k] !== null && regs[k] !== '') r[k] = BigInt(regs[k]);
  const missing = need.filter((k) => r[k] === undefined);
  if (missing.length) throw new Error(`The debugger did not give ${missing.join(', ')}`);
  const v = BigInt.asUintN(64, BigInt(va));
  const sctlr = parseSctlr(r.SCTLR_EL1);
  const tcr = parseTcr(r.TCR_EL1);
  const pstate = r.cpsr !== undefined ? { el: bits(r.cpsr, 3, 2), pan: bit(r.cpsr, 22) } : undefined;
  const out = { va: v, mmu: !!sctlr.m, paBits: tcr.paBits, steps: [], notes: [], fields: [], pstate };
  if (r.HCR_EL2 !== undefined && bit(r.HCR_EL2, 0)) out.notes.push('HCR_EL2.VM is set: a hypervisor translates the result again (stage 2), which is not shown.');
  if (!sctlr.m) {
    out.notes.push('SCTLR_EL1.M = 0: the MMU is off, so the physical address equals the virtual one.');
    if (v >> BigInt(tcr.paBits)) out.fault = { kind: 'address size', level: 0, text: `With the MMU off the address must fit in ${tcr.paBits} bits.` };
    else { out.pa = v; out.attr = { device: true, text: 'Device-nGnRnE (data accesses with the MMU off)' }; }
    return out;
  }
  if (tcr.ds) out.notes.push('TCR_EL1.DS is set (52-bit addresses, FEAT_LPA2): the walk below assumes 48-bit descriptors and may be wrong.');
  const reg = region(v, tcr);
  out.notes.push(...reg.notes);
  Object.assign(out, { ttbr: reg.ttbr, granule: SIZE(reg.g), inputBits: reg.inputBits, startLevel: reg.startLevel });
  const ttbr = reg.ttbr ? r.TTBR1_EL1 : r.TTBR0_EL1;
  const asidFrom = tcr.a1 ? r.TTBR1_EL1 : r.TTBR0_EL1;
  out.asid = Number((asidFrom >> 48n) & (tcr.as16 ? 0xffffn : 0xffn));
  out.ttbrValue = ttbr;
  if (reg.fault) { out.fault = reg.fault; return out; }
  out.fields = fields(v, reg);
  if (reg.epd) { out.fault = { kind: 'translation', level: 0, text: `TCR_EL1.EPD${reg.ttbr} = 1: walks through TTBR${reg.ttbr} are disabled.` }; return out; }
  if ((reg.ttbr ? tcr.e0pd1 : tcr.e0pd0)) out.notes.push(`TCR_EL1.E0PD${reg.ttbr} = 1: EL0 accesses to this range fault without a walk.`);

  const startWidth = reg.inputBits - (reg.g + (3 - reg.startLevel) * reg.stride);
  let table = ttbr & M(48) & ~1n & ~M(Math.max(startWidth + 3, 0));
  if ((ttbr & M(48) & ~1n) !== table) out.notes.push(`TTBR${reg.ttbr} has bits set below the table's alignment; they are taken as 0.`);
  const inherited = { apTable: 0, pxnTable: 0, uxnTable: 0 };
  for (let level = reg.startLevel; level <= 3; level++) {
    const lo = reg.g + (3 - level) * reg.stride;
    const width = level === reg.startLevel ? startWidth : reg.stride;
    const index = Number((v >> BigInt(lo)) & M(width));
    const address = table + BigInt(index) * 8n;
    const step = { level, table, index, address };
    out.steps.push(step);
    if (address >> BigInt(tcr.paBits)) { out.fault = { kind: 'address size', level, text: `The level ${level} table at ${hexg(table)} is beyond the ${tcr.paBits}-bit physical address size (TCR_EL1.IPS).` }; return out; }
    const desc = await read8(address);
    if (desc === null || desc === undefined) { out.fault = { kind: 'unreadable', level, text: `Could not read the level ${level} descriptor at physical ${hexg(address)}.` }; return out; }
    step.desc = BigInt.asUintN(64, BigInt(desc));
    const d = decodeDescriptor(step.desc, level, reg.g);
    step.decoded = d;
    if (d.type === 'invalid') { out.fault = { kind: 'translation', level, text: `Level ${level} descriptor is invalid (bit 0 = 0): the address is not mapped.` }; return out; }
    if (d.type === 'reserved') { out.fault = { kind: 'translation', level, text: `Level ${level} descriptor uses a reserved encoding (${level === 3 ? 'bit 1 = 0 at level 3' : `no block at level ${level} with a ${SIZE(reg.g)} granule`}).` }; return out; }
    if (d.type === 'table') {
      if (!reg.hpd) { inherited.apTable |= d.apTable; inherited.pxnTable |= d.pxnTable; inherited.uxnTable |= d.uxnTable; }
      table = d.next;
      continue;
    }
    // block or page
    if (d.output >> BigInt(tcr.paBits)) { out.fault = { kind: 'address size', level, text: `The output address ${hexg(d.output)} is beyond the ${tcr.paBits}-bit physical address size.` }; return out; }
    out.leaf = d;
    out.pa = d.output | (v & M(d.lsb));
    out.size = 1n << BigInt(d.lsb);
    out.base = d.output;
    const mairByte = Number((r.MAIR_EL1 >> BigInt(8 * d.attrIndx)) & 0xffn);
    out.attr = Object.assign({ index: d.attrIndx, byte: mairByte }, decodeAttr(mairByte));
    out.shareability = out.attr.device ? 'outer shareable (device memory)' : SHAREABILITY[d.sh];
    out.perms = permissions(d, inherited, sctlr, pstate);
    if (reg.hpd && out.perms) out.perms.notes.push(`TCR_EL1.HPD${reg.ttbr} = 1: the tables' APTable/XNTable bits are ignored.`);
    if (!d.af) {
      if (tcr.ha) out.notes.push('AF = 0: the first access sets it in hardware (TCR_EL1.HA = 1).');
      else out.fault = { kind: 'access flag', level, text: 'AF = 0: the first access takes an Access flag fault (the OS then sets AF).' };
    }
    if (d.dbm && tcr.hd) out.notes.push(`DBM = 1 with TCR_EL1.HD: ${d.ap & 2 ? 'read-only until the first write, which hardware makes writable (dirty)' : 'already written (dirty)'}.`);
    if (d.contiguous) out.notes.push('Contiguous bit set: this entry is one of a run the TLB may cache as one.');
    if (pstate && pstate.el === 0 && reg.ttbr === 1) out.notes.push('This CPU is at EL0. With KPTI, TTBR1 then maps only the kernel entry trampoline.');
    return out;
  }
  return out;
}

/** "the CPU is at EL0 with KPTI" explains a TTBR1 fault: the hint shown with it. */
function faultHint(res) {
  if (!res.fault) return '';
  if (res.pstate && res.pstate.el === 0 && res.ttbr === 1) return 'This CPU is running user space (EL0). With KPTI, the kernel half is unmapped while it does: pick a CPU at EL1 in Call Stack and translate again.';
  if (res.fault.kind === 'access flag') return 'The page is mapped; the OS has not marked it accessed yet.';
  return '';
}

/** The platform region the physical address falls in (lowest priority number on each bus wins). */
function regionAt(memoryMap, pa) {
  const a = BigInt(pa);
  const hits = (memoryMap || []).filter((m) => a >= m.start && a <= m.end).sort((x, y) => (x.priority || 0) - (y.priority || 0));
  if (!hits.length) return null;
  const h = hits[0];
  return { instance: h.instance, port: h.port, bus: h.bus, start: h.start, offset: a - h.start };
}

/** gdb's "monitor xp /1gx ADDR" output -> BigInt, or null. */
function parseXp(text) {
  const m = /^\s*[0-9a-f]+:\s+(0x[0-9a-f]+)/im.exec(String(text));
  return m ? BigInt(m[1]) : null;
}

/** From a -data-list-register-names / -values snapshot (cpuregs.snapshot): the registers translation needs. */
function pickRegisters(regs) {
  const out = {};
  const want = new Map(REGISTERS.map((n) => [n.toLowerCase(), n]));
  for (const r of regs || []) {
    const k = want.get(String(r.name).toLowerCase());
    if (k && /^(0x[0-9a-f]+|\d+)$/i.test(String(r.value).trim())) out[k] = BigInt(String(r.value).trim());
  }
  return out;
}

/** Plain text of a result, for Copy. */
function toText(res) {
  const lines = [`VA ${hexg(res.va)}`];
  if (!res.mmu) lines.push('MMU off');
  else lines.push(`TTBR${res.ttbr} = ${hexg(res.ttbrValue)}, ${res.granule} granule, ${res.inputBits}-bit VA, ASID ${res.asid}`);
  for (const s of res.steps) lines.push(`L${s.level} [${s.index}] @ ${hexg(s.address)} = ${s.desc === undefined ? '?' : hexg(s.desc)}${s.decoded ? ' ' + s.decoded.type : ''}`);
  if (res.pa !== undefined) lines.push(`PA ${hexg(res.pa)}${res.size ? ` (${res.leaf.type} of ${formatSize(res.size)} at ${hexg(res.base)})` : ''}`);
  if (res.perms) lines.push(`EL1 ${rwx(res.perms.el1)}  EL0 ${rwx(res.perms.el0)}`);
  if (res.attr) lines.push(`${res.attr.text}${res.shareability ? ', ' + res.shareability : ''}`);
  if (res.fault) lines.push(`FAULT (${res.fault.kind}, level ${res.fault.level}): ${res.fault.text}`);
  for (const n of res.notes) lines.push(`note: ${n}`);
  if (res.perms) for (const n of res.perms.notes) lines.push(`note: ${n}`);
  return lines.join('\n');
}

function formatSize(n) {
  const b = Number(n);
  for (const { u, s } of [{ u: 2 ** 30, s: 'GiB' }, { u: 2 ** 20, s: 'MiB' }, { u: 2 ** 10, s: 'KiB' }]) if (b >= u && b % u === 0) return `${b / u} ${s}`;
  return `${b} bytes`;
}

/** Result as JSON for the webview (BigInts as hex strings). */
function forView(res, memoryMap) {
  const h = (x) => (x === undefined || x === null ? undefined : hexg(x));
  const where = res.pa !== undefined ? regionAt(memoryMap, res.pa) : null;
  return {
    va: h(res.va), mmu: res.mmu, ttbr: res.ttbr, ttbrValue: h(res.ttbrValue), granule: res.granule, inputBits: res.inputBits, paBits: res.paBits, asid: res.asid,
    el: res.pstate ? res.pstate.el : undefined,
    fields: res.fields,
    steps: res.steps.map((s) => ({
      level: s.level, table: h(s.table), index: s.index, address: h(s.address), desc: h(s.desc),
      type: s.decoded ? s.decoded.type : undefined,
      next: s.decoded && s.decoded.next !== undefined ? h(s.decoded.next) : undefined,
      output: s.decoded && s.decoded.output !== undefined ? h(s.decoded.output) : undefined,
      flags: s.decoded ? descFlags(s.decoded) : [],
    })),
    pa: h(res.pa), base: h(res.base), size: res.size ? formatSize(res.size) : undefined, kind: res.leaf ? res.leaf.type : undefined,
    perms: res.perms ? { el1: rwx(res.perms.el1), el0: rwx(res.perms.el0), notes: res.perms.notes } : undefined,
    attr: res.attr ? { text: res.attr.text, index: res.attr.index, byte: res.attr.byte, device: res.attr.device } : undefined,
    shareability: res.shareability,
    leaf: res.leaf ? { af: res.leaf.af, ng: res.leaf.ng, ns: res.leaf.ns, dbm: res.leaf.dbm, contiguous: res.leaf.contiguous, gp: res.leaf.gp, software: res.leaf.software, ap: res.leaf.ap } : undefined,
    where: where ? { instance: where.instance, port: where.port, offset: '0x' + where.offset.toString(16) } : null,
    fault: res.fault, hint: faultHint(res), notes: res.notes, text: toText(res),
  };
}

/** Short flags of a descriptor, for its row. */
function descFlags(d) {
  if (d.type === 'table') return [d.apTable & 1 ? 'APTable: no EL0' : '', d.apTable & 2 ? 'APTable: RO' : '', d.pxnTable ? 'PXNTable' : '', d.uxnTable ? 'UXNTable' : '', d.nsTable ? 'NSTable' : ''].filter(Boolean);
  if (d.type !== 'block' && d.type !== 'page') return [];
  return [`AttrIndx ${d.attrIndx}`, ['AP 00 (EL1 rw)', 'AP 01 (rw)', 'AP 10 (EL1 ro)', 'AP 11 (ro)'][d.ap], ['NSH', 'SH?', 'OSH', 'ISH'][d.sh], d.af ? 'AF' : 'AF=0', d.ng ? 'nG' : 'global', d.pxn ? 'PXN' : '', d.uxn ? 'UXN' : '', d.dbm ? 'DBM' : '', d.contiguous ? 'Cont' : '', d.gp ? 'GP' : ''].filter(Boolean);
}

module.exports = {
  REGISTERS, parseTcr, parseSctlr, decodeAttr, region, fields, decodeDescriptor, permissions, rwx,
  translate, faultHint, regionAt, parseXp, pickRegisters, toText, forView, formatSize, hexg, hex,
};
