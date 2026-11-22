'use strict';
// Run with: node test/catalog.test.js (every file: npm test)
const { test } = require('./harness');
const assert = require('assert');
const core = require('../lib/core');
const cat = require('../lib/catalog');
const { load, catalog } = require('./helpers');

const catProblems = (d) => core.analyze(d, { catalog }).problems;

test('catalog: the bootable example has no problems', () => {
  assert.deepStrictEqual(catProblems(load()), []);
});

test('catalog: Cortex-A53, A55 and Neoverse N2 exist, A73 does not', () => {
  for (const t of ['cpu_arm_cortexA53', 'cpu_arm_cortexA55', 'cpu_arm_neoverseN2']) {
    assert.ok(cat.moduleInfo(catalog, t), t);
    assert.strictEqual(catalog.modules[t].introspection.status, 'ok', t);
  }
  assert.strictEqual(cat.moduleInfo(catalog, 'cpu_arm_cortexA73'), undefined);
});

test('catalog: unknown module type is an error with suggestions', () => {
  const d = load();
  d.modules.cpu.type = 'cpu_arm_cortexA73';
  const errs = catProblems(d).filter((p) => p.severity === 'error');
  assert.strictEqual(errs.length, 1); // reported once for all 8 replicas
  assert.ok(/cpu_arm_cortexA73 is not registered/.test(errs[0].message), errs[0].message);
  assert.ok(/Did you mean .*cpu_arm_cortexA7/.test(errs[0].message), errs[0].message);
});

test('catalog: switching A76 to A53 flags the ports A53 lacks', () => {
  const d = load();
  d.modules.cpu.type = 'cpu_arm_cortexA53';
  const msgs = catProblems(d).filter((p) => p.severity === 'error').map((p) => p.message);
  assert.deepStrictEqual(msgs.sort(), [
    'cpu: cpu_arm_cortexA53 has no port gicv3_maintenance_interrupt',
    'cpu: cpu_arm_cortexA53 has no port pmu_interrupt',
  ]);
});

test('catalog: unknown ports on either end are errors', () => {
  const d = load();
  d.modules.pl011_uart_0.ports.irq.bind = 'gic_0.spi_inn_379';
  d.modules.virtionet0_0.ports.mem_typo = d.modules.virtionet0_0.ports.mem;
  delete d.modules.virtionet0_0.ports.mem;
  const msgs = catProblems(d).map((p) => p.message);
  assert.ok(msgs.includes('pl011_uart_0.irq binds to gic_0.spi_inn_379, but arm_gicv3 has no port spi_inn_379'), msgs.join('\n'));
  assert.ok(msgs.includes('virtionet0_0: virtio_mmio_net has no port mem_typo'), msgs.join('\n'));
});

test('catalog: vector ports accept indexed names, nested ones too', () => {
  const gic = catalog.modules.arm_gicv3;
  assert.ok(cat.findPort(gic, 'spi_in_541'));
  assert.ok(cat.findPort(gic, 'ppi_in_cpu_7_30'));
  assert.ok(cat.findPort(gic, 'redist_iface_0'));
  assert.strictEqual(cat.findPort(gic, 'spi_in'), cat.findPort(gic, 'spi_in_0'));
  assert.strictEqual(cat.findPort(gic, 'spi_inx_1'), null);
});

test('catalog: parameter names and value types are checked', () => {
  const d = load();
  d.modules.gic_0.params.num_spi = 'many';
  d.modules.gic_0.params.has_lpi = 1;
  d.modules.gic_0.params.no_such = 3;
  d.modules.router.params.log_level = 3; // universal, accepted everywhere
  const ps = catProblems(d);
  const find = (re) => ps.find((p) => re.test(p.message));
  assert.strictEqual(find(/gic_0.num_spi/).severity, 'error');
  assert.ok(/expects an integer \(unsigned int\)/.test(find(/gic_0.num_spi/).message));
  assert.strictEqual(find(/gic_0.has_lpi/).severity, 'error');
  assert.strictEqual(find(/no parameter no_such/).severity, 'warning');
  assert.strictEqual(ps.length, 3, ps.map((p) => p.message).join('\n'));
});

test('catalog: variables, hex and Lua values resolve or are skipped', () => {
  const env = { N: 8n };
  assert.strictEqual(cat.valueClass('${N}', env).num, 8);
  assert.strictEqual(cat.valueClass('0x10', env).cls, 'int');
  assert.strictEqual(cat.valueClass('${UNKNOWN}', env), null);
  assert.strictEqual(cat.valueClass({ $lua: 'x' }, env), null);
  assert.strictEqual(cat.paramClass('unsigned int'), 'uint');
  assert.strictEqual(cat.paramClass('std::__cxx11::basic_string<char, std::char_traits<char>, std::allocator<char> >'), 'string');
  assert.strictEqual(cat.paramClass('std::vector<unsigned int, std::allocator<unsigned int> >'), 'array');
});

test('catalog: constructor argument count is checked', () => {
  const d = load();
  d.modules.gic_0.args = [];
  const e = catProblems(d).find((p) => /arm_gicv3 takes 1 constructor argument/.test(p.message));
  assert.ok(e && e.severity === 'error');
});

test('catalog: mismatched binding kinds are a warning', () => {
  const d = load();
  d.modules.pl011_uart_0.ports.irq.bind = 'cpu_0.irq_timer_phys_out'; // output to output
  const w = catProblems(d).find((p) => /do not normally connect/.test(p.message));
  assert.ok(w && w.severity === 'warning');
});

test('gdb_port on more than one CPU of a QEMU instance is an error', () => {
  const gdbErr = (d) => core.analyze(d).problems.filter((p) => /single gdb server/.test(p.message));
  const d = load();
  d.modules.cpu.params.gdb_port = 1234; // applies to all 8 replicas
  const e = gdbErr(d);
  assert.strictEqual(e.length, 1);
  assert.ok(/^cpu_0, cpu_1 … cpu_7 all set gdb_port, but qemu_inst/.test(e[0].message) && e[0].module === 'cpu');
  const one = load();
  one.modules.cpu.perIndex['0'].params.gdb_port = 1234;
  assert.deepStrictEqual(gdbErr(one), []);
  const off = load();
  off.modules.cpu.params.gdb_port = 0;
  assert.deepStrictEqual(gdbErr(off), []);
});
