'use strict';
// Run with: node test/registers.test.js (every file: npm test)
const { test } = require('./harness');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const core = require('../lib/platform/core');
const registers = require('../lib/analysis/registers');

test('registers: the bundled descriptions load and cover the example platform', () => {
  const { descs, problems } = registers.loadDir(path.join(__dirname, '..', 'registers'));
  assert.deepStrictEqual(problems, []);
  assert.deepStrictEqual(descs.map((d) => path.basename(d.file)), ['gicv3-dist.json', 'pl011.json', 'virtio-mmio.json']);
  const pl011 = descs.find((d) => d.port === 'target_socket').registers;
  // Arrays and field sets expand; sorted by offset.
  assert.deepStrictEqual(pl011.filter((r) => r.name.startsWith('UARTPeriphID')).map((r) => [r.name, '0x' + r.offset.toString(16)]),
    [['UARTPeriphID0', '0xfe0'], ['UARTPeriphID1', '0xfe4'], ['UARTPeriphID2', '0xfe8'], ['UARTPeriphID3', '0xfec']]);
  assert.deepStrictEqual(pl011.find((r) => r.name === 'UARTMIS').fields.map((f) => f.name).slice(0, 6), ['RIM', 'CTSM', 'DCDM', 'DSRM', 'RX', 'TX']);
  assert.strictEqual(pl011.find((r) => r.name === 'UARTDR').readSideEffect, true);
  const gic = descs.find((d) => d.port === 'dist_iface').registers;
  assert.strictEqual(gic.filter((r) => r.name.startsWith('GICD_ISENABLER')).length, 32);
  assert.strictEqual(gic.find((r) => r.name === 'GICD_ISENABLER12').offset, 0x130n);

  const doc = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'templates', 'ubuntu-aarch64.platform.json'), 'utf8'));
  const ps = registers.peripherals(doc, descs, core.analyze(doc).buses);
  assert.deepStrictEqual(ps.map((p) => `${p.id}@0x${p.address.toString(16)}/${p.bus}#${p.busIndex}`),
    ['pl011_uart_0.target_socket@0x10000000/router#0', 'gic_0.dist_iface@0x17a00000/router#0',
      'virtioblk_0.mem@0x1c0d0000/router#0', 'virtionet0_0.mem@0x1c120000/router#0']);
  assert.deepStrictEqual(registers.peripherals(doc, descs, []), []); // a bus the agent is not on: nothing to read
});

test('registers: descriptions are checked', () => {
  const bad = (registers_, re) => assert.throws(() => registers.expand({ registers: registers_ }, 'x.json'), re);
  bad([{ name: 'A' }], /register A: offset must be a number/);
  bad([{ name: 'A', offset: 0, size: 3 }], /size must be 1, 2, 4 or 8/);
  bad([{ name: 'A', offset: 0, access: 'rx' }], /access must be rw, ro, wo or w1c/);
  bad([{ name: 'A', offset: 0, size: 1, fields: [{ name: 'F', bits: '8' }] }], /field F has bits "8", outside the 8-bit register/);
  bad([{ name: 'A', offset: 0, fields: [{ name: 'F', bits: '3:5' }] }], /field F has bits "3:5"/);
  bad([{ name: 'A', offset: 0, fieldsLike: 'nope' }], /no field set nope/);
  bad([{ name: 'A0', offset: 0 }, { name: 'A', offset: 4, count: 2 }], /two registers named A0/);
  bad([{ name: '1A', offset: 0 }], /no valid name/);
  // A wizard model's spec is a description of its target_socket.
  const m = registers.fromModelSpec({ name: 'my_timer', registers: [{ name: 'CTRL', offset: '0x0', fields: [{ name: 'EN', bits: '0' }] }, { name: 'ID', offset: '0xfc', access: 'ro' }] }, '/m/my_timer.model.json');
  assert.deepStrictEqual([m.types, m.port, m.registers.map((r) => r.name)], [['my_timer'], 'target_socket', ['CTRL', 'ID']]);
});

