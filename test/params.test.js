'use strict';
// Run with: node test/params.test.js (every file: npm test)
const { test } = require('./harness');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const core = require('../lib/platform/core');
const jsonedit = require('../lib/platform/jsonedit');
const params = require('../lib/platform/params');
const { load, catalog, exampleText } = require('./helpers');

test('param form: catalog parameters, set ones first, Lua and per-instance values', () => {
  const d = load();
  const forms = params.moduleForms(d, core.analyze(d), catalog);
  const cpu = forms.get('cpu');
  assert.strictEqual(cpu.status, 'ok');
  assert.strictEqual(cpu.count, 8);
  const names = cpu.rows.map((r) => r.name);
  assert.deepStrictEqual(names.slice(0, 6), Object.keys(d.modules.cpu.params));
  assert.ok(names.includes('gdb_port') && !cpu.rows.find((r) => r.name === 'gdb_port').set);
  const el3 = cpu.rows.find((r) => r.name === 'has_el3');
  assert.deepStrictEqual([el3.kind, el3.set, el3.input, el3.default], ['bool', true, 'false', true]);
  assert.ok(cpu.rows.find((r) => r.name === 'psci_conduit').lua);
  const rvbar = cpu.rows.find((r) => r.name === 'rvbar');
  assert.deepStrictEqual([rvbar.kind, rvbar.input, rvbar.resolved], ['uint', '${INITIAL_DDR_SPACE}', '0x80000000']);
  assert.strictEqual(cpu.rows.find((r) => r.name === 'gdb_port').type, 'uint');
  assert.deepStrictEqual(cpu.rows.find((r) => r.name === 'start_powered_off').overriddenIn, ['cpu_0']);
});

test('param form: one scope per replica, inheriting the values for all', () => {
  const d = load();
  const cpu = params.moduleForms(d, core.analyze(d), catalog).get('cpu');
  assert.deepStrictEqual(cpu.scopes.map((s) => s.name), ['cpu_0', 'cpu_1', 'cpu_2', 'cpu_3', 'cpu_4', 'cpu_5', 'cpu_6', 'cpu_7']);
  const s0 = cpu.scopes[0].rows;
  assert.strictEqual(s0[0].name, 'start_powered_off'); // set for cpu_0 itself: first
  assert.deepStrictEqual([s0[0].set, s0[0].value, s0[0].inherited], [true, false, true]);
  const el3 = s0.find((r) => r.name === 'has_el3');
  assert.deepStrictEqual([el3.set, el3.inheritedSet, el3.blankLabel], [false, true, 'same as all (false)']);
  const rv = cpu.scopes[3].rows.find((r) => r.name === 'rvbar');
  assert.deepStrictEqual([rv.placeholder, rv.resolved], ['all: "${INITIAL_DDR_SPACE}"', '0x80000000']);
  assert.strictEqual(cpu.scopes[3].rows.find((r) => r.name === 'gdb_port').placeholder, 'default 0');
  assert.deepStrictEqual(params.moduleForms(d, core.analyze(d), catalog).get('router').scopes, []);
});

test('param form: gdb_port is locked for all replicas of a CPU, free for one', () => {
  const d = load();
  let cpu = params.moduleForms(d, core.analyze(d), catalog).get('cpu');
  assert.ok(/one gdb server/.test(cpu.rows.find((r) => r.name === 'gdb_port').locked));
  assert.strictEqual(cpu.scopes[0].rows.find((r) => r.name === 'gdb_port').locked, '');
  // Already set for all (the error case): stays editable so it can be reset.
  d.modules.cpu.params.gdb_port = 1234;
  cpu = params.moduleForms(d, core.analyze(d), catalog).get('cpu');
  assert.strictEqual(cpu.rows.find((r) => r.name === 'gdb_port').locked, '');
});

test('param form: unknown names, log_level, and modules the catalog cannot describe', () => {
  const d = load();
  d.modules.router.params.no_such = 1;
  d.modules.pl011_uart_0.type = 'NotAType';
  const forms = params.moduleForms(d, core.analyze(d), catalog);
  const router = forms.get('router');
  assert.ok(router.rows.find((r) => r.name === 'no_such').unknown);
  const ll = router.rows.find((r) => r.name === 'log_level');
  assert.deepStrictEqual([ll.unknown, ll.kind], [false, 'int']);
  const uart = forms.get('pl011_uart_0');
  assert.strictEqual(uart.status, 'unknown');
  assert.ok(/not in the component catalog/.test(uart.note));
  assert.strictEqual(params.moduleForms(d, core.analyze(d), undefined).get('cpu').status, 'nocatalog');
});

