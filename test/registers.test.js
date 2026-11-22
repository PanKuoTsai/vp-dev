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
