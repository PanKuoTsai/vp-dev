'use strict';
// Run with: node test/profile.test.js (every file: npm test)
const { test } = require('./harness');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ------------------------------------------------------------------ G-05: profiling

/** A minimal ELF64 little-endian file with a .symtab: [{name, value, size, func}]. */
function makeSymElf(file, syms) {
  let strs = Buffer.from([0]);
  const nameOff = [];
  for (const s of syms) { nameOff.push(strs.length); strs = Buffer.concat([strs, Buffer.from(s.name + '\0', 'latin1')]); }
  const symtab = Buffer.alloc(24 * (syms.length + 1));
  syms.forEach((s, i) => {
    const o = 24 * (i + 1);
    symtab.writeUInt32LE(nameOff[i], o);
    symtab[o + 4] = s.func ? 0x12 : 0x11; // GLOBAL FUNC / GLOBAL OBJECT
    symtab.writeUInt16LE(1, o + 6);
    symtab.writeBigUInt64LE(BigInt(s.value), o + 8);
    symtab.writeBigUInt64LE(BigInt(s.size || 0), o + 16);
  });
  const symOff = 64;
  const strOff = symOff + symtab.length;
  const shOff = strOff + strs.length;
  const eh = Buffer.alloc(64);
  eh.writeUInt32BE(0x7f454c46, 0); eh[4] = 2; eh[5] = 1; eh[6] = 1;
  eh.writeBigUInt64LE(BigInt(shOff), 0x28); eh.writeUInt16LE(64, 0x3a); eh.writeUInt16LE(3, 0x3c);
  const sh = Buffer.alloc(64 * 3);
  const sec = (i, type, off, size, link, entsize) => {
    sh.writeUInt32LE(type, i * 64 + 4); sh.writeBigUInt64LE(BigInt(off), i * 64 + 0x18); sh.writeBigUInt64LE(BigInt(size), i * 64 + 0x20);
    sh.writeUInt32LE(link, i * 64 + 0x28); sh.writeBigUInt64LE(BigInt(entsize), i * 64 + 0x38);
  };
  sec(1, 2, symOff, symtab.length, 2, 24); // SHT_SYMTAB, strings in section 2
  sec(2, 3, strOff, strs.length, 0, 0);    // SHT_STRTAB
  fs.writeFileSync(file, Buffer.concat([eh, symtab, strs, sh]));
}