test('param input: parsing by kind', () => {
  const p = params.parseInput;
  assert.deepStrictEqual(p('  ', 'uint'), { reset: true });
  assert.deepStrictEqual(p('true', 'bool'), { value: true });
  assert.ok(p('yes', 'bool').error);
  assert.deepStrictEqual(p('1234', 'uint'), { value: 1234 });
  assert.deepStrictEqual(p('0x40000000', 'uint'), { value: '0x40000000' });
  assert.deepStrictEqual(p('${RAM} + 0x100', 'uint'), { value: '${RAM} + 0x100' });
  assert.deepStrictEqual(p('-3', 'int'), { value: -3 });
  assert.ok(p('-3', 'uint').error);
  assert.deepStrictEqual(p('18446744073709551615', 'uint'), { value: '0xffffffffffffffff' });
  assert.ok(p('12abc', 'int').error);
  assert.deepStrictEqual(p('2.5e-3', 'float'), { value: 0.0025 });
  assert.ok(p('fast', 'float').error);
  assert.deepStrictEqual(p(' keep spaces ', 'string'), { value: ' keep spaces ' });
  assert.deepStrictEqual(p('[10, "ns"]', 'json'), { value: [10, 'ns'] });
  assert.ok(p('[10, ns]', 'json').error);
  assert.ok(p('{"$lua":"x"}', 'json').error);
});

test('param edits: change, add, create params, reset; rest of the file untouched', () => {
  const text = exampleText();
  const d = JSON.parse(text);
  // change an existing value
  let t = jsonedit.apply(text, params.setParamEdit(text, 'cpu', 'has_el3', true));
  assert.strictEqual(JSON.parse(t).modules.cpu.params.has_el3, true);
  assert.strictEqual(t.length, text.length - 1); // "false" -> "true" is the only change
  // add a new one
  t = jsonedit.apply(text, params.setParamEdit(text, 'cpu', 'gdb_port', 1234));
  assert.strictEqual(JSON.parse(t).modules.cpu.params.gdb_port, 1234);
  assert.ok(t.startsWith(text.slice(0, text.indexOf('"rvbar"'))));
  // module without "params"
  assert.strictEqual(d.modules.keep_alive_0.params, undefined);
  t = jsonedit.apply(text, params.setParamEdit(text, 'keep_alive_0', 'log_level', 3));
  const after = JSON.parse(t);
  assert.deepStrictEqual(after.modules.keep_alive_0.params, { log_level: 3 });
  assert.deepStrictEqual(Object.assign({}, after, { modules: Object.assign({}, after.modules, { keep_alive_0: d.modules.keep_alive_0 }) }), d);
  assert.ok(/\n {6}"params": \{\n {8}"log_level": 3\n {6}\}/.test(t));
  // reset
  t = jsonedit.apply(text, params.resetParamEdit(text, 'cpu', 'has_el2'));
  assert.ok(!('has_el2' in JSON.parse(t).modules.cpu.params));
  assert.strictEqual(params.resetParamEdit(text, 'cpu', 'gdb_port'), undefined);
  assert.throws(() => params.setParamEdit(text, 'nope', 'x', 1), /no longer exists/);
});

test('param edits for one replica create perIndex entries as needed', () => {
  const text = exampleText();
  const d = JSON.parse(text);
  const cpuOf = (t) => JSON.parse(t).modules.cpu;
  // existing perIndex["0"].params
  let t = jsonedit.apply(text, params.setParamEdit(text, 'cpu', 'gdb_port', 1234, '0'));
  assert.deepStrictEqual(cpuOf(t).perIndex['0'].params, { start_powered_off: false, gdb_port: 1234 });
  assert.strictEqual(cpuOf(t).params.gdb_port, undefined);
  assert.deepStrictEqual(core.analyze(JSON.parse(t)).problems.filter((p) => /gdb/.test(p.message)), []);
  // new index entry
  t = jsonedit.apply(text, params.setParamEdit(text, 'cpu', 'has_el2', true, '5'));
  assert.deepStrictEqual(cpuOf(t).perIndex['5'], { params: { has_el2: true } });
  assert.ok(/\n {8}"5": \{\n {10}"params": \{\n {12}"has_el2": true\n {10}\}\n {8}\}/.test(t));
  // no perIndex at all
  const d2 = JSON.parse(text);
  delete d2.modules.cpu.perIndex;
  const t2 = JSON.stringify(d2, null, 2);
  const t3 = jsonedit.apply(t2, params.setParamEdit(t2, 'cpu', 'gdb_port', 1234, '0'));
  assert.deepStrictEqual(cpuOf(t3).perIndex, { 0: { params: { gdb_port: 1234 } } });
  // remove an override
  t = jsonedit.apply(text, params.resetParamEdit(text, 'cpu', 'start_powered_off', '0'));
  assert.deepStrictEqual(cpuOf(t).perIndex['0'].params, {});
  assert.strictEqual(params.resetParamEdit(text, 'cpu', 'start_powered_off', '3'), undefined);
  assert.deepStrictEqual(d.modules.cpu.perIndex['0'].params, { start_powered_off: false }); // input untouched
});

