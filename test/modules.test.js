'use strict';
// Run with: node test/modules.test.js (every file: npm test)
const { test } = require('./harness');
const assert = require('assert');
const core = require('../lib/platform/core');
const jsonedit = require('../lib/platform/jsonedit');
const modules = require('../lib/platform/modules');
const { load, catalog, exampleText } = require('./helpers');

test('module types to add: from the catalog, containers hidden, summarized', () => {
  const choices = modules.typeChoices(catalog);
  const names = choices.map((c) => c.type);
  assert.ok(names.includes('Pl011') && names.includes('cpu_arm_cortexA53') && !names.includes('Container'));
  assert.ok(/ports · \d+ params · needs QemuInstance$/.test(choices.find((c) => c.type === 'cpu_arm_cortexA53').summary));
});

test('new module names: suggested, validated against modules and replicas', () => {
  const d = load();
  const a = core.analyze(d);
  assert.strictEqual(modules.suggestName(d, a, 'Pl011'), 'pl011_0');
  assert.strictEqual(modules.suggestName(d, a, 'gs_memory'), 'gs_memory_0');
  assert.strictEqual(modules.nameProblem(d, a, 'uart1'), null);
  assert.ok(/already used/.test(modules.nameProblem(d, a, 'router')));
  assert.ok(/already used/.test(modules.nameProblem(d, a, 'cpu_3')));
  assert.ok(/instance of cpu/.test(modules.nameProblem(d, a, 'cpu_9')));
  assert.ok(modules.nameProblem(d, a, '9lives'));
});

test('constructor arguments: classes, candidates, defaults, dylib', () => {
  const d = load();
  const a = core.analyze(d);
  const qi = modules.argSpecs(catalog, 'QemuInstance');
  assert.deepStrictEqual(qi.map((s) => [s.ref, s.expects]), [[true, 'QemuInstanceManager'], [false, 'std::string']]);
  assert.deepStrictEqual(modules.argCandidates(a, 'QemuInstanceManager'), { exact: true, names: ['qemu_inst_mgr'] });
  assert.strictEqual(modules.existingArg(d, 'QemuInstance', 1), 'AARCH64');
  const dev = modules.argCandidates(a, 'QemuDevice');
  assert.strictEqual(dev.exact, false);
  assert.ok(dev.names.includes('cpu_0'));
  assert.deepStrictEqual(modules.moduleDef(catalog, 'Pl011', []), { type: 'Pl011', dylib: 'uart-pl011' });
  assert.deepStrictEqual(modules.moduleDef(catalog, 'arm_gicv3', [{ ref: 'qemu_inst' }]), { type: 'arm_gicv3', args: [{ ref: 'qemu_inst' }] });
});

test('add module edit: appended to modules in the file style, analyzable', () => {
  const text = exampleText();
  const t = jsonedit.apply(text, modules.addModuleEdit(text, 'uart1', modules.moduleDef(catalog, 'Pl011', [])));
  const d = JSON.parse(t);
  assert.deepStrictEqual(d.modules.uart1, { type: 'Pl011', dylib: 'uart-pl011' });
  assert.strictEqual(Object.keys(d.modules).pop(), 'uart1');
  assert.ok(/\n {4}"uart1": \{\n {6}"type": "Pl011",\n {6}"dylib": "uart-pl011"\n {4}\}/.test(t));
  const t2 = jsonedit.apply(text, modules.addModuleEdit(text, 'gic1', modules.moduleDef(catalog, 'arm_gicv3', [{ ref: 'qemu_inst' }])));
  assert.ok(t2.includes('"args": [{ "ref": "qemu_inst" }]'));
  assert.deepStrictEqual(core.analyze(JSON.parse(t2), { catalog }).problems.filter((p) => p.severity === 'error'), []);
});

test('delete plan: bindings to the module, blockers that take it as an argument', () => {
  const d = load();
  const gic = modules.deletePlan(d, 'gic_0');
  assert.deepStrictEqual(gic.blockers, []);
  const fromCpu = gic.bindings.filter((b) => b.module === 'cpu');
  assert.strictEqual(fromCpu.length, 6);
  assert.ok(gic.bindings.some((b) => b.module === 'pl011_uart_0' && b.port === 'irq'));
  const qi = modules.deletePlan(d, 'qemu_inst');
  assert.ok(qi.blockers.some((b) => b.module === 'cpu') && qi.blockers.some((b) => b.module === 'gic_0'));
  assert.throws(() => modules.deletePlan(d, 'nope'), /no longer exists/);
});

test('delete module: removes it and its bindings, rest untouched, one minimal edit', () => {
  const text = exampleText();
  const d = JSON.parse(text);
  const plan = modules.deletePlan(d, 'pl011_uart_0');
  const after = modules.deleteModuleText(text, 'pl011_uart_0', plan);
  const a = JSON.parse(after);
  assert.ok(!('pl011_uart_0' in a.modules));
  for (const b of plan.bindings) assert.ok(!(b.port in a.modules[b.module].ports));
  // Nothing else changed.
  const expect = JSON.parse(text);
  delete expect.modules.pl011_uart_0;
  for (const b of plan.bindings) delete expect.modules[b.module].ports[b.port];
  assert.deepStrictEqual(a, expect);
  assert.deepStrictEqual(core.analyze(a).problems.filter((p) => /unknown instance/.test(p.message)), []);
  const e = modules.minimalEdit(text, after);
  assert.strictEqual(jsonedit.apply(text, e), after);
  assert.ok(e.end - e.start < text.length / 2);
});