test('profile: ELF function symbols and address lookup', () => {
  const elfsym = require('../lib/analysis/elfsym');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-elf-'));
  try {
    const f = path.join(dir, 'vmlinux');
    makeSymElf(f, [
      { name: '_text', value: '0xffff800008000000' },
      { name: 'kimage_vaddr', value: '0xffff800009130000' },
      { name: 'cpu_do_idle', value: '0xffff8000091072d0', size: 0x20, func: true },
      { name: 'do_idle', value: '0xffff800008100000', size: 0x100, func: true },
      { name: 'asm_entry', value: '0xffff800008200000', func: true }, // no size: up to 64 KiB or the next one
    ]);
    const s = elfsym.readSymbols(f);
    assert.deepStrictEqual(s.functions.map((x) => x.name), ['do_idle', 'asm_entry', 'cpu_do_idle']);
    assert.strictEqual(s.find('kimage_vaddr'), 0xffff800009130000n);
    assert.strictEqual(s.find('nope'), undefined);
    const at = (a) => { const r = elfsym.lookup(s.functions, a); return r ? r.name : null; };
    assert.strictEqual(at(0xffff8000091072d0n), 'cpu_do_idle');
    assert.strictEqual(at(0xffff8000091072efn), 'cpu_do_idle');
    assert.strictEqual(at(0xffff8000091072f0n), null); // past its size
    assert.strictEqual(at(0xffff800008100050n), 'do_idle');
    assert.strictEqual(at(0xffff800008200100n), 'asm_entry');
    assert.strictEqual(at(0xffff800008210000n), null); // more than 64 KiB past a sizeless symbol
    assert.strictEqual(at(0xffff800007000000n), null); // before the first
    fs.writeFileSync(path.join(dir, 'x'), 'not elf');
    assert.throws(() => elfsym.readSymbols(path.join(dir, 'x')), /is not an ELF file/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('profile: KASLR offset, per-function sums and the symbol warning', () => {
  const prof = require('../lib/analysis/profile');
  assert.strictEqual(prof.isArm64Image('41524d64'), true);
  assert.strictEqual(prof.isArm64Image('00000000'), false);
  const syms = { find: (n) => ({ _text: 0xffff800008000000n, kimage_vaddr: 0xffff800009130000n })[n] };
  assert.deepStrictEqual(prof.kimageVaddrOffset(syms), { offset: 0x1130000n, text: 0xffff800008000000n });
  assert.strictEqual(prof.kimageVaddrOffset({ find: () => undefined }), undefined);
  // Runtime _text 0xffffc98ba1600000, as read (little-endian) from guest memory.
  assert.strictEqual(prof.kaslrOffset('000060a18bc9ffff', 0xffff800008000000n), 0x498b99600000n);
  const fns = [{ name: 'do_idle', start: 0xffff800008100000n, size: 0x100n }, { name: 'cpu_do_idle', start: 0xffff8000091072d0n, size: 0x20n }];
  const off = 0x498b99600000n;
  const blocks = [
    ['0x' + (0xffff8000091072d0n + off).toString(16), 60], ['0x' + (0xffff800008100010n + off).toString(16), 25],
    ['0x' + (0xffff800008100020n + off).toString(16), 5], ['0xffffffffc0000000', 4], ['0x0000aaaabbbb0000', 6],
  ];
  const s = prof.summarize(blocks, fns, off);
  assert.strictEqual(s.total, 100);
  assert.deepStrictEqual(s.rows.map((r) => [r.name, r.samples, r.space, r.resolved]), [
    ['cpu_do_idle', 60, 'kernel', true], ['do_idle', 30, 'kernel', true], ['[user space]', 6, 'user', false], ['[kernel, no symbol]', 4, 'kernel', false],
  ]);
  assert.deepStrictEqual(s.kernel, { samples: 94, resolved: 90 });
  assert.strictEqual(prof.symbolWarning(s, true), '');
  const wrong = prof.summarize(blocks, fns, 0n); // without the KASLR offset nothing fits
  assert.match(prof.symbolWarning(wrong, true), /Only 0% of the kernel samples .* KASLR offset is unknown/);
  assert.match(prof.symbolWarning(prof.summarize(blocks, [], 0n), false), /No symbol file/);
  assert.strictEqual(prof.symbolWarning(prof.summarize([['0x400000', 3]], [], 0n), false), ''); // user space only: nothing to say
});

test('ftrace: parse, match calls and returns, name, summarize, write a Chrome trace', () => {
  const ftrace = require('../lib/analysis/ftrace');
  const K = 0xffff800008000000n;
  const OFF = 0x1234600000n; // KASLR, 2 MiB steps
  const fns = [
    { name: 'main_loop', start: K + 0x1000n, size: 0x100n },
    { name: 'work', start: K + 0x2000n, size: 0x100n },
    { name: 'leaf', start: K + 0x3000n, size: 0x100n },
    { name: 'tail', start: K + 0x4000n, size: 0x100n },
    { name: 'cpu_switch_to', start: K + 0x5000n, size: 0x100n },
  ];
  const run = (n) => fns.find((f) => f.name === n).start + OFF;
  // [kind, from, to, ns, insns]
  const cpu0 = [
    [1, run('main_loop') + 0x10n, run('work'), 100, 1000],      // main_loop -> work
    [1, run('work') + 0x20n, run('leaf'), 150, 1010],           //   work -> leaf
    [2, run('leaf') + 0x40n, run('work') + 0x24n, 200, 1030],   //   leaf returns
    [1, run('work') + 0x30n, run('leaf'), 210, 1040],           //   work -> leaf (again)
    [2, run('leaf') + 0x40n, run('work') + 0x34n, 260, 1050],
    [1, run('work') + 0x50n, run('tail'), 270, 1060],           //   work -> tail, which returns to main_loop (as after a tail call)
    [2, run('tail') + 0x8n, run('main_loop') + 0x14n, 300, 1100],
    [2, run('main_loop') + 0x80n, 0x400000n, 310, 1110],        // return without a recorded call
    [1, run('main_loop') + 0x90n, 0xfffffbff00001000n, 320, 1120], // call into a module
    [2, 0xfffffbff00001010n, run('main_loop') + 0x94n, 330, 1130],
  ];
  const cpu3 = [
    [1, 0x400100n, 0x400800n, 50, 10],                          // user space
    [1, run('work') + 0x60n, run('cpu_switch_to'), 60, 20],
    [2, run('cpu_switch_to') + 0x40n, run('work') + 0x64n, 90, 40], // to another task, at the same return address
    [1, run('work') + 0x20n, run('leaf'), 95, 50],              // still open at the end
  ];
  const cpus = [[0, cpu0, cpu0.length], [3, cpu3, 9]];
  const parts = [Buffer.from('VPFTRC01', 'latin1'), Buffer.alloc(8)];
  parts[1].writeUInt32LE(1, 0); parts[1].writeUInt32LE(cpus.length, 4);
  for (const [cpu, ev, total] of cpus) {
    const h = Buffer.alloc(24);
    h.writeUInt32LE(cpu, 0); h.writeBigUInt64LE(BigInt(total), 8); h.writeBigUInt64LE(BigInt(ev.length), 16);
    parts.push(h);
    for (const [kind, from, to, ns, insns] of ev) {
      const r = Buffer.alloc(32);
      r.writeBigUInt64LE(from | BigInt(kind), 0); r.writeBigUInt64LE(to, 8);
      r.writeBigUInt64LE(BigInt(ns), 16); r.writeBigUInt64LE(BigInt(insns), 24);
      parts.push(r);
    }
  }
  const tr = ftrace.parse(Buffer.concat(parts));
  assert.strictEqual(tr.cpus.length, 2);
  assert.deepStrictEqual(tr.cpus[0].events[0], { kind: 1, from: run('main_loop') + 0x10n, to: run('work'), ns: 100, insns: 1000 });
  assert.throws(() => ftrace.parse(Buffer.from('nope')), /not a VP Studio function trace/);
  assert.throws(() => ftrace.parse(Buffer.concat(parts).subarray(0, 100)), /truncated/);

  assert.strictEqual(ftrace.guessOffset(tr, fns), OFF);
  const b = ftrace.build(tr, { functions: fns, offset: OFF });
  assert.strictEqual(b.start, 50);
  assert.strictEqual(b.end, 330);
  const c0 = b.cpus[0];
  assert.deepStrictEqual(c0.slices.map((s) => [s.name, s.start, s.end, s.depth, s.insns, s.self]), [
    ['work', 100, 300, 0, 100, 30],
    ['leaf', 150, 200, 1, 20, 20],
    ['leaf', 210, 260, 1, 10, 10],
    ['tail', 270, 300, 1, 40, 40],
    ['module 0xfffffbff00001000', 320, 330, 0, 10, 10],
  ]);
  assert.strictEqual(c0.unmatched, 1);
  const c3 = b.cpus[1];
  assert.deepStrictEqual(c3.slices.map((s) => [s.name, s.depth, s.open]), [
    ['user 0x400800', 0, true], ['cpu_switch_to', 1, true], ['leaf', 0, true]]);
  assert.strictEqual(c3.switches, 1);
  assert.deepStrictEqual(b.functions.get('leaf'), { calls: 3, insns: 30 + 0, self: 30, ns: 100 + 0, user: false });
  const top = ftrace.topFunctions(b, 2);
  assert.deepStrictEqual(top.map((f) => f.name), ['tail', 'leaf']);

  const md = ftrace.summary(b, { title: 'Function trace: demo', symbolFile: 'vmlinux', offset: OFF, jsonFile: 'demo.json' });
  assert.ok(/^# Function trace: demo/.test(md));
  assert.ok(/14 calls and returns on 2 CPUs/.test(md), md);
  assert.ok(/kept only the newest records on cpu 3 \(4 of 9\)/.test(md), md);
  assert.ok(/KASLR offset 0x1234600000/.test(md));
  assert.ok(/\| `work` \| 1 \| 30 \|/.test(md), md);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vps-ft-'));
  const file = path.join(dir, 't.json');
  ftrace.writeChromeTrace(file, b, { title: 'demo' });
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const x = j.traceEvents.filter((e) => e.ph === 'X');
  assert.strictEqual(x.length, 8);
  // CPU n is tid n + 1: Perfetto treats tid 0 as the idle thread and merges it into another track.
  assert.deepStrictEqual(x[0], { ph: 'X', name: 'work', pid: 1000, tid: 1, ts: 0.05, dur: 0.2, args: { insns: 100, self: 30 } });
  assert.ok(j.traceEvents.some((e) => e.ph === 'M' && e.name === 'thread_name' && e.tid === 4 && e.args.name === 'cpu 3'));
  assert.ok(x.find((e) => e.tid === 4 && e.name === 'leaf').args.open);
  assert.ok(j.traceEvents.every((e) => e.tid !== 0 && e.tid !== e.pid));
  // Rounded ends: a callee never ends after its caller (Perfetto reports that as an import error).
  for (const t of new Set(x.map((e) => e.tid))) {
    const stack = [];
    for (const e of x.filter((y) => y.tid === t)) {
      const s0 = Math.round(e.ts * 1000), e0 = s0 + Math.round(e.dur * 1000);
      while (stack.length && stack[stack.length - 1] <= s0) stack.pop();
      if (stack.length) assert.ok(e0 <= stack[stack.length - 1], e.name);
      stack.push(e0);
    }
  }
  // Without symbols, kernel functions are addresses; without matches the offset is 0.
  assert.strictEqual(ftrace.build(tr).cpus[0].slices[0].name, '0x' + run('work').toString(16));
  assert.strictEqual(ftrace.guessOffset(tr, []), 0n);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ftrace: a BL whose function returns elsewhere ends its frame (JIT code, trampolines)', () => {
  const ftrace = require('../lib/analysis/ftrace');
  const M = 0xfffffbfffdbf7400n; // module space, no symbol
  const ev = (kind, from, to, ns, insns) => ({ kind, from, to, ns, insns });
  const fns = [{ name: 'run_prog', start: 0xffff800008001000n, size: 0x100n }];
  const tr = { cpus: [{ cpu: 0, total: 6, events: [
    ev(1, 0xffff800008001010n, 0xffff800008001000n, 0, 0),       // something -> run_prog (its caller's frame not recorded)
    ev(1, M + 0x1cn, M + 0x24n, 10, 100),                          //   bl +8 inside the JIT code
    ev(2, M + 0x74n, 0xffff800008001044n, 20, 121),                //   which returns into run_prog, not to M + 0x20
    ev(1, M + 0x1cn, M + 0x24n, 30, 200),
    ev(2, M + 0x74n, 0xffff800008001044n, 40, 221),
    ev(2, 0xffff800008001080n, 0xffff800008001014n, 50, 300),      // run_prog returns
  ] }] };
  const b = ftrace.build(tr, { functions: fns });
  assert.deepStrictEqual(b.cpus[0].slices.map((s) => [s.name, s.depth, s.insns, s.open]), [
    ['run_prog', 0, 300, false],
    ['module 0xfffffbfffdbf7424', 1, 21, false],
    ['module 0xfffffbfffdbf7424', 1, 21, false],
  ]);
  assert.strictEqual(b.cpus[0].unmatched, 0);
});

test('function trace: the last calls of a CPU (ftrace.tail) as indented rows and the open call chain', () => {
  const ft = require('../lib/analysis/ftrace');
  const fns = [
    { name: 'el0_svc', start: 0x1000n, size: 0x100n }, { name: 'do_sys_open', start: 0x2000n, size: 0x100n },
    { name: 'getname', start: 0x3000n, size: 0x100n }, { name: 'kmem_cache_alloc', start: 0x4000n, size: 0x100n },
    { name: 'strncpy_from_user', start: 0x5000n, size: 0x100n },
  ].map((f) => Object.assign(f, { start: f.start + 0xffff800008000000n }));
  const K = 0xffff800008000000n;
  const hex = (n) => '0x' + (K + BigInt(n)).toString(16);
  // el0_svc calls do_sys_open, which calls getname; getname calls kmem_cache_alloc (returns), then
  // strncpy_from_user, which faults: the chain el0_svc > do_sys_open > getname > strncpy_from_user is open.
  const res = { cpu: 2, total: 9, records: [
    [hex(0x1010 | 1), hex(0x2000), 10, 100],
    [hex(0x2020 | 1), hex(0x3000), 11, 120],
    [hex(0x3010 | 1), hex(0x4000), 12, 130],
    [hex(0x4050 | 2), hex(0x3014), 13, 160],
    [hex(0x3030 | 1), hex(0x5000), 14, 170],
  ] };
  const ev = ft.tailEvents(res);
  assert.deepStrictEqual(ev.map((e) => e.kind), [1, 1, 1, 2, 1]);
  const r = ft.recentCalls(ev, ft.namer(fns, 0n));
  assert.deepStrictEqual(r.rows.map((x) => [x.kind, x.depth, x.name, x.insnsBefore]), [
    ['call', 0, 'do_sys_open', 70], ['call', 1, 'getname', 50], ['call', 2, 'kmem_cache_alloc', 40], ['ret', 2, 'kmem_cache_alloc', 10], ['call', 2, 'strncpy_from_user', 0]]);
  assert.deepStrictEqual(r.open, ['do_sys_open', 'getname', 'strncpy_from_user']);
  assert.strictEqual(r.rows[0].site, 'el0_svc');
  // Returns out of frames opened before the records start: depths move left, then are shifted back to 0.
  const r2 = ft.recentCalls(ft.tailEvents({ records: [[hex(0x4050 | 2), hex(0x3014), 1, 1], [hex(0x3050 | 2), hex(0x2024), 2, 2], [hex(0x2010 | 1), hex(0x5000), 3, 3]] }), ft.namer(fns, 0n));
  assert.deepStrictEqual(r2.rows.map((x) => [x.kind, x.depth]), [['ret', 1], ['ret', 0], ['call', 0]]);
  assert.deepStrictEqual(ft.recentCalls([], ft.namer()).rows, []);
  // An exception right after a call: a "call" into the vector table opens no frame.
  const withVec = ev.concat(ft.tailEvents({ records: [[hex(0x5010 | 1), '0xfffffbfffdbf7480', 15, 180]] }));
  const r3 = ft.recentCalls(withVec, ft.namer(fns, 0n), { vectors: [0xfffffbfffdbf7480n] });
  assert.deepStrictEqual(r3.rows[r3.rows.length - 1].kind, 'exception');
  assert.deepStrictEqual(r3.open, ['do_sys_open', 'getname', 'strncpy_from_user']);
  assert.strictEqual(ft.recentCalls(withVec, ft.namer(fns, 0n)).open.length, 4);
});

test('profile: a user program\'s symbols name the user-space samples; ELF type and .text of a program', () => {
  const prof = require('../lib/analysis/profile');
  const elfsym = require('../lib/analysis/elfsym');
  const user = [{ name: 'filter', start: 0x400c00n, size: 0x40n }, { name: 'format_record', start: 0x400d40n, size: 0x100n }];
  const blocks = [['0x400c10', 7], ['0x400d80', 3], ['0x0000ffff8b8ffd3c', 5], ['0xffff800008100010', 2]];
  const s = prof.summarize(blocks, [], 0n, user);
  assert.deepStrictEqual(s.rows.map((r) => [r.name, r.samples, r.space, r.resolved]), [
    ['filter', 7, 'user', true], ['[user space, outside the program: libraries, other processes]', 5, 'user', false],
    ['format_record', 3, 'user', true], ['[kernel, no symbol]', 2, 'kernel', false],
  ]);
  assert.deepStrictEqual(s.user, { samples: 15, resolved: 10 });
  // Without a program: one row, as before.
  assert.deepStrictEqual(prof.summarize(blocks, [], 0n).rows[0], { name: '[user space]', samples: 15, space: 'user', resolved: false });
  // The tutorial programs are linked at a fixed address: Load Symbols fills in their .text.
  const bin = path.join(__dirname, '..', 'templates', 'tutorial', 'vplogger', 'bin', 'vplogger-bug');
  const info = elfsym.elfInfo(bin);
  assert.strictEqual(info.type, 'exec');
  assert.ok(info.text >= 0x400000n && info.text < 0x500000n, info.text.toString(16));
  const fns = elfsym.readSymbols(bin).functions.map((f) => f.name);
  for (const f of ['main', 'filter', 'format_record', 'write_all']) assert.ok(fns.includes(f), f);
  assert.throws(() => elfsym.elfInfo(__filename), /not an ELF/);
});

test('ftrace: the summary also ranks functions with their callees (a system call\'s whole path)', () => {
  const ftrace = require('../lib/analysis/ftrace');
  const built = {
    start: 0, end: 1e9, cpus: [{ cpu: 0, recorded: 10, total: 10, slices: [], unmatched: 0, switches: 0 }],
    functions: new Map([
      ['__arm64_sys_fsync', { calls: 2, insns: 9000, self: 100, ns: 1, user: false }],
      ['ext4_sync_file', { calls: 2, insns: 8800, self: 300, ns: 1, user: false }],
      ['memset', { calls: 50, insns: 2000, self: 2000, ns: 1, user: false }],
    ]),
  };
  const md = ftrace.summary(built, { limit: 4 });
  const own = md.indexOf('## Functions by own instructions');
  const trees = md.indexOf('## Functions by instructions with callees');
  assert.ok(own > 0 && trees > own, md);
  const part = md.slice(trees);
  assert.ok(part.indexOf('`__arm64_sys_fsync` | 2 | 9,000 | 4,500 | 100 |') > 0, part);
  assert.ok(part.indexOf('__arm64_sys_fsync') < part.indexOf('ext4_sync_file') && part.indexOf('ext4_sync_file') < part.indexOf('memset'));
});