test('registers: values, fields and the bytes of mem.read / mem.write', () => {
  assert.strictEqual(registers.fromBytes('76697274'), 0x74726976n); // little-endian, as the bus returns it
  assert.strictEqual(registers.fromBytes('5a00'), 0x5an);
  assert.strictEqual(registers.toBytes(0x74726976n, 4), '76697274');
  assert.strictEqual(registers.toBytes(0x0an, 2), '0a00');
  assert.strictEqual(registers.toBytes(0xffffffffffffffffn, 8), 'ffffffffffffffff');
  const reg = { size: 4, fields: [{ name: 'UARTEN', msb: 0, lsb: 0 }, { name: 'TXE', msb: 8, lsb: 8 }, { name: 'WLEN', msb: 6, lsb: 5 }] };
  const d = registers.decode(reg, 0x361n);
  assert.deepStrictEqual(d.fields.map((f) => [f.name, f.value]), [['UARTEN', 1n], ['TXE', 1n], ['WLEN', 3n]]);
  assert.strictEqual(registers.withField(0x361n, reg.fields[2], 1n), 0x321n); // only bits 6:5 change
  assert.strictEqual(registers.withField(0x361n, reg.fields[1], 0n), 0x261n);
  assert.strictEqual(registers.hexOf(0x30n, 4), '0x0000_0030');
  assert.strictEqual(registers.hexOf(0x5an, 1), '0x5a');
  assert.strictEqual(registers.hexOf(0x1234n, 8), '0x0000_0000_0000_1234');
  assert.strictEqual(registers.bitsText(reg.fields[2]), '[6:5]');
  assert.strictEqual(registers.bitsText(reg.fields[0]), '[0]');
  assert.strictEqual(registers.parseValue('0x30', 32), 0x30n);
  assert.strictEqual(registers.parseValue('0b11', 2), 3n);
  assert.strictEqual(registers.parseValue('0x0000_0030', 32), 0x30n);
  assert.throws(() => registers.parseValue('4', 2), /Too large: 2 bits hold at most 0x3/);
  assert.throws(() => registers.parseValue('-1', 8), /Enter a number/);
  assert.strictEqual(registers.notReadReason({ access: 'wo' }), 'write-only');
  assert.strictEqual(registers.notReadReason({ access: 'rw', readSideEffect: true }), 'reading it changes the device');
  assert.strictEqual(registers.notReadReason({ access: 'ro' }), '');
});

