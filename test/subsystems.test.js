'use strict';
// Run with: node test/subsystems.test.js (every file: npm test)
const { test } = require('./harness');
const assert = require('assert');
const core = require('../lib/platform/core');
const { load } = require('./helpers');

// ------------------------------------------------------------------ subsystems (nested containers)
/** The Ubuntu example with pl011_uart_0 and virtioblk_0 in a "periph" container, as booted on 2026-11-15. */
function nested() {
  const d = load();
  const m = {};
  for (const [k, v] of Object.entries(d.modules)) {
    if (k === 'pl011_uart_0' || k === 'virtioblk_0') continue;
    m[k] = v;
    if (k === 'charbackend_stdio_0') m.periph = { type: 'Container', modules: { pl011_uart_0: d.modules.pl011_uart_0, virtioblk_0: d.modules.virtioblk_0 } };
  }
  d.modules = m;
  return d;
}

test('subsystems: names resolve from the inside out, and to full paths', () => {
  const d = nested();
  d.modules.periph.modules.sub = { type: 'Container', modules: { mem: { type: 'gs_memory', ports: { target_socket: { address: '0x1d000000', size: '0x1000', bind: 'router.initiator_socket' } } } } };
  d.modules.periph.modules.router = { type: 'router' };
  const fl = core.flatten(d);
  assert.deepStrictEqual([...fl.containers], ['periph', 'periph.sub']);
  // pl011 in periph: "router" now means periph.router (nearest), "gic_0" the top-level one.
  assert.strictEqual(fl.modules['periph.pl011_uart_0'].ports.target_socket.bind, 'periph.router.initiator_socket');
  assert.strictEqual(fl.modules['periph.pl011_uart_0'].ports.irq.bind, 'gic_0.spi_in_379');
  assert.strictEqual(fl.modules['periph.sub.mem'].ports.target_socket.bind, 'periph.router.initiator_socket');
  // Top-level modules are untouched; the container entry has no "modules".
  assert.strictEqual(fl.modules.ram_0.ports.target_socket.bind, 'router.initiator_socket');
  assert.strictEqual(fl.modules.periph.modules, undefined);
  assert.strictEqual(fl.modules.periph.container, true);
  assert.deepStrictEqual(fl.shadows.map((s) => `${s.inner}>${s.outer}`), ['periph.router>router']);
  assert.deepStrictEqual(core.jsonPath('periph.sub.mem'), ['modules', 'periph', 'modules', 'sub', 'modules', 'mem']);
  // Replicas and {i} resolve through their base.
  assert.strictEqual(fl.resolve('cpu_3', 'periph.sub'), 'cpu_3');
  assert.strictEqual(fl.resolve('cpu_{i}', 'periph'), 'cpu_{i}');
  assert.strictEqual(fl.resolve('nothing', 'periph'), 'nothing');
  // The shortest name that gets back, or an error when hidden.
  assert.strictEqual(core.refFor(d, 'periph.sub.mem', 'periph.router'), 'router');
  assert.strictEqual(core.refFor(d, 'periph.sub.mem', 'gic_0'), 'gic_0');
  assert.strictEqual(core.refFor(d, 'ram_0', 'periph.sub.mem'), 'periph.sub.mem');
  assert.throws(() => core.refFor(d, 'periph.pl011_uart_0', 'router'), /hides it/);
});

