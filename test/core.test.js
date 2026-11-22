'use strict';
// Run with: node test/core.test.js (every file: npm test)
const { test } = require('./harness');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const core = require('../lib/platform/core');
const { load } = require('./helpers');

test('example expands to 22 instances with 8 CPUs', () => {
  const a = core.analyze(load());
  assert.strictEqual(a.instances.length, 22);
  assert.strictEqual(a.instances.filter((i) => i.base === 'cpu').length, 8);
  assert.deepStrictEqual(a.problems, []);
});

// With more than one CPU in MTTCG mode, SystemC can end the simulation during
// an IPI hand-off unless something keeps a suspending channel attached.
test('multi-CPU MTTCG example keeps SystemC alive', () => {
  const d = load();
  assert.strictEqual(d.modules.qemu_inst.params.tcg_mode, 'MULTI');
  assert.strictEqual(d.modules.keep_alive_0.type, 'keep_alive');
  const lua = core.generate(d);
  assert.ok(/keep_alive_0 = \{\s*moduletype = "keep_alive";/.test(lua));
});

test('memory map resolves variables and is sorted', () => {
  const a = core.analyze(load());
  const ram = a.memoryMap.find((m) => m.instance === 'ram_0');
  assert.strictEqual(ram.start, 0x80000000n);
  assert.strictEqual(ram.end, 0x17fffffffn);
  const redist = a.memoryMap.find((m) => m.port === 'redist_iface_0');
  assert.strictEqual(redist.start, 0x17a60000n);
  for (let i = 1; i < a.memoryMap.length; i++) assert.ok(a.memoryMap[i - 1].start <= a.memoryMap[i].start);
});

test('perIndex override applies to replica 0 only', () => {
  const lua = core.generate(load());
  const cpu0 = lua.slice(lua.indexOf('cpu_0 = '), lua.indexOf('cpu_1 = '));
  const cpu1 = lua.slice(lua.indexOf('cpu_1 = '), lua.indexOf('cpu_2 = '));
  assert.ok(cpu0.includes('start_powered_off = false;'));
  assert.ok(cpu1.includes('start_powered_off = true;'));
  assert.ok(cpu1.includes('"&gic_0.ppi_in_cpu_1_30"'));
});

test('repeat expands GIC outputs per CPU', () => {
  const lua = core.generate(load());
  for (let i = 0; i < 8; i++) assert.ok(lua.includes(`irq_out_${i} = {bind = "&cpu_${i}.irq_in"};`));
  assert.ok(!lua.includes('{i}'));
});

test('changing ARM_NUM_CPUS changes the CPU count', () => {
  const d = load();
  d.variables.find((v) => v.name === 'ARM_NUM_CPUS').value = 4;
  const a = core.analyze(d);
  assert.strictEqual(a.instances.filter((i) => i.base === 'cpu').length, 4);
  assert.deepStrictEqual(a.problems, []);
});

test('unknown bind target is an error', () => {
  const d = load();
  d.modules.pl011_uart_0.ports.irq.bind = 'gic_9.spi_in_379';
  const errs = core.analyze(d).problems.filter((p) => p.severity === 'error');
  assert.strictEqual(errs.length, 1);
  assert.ok(errs[0].message.includes('gic_9'));
});

test('unknown args reference is an error', () => {
  const d = load();
  d.modules.gic_0.args = [{ ref: 'nope' }];
  assert.ok(core.analyze(d).problems.some((p) => p.severity === 'error' && p.message.includes('nope')));
});

test('same-priority overlap is a warning, different priority is not', () => {
  const d = load();
  d.modules.pl011_uart_0.ports.target_socket.address = '0x17A00000';
  const w = core.analyze(d).problems.filter((p) => p.severity === 'warning');
  assert.strictEqual(w.length, 1);
  assert.ok(w[0].message.includes('overlap'));
});

test('non-constant count is reported, not thrown', () => {
  const d = load();
  d.modules.cpu.count = { $lua: 'N' };
  const a = core.analyze(d);
  assert.strictEqual(a.problems[0].severity, 'error');
});

test('launcher overrides are appended after the platform table', () => {
  const lua = core.generate(load(), { overrides: [{ instance: 'cpu_0', param: 'gdb_port', value: 1234 }] });
  assert.ok(lua.trimEnd().endsWith('platform["cpu_0"]["gdb_port"] = 1234'));
});

test('strings are escaped and templated', () => {
  const d = load();
  d.modules.router.params.note = 'a "quoted" \\ ${TOP}x';
  const lua = core.generate(d);
  assert.ok(lua.includes('note = "a \\"quoted\\" \\\\ "..top().."x";'));
});

test('schema accepts the debug section and elf entries', () => {
  let Ajv;
  // Optional: only when ajv 8 is installed. The schemas are draft 2020-12, which is ajv/dist/2020;
  // an older ajv (ESLint brings ajv 6 into node_modules) does not have it and cannot read them.
  try { Ajv = require('ajv/dist/2020'); } catch (e) { return; }
  const ajv = new Ajv({ strict: false });
  const validate = ajv.compile(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'schemas', 'qbox-platform.schema.json'), 'utf8')));
  const d = load();
  d.debug = { symbols: ['${TOP}vmlinux'] };
  assert.ok(validate(d), JSON.stringify(validate.errors));
});

