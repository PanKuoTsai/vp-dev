'use strict';
// Run with: node test/connect.test.js (every file: npm test)
const { test } = require('./harness');
const assert = require('assert');
const core = require('../lib/core');
const jsonedit = require('../lib/jsonedit');
const modules = require('../lib/modules');
const connect = require('../lib/connect');
const { load, catalog, exampleText } = require('./helpers');

test('connections: port rows show bindings in both directions', () => {
  const d = load();
  const gic = connect.portRows(d, catalog, 'gic_0');
  const spi = gic.find((r) => r.name === 'spi_in');
  assert.deepStrictEqual([spi.kind, spi.vector], ['signal_in', true]);
  assert.ok(spi.in.some((i) => i.from === 'pl011_uart_0' && i.port === 'spi_in_379'));
  const irq = gic.find((r) => r.name === 'irq_out');
  assert.deepStrictEqual(irq.out.map((o) => [o.key, o.bind, o.repeat]), [['irq_out_{i}', 'cpu_{i}.irq_in', '${ARM_NUM_CPUS}']]);
  const dist = gic.find((r) => r.name === 'dist_iface');
  assert.deepStrictEqual([dist.out[0].address, dist.out[0].bind], ['${GICD_BASE}', 'router.initiator_socket']);
  const cpu = connect.portRows(d, catalog, 'cpu');
  assert.ok(cpu.find((r) => r.name === 'irq_in').in.some((i) => i.from === 'gic_0' && i.key === 'irq_out_{i}'));
  assert.deepStrictEqual(cpu.find((r) => r.name === 'halt').out.concat(cpu.find((r) => r.name === 'halt').in), []);
  const router = connect.portRows(d, catalog, 'router');
  assert.ok(router.find((r) => r.name === 'initiator_socket').in.length >= 8);
});

test('connections: compatible ports and modules, declaring end, indexes', () => {
  const d = load();
  assert.deepStrictEqual(connect.compatiblePorts(catalog, 'router', 'tlm_target').map((p) => p.name), ['initiator_socket']);
  const toGic = connect.compatiblePorts(catalog, 'arm_gicv3', 'signal_out').map((p) => p.name);
  assert.deepStrictEqual(toGic, ['spi_in', 'ppi_in_cpu']);
  assert.ok(connect.compatibleModules(d, catalog, 'pl011_uart_0', 'signal_out').includes('gic_0'));
  assert.ok(!connect.compatibleModules(d, catalog, 'pl011_uart_0', 'signal_out').includes('pl011_uart_0'));
  assert.strictEqual(connect.declaringEnd(d, 'router', 'ram_0'), 'b');
  assert.strictEqual(connect.declaringEnd(d, 'pl011_uart_0', 'gic_0'), 'a');
  assert.ok(connect.needsAddress(d, 'tlm_target', 'router'));
  assert.ok(!connect.needsAddress(d, 'tlm_initiator', 'router'));
  assert.strictEqual(connect.nextIndex(d, 'gic_0', 'spi_in'), 545); // highest SPI in use is 544
  assert.strictEqual(connect.nextIndex(d, 'gic_0', 'fiq_out'), 0);
  const a = core.analyze(d);
  assert.deepStrictEqual(connect.peerInstances(d, a, 'gic_0', 'cpu').slice(0, 2), ['cpu_0', 'cpu_1']);
  assert.deepStrictEqual(connect.peerInstances(d, a, 'cpu', 'cpu').slice(0, 2), ['cpu_{i}', 'cpu_0']);
  assert.strictEqual(connect.addressProblem('${UART0}+0x1000'), null);
  assert.ok(connect.addressProblem('0xZZ'));
  assert.strictEqual(connect.indexProblem('{i}', true), null);
  assert.ok(connect.indexProblem('{i}', false));
});

test('connections: bind and unbind edits', () => {
  const text = exampleText();
  // A new UART on the bus and the GIC.
  let t = jsonedit.apply(text, modules.addModuleEdit(text, 'uart1', modules.moduleDef(catalog, 'Pl011', [])));
  t = jsonedit.apply(t, connect.bindEdit(t, 'uart1', 'target_socket', { address: '0x9100000', size: '0x1000', bind: 'router.initiator_socket' }));
  t = jsonedit.apply(t, connect.bindEdit(t, 'uart1', 'irq', { bind: 'gic_0.spi_in_380' }));
  const d = JSON.parse(t);
  assert.deepStrictEqual(d.modules.uart1.ports, {
    target_socket: { address: '0x9100000', size: '0x1000', bind: 'router.initiator_socket' },
    irq: { bind: 'gic_0.spi_in_380' },
  });
  assert.ok(t.includes('"target_socket": { "address": "0x9100000", "size": "0x1000", "bind": "router.initiator_socket" }'));
  const a = core.analyze(d, { catalog });
  assert.ok(a.memoryMap.some((m) => m.instance === 'uart1' && m.start === 0x9100000n));
  assert.deepStrictEqual(a.problems.filter((p) => p.module === 'uart1' && p.severity === 'error'), []);
  // Unbind the incoming one from the GIC's point of view.
  const item = connect.incoming(d, 'gic_0').find((i) => i.from === 'uart1');
  t = jsonedit.apply(t, connect.unbindEdit(t, item));
  assert.deepStrictEqual(Object.keys(JSON.parse(t).modules.uart1.ports), ['target_socket']);
  // Per-instance binding.
  const t3 = jsonedit.apply(text, connect.bindEdit(text, 'cpu', 'halt', { bind: 'gic_0.spi_in_500' }, '2'));
  assert.deepStrictEqual(JSON.parse(t3).modules.cpu.perIndex['2'], { ports: { halt: { bind: 'gic_0.spi_in_500' } } });
});