// ------------------------------------------------------------------ setting parameters at run time
test('set param: input text is checked by category and C++ type', () => {
  const sa = require('../lib/sim/simagent');
  const u32 = { category: 'integer', type: 'uint32_t', value: 7 };
  assert.deepStrictEqual(sa.parseParamValue(' 0x10 ', u32), { json: '16' });
  assert.deepStrictEqual(sa.parseParamValue('4294967295', u32), { json: '4294967295' });
  assert.match(sa.parseParamValue('4294967296', u32).error, /uint32_t holds 0 to 4294967295/);
  assert.match(sa.parseParamValue('-1', u32).error, /holds 0/);
  assert.match(sa.parseParamValue('1.5', u32).error, /whole number/);
  assert.deepStrictEqual(sa.parseParamValue('-128', { category: 'integer', type: 'int8_t' }), { json: '-128' });
  // 64-bit values keep every digit (they are sent as JSON text).
  assert.deepStrictEqual(sa.parseParamValue('0xffffffffffffffff', { category: 'integer', type: 'uint64_t' }), { json: '18446744073709551615' });
  assert.deepStrictEqual(sa.parseParamValue('12', { category: 'integer', type: 'my_int' }), { json: '12' });
  assert.deepStrictEqual(sa.parseParamValue('true', { category: 'bool' }), { json: 'true' });
  assert.match(sa.parseParamValue('yes', { category: 'bool' }).error, /true or false/);
  assert.deepStrictEqual(sa.parseParamValue('2e-3', { category: 'real' }), { json: '0.002' });
  assert.match(sa.parseParamValue('abc', { category: 'real' }).error, /number/);
  assert.deepStrictEqual(sa.parseParamValue(' a "b" ', { category: 'string' }), { json: '" a \\"b\\" "' });
  assert.deepStrictEqual(sa.parseParamValue('', { category: 'string' }), { json: '""' });
  assert.deepStrictEqual(sa.parseParamValue('[1, 2]', { category: 'list' }), { json: '[1, 2]' });
  assert.match(sa.parseParamValue('[1,', { category: 'list' }).error, /Use JSON/);
  assert.strictEqual(sa.paramInputText({ value: 'smc' }), 'smc');
  assert.strictEqual(sa.paramInputText({ value: [1, 2] }), '[1,2]');
  assert.strictEqual(sa.paramInputText({ value: null }), '');
  assert.strictEqual(sa.readOnlyReason({ value: 1, mutability: 'mutable', locked: false }), undefined);
  assert.match(sa.readOnlyReason({ value: 1, locked: true }), /locked/);
  assert.match(sa.readOnlyReason({ value: 1, mutability: 'immutable' }), /immutable/);
  assert.match(sa.readOnlyReason({ value: null }), /no JSON/);
});

test('set param: runtime names map to platform modules and replicas', () => {
  const params = require('../lib/platform/params');
  const doc = load();
  const a = core.analyze(doc);
  assert.deepStrictEqual(params.runtimeTarget(doc, a, 'platform.cpu_3.gdb_port'), { base: 'cpu', index: '3', name: 'gdb_port', instance: 'cpu_3' });
  const t = params.runtimeTarget(doc, a, 'platform.qemu_inst.tcg_mode');
  assert.deepStrictEqual(t, { base: 'qemu_inst', index: null, name: 'tcg_mode', instance: 'qemu_inst' });
  assert.strictEqual(params.runtimeTarget(doc, a, 'platform.sim_agent.port'), undefined);
  assert.strictEqual(params.runtimeTarget(doc, a, 'log_level'), undefined);
  // A parameter of the top container: saved in platform.params (2026-11-15: set from the
  // Simulation Parameters view as "platform.gdb_port", where no Save in Platform was offered).
  assert.deepStrictEqual(params.runtimeTarget(doc, a, 'platform.gdb_port'), { platform: true, name: 'gdb_port' });
  const pt = fs.readFileSync(path.join(__dirname, '..', 'examples', 'ubuntu-aarch64.platform.json'), 'utf8');
  const pe = params.setPlatformParamEdit(pt, 'gdb_port', 5555);
  const pd = JSON.parse(pt.slice(0, pe.start) + pe.text + pt.slice(pe.end));
  assert.strictEqual(pd.platform.params.gdb_port, 5555);
  assert.strictEqual(pd.platform.params.quantum_ns, JSON.parse(pt).platform.params.quantum_ns);
  const bare = '{\n  "name": "x",\n  "modules": {}\n}\n';
  const be = params.setPlatformParamEdit(bare, 'log_level', 3);
  assert.deepStrictEqual(JSON.parse(bare.slice(0, be.start) + be.text + bare.slice(be.end)).platform, { params: { log_level: 3 } });
  assert.strictEqual(params.schemaValue(5n), 5);
  assert.strictEqual(params.schemaValue(0xffffffffffffffffn), '0xffffffffffffffff');
  assert.strictEqual(params.schemaValue(true), true);
  // Saving it writes the replica's perIndex entry.
  const text = fs.readFileSync(path.join(__dirname, '..', 'examples', 'ubuntu-aarch64.platform.json'), 'utf8');
  const e = params.setParamEdit(text, 'cpu', 'gdb_port', 4321, '3');
  const out = text.slice(0, e.start) + e.text + text.slice(e.end);
  assert.strictEqual(JSON.parse(out).modules.cpu.perIndex['3'].params.gdb_port, 4321);
});
