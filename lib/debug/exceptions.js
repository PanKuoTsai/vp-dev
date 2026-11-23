'use strict';
// Exceptions and interrupts (sim agent 0.15.0, exc.*): decode the events the
// agent records on AArch64 (vector slot, ESR exception class and abort status,
// FAR) and build the catch rules from the choices in the panel.
// No VS Code dependency.

const MIN_AGENT = '0.15.0';
const SYSCALLS = require('./syscalls-arm64.json').syscalls; // number -> name (asm-generic, as arm64 uses)
const SYSCALL_NUMBERS = new Map(Object.entries(SYSCALLS).map(([n, name]) => [name, Number(n)]));

/** "ioctl, mmap 29" -> [29, 222, 29]; throws on an unknown name. */
function parseSyscalls(text) {
  const out = [];
  for (const w of String(text || '').split(/[\s,]+/).filter(Boolean)) {
    if (/^\d+$/.test(w)) out.push(Number(w));
    else if (SYSCALL_NUMBERS.has(w)) out.push(SYSCALL_NUMBERS.get(w));
    else if (SYSCALL_NUMBERS.has(w.replace(/^(sys_|__NR_)/, ''))) out.push(SYSCALL_NUMBERS.get(w.replace(/^(sys_|__NR_)/, '')));
    else throw new Error(`unknown system call "${w}"`);
  }
  return [...new Set(out)];
}

const syscallName = (n) => SYSCALLS[String(n)];

const KINDS = ['sync', 'irq', 'fiq', 'serror'];
const KIND_LABEL = { sync: 'Synchronous', irq: 'IRQ', fiq: 'FIQ', serror: 'SError' };
// Vector table groups, by offset / 0x200.
const GROUPS = ['current EL, SP_EL0', 'current EL, SP_ELx', 'lower EL, AArch64', 'lower EL, AArch32'];

// ESR_ELx.EC (Arm ARM, ESR_EL1).
const EC = {
  0x00: 'Unknown reason (undefined instruction)',
  0x01: 'Trapped WFI/WFE',
  0x03: 'Trapped MCR/MRC (CP15)',
  0x04: 'Trapped MCRR/MRRC (CP15)',
  0x05: 'Trapped MCR/MRC (CP14)',
  0x06: 'Trapped LDC/STC',
  0x07: 'SVE, SIMD or FP access trap',
  0x0c: 'Trapped MRRC (CP14)',
  0x0d: 'Branch target exception',
  0x0e: 'Illegal execution state',
  0x11: 'SVC (AArch32)',
  0x12: 'HVC (AArch32)',
  0x13: 'SMC (AArch32)',
  0x15: 'SVC (system call)',
  0x16: 'HVC',
  0x17: 'SMC',
  0x18: 'Trapped MSR, MRS or system instruction',
  0x19: 'SVE access trap',
  0x1c: 'Pointer authentication failure',
  0x20: 'Instruction abort from a lower EL',
  0x21: 'Instruction abort',
  0x22: 'PC alignment fault',
  0x24: 'Data abort from a lower EL',
  0x25: 'Data abort',
  0x26: 'SP alignment fault',
  0x28: 'FP exception (AArch32)',
  0x2c: 'FP exception',
  0x2f: 'SError',
  0x30: 'Breakpoint from a lower EL',
  0x31: 'Breakpoint',
  0x32: 'Software step from a lower EL',
  0x33: 'Software step',
  0x34: 'Watchpoint from a lower EL',
  0x35: 'Watchpoint',
  0x38: 'BKPT (AArch32)',
  0x3c: 'BRK instruction',
};
const ABORTS = new Set([0x20, 0x21, 0x24, 0x25]);

/** Fault status code (DFSC/IFSC, ISS bits 5:0) in words. */
function faultStatus(fsc) {
  const level = fsc & 3;
  switch (fsc >> 2) {
    case 0: return `address size fault, level ${level}`;
    case 1: return `translation fault, level ${level}`;
    case 2: return `access flag fault, level ${level}`;
    case 3: return `permission fault, level ${level}`;
    default: break;
  }
  const other = { 0x10: 'synchronous external abort', 0x11: 'synchronous tag check fault', 0x18: 'synchronous parity or ECC error', 0x21: 'alignment fault', 0x30: 'TLB conflict abort', 0x31: 'unsupported atomic hardware update fault' };
  return other[fsc] || `fault status 0x${fsc.toString(16)}`;
}

const big = (s) => { try { return BigInt(s); } catch (e) { return 0n; } };
const hex = (v) => '0x' + v.toString(16);

/**
 * One event from exc.read or a status' exceptionHit:
 * [seq, vtime_ns, cpu, type, vec, elFrom, elTo, fromPc, toPc, esr, far, elr].
 */