test('generate: extraModules are added to the platform after the table', () => {
  const lua = core.generate(load(), {
    extraModules: [{ name: 'vp_sim_agent', type: 'vp_sim_agent', dylib: '/opt/vp "x"/vp_sim_agent', params: { port: 51000, host: '127.0.0.1' } }],
  });
  const line = lua.split('\n').find((l) => l.startsWith('platform["vp_sim_agent"]'));
  assert.strictEqual(line,
    'platform["vp_sim_agent"] = { moduletype = "vp_sim_agent"; dylib_path = "/opt/vp \\"x\\"/vp_sim_agent"; port = 51000; host = "127.0.0.1" }');
  assert.ok(lua.indexOf(line) > lua.lastIndexOf('\n};'));
});

test('generate: extraModules refuse a name the platform already uses', () => {
  assert.throws(() => core.generate(load(), { extraModules: [{ name: 'cpu', type: 'x' }] }), /already has a module/);
});

test('bundled modules: platforms name the type only; the library path is supplied at generation', () => {
  const models = require('../lib/generate/models');
  const modules = require('../lib/platform/modules');
  const base = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'catalog', 'qbox-catalog.json'), 'utf8'));
  const a76 = base.modules.cpu_arm_cortexA76;
  // A made-up bundled module (the mechanism stays; VP Studio ships none since the
  // Cortex-A73 module was removed): the A76 ports and parameters, plus midr.
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-a73-'));
  const intro = JSON.parse(JSON.stringify(a76.introspection));
  intro.params.push({ name: 'midr', type: 'unsigned long', default: 0x410fd092 });
  fs.writeFileSync(path.join(dir, 'c.catalog.json'), JSON.stringify({ modules: { cpu_arm_cortexA73: { library: 'cpu_arm_cortexA73.so', args: a76.args, introspection: intro } } }));
  const hint = 'cpu_arm_cortexA73 comes with VP Studio but has not been built for your QBox yet. Run "VP Studio: Build Cortex-A73 Module".';
  const cat = models.merge(base, [models.loadModelCatalog(path.join(dir, 'c.catalog.json'), { bundled: true })], [{ type: 'cpu_arm_cortexA73', hint }]).catalog;
  const d = load();
  d.modules.cpu.type = 'cpu_arm_cortexA73';
  // No "dylib" in the platform and no problem: the platform stays the same on every machine.
  assert.deepStrictEqual(core.analyze(d, { catalog: cat }).problems.map((p) => p.message), []);
  const libs = models.libraries(cat);
  assert.deepStrictEqual(libs, { cpu_arm_cortexA73: path.join(dir, 'cpu_arm_cortexA73') });
  const lua = core.generate(d, { libraries: libs });
  assert.ok(lua.includes(`dylib_path = "${path.join(dir, 'cpu_arm_cortexA73')}";`));
  assert.ok(!core.generate(load(), { libraries: libs }).includes(dir), 'only the types that use it get a path');
  // An explicit dylib in the platform wins.
  d.modules.cpu.dylib = '${TOP}lib/a73';
  assert.match(core.generate(d, { libraries: libs }), /dylib_path = top\(\)\.\."lib\/a73";/);
  // Add Module writes no dylib for it.
  assert.deepStrictEqual(modules.moduleDef(cat, 'cpu_arm_cortexA73', [], '/plat'), { type: 'cpu_arm_cortexA73' });
  // Not built yet: the check says how to build it, and Add Module does not offer it.
  const notBuilt = models.merge(base, [], [{ type: 'cpu_arm_cortexA73', hint }]).catalog;
  delete d.modules.cpu.dylib;
  assert.deepStrictEqual(core.analyze(d, { catalog: notBuilt }).problems.map((p) => p.message), [`cpu: ${hint}`]);
  assert.ok(!modules.typeChoices(notBuilt).some((c) => c.type === 'cpu_arm_cortexA73'));
  // A wizard model far from the platform: no machine-specific dylib either.
  const far = { library: '/opt/elsewhere/build/m.so', model: { dir: '/opt/elsewhere' } };
  assert.strictEqual(models.dylibFor(far, '/home/u/project/platforms/x'), null);
  // The device tree names the core it is.
  assert.match(require('../lib/generate/devicetree').generate(d, { fileSize: () => 16 }).dts, /compatible = "arm,cortex-a73";/);
});