test('subsystems: analysis, memory map and Lua of the booted nested platform', () => {
  const d = nested();
  const a = core.analyze(d);
  assert.deepStrictEqual(a.problems, []);
  const names = a.instances.map((i) => i.name);
  assert.ok(names.includes('periph') && names.includes('periph.pl011_uart_0') && names.includes('periph.virtioblk_0'));
  assert.ok(a.memoryMap.some((r) => r.instance === 'periph.pl011_uart_0' && r.start === 0x10000000n && r.bus === 'router'));
  assert.ok(a.connections.some((c) => c.from === 'periph.pl011_uart_0' && c.to === 'charbackend_stdio_0' && c.toPort === 'biflow_socket'));
  const lua = core.generate(d);
  // Same Lua as the hand-made test that booted: binds out of the container are absolute.
  assert.match(lua, /\n    periph = \{\n        moduletype = "Container";\n\n        pl011_uart_0 = \{\n            moduletype = "Pl011";\n            dylib_path = "uart-pl011";\n            target_socket = \{address = UART0, size = 0x1000, bind = "&platform.router.initiator_socket"\};\n            irq = \{bind = "&platform.gic_0.spi_in_379"\};\n            backend_socket = \{bind = "&platform.charbackend_stdio_0.biflow_socket"\};\n        \};\n/);
  assert.match(lua, /        virtioblk_0 = \{\n            moduletype = "virtio_mmio_blk";\n            args = \{"&platform.qemu_inst"\};/);
  assert.match(lua, /\n    \};\n\n    global_peripheral_initiator_arm_0 = \{/);
  // A bind inside the container stays relative; overrides reach nested tables.
  d.modules.periph.modules.cb = { type: 'char_backend_stdio' };
  d.modules.periph.modules.pl011_uart_0.ports.backend_socket.bind = 'cb.biflow_socket';
  const lua2 = core.generate(d, { overrides: [{ instance: 'periph.pl011_uart_0', param: 'log_level', value: 3 }], portOverrides: [{ instance: 'periph.virtioblk_0', port: 'mem', value: { bind: 'vp_trace.initiator_socket' } }] });
  assert.match(lua2, /backend_socket = \{bind = "&cb.biflow_socket"\};/);
  assert.match(lua2, /\nplatform\["periph"\]\["pl011_uart_0"\]\["log_level"\] = 3\n/);
  assert.match(lua2, /\nplatform\["periph"\]\["virtioblk_0"\]\["mem"\] = \{bind = "&platform.vp_trace.initiator_socket"\}\n/);
  // Containers cannot be replicated or have ports.
  d.modules.periph.count = 2;
  d.modules.periph.ports = { x: { bind: 'router.target_socket' } };
  const msgs = core.analyze(d).problems.map((p) => p.message).join('\n');
  assert.match(msgs, /periph: a container cannot be replicated/);
  assert.match(msgs, /periph: a container has no ports/);
});

test('subsystems: editing modules and connections inside a container', () => {
  const modules = require('../lib/platform/modules');
  const connect = require('../lib/platform/connect');
  const params = require('../lib/platform/params');
  const jsonedit = require('../lib/platform/jsonedit');
  let text = JSON.stringify(nested(), null, 2);
  const doc = () => JSON.parse(text);
  const an = () => core.analyze(doc());
  // Names are per container; hiding an outer module is refused.
  assert.strictEqual(modules.nameProblem(doc(), an(), 'pl011_uart_0', 'periph') !== null, true);
  assert.strictEqual(modules.nameProblem(doc(), an(), 'uart_x', ''), null);
  assert.strictEqual(modules.nameProblem(doc(), an(), 'uart_x', 'periph'), null);
  assert.match(modules.nameProblem(doc(), an(), 'router', 'periph'), /would hide router/);
  assert.match(modules.nameProblem(doc(), an(), 'virtioblk_0', ''), /would be hidden inside periph/);
  assert.strictEqual(modules.suggestName(doc(), an(), 'Pl011', 'periph'), 'pl011_0');
  assert.deepStrictEqual(modules.containerChoices(doc()), ['', 'periph']);
  // Add a module into periph, with a constructor argument written as the shortest name.
  text = jsonedit.apply(text, modules.addModuleEdit(text, 'rtc_0', { type: 'pl031', args: [{ ref: 'qemu_inst' }] }, 'periph'));
  assert.deepStrictEqual(doc().modules.periph.modules.rtc_0, { type: 'pl031', args: [{ ref: 'qemu_inst' }] });
  // Connect it to the top-level bus: written relative to periph, read back as full paths.
  text = jsonedit.apply(text, connect.bindEdit(text, 'periph.rtc_0', 'mem', { address: '0x9010000', size: '0x1000', bind: 'router.initiator_socket' }));
  assert.deepStrictEqual(doc().modules.periph.modules.rtc_0.ports.mem, { address: '0x9010000', size: '0x1000', bind: 'router.initiator_socket' });
  assert.ok(connect.incoming(doc(), 'router').some((i) => i.from === 'periph.rtc_0' && i.port === 'initiator_socket'));
  assert.ok(connect.declared(doc(), 'periph.pl011_uart_0').some((x) => x.bind === 'charbackend_stdio_0.biflow_socket'));
  // A parameter of a nested module, and its runtime name.
  text = jsonedit.apply(text, params.setParamEdit(text, 'periph.rtc_0', 'log_level', 2));
  assert.strictEqual(doc().modules.periph.modules.rtc_0.params.log_level, 2);
  assert.deepStrictEqual(params.runtimeTarget(doc(), an(), 'platform.periph.rtc_0.log_level'), { base: 'periph.rtc_0', index: null, name: 'log_level', instance: 'periph.rtc_0' });
  // A new container, then a module in it (creates its "modules").
  text = jsonedit.apply(text, modules.addModuleEdit(text, 'sub', { type: 'Container', modules: {} }, 'periph'));
  text = jsonedit.apply(text, modules.addModuleEdit(text, 'm', { type: 'gs_memory' }, 'periph.sub'));
  assert.deepStrictEqual(doc().modules.periph.modules.sub, { type: 'Container', modules: { m: { type: 'gs_memory' } } });
  // Deleting a module inside: other modules' bindings to it go too.
  let plan = modules.deletePlan(doc(), 'periph.pl011_uart_0');
  assert.deepStrictEqual(plan.blockers, []);
  // Deleting the container: everything inside, and outside bindings into it.
  const d = doc();
  d.modules.gic_0.ports = Object.assign({}, d.modules.gic_0.ports, { irq_from_rtc: { bind: 'periph.rtc_0.mem' } });
  text = JSON.stringify(d, null, 2);
  plan = modules.deletePlan(doc(), 'periph');
  assert.deepStrictEqual(plan.bindings.map((b) => `${b.module}.${b.port}`), ['gic_0.irq_from_rtc']);
  assert.deepStrictEqual(plan.contents.sort(), ['periph.pl011_uart_0', 'periph.rtc_0', 'periph.sub', 'periph.sub.m', 'periph.virtioblk_0']);
  text = modules.deleteModuleText(text, 'periph', plan);
  assert.strictEqual(doc().modules.periph, undefined);
  assert.strictEqual(doc().modules.gic_0.ports.irq_from_rtc, undefined);
  // An argument into the container blocks the deletion.
  const d2 = nested();
  d2.modules.x = { type: 'foo', args: [{ ref: 'periph.virtioblk_0' }] };
  assert.deepStrictEqual(modules.deletePlan(d2, 'periph').blockers, [{ module: 'x', ref: 'periph.virtioblk_0' }]);
});

test('subsystems: definitions are found by JSON position, nested or not', () => {
  const modules = require('../lib/platform/modules');
  const text = JSON.stringify(nested(), null, 2);
  const at = (m, p) => { const o = modules.definitionOffset(text, m, p); return o === null ? null : text.slice(o, o + 40).split('\n')[0]; };
  assert.strictEqual(at('periph.pl011_uart_0'), '"pl011_uart_0": {');
  assert.strictEqual(at('periph.pl011_uart_0', 'irq'), '"irq": {');
  assert.strictEqual(at('periph'), '"periph": {');
  // A replica's port written with {i}, and an instance name instead of the base.
  assert.strictEqual(at('gic_0', 'irq_out_3'), '"irq_out_{i}": {');
  assert.strictEqual(at('cpu_5', 'mem'), '"mem": {');
  // pl011_uart_0 at the top level does not exist any more.
  assert.strictEqual(at('pl011_uart_0'), null);
  assert.strictEqual(modules.definitionOffset('{ bad', 'x'), null);
});

test('subsystems: device tree and tracing see nested modules', () => {
  const d = nested();
  const r = require('../lib/generate/devicetree').generate(d, { fileSize: () => 16 });
  assert.match(r.dts, /periph_pl011_uart_0: serial@10000000 \{[^}]*interrupts = <0x0 0x17b 0x4>;/);
  assert.match(r.dts, /periph_virtioblk_0: virtio_mmio@1c0d0000 \{/);
  const trace = require('../lib/analysis/trace');
  const pts = trace.tracePoints(d).map((p) => p.id);
  assert.ok(pts.includes('periph.pl011_uart_0.target_socket'));
  const t = trace.traceOptions(d, ['periph.pl011_uart_0.target_socket'], '/x/vp_sim_agent');
  assert.strictEqual(t.extraModules[0].name, 'trace_periph_pl011_uart_0_target_socket');
  assert.strictEqual(t.extraModules[0].ports.target_socket.bind, 'router.initiator_socket');
  const lua = core.generate(d, t);
  assert.match(lua, /\nplatform\["periph"\]\["pl011_uart_0"\]\["target_socket"\] = \{address = UART0, size = 0x1000, bind = "&platform.trace_periph_pl011_uart_0_target_socket.initiator_socket"\}\n/);
});