function decode(a) {
  const [seq, timeNs, cpu, type, vec, elFrom, elTo, fromPc, toPc, esrS, farS, elrS, x8S] = a;
  const kind = vec < 16 ? KINDS[vec & 3] : type === 1 ? 'irq' : 'sync';
  const esr = big(esrS);
  const ec = kind === 'sync' ? Number((esr >> 26n) & 0x3fn) : undefined;
  const iss = Number(esr & 0x1ffffffn);
  const e = {
    seq, timeNs, cpu, kind, vec, fromEl: elFrom, toEl: elTo, fromPc, toPc, elr: elrS,
    group: vec < 16 ? GROUPS[vec >> 2] : undefined,
    esr: kind === 'sync' || kind === 'serror' ? hex(esr) : undefined,
    ec, far: undefined, detail: '',
  };
  if (kind !== 'sync') {
    e.title = `${KIND_LABEL[kind]} on CPU ${cpu}`;
    e.detail = `EL${elFrom} → EL${elTo}`;
    return e;
  }
  e.ecName = EC[ec] || `Exception class 0x${ec.toString(16)}`;
  const parts = [];
  if (ABORTS.has(ec)) {
    parts.push(faultStatus(iss & 0x3f));
    const data = ec === 0x24 || ec === 0x25;
    if (data) parts.push(iss & 0x40 ? 'write' : 'read');
    if (iss & 0x400) parts.push('address not valid (FnV)');
    else e.far = farS;
  } else if (ec === 0x15 && x8S !== undefined) {
    // Linux passes the system call number in x8 (agent 0.15.0 records it).
    const nr = Number(big(x8S));
    e.syscall = nr;
    parts.push(syscallName(nr) ? `${syscallName(nr)}, #${nr}` : `#${nr}`);
  } else if (ec === 0x15 || ec === 0x16 || ec === 0x17 || ec === 0x3c) {
    parts.push(`#${iss & 0xffff}`);
  } else if (ec === 0x22) {
    e.far = farS;
  }
  e.detail = parts.join(', ');
  e.title = `${e.ecName}${e.detail ? ` (${e.detail})` : ''}${e.far ? ` at ${e.far}` : ''}`;
  return e;
}

/** A short line for a notification or the status bar. */
function describe(e) {
  return `${e.title} — CPU ${e.cpu}, EL${e.fromEl} → EL${e.toEl}, from ${e.fromPc}`;
}

// What the panel offers to stop on. ec: exception classes (synchronous only).
const CATCH = [
  { id: 'dataAbort', label: 'Data abort', hint: 'Page faults and bad data accesses (EC 0x24, 0x25)', kind: 'sync', ec: [0x24, 0x25] },
  { id: 'instAbort', label: 'Instruction abort', hint: 'Fetching from an unmapped or non-executable address (EC 0x20, 0x21)', kind: 'sync', ec: [0x20, 0x21] },
  { id: 'undef', label: 'Undefined instruction', hint: 'Unknown reason and illegal execution state (EC 0x00, 0x0E)', kind: 'sync', ec: [0x00, 0x0e] },
  { id: 'align', label: 'Alignment fault', hint: 'PC or SP alignment (EC 0x22, 0x26)', kind: 'sync', ec: [0x22, 0x26] },
  { id: 'brk', label: 'BRK / BKPT', hint: 'Software breakpoints the program itself executes (EC 0x3C, 0x38)', kind: 'sync', ec: [0x3c, 0x38] },
  { id: 'svc', label: 'SVC (system call)', hint: 'Every system call (EC 0x15, 0x11), or only those listed below: frequent', kind: 'sync', ec: [0x15, 0x11] },
  { id: 'trap', label: 'Trapped system register', hint: 'MSR, MRS and system instructions trapped to a higher EL (EC 0x18)', kind: 'sync', ec: [0x18] },
  { id: 'serror', label: 'SError', hint: 'Asynchronous external aborts', kind: 'serror' },
  { id: 'irq', label: 'IRQ', hint: 'Every interrupt: very frequent', kind: 'irq' },
  { id: 'fiq', label: 'FIQ', hint: 'Fast interrupts', kind: 'fiq' },
];
const ORIGINS = { any: undefined, el0: 0, el1: 1, el2: 2 };

/**
 * exc.setCatch rules for the chosen CATCH ids, taken from `origin` ('any',
 * 'el0', 'el1', 'el2'). syscalls: numbers that limit the SVC choice to those
 * system calls (AArch64 only).
 */
function rulesFor(ids, origin = 'any', syscalls = []) {
  const from = ORIGINS[origin];
  const out = [];
  for (const c of CATCH) {
    if (!ids.includes(c.id)) continue;
    const base = from === undefined ? {} : { fromEl: from };
    if (c.id === 'svc' && syscalls.length) { out.push(Object.assign({ kind: 'sync', ec: 0x15, syscalls }, base)); continue; }
    if (c.ec) for (const ec of c.ec) out.push(Object.assign({ kind: c.kind, ec }, base));
    else out.push(Object.assign({ kind: c.kind }, base));
  }
  return out;
}

/** The counts of exc.getStatus as table rows, most frequent first. */
function countRows(counts) {
  return (counts || []).map((c) => ({
    kind: c.kind, ec: c.ec, count: c.count,
    label: c.kind === 'sync' ? (EC[c.ec] || `Exception class 0x${Number(c.ec).toString(16)}`) : KIND_LABEL[c.kind] || c.kind,
    code: c.kind === 'sync' ? `EC 0x${Number(c.ec).toString(16).padStart(2, '0')}` : '',
  })).sort((a, b) => b.count - a.count);
}

module.exports = { MIN_AGENT, KINDS, EC, CATCH, faultStatus, decode, describe, rulesFor, countRows, parseSyscalls, syscallName };
