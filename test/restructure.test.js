'use strict';
// Run with: node test/restructure.test.js (every file: npm test)
const { test } = require('./harness');
const assert = require('assert');
const fs = require('fs');
const core = require('../lib/platform/core');
const { examplePath, catalog } = require('./helpers');

// ------------------------------------------------------------------ replace a model, group into a subsystem

test('replace model: A76 -> A53 keeps the CPU connections and drops the two ports A53 lacks', () => {
  const rs = require('../lib/platform/restructure');
  const text = fs.readFileSync(examplePath, 'utf8');
  const doc = JSON.parse(text);
  const plan = rs.swapPlan(doc, catalog, 'cpu', 'cpu_arm_cortexA53');
  assert.deepStrictEqual(plan.lost.map((l) => l.port), ['gicv3_maintenance_interrupt', 'pmu_interrupt']);
  assert.ok(plan.keep.includes('mem') && plan.keep.includes('irq_in'));
  assert.deepStrictEqual(plan.args, { old: [{ ref: 'qemu_inst' }], now: [{ ref: 'qemu_inst' }], changed: false, ask: [] });
  const out = rs.swapText(text, doc, plan, plan.args.now);
  const d = JSON.parse(out);
  assert.strictEqual(d.modules.cpu.type, 'cpu_arm_cortexA53');
  assert.ok(!d.modules.cpu.ports.gicv3_maintenance_interrupt && !d.modules.cpu.ports.pmu_interrupt);
  assert.deepStrictEqual(core.analyze(d, { catalog }).problems, []);
  // Only the CPU's lines change.
  const e = require('../lib/platform/modules').minimalEdit(text, out);
  assert.ok(text.slice(0, e.start).endsWith('"type": "cpu_arm_cortexA'));
  // Best fits first: the A710 has every port; A53 loses two connections.
  const ch = rs.swapChoices(doc, catalog, 'cpu');
  assert.strictEqual(ch[0].type, 'cpu_arm_cortexA710');
  assert.strictEqual(ch.find((c) => c.type === 'cpu_arm_cortexA53').lost, 2);
});

test('replace model: PL011 -> qemu_pl011 renames ports, adds the QEMU instance, drops the library', () => {
  const rs = require('../lib/platform/restructure');
  const text = fs.readFileSync(examplePath, 'utf8');
  const doc = JSON.parse(text);
  const plan = rs.swapPlan(doc, catalog, 'pl011_uart_0', 'qemu_pl011');
  assert.deepStrictEqual(plan.rename.map((r) => `${r.from}>${r.to}`), ['target_socket>mem', 'irq>irq_out']);
  assert.deepStrictEqual(plan.lost.map((l) => l.port), ['backend_socket']);
  assert.deepStrictEqual(plan.args.now, [{ ref: 'qemu_inst' }]);
  assert.deepStrictEqual(plan.dylib, { old: 'uart-pl011', now: undefined });
  const d = JSON.parse(rs.swapText(text, doc, plan, plan.args.now));
  const u = d.modules.pl011_uart_0;
  assert.deepStrictEqual(Object.keys(u.ports), ['mem', 'irq_out']);
  assert.deepStrictEqual(u.ports.mem, { address: '${UART0}', size: '0x1000', bind: 'router.initiator_socket' });
  assert.strictEqual(u.dylib, undefined);
  assert.deepStrictEqual(u.args, [{ ref: 'qemu_inst' }]);
});

test('replace model: bindings other modules write to a renamed port follow it', () => {
  const rs = require('../lib/platform/restructure');
  const text = fs.readFileSync(examplePath, 'utf8');
  const doc = JSON.parse(text);
  // A made-up GIC whose shared interrupt inputs are called "shared_in".
  const cat2 = JSON.parse(JSON.stringify(catalog));
  const gic = JSON.parse(JSON.stringify(cat2.modules.arm_gicv3));
  gic.introspection.ports = gic.introspection.ports.map((p) => (p.name === 'spi_in' ? Object.assign({}, p, { name: 'shared_in' }) : p));
  cat2.modules.fake_gic = gic;
  const plan = rs.swapPlan(doc, cat2, 'gic_0', 'fake_gic');
  assert.deepStrictEqual(plan.rename.map((r) => `${r.from}>${r.to}`), ['spi_in>shared_in']);
  const d = JSON.parse(rs.swapText(text, doc, plan, plan.args.now));
  assert.strictEqual(d.modules.gpex_0.ports.irq_out_0.bind, 'gic_0.shared_in_541');
  assert.strictEqual(d.modules.pl011_uart_0.ports.irq.bind, 'gic_0.shared_in_379');
  assert.strictEqual(d.modules.gic_0.type, 'fake_gic');
});

test('group into a subsystem: moves the text, rewrites references from outside, keeps every connection', () => {
  const rs = require('../lib/platform/restructure');
  const text = fs.readFileSync(examplePath, 'utf8');
  const doc = JSON.parse(text);
  const plan = rs.groupPlan(doc, ['gic_0'], 'irqs');
  assert.ok(plan.rewrites.length > 0);
  assert.ok(plan.rewrites.some((w) => w.module === 'gpex_0' && w.from === 'gic_0.spi_in_541' && w.to === 'irqs.gic_0.spi_in_541'));
  const out = rs.groupText(text, plan);
  const d = JSON.parse(out);
  assert.strictEqual(d.modules.gic_0, undefined);
  assert.strictEqual(d.modules.irqs.type, 'Container');
  assert.deepStrictEqual(d.modules.irqs.modules.gic_0, doc.modules.gic_0);
  // The moved text keeps its own lines, one level deeper.
  assert.ok(out.includes('\n        "gic_0": {\n          "type": "arm_gicv3",'));
  const a = core.analyze(d, { catalog });
  assert.deepStrictEqual(a.problems, []);
  assert.strictEqual(a.connections.length, core.analyze(doc).connections.length);
  // Several modules at once; the subsystem takes the place of the first.
  const two = JSON.parse(rs.groupText(text, rs.groupPlan(doc, ['virtioblk_0', 'pl011_uart_0'], 'periph')));
  assert.deepStrictEqual(Object.keys(two.modules.periph.modules), Object.keys(doc.modules).filter((k) => k === 'virtioblk_0' || k === 'pl011_uart_0'));
  assert.strictEqual(Object.keys(two.modules).indexOf('periph'), Object.keys(doc.modules).indexOf('virtioblk_0'));
  // Refused: a taken name, modules from different subsystems.
  assert.throws(() => rs.groupPlan(doc, ['gic_0'], 'ram_0'), /already used/);
  assert.throws(() => rs.groupPlan(two, ['periph.pl011_uart_0', 'gic_0'], 'x'), /same subsystem/);
});
