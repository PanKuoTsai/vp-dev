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
  const elfsym = require('../lib/elfsym');
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
  const prof = require('../lib/profile');
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
  const ftrace = require('../lib/ftrace');
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
  const ftrace = require('../lib/ftrace');
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
