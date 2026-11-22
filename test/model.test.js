'use strict';
// Run with: node test/model.test.js (every file: npm test)
const { test } = require('./harness');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const core = require('../lib/core');
const { load } = require('./helpers');

// ------------------------------------------------------------------ modeling wizard
test('model: the starting description is valid and generates every file', () => {
  const modelgen = require('../lib/modelgen');
  const spec = modelgen.template('my_timer');
  assert.deepStrictEqual(modelgen.check(spec).problems, []);
  const files = modelgen.files(spec);
  assert.deepStrictEqual(files.map((f) => `${f.path}${f.once ? ' (once)' : ''}`),
    ['include/my_timer_regs.h', 'test/my_timer_selftest.cc', 'include/my_timer.h (once)', 'src/my_timer.cc (once)', 'CMakeLists.txt (once)']);
  const regs = files[0].text;
  assert.match(regs, /class my_timer_regs : public sc_core::sc_module/);
  assert.match(regs, /tlm_utils::simple_target_socket<my_timer_regs, DEFAULT_TLM_BUSWIDTH> target_socket;/);
  assert.match(regs, /InitiatorSignalSocket<bool> irq; \/\/ Interrupt request/);
  assert.match(regs, /cci::cci_param<uint64_t> p_clock_hz;/);
  assert.match(regs, /p_clock_hz\("clock_hz", 1000000ull, "Input clock frequency in Hz"\)/);
  assert.match(regs, /static constexpr uint32_t CTRL_IRQ_EN_MASK = 0x2u;/);
  assert.match(regs, /r_ID = 0x10001u;/);
  // Access types: w1c clears written ones, ro has no write hook, everyone else calls it.
  assert.match(regs, /r_STATUS = \(uint32_t\)\(old & ~\(merged & written\)\); \/\/ write 1 to clear/);
  assert.match(regs, /write to read-only ID ignored/);
  assert.ok(!/after_write_ID/.test(regs));
  assert.match(regs, /virtual uint32_t read_CTRL\(uint32_t value\) \{ return value; \}/);
  assert.match(regs, /void set_irq\(bool value\) \{ if \(irq.size\(\)\) irq->write\(value\); \}/);
  assert.match(files[2].text, /class my_timer : public my_timer_regs/);
  assert.match(files[3].text, /void module_register\(\) \{ GSC_MODULE_REGISTER_C\(my_timer\); \}/);
  const st = files[1].text;
  assert.match(st, /expect\("ID ignores writes", rd\(0xfc, 4\), 0x10001ull\);/);
  assert.match(st, /expect\("STATUS write 1 clears that bit only", rd\(0x4, 4\), 0xfffffffeull\);/);
  assert.match(st, /Unmapped offset 0x8\./);
});

test('model: checks catch overlaps, bad sizes, fields and names', () => {
  const modelgen = require('../lib/modelgen');
  const spec = modelgen.template('t');
  spec.registers.push(
    { name: 'BAD', offset: '0x2', size: 4 },                       // overlaps CTRL and STATUS, unaligned
    { name: 'BIG', offset: '0x20', size: 2, reset: '0x10000' },    // reset too big
    { name: 'FAR', offset: '0x1000', size: 4 },                    // beyond the region
    { name: 'F', offset: '0x30', fields: [{ name: 'A', bits: '3:0' }, { name: 'B', bits: '2' }, { name: 'C', bits: '40' }] },
    { name: 'CTRL', offset: '0x40' });                             // duplicate name
  spec.params.push({ name: 'irq', type: 'bool' }, { name: 'x', type: 'float' }, { name: 'n', type: 'uint32_t', default: -1 });
  spec.inputs.push({ name: 'class' });
  const msgs = modelgen.check(spec).problems.map((p) => `${p.severity}: ${p.message}`).join('\n');
  for (const want of [/error: CTRL and BAD overlap/, /warning: BAD: offset 0x2 is not aligned/, /BIG: reset value 0x10000 does not fit in 2 bytes/,
    /FAR: ends at 0x1004, beyond regionSize 0x1000/, /F.B: overlaps another field/, /F.C: bit 40 is beyond a 4-byte register/,
    /"CTRL" is already used/, /outputs\[0\].name: "irq" is already used by params\[1\].name/, /x: type must be one of/, /n: default cannot be negative/, /"class" is reserved/]) {
    assert.match(msgs, want);
  }
  assert.throws(() => modelgen.files(spec), /overlap/);
  assert.deepStrictEqual(modelgen.bitsOf('7:4'), { msb: 7, lsb: 4 });
  assert.strictEqual(modelgen.bitsOf('4:7'), null);
});

test('model: files on disk, catalog merge, and the dylib a platform writes', () => {
  const os = require('os');
  const modelgen = require('../lib/modelgen');
  const models = require('../lib/models');
  const modules = require('../lib/modules');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-model-'));
  const dir = path.join(root, 'models', 'my_timer');
  fs.mkdirSync(dir, { recursive: true });
  const specFile = path.join(dir, 'my_timer.model.json');
  const spec = modelgen.template('my_timer');
  let r = models.writeFiles(specFile, spec);
  assert.strictEqual(r.written.length, 5);
  // The user's files survive regeneration; unchanged generated files are not rewritten.
  fs.writeFileSync(path.join(dir, 'include', 'my_timer.h'), '// mine\n');
  spec.registers.push({ name: 'EXTRA', offset: '0x8' });
  r = models.writeFiles(specFile, spec);
  assert.deepStrictEqual(r.written.sort(), ['include/my_timer_regs.h', 'test/my_timer_selftest.cc']);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'include', 'my_timer.h'), 'utf8'), '// mine\n');
  assert.deepStrictEqual(models.writeFiles(specFile, spec).written, []);
  // A built model's catalog entry joins the QBox catalog, unless the name is taken.
  const cf = models.catalogFileFor(specFile, 'my_timer');
  fs.mkdirSync(path.dirname(cf));
  fs.writeFileSync(cf, JSON.stringify({ modules: { my_timer: { library: 'my_timer.so', introspection: { status: 'ok', ports: [{ name: 'target_socket', kind: 'tlm_target' }], params: [] } }, Pl011: { library: 'x.so' } } }));
  const base = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'catalog', 'qbox-catalog.json'), 'utf8'));
  const m = models.merge(base, [models.loadModelCatalog(cf)]);
  assert.deepStrictEqual(m.clashes, ['Pl011']);
  assert.strictEqual(m.catalog.modules.my_timer.library, path.join(dir, 'build', 'my_timer.so'));
  assert.strictEqual(m.catalog.modules.Pl011.library, base.modules.Pl011.library);
  assert.strictEqual(base.modules.my_timer, undefined);
  // Added to a platform in <root>/platforms/x: the library relative to the platform.
  const top = path.join(root, 'platforms', 'x');
  assert.deepStrictEqual(modules.moduleDef(m.catalog, 'my_timer', [], top), { type: 'my_timer', dylib: '${TOP}../../models/my_timer/build/my_timer' });
  assert.deepStrictEqual(modules.moduleDef(m.catalog, 'Pl011', []), { type: 'Pl011', dylib: 'uart-pl011' });
  // The generator expands ${TOP} in dylib; a plain name is emitted as before.
  const d = load();
  d.modules.t = { type: 'my_timer', dylib: '${TOP}../../models/my_timer/build/my_timer' };
  const lua = core.generate(d);
  assert.match(lua, /dylib_path = top\(\)\.\."\.\.\/\.\.\/models\/my_timer\/build\/my_timer";/);
  assert.match(lua, /dylib_path = "uart-pl011";/);
});