test('gic: layout, reads and the state of each interrupt with why it is not delivered', () => {
  const gic = require('../lib/analysis/gic');
  const doc = JSON.parse(JSON.stringify(require('../templates/ubuntu-aarch64.platform.json')));
  const [g] = gic.layout(doc);
  assert.strictEqual(g.name, 'gic_0');
  assert.strictEqual(g.dist, 0x17a00000n);
  assert.strictEqual(g.redist, 0x17a60000n);
  assert.deepStrictEqual(g.sources.get(50), [{ module: 'virtionet0_0', port: 'irq_out' }]); // spi_in_18
  assert.strictEqual(g.sources.get(30).length, 8); // the physical timer of every CPU
  // Probe: GICD_TYPER.ITLinesNumber 1 (64 INTIDs), DS and Group 1 and ARE on; two redistributors, the second the last.
  const hex = (b) => b.toString('hex');
  const head = Buffer.alloc(16); head.writeUInt32LE(0x40 | 0x10 | 0x2, 0); head.writeUInt32LE(1, 4);
  const rd = (cpu, aff, last, waker) => { const b = Buffer.alloc(24); b.writeBigUInt64LE((BigInt(aff) << 32n) | (BigInt(cpu) << 8n) | (last ? 0x10n : 0n), 8); b.writeUInt32LE(waker, 0x14); return b; };
  const probeReads = gic.probeReads(g);
  assert.strictEqual(gic.redistFrames(g), 14); // 0x1C0000 / 0x20000
  assert.strictEqual(gic.redistHeadRead(g, 1).address, 0x17a80000n);
  const probeData = gic.gather([
    { read: probeReads[0], data: hex(head) }, { read: gic.redistHeadRead(g, 0), data: hex(rd(0, 0, false, 0)) }, { read: gic.redistHeadRead(g, 1), data: hex(rd(1, 1, true, 6)) },
  ]);
  const probe = gic.parseProbe(g, probeData);
  assert.strictEqual(probe.lines, 64);
  assert.deepStrictEqual(probe.redists.map((r) => [r.cpu, r.affinity, r.last]), [[0, 0, false], [1, 1, true]]);
  const reads = gic.stateReads(g, probe);
  assert.ok(reads.every((r) => r.size <= 4096 && r.size % r.width === 0));
  assert.ok(reads.filter((r) => r.key === 'IROUTER').every((r) => r.width === 8));
  // An agent without mem.read's width: one request per register, same data.
  const one = gic.oneByOne(reads.filter((r) => r.key === 'ISENABLER'));
  assert.deepStrictEqual([one.length, one[1].offset, one[1].address, one[1].size], [2, 4, 0x17a00104n, 4]);
  // State: INTID 50 enabled, group 1, priority 0xa0, level, routed to CPU 1 (asleep);
  // INTID 33 enabled with priority 0xFF and pending; INTID 34 routed to an affinity nobody has.
  const n = 64; const bits = () => Buffer.alloc(n / 8);
  const set = (b, i) => { b[i >> 3] |= 1 << (i & 7); return b; };
  const en = set(set(set(bits(), 50), 33), 34); const grp = set(set(set(bits(), 50), 33), 34); const pend = set(bits(), 33);
  const prio = Buffer.alloc(n, 0xa0); prio[33] = 0xff;
  const route = Buffer.alloc((n - 32) * 8); route.writeBigUInt64LE(1n, (50 - 32) * 8); route.writeBigUInt64LE(5n, (34 - 32) * 8);
  const byKey = { IGROUPR: grp, ISENABLER: en, ISPENDR: pend, ISACTIVER: bits(), IPRIORITYR: prio, ICFGR: Buffer.alloc(n / 4), IGRPMODR: bits(), IROUTER: route };
  const res = reads.map((r) => ({ read: r, data: hex(byKey[r.key] ? byKey[r.key].subarray(r.offset, r.offset + r.size) : Buffer.alloc(r.size)) }));
  const st = gic.interpret(g, probe, new Map([...gic.gather(res), ...probeData]));
  assert.deepStrictEqual(st.dist, { lines: 64, ds: true, grp0: false, grp1: true, are: true });
  assert.deepStrictEqual(st.cpus.map((c) => [c.cpu, c.asleep]), [[0, false], [1, true]]);
  const row = (id, cpu) => st.rows.find((r) => r.intid === id && (cpu === undefined || r.cpu === cpu));
  const r50 = row(50);
  assert.deepStrictEqual([r50.enabled, r50.group, r50.priority, r50.edge, r50.route.text], [true, 'G1', 0xa0, false, 'CPU 1']);
  assert.match(r50.problems[0].text, /redistributor is asleep/);
  assert.match(row(33).problems.map((p) => p.text).join(' | '), /priority 0xFF.*\| .*pending/);
  assert.match(row(34).problems[0].text, /affinity 0.0.0.5, which no CPU has/);
  // PPIs come per CPU; CPU 0's physical timer is wired but not enabled.
  assert.strictEqual(st.rows.filter((r) => r.intid === 30).length, 2);
  assert.match(row(30, 0).problems[0].text, /disabled/);
  assert.deepStrictEqual(row(30, 0).sources, [{ module: 'cpu_0', port: 'irq_timer_phys_out', cpu: 0 }]);
  assert.ok(!gic.interesting(row(40)));
  assert.deepStrictEqual(gic.summary(st).enabled, 3);
});

test('registers: what changed since the last stop, and the register at an address', () => {
  const registers = require('../lib/analysis/registers');
  const reg = { name: 'CR', offset: 0x30n, size: 4, fields: [{ name: 'UARTEN', msb: 0, lsb: 0 }, { name: 'TXE', msb: 8, lsb: 8 }, { name: 'RXE', msb: 9, lsb: 9 }] };
  assert.deepStrictEqual(registers.changedFields(reg, 0x301n, 0x201n), [{ name: 'TXE', now: 1n, was: 0n }]);
  assert.deepStrictEqual(registers.changedFields(reg, 0x301n, 0x301n), []);
  assert.deepStrictEqual(registers.changedFields(reg, 0x301n, undefined), []);
  const periphs = [{ id: 'uart', address: 0x9000000n, registers: [{ name: 'DR', offset: 0n, size: 4 }, reg] }];
  assert.strictEqual(registers.registerAt(periphs, 0x9000032n).reg.name, 'CR');
  assert.strictEqual(registers.registerAt(periphs, '0x9000000').reg.name, 'DR');
  assert.strictEqual(registers.registerAt(periphs, 0x9000034n), undefined);
});
