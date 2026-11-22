'use strict';
// Run with: node test/core.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const core = require('../lib/core');
const view = require('../lib/view');

const load = () => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'examples', 'ubuntu-aarch64.platform.json'), 'utf8'));
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('ok   ' + name); };
// Async tests run in order after all synchronous ones.
const asyncTests = [];
const testAsync = (name, fn) => asyncTests.push([name, fn]);

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

test('platform view renders and escapes', () => {
  const d = load();
  d.description = '<script>alert(1)</script>';
  const html = view.render(d, core.analyze(d), 'nonce', 'vscode-resource:');
  assert.ok(html.includes('cpu ×8'));
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('0x80000000'));
});


// ---------------------------------------------------------------- images and JSON editing
const os = require('os');
const crypto = require('crypto');
const images = require('../lib/images');
const jsonedit = require('../lib/jsonedit');
const examplePath = path.join(__dirname, '..', 'examples', 'ubuntu-aarch64.platform.json');

/** Minimal little-endian ELF64 with the given PT_LOAD segments. */
function makeElf(file, segments, machine = 183, entry = 0x80000000n) {
  const b = Buffer.alloc(64 + 56 * segments.length);
  b.write('\x7fELF', 0, 'latin1'); b[4] = 2; b[5] = 1; b[6] = 1;
  b.writeUInt16LE(2, 16); b.writeUInt16LE(machine, 18); b.writeUInt32LE(1, 20);
  b.writeBigUInt64LE(entry, 24); b.writeBigUInt64LE(64n, 32);
  b.writeUInt16LE(64, 52); b.writeUInt16LE(56, 54); b.writeUInt16LE(segments.length, 56);
  segments.forEach((s, k) => {
    const o = 64 + 56 * k;
    b.writeUInt32LE(1, o); b.writeBigUInt64LE(s.paddr, o + 16); b.writeBigUInt64LE(s.paddr, o + 24);
    b.writeBigUInt64LE(s.memsz, o + 32); b.writeBigUInt64LE(s.memsz, o + 40);
  });
  fs.writeFileSync(file, b);
}

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vps-'));
  fs.mkdirSync(path.join(dir, 'fw', 'Artifacts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'fw', 'Artifacts', 'Image.bin'), Buffer.alloc(4096));
  fs.writeFileSync(path.join(dir, 'fw', 'Artifacts', 'ubuntu.dtb'), Buffer.alloc(512));
  fs.writeFileSync(path.join(dir, 'fw', 'Artifacts', 'image_ext4_initrd.img'), Buffer.alloc(1024));
  return dir;
}
const collect = (d, dir) => images.collect(d, core.analyze(d), dir);

/** An arm64 Linux Image header: magic at 0x38, text_offset at 0x08, image_size at 0x10. */
function arm64Image(file, fileSize, imageSize, textOffset = 0n) {
  const buf = Buffer.alloc(fileSize);
  buf.writeBigUInt64LE(textOffset, 0x08);
  buf.writeBigUInt64LE(BigInt(imageSize), 0x10);
  buf.writeUInt32LE(0x644d5241, 0x38);
  fs.writeFileSync(file, buf);
}

test('images: an arm64 kernel reserves image_size (BSS included) and must be 2 MiB aligned', () => {
  const dir = workspace();
  const kernel = path.join(dir, 'fw', 'Artifacts', 'Image.bin');
  // A 4 KiB file that needs 0x6500000 (101 MiB) once running: from 0x81200000 that reaches the DTB at 0x87600000.
  arm64Image(kernel, 4096, 0x6500000);
  const d = load();
  let r = collect(d, dir);
  const k = r.loaders[0].entries[0];
  assert.strictEqual(k.linux, 'arm64');
  assert.deepStrictEqual(k.kernel, { textOffset: 0n, imageSize: 0x6500000n });
  assert.strictEqual(k.ranges[0].end, 0x81200fffn);
  assert.strictEqual(k.ranges[0].reserveEnd, 0x876fffffn);
  const clash = r.problems.find((p) => /overlaps/.test(p.message));
  assert.ok(clash && /image_size from the kernel header, BSS included/.test(clash.message) && /clears its BSS/.test(clash.message), JSON.stringify(r.problems));
  // Small enough: no overlap. Misaligned: a warning.
  arm64Image(kernel, 4096, 0x100000);
  assert.deepStrictEqual(collect(d, dir).problems, []);
  d.variables.find((v) => v.name === '_KERNEL64_LOAD_ADDR').value = '${INITIAL_DDR_SPACE}+0x01280000';
  r = collect(d, dir);
  assert.ok(r.problems.some((p) => /above a 2 MiB-aligned address/.test(p.message)), JSON.stringify(r.problems));
  // The software images tab draws the layout, BSS hatched.
  const a = core.analyze(d);
  const html = view.render(d, a, 'n', 'x', images.collect(d, a, dir));
  assert.ok(html.includes('Memory layout at start') && /class="lseg bss role-boot d\d+"/.test(html));
  // The webview's content security policy ignores style attributes: data-dependent styles are generated classes.
  assert.ok(!/<[a-z]+ [^>]*style="/.test(html.replace(/<style[\s\S]*?<\/style>/, '')), 'a style attribute in the platform view');
  assert.ok(/\.d\d+\{left:[\d.]+%;width:[\d.]+%\}/.test(html) && /\.d\d+\{flex:[\d.]+\}/.test(html));
  assert.ok(/<b>ram_0\.target_socket<\/b>/.test(html));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('images: example resolves files, ranges and target memory', () => {
  const dir = workspace();
  const r = collect(load(), dir);
  assert.deepStrictEqual(r.problems, []);
  const e = r.loaders[0].entries;
  assert.strictEqual(e.length, 4);
  assert.strictEqual(e[0].ranges[0].start, 0x81200000n);
  assert.strictEqual(e[0].ranges[0].end, 0x81200fffn);
  assert.strictEqual(e[0].ranges[0].region, 'ram_0.target_socket');
  assert.strictEqual(e[3].kind, 'raw');
  assert.strictEqual(r.defaultAddress, '0x80000000');
});

test('images: missing file is a warning', () => {
  const r = collect(load(), fs.mkdtempSync(path.join(os.tmpdir(), 'vps-')));
  assert.strictEqual(r.problems.filter((p) => p.message.includes('file not found')).length, 3);
});

test('images: overlap, overrun and non-memory targets are reported', () => {
  const dir = workspace();
  const d = load();
  d.modules.load.entries[1].address = '${_KERNEL64_LOAD_ADDR}+0x800';   // overlaps the kernel
  d.modules.load.entries[2].address = '0x17FFFFF00';                    // runs past the end of ram_0
  d.modules.load.entries.push({ bin_file: '${TOP}fw/Artifacts/ubuntu.dtb', address: '0x10000000' }); // UART
  const msgs = collect(d, dir).problems.map((p) => p.message).join('\n');
  assert.ok(/ubuntu\.dtb .* overlaps load\[0\] Image\.bin/.test(msgs), msgs);
  assert.ok(/runs past the end of ram_0/.test(msgs), msgs);
  assert.ok(/loads into pl011_uart_0, which is not a memory module/.test(msgs), msgs);
});

test('images: ELF segments are read and placed', () => {
  const dir = workspace();
  const elf = path.join(dir, 'fw', 'app.elf');
  makeElf(elf, [{ paddr: 0x80000000n, memsz: 0x2000n }, { paddr: 0x80010000n, memsz: 0x100n }]);
  const info = images.readElf(elf);
  assert.strictEqual(info.machine, 'AArch64');
  assert.strictEqual(info.segments.length, 2);
  const d = load();
  d.modules.load.entries = [{ elf_file: '${TOP}fw/app.elf' }];
  const r = collect(d, dir);
  assert.deepStrictEqual(r.problems, []);
  assert.strictEqual(r.loaders[0].entries[0].ranges.length, 2);
  assert.deepStrictEqual(r.symbolFiles, [elf]);
});

test('images: ELF loaded as raw binary and unmapped ELF segment are flagged', () => {
  const dir = workspace();
  makeElf(path.join(dir, 'fw', 'app.elf'), [{ paddr: 0x900000000n, memsz: 0x1000n }]);
  const d = load();
  d.modules.load.entries = [{ bin_file: '${TOP}fw/app.elf', address: '0x80000000' }, { elf_file: '${TOP}fw/app.elf' }];
  const msgs = collect(d, dir).problems.map((p) => p.message).join('\n');
  assert.ok(/is an ELF file but is loaded as a raw binary/.test(msgs), msgs);
  assert.ok(/not mapped on any bus/.test(msgs), msgs);
});

test('images: explicit debug symbols come first and are validated', () => {
  const dir = workspace();
  makeElf(path.join(dir, 'vmlinux'), [{ paddr: 0x81200000n, memsz: 0x10n }]);
  const d = load();
  d.debug = { symbols: ['${TOP}vmlinux'] };
  assert.deepStrictEqual(collect(d, dir).symbolFiles, [path.join(dir, 'vmlinux')]);
  d.debug.symbols = ['${TOP}fw/Artifacts/Image.bin'];
  assert.ok(collect(d, dir).problems.some((p) => p.message.includes('not an ELF file')));
});

test('images: addresses are normalised or rejected', () => {
  assert.strictEqual(images.normaliseAddress('2147483648'), '0x80000000');
  assert.strictEqual(images.normaliseAddress(' 0x1000 '), '0x1000');
  assert.strictEqual(images.normaliseAddress('${BASE}+0x10'), '${BASE}+0x10');
  assert.strictEqual(images.normaliseAddress('80000000h'), null);
  assert.throws(() => images.rebuildEntries([], [{ orig: null, kind: 'bin', file: 'x', address: 'zz' }]), /not a valid address/);
});

test('images: rebuildEntries keeps raw entries and extra keys', () => {
  const old = load().modules.load.entries;
  old[0].note = 'keep me';
  const out = images.rebuildEntries(old, [
    { orig: 0, kind: 'elf', file: '${TOP}k.elf', address: '' },
    { orig: 3, kind: 'raw' },
    { orig: null, kind: 'bin', file: '${TOP}n.bin', address: '4096' },
  ]);
  assert.deepStrictEqual(out[0], { elf_file: '${TOP}k.elf', note: 'keep me' });
  assert.deepStrictEqual(out[1], old[3]);
  assert.deepStrictEqual(out[2], { bin_file: '${TOP}n.bin', address: '0x1000' });
});

test('jsonedit: replacing entries changes only that array', () => {
  const text = fs.readFileSync(examplePath, 'utf8');
  const entries = [{ elf_file: '${TOP}fw/app.elf' }];
  const edit = jsonedit.setProperty(text, ['modules', 'load'], 'entries', (ind) => jsonedit.renderRows(entries, ind));
  const out = jsonedit.apply(text, edit);
  const parsed = JSON.parse(out);
  assert.deepStrictEqual(parsed.modules.load.entries, entries);
  const before = JSON.parse(text);
  before.modules.load.entries = entries;
  assert.deepStrictEqual(parsed, before);
  assert.strictEqual(out.slice(0, edit.start), text.slice(0, edit.start));
  assert.ok(out.endsWith(text.slice(edit.end)));
});

test('jsonedit: adds and removes properties, including on empty objects', () => {
  const text = fs.readFileSync(examplePath, 'utf8');
  const added = jsonedit.apply(text, jsonedit.setProperty(text, [], 'debug', () => '{ "symbols": ["${TOP}vmlinux"] }'));
  assert.deepStrictEqual(JSON.parse(added).debug, { symbols: ['${TOP}vmlinux'] });
  const removed = jsonedit.apply(added, jsonedit.removeProperty(added, [], 'debug'));
  assert.deepStrictEqual(JSON.parse(removed), JSON.parse(text));
  const mgr = jsonedit.apply(text, jsonedit.setProperty(text, ['modules', 'qemu_inst_mgr'], 'entries', () => '[]'));
  assert.deepStrictEqual(JSON.parse(mgr).modules.qemu_inst_mgr, { type: 'QemuInstanceManager', entries: [] });
  const empty = '{\n  "a": {}\n}';
  assert.deepStrictEqual(JSON.parse(jsonedit.apply(empty, jsonedit.setProperty(empty, ['a'], 'k', () => '1'))), { a: { k: 1 } });
  const tricky = '{"s": "br{ace\\" ]", "n": -1.5e3, "t": [true, null, {"x": []}]}';
  assert.deepStrictEqual(JSON.parse(jsonedit.apply(tricky, jsonedit.setProperty(tricky, ['t', 2], 'x', () => '[1]'))).t[2].x, [1]);
  assert.strictEqual(JSON.parse(jsonedit.apply(tricky, jsonedit.removeProperty(tricky, [], 's'))).s, undefined);
});

test('schema accepts the debug section and elf entries', () => {
  let Ajv;
  try { Ajv = require('ajv'); } catch (e) { return; } // optional: only when ajv is installed
  const ajv = new Ajv({ strict: false });
  const validate = ajv.compile(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'schemas', 'qbox-platform.schema.json'), 'utf8')));
  const d = load();
  d.debug = { symbols: ['${TOP}vmlinux'] };
  assert.ok(validate(d), JSON.stringify(validate.errors));
});

test('platform view shows the images form', () => {
  const dir = workspace();
  const d = load();
  const a = core.analyze(d);
  const html = view.render(d, a, 'nonce', 'x', images.collect(d, a, dir));
  assert.ok(html.includes('Software images'));
  assert.ok(html.includes('value="${TOP}fw/Artifacts/Image.bin"'));
  assert.ok(html.includes('0x81200000 – 0x81200fff'));
  assert.ok(html.includes('<td>ram_0<span'));
});

// ------------------------------------------------------------ component catalog

const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'catalog', 'qbox-catalog.json'), 'utf8'));
const cat = require('../lib/catalog');
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

// ------------------------------------------------------------------ parameter form

const params = require('../lib/params');
const exampleText = () => fs.readFileSync(path.join(__dirname, '..', 'examples', 'ubuntu-aarch64.platform.json'), 'utf8');

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

test('platform view: parameter panels render, escaped, with input kinds', () => {
  const d = load();
  d.modules.router.params['<x>'] = 'a"b';
  const a = core.analyze(d, { catalog });
  const html = view.render(d, a, 'nonce', 'x', undefined, params.moduleForms(d, a, catalog));
  assert.ok(html.includes('<section class="mod-panel" data-panel="cpu" hidden>'));
  assert.ok(html.includes('<option value="all">all 8 instances</option><option value="0">cpu_0 only</option>'));
  assert.ok(/data-name="has_el3"[\s\S]*?<select class="p-input" data-kind="bool" aria-label[\s\S]*?<option value="false" selected>/.test(html));
  assert.ok(html.includes('value="Lua: ACCEL == &quot;kvm&quot; and &quot;hvc&quot; or &quot;smc&quot;"'));
  assert.ok(html.includes('data-name="&lt;x&gt;"') && !html.includes('<x>'));
  assert.ok(html.includes('overridden for cpu_0'));
  assert.ok(html.includes('<div class="p-scope-body" data-scope="7" hidden>'));
  assert.ok(/data-scope="all">[\s\S]*?data-name="gdb_port"[\s\S]*?disabled title="A QEMU instance has one gdb server/.test(html));
});

test('block diagram: one bar per bus, each selectable, devices under their own bus', () => {
  const d = load();
  d.modules.router_1 = { type: 'router' };
  d.modules.uart1 = { type: 'Pl011', dylib: 'uart-pl011', ports: { target_socket: { address: '0x0', size: '0x1000', bind: 'router_1.initiator_socket' } } };
  const svg = view.diagram(core.analyze(d));
  assert.ok(svg.includes('<g class="node bus" data-module="router"'));
  assert.ok(svg.includes('<g class="node bus" data-module="router_1"'));
  assert.ok(!svg.includes('router, router_1'));
  // uart1 is drawn after (below) the router_1 bar, ram_0 before it.
  const at = (s) => svg.indexOf(s);
  assert.ok(at('data-module="ram_0"') < at('data-module="router_1"') && at('data-module="router_1"') < at('data-module="uart1"'));
  delete d.modules.uart1;
  assert.ok(view.diagram(core.analyze(d)).includes('router_1 (bus) — nothing connected yet'));
});

test('platform view: roles, summary strip, outline and header actions', () => {
  assert.strictEqual(view.cpuLabel('cpu_arm_cortexA76'), 'Cortex-A76');
  assert.strictEqual(view.cpuLabel('cpu_arm_neoverseN2'), 'Neoverse N2');
  assert.strictEqual(view.fmtAddr(0x80000000n), '0x8000_0000');
  assert.strictEqual(view.fmtAddr(0x400000000n), '0x4_0000_0000');
  assert.strictEqual(view.fmtAddr(0n), '0x0');
  const role = (type, extra = {}) => view.roleOf(Object.assign({ type }, extra));
  assert.deepStrictEqual(['cpu_arm_cortexA53', 'gs_memory', 'arm_gicv3', 'qemu_gpex', 'loader', 'router', 'QemuInstance'].map((t) => role(t)),
    ['compute', 'memory', 'irq', 'pcie', 'boot', 'bus', 'infra']);
  assert.strictEqual(role('Pl011', { target: true }), 'periph');
  assert.strictEqual(role('Container', { subsystem: true }), 'subsystem');
  const d = load();
  const a = core.analyze(d, { catalog });
  const gs = view.groups(a);
  const s = view.summary(d, a, gs);
  const by = Object.fromEntries(s.map((x) => [x.label, x]));
  assert.strictEqual(by.Compute.value, '8 × Cortex-A76');
  assert.strictEqual(by.Memory.value, '4 GiB');
  assert.strictEqual(by.Memory.sub, '@ 0x8000_0000');
  assert.strictEqual(by['Address map'].value, '11 regions');
  assert.strictEqual(by.Interrupts.value, 'arm_gicv3 · 960 SPI');
  assert.strictEqual(by.Interrupts.sub, '4 sources wired');
  assert.strictEqual(by['Host ports'].value, 'ssh 2222');
  const html = view.render(d, a, 'nonce', 'x', undefined, params.moduleForms(d, a, catalog), { connections: new Map() });
  // Interrupt numbers on the blocks, CPUs as one block with core tiles, modules by role on the left.
  assert.ok(html.includes('>SPI 379</text>') && html.includes('>SPI 541–544</text>'));
  assert.strictEqual((html.match(/class="core"/g) || []).length, 8);
  assert.ok(/class="ol-item role-periph" data-module="pl011_uart_0"/.test(html));
  assert.ok(html.includes('data-command="start"') && html.includes('data-command="generate"'));
  assert.ok(html.includes('Valid · no problems'));
  // Each module's inspector has the parameter and connection tabs and its facts.
  assert.ok(/data-panel="pl011_uart_0"[\s\S]*?<div class="fact-k">Interrupt<\/div><div class="fact-v mono" title="pl011_uart_0.irq → gic_0.spi_in_379">SPI 379</.test(html));
  // The badge's tooltip lists every line; each core tile is one instance.
  assert.ok(html.includes('<title>gpex_0.irq_out_0 → gic_0.spi_in_541\ngpex_0.irq_out_1 → gic_0.spi_in_542'));
  assert.ok(html.includes('<rect class="core" data-index="3"'));
  // Address lookup: the region data is embedded and the lookup runs in the webview.
  assert.ok(html.includes('id="vp-regions"') && html.includes('function lookupAddress('));
  assert.ok(/data-panel="cpu"[\s\S]*?data-tab="params"[\s\S]*?data-tab="conns"/.test(html));
});

test('platform view: address lookup picks the region that answers on each bus', () => {
  const a = core.analyze(load());
  const hit = view.lookupAddress(a.memoryMap, view.parseAddress('0x1000_0010'));
  assert.strictEqual(hit.length, 1);
  assert.strictEqual(hit[0].bus, 'router');
  assert.strictEqual(hit[0].hit.instance, 'pl011_uart_0');
  assert.strictEqual(hit[0].hit.offset, 0x10n);
  // The UART shadows the background memory, which maps everything below 32 GiB.
  assert.deepStrictEqual(hit[0].shadowed.map((r) => r.instance), ['fallback_0']);
  assert.strictEqual(view.lookupAddress(a.memoryMap, 0x8000_0000n)[0].hit.instance, 'ram_0');
  assert.deepStrictEqual(view.lookupAddress(a.memoryMap, 0x9_0000_0000n), []);
  assert.strictEqual(view.parseAddress('268435472'), 0x10000010n);
  assert.strictEqual(view.parseAddress('ram'), null);
});

// ------------------------------------------------------------------ replace a model, group into a subsystem

test('replace model: A76 -> A53 keeps the CPU connections and drops the two ports A53 lacks', () => {
  const rs = require('../lib/restructure');
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
  const e = require('../lib/modules').minimalEdit(text, out);
  assert.ok(text.slice(0, e.start).endsWith('"type": "cpu_arm_cortexA'));
  // Best fits first: the A710 has every port; A53 loses two connections.
  const ch = rs.swapChoices(doc, catalog, 'cpu');
  assert.strictEqual(ch[0].type, 'cpu_arm_cortexA710');
  assert.strictEqual(ch.find((c) => c.type === 'cpu_arm_cortexA53').lost, 2);
});

test('replace model: PL011 -> qemu_pl011 renames ports, adds the QEMU instance, drops the library', () => {
  const rs = require('../lib/restructure');
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
  const rs = require('../lib/restructure');
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
  const rs = require('../lib/restructure');
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

test('platform view: signal layer draws interrupt and stream lines between blocks', () => {
  const d = load();
  const svg = view.diagram(core.analyze(d));
  const edges = [...svg.matchAll(/<g class="sig sig-(\w+)" data-a="([^"]+)" data-b="([^"]+)">([\s\S]*?)<\/g>/g)]
    .map((m) => ({ kind: m[1], a: m[2], b: m[3], label: (/<text[^>]*>([^<]*)<\/text>/.exec(m[4]) || [])[1] || '', both: m[4].includes('marker-start') }));
  const by = (a, b) => edges.find((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a));
  // Interrupts into the GIC: one line per device, no label (the number is on the device's block).
  assert.deepStrictEqual(['pl011_uart_0', 'virtioblk_0', 'virtionet0_0', 'gpex_0'].map((m) => [by(m, 'gic_0').kind, by(m, 'gic_0').label]), [['irq', ''], ['irq', ''], ['irq', ''], ['irq', '']]);
  // GIC and the 8 CPUs: one line both ways.
  const gc = by('gic_0', 'cpu');
  assert.ok(gc.both && /^irq ×\d+ ⇄ ×\d+$/.test(gc.label), JSON.stringify(gc));
  // The UART's console is a byte stream to a block that is on no bus.
  assert.strictEqual(by('pl011_uart_0', 'charbackend_stdio_0').kind, 'stream');
  // A collapsed subsystem is one end for everything inside it.
  const rs = require('../lib/restructure');
  const text = fs.readFileSync(examplePath, 'utf8');
  const g = JSON.parse(rs.groupText(text, rs.groupPlan(JSON.parse(text), ['pl011_uart_0', 'virtioblk_0'], 'periph')));
  const svg2 = view.diagram(core.analyze(g), new Set(['periph']));
  assert.ok(svg2.includes('data-a="periph" data-b="gic_0"') || svg2.includes('data-a="gic_0" data-b="periph"'));
  assert.ok(!svg2.includes('data-a="periph.pl011_uart_0"'));
  // Subsystem blocks carry their own collapse / expand button.
  assert.ok(svg2.includes('<g class="sub-toggle" data-module="periph" tabindex="0" role="button" aria-label="Expand subsystem periph">'));
  assert.ok(view.diagram(core.analyze(g)).includes('aria-label="Collapse subsystem periph"'));
  // The subsystem's own (Container) parameters are folded into an advanced block; other modules' are not.
  const ag = core.analyze(g, { catalog });
  const html2 = view.render(g, ag, 'n', 'x', undefined, params.moduleForms(g, ag, catalog), { connections: new Map() });
  assert.ok(/data-panel="periph" hidden>[\s\S]*?<details class="advanced" data-panel="periph"><summary>Advanced: Container settings/.test(html2));
  assert.ok(!/data-panel="gic_0" hidden>(?:(?!<\/section>)[\s\S])*?<details class="advanced"/.test(html2));
  // The toolbar switches the layer between the selected block, all lines, and off.
  const html = view.render(d, core.analyze(d), 'n', 'x');
  assert.ok(['selected', 'all', 'off'].every((m) => html.includes(`data-sig="${m}"`)));
});

test('platform view: replace and multiple selection controls', () => {
  const d = load();
  const a = core.analyze(d, { catalog });
  const html = view.render(d, a, 'n', 'x', undefined, params.moduleForms(d, a, catalog), { connections: new Map() });
  assert.ok(html.includes('<button class="swap-module" data-module="pl011_uart_0"'));
  assert.ok(html.includes('class="group-modules primary"') && html.includes("post({type:'groupModules',modules:ms})"));
});

// ------------------------------------------------------------------ add and delete modules

const modules = require('../lib/modules');

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

// ------------------------------------------------------------------ host ports

const hostports = require('../lib/hostports');

test('host port variables: listed, emitted as overridable, preset values win', () => {
  const d = load();
  assert.deepStrictEqual(hostports.hostPortVariables(d).map((v) => [v.name, v.port]),
    [['HOST_PORT_SSH', 2222], ['HOST_PORT_FTP', 2221], ['HOST_PORT_56283', 56283], ['HOST_PORT_65534', 55534], ['HOST_PORT_65535', 55535]]);
  const lua = core.generate(d, { variableValues: { HOST_PORT_SSH: 40001 } });
  const preset = lua.indexOf('HOST_PORT_SSH = 40001');
  const fallback = lua.indexOf('if HOST_PORT_SSH == nil then HOST_PORT_SSH = 2222 end');
  assert.ok(preset > 0 && fallback > preset);
  assert.ok(lua.includes('netdev_str = "type=user,hostfwd=tcp::"..tostring(HOST_PORT_SSH).."-:22,'));
  assert.ok(!core.generate(d).includes('HOST_PORT_SSH = 40001'));
});

testAsync('host ports: keep free ones, move taken or duplicate ones', async () => {
  const taken = new Set([2222]);
  let next = 40000;
  const r = await hostports.choosePorts(
    [{ name: 'A', port: 2222 }, { name: 'B', port: 2221 }, { name: 'C', port: 2221 }, { name: 'D', port: null }],
    { isFree: async (p) => !taken.has(p), pick: async () => next++ });
  assert.deepStrictEqual(r.values, { A: 40000, B: 2221, C: 40001, D: 40002 });
  assert.deepStrictEqual(r.moved.map((m) => [m.name, m.from, m.to]), [['A', 2222, 40000], ['C', 2221, 40001], ['D', null, 40002]]);
});

testAsync('host ports: a port held by another process is seen as taken', async () => {
  const net = require('net');
  const srv = net.createServer();
  await new Promise((r) => srv.listen({ port: 0, host: '0.0.0.0' }, r));
  const port = srv.address().port;
  assert.strictEqual(await hostports.isPortFree(port), false);
  await new Promise((r) => srv.close(r));
  assert.strictEqual(await hostports.isPortFree(port), true);
  const r = await hostports.choosePorts([{ name: 'X', port }]);
  assert.deepStrictEqual(r, { values: { X: port }, moved: [] });
});

// ------------------------------------------------------------------ disk image locks

const disklock = require('../lib/disklock');

test('disk images: found in QEMU option strings, ${TOP} resolved, read-only ones marked', () => {
  const d = load();
  const imgs = disklock.diskImages(d, '/plat/ubuntu');
  assert.deepStrictEqual(imgs, [{ module: 'virtioblk_0', param: 'blkdev_str', file: '/plat/ubuntu/fw/Artifacts/image_ext4.img', writable: true,
    options: 'file=${TOP}fw/Artifacts/image_ext4.img,format=raw,if=none,readonly=off' }]);
  d.modules.virtioblk_0.params.blkdev_str += ',snapshot=on';
  assert.strictEqual(disklock.diskImages(d, '/plat/ubuntu')[0].writable, false);
  d.modules.virtioblk_0.params.blkdev_str = 'file=${UNKNOWN}/x.img,format=raw';
  assert.deepStrictEqual(disklock.diskImages(d, '/plat/ubuntu'), []);
});

test('disk locks: device numbers and /proc/locks lines', () => {
  assert.deepStrictEqual(disklock.devParts(66308), [259, 4]); // 0x10304: nvme0n1p4
  const text = '17: OFDLCK ADVISORY  READ -1 103:04:8951619 201 201\n18: OFDLCK ADVISORY  READ -1 103:04:8951619 100 101\n19: POSIX  ADVISORY  WRITE 812 103:04:111 0 EOF\n';
  assert.strictEqual(disklock.locksOn(text, 259, 4, 8951619).length, 2);
  assert.strictEqual(disklock.locksOn(text, 259, 4, 895161).length, 0);
  assert.strictEqual(disklock.locksOn(text, 259, 5, 8951619).length, 0);
});

test('disk locks: processes with the image open', () => {
  const os = require('os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-proc-'));
  const img = path.join(root, 'disk.img');
  fs.writeFileSync(img, '');
  fs.mkdirSync(path.join(root, '4242', 'fd'), { recursive: true });
  fs.symlinkSync(img, path.join(root, '4242', 'fd', '17'));
  fs.writeFileSync(path.join(root, '4242', 'cmdline'), './build/platforms-vp\0-l\0x.lua\0');
  fs.mkdirSync(path.join(root, '4343', 'fd'), { recursive: true });
  fs.symlinkSync('/dev/null', path.join(root, '4343', 'fd', '0'));
  assert.deepStrictEqual(disklock.openers(img, root), [{ pid: 4242, cmd: './build/platforms-vp -l x.lua' }]);
  fs.rmSync(root, { recursive: true, force: true });
});

// ------------------------------------------------------------------ transaction trace

const trace = require('../lib/trace');

test('trace points: bus-mapped ports of modules that are not replicated, by address', () => {
  const d = load();
  const pts = trace.tracePoints(d);
  const ids = pts.map((p) => p.id);
  assert.ok(ids.includes('pl011_uart_0.target_socket') && ids.includes('virtioblk_0.mem') && ids.includes('gic_0.dist_iface'));
  assert.ok(!ids.some((i) => i.startsWith('cpu')));
  assert.ok(pts.find((p) => p.id === 'ram_0.target_socket').memory);
  assert.ok(!pts.find((p) => p.id === 'pl011_uart_0.target_socket').memory);
  for (let i = 1; i < pts.length; i++) assert.ok(pts[i - 1].address <= pts[i].address);
});

test('trace options: a tracer takes the port address, the port is rebound to it', () => {
  const d = load();
  const t = trace.traceOptions(d, ['pl011_uart_0.target_socket', 'ram_0.target_socket'], '/x/vp_sim_agent');
  assert.deepStrictEqual(t.extraModules[0], {
    name: 'trace_pl011_uart_0_target_socket', type: 'tracer', dylib: '/x/vp_sim_agent',
    params: { label: 'pl011_uart_0.target_socket', allow_dmi: false },
    ports: { target_socket: { address: '${UART0}', size: '0x1000', bind: 'router.initiator_socket' } },
  });
  assert.strictEqual(t.extraModules[1].params.allow_dmi, true);
  const lua = core.generate(d, { extraModules: t.extraModules, portOverrides: t.portOverrides });
  assert.ok(lua.includes('platform["trace_pl011_uart_0_target_socket"] = { moduletype = "tracer"; dylib_path = "/x/vp_sim_agent"; label = "pl011_uart_0.target_socket"; allow_dmi = false; target_socket = {address = UART0, size = 0x1000, bind = "&router.initiator_socket"} }'));
  // The traced port keeps its address and size (gs_memory reads its size from them; 2026-11-15
  // a traced fallback_0 stopped the simulator with "Unable to get parameter ...target_socket.size").
  assert.ok(lua.includes('platform["pl011_uart_0"]["target_socket"] = {address = UART0, size = 0x1000, bind = "&trace_pl011_uart_0_target_socket.initiator_socket"}'));
  assert.ok(lua.includes('platform["ram_0"]["target_socket"] = {address = INITIAL_DDR_SPACE, size = 0x100000000, bind = "&trace_ram_0_target_socket.initiator_socket"}'));
  assert.throws(() => trace.traceOptions(d, ['cpu.mem'], '/x'), /cannot be traced/);
});

test('trace records: decoded with point names, little-endian values, CSV', () => {
  // Agent 0.12.0 adds the initiator as a ninth element; older agents send eight.
  const res = { points: ['uart.target_socket'], records: [[7, 1.5, 0, 'R', '0x10000fe0', 4, '11000000', 1, 'cpu_3.mem'], [8, 1.6, 0, 'W', '0x10000000', 1, '41', -2]] };
  const r = trace.decodeRecords(res);
  assert.deepStrictEqual(r[0], { seq: 7, time: 1.5, point: 'uart.target_socket', dir: 'R', address: '0x10000fe0', length: 4, data: '11000000', value: '0x11', status: 'OK', initiator: 'cpu_3.mem' });
  assert.strictEqual(r[1].initiator, '');
  assert.deepStrictEqual([r[1].value, r[1].status], ['0x41', 'ADDRESS_ERROR']);
  assert.strictEqual(trace.leValue('00000000', 4), '0x0');
  assert.strictEqual(trace.leValue('0102030405060708090a', 10), null);
  assert.strictEqual(trace.toCsv(r).split('\n')[0], 'seq,time_s,point,dir,address,length,value,data,status,initiator');
  assert.strictEqual(trace.toCsv(r).split('\n')[1], '7,1.5,uart.target_socket,R,0x10000fe0,4,0x11,11000000,OK,cpu_3.mem');
});

test('kit file names: one .tar.gz, never doubled by a save dialog', () => {
  const kit = require('../lib/kit');
  assert.strictEqual(kit.kitFileName('/w/kits/p-kit.tar.gz'), '/w/kits/p-kit.tar.gz');
  // VS Code's own save dialog appends the filter's extension again.
  assert.strictEqual(kit.kitFileName('/w/kits/p-kit.tar.gz.tar.gz'), '/w/kits/p-kit.tar.gz');
  assert.strictEqual(kit.kitFileName('/w/kits/p-kit.tar.gz.gz'), '/w/kits/p-kit.tar.gz');
  assert.strictEqual(kit.kitFileName('/w/kits/p-kit.tgz'), '/w/kits/p-kit.tgz');
  assert.strictEqual(kit.kitFileName('/w/kits/p-kit.tgz.tar.gz'), '/w/kits/p-kit.tgz');
  assert.strictEqual(kit.kitFileName('/w/kits/p-kit'), '/w/kits/p-kit.tar.gz');
  assert.strictEqual(kit.kitFileName('/w/kits/p-kit.gz'), '/w/kits/p-kit.tar.gz');
  assert.strictEqual(kit.kitFileName('/w/v1.2/p'), '/w/v1.2/p.tar.gz');
});

test('summary strip: dividers drawn per figure, not by showing the border color', () => {
  const { css } = require('../lib/webtheme');
  const stats = /\.stats\{[^}]*\}/.exec(css)[0];
  // An empty cell at the end of a wrapped row showed the border color: a bright block in high-contrast themes.
  assert.ok(!/background:var\(--vp-border\)/.test(stats), stats);
  assert.ok(/\.stat\{[^}]*box-shadow:[^}]*var\(--vp-border\)/.test(css));
});

test('trace view renders with a nonce and escapes the title', () => {
  const html = require('../lib/traceview').render('N1', 'vscode-resource:', 'Trace: <x>');
  assert.ok(html.includes("script-src 'nonce-N1'") && html.includes('<title>Trace: &lt;x&gt;</title>'));
  assert.ok(html.includes("post({ type: 'ready' })"));
  // Same look as the platform view: shared tokens, the name and the platform in the header.
  const theme = require('../lib/webtheme');
  assert.ok(html.includes(theme.css.slice(0, 200)) && html.includes('<h1>Trace</h1><span class="tag mono">&lt;x&gt;</span>'));
  const prof = require('../lib/profileview').render('N2', 'x', 'Profile: demo');
  assert.ok(prof.includes(theme.css.slice(0, 200)) && prof.includes('<h1>Profile</h1>'));
  // The controls the extension listens to are all there.
  for (const id of ['record', 'follow', 'clear', 'export', 'vcd', 'pchoose', 'point', 'dir', 'addr', 'bpoint', 'baccess', 'baddr', 'bval', 'bmask', 'badd', 'hit', 'hitcont', 'rows', 'st-total', 'st-probes']) {
    assert.ok(html.includes(`id="${id}"`), id);
  }
  for (const id of ['cpu', 'sampling', 'reset', 'choose', 'rows', 'hot', 'st-samples', 'warn']) assert.ok(prof.includes(`id="${id}"`), id);
  // A breakpoint stop (with Continue) is outside the scrolling table, so it stays in sight.
  const tmain = html.slice(html.indexOf('id="tmain"'), html.indexOf('</main>'));
  assert.ok(html.includes('id="hit"') && !tmain.includes('id="hit"'));
  // No style attributes (the content security policy would drop them).
  for (const h of [html, prof]) assert.ok(!/<[a-z]+ [^>]*style="/.test(h.replace(/<style[\s\S]*?<\/style>/, '')));
});

test('cpu registers: groups, PSTATE, changes, compact SIMD values, the view', () => {
  const cr = require('../lib/cpuregs');
  assert.deepStrictEqual(['x0', 'x30', 'sp', 'pc', 'cpsr', 'v31', 'fpsr', 'SCTLR_EL1', 'tpidr', 'w3', 'q0', 'b31'].map(cr.classify),
    ['general', 'general', 'general', 'general', 'general', 'fp', 'fp', 'system', 'system', 'alias', 'alias', 'alias']);
  // cpsr as QEMU's gdbstub gave it for a CPU idling in the kernel: N set, IRQ and FIQ masked, EL1 on SP_EL1.
  const p = cr.decodePstate('0x800000c5');
  assert.deepStrictEqual([p.n, p.z, p.c, p.v, p.d, p.a, p.i, p.f, p.mode], [1, 0, 0, 0, 0, 0, 1, 1, 'EL1h']);
  assert.strictEqual(cr.decodePstate('0x3c4').mode, 'EL1t');
  assert.strictEqual(cr.decodePstate('nonsense'), null);
  const v0 = '{d = {f = {0x0, 0x0}, u = {0x0, 0x0}, s = {0x0, 0x0}}, b = {u = {0x0 <repeats 16 times>}}, q = {u = {0x3f800000}, s = {0x3f800000}}}';
  assert.strictEqual(cr.compactValue(v0), '0x3f800000');
  const names = { 'register-names': ['x0', 'x1', '', 'pc', 'v0', 'w0'] };
  const vals = { 'register-values': [{ number: '0', value: '0x1' }, { number: '1', value: '0x2' }, { number: '3', value: '0xffffc98ba16430b4' }, { number: '4', value: v0 }, { number: '5', value: '0x1' }] };
  const first = cr.snapshot(names, vals);
  assert.deepStrictEqual(first.map((r) => [r.name, r.group, r.changed]), [['x0', 'general', false], ['x1', 'general', false], ['pc', 'general', false], ['v0', 'fp', false]]);
  const prev = new Map(first.map((r) => [r.name, r.value]));
  vals['register-values'][1].value = '0x3';
  assert.deepStrictEqual(cr.snapshot(names, vals, prev).filter((r) => r.changed).map((r) => r.name), ['x1']);
  assert.strictEqual(cr.valuesCommand(8), '-data-list-register-values --thread 8 --frame 0 x');
  const html = require('../lib/cpuregsview').render('N3', 'x');
  assert.ok(html.includes("script-src 'nonce-N3'") && html.includes('id="g-system"') && html.includes("post({ type: 'ready' })"));
  assert.ok(!/<[a-z]+ [^>]*style="/.test(html.replace(/<style[\s\S]*?<\/style>/, '')));
});

test('kernel sources: map a build path to a local tree, and gdb gets it at attach', () => {
  const gl = require('../lib/guestlinux');
  const local = new Set(['/home/me/linux/arch/arm64/kernel/idle.c']);
  const m = gl.sourceMapping('/build/linux-oPNunh/linux-5.15.0/arch/arm64/kernel/idle.c', '/home/me/linux/', (p) => local.has(p));
  assert.deepStrictEqual(m, { from: '/build/linux-oPNunh/linux-5.15.0', to: '/home/me/linux', file: '/home/me/linux/arch/arm64/kernel/idle.c' });
  assert.strictEqual(gl.sourceMapping('/build/x/linux/kernel/fork.c', '/home/me/linux', () => false), null);
  assert.deepStrictEqual(gl.substituteCommands({ '/build/a b': '/home/me/x' }), ['set substitute-path "/build/a b" "/home/me/x"']);
  const c = gl.withSourceMap({ type: 'gdbtarget', initCommands: ['foo'] }, { '/build/a': '/b' });
  assert.deepStrictEqual(c.initCommands, ['foo', 'set substitute-path "/build/a" "/b"']);
  assert.strictEqual(gl.withSourceMap(c, { '/build/a': '/b' }).initCommands.length, 2); // not twice
  const none = { type: 'gdbtarget' };
  assert.strictEqual(gl.withSourceMap(none, {}), none);
});

// ------------------------------------------------------------------ connections

const connect = require('../lib/connect');

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

const dataflow = require('../lib/dataflow');

test('dataflow: what the CPUs reach and who reaches a device (Ubuntu example)', () => {
  const d = load();
  const a = core.analyze(d, { catalog });
  const r = dataflow.reachFrom(a, 'cpu');
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].port, 'mem');
  assert.strictEqual(r[0].bus, 'router');
  assert.strictEqual(r[0].instances, 8);
  const uart = r[0].targets.find((t) => t.base === 'pl011_uart_0');
  assert.strictEqual(uart.start, 0x10000000n);
  assert.strictEqual(uart.end, 0x10000fffn);
  assert.ok(r[0].targets.find((t) => t.base === 'fallback_0').background);
  // Sorted by address.
  for (let i = 1; i < r[0].targets.length; i++) assert.ok(r[0].targets[i - 1].start <= r[0].targets[i].start);
  const by = dataflow.reachedBy(a, 'pl011_uart_0');
  assert.strictEqual(by.length, 1);
  assert.deepStrictEqual(by[0].path, ['router']);
  assert.deepStrictEqual(by[0].initiators.map((x) => `${x.base}.${x.port}×${x.count}`).sort(),
    ['cpu.mem×8', 'global_peripheral_initiator_arm_0.global_initiator×1', 'gpex_0.bus_master×1', 'load.initiator_socket×1']);
  assert.deepStrictEqual(dataflow.reachFrom(a, 'pl011_uart_0'), []);
  assert.ok(dataflow.hasDataFlow(a, 'router') && dataflow.hasDataFlow(a, 'cpu') && dataflow.hasDataFlow(a, 'pl011_uart_0'));
  assert.ok(!dataflow.hasDataFlow(a, 'charbackend_stdio_0'));
  assert.deepStrictEqual(dataflow.regionsByPort(a).get('pl011_uart_0.target_socket'), { start: 0x10000000n, size: 0x1000n, bus: 'router', priority: 0 });
});

test('dataflow: a router behind a router sees its window offset', () => {
  // Synthetic analysis: cpu -> top; top decodes sub at 0x4000_0000; sub decodes dev at 0x100.
  const a = {
    buses: ['top', 'sub'],
    connections: [{ from: 'cpu_0', fromBase: 'cpu', fromPort: 'mem', to: 'top', toPort: 'target_socket' }],
    memoryMap: [
      { instance: 'sub', base: 'sub', port: 'target_socket', bus: 'top', start: 0x40000000n, size: 0x1000000n, priority: 0 },
      { instance: 'dev', base: 'dev', port: 'target_socket', bus: 'sub', start: 0x100n, size: 0x100n, priority: 0 },
    ],
  };
  const t = dataflow.reachFrom(a, 'cpu')[0].targets;
  assert.deepStrictEqual(t.map((x) => [x.instance, x.start, x.depth]), [['sub', 0x40000000n, 0], ['dev', 0x40000100n, 1]]);
  const by = dataflow.reachedBy(a, 'dev');
  // sub has no initiator of its own; through top the CPU sees dev at window + 0x100.
  assert.strictEqual(by.length, 1);
  assert.deepStrictEqual(by[0].path, ['top', 'sub']);
  assert.strictEqual(by[0].start, 0x40000100n);
  assert.deepStrictEqual(by[0].initiators.map((x) => x.base), ['cpu']);
  // A loop of routers does not recurse forever.
  a.memoryMap.push({ instance: 'top', base: 'top', port: 'target_socket', bus: 'sub', start: 0n, size: 0x10n, priority: 0 });
  assert.ok(dataflow.reachFrom(a, 'cpu')[0].targets.length < 20);
});

test('dataflow: route of a transaction, from the trace initiator name to the device', () => {
  const d = load();
  const a = core.analyze(d);
  const t = dataflow.routeTable(a);
  assert.deepStrictEqual(t.inst.cpu_3, ['cpu', 3]);
  assert.deepStrictEqual(t.inst.pl011_uart_0, ['pl011_uart_0', null]);
  assert.deepStrictEqual(t.regions['pl011_uart_0.target_socket'].ways[0].path, ['router']);
  assert.ok(t.regions['pl011_uart_0.target_socket'].ways[0].initiators.includes('cpu'));
  // JSON only (the view embeds it).
  assert.deepStrictEqual(JSON.parse(JSON.stringify(t)), t);
  assert.deepStrictEqual(dataflow.routeFor(t, { region: 'pl011_uart_0.target_socket', initiator: 'cpu_3.mem' }),
    { from: 'cpu', index: 3, port: 'mem', buses: ['router'], target: 'pl011_uart_0', region: 'pl011_uart_0.target_socket' });
  // Without an initiator (an older agent, or the address lookup): the bus and the device only.
  const r = dataflow.routeFor(t, { region: 'ram_0.target_socket' });
  assert.deepStrictEqual([r.from, r.buses, r.target], [null, ['router'], 'ram_0']);
  // An initiator the platform does not know is kept out of the route.
  assert.strictEqual(dataflow.routeFor(t, { region: 'ram_0.target_socket', initiator: 'vp_sim_agent.bus_0' }).from, null);
  assert.strictEqual(dataflow.routeFor(t, { region: 'nothing.here' }), null);
  // Self-contained, as the view embeds it with toString().
  const embedded = new Function(`return (${dataflow.routeFor.toString()})`)();
  assert.deepStrictEqual(embedded(t, { region: 'pl011_uart_0.target_socket', initiator: 'cpu_0.mem' }).index, 0);
  // Behind two routers: the path is the outer router first.
  const n = {
    instances: [{ name: 'cpu_0', base: 'cpu', index: 0 }, { name: 'dev', base: 'dev', index: null }],
    buses: ['top', 'sub'],
    connections: [{ from: 'cpu_0', fromBase: 'cpu', fromPort: 'mem', to: 'top', toPort: 'target_socket' }],
    memoryMap: [
      { instance: 'sub', base: 'sub', port: 'target_socket', bus: 'top', start: 0x40000000n, size: 0x1000000n, priority: 0 },
      { instance: 'dev', base: 'dev', port: 'target_socket', bus: 'sub', start: 0x100n, size: 0x100n, priority: 0 },
    ],
  };
  assert.deepStrictEqual(dataflow.routeFor(dataflow.routeTable(n), { region: 'dev.target_socket', initiator: 'cpu_0.mem' }).buses, ['top', 'sub']);
});

test('trace options: bus tracers name their router for agent 0.12.0 (who issued an access)', () => {
  const d = load();
  const t = trace.traceOptions(d, ['pl011_uart_0.target_socket'], '/x/vp_sim_agent', undefined, { router: true });
  assert.strictEqual(t.extraModules[0].params.router, 'router');
  assert.strictEqual(trace.traceOptions(d, ['pl011_uart_0.target_socket'], '/x/vp_sim_agent').extraModules[0].params.router, undefined);
  assert.ok(core.generate(d, { extraModules: t.extraModules, portOverrides: t.portOverrides }).includes('router = "router"'));
});

test('view: transaction route (Data flow rows, address lookup, a route sent by the trace panel)', () => {
  const d = load();
  const a = core.analyze(d, { catalog });
  const forms = params.moduleForms(d, a, catalog);
  const connections = new Map([...forms.keys()].map((b) => [b, connect.portRows(d, catalog, b)]));
  const spec = { region: 'pl011_uart_0.target_socket', initiator: 'cpu_3.mem', detail: 'write 0x10000000 · "quoted" <b>' };
  const html = view.render(d, a, 'nonce', 'x', undefined, forms, { connections, route: { id: 4, spec } });
  // The route table for the page, and the route bar above the diagram.
  const json = /<script type="application\/json" id="vp-routes">([^<]*)<\/script>/.exec(html);
  assert.ok(json && JSON.parse(json[1]).regions['pl011_uart_0.target_socket']);
  assert.ok(html.includes('<div class="route-bar"'));
  assert.ok(html.includes('function routeFor('));
  // The route the trace panel sent goes into the page, escaped.
  const m = /data-route="([^"]*)"/.exec(html);
  const back = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
  assert.deepStrictEqual(back, { id: 4, spec });
  assert.ok(!html.includes('<b>'));
  // Data flow rows of the CPU carry the route from the CPU; the router's from no initiator.
  const panel = (mod) => { const i = html.indexOf(`<section class="mod-panel" data-panel="${mod}"`); return html.slice(i, html.indexOf('</section>', i)); };
  assert.ok(panel('cpu').includes('data-route-region="pl011_uart_0.target_socket" data-route-from="cpu" data-route-bus="router"'));
  assert.ok(panel('router').includes('data-route-region="pl011_uart_0.target_socket" data-route-bus="router"'));
  // A device's "Reached from": each initiator chip previews its route.
  assert.ok(panel('pl011_uart_0').includes('data-route-region="pl011_uart_0.target_socket" data-route-from="cpu"'));
  // The diagram has the arrow for the route line; still no style attributes (CSP).
  assert.ok(html.includes('id="vp-arrow-route"'));
  assert.ok(!/<[^>]+\sstyle=/.test(html.replace(/<html style='[^']*'/, '')));
  // Without a route, no data-route attribute.
  assert.ok(!/data-route="/.test(view.render(d, a, 'nonce', 'x', undefined, forms, { connections })));
});

test('view: Transactions tab in the dock, and the page script compiles', () => {
  const d = load();
  const a = core.analyze(d, { catalog });
  const forms = params.moduleForms(d, a, catalog);
  const connections = new Map([...forms.keys()].map((b) => [b, connect.portRows(d, catalog, b)]));
  const html = view.render(d, a, 'nonce', 'x', undefined, forms, { connections, route: { id: 1, spec: { region: 'ram_0.target_socket', detail: 'a\nb "c"' } } });
  assert.ok(html.includes('<button class="dtab" role="tab" data-dock="tx">Transactions<span class="count tx-count">–</span></button>'));
  assert.ok(html.includes('<div class="dock-body" data-dock="tx" hidden>'));
  assert.ok(html.includes('<tbody class="tx-rows"></tbody>'));
  // The tab asks the extension for records while it is shown (txWatch); its buttons run only allowed commands.
  assert.ok(html.includes("post({type:'txWatch',on})"));
  for (const c of ['probes', 'trace']) assert.ok(html.includes(`class="run-cmd" data-command="${c}"`));
  // The route bar sits in the toolbar (it must not push the diagram down when it appears).
  const tb = html.indexOf('<div class="toolbar">');
  assert.ok(html.indexOf('<div class="route-bar"') > tb && html.indexOf('<div class="route-bar"') < html.indexOf('<div class="canvas">'));
  // Every inline script compiles (a slip in the template, such as a bare \n in a string, breaks the whole page).
  const scripts = [...html.matchAll(/<script nonce="nonce">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length >= 1);
  for (const src of scripts) assert.doesNotThrow(() => new Function(src));
});

test('webviews: the scripts of the profile and CPU register pages compile', () => {
  for (const html of [require('../lib/profileview').render('N2', 'x', 'Profile'), require('../lib/cpuregsview').render('N2', 'x')]) {
    const scripts = [...html.matchAll(/<script nonce="N2">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    assert.ok(scripts.length >= 1);
    for (const src of scripts) assert.doesNotThrow(() => new Function(src));
  }
});

test('debug port (G-13): module wiring for the Ubuntu example and the OpenOCD configuration', () => {
  const dd = require('../lib/debugdap');
  const d = load();
  const t = dd.targets(d);
  assert.deepStrictEqual(t.cpus.map((c) => c.name), ['cpu_0', 'cpu_1', 'cpu_2', 'cpu_3', 'cpu_4', 'cpu_5', 'cpu_6', 'cpu_7']);
  assert.strictEqual(t.bus, 'router');
  assert.deepStrictEqual(t.problems, []);
  // QBox's vp_debug_dap component (agent 0.14.0): no dylib, QBox finds it by the type name.
  const m = dd.dapModule(d, 3335);
  assert.strictEqual(m.dylib, undefined);
  assert.strictEqual(dd.dapModule(d, 3335, '/x/vp_sim_agent').dylib, '/x/vp_sim_agent'); // agent 0.13.0 carried it
  assert.deepStrictEqual(m.params, { port: 3335, cpus: 8, midr: 0x414FD0B1 });
  assert.deepStrictEqual(m.ports.mem, { bind: 'router.target_socket' });
  assert.deepStrictEqual(m.ports.halt_7, { bind: 'cpu_7.halt' });
  const lua = core.generate(d, { extraModules: [m] });
  // Type debug_dap, as its library: QBox finds build/debug_dap.so by the name, so no dylib_path.
  const dapLine = lua.split('\n').find((l) => l.includes('moduletype = "debug_dap"')) || '';
  assert.ok(dapLine && !dapLine.includes('dylib_path'));
  assert.ok(lua.includes('halt_3 = {bind = "&cpu_3.halt"}'));
  // A platform that already drives a CPU's halt signal is refused (the port needs it).
  const d2 = JSON.parse(JSON.stringify(d));
  d2.modules.resetctl = { type: 'keep_alive', ports: { out: { bind: 'cpu_2.halt' } } };
  assert.throws(() => dd.dapModule(d2, 1), /cpu_2\.halt is already connected/);
  // No Arm CPU: nothing to halt.
  assert.throws(() => dd.dapModule({ schemaVersion: '0.1', name: 'x', modules: { ram: { type: 'gs_memory' } } }, 1), /no Arm CPU/);
  // Where the probes come from, by agent version: QBox's components from 0.14.0, the agent's library before.
  const at = (v) => trace.probeLibraries(v, '/x/vp_sim_agent', require('../lib/pin').versionAtLeast);
  assert.deepStrictEqual(at('0.14.0'), { probes: 'probes', dap: null, types: { tracer: 'tracer', signal: 'signal_tracer', dap: 'debug_dap' }, inQbox: true, files: ['probes.so', 'debug_dap.so'] });
  assert.deepStrictEqual(at('0.13.0'), { probes: '/x/vp_sim_agent', dap: '/x/vp_sim_agent', types: { tracer: 'vp_tracer', signal: 'vp_signal_tracer', dap: 'vp_debug_dap' }, inQbox: false, files: [] });
  const t2 = trace.traceOptions(d, ['pl011_uart_0.target_socket'], at('0.14.0').probes);
  assert.ok(core.generate(d, { extraModules: t2.extraModules, portOverrides: t2.portOverrides }).includes('moduletype = "tracer"; dylib_path = "probes";'));
  // An agent up to 0.13.0 carries the old type names in its own library.
  const t3 = trace.traceOptions(d, ['pl011_uart_0.target_socket'], at('0.13.0').probes, undefined, { types: at('0.13.0').types });
  assert.deepStrictEqual([t3.extraModules[0].type, t3.extraModules[0].dylib], ['vp_tracer', '/x/vp_sim_agent']);
  assert.deepStrictEqual(at('0.13.0').types, { tracer: 'vp_tracer', signal: 'vp_signal_tracer', dap: 'vp_debug_dap' });
  assert.strictEqual(dd.dapModule(d, 1, at('0.13.0').dap, at('0.13.0').types.dap).type, 'vp_debug_dap');
  // The OpenOCD configuration matches the model's map.
  const cfg = dd.openocdConfig({ port: 3335, cpus: 2, platform: 'ubuntu-aarch64' });
  assert.ok(cfg.includes('remote_bitbang port 3335'));
  assert.ok(cfg.includes('jtag newtap vp cpu -irlen 4 -expected-id 0x4ba00477'));
  assert.ok(cfg.includes('target create vp.sys mem_ap -dap vp.dap -ap-num 0'));
  assert.ok(cfg.includes(`cti create vp.cti1 -dap vp.dap -ap-num 1 -baseaddr 0x${dd.ctiBase(1).toString(16).toUpperCase()}`));
  assert.strictEqual(dd.coreBase(1), 0x80030000);
  assert.strictEqual(dd.ctiBase(0), 0x80020000);
  assert.ok(cfg.includes('set VP_CORES 2') && /proc vp_halt \{n\}/.test(cfg) && /proc vp_resume \{n\}/.test(cfg));
  assert.ok(/proc vp_halt_all \{\}/.test(cfg) && /proc vp_resume_all \{\}/.test(cfg) && cfg.includes('vp.cti$k write GATE 3'));
  assert.ok(cfg.trim().endsWith('init'));
});

test('Build QBox, first build: QBox folder, CPM source cache and build-qbox.sh arguments', () => {
  const qs = require('../lib/qboxsetup');
  const os = require('os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-qbox-setup-'));
  try {
    const q = path.join(root, 'qbox');
    fs.mkdirSync(path.join(q, 'systemc-components'), { recursive: true });
    fs.writeFileSync(path.join(q, 'CMakePresets.json'), '{}');
    const other = path.join(root, 'notes');
    fs.mkdirSync(other); fs.writeFileSync(path.join(other, 'a.txt'), 'x');
    assert.strictEqual(qs.folderKind(q), 'qbox');
    assert.strictEqual(qs.folderKind(path.join(root, 'new')), 'empty');
    assert.strictEqual(qs.folderKind(other), 'other');
    // The folder vpStudio.executable points into comes first, then QBox workspace folders, no duplicates.
    const c = qs.sourceCandidates(path.join(q, 'build', 'platforms-vp'), [q, other]);
    assert.deepStrictEqual(c.map((x) => [x.dir, x.kind]), [[q, 'qbox']]);
    assert.deepStrictEqual(qs.sourceCandidates(path.join(root, 'fresh', 'build', 'platforms-vp'), [q]).map((x) => x.kind), ['empty', 'qbox']);
    // Cache choices: none and choose always; Packages (found by QBox), the environment and a lower-case packages folder when there.
    assert.deepStrictEqual(qs.cacheChoices(q, '').map((x) => x.id), ['none', 'choose']);
    fs.mkdirSync(path.join(q, 'packages'));
    assert.deepStrictEqual(qs.cacheChoices(q, '/cache/cpm').map((x) => [x.id, x.dir]), [['env', '/cache/cpm'], ['packages', path.join(q, 'packages')], ['none', null], ['choose', undefined]]);
    // Only QBox is built here: no catalog, no sim agent.
    assert.deepStrictEqual(qs.buildArgs({ script: '/s/build-qbox.sh', src: q }), ['/s/build-qbox.sh', '--no-catalog', '--no-agent', q]);
    assert.deepStrictEqual(qs.buildArgs({ script: 's', src: q, cache: '/c', targets: 'aarch64', jobs: 4 }), ['s', '--no-catalog', '--no-agent', '--jobs', '4', '--targets', 'aarch64', '--cpm-cache', '/c', q]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  // The script takes the options.
  const sh = fs.readFileSync(path.join(__dirname, '..', 'tools', 'qbox-pin', 'build-qbox.sh'), 'utf8');
  assert.ok(sh.includes('--cpm-cache) cpm="$2"') && sh.includes('--no-agent) agent=0') && sh.includes('-DCPM_SOURCE_CACHE='));
  // build-info.json goes into the build folder, and DEST/vp-studio is made only
  // for the agent or the catalog: Build QBox (--no-agent --no-catalog) leaves no
  // untracked folder in the QBox source tree (2026-11-21).
  assert.ok(sh.includes('"$dest/build/vp-studio-build-info.json"') && !sh.includes('$out/build-info.json'));
  assert.ok(sh.includes('if [ "$agent" = 1 ] || [ "$catalog" = 1 ]; then mkdir -p "$out"; fi'));
  assert.ok(!/^mkdir -p "\$out"$/m.test(sh));
  const ex = fs.readFileSync(path.join(__dirname, '..', 'tools', 'container', 'extract.sh'), 'utf8');
  assert.ok(ex.includes('/opt/qbox/build/vp-studio-build-info.json'));
});

test('QBox patch 0002: VP Studio components as a patch, registered in the pin, detected applied or not', () => {
  const pinLib = require('../lib/pin');
  const qs = require('../lib/qboxsetup');
  const os = require('os');
  const pin = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'qbox.pin.json'), 'utf8'));
  const rel = 'patches/qbox/0002-vp-studio-probes-debug-dap.patch';
  assert.ok(pin.qbox.patches.includes(rel));
  for (const p of pin.qbox.patches.concat(pin.libqemu.patches)) assert.ok(fs.existsSync(path.join(__dirname, '..', p)), p);
  const text = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  for (const f of ['probes/include/probes.h', 'probes/src/probes.cc', 'debug_dap/include/debug_dap.h', 'debug_dap/src/debug_dap.cc']) assert.ok(text.includes('+++ b/systemc-components/' + f), f);
  assert.ok(text.includes('+add_subdirectory(probes)') && text.includes('+add_subdirectory(debug_dap)'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-patch-'));
  try {
    const q = path.join(root, 'qbox');
    fs.mkdirSync(path.join(q, 'systemc-components'), { recursive: true });
    fs.writeFileSync(path.join(q, 'CMakePresets.json'), '{}');
    fs.writeFileSync(path.join(q, 'systemc-components', 'CMakeLists.txt'), 'add_subdirectory(uart)\n');
    // A clean QBox: the files the patch creates are missing, so "not applied" (was "unknown").
    assert.strictEqual(pinLib.patchApplied(text, q), false);
    const mini = '--- a/x.txt\n+++ b/x.txt\n@@\n+added line\n--- /dev/null\n+++ b/new/y.txt\n@@\n+new file line\n';
    fs.writeFileSync(path.join(q, 'x.txt'), 'added line\n');
    assert.strictEqual(pinLib.patchApplied(mini, q), false);
    fs.mkdirSync(path.join(q, 'new')); fs.writeFileSync(path.join(q, 'new', 'y.txt'), 'new file line\n');
    assert.strictEqual(pinLib.patchApplied(mini, q), true);
    // Build QBox: with the patch in the pin, a QBox without the components still builds the agent when the patches are applied.
    const st = qs.inspect(q, { pin });
    assert.strictEqual(st.hasProbes, false);
    assert.strictEqual(st.probesPatch, true);
    const f = qs.defaults(st, pin, 4, {});
    assert.strictEqual(f.agent, true);
    const agentWarn = (form) => qs.check(form, st).warnings.filter((w) => /VP Studio components/.test(w));
    assert.deepStrictEqual(agentWarn(f), []);
    assert.ok(/turn on "Apply the patches"/.test(agentWarn(Object.assign({}, f, { patches: false }))[0]));
    // The agent is built against the QBox VP Studio uses: warn when that is another one and this one is not taken.
    const other = { simulator: '/elsewhere/build/platforms-vp' };
    assert.ok(qs.check(Object.assign({}, f, { useForSim: false }), st, other).warnings.some((w) => /not built/.test(w)));
    assert.ok(!qs.check(Object.assign({}, f, { useForSim: true }), st, other).warnings.some((w) => /not built/.test(w)));
    assert.ok(!qs.check(Object.assign({}, f, { useForSim: false }), st, { simulator: path.join(q, 'build', 'platforms-vp') }).warnings.some((w) => /not built/.test(w)));
    const empty = qs.inspect(path.join(root, 'new-clone'), { pin });
    assert.strictEqual(qs.defaults(empty, pin, 4, {}).agent, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('QBox patch 0003: the perf models, registered after 0002, away from 0002\'s lines', () => {
  const pin = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'qbox.pin.json'), 'utf8'));
  const rel = 'patches/qbox/0003-vp-studio-perf-models.patch';
  assert.ok(pin.qbox.patches.indexOf(rel) > pin.qbox.patches.indexOf('patches/qbox/0002-vp-studio-probes-debug-dap.patch'));
  const text = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  assert.match(text, /^From: VP Studio\nSubject: \[PATCH\] systemc-components: add VP Studio's perf models\n/);
  for (const f of ['perf/CMakeLists.txt', 'perf/README.md', 'perf/include/perf.h', 'perf/src/perf.cc']) assert.ok(text.includes('+++ b/systemc-components/' + f), f);
  for (const t of ['traffic_gen', 'at_bus', 'dram_ctrl', 'perf_stats']) assert.ok(text.includes(`GSC_MODULE_REGISTER_C(${t})`), t);
  // The CMakeLists line goes at the end of the file, more than 3 lines from 0002's: build-qbox.sh
  // recognises an applied patch with "git apply --reverse --check", which needs each patch's context intact.
  const hunk = /\+\+\+ b\/systemc-components\/CMakeLists\.txt\n(@@[^\n]*\n(?:[ +-][^\n]*\n)+)/.exec(text)[1];
  assert.ok(hunk.includes('+add_subdirectory(perf)') && !/probes|debug_dap|realtimelimiter/.test(hunk));
  // The catalog knows the types, from perf.so.
  const cat = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'catalog', 'qbox-catalog.json'), 'utf8'));
  for (const t of ['traffic_gen', 'at_bus', 'dram_ctrl', 'perf_stats']) assert.strictEqual(cat.modules[t].library, 'perf.so', t);
  assert.deepStrictEqual(cat.modules.at_bus.introspection.ports.map((p) => [p.name, p.kind]), [['target_socket', 'tlm_target'], ['initiator_socket', 'tlm_initiator']]);
  assert.ok(cat.modules.dram_ctrl.introspection.params.some((p) => p.name === 'scheduler' && p.default === 'fr_fcfs'));
  // Add Module writes the library: the types are not named like it.
  assert.deepStrictEqual(require('../lib/modules').moduleDef(cat, 'traffic_gen'), { type: 'traffic_gen', dylib: 'perf' });
  // perf 1.1.0: QoS per master on at_bus, priority scheduling in dram_ctrl; perf.so and lib/qos.js know the same keys.
  assert.ok(cat.modules.at_bus.introspection.params.some((p) => p.name === 'masters' && p.default === ''));
  assert.ok(cat.modules.dram_ctrl.introspection.params.some((p) => p.name === 'qos' && p.default === false));
  assert.match(text, /PERF_VERSION "1\.2\.0"/);
  // perf 1.2.0: a crossbar, and buses behind buses.
  assert.ok(cat.modules.at_bus.introspection.params.some((p) => p.name === 'topology' && p.default === 'shared'));
  assert.ok(cat.modules.at_bus.introspection.params.some((p) => p.name === 'input_queue' && p.default === 1));
  for (const k of Object.keys(require('../lib/qos').KEYS)) assert.ok(text.includes(`k == "${k}"`), k);
});

test('Build QBox: CMake Tools configuring QBox by itself, and turning it off', () => {
  const qs = require('../lib/qboxsetup');
  const os = require('os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-qbox-cmt-'));
  try {
    const q = path.join(root, 'qbox');
    fs.mkdirSync(path.join(q, 'systemc-components'), { recursive: true });
    fs.writeFileSync(path.join(q, 'CMakePresets.json'), '{}');
    // Not installed: nothing to say.
    assert.strictEqual(qs.cmakeTools(q, {}), null);
    assert.strictEqual(qs.inspect(q, {}).cmakeTools, null);
    // Installed, no settings: all three default to true.
    const a = qs.cmakeTools(q, { installed: true });
    assert.deepStrictEqual(a.auto, qs.CMAKE_TOOLS_OFF);
    assert.strictEqual(a.configuredBy, false);
    // User settings count unless the folder overrides them.
    assert.deepStrictEqual(qs.cmakeTools(q, { installed: true, user: { 'cmake.configureOnOpen': false } }).auto, ['cmake.automaticReconfigure', 'cmake.configureOnEdit']);
    fs.mkdirSync(path.join(q, '.vscode'));
    const f = path.join(q, '.vscode', 'settings.json');
    fs.writeFileSync(f, '{\n    // mine\n    "a.b": "x//y",\n    "cmake.configureOnOpen": true,\n}\n');
    assert.deepStrictEqual(qs.parseSettings(fs.readFileSync(f, 'utf8')), { 'a.b': 'x//y', 'cmake.configureOnOpen': true });
    assert.strictEqual(qs.cmakeTools(q, { installed: true, user: { 'cmake.configureOnOpen': false } }).auto[0], 'cmake.configureOnOpen');
    // A file with comments is not rewritten.
    assert.throws(() => qs.cmakeToolsOffText(fs.readFileSync(f, 'utf8')), /comments/);
    // Turning off: keeps other settings, sets existing keys and adds the others.
    const t = qs.cmakeToolsOffText('{\n    "vpStudio.platformView.openBeside": false,\n    "cmake.configureOnOpen": true\n}\n');
    assert.deepStrictEqual(JSON.parse(t), { 'vpStudio.platformView.openBeside': false, 'cmake.configureOnOpen': false, 'cmake.automaticReconfigure': false, 'cmake.configureOnEdit': false });
    assert.ok(t.includes('\n    "cmake.configureOnEdit": false'));
    assert.deepStrictEqual(JSON.parse(qs.cmakeToolsOffText('')), { 'cmake.configureOnOpen': false, 'cmake.automaticReconfigure': false, 'cmake.configureOnEdit': false });
    fs.writeFileSync(f, qs.cmakeToolsOffText(''));
    assert.deepStrictEqual(qs.cmakeTools(q, { installed: true }).auto, []);
    // A build directory CMake Tools configured, while it still would: one warning saying so.
    fs.writeFileSync(f, '{}');
    fs.mkdirSync(path.join(q, 'build', '.cmake', 'api', 'v1', 'query', 'client-vscode'), { recursive: true });
    const st = qs.inspect(q, { cmakeTools: { installed: true } });
    assert.strictEqual(st.cmakeTools.configuredBy, true);
    const w = qs.check({ src: q, targets: ['aarch64'], cache: { mode: 'none' }, patches: true, checkout: false, agent: false }, st).warnings.filter((x) => /CMake Tools/.test(x));
    assert.strictEqual(w.length, 1);
    assert.ok(/has configured this build directory before/.test(w[0]));
    fs.writeFileSync(f, qs.cmakeToolsOffText('{}'));
    assert.ok(!qs.check({ src: q, targets: ['aarch64'], cache: { mode: 'none' }, patches: true, checkout: false, agent: false }, qs.inspect(q, { cmakeTools: { installed: true } })).warnings.some((x) => /CMake Tools/.test(x)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Build QBox view: what the build directory was configured with, defaults that change nothing, checks', () => {
  const qs = require('../lib/qboxsetup');
  const os = require('os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-qbox-view-'));
  try {
    const q = path.join(root, 'qbox');
    fs.mkdirSync(path.join(q, 'systemc-components'), { recursive: true });
    fs.mkdirSync(path.join(q, 'packages'));
    fs.writeFileSync(path.join(q, 'CMakePresets.json'), JSON.stringify({ configurePresets: [
      { name: '_base', hidden: true }, { name: 'gcc', displayName: 'GCC (Release, Make)' }, { name: 'gcc-debug' }, { name: 'clang' }, { name: 'mac' }, { name: 'win-gcc' }] }));
    assert.deepStrictEqual(qs.presets(q).map((p) => p.name), ['gcc', 'gcc-debug', 'clang']);
    // Not configured yet: the pin decides.
    const pin = { qbox: { commit: 'a'.repeat(40), patches: [] }, build: { preset: 'gcc', libqemuTargets: ['aarch64', 'riscv64'] } };
    let st = qs.inspect(q, { pin, studioDir: root });
    assert.strictEqual(st.cache.configured, false);
    let f = qs.defaults(st, pin, 4);
    assert.deepStrictEqual([f.preset, f.targets, f.cache.mode, f.checkout, f.patches], ['gcc', ['aarch64', 'riscv64'], 'none', false, true]);
    // No VP Studio components in this QBox: the sim agent (linked to probes.so) is not built by default, and asking for it warns.
    assert.deepStrictEqual([st.hasProbes, f.agent], [false, false]);
    assert.ok(/cannot be built/.test(qs.check(Object.assign({}, f, { agent: true }), st).warnings.join(' ')));
    fs.mkdirSync(path.join(q, 'systemc-components', 'probes'));
    assert.strictEqual(qs.defaults(qs.inspect(q, { pin, studioDir: root }), pin, 4).agent, true);
    // Configured (as the user's QBox): aarch64 only, a lower-case packages cache, GCC Release.
    fs.mkdirSync(path.join(q, 'build'));
    fs.writeFileSync(path.join(q, 'build', 'CMakeCache.txt'), [
      'CMAKE_BUILD_TYPE:STRING=Release', 'CMAKE_CXX_COMPILER:FILEPATH=/usr/lib/ccache/c++', 'LIBQEMU_TARGETS:UNINITIALIZED=aarch64',
      `CPM_SOURCE_CACHE:PATH=${path.join(q, 'packages')}`, 'CMAKE_GENERATOR:INTERNAL=Unix Makefiles'].join('\n'));
    st = qs.inspect(q, { pin, studioDir: root });
    assert.deepStrictEqual([st.cache.compiler, st.cache.buildType, st.cache.targets, st.cache.preset], ['gcc', 'Release', ['aarch64'], 'gcc']);
    f = qs.defaults(st, pin, 4);
    // Defaults are the configured settings, so Build changes nothing (no rebuild of other targets).
    assert.deepStrictEqual([f.preset, f.targets, f.cache.mode, f.cache.dir], ['gcc', ['aarch64'], 'packages', path.join(q, 'packages')]);
    assert.deepStrictEqual(qs.check(f, st), { errors: [], warnings: [], changes: [] });
    assert.deepStrictEqual(qs.argsFor(f, 'b.sh'), ['b.sh', '--no-catalog', '--no-agent', '--jobs', '4', '--preset', 'gcc', '--targets', 'aarch64', '--cpm-cache', path.join(q, 'packages'), '--no-checkout', q]);
    // Changes are listed; a compiler change is refused (CMake cannot do it in place).
    const g = Object.assign({}, f, { targets: ['aarch64', 'riscv64'], preset: 'gcc-debug', cache: { mode: 'none', dir: null } });
    const c = qs.check(g, st);
    assert.deepStrictEqual(c.errors, []);
    assert.strictEqual(c.changes.length, 3);
    assert.ok(/QEMU targets aarch64 → aarch64, riscv64/.test(c.changes.join(' ')) && /Release → Debug/.test(c.changes.join(' ')) && /package cache .* → none/.test(c.changes.join(' ')));
    assert.ok(/cannot change the compiler/.test(qs.check(Object.assign({}, f, { preset: 'clang' }), st).errors[0]));
    assert.ok(/at least one QEMU target/.test(qs.check(Object.assign({}, f, { targets: [] }), st).errors[0]));
    assert.ok(/patches are not applied/.test(qs.check(Object.assign({}, f, { patches: false }), st).warnings[0]));
    // Not at the pinned commit: a warning; checking out over local changes: refused.
    const other = Object.assign({}, st, { head: 'b'.repeat(40), pinned: 'a'.repeat(40), atPin: false, dirty: true });
    assert.ok(/not the pinned/.test(qs.check(f, other).warnings[0]));
    assert.ok(/commit or stash/.test(qs.check(Object.assign({}, f, { checkout: true }), other).errors[0]));
    const a2 = qs.argsFor(Object.assign({}, f, { checkout: true, patches: false }), 'b.sh');
    assert.ok(a2.includes('--no-patches') && !a2.includes('--no-checkout') && a2[a2.length - 1] === q);
    // QBox's own Packages folder is not passed (QBox uses it by itself).
    assert.strictEqual(qs.cacheDir({ src: q, cache: { mode: 'Packages', dir: path.join(q, 'Packages') } }), null);
    assert.strictEqual(qs.commandLine(['bash', "/a b/it's"]), "bash '/a b/it'\\''s'");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Build QBox view: the page script compiles, no style attributes, stable ids', () => {
  const html = require('../lib/qboxview').render('N3', 'x');
  const scripts = [...html.matchAll(/<script nonce="N3">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length === 1);
  assert.doesNotThrow(() => new Function(scripts[0]));
  assert.ok(!/<[^>]+\sstyle=/.test(html));
  for (const id of ['src', 'src-browse', 'checkout', 'preset', 'targets', 'jobs', 'cache', 'cache-dir', 'cache-browse', 'patches', 'plist', 'agent', 'useForSim', 'msgs', 'cmd', 'build', 'move']) {
    assert.ok(html.includes(`id="${id}"`), id);
  }
  assert.ok(html.includes("post({ type: 'ready' })") && html.includes("post({ type: 'build' })"));
});

test('trace view: Initiator column and clickable bus accesses', () => {
  const html = require('../lib/traceview').render('N1', 'vscode-resource:', 'Trace');
  // The page script compiles (a quote escaped for the template, such as \\', breaks the whole panel).
  const scripts = [...html.matchAll(/<script nonce="N1">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length >= 1);
  for (const src of scripts) assert.doesNotThrow(() => new Function(src));
  assert.ok(html.includes('<th>Point</th><th title="Who issued the access (sim agent 0.12.0 and later)">Initiator</th><th>Access</th>'));
  assert.ok(html.includes("type: 'showRoute'"));
});

test('view: Socket Inspector and Data flow tab in the inspector', () => {
  const d = load();
  const a = core.analyze(d, { catalog });
  const forms = params.moduleForms(d, a, catalog);
  const connections = new Map([...forms.keys()].map((b) => [b, connect.portRows(d, catalog, b)]));
  const html = view.render(d, a, 'nonce', 'x', undefined, forms, { connections });
  const panel = (m) => { const i = html.indexOf(`<section class="mod-panel" data-panel="${m}"`); return html.slice(i, html.indexOf('</section>', i)); };
  // The router's initiator socket lists its targets with their addresses, in address order.
  const router = panel('router');
  assert.match(router, /data-tab="flow">Data flow/);
  const conns = router.slice(router.indexOf('data-tab="conns" hidden'));
  assert.match(conns, /dir-init[^>]*>▼ Initiator/);
  assert.ok(conns.indexOf('fallback_0.target_socket') < conns.indexOf('pl011_uart_0.target_socket'));
  assert.ok(conns.indexOf('pl011_uart_0.target_socket') < conns.indexOf('ram_0.target_socket'));
  assert.match(conns, /0x1000_0000 – 0x1000_0FFF · 4 KiB/);
  // Every connection keeps its Disconnect button with the data the extension needs.
  assert.match(conns, /class="unbind x" data-module="pl011_uart_0" data-key="target_socket" data-scope=""/);
  // The CPU: bus first, then signals; unused ports folded away.
  const cpu = panel('cpu');
  assert.ok(cpu.indexOf('c-group-h">Bus') < cpu.indexOf('c-group-h">Signals'));
  assert.match(cpu, /<details class="c-free"><summary>\d+ unconnected ports<\/summary>/);
  assert.match(cpu, /class="connect" data-module="cpu" data-port="halt"/);
  // Data flow: the CPU reaches the UART; the UART is reached from the CPUs.
  assert.match(cpu, /<span class="mono">mem<\/span> ×8/);
  assert.match(cpu, /data-module="pl011_uart_0">pl011_uart_0\.target_socket/);
  assert.match(panel('pl011_uart_0'), /Reached from[\s\S]*cpu\.mem ×8/);
  // Modules without bus traffic get no Data flow tab; nothing uses style attributes (CSP).
  assert.doesNotMatch(panel('charbackend_stdio_0'), /data-tab="flow"/);
  assert.doesNotMatch(html, /<[a-z][^>]*\sstyle="/i);
});

// ------------------------------------------------------------------ sim agent

const agent = require('../lib/simagent');

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

test('param tree groups dotted names, objects first, numeric order', () => {
  const tree = agent.buildParamTree([
    { name: 'platform.cpu_10.gdb_port', value: 0 },
    { name: 'platform.cpu_2.gdb_port', value: 0 },
    { name: 'platform.quantum_ns', value: 1000 },
    { name: 'log_level', value: 0 },
    { name: 'platform.cpu_2', value: 'odd but legal' },
  ]);
  assert.deepStrictEqual(tree.map((n) => n.label), ['platform', 'log_level']);
  const plat = tree[0];
  assert.deepStrictEqual(plat.children.map((n) => n.label), ['cpu_2', 'cpu_10', 'cpu_2', 'quantum_ns']);
  assert.strictEqual(plat.children[1].children[0].path, 'platform.cpu_10.gdb_port');
  assert.strictEqual(plat.children[2].param.value, 'odd but legal');
});

test('param values format on one line', () => {
  assert.strictEqual(agent.formatValue('a"b'), '"a\\"b"');
  assert.strictEqual(agent.formatValue(null), '—');
  assert.strictEqual(agent.formatValue(42), '42');
  assert.ok(agent.formatValue(Array(100).fill(1)).endsWith('…'));
});

test('simulated time formats with a fitting unit', () => {
  assert.strictEqual(agent.formatTime(0), '0 s');
  assert.strictEqual(agent.formatTime(19.090650666), '19.091 s');
  assert.strictEqual(agent.formatTime(0.25), '250 ms');
  assert.strictEqual(agent.formatTime(1.5e-5), '15 µs');
  assert.strictEqual(agent.formatTime(2e-9), '2 ns');
  assert.strictEqual(agent.formatTime(undefined), '?');
});

test('typed simulated times parse into what sim.runFor accepts', () => {
  const near = (a, b) => assert.ok(Math.abs(a - b) <= Math.abs(b) * 1e-12, `${a} != ${b}`);
  const p = agent.parseSimTime;
  assert.deepStrictEqual(p('500 ms'), { seconds: 0.5, text: '500 ms' });
  assert.strictEqual(p('1.5s').text, '1.5 s');
  near(p('1.5s').seconds, 1.5);
  assert.strictEqual(p('2').text, '2 s'); // no unit: seconds, as the agent reads a bare number
  assert.strictEqual(p(' 250 us ').text, '250 us');
  assert.strictEqual(p('250 µs').text, '250 us'); // the agent gets the ASCII spelling
  near(p('250 µs').seconds, 250e-6);
  assert.strictEqual(p('10 MS').text, '10 ms');
  near(p('1e3 ns').seconds, 1e-6);
  near(p('.5 ps').seconds, 0.5e-12);
  for (const bad of ['', 'abc', '-1 ms', '1 parsec', '1 2 ms', 'ms']) {
    assert.throws(() => p(bad), Error, bad);
  }
  assert.throws(() => p('1 min'), /Unknown unit "min"/);
});


/** A fake agent: answers each request line with reply(msg), which may return a string, object or undefined. */
function fakeAgent(reply) {
  const net = require('net');
  return new Promise((resolve) => {
    const sockets = [];
    const srv = net.createServer((s) => {
      sockets.push(s);
      let buf = '';
      s.setEncoding('utf8');
      s.on('data', (d) => {
        buf += d;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const msg = JSON.parse(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
          const out = reply(msg, s);
          if (out !== undefined) s.write((typeof out === 'string' ? out : JSON.stringify(out)) + '\n');
        }
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({
      port: srv.address().port,
      close: () => { sockets.forEach((s) => s.destroy()); srv.close(); },
    }));
  });
}

testAsync('agent client: results, errors and notifications', async () => {
  const srv = await fakeAgent((m, s) => {
    if (m.method === 'sim.pause') {
      // Partial writes and a notification ahead of the response.
      const n = JSON.stringify({ jsonrpc: '2.0', method: 'sim.stateChanged', params: { state: 'paused' } });
      const r = JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { state: 'paused' } });
      s.write(n.slice(0, 10));
      setTimeout(() => s.write(n.slice(10) + '\n' + r + '\n'), 20);
      return undefined;
    }
    if (m.method === 'cci.getParam') return { jsonrpc: '2.0', id: m.id, error: { code: -32001, message: 'no parameter named x' } };
    return { jsonrpc: '2.0', id: m.id, result: { echo: m.params } };
  });
  const c = await agent.SimAgentClient.connect({ port: srv.port });
  const notes = [];
  c.on('notification', (method, params) => notes.push([method, params.state]));
  assert.deepStrictEqual(await c.request('x', { a: 1 }), { echo: { a: 1 } });
  assert.deepStrictEqual(await c.request('sim.pause'), { state: 'paused' });
  assert.deepStrictEqual(notes, [['sim.stateChanged', 'paused']]);
  await assert.rejects(c.request('cci.getParam', { name: 'x' }), (e) => e instanceof agent.RpcError && e.code === -32001);
  c.close();
  srv.close();
});

testAsync('agent client: pending requests fail when the simulator goes away', async () => {
  const srv = await fakeAgent(() => undefined); // never answers
  const c = await agent.SimAgentClient.connect({ port: srv.port });
  let closed = false;
  c.on('close', () => { closed = true; });
  const p = c.request('sim.getStatus');
  srv.close();
  await assert.rejects(p, /closed/);
  assert.ok(closed);
  await assert.rejects(c.request('sim.getStatus'), /not connected/);
});

testAsync('agent client: request timeout', async () => {
  const srv = await fakeAgent(() => undefined);
  const c = await agent.SimAgentClient.connect({ port: srv.port });
  await assert.rejects(c.request('sim.getStatus', undefined, { timeoutMs: 50 }), /no answer/);
  c.close();
  srv.close();
});

testAsync('agent client: connectWithRetry waits for the agent, and gives up', async () => {
  const port = await agent.freePort();
  assert.strictEqual(await agent.connectWithRetry({ port, totalMs: 300, intervalMs: 50 }), undefined);
  let stop = false;
  setTimeout(() => { stop = true; }, 100);
  const t0 = Date.now();
  assert.strictEqual(await agent.connectWithRetry({ port, totalMs: 5000, intervalMs: 20, shouldStop: () => stop }), undefined);
  assert.ok(Date.now() - t0 < 2000);
  const srv = await fakeAgent((m) => ({ jsonrpc: '2.0', id: m.id, result: 1 }));
  const c = await agent.connectWithRetry({ port: srv.port, totalMs: 2000 });
  assert.strictEqual(await c.request('agent.getInfo'), 1);
  c.close();
  srv.close();
});

testAsync('agent client: with handshake, a tunnel that accepts and closes is retried', async () => {
  const net = require('net');
  // Like ssh -L before the remote agent listens: accept, then close at once.
  let accepted = 0;
  const tunnel = net.createServer((sock) => { accepted++; sock.destroy(); });
  await new Promise((r) => tunnel.listen(0, '127.0.0.1', r));
  const port = tunnel.address().port;
  assert.strictEqual(await agent.connectWithRetry({ port, totalMs: 600, intervalMs: 50, handshake: true }), undefined);
  assert.ok(accepted >= 2);
  // Without the handshake the first accept counts as connected.
  const c0 = await agent.connectWithRetry({ port, totalMs: 600, intervalMs: 50 });
  assert.ok(c0);
  c0.close();
  tunnel.close();
  const srv = await fakeAgent((m) => ({ jsonrpc: '2.0', id: m.id, result: { protocol: 1 } }));
  const c = await agent.connectWithRetry({ port: srv.port, totalMs: 2000, handshake: true });
  assert.deepStrictEqual(await c.request('agent.getInfo'), { protocol: 1 });
  c.close();
  srv.close();
});

// ------------------------------------------------------------------ setting parameters at run time
test('set param: input text is checked by category and C++ type', () => {
  const sa = require('../lib/simagent');
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
  const params = require('../lib/params');
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

// ------------------------------------------------------------------ device tree
test('lua expressions: precedence, truthiness, math, and refusal', () => {
  const { evaluate } = require('../lib/luaexpr');
  const aff = '(math.floor(i / 8) << 8) | (i % 8)';
  assert.deepStrictEqual([0, 7, 8, 9, 17].map((i) => evaluate(aff, { i })), [0, 7, 256, 257, 513]);
  const conduit = 'ACCEL == "kvm" and "hvc" or "smc"';
  assert.strictEqual(evaluate(conduit, { ACCEL: 'tcg' }), 'smc');
  assert.strictEqual(evaluate(conduit, { ACCEL: 'kvm' }), 'hvc');
  assert.strictEqual(evaluate('2^3^2'), 512);
  assert.strictEqual(evaluate('-2^2'), -4);
  assert.strictEqual(evaluate('1 + 2 * 3 << 1'), 14);
  assert.strictEqual(evaluate('-7 % 3'), 2);
  assert.strictEqual(evaluate('7 // 2'), 3);
  assert.strictEqual(evaluate('nil or false'), false);
  assert.strictEqual(evaluate('0 and "zero is true in Lua"'), 'zero is true in Lua');
  assert.strictEqual(evaluate("'a' .. 'b' .. 1"), 'ab1');
  assert.strictEqual(evaluate('0x10 ~= 16'), false);
  for (const bad of ['f(1)', 'x.y', 'a', '1 +', '(1', 'math.huge', '{1}', '1 2']) assert.throws(() => evaluate(bad), Error, bad);
});

test('device tree: Ubuntu platform matches its addresses and interrupts', () => {
  const dt = require('../lib/devicetree');
  const doc = load();
  doc.devicetree = { bootargs: 'console=ttyAMA0 root=LABEL=root-arm64' };
  const sizes = { 'image_ext4_initrd.img': 0x0c26be30 };
  const r = dt.generate(doc, { topDir: '/plat', fileSize: (f) => sizes[path.basename(f)] ?? null });
  const s = r.dts;
  // CPUs from mp_affinity (Lua) and the PSCI conduit (Lua, with ACCEL = tcg).
  assert.strictEqual((s.match(/cpu@\d+ \{/g) || []).length, 8);
  assert.match(s, /cpu_7: cpu@7 \{\n\t\t\tdevice_type = "cpu";\n\t\t\tcompatible = "arm,cortex-a76";\n\t\t\treg = <0x7>;\n\t\t\tenable-method = "psci";/);
  assert.match(s, /psci \{[^}]*method = "smc";/);
  // Timer and PMU PPIs: ppi_in_cpu_0_N is INTID N, PPI N-16 (sec 29, phys 30, virt 27, hyp 26).
  assert.match(s, /interrupts = <0x1 0xd 0x4 0x1 0xe 0x4 0x1 0xb 0x4 0x1 0xa 0x4>;/);
  assert.match(s, /pmu \{\n\t\tcompatible = "arm,armv8-pmuv3";\n\t\tinterrupts = <0x1 0x7 0x4>;/);
  // GICv3 with the maintenance interrupt, SPIs as the spi_in index.
  assert.match(s, /gic_0: interrupt-controller@17a00000 \{\n\t\tcompatible = "arm,gic-v3";\n\t\treg = <0x0 0x17a00000 0x0 0x60000>,\n\t\t\t<0x0 0x17a60000 0x0 0x1c0000>;/);
  assert.match(s, /#interrupt-cells = <0x3>;\n\t\tinterrupt-controller;[\s\S]*?interrupts = <0x1 0x9 0x4>;/);
  assert.match(s, /pl011_uart_0: serial@10000000 \{[^}]*interrupts = <0x0 0x17b 0x4>;[^}]*clocks = <&apb_pclk &apb_pclk>;/);
  assert.match(s, /virtioblk_0: virtio_mmio@1c0d0000 \{[^}]*reg = <0x0 0x1c0d0000 0x0 0x2000>;\n\t\tinterrupts = <0x0 0x2e 0x4>;/);
  assert.match(s, /virtionet0_0: virtio_mmio@1c120000 \{[^}]*interrupts = <0x0 0x12 0x4>;/);
  // PCIe: ECAM, 1:1 windows, INTx swizzle over irq_out_0..3 = SPI 541..544.
  assert.match(s, /pcie@43b50000 \{[^}]*bus-range = <0x0 0xff>;/);
  assert.match(s, /ranges = <0x1000000 0x0 0x60200000 0x0 0x60200000 0x0 0x100000>,\n\t\t\t<0x2000000 0x0 0x60300000 0x0 0x60300000 0x0 0x1fd00000>,\n\t\t\t<0x3000000 0x4 0x0 0x4 0x0 0x2 0x0>;/);
  assert.match(s, /<0x800 0x0 0x0 0x1 &gic_0 0x0 0x0 0x0 0x21e 0x4>/);
  assert.match(s, /<0x1800 0x0 0x0 0x4 &gic_0 0x0 0x0 0x0 0x21f 0x4>;/);
  // RAM only: the background memory is left out, with a note.
  assert.match(s, /memory@80000000 \{\n\t\tdevice_type = "memory";\n\t\treg = <0x0 0x80000000 0x1 0x0>;/);
  assert.ok(!/memory@0 /.test(s));
  assert.ok(r.notes.some((n) => n.module === 'fallback_0' && n.level === 'info'));
  // chosen: bootargs, console, initrd range from the loader entry and the file size.
  assert.match(s, /chosen \{\n\t\tbootargs = "console=ttyAMA0 root=LABEL=root-arm64";\n\t\tstdout-path = "\/serial@10000000";\n\t\tlinux,initrd-start = <0x0 0x8a800000>;\n\t\tlinux,initrd-end = <0x0 0x96a6be30>;/);
  assert.match(s, /serial0 = "\/serial@10000000";/);
  assert.deepStrictEqual(r.notes.filter((n) => n.level === 'warning'), []);
  // No bootargs: a warning, as Linux then has no root=.
  const nb = load();
  assert.ok(dt.generate(nb, { topDir: '/plat', fileSize: () => 16 }).notes.some((n) => n.level === 'warning' && /bootargs is not set/.test(n.text)));
  // Nodes are sorted by address after the CPU-level ones.
  assert.ok(s.indexOf('serial@10000000') < s.indexOf('interrupt-controller@17a00000') && s.indexOf('pcie@43b50000') < s.indexOf('memory@80000000'));
});

test('device tree: overrides, unknown devices, missing pieces', () => {
  const dt = require('../lib/devicetree');
  const doc = load();
  // An unknown device with a bus address: described by the platform, or noted.
  doc.modules.timer_0 = { type: 'my_timer', ports: { regs: { address: '0x1c000000', size: '0x1000', bind: 'router.initiator_socket' }, irq: { bind: 'gic_0.spi_in_70' } } };
  doc.modules.thing_0 = { type: 'my_thing', ports: { regs: { address: '0x1d000000', size: '0x100', bind: 'router.initiator_socket' } } };
  doc.modules.timer_0.devicetree = { compatible: ['acme,timer'], name: 'timer', properties: { 'clock-frequency': 1000000, 'acme,mode': 'fast', 'wakeup-source': true } };
  doc.modules.virtionet0_0.devicetree = false;
  doc.devicetree = { initrd: false, stdout: 'pl011_uart_0', extra: 'reserved-memory { };', model: 'm', compatible: ['a,b', 'c'] };
  let r = dt.generate(doc, { fileSize: () => 1 });
  assert.match(r.dts, /timer_0: timer@1c000000 \{\n\t\tcompatible = "acme,timer";\n\t\treg = <0x0 0x1c000000 0x0 0x1000>;\n\t\tinterrupts = <0x0 0x46 0x4>;\n\t\tclock-frequency = <0xf4240>;\n\t\tacme,mode = "fast";\n\t\twakeup-source;/);
  assert.ok(!/virtio_mmio@1c120000/.test(r.dts));
  assert.ok(!/initrd/.test(r.dts));
  assert.match(r.dts, /\/\* devicetree.extra \*\/\n\treserved-memory \{ \};\n\};\n$/);
  assert.match(r.dts, /model = "m";\n\tcompatible = "a,b", "c";/);
  assert.ok(r.notes.some((n) => n.module === 'thing_0' && /0x1d000000 is not described/.test(n.text)));
  // No timer wiring and no PSCI: warnings say what is missing.
  delete doc.modules.cpu.ports.irq_timer_phys_out;
  doc.modules.cpu.params.psci_conduit = 'disabled';
  doc.devicetree.stdout = 'nope';
  r = dt.generate(doc, { fileSize: () => null });
  const w = r.notes.filter((n) => n.level === 'warning').map((n) => n.text).join('\n');
  assert.match(w, /irq_timer_phys_out\) are not wired/);
  assert.match(w, /psci_conduit is not set/);
  assert.match(w, /devicetree.stdout: nope is not a UART/);
  assert.ok(!/enable-method/.test(r.dts));
  assert.strictEqual(dt.cpuCompatible('cpu_arm_neoverseN2'), 'arm,neoverse-n2');
  assert.strictEqual(dt.cpuCompatible('cpu_arm_cortexA53'), 'arm,cortex-a53');
  assert.strictEqual(dt.cpuCompatible('cpu_riscv64'), null);
});

test('bundled modules: platforms name the type only; the library path is supplied at generation', () => {
  const models = require('../lib/models');
  const modules = require('../lib/modules');
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
  assert.match(require('../lib/devicetree').generate(d, { fileSize: () => 16 }).dts, /compatible = "arm,cortex-a73";/);
});

test('disk space: ext4 superblock free space and the low-space check', () => {
  const os = require('os');
  const diskspace = require('../lib/diskspace');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-ext-'));
  // A minimal ext4 superblock at byte 1024, as in the Ubuntu image: 4 KiB blocks, 64-bit.
  const image = (blocks, free, reserved) => {
    const buf = Buffer.alloc(4096);
    const sb = 1024;
    buf.writeUInt32LE(blocks, sb + 0x04);
    buf.writeUInt32LE(reserved, sb + 0x08);
    buf.writeUInt32LE(free, sb + 0x0c);
    buf.writeUInt32LE(2, sb + 0x18);           // 1024 << 2 = 4096
    buf.writeUInt16LE(0xef53, sb + 0x38);
    buf.writeUInt32LE(0x80, sb + 0x60);        // 64-bit: high halves (zero here)
    const f = path.join(dir, `img-${blocks}-${free}-${reserved}`);
    fs.writeFileSync(f, buf);
    return f;
  };
  // 2026-11-15: 4 GB image, 4096 free blocks (16 MB), nothing reserved.
  const full = image(1048576, 4096, 0);
  const info = diskspace.readExt(full);
  assert.deepStrictEqual(info, { blockSize: 4096, blocks: 1048576, free: 4096, reserved: 0, size: 4294967296, available: 16777216 });
  assert.ok(diskspace.isLow(info));
  // After freeing the journal: 61380 free blocks (240 MB) is fine.
  assert.ok(!diskspace.isLow(diskspace.readExt(image(1048576, 61380, 0))));
  // Reserved blocks are not available to services running as other users.
  const rsv = diskspace.readExt(image(1048576, 61380, 52428));
  assert.strictEqual(rsv.available, (61380 - 52428) * 4096);
  assert.ok(diskspace.isLow(rsv));
  // Threshold: 5% of the file system, at most 256 MiB.
  assert.strictEqual(diskspace.lowThreshold(4294967296), 0.05 * 4294967296);
  assert.strictEqual(diskspace.lowThreshold(100 * 2 ** 30), 256 * 2 ** 20);
  // Not ext4, too short, missing: not judged.
  fs.writeFileSync(path.join(dir, 'raw'), Buffer.alloc(4096));
  assert.strictEqual(diskspace.readExt(path.join(dir, 'raw')), null);
  fs.writeFileSync(path.join(dir, 'short'), Buffer.alloc(100));
  assert.strictEqual(diskspace.readExt(path.join(dir, 'short')), null);
  assert.strictEqual(diskspace.readExt(path.join(dir, 'nope')), null);
  // Only writable images are checked.
  const low = diskspace.lowImages([{ module: 'virtioblk_0', file: full, writable: true }, { module: 'ro', file: full, writable: false }]);
  assert.deepStrictEqual(low.map((l) => [l.module, diskspace.fmtBytes(l.available), diskspace.fmtBytes(l.size)]), [['virtioblk_0', '16 MB', '4.0 GB']]);
});

test('images: the files a loader would fail on at start', () => {
  const os = require('os');
  const images = require('../lib/images');
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-img-'));
  fs.mkdirSync(path.join(top, 'fw', 'Artifacts'), { recursive: true });
  for (const f of ['Image.bin', 'image_ext4_initrd.img']) fs.writeFileSync(path.join(top, 'fw', 'Artifacts', f), 'x');
  const d = load();
  d.modules.load.entries[1].bin_file = '${TOP}fw/Artifacts/generated.dtb';
  const miss = images.missingFiles(images.collect(d, core.analyze(d), top));
  assert.deepStrictEqual(miss.map((m) => `${m.module}[${m.index}] ${path.basename(m.resolved)}`), ['load[1] generated.dtb']);
  fs.writeFileSync(path.join(top, 'fw', 'Artifacts', 'generated.dtb'), 'x');
  assert.deepStrictEqual(images.missingFiles(images.collect(d, core.analyze(d), top)), []);
});

test('device tree compare: line diff, hunks, FDT files, the view tab', () => {
  const dtc = require('../lib/dtcompare');
  const ops = dtc.diffLines('a\nb\nc\nd\n', 'a\nB\nc\nd\ne\n');
  assert.deepStrictEqual(ops.map((o) => o.op + o.text), [' a', '-b', '+B', ' c', ' d', '+e']);
  assert.deepStrictEqual(ops.filter((o) => o.op === '-').map((o) => [o.a, o.b]), [[2, null]]);
  assert.deepStrictEqual(dtc.diffLines('x\n', 'x\n'), [{ op: ' ', text: 'x', a: 1, b: 1 }]);
  // Unchanged stretches longer than the context collapse into one "skip".
  const long = Array.from({ length: 40 }, (_, k) => `l${k}`);
  const h = dtc.hunks(dtc.diffLines(long.join('\n'), long.map((t, k) => (k === 20 ? 'changed' : t)).join('\n')), 3);
  assert.deepStrictEqual(h.parts.map((p) => (p.skip ? `skip ${p.skip}` : p.lines.length)), ['skip 17', 8, 'skip 16']);
  assert.strictEqual(h.added, 1); assert.strictEqual(h.removed, 1);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vps-dt-'));
  const fdt = path.join(dir, 'x.dtb');
  fs.writeFileSync(fdt, Buffer.from([0xd0, 0x0d, 0xfe, 0xed, 0, 0, 0, 0]));
  fs.writeFileSync(path.join(dir, 'y.bin'), Buffer.alloc(8));
  assert.ok(dtc.isFdt(fdt) && !dtc.isFdt(path.join(dir, 'y.bin')) && !dtc.isFdt(path.join(dir, 'none')));
  fs.rmSync(dir, { recursive: true, force: true });
  // Phandle numbers are replaced by the path of the node they name.
  assert.strictEqual(dtc.symbolizePhandles('/ {\n\tinterrupt-parent = <0x8001>;\n\tintc@17a00000 {\n\t\tphandle = <0x8001>;\n\t};\n\tmsi = <0x8001 0x02>;\n};'),
    '/ {\n\tinterrupt-parent = <&/intc@17a00000>;\n\tintc@17a00000 {\n\t};\n\tmsi = <0x8001 0x02>;\n};');
  // The tab: options, the diff with its legend, and escaping.
  const pane = view.deviceTreePane({ candidates: [{ id: 'output', label: 'DTS written last: a<b>.dts' }], against: 'output', notes: [{ level: 'warning', text: 'no <bootargs>' }],
    text: '', oldLabel: 'a.dts', result: { ops: dtc.diffLines('x\n', 'y <&gic>\n'), normalized: false } });
  assert.ok(pane.includes('<option value="output" selected>DTS written last: a&lt;b&gt;.dts</option>'));
  assert.ok(pane.includes('<span class="dt-add">+1</span> <span class="dt-del">−1</span>'));
  assert.ok(pane.includes('y &lt;&amp;gic&gt;') && pane.includes('no &lt;bootargs&gt;'));
  assert.ok(view.deviceTreePane({ candidates: [], against: 'none', notes: [], text: '/dts-v1/;\n/ {\n};\n' }).includes('<td class="ln">3</td><td class="src">};</td>'));
  // The platform view has the tab; its content arrives when it opens.
  assert.ok(view.render(load(), core.analyze(load()), 'n', 'x').includes('data-dock="dt"'));
});

testAsync('device tree compare: with dtc, a changed address shows as one changed reg line', async () => {
  const { execFileSync } = require('child_process');
  try { execFileSync('dtc', ['--version'], { stdio: 'ignore' }); } catch (e) { return; } // no dtc on this machine
  const dt = require('../lib/devicetree');
  const dtc = require('../lib/dtcompare');
  const d = load();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vps-dt-'));
  const old = path.join(dir, 'old.dtb');
  fs.writeFileSync(old, await dtc.runDtc('dtc', ['-q', '-I', 'dts', '-O', 'dtb', '-o', '-', '-'], dt.generate(d, { fileSize: () => 16 }).dts));
  assert.ok(dtc.isFdt(old));
  let r = await dtc.compare(dt.generate(d, { fileSize: () => 16 }).dts, { kind: 'dtb', file: old });
  assert.ok(r.normalized && r.ops.every((o) => o.op === ' '));
  d.variables.find((v) => v.name === 'UART0').value = '0x10010000';
  r = await dtc.compare(dt.generate(d, { fileSize: () => 16 }).dts, { kind: 'dtb', file: old });
  const changed = r.ops.filter((o) => o.op !== ' ').map((o) => o.op + o.text.trim());
  assert.ok(changed.includes('-serial@10000000 {') && changed.includes('+serial@10010000 {') && changed.includes('+reg = <0x00 0x10010000 0x00 0x1000>;'), changed.join('\n'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('device tree: the DTS goes next to its DTB, with the same name', () => {
  const dt = require('../lib/devicetree');
  const doc = load();
  const pf = '/q/platforms/ubuntu/ubuntu-aarch64.platform.json';
  assert.deepStrictEqual(dt.outputPaths(doc, pf), { dts: '/q/platforms/ubuntu/ubuntu-aarch64.generated.dts', dtb: '/q/platforms/ubuntu/ubuntu-aarch64.generated.dtb' });
  doc.devicetree = { output: '${TOP}fw/Artifacts/generated.dtb' };
  assert.deepStrictEqual(dt.outputPaths(doc, pf), { dts: '/q/platforms/ubuntu/fw/Artifacts/generated.dts', dtb: '/q/platforms/ubuntu/fw/Artifacts/generated.dtb' });
  doc.devicetree = { output: '/abs/board.DTB' };
  assert.strictEqual(dt.outputPaths(doc, pf).dts, '/abs/board.dts');
  doc.devicetree = { output: '${TOP}x/blob' };
  assert.strictEqual(dt.outputPaths(doc, pf).dts, '/q/platforms/ubuntu/x/blob.dts');
  doc.devicetree = { output: '${DIR}x.dtb' };
  assert.throws(() => dt.outputPaths(doc, pf), /other than/);
});

test('device tree: analyze warns when devicetree.output is not loaded', () => {
  const doc = load();
  doc.devicetree = { output: '${TOP}fw/Artifacts/generated.dtb' };
  const msg = (d) => core.analyze(d).problems.filter((p) => /devicetree.output/.test(p.message));
  assert.strictEqual(msg(doc).length, 1);
  doc.modules.load.entries[1].bin_file = '${TOP}fw/Artifacts/generated.dtb';
  assert.strictEqual(msg(doc).length, 0);
});

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
  const modules = require('../lib/modules');
  const connect = require('../lib/connect');
  const params = require('../lib/params');
  const jsonedit = require('../lib/jsonedit');
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
  const modules = require('../lib/modules');
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
  const r = require('../lib/devicetree').generate(d, { fileSize: () => 16 });
  assert.match(r.dts, /periph_pl011_uart_0: serial@10000000 \{[^}]*interrupts = <0x0 0x17b 0x4>;/);
  assert.match(r.dts, /periph_virtioblk_0: virtio_mmio@1c0d0000 \{/);
  const trace = require('../lib/trace');
  const pts = trace.tracePoints(d).map((p) => p.id);
  assert.ok(pts.includes('periph.pl011_uart_0.target_socket'));
  const t = trace.traceOptions(d, ['periph.pl011_uart_0.target_socket'], '/x/vp_sim_agent');
  assert.strictEqual(t.extraModules[0].name, 'trace_periph_pl011_uart_0_target_socket');
  assert.strictEqual(t.extraModules[0].ports.target_socket.bind, 'router.initiator_socket');
  const lua = core.generate(d, t);
  assert.match(lua, /\nplatform\["periph"\]\["pl011_uart_0"\]\["target_socket"\] = \{address = UART0, size = 0x1000, bind = "&platform.trace_periph_pl011_uart_0_target_socket.initiator_socket"\}\n/);
});

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

// ------------------------------------------------------------------ version pinning
const pin = require('../lib/pin');
const C1 = 'a'.repeat(40), C2 = 'b'.repeat(40), C3 = 'c'.repeat(40);

test('pin: bundled qbox.pin.json is valid and matches the bundled catalog', () => {
  const p = pin.readPin(path.join(__dirname, '..', 'qbox.pin.json'));
  const cat = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'catalog', 'qbox-catalog.json'), 'utf8'));
  assert.strictEqual(cat.qbox.commit, p.qbox.commit);
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'vp-pin-'));
  fs.writeFileSync(path.join(dir, 'p.json'), JSON.stringify({ pinVersion: 1, qbox: { commit: 'adfde79', patches: [] } }));
  assert.throws(() => pin.readPin(path.join(dir, 'p.json')), /40-character/);
});

test('pin: gitHead reads detached, loose, packed and worktree refs', () => {
  const os = require('os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-git-'));
  const repo = path.join(root, 'repo');
  const gd = path.join(repo, '.git');
  fs.mkdirSync(path.join(gd, 'refs', 'heads'), { recursive: true });
  fs.writeFileSync(path.join(gd, 'HEAD'), C1 + '\n');
  assert.strictEqual(pin.gitHead(repo), C1);
  fs.writeFileSync(path.join(gd, 'HEAD'), 'ref: refs/heads/main\n');
  assert.strictEqual(pin.gitHead(repo), null);
  fs.writeFileSync(path.join(gd, 'packed-refs'), `# pack-refs with: peeled\n${C2} refs/heads/main\n`);
  assert.strictEqual(pin.gitHead(repo), C2);
  fs.writeFileSync(path.join(gd, 'refs', 'heads', 'main'), C3 + '\n');
  assert.strictEqual(pin.gitHead(repo), C3);
  // A worktree: .git is a file; HEAD is in its own git dir, refs in the common one.
  const wt = path.join(root, 'wt');
  const wgd = path.join(gd, 'worktrees', 'wt');
  fs.mkdirSync(wgd, { recursive: true });
  fs.mkdirSync(wt);
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${wgd}\n`);
  fs.writeFileSync(path.join(wgd, 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(wgd, 'commondir'), '../..\n');
  assert.strictEqual(pin.gitHead(wt), C3);
  assert.strictEqual(pin.gitHead(path.join(root, 'nothing')), null);
});

test('pin: libqemu sources and patches in a CPM source cache (CPM_SOURCE_CACHE)', () => {
  const os = require('os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-cpm-'));
  const src = path.join(root, 'qbox');
  const lq = path.join(src, 'packages', 'libqemu', '0123abcd');
  fs.mkdirSync(path.join(src, 'build'), { recursive: true });
  fs.mkdirSync(lq, { recursive: true });
  fs.writeFileSync(path.join(src, 'build', 'CMakeCache.txt'),
    `CMAKE_HOME_DIRECTORY:INTERNAL=${src}\nCPM_SOURCE_CACHE:PATH=${path.join(src, 'packages')}\nlibqemu_SOURCE_DIR:STATIC=${lq}\n`);
  const where = pin.qboxSourceOf(path.join(src, 'build', 'platforms-vp'));
  assert.strictEqual(where.libqemu, lq);
  // Only CPM's own record: still found.
  fs.writeFileSync(path.join(src, 'build', 'CMakeCache.txt'), `CMAKE_HOME_DIRECTORY:INTERNAL=${src}\nCPM_PACKAGE_libqemu_SOURCE_DIR:INTERNAL=${lq}\n`);
  assert.strictEqual(pin.qboxSourceOf(path.join(src, 'build', 'platforms-vp')).libqemu, lq);
  // The patch check looks there, not in build/_deps.
  const studio = path.join(root, 'studio');
  fs.mkdirSync(path.join(studio, 'patches'), { recursive: true });
  fs.writeFileSync(path.join(lq, 'a.c'), 'int x = 1;\n');
  fs.writeFileSync(path.join(studio, 'patches', 'p.patch'), 'Subject: [PATCH] t\n---\n--- a/a.c\n+++ b/a.c\n@@ -1 +1 @@\n-int x = 0;\n+int x = 1;\n');
  const rep = pin.patchReport({ libqemu: { patches: ['patches/p.patch'] } }, studio, { ...where, build: path.join(src, 'build') });
  assert.strictEqual(rep.length, 1);
  assert.strictEqual(rep[0].target, 'libqemu');
  assert.strictEqual(rep[0].applied, true);
});

test('pin: versionReport finds the QBox of the simulator and reports mismatches', () => {
  const os = require('os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-ver-'));
  const src = path.join(root, 'qbox');
  fs.mkdirSync(path.join(src, '.git'), { recursive: true });
  fs.mkdirSync(path.join(src, 'build', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(src, '.git', 'HEAD'), C1 + '\n');
  fs.writeFileSync(path.join(src, 'build', 'CMakeCache.txt'), `# cache\nCMAKE_HOME_DIRECTORY:INTERNAL=${src}\n`);
  const exe = path.join(src, 'build', 'platforms-vp');
  assert.deepStrictEqual(pin.qboxSourceOf(path.join(src, 'build', 'bin', 'x')), { source: src, build: path.join(src, 'build'), libqemu: path.join(src, 'build', '_deps', 'libqemu-src') });
  const lib = path.join(root, 'vp_sim_agent.so');
  const p = { pinVersion: 1, qbox: { commit: C1, patches: [] } };

  // All the same: nothing to report.
  fs.writeFileSync(path.join(root, 'vp_sim_agent.json'), JSON.stringify({ qbox: { commit: C1 } }));
  let r = pin.versionReport({ pin: p, exePath: exe, catalog: { qbox: { commit: C1 } }, agentLib: lib });
  assert.deepStrictEqual(r.problems, []);
  assert.strictEqual(r.simulator.commit, C1);
  assert.match(pin.formatReport(r), /Everything matches/);

  // Simulator moved on: pin, catalog and agent all differ from it.
  fs.writeFileSync(path.join(src, '.git', 'HEAD'), C2 + '\n');
  r = pin.versionReport({ pin: p, exePath: exe, catalog: { qbox: { commit: C1 } }, agentLib: lib });
  assert.deepStrictEqual(r.problems.map((x) => x.level), ['warning', 'warning', 'warning']);
  assert.match(r.problems[0].text, /QBox bbbbbbbbbbbb, but .* tested with QBox aaaaaaaaaaaa/);
  assert.match(r.problems[1].text, /catalog was made from QBox aaaaaaaaaaaa/);
  assert.match(r.problems[2].text, /sim agent was built against QBox aaaaaaaaaaaa/);

  // Agent without a record, catalog off, no agent: notes only where it cannot tell.
  fs.unlinkSync(path.join(root, 'vp_sim_agent.json'));
  r = pin.versionReport({ pin: { pinVersion: 1, qbox: { commit: C2, patches: [] } }, exePath: exe, catalog: undefined, agentLib: lib });
  assert.deepStrictEqual(r.problems.map((x) => x.level), ['info']);
  assert.match(r.problems[0].text, /does not record/);
  r = pin.versionReport({ pin: p, exePath: path.join(root, 'elsewhere', 'platforms-vp'), catalog: undefined, agentLib: undefined });
  assert.deepStrictEqual(r.problems.map((x) => x.level), ['info']);
  assert.match(pin.formatReport(r), /Simulator: unknown[\s\S]*Component catalog: off[\s\S]*Sim agent: not used/);
});

// ------------------------------------------------------------------ G-05: profiling

/** A minimal ELF64 little-endian file with a .symtab: [{name, value, size, func}]. */
function makeSymElf(file, syms) {
  let strs = Buffer.from([0]);
  const nameOff = [];
  for (const s of syms) { nameOff.push(strs.length); strs = Buffer.concat([strs, Buffer.from(s.name + '\0', 'latin1')]); }
  const symtab = Buffer.alloc(24 * (syms.length + 1));
  syms.forEach((s, i) => {
    const o = 24 * (i + 1);
    symtab.writeUInt32LE(nameOff[i], o);
    symtab[o + 4] = s.func ? 0x12 : 0x11; // GLOBAL FUNC / GLOBAL OBJECT
    symtab.writeUInt16LE(1, o + 6);
    symtab.writeBigUInt64LE(BigInt(s.value), o + 8);
    symtab.writeBigUInt64LE(BigInt(s.size || 0), o + 16);
  });
  const symOff = 64;
  const strOff = symOff + symtab.length;
  const shOff = strOff + strs.length;
  const eh = Buffer.alloc(64);
  eh.writeUInt32BE(0x7f454c46, 0); eh[4] = 2; eh[5] = 1; eh[6] = 1;
  eh.writeBigUInt64LE(BigInt(shOff), 0x28); eh.writeUInt16LE(64, 0x3a); eh.writeUInt16LE(3, 0x3c);
  const sh = Buffer.alloc(64 * 3);
  const sec = (i, type, off, size, link, entsize) => {
    sh.writeUInt32LE(type, i * 64 + 4); sh.writeBigUInt64LE(BigInt(off), i * 64 + 0x18); sh.writeBigUInt64LE(BigInt(size), i * 64 + 0x20);
    sh.writeUInt32LE(link, i * 64 + 0x28); sh.writeBigUInt64LE(BigInt(entsize), i * 64 + 0x38);
  };
  sec(1, 2, symOff, symtab.length, 2, 24); // SHT_SYMTAB, strings in section 2
  sec(2, 3, strOff, strs.length, 0, 0);    // SHT_STRTAB
  fs.writeFileSync(file, Buffer.concat([eh, symtab, strs, sh]));
}

test('profile: ELF function symbols and address lookup', () => {
  const elfsym = require('../lib/elfsym');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-elf-'));
  try {
    const f = path.join(dir, 'vmlinux');
    makeSymElf(f, [
      { name: '_text', value: '0xffff800008000000' },
      { name: 'kimage_vaddr', value: '0xffff800009130000' },
      { name: 'cpu_do_idle', value: '0xffff8000091072d0', size: 0x20, func: true },
      { name: 'do_idle', value: '0xffff800008100000', size: 0x100, func: true },
      { name: 'asm_entry', value: '0xffff800008200000', func: true }, // no size: up to 64 KiB or the next one
    ]);
    const s = elfsym.readSymbols(f);
    assert.deepStrictEqual(s.functions.map((x) => x.name), ['do_idle', 'asm_entry', 'cpu_do_idle']);
    assert.strictEqual(s.find('kimage_vaddr'), 0xffff800009130000n);
    assert.strictEqual(s.find('nope'), undefined);
    const at = (a) => { const r = elfsym.lookup(s.functions, a); return r ? r.name : null; };
    assert.strictEqual(at(0xffff8000091072d0n), 'cpu_do_idle');
    assert.strictEqual(at(0xffff8000091072efn), 'cpu_do_idle');
    assert.strictEqual(at(0xffff8000091072f0n), null); // past its size
    assert.strictEqual(at(0xffff800008100050n), 'do_idle');
    assert.strictEqual(at(0xffff800008200100n), 'asm_entry');
    assert.strictEqual(at(0xffff800008210000n), null); // more than 64 KiB past a sizeless symbol
    assert.strictEqual(at(0xffff800007000000n), null); // before the first
    fs.writeFileSync(path.join(dir, 'x'), 'not elf');
    assert.throws(() => elfsym.readSymbols(path.join(dir, 'x')), /is not an ELF file/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('profile: KASLR offset, per-function sums and the symbol warning', () => {
  const prof = require('../lib/profile');
  assert.strictEqual(prof.isArm64Image('41524d64'), true);
  assert.strictEqual(prof.isArm64Image('00000000'), false);
  const syms = { find: (n) => ({ _text: 0xffff800008000000n, kimage_vaddr: 0xffff800009130000n })[n] };
  assert.deepStrictEqual(prof.kimageVaddrOffset(syms), { offset: 0x1130000n, text: 0xffff800008000000n });
  assert.strictEqual(prof.kimageVaddrOffset({ find: () => undefined }), undefined);
  // Runtime _text 0xffffc98ba1600000, as read (little-endian) from guest memory.
  assert.strictEqual(prof.kaslrOffset('000060a18bc9ffff', 0xffff800008000000n), 0x498b99600000n);
  const fns = [{ name: 'do_idle', start: 0xffff800008100000n, size: 0x100n }, { name: 'cpu_do_idle', start: 0xffff8000091072d0n, size: 0x20n }];
  const off = 0x498b99600000n;
  const blocks = [
    ['0x' + (0xffff8000091072d0n + off).toString(16), 60], ['0x' + (0xffff800008100010n + off).toString(16), 25],
    ['0x' + (0xffff800008100020n + off).toString(16), 5], ['0xffffffffc0000000', 4], ['0x0000aaaabbbb0000', 6],
  ];
  const s = prof.summarize(blocks, fns, off);
  assert.strictEqual(s.total, 100);
  assert.deepStrictEqual(s.rows.map((r) => [r.name, r.samples, r.space, r.resolved]), [
    ['cpu_do_idle', 60, 'kernel', true], ['do_idle', 30, 'kernel', true], ['[user space]', 6, 'user', false], ['[kernel, no symbol]', 4, 'kernel', false],
  ]);
  assert.deepStrictEqual(s.kernel, { samples: 94, resolved: 90 });
  assert.strictEqual(prof.symbolWarning(s, true), '');
  const wrong = prof.summarize(blocks, fns, 0n); // without the KASLR offset nothing fits
  assert.match(prof.symbolWarning(wrong, true), /Only 0% of the kernel samples .* KASLR offset is unknown/);
  assert.match(prof.symbolWarning(prof.summarize(blocks, [], 0n), false), /No symbol file/);
  assert.strictEqual(prof.symbolWarning(prof.summarize([['0x400000', 3]], [], 0n), false), ''); // user space only: nothing to say
});

// ------------------------------------------------------------------ G-07: signal tracing

test('signal tracing: which connections, and how the tracer is wired in', () => {
  const cat = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'catalog', 'qbox-catalog.json'), 'utf8'));
  const doc = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'examples', 'ubuntu-aarch64.platform.json'), 'utf8'));
  // QEMU-to-QEMU lines (GIC to CPUs, timers, virtio) are wired inside QEMU and left out.
  const pts = trace.signalPoints(doc, cat);
  assert.deepStrictEqual(pts.map((p) => `${p.id}>${p.dest}.${p.destPort}/${p.declaredBy}`), ['pl011_uart_0.irq>gic_0.spi_in_379/source']);
  assert.deepStrictEqual(trace.signalPoints(doc, undefined), []); // no catalog, no kinds
  // The source declares the binding: it now binds to the tracer, which binds on to the destination.
  const o = trace.traceOptions(doc, ['pl011_uart_0.irq', 'pl011_uart_0.target_socket'], '/a/vp', cat);
  assert.deepStrictEqual(o.extraModules[0], { name: 'trace_sig_pl011_uart_0_irq', type: 'signal_tracer', dylib: '/a/vp', params: { label: 'pl011_uart_0.irq' }, ports: { out: { bind: 'gic_0.spi_in_379' } } });
  assert.deepStrictEqual(o.portOverrides[0], { instance: 'pl011_uart_0', port: 'irq', value: { bind: 'trace_sig_pl011_uart_0_irq.in' } });
  assert.strictEqual(o.extraModules[1].type, 'tracer'); // bus points as before
  const lua = core.generate(doc, o);
  assert.ok(lua.includes('platform["pl011_uart_0"]["irq"] = {bind = "&trace_sig_pl011_uart_0_irq.in"}'));
  assert.ok(lua.includes('platform["trace_sig_pl011_uart_0_irq"] = { moduletype = "signal_tracer"; dylib_path = "/a/vp"; label = "pl011_uart_0.irq"; out = {bind = "&gic_0.spi_in_379"} }'));
  // The destination declares it: the tracer takes the source's place.
  const d2 = JSON.parse(JSON.stringify(doc));
  delete d2.modules.pl011_uart_0.ports.irq;
  d2.modules.gic_0.ports = Object.assign({}, d2.modules.gic_0.ports, { spi_in_379: { bind: 'pl011_uart_0.irq' } });
  const p2 = trace.signalPoints(d2, cat).find((p) => p.id === 'pl011_uart_0.irq');
  assert.strictEqual(p2 && p2.declaredBy, 'dest');
  const o2 = trace.traceOptions(d2, ['pl011_uart_0.irq'], '/a/vp', cat);
  assert.deepStrictEqual(o2.extraModules[0].ports, { in: { bind: 'pl011_uart_0.irq' } });
  assert.deepStrictEqual(o2.portOverrides[0], { instance: 'gic_0', port: 'spi_in_379', value: { bind: 'trace_sig_pl011_uart_0_irq.out' } });
});

test('signal tracing: records and the VCD file', () => {
  const recs = trace.decodeRecords({ points: ['pl011_uart_0.target_socket', 'pl011_uart_0.irq', 'my_dev.irq'], records: [
    [1, 55.867376157, 1, 'S', '0x0', 1, '00', 1],
    [2, 229.126844701, 1, 'S', '0x0', 1, '01', 1],
    [3, 229.134661, 0, 'R', '0x1000003c', 4, '30000000', 1],
    [4, 229.137211123, 1, 'S', '0x0', 1, '00', 1],
    [5, 229.130000000, 2, 'S', '0x0', 1, '01', 1], // reached the store late, from another thread
  ] });
  assert.deepStrictEqual([recs[1].dir, recs[1].value, recs[1].address], ['S', '1', '']);
  assert.strictEqual(recs[2].value, '0x30');
  const vcd = trace.toVcd(recs, { date: 'd' });
  assert.strictEqual(vcd, [
    '$date d $end', '$version VP Studio $end', '$timescale 1ps $end', '$scope module vp $end',
    '$var wire 1 ! my_dev.irq $end', '$var wire 1 " pl011_uart_0.irq $end', '$upscope $end', '$enddefinitions $end',
    '#0', '$dumpvars', '0!', '0"', '$end',
    '#55867376157000', '0"', '#229126844701000', '1"', '#229130000000000', '1!', '#229137211123000', '0"', '',
  ].join('\n'));
  assert.match(trace.toVcd(recs, { initial: 'x', date: 'd' }), /\$dumpvars\nx!\nx"\n\$end/);
  assert.strictEqual(trace.toVcd([], { date: 'd' }).includes('$var'), false);
});

// ------------------------------------------------------------------ G-03: peripheral registers

const registers = require('../lib/registers');

test('registers: the bundled descriptions load and cover the example platform', () => {
  const { descs, problems } = registers.loadDir(path.join(__dirname, '..', 'catalog', 'registers'));
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

  const doc = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'examples', 'ubuntu-aarch64.platform.json'), 'utf8'));
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

test('launch: the agent module gets one bus socket per router', () => {
  const launch = require('../lib/launch');
  assert.deepStrictEqual(launch.agentModule('/a/sim_agent', 5000, ['router', 'periph.router_1']), {
    name: 'sim_agent', type: 'sim_agent', dylib: '/a/sim_agent', params: { port: 5000, buses: 2 },
    ports: { bus_0: { bind: 'router.target_socket' }, bus_1: { bind: 'periph.router_1.target_socket' } },
  });
  const doc = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'examples', 'ubuntu-aarch64.platform.json'), 'utf8'));
  const lua = core.generate(doc, { extraModules: [launch.agentModule('/a/sim_agent', 5000, core.analyze(doc).buses)] });
  assert.ok(lua.includes('platform["sim_agent"] = { moduletype = "sim_agent"; dylib_path = "/a/sim_agent"; port = 5000; buses = 1; bus_0 = {bind = "&router.target_socket"} }'), lua.slice(-400));
});

// ------------------------------------------------------------------ G-04: bus breakpoints

test('bus breakpoints: panel input to break.set objects', () => {
  const p = trace.parseBreakInput;
  assert.deepStrictEqual(p({ point: 'pl011_uart_0.target_socket', access: 'w', address: '0x10000000' }),
    { point: 'pl011_uart_0.target_socket', access: 'w', from: '0x10000000', to: '0x10000000' });
  assert.deepStrictEqual(p({ access: 'r', address: ' 0x1c0d0000 - 0x1C0D0FFF ' }), { access: 'r', from: '0x1c0d0000', to: '0x1c0d0fff' });
  assert.deepStrictEqual(p({ point: 'x.p', address: '' }), { point: 'x.p', access: 'rw' }); // the whole point
  assert.deepStrictEqual(p({ access: 'w', address: '4096', value: '0x0a', mask: '0xff' }), { access: 'w', from: '0x1000', to: '0x1000', value: '0xa', mask: '0xff' });
  assert.strictEqual(p({ address: '0x0', value: '0x1', mask: ' ' }).mask, '0xffffffffffffffff'); // empty mask: the whole value
  assert.strictEqual(p({ address: '0x0', value: '10' }).mask, '0xffffffffffffffff');
  assert.strictEqual(p({ address: '0xffffffffffffffff' }).to, '0xffffffffffffffff'); // 64-bit addresses stay exact
  for (const [input, re] of [
    [{ address: '' }, /Fill in the Address of the breakpoint .* or choose a trace point/],
    [{ address: 'abc' }, /Address: enter/],
    [{ address: '0x10000000000000000' }, /Address: enter/],
    [{ address: '0x20-0x10' }, /below its start/],
    [{ address: '0x0', value: 'x' }, /Value: enter/],
    [{ address: '0x0', value: '0x0a/0xff' }, /Value: enter/], // the mask has its own box
    [{ address: '0x0', value: '1', mask: 'x' }, /Mask: enter/],
    [{ address: '0x0', value: '1', mask: '0' }, /Mask: 0 would compare no bit/],
    [{ address: '0x0', mask: '0xff' }, /Mask: give a Value too/],
    [{ address: '0x0', access: 'x' }, /read, write or any/],
  ]) assert.throws(() => p(input), re, JSON.stringify(input));
});

test('bus breakpoints: labels and hit descriptions', () => {
  assert.strictEqual(trace.breakLabel({ id: 2, point: 'pl011_uart_0.target_socket', access: 'w', from: '0x10000000', to: '0x10000000', mask: '0xff', value: '0xa' }),
    '#2 pl011_uart_0.target_socket write 0x10000000 value 0xa mask 0xff');
  assert.strictEqual(trace.breakLabel({ id: 1, point: null, access: 'r', from: '0x1c0d0000', to: '0x1c0d0fff' }), '#1 any point read 0x1c0d0000-0x1c0d0fff');
  assert.strictEqual(trace.breakLabel({ id: 3, point: 'a.b', access: 'rw', from: '0x0', to: '0xffffffffffffffff' }), '#3 a.b access 0x0-0xffffffffffffffff');
  assert.strictEqual(trace.breakLabel({ id: 4, access: 'w', from: '0x4', to: '0x4', value: '0x1', mask: '0xffffffffffffffff' }), '#4 any point write 0x4 value 0x1');
  const hit = { breakpoint: 1, accessesAfter: 3, matchesAfter: 2, record: { seq: 9, point: 'pl011_uart_0.target_socket', rw: 'W', address: '0x10000000', length: 2, data: '5b00' } };
  assert.strictEqual(trace.describeHit(hit),
    'Breakpoint #1: write 0x10000000 = 0x5b on pl011_uart_0.target_socket. The CPUs made 3 more traced accesses before the pause took hold; 2 of them matched a breakpoint too and did not stop it.');
  assert.strictEqual(trace.describeHit({ breakpoint: 2, accessesAfter: 0, matchesAfter: 0, record: { point: 'v.mem', rw: 'R', address: '0x1c0d0000', length: 4, data: '76697274' } }),
    'Breakpoint #2: read 0x1c0d0000 → 0x74726976 on v.mem.');
  // Agent 0.12.0 names who made the access.
  assert.ok(trace.describeHit({ breakpoint: 3, record: { point: 'v.mem', rw: 'W', address: '0x1c0d0070', length: 4, data: '0f000000', initiator: 'cpu_2.mem' } }).includes('on v.mem by cpu_2.mem.'));
});

// ------------------------------------------------------------------ G-01: vp-run

const launch = require('../lib/launch');
const vprun = require('../bin/vp-run.js');

test('vp-run: steps keep their order; options are checked', () => {
  const o = vprun.parseArgs(['--qbox', '/q', '--expect', 'login:', '--send', 'root', '--expect', 'root@\\w+', '--timeout', '900',
    '--sim-timeout', '30 s', '--snapshot', '--param', 'cpu_0.gdb_port=1234', '--param', 'uart_0.name=con 1', '--junit', 'r.xml', 'p.platform.json']);
  assert.strictEqual(o.platform, 'p.platform.json');
  assert.strictEqual(o.qbox, '/q');
  assert.deepStrictEqual(o.steps.map((s) => (s.send !== undefined ? 'send ' + s.send : 'expect ' + s.source)), ['expect login:', 'send root', 'expect root@\\w+']);
  assert.ok(o.steps[2].expect.test('x\nroot@ubuntu:~#'));
  assert.strictEqual(o.timeout, 900);
  assert.deepStrictEqual(o.simTimeout, { seconds: 30, text: '30 s' });
  assert.strictEqual(o.snapshot, true);
  assert.deepStrictEqual(o.params, [{ instance: 'cpu_0', param: 'gdb_port', value: 1234 }, { instance: 'uart_0', param: 'name', value: 'con 1' }]);
  assert.strictEqual(o.junit, 'r.xml');
  // Defaults.
  const d = vprun.parseArgs(['x.platform.json']);
  assert.strictEqual(d.timeout, 600);
  assert.strictEqual(d.exe, 'build/platforms-vp');
  assert.deepStrictEqual(d.steps, []);
  // A parameter of a module inside a subsystem keeps its dotted instance path.
  assert.deepStrictEqual(vprun.parseArgs(['--param', 'periph.uart_0.baud=9600', 'x']).params[0], { instance: 'periph.uart_0', param: 'baud', value: 9600 });
  // A value with dots and "=" (a disk option string).
  assert.deepStrictEqual(vprun.parseArgs(['--param', 'blk_0.blkdev_str=file=/a/b.img,format=raw', 'x']).params[0], { instance: 'blk_0', param: 'blkdev_str', value: 'file=/a/b.img,format=raw' });
  assert.strictEqual(vprun.parseArgs(['-h']).help, true);
  process.env.VP_TEST_SECRET = 's3cret';
  assert.deepStrictEqual(vprun.parseArgs(['--send-env', 'VP_TEST_SECRET', 'x']).steps, [{ sendEnv: 'VP_TEST_SECRET' }]);
  delete process.env.VP_TEST_SECRET;
  assert.throws(() => vprun.parseArgs(['--send-env', 'VP_TEST_SECRET', 'x']), /the variable is not set/);
  assert.throws(() => vprun.parseArgs(['--send-env', 'A-B', 'x']), /not an environment variable name/);
  for (const [args, re] of [
    [[], /no platform file/],
    [['a', 'b'], /only one platform/],
    [['--expect'], /needs a value/],
    [['--expect', '(', 'x'], /--expect \(/],
    [['--timeout', '0', 'x'], /greater than 0/],
    [['--sim-timeout', '3 parsecs', 'x'], /Unknown unit/],
    [['--param', 'nodot=1', 'x'], /INSTANCE\.NAME=VALUE/],
    [['--agent-port', '70000', 'x'], /port number/],
    [['--wait-exit', '--exec', 'true', 'x'], /cannot be used together/],
    [['--bogus', 'x'], /unknown option --bogus/],
  ]) {
    assert.throws(() => vprun.parseArgs(args), (e) => e instanceof vprun.UsageError && re.test(e.message), args.join(' '));
  }
});

test('vp-run: JUnit report escapes console text and counts failures', () => {
  const xml = vprun.junitXml('ubuntu <a&b>', [
    { name: 'expect /login:/', seconds: 12.5 },
    { name: 'expect /root@/', seconds: 600, failure: 'timed out after 600 s waiting for /root@/' },
  ], 'boot \u001b[0mok <tag> & "q"\u0007\n');
  assert.match(xml, /<testsuite name="ubuntu &lt;a&amp;b&gt;" tests="2" failures="1" errors="0" time="612.500">/);
  assert.match(xml, /<testcase classname="[^"]*" name="expect \/login:\/" time="12.500"\/>/);
  assert.match(xml, /<failure message="timed out after 600 s waiting for \/root@\/"\/>/);
  assert.match(xml, /<system-out>boot \[0mok &lt;tag&gt; &amp; &quot;q&quot;\n<\/system-out>/); // ESC and BEL dropped: not allowed in XML
  assert.strictEqual(vprun.envName('HOST_PORT_SSH'), 'VP_HOST_PORT_SSH');
  assert.strictEqual(vprun.envName('hostPort-gdb'), 'VP_HOSTPORT_GDB');
});

test('launch: snapshot=on for writable disk images only', () => {
  const doc = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'examples', 'ubuntu-aarch64.platform.json'), 'utf8'));
  assert.deepStrictEqual(launch.snapshotOverrides(doc), [{
    instance: 'virtioblk_0', param: 'blkdev_str', value: 'file=${TOP}fw/Artifacts/image_ext4.img,format=raw,if=none,readonly=off,snapshot=on',
  }]);
  // The override ends up after the platform table, ${TOP} kept as in the platform.
  const lua = core.generate(doc, { overrides: launch.snapshotOverrides(doc) });
  assert.ok(lua.includes('platform["virtioblk_0"]["blkdev_str"] = "file="..top().."fw/Artifacts/image_ext4.img,format=raw,if=none,readonly=off,snapshot=on"'));
  const d2 = JSON.parse(JSON.stringify(doc));
  d2.modules.virtioblk_0.params.blkdev_str = 'file=a.img,readonly=on';
  assert.deepStrictEqual(launch.snapshotOverrides(d2), []);
  d2.modules.virtioblk_0.params.blkdev_str = 'file=a.img,snapshot=off,format=raw';
  assert.strictEqual(launch.snapshotOverrides(d2)[0].value, 'file=a.img,snapshot=on,format=raw');
});

test('launch: build folders, local catalogs and the agent library', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-launch-'));
  const ext = path.join(home, 'ext');
  const saved = process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_CONFIG_HOME;
  try {
    const dirs = launch.buildDirs(ext, home);
    assert.deepStrictEqual(dirs, [
      path.join(home, '.config', 'Code', 'User', 'globalStorage', 'novatek.vp-studio', 'build'),
      path.join(home, '.config', 'VSCodium', 'User', 'globalStorage', 'novatek.vp-studio', 'build'),
      path.join(home, '.theia', 'globalStorage', 'novatek.vp-studio', 'build'),
      path.join(ext, 'tools'),
    ]);
    assert.strictEqual(launch.findBuilt(dirs, 'sim-agent', 'sim_agent.so'), undefined);
    // Built in the extension folder by an older version, and in Theia's user data: Theia's wins.
    fs.mkdirSync(path.join(ext, 'tools', 'sim-agent'), { recursive: true });
    fs.writeFileSync(path.join(ext, 'tools', 'sim-agent', 'sim_agent.so'), '');
    assert.strictEqual(launch.findBuilt(dirs, 'sim-agent', 'sim_agent.so'), path.join(ext, 'tools', 'sim-agent', 'sim_agent.so'));
    fs.mkdirSync(path.join(dirs[2], 'sim-agent'), { recursive: true });
    fs.writeFileSync(path.join(dirs[2], 'sim-agent', 'sim_agent.so'), '');
    assert.strictEqual(launch.findBuilt(dirs, 'sim-agent', 'sim_agent.so'), path.join(dirs[2], 'sim-agent', 'sim_agent.so'));

    // A bundled module built in the user data folder, and a wizard model in a workspace.
    fs.mkdirSync(path.join(dirs[0], 'cpu-a73'), { recursive: true });
    fs.writeFileSync(path.join(dirs[0], 'cpu-a73', 'cpu_arm_cortexA73.catalog.json'), JSON.stringify({
      library: '/built/cpu_arm_cortexA73.so', modules: { cpu_arm_cortexA73: { ports: {}, params: {} } },
    }));
    const ws = path.join(home, 'ws');
    for (const d of ['models/my_timer/build', 'node_modules/x', 'build/y']) fs.mkdirSync(path.join(ws, d), { recursive: true });
    fs.writeFileSync(path.join(ws, 'models', 'my_timer', 'my_timer.model.json'), JSON.stringify({ name: 'my_timer' }));
    fs.writeFileSync(path.join(ws, 'models', 'my_timer', 'build', 'my_timer.catalog.json'), JSON.stringify({
      library: path.join(ws, 'models', 'my_timer', 'build', 'my_timer.so'), modules: { my_timer: { ports: {}, params: {} } },
    }));
    fs.writeFileSync(path.join(ws, 'node_modules', 'x', 'skip.model.json'), '{}');
    fs.writeFileSync(path.join(ws, 'build', 'y', 'skip.model.json'), '{}');
    const specs = launch.findModelSpecs(ws);
    assert.deepStrictEqual(specs, [path.join(ws, 'models', 'my_timer', 'my_timer.model.json')]);
    const r = launch.catalogWithLocal({ modules: { router: { ports: {}, params: {} } } }, { bundled: [{ type: 'cpu_arm_cortexA73', dir: 'cpu-a73' }], dirs, modelSpecs: specs });
    assert.deepStrictEqual(Object.keys(r.catalog.modules).sort(), ['cpu_arm_cortexA73', 'my_timer', 'router']);
    const libs = require('../lib/models').libraries(r.catalog);
    assert.strictEqual(libs.cpu_arm_cortexA73, path.join(dirs[0], 'cpu-a73', 'cpu_arm_cortexA73')); // next to its catalog

    // --agent: an explicit path must exist; "none" turns it off; VP_SIM_AGENT is the default.
    assert.deepStrictEqual(vprun.agentLibrary('none'), { lib: undefined, why: 'disabled with --agent none' });
    assert.throws(() => vprun.agentLibrary(path.join(home, 'nope')), /not found: .*nope\.so/);
    const so = path.join(ext, 'tools', 'sim-agent', 'sim_agent');
    assert.deepStrictEqual(vprun.agentLibrary(undefined, { VP_SIM_AGENT: so }), { lib: so });
    assert.deepStrictEqual(vprun.agentLibrary(so + '.so', {}), { lib: so });
  } finally {
    if (saved !== undefined) process.env.XDG_CONFIG_HOME = saved;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ G-12: probes everywhere

test('probes: every place one fits, and which ones record from the start', () => {
  const cat = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'catalog', 'qbox-catalog.json'), 'utf8'));
  const doc = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'examples', 'ubuntu-aarch64.platform.json'), 'utf8'));
  const list = trace.probeList(doc, cat);
  // The bus-mapped ports first (by address), then the signals.
  assert.deepStrictEqual(list.map((p) => p.id), trace.tracePoints(doc).map((p) => p.id).concat(['pl011_uart_0.irq']));
  assert.ok(list.some((p) => p.kind === 'memory') && list.some((p) => p.kind === 'bus'));
  assert.strictEqual(list.find((p) => p.id === 'pl011_uart_0.irq').description, '→ gic_0.spi_in_379 · signal');
  assert.match(list.find((p) => p.id === 'pl011_uart_0.target_socket').description, /^0x10000000 \(0x1000\) · /);
  // recording: each tracer gets "record"; without it the params stay as before (agents before 0.9.0).
  const ids = list.map((p) => p.id);
  const o = trace.traceOptions(doc, ids, '/a/vp', cat, { recording: ['pl011_uart_0.irq'] });
  assert.strictEqual(o.extraModules.length, ids.length);
  const rec = Object.fromEntries(o.extraModules.map((m) => [m.params.label, m.params.record]));
  assert.strictEqual(rec['pl011_uart_0.irq'], true);
  assert.strictEqual(rec['pl011_uart_0.target_socket'], false);
  assert.ok(Object.values(rec).filter(Boolean).length === 1);
  const old = trace.traceOptions(doc, ['pl011_uart_0.target_socket'], '/a/vp', cat);
  assert.ok(!('record' in old.extraModules[0].params));
  // Every probe at once still gives a platform the generator takes.
  const lua = core.generate(doc, o);
  assert.ok(lua.includes('record = false') && lua.includes('record = true'));
});

test('probes: agent version next to the library', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-ver-'));
  try {
    const so = path.join(dir, 'vp_sim_agent.so');
    assert.strictEqual(pin.agentVersion(so), null); // no vp_sim_agent.json
    fs.writeFileSync(path.join(dir, 'vp_sim_agent.json'), JSON.stringify({ qbox: { commit: null } }));
    assert.strictEqual(pin.agentVersion(so), null); // written by an agent before 0.9.0
    fs.writeFileSync(path.join(dir, 'vp_sim_agent.json'), JSON.stringify({ version: '0.9.0', qbox: { commit: null } }));
    assert.strictEqual(pin.agentVersion(so), '0.9.0');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  assert.strictEqual(pin.versionAtLeast('0.9.0', '0.9.0'), true);
  assert.strictEqual(pin.versionAtLeast('0.10.1', '0.9.0'), true);
  assert.strictEqual(pin.versionAtLeast('1.0.0', '0.9.0'), true);
  assert.strictEqual(pin.versionAtLeast('0.8.9', '0.9.0'), false);
  assert.strictEqual(pin.versionAtLeast(null, '0.9.0'), false);
  // The source and build script agree on where the version is written.
  const src = fs.readFileSync(path.join(__dirname, '..', 'tools', 'sim-agent', 'sim_agent.cc'), 'utf8');
  assert.match(src, /^const char\* const AGENT_VERSION = "\d+\.\d+\.\d+";$/m);
});

test('launch: Lua path and the agent module', () => {
  assert.strictEqual(launch.luaPathFor('/p/x.platform.json', { name: 'ubuntu' }), '/p/ubuntu.generated.lua');
  assert.strictEqual(launch.luaPathFor('/p/x.platform.json', {}), '/p/x.generated.lua');
  assert.deepStrictEqual(launch.agentModule('/a/sim_agent', 5000), { name: 'sim_agent', type: 'sim_agent', dylib: '/a/sim_agent', params: { port: 5000 } });
  // A library built before the rename (vp_sim_agent.so) registered the old type name.
  assert.deepStrictEqual(launch.agentModule('/a/vp_sim_agent', 5000), { name: 'sim_agent', type: 'vp_sim_agent', dylib: '/a/vp_sim_agent', params: { port: 5000 } });
});

test('guest linux: the CDT evaluate answers of -vp-ps and -vp-dmesg', () => {
  const gl = require('../lib/guestlinux');
  // As CDT returns them: the MI result as JSON, every value a string, plus CDT's own keys.
  const proc = (pid, tgid, ppid, comm, o = {}) => Object.assign({ pid: String(pid), tgid: String(tgid), ppid: String(ppid), uid: '0', state: 'S', cpu: '0', running: '-1', kernel: '0', comm, task: '0xffff0001' }, o);
  const body = { result: JSON.stringify({
    processes: [
      proc(1, 1, 0, 'systemd'), proc(2, 2, 0, 'kthreadd', { kernel: '1' }), proc(13, 13, 2, 'ksoftirqd/0', { kernel: '1' }),
      proc(369, 369, 1, 'NetworkManager', { cpu: '7' }), proc(390, 369, 1, 'gmain', { cpu: '3' }),
      proc(472, 472, 440, 'bash'), proc(440, 440, 1, 'login'), proc(510, 510, 472, 'sh', { state: 'R', cpu: '5', running: '5' }),
    ],
    cpus: [{ cpu: '0', pid: '0', comm: 'swapper/0', idle: '1' }, { cpu: '5', pid: '510', comm: 'sh', idle: '0' }],
    'cdt-token': '12', 'cdt-command': '-vp-ps -t',
  }) };
  const t = gl.processTree(gl.normalizePs(gl.parseResult(body)));
  assert.deepStrictEqual(t.count, { processes: 7, threads: 1, kernel: 2 });
  assert.deepStrictEqual(t.roots.map((n) => n.proc.comm), ['systemd', 'kthreadd']);
  const systemd = t.roots[0];
  assert.deepStrictEqual(systemd.children.map((n) => n.proc.pid), [369, 440]);
  assert.deepStrictEqual(systemd.children[0].threads.map((x) => x.comm), ['gmain']); // a thread under its process
  const sh = systemd.children[1].children[0].children[0];
  assert.strictEqual(sh.proc.comm, 'sh');
  assert.deepStrictEqual(gl.procLabel(sh.proc), { label: 'sh', description: 'pid 510 · R · running on cpu 5' });
  assert.deepStrictEqual(gl.procLabel(t.roots[1].children[0].proc), { label: '[ksoftirqd/0]', description: 'pid 13 · S · cpu 0' });
  assert.strictEqual(gl.procLabel(systemd.children[0].threads[0], true).description, 'tid 390 · S · cpu 3');
  assert.match(gl.procTooltip(systemd.children[0].threads[0], true), /TID 390, process 369, parent 1/);
  assert.match(gl.procTooltip(sh.proc), /State R: running or runnable\nRunning on cpu 5 now/);
  assert.deepStrictEqual(t.cpus.map(gl.cpuLabel), [{ label: 'cpu 0', description: 'idle' }, { label: 'cpu 5', description: 'sh (pid 510)' }]);
  // A process whose parent is gone (or pid 0) is a root.
  assert.strictEqual(gl.processTree(gl.normalizePs({ processes: [proc(9, 9, 4, 'orphan')] })).roots.length, 1);

  // dmesg as dmesg prints it, a record with two lines gets the stamp twice.
  const dm = gl.parseResult({ result: JSON.stringify({ records: [
    { seq: '0', ts: '0', level: '5', text: 'Booting Linux on physical CPU 0x0000000000 [0x414fd0b1]' },
    { seq: '388', ts: '139439840256', level: '5', text: 'random: 217 urandom warning(s)\nsecond line' },
  ] }) });
  assert.strictEqual(gl.formatDmesg(dm), '[    0.000000] Booting Linux on physical CPU 0x0000000000 [0x414fd0b1]\n' +
    '[  139.439840] random: 217 urandom warning(s)\n[  139.439840] second line\n');
  assert.strictEqual(gl.formatDmesg({}), '');
  assert.deepStrictEqual(gl.parseResult({ result: '\r' }), {}); // a CLI command: nothing back
  assert.throws(() => gl.parseResult({ result: 'not json' }), /unexpected answer/);
});

test('guest linux: loading the gdb script', () => {
  const gl = require('../lib/guestlinux');
  assert.deepStrictEqual(gl.evaluateArgs('-vp-ps -t'), { expression: '>-vp-ps -t', context: 'repl' });
  assert.strictEqual(gl.notLoaded('Undefined MI command: vp-ps'), true);
  assert.strictEqual(gl.notLoaded('The target is running: pause it first.'), false);
  // Through Python, so a path with spaces or quotes works; as MI, a c-string.
  assert.strictEqual(gl.loadCommand('/a b/x.py'), 'python import runpy; runpy.run_path("/a b/x.py")');
  assert.strictEqual(gl.sourceCommand('/a b/"x".py'), '-interpreter-exec console "python import runpy; runpy.run_path(\\"/a b/\\\\\\"x\\\\\\".py\\")"');
  // initCommands: after the configuration's own (they may add symbol files); once only.
  const c = gl.withLinuxAwareness({ type: 'gdbtarget', initCommands: ['add-symbol-file "/x/app"'] }, '/ext/tools/gdb/vp-linux.py');
  assert.deepStrictEqual(c.initCommands, ['add-symbol-file "/x/app"', 'python import runpy; runpy.run_path("/ext/tools/gdb/vp-linux.py")', 'vp-kaslr -q']);
  assert.strictEqual(gl.withLinuxAwareness(c, '/ext/tools/gdb/vp-linux.py'), c);
  assert.deepStrictEqual(gl.withLinuxAwareness({ type: 'gdbtarget' }, '/s/vp-linux.py').initCommands.length, 2);
  // The script and the module agree on the version; the script ships in the .vsix.
  const py = fs.readFileSync(path.join(__dirname, '..', 'tools', 'gdb', 'vp-linux.py'), 'utf8');
  assert.strictEqual(/^VERSION = "(.*)"$/m.exec(py)[1], gl.SCRIPT_VERSION);
  for (const cmd of ['-vp-ps', '-vp-dmesg', '-vp-kaslr', '-vp-linux-version']) assert.ok(py.includes(`"${cmd}"`), cmd);
  assert.match(fs.readFileSync(path.join(__dirname, '..', '.vscodeignore'), 'utf8'), /^!tools\/gdb\/\*\*$/m);
});

testAsync('kit: tar archives with long names, read back and by GNU tar', async () => {
  const tar = require('../lib/tar');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-tar-'));
  const big = path.join(dir, 'big.bin');
  fs.writeFileSync(big, Buffer.alloc(70000, 7));
  const long1 = `k/${'a'.repeat(90)}/${'b'.repeat(60)}.txt`; // ustar prefix + name
  const long2 = `k/${'c'.repeat(300)}.txt`; // needs a pax header
  assert.deepStrictEqual(tar.splitName(long1), { prefix: `k/${'a'.repeat(90)}`, name: `${'b'.repeat(60)}.txt` });
  assert.strictEqual(tar.splitName(long2), null);
  assert.strictEqual(tar.paxRecord('path', 'x'), '9 path=x\n'); // the length counts itself
  assert.strictEqual(tar.paxRecord('path', 'y'.repeat(92)), '102 path=' + 'y'.repeat(92) + '\n'); // 99 + 3 digits: the carry case
  assert.throws(() => tar.cleanPath('k/../etc/passwd'), /unsafe/);
  assert.strictEqual(tar.cleanPath('./k//x'), 'k/x');
  const out = path.join(dir, 'a.tar.gz');
  const w = await tar.write(out, [
    { path: 'k/first.json', data: '{"x":1}' },
    { path: long1, data: 'one' },
    { path: long2, file: big },
    { path: 'k/empty', data: '' },
    { path: 'k/sums', data: (files) => files.map((f) => `${f.sha256}  ${f.path}`).join('\n') },
  ]);
  assert.strictEqual(w.files.length, 5);
  assert.strictEqual(w.files[2].sha256, crypto.createHash('sha256').update(fs.readFileSync(big)).digest('hex'));
  const back = {};
  const got = await tar.read(out, (e) => {
    if (e.type !== 'file') return undefined;
    const chunks = [];
    return new (require('stream').Writable)({ write(c, enc, cb) { chunks.push(c); cb(); }, final(cb) { back[e.path] = Buffer.concat(chunks); cb(); } });
  });
  assert.deepStrictEqual(got.map((f) => f.path), ['k/first.json', long1, long2, 'k/empty', 'k/sums']);
  assert.strictEqual(back[long1].toString(), 'one');
  assert.strictEqual(back[long2].length, 70000);
  assert.strictEqual(back['k/empty'].length, 0);
  assert.strictEqual(back['k/sums'].toString().split('\n').length, 4);
  assert.strictEqual((await tar.readFile(out, 'k/first.json')).toString(), '{"x":1}');
  const gnu = require('child_process').spawnSync('tar', ['-tzf', out], { encoding: 'utf8' });
  if (gnu.status === 0) assert.deepStrictEqual(gnu.stdout.trim().split('\n'), ['k/first.json', long1, long2, 'k/empty', 'k/sums']);
  fs.writeFileSync(path.join(dir, 'not.tar.gz'), 'hello');
  await assert.rejects(tar.read(path.join(dir, 'not.tar.gz'), () => undefined));
});

testAsync('kit: plan, export and import of a platform with its files and a model', async () => {
  const kit = require('../lib/kit');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-kit-'));
  const w = (rel, data) => { const f = path.join(base, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); return f; };
  w('src/common/u.lua', '-- prelude');
  w('src/plat/fw/k.bin', Buffer.alloc(1000, 1));
  w('src/plat/fw/dtb', 'dtb');
  w('src/plat/disk.img', Buffer.alloc(5000, 2));
  const abs = w('elsewhere/app.elf', '\x7fELF....');
  w('src/models/m1/m1.model.json', JSON.stringify({ name: 'm1' }));
  w('src/models/m1/src/m1.cc', '// model');
  w('src/models/m1/build/m1.so', 'binary');
  const pin = w('pin/qbox.pin.json', JSON.stringify({ pinVersion: 1, qbox: { commit: 'a'.repeat(40), patches: ['patches/p.patch'] } }));
  w('pin/patches/p.patch', 'diff');
  const doc = {
    schemaVersion: '0.2', name: 'kp', description: 'kit test',
    luaPrelude: ['${TOP}../common/u.lua'],
    variables: [{ name: 'FW', value: '${TOP}fw' }, { name: 'ADDR', value: '0x1000' }],
    modules: {
      router: { type: 'router' },
      blk: { type: 'virtio_mmio_blk', params: { blkdev_str: 'file=${TOP}disk.img,format=raw,if=none' } },
      m: { type: 'm1', dylib: '${TOP}../models/m1/build/m1' },
      load: { type: 'loader', entries: [
        { bin_file: '${FW}/k.bin', address: '${ADDR}' },
        { bin_file: '${TOP}fw/dtb', address: '0x2000' },
        { elf_file: abs },
        { bin_file: '${TOP}nope.bin', address: '0x3000' },
      ] },
    },
  };
  const platformFile = w('src/plat/kp.platform.json', JSON.stringify(doc, null, 2));
  const p = kit.plan(doc, platformFile, { pinFile: pin, bundledTypes: ['cpu_arm_cortexA73'] });
  assert.strictEqual(p.root, path.join(base, 'src'));
  assert.strictEqual(p.platformPath, 'platform/plat/kp.platform.json');
  const byPath = Object.fromEntries(p.files.map((f) => [f.path, f.role]));
  assert.deepStrictEqual(byPath, {
    'platform/_external/app.elf': 'image',
    'platform/common/u.lua': 'lua',
    'platform/models/m1/m1.model.json': 'model',
    'platform/models/m1/src/m1.cc': 'model',
    'platform/plat/disk.img': 'disk',
    'platform/plat/fw/dtb': 'image',
    'platform/plat/fw/k.bin': 'image',
    'qbox/patches/p.patch': 'qbox',
    'qbox/qbox.pin.json': 'qbox',
  });
  assert.deepStrictEqual(p.missing.map((m) => m.ref), ['${TOP}nope.bin']);
  assert.deepStrictEqual(p.rewrites, [{ token: abs, replacement: '${TOP}../_external/app.elf' }]);
  assert.deepStrictEqual(p.models.map((m) => [m.name, m.path]), [['m1', 'platform/models/m1']]);
  assert.deepStrictEqual(kit.largeFiles(p, 4000), ['platform/plat/disk.img']);
  await assert.rejects(kit.exportKit(p, path.join(base, 'x.tar.gz')), /files not found: \$\{TOP\}nope.bin/);

  const archive = path.join(base, 'out', 'kp-kit.tar.gz');
  const m = await kit.exportKit(p, archive, { allowMissing: true, omit: new Set(['platform/plat/disk.img']), urls: { 'platform/plat/disk.img': 'https://example.com/disk.img' }, vpStudio: '9.9.9' });
  assert.strictEqual(m.omitted.length, 1);
  assert.strictEqual(m.omitted[0].sha256, crypto.createHash('sha256').update(Buffer.alloc(5000, 2)).digest('hex'));
  assert.ok(!m.files.some((f) => f.path === 'platform/plat/disk.img'));
  assert.strictEqual(m.qbox.commit, 'a'.repeat(40));

  const head = await kit.readManifest(archive);
  assert.strictEqual(head.top, 'kp-kit');
  assert.strictEqual(head.manifest.vpStudio, '9.9.9');
  const recv = path.join(base, 'recv');
  const r = await kit.importKit(archive, recv);
  assert.deepStrictEqual(r.bad, []);
  assert.deepStrictEqual(r.extra, []);
  assert.strictEqual(r.platform, path.join(recv, 'kp-kit', 'platform', 'plat', 'kp.platform.json'));
  const text = fs.readFileSync(r.platform, 'utf8');
  const got = JSON.parse(text);
  assert.strictEqual(got.modules.load.entries[2].elf_file, '${TOP}../_external/app.elf');
  assert.strictEqual(got.modules.m.dylib, '${TOP}../models/m1/build/m1');
  assert.ok(fs.existsSync(path.join(path.dirname(r.platform), '..', '_external', 'app.elf')));
  assert.ok(!fs.existsSync(path.join(recv, 'kp-kit', 'platform', 'models', 'm1', 'build')));
  const readme = fs.readFileSync(path.join(recv, 'kp-kit', 'README.md'), 'utf8');
  assert.match(readme, /platform\/plat\/disk\.img/);
  assert.match(readme, /https:\/\/example\.com\/disk\.img/);
  assert.match(readme, /Build Model/);
  assert.strictEqual(kit.findKitRoot(r.platform), path.join(recv, 'kp-kit'));
  // The left-out disk image: missing, then added.
  let rep = kit.omittedReport(r.dir, r.manifest);
  assert.deepStrictEqual(rep.map((x) => x.state), ['missing']);
  fs.writeFileSync(rep[0].file, Buffer.alloc(5000, 2));
  assert.deepStrictEqual(kit.omittedReport(r.dir, r.manifest).map((x) => x.state), ['present']);
  assert.strictEqual(await kit.checkOmitted(rep[0], rep[0].file), true);
  fs.writeFileSync(rep[0].file, Buffer.alloc(5000, 3));
  assert.strictEqual(await kit.checkOmitted(rep[0], rep[0].file), false);
  // Unpacking again needs overwrite; a damaged file is reported.
  await assert.rejects(kit.importKit(archive, recv), (e) => e.code === 'EEXIST');
  fs.writeFileSync(path.join(r.dir, 'SHA256SUMS'), fs.readFileSync(path.join(r.dir, 'SHA256SUMS'), 'utf8')); // unchanged
  const again = await kit.importKit(archive, recv, { overwrite: true });
  assert.deepStrictEqual(again.bad, []);
  await assert.rejects(kit.readManifest(path.join(base, 'src', 'plat', 'fw', 'dtb')), /not a VP Studio kit/);
  // Rewrites only touch JSON strings, and keep the rest of the text.
  assert.strictEqual(kit.rewriteText('{ "a": "/x/y.bin", "b": 1 } // /x/y.bin', [{ token: '/x/y.bin', replacement: '${TOP}z.bin' }]), '{ "a": "${TOP}z.bin", "b": 1 } // /x/y.bin');
  assert.deepStrictEqual(kit.tokensOf('file=${TOP}a.img,format=raw'), ['${TOP}a.img', 'raw']);
});

test('kit: vp-run options', () => {
  const { parseArgs, UsageError } = require('../bin/vp-run.js');
  const o = parseArgs(['--export-kit', 'k.tar.gz', '--omit', 'image_ext4.img', '--omit-larger', '512', '--url', 'image_ext4.img=https://x/y', 'p.platform.json']);
  assert.strictEqual(o.exportKit, 'k.tar.gz');
  assert.deepStrictEqual(o.omit, ['image_ext4.img']);
  assert.strictEqual(o.omitLarger, 512);
  assert.deepStrictEqual(o.urls, { 'image_ext4.img': 'https://x/y' });
  const i = parseArgs(['--import-kit', 'k.tar.gz', '--into', '/tmp/x']);
  assert.strictEqual(i.importKit, 'k.tar.gz');
  assert.strictEqual(i.into, '/tmp/x');
  assert.throws(() => parseArgs(['--import-kit', 'k.tar.gz', 'p.platform.json']), UsageError);
  assert.throws(() => parseArgs(['--url', 'nourl', 'p.platform.json']), UsageError);
});

test('checkpoint: what a checkpoint of the Ubuntu platform holds', () => {
  const ck = require('../lib/checkpoint');
  const reg = require('../lib/registers');
  const doc = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'examples', 'ubuntu-aarch64.platform.json'), 'utf8'));
  const cat = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'catalog', 'qbox-catalog.json'), 'utf8'));
  const top = '/plat';
  const p = ck.plan(doc, { catalog: cat, descs: reg.loadDir(path.join(__dirname, '..', 'catalog', 'registers')).descs, buses: ['router'], topDir: top });
  // RAM through DMI; the background memory has no DMI and is skipped.
  assert.deepStrictEqual(p.memories, [{ name: 'ram_0', address: '0x80000000', size: '0x100000000', bus: 0 }]);
  assert.deepStrictEqual(p.skipped.map((x) => x.instance), ['fallback_0']);
  // QBox's SystemC PL011 is saved as its read-write registers without read side effects (not UARTDR).
  assert.ok(p.registers.length > 5 && p.registers.every((r) => r.name.startsWith('pl011_uart_0.')));
  assert.ok(!p.registers.some((r) => r.name.endsWith('.UARTDR')));
  assert.ok(p.registers.some((r) => r.name === 'pl011_uart_0.UARTCR' && r.address === '0x10000030'));
  // GIC, virtio, CPUs are QEMU's; router, loader, keep_alive have no state.
  assert.deepStrictEqual(p.unsaved, []);
  assert.strictEqual(ck.isQemuType('arm_gicv3', cat), true);
  assert.strictEqual(ck.isQemuType('Pl011', cat), false);
  assert.strictEqual(ck.isQemuType('no_such_type', cat), null);
  // The writable disk image, as the simulation really opens it (an override wins).
  assert.deepStrictEqual(p.disks.map((d) => d.file), ['/plat/fw/Artifacts/image_ext4.img']);
  const o = ck.plan(doc, { topDir: top, overrides: [{ instance: 'virtioblk_0', param: 'blkdev_str', value: 'file=/run/x.img,format=raw' }] });
  assert.deepStrictEqual(o.disks.map((d) => d.file), ['/run/x.img']);
  // A disk opened with snapshot=on keeps the guest's writes in a temporary overlay: not savable.
  const v = ck.plan(doc, { topDir: top, overrides: [{ instance: 'virtioblk_0', param: 'blkdev_str', value: 'file=/c/d.img,format=raw,snapshot=on' }] });
  assert.deepStrictEqual(v.volatile, [{ module: 'virtioblk_0', file: '/c/d.img' }]);
  assert.deepStrictEqual(v.disks, []);
  // A SystemC model the checkpoint knows nothing about is reported.
  const d2 = JSON.parse(JSON.stringify(doc));
  d2.modules.mystery_0 = { type: 'my_model' };
  assert.deepStrictEqual(ck.plan(d2, { catalog: cat, topDir: top, descs: reg.loadDir(path.join(__dirname, '..', 'catalog', 'registers')).descs, buses: ['router'] }).unsaved, [{ instance: 'mystery_0', type: 'my_model' }]);
  // Without register descriptions the PL011 has no way to be saved either.
  assert.deepStrictEqual(ck.plan(doc, { catalog: cat, topDir: top }).unsaved, [{ instance: 'pl011_uart_0', type: 'Pl011' }]);
});

testAsync('checkpoint: save refuses a disk in a snapshot overlay, and runs the guest on afterwards', async () => {
  const ck = require('../lib/checkpoint');
  const calls = [];
  const client = { request: async (m, p) => { calls.push(m); return m === 'sim.getStatus' ? { state: 'running' } : { time: { seconds: 1, text: '1 s' }, memories: [], registers: [] }; } };
  await assert.rejects(ck.save(client, '/nonexistent/x', { volatile: [{ module: 'blk', file: '/d.img' }], memories: [], registers: [], disks: [], skipped: [], unsaved: [] }, {}), /snapshot=on/);
  assert.deepStrictEqual(calls, []);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-ckpt-save-'));
  const m = await ck.save(client, dir, { volatile: [], memories: [], registers: [], disks: [], skipped: [], unsaved: [] }, { name: 'n', platformFile: '/p/a.platform.json', platformText: 'x' });
  assert.deepStrictEqual(calls, ['sim.getStatus', 'sim.pause', 'ckpt.save', 'sim.continue']);
  assert.strictEqual(m.platform.sha256, ck.sha256('x'));
  assert.ok(fs.existsSync(path.join(dir, 'checkpoint.json')));
});

test('checkpoint: manifest, listing and how to start from it', () => {
  const ck = require('../lib/checkpoint');
  const doc = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'examples', 'ubuntu-aarch64.platform.json'), 'utf8'));
  const text = JSON.stringify(doc);
  assert.strictEqual(ck.withDiskFile('file=${TOP}a.img,format=raw,if=none,readonly=off', '/c/run/d.img', false), 'file=/c/run/d.img,format=raw,if=none,readonly=off');
  assert.strictEqual(ck.withDiskFile('format=raw,file=/a.img,snapshot=off', '/c/d.img', true), 'format=raw,file=/c/d.img,snapshot=on');
  assert.match(ck.defaultName(doc, new Date(2026, 10, 16, 9, 5, 7)), /^ubuntu-aarch64-20261116-090507$/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-ckpt-'));
  const dir = path.join(root, 'ck1');
  fs.mkdirSync(dir);
  assert.throws(() => ck.readManifest(dir), /not a checkpoint/);
  const manifest = { checkpoint: 1, name: 'ck1', created: '2026-11-16T10:00:00Z', platform: { name: 'ubuntu-aarch64.platform.json', sha256: ck.sha256(text) },
    time: { seconds: 255.6, text: '255600000000 ns' }, disks: [{ module: 'virtioblk_0', param: 'blkdev_str', file: 'disk-virtioblk_0-0.img' }] };
  fs.writeFileSync(path.join(dir, 'checkpoint.json'), JSON.stringify(manifest));
  assert.throws(() => ck.readManifest(dir), /agent\.json is missing/);
  fs.writeFileSync(path.join(dir, 'agent.json'), '{}');
  fs.writeFileSync(path.join(dir, 'devices.qemu'), 'x');
  assert.strictEqual(ck.readManifest(dir).name, 'ck1');
  const dir2 = path.join(root, 'ck2');
  fs.mkdirSync(dir2);
  for (const f of ['agent.json', 'devices.qemu']) fs.writeFileSync(path.join(dir2, f), '{}');
  fs.writeFileSync(path.join(dir2, 'checkpoint.json'), JSON.stringify(Object.assign({}, manifest, { name: 'ck2', created: '2026-11-16T11:00:00Z' })));
  fs.mkdirSync(path.join(root, 'junk'));
  assert.deepStrictEqual(ck.list(root, '/p/ubuntu-aarch64.platform.json').map((c) => c.manifest.name), ['ck2', 'ck1']);
  assert.deepStrictEqual(ck.list(root, '/p/other.platform.json'), []);
  assert.strictEqual(ck.rootFor('/p/x.platform.json'), path.join('/p', 'checkpoints'));
  // Start: a copy of each disk in run/, the agent loads the folder.
  const rp = ck.restorePlan(manifest, dir, doc, { platformText: text });
  assert.deepStrictEqual(rp.problems, []);
  assert.deepStrictEqual(rp.copies, [{ from: path.join(dir, 'disk-virtioblk_0-0.img'), to: path.join(dir, 'run', 'disk-virtioblk_0-0.img') }]);
  assert.deepStrictEqual(rp.overrides, [{ instance: 'virtioblk_0', param: 'blkdev_str', value: `file=${path.join(dir, 'run', 'disk-virtioblk_0-0.img')},format=raw,if=none,readonly=off` }]);
  assert.deepStrictEqual(rp.agentParams, { restore_from: path.resolve(dir), restore_paused: false });
  // snapshot: the checkpoint's own image with snapshot=on, nothing copied.
  const rs = ck.restorePlan(manifest, dir, doc, { snapshot: true, paused: true });
  assert.deepStrictEqual(rs.copies, []);
  assert.match(rs.overrides[0].value, /disk-virtioblk_0-0\.img,.*snapshot=on$/);
  assert.strictEqual(rs.agentParams.restore_paused, true);
  // A changed platform is a warning; a disk module that is gone, an error.
  assert.strictEqual(ck.restorePlan(manifest, dir, doc, { platformText: text + ' ' }).problems[0].level, 'warning');
  const d3 = JSON.parse(text);
  delete d3.modules.virtioblk_0;
  assert.strictEqual(ck.restorePlan(manifest, dir, d3).problems[0].level, 'error');
});

test('pin: whether the pinned patches are applied, without git', () => {
  const pin = require('../lib/pin');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-patch-'));
  fs.mkdirSync(path.join(root, 'hw'));
  const patch = 'Subject: [PATCH] t\n---\n--- a/hw/x.c\n+++ b/hw/x.c\n@@ -1,2 +1,3 @@\n int a;\n+int marker = 1;\n-old();\n+  new();\n';
  fs.writeFileSync(path.join(root, 'hw', 'x.c'), 'int a;\nold();\n');
  assert.strictEqual(pin.patchApplied(patch, root), false);
  fs.writeFileSync(path.join(root, 'hw', 'x.c'), 'int a;\nint marker = 1;\n  new();\n');
  assert.strictEqual(pin.patchApplied(patch, root), true);
  assert.strictEqual(pin.patchApplied(patch, path.join(root, 'nope')), null);
  // The pinned libqemu patch adds the marker the agent looks for.
  const p = pin.readPin(path.join(__dirname, '..', 'qbox.pin.json'));
  assert.deepStrictEqual(p.libqemu.patches, ['patches/libqemu/0001-register-device-vmstate.patch']);
  const text = fs.readFileSync(path.join(__dirname, '..', p.libqemu.patches[0]), 'utf8');
  assert.match(text, /^\+int libqemu_device_vmstate = 1;$/m);
  const agent = fs.readFileSync(path.join(__dirname, '..', 'tools', 'sim-agent', 'sim_agent.cc'), 'utf8');
  assert.ok(agent.includes('dlsym(h, "libqemu_device_vmstate")'));
  // The patches ship in the .vsix (build-qbox.sh and Check QBox Version read them there).
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', '.vscodeignore'), 'utf8'), /^patches/m);
});

test('xml: elements, attributes, entities, CDATA, comments and errors', () => {
  const xml = require('../lib/xml');
  const r = xml.parse('﻿<?xml version="1.0"?>\n<!DOCTYPE a>\n<a:root xmlns:a="u" k=\'v &amp; w\'><!-- c --><b x="1"/>t&lt;<![CDATA[<raw>]]>&#x41;&#66;<c>  in  </c></a:root>');
  assert.strictEqual(xml.localName(r.name), 'root');
  assert.strictEqual(xml.attr(r, 'k'), 'v & w');
  assert.strictEqual(xml.kids(r).length, 2);
  assert.strictEqual(xml.attr(xml.kid(r, 'b'), 'x'), '1');
  assert.strictEqual(xml.childText(r, 'c'), 'in');
  assert.strictEqual(xml.textOf(r), 't<<raw>AB  in');
  assert.throws(() => xml.parse('<a><b></a>'), /does not match <b> \(line 1/);
  assert.throws(() => xml.parse('<a>\n<b>'), /<b> is not closed \(line 2/);
  assert.throws(() => xml.parse('<a x="1" x="2"/>'), /Duplicate attribute/);
  assert.throws(() => xml.parse('<a>&nbsp;</a>'), /Unknown entity/);
  assert.throws(() => xml.parse('<!DOCTYPE a [<!ENTITY e "x">]><a/>'), /internal subset/);
  assert.throws(() => xml.parse('<a/><b/>'), /More than one root/);
});

test('ipxact: numbers and expressions', () => {
  const ip = require('../lib/ipxact');
  const cases = { '42': 42n, '0x2A': 42n, "'h2A": 42n, "8'h2a": 42n, "'b101": 5n, "'d42": 42n, "'o52": 42n, '#2A': 42n, '4K': 4096n, '1M': 1n << 20n, "32'hFFFF_FFFF": 0xffffffffn };
  for (const [s, v] of Object.entries(cases)) assert.strictEqual(ip.literal(s), v, s);
  assert.strictEqual(ip.literal("4'bx01"), undefined);
  const P = { W: 32n, N: 3n };
  const ev = (s) => ip.evaluate(s, (n) => P[n]);
  assert.strictEqual(ev('W / 8 * N'), 12n);
  assert.strictEqual(ev('(1 << N) - 1'), 7n);
  assert.strictEqual(ev("'h100 + W*2"), 0x140n);
  assert.strictEqual(ev('N > 2 ? 16 : 8'), 16n);
  assert.strictEqual(ev('$clog2(W)'), 5n);
  assert.strictEqual(ev('2 ** 4 - -1'), 17n);
  assert.strictEqual(ev('~0 & 255'), 255n);
  assert.throws(() => ev('X + 1'), /unknown parameter X/);
  assert.throws(() => ev('4 /'), /incomplete/);
  assert.throws(() => ev('4 / 0'), /division by zero/);
  assert.strictEqual(ip.identOf('3rd reg'), 'r_3rd_reg');
  assert.strictEqual(ip.identOf('class'), 'class_');
  assert.strictEqual(ip.identOf('Rx-FIFO'), 'Rx_FIFO');
});

test('ipxact: the 2014 example becomes a model the wizard accepts', () => {
  const ip = require('../lib/ipxact');
  const modelgen = require('../lib/modelgen');
  const doc = ip.parse(fs.readFileSync(path.join(__dirname, '..', 'examples', 'ipxact', 'simple_timer.xml'), 'utf8'));
  assert.strictEqual(doc.standard, 'IEEE 1685-2014');
  assert.strictEqual(doc.vlnv.name, 'simple_timer');
  assert.strictEqual(doc.blocks.length, 1);
  const b = doc.blocks[0];
  assert.strictEqual(b.key, 'regs.timer');
  assert.strictEqual(b.range, 0x1000n); // REG_SPACE = 'h40 * 4 * 16
  assert.deepStrictEqual(b.notes, []);
  const by = Object.fromEntries(b.registers.map((r) => [r.name, r]));
  assert.deepStrictEqual(b.registers.map((r) => r.name), ['CTRL', 'STATUS', 'CH_0_LOAD', 'CH_0_VALUE', 'CH_1_LOAD', 'CH_1_VALUE', 'ID']);
  assert.strictEqual(by.CTRL.reset, 0x30n); // field resets combined
  assert.strictEqual(by.STATUS.access, 'w1c');
  assert.deepStrictEqual(by.STATUS.fields.map((f) => [f.msb, f.lsb]), [[1, 0]]); // bitWidth = NUM_TIMERS
  assert.strictEqual(by.CH_1_VALUE.offset, 0x24n);
  assert.strictEqual(by.CH_1_VALUE.access, 'ro');
  assert.strictEqual(by.ID.offset, 0xffcn);
  assert.strictEqual(by.STATUS.description, 'Interrupt status & flags');
  const { spec, problems } = ip.toModel(doc, b);
  assert.deepStrictEqual(problems, []);
  assert.strictEqual(spec.name, 'simple_timer');
  assert.strictEqual(spec.regionSize, '0x1000');
  assert.deepStrictEqual(spec.registers[0], { name: 'CTRL', offset: '0x0', size: 4, access: 'rw', reset: '0x30', description: 'Control', fields: [{ name: 'ENABLE', bits: '0' }, { name: 'PRESCALE', bits: '7:4', description: 'Clock divider = 2^PRESCALE' }] });
  // The generated C++ includes every register.
  const files = modelgen.files(spec);
  const regs = files.find((f) => f.path.endsWith('_regs.h')).text;
  for (const r of spec.registers) assert.ok(regs.includes(r.name), r.name);
  // Updating an existing model keeps its parameters and ports.
  const existing = modelgen.template('simple_timer');
  const up = ip.toModel(doc, b, { existing }).spec;
  assert.deepStrictEqual(up.params, existing.params);
  assert.deepStrictEqual(up.outputs, existing.outputs);
  assert.strictEqual(up.registers.length, 7);
  // As a register description it expands as the shipped ones do.
  const registers = require('../lib/registers');
  const desc = ip.toDescription(doc, b, { types: ['simple_timer'] });
  assert.strictEqual(registers.expand(desc).length, 7);
});

test('ipxact: 2009 register resets, dim arrays, mixed access and skipped parts', () => {
  const ip = require('../lib/ipxact');
  const x = `<spirit:component xmlns:spirit="http://www.spiritconsortium.org/XMLSchema/SPIRIT/1685-2009">
    <spirit:vendor>v</spirit:vendor><spirit:library>l</spirit:library><spirit:name>uart</spirit:name><spirit:version>1</spirit:version>
    <spirit:memoryMaps><spirit:memoryMap><spirit:name>mm</spirit:name>
      <spirit:bank spirit:bankAlignment="serial"><spirit:name>b0</spirit:name></spirit:bank>
      <spirit:addressBlock><spirit:name>regs</spirit:name><spirit:baseAddress>0x1000</spirit:baseAddress><spirit:range>4K</spirit:range><spirit:width>32</spirit:width>
        <spirit:register><spirit:name>DATA</spirit:name><spirit:dim>4</spirit:dim><spirit:addressOffset>0x0</spirit:addressOffset><spirit:size>8</spirit:size>
          <spirit:reset><spirit:value>0xA5</spirit:value></spirit:reset>
          <spirit:field><spirit:name>D</spirit:name><spirit:bitOffset>0</spirit:bitOffset><spirit:bitWidth>8</spirit:bitWidth><spirit:readAction>clear</spirit:readAction></spirit:field></spirit:register>
        <spirit:register><spirit:name>SR</spirit:name><spirit:addressOffset>0x8</spirit:addressOffset><spirit:size>32</spirit:size>
          <spirit:field><spirit:name>BUSY</spirit:name><spirit:bitOffset>0</spirit:bitOffset><spirit:bitWidth>1</spirit:bitWidth><spirit:access>read-only</spirit:access></spirit:field>
          <spirit:field><spirit:name>EN</spirit:name><spirit:bitOffset>1</spirit:bitOffset><spirit:bitWidth>1</spirit:bitWidth><spirit:access>read-write</spirit:access></spirit:field>
          <spirit:field><spirit:name>BAD</spirit:name><spirit:bitOffset>31</spirit:bitOffset><spirit:bitWidth>2</spirit:bitWidth></spirit:field></spirit:register>
        <spirit:register><spirit:name>ODD</spirit:name><spirit:addressOffset>0xc</spirit:addressOffset><spirit:size>24</spirit:size></spirit:register>
        <spirit:register><spirit:name>WO</spirit:name><spirit:addressOffset>0x10</spirit:addressOffset><spirit:size>16</spirit:size><spirit:access>write-only</spirit:access></spirit:register>
      </spirit:addressBlock></spirit:memoryMap></spirit:memoryMaps></spirit:component>`;
  const doc = ip.parse(x);
  assert.strictEqual(doc.standard, 'IEEE 1685-2009');
  assert.match(doc.notes.join('\n'), /bank b0 is not read/);
  const b = doc.blocks[0];
  assert.strictEqual(b.baseAddress, 0x1000n);
  assert.strictEqual(b.range, 4096n);
  assert.deepStrictEqual(b.registers.map((r) => [r.name, Number(r.offset), r.size, r.access]),
    [['DATA_0', 0, 1, 'rw'], ['DATA_1', 1, 1, 'rw'], ['DATA_2', 2, 1, 'rw'], ['DATA_3', 3, 1, 'rw'], ['SR', 8, 4, 'rw'], ['WO', 16, 2, 'wo']]);
  assert.strictEqual(b.registers[0].reset, 0xa5n);
  assert.strictEqual(b.registers[0].readSideEffect, true);
  const notes = b.notes.join('\n');
  assert.match(notes, /SR\.BAD: bits 32:31 are outside/);
  assert.match(notes, /SR: fields of different access \(ro, rw\)/);
  assert.match(notes, /ODD: 24-bit registers are not supported/);
  const { spec, problems } = ip.toModel(doc, b);
  assert.deepStrictEqual(problems.filter((p) => p.severity === 'error'), []);
  assert.match(spec.registers[0].description, /read hook/);
  assert.strictEqual(ip.toDescription(doc, b, { types: ['uart'] }).registers[0].readSideEffect, true);
  assert.throws(() => ip.parse('<design/>'), /a design/);
  assert.throws(() => ip.parse('<component><memoryMaps>'), /not closed/);
});

test('third-party debuggers: gdbstub of the platform, TRACE32 script and guide', () => {
  const tp = require('../lib/thirdparty');
  const d = load();
  let g = tp.gdbTarget(d, undefined, { port: 4321 });
  assert.deepStrictEqual(g, { port: 4321, source: 'debug-start', cpu: 'cpu_0', type: 'cpu_arm_cortexA76', cores: 8 });
  // A gdb_port set in the platform wins, on whichever CPU it is.
  d.modules.cpu.perIndex = { 2: { params: { gdb_port: 2000 } } };
  g = tp.gdbTarget(d);
  assert.deepStrictEqual([g.port, g.source, g.cpu], [2000, 'platform', 'cpu_2']);
  const cmm = tp.trace32Script(Object.assign({ platform: 'u.platform.json', host: 'sim-host', symbols: ['/k/vmlinux'] }, g));
  assert.match(cmm, /^SYStem\.CPU CortexA76 /m);
  assert.match(cmm, /^SYStem\.PORT sim-host:2000$/m);
  assert.match(cmm, /^SYStem\.GDBconfig GDBSERVER OFF /m);
  assert.match(cmm, /^SYStem\.Mode Attach$/m);
  assert.match(cmm, /^Data\.LOAD\.Elf "\/k\/vmlinux" \/NoCODE$/m);
  assert.match(cmm, /start t32marm64/);
  const unknown = tp.trace32Script({ platform: 'p', host: 'h', port: 1, type: 'cpu_riscv64', cores: 1 });
  assert.match(unknown, /^SYStem\.CPU$/m);
  assert.match(unknown, /t32mriscv/);
  const md = tp.guide(Object.assign({ platform: 'u.platform.json', host: 'localhost', symbols: ['/k/vmlinux'], cmmFile: '/x/debug/u.trace32.cmm', hostNames: ['box', '10.0.0.5'] }, g));
  assert.match(md, /`cpu_2` sets `gdb_port` 2000/);
  assert.match(md, /DO u\.trace32\.cmm/);
  assert.match(md, /`box`, `10\.0\.0\.5`/);
  assert.match(md, /target extended-remote localhost:2000/);
  assert.match(md, /set architecture aarch64/);
  assert.match(md, /\*\*Not confirmed\.\*\*/);
  assert.throws(() => tp.gdbTarget({ schemaVersion: '0.1', modules: { ram: { type: 'gs_memory' } } }), /no CPU/);
});

test('remote: settings, ports, paths and the ssh command line', () => {
  const remote = require('../lib/remote');
  assert.strictEqual(remote.config({ host: '' }), undefined);
  assert.throws(() => remote.config({ host: '-oProxyCommand=x', root: '/r' }), /ssh destination/);
  assert.throws(() => remote.config({ host: 'sim', root: 'qbox' }), /absolute path/);
  const rc = remote.config({ host: 'me@sim', root: '/home/me/qbox/', sshArgs: ['-p', '2222'] });
  assert.deepStrictEqual(rc, { host: 'me@sim', sshArgs: ['-p', '2222'], root: '/home/me/qbox', executable: '/home/me/qbox/build/platforms-vp', buildDir: '/home/me/qbox/build' });
  assert.strictEqual(remote.config({ host: 'sim', root: '/q', executable: '/opt/qbox/bin/platforms-vp' }).buildDir, '/opt/qbox/bin');
  assert.deepStrictEqual(remote.sshArgsFor(rc, 'true'), ['-p', '2222', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', 'me@sim', 'true']);
  // /proc/net/tcp: listening (0A) sockets only; ports are hex.
  const proc = [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    '   0: 0100007F:08AE 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1 1',
    '   1: 0100007F:D431 0100007F:08AE 01 00000000:00000000 00:00000000 00000000  1000        0 2 1',
    '   0: 00000000000000000000000000000000:5BA0 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 3 1',
  ].join('\n');
  assert.deepStrictEqual([...remote.listeningPorts(proc)].sort(), [2222, 23456]);
  let k = 0;
  const ports = remote.pickPorts(new Set([2222, 20000]), [{ name: 'SSH', preferred: 2222 }, { name: 'FTP', preferred: 2221 }, { name: '@agent' }, { name: '@gdb', preferred: 2221 }],
    { from: 20000, to: 20003, random: () => (k++ ? 0 : 0) });
  assert.deepStrictEqual(ports, { SSH: 20001, FTP: 2221, '@agent': 20002, '@gdb': 20003 });
  assert.throws(() => remote.pickPorts(new Set([5, 6]), [{ name: 'a' }], { from: 5, to: 6 }), /no free port/);
  assert.strictEqual(remote.mapPath('/w/qbox', '/r/qbox', '/w/qbox/platforms/u/x.lua'), '/r/qbox/platforms/u/x.lua');
  assert.strictEqual(remote.mapPath('/w/qbox', '/r/qbox', '/w/qbox'), '/r/qbox');
  assert.strictEqual(remote.mapPath('/w/qbox', '/r/qbox', '/w/qbox2/x'), undefined);
  assert.strictEqual(remote.mapPath('/w/qbox', '/r/qbox', '/etc/x'), undefined);
  assert.strictEqual(remote.mapText('dylib_path = "/w/qbox/m/x";\nf="/w/qbox";\nother="/w/qbox2/y"', '/w/qbox', '/r'), 'dylib_path = "/r/m/x";\nf="/r";\nother="/w/qbox2/y"');
  const args = remote.terminalArgs(rc, { forwards: [{ local: 1234, remote: 41234 }], cwd: '/home/me/qbox', command: "/home/me/qbox/build/platforms-vp -l '/x y.lua'" });
  assert.deepStrictEqual(args, ['-p', '2222', '-tt', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-L', '127.0.0.1:1234:127.0.0.1:41234', 'me@sim',
    "cd /home/me/qbox && exec /home/me/qbox/build/platforms-vp -l '/x y.lua'"]);
  assert.strictEqual(remote.shq("it's"), `'it'\\''s'`);
  assert.match(remote.commandLine(args), /^ssh -p 2222 -tt .* me@sim 'cd \/home\/me\/qbox && exec/);
  // The files a platform names, absolute; the remote check leaves symbol files out.
  const files = remote.platformFiles(load(), '/w/qbox/platforms/ubuntu');
  assert.ok(files.some((f) => f.file === '/w/qbox/platforms/fw/utils.lua' && f.role === 'lua'));
  assert.ok(files.some((f) => f.file === '/w/qbox/platforms/ubuntu/fw/Artifacts/image_ext4.img' && f.role === 'disk'));
  assert.strictEqual(new Set(files.map((f) => f.file)).size, files.length);
});

test('remote from Windows: local C:\\ paths map to the Linux host, in paths and in generated text', () => {
  const remote = require('../lib/remote');
  assert.ok(remote.isWindowsPath('C:\\work') && remote.isWindowsPath('c:/work') && remote.isWindowsPath('\\\\srv\\share'));
  assert.ok(!remote.isWindowsPath('/home/me') && !remote.isWindowsPath('work'));
  // VS Code gives c:\ (lower case) for the workspace and C:\ elsewhere: the same folder.
  assert.strictEqual(remote.mapPath('c:\\Users\\me\\work', '/r/work', 'C:\\Users\\me\\work\\platforms\\u\\x.lua'), '/r/work/platforms/u/x.lua');
  assert.strictEqual(remote.mapPath('C:\\Users\\me\\work', '/r/work', 'C:\\Users\\me\\work'), '/r/work');
  assert.strictEqual(remote.mapPath('C:\\Users\\me\\work', '/r/work', 'C:/Users/me/work/m/build/x'), '/r/work/m/build/x');
  assert.strictEqual(remote.mapPath('C:\\Users\\me\\work', '/r/work', 'C:\\Users\\me\\work2\\x'), undefined);
  assert.strictEqual(remote.mapPath('C:\\Users\\me\\work', '/r/work', 'D:\\Users\\me\\work\\x'), undefined);
  // In Lua (luaStr doubles backslashes), plain, and with / — all become /r/... with / inside.
  const core = require('../lib/core');
  const lua = core.generate({ schemaVersion: '0.1', name: 'w', modules: { m_0: { type: 'mymodel' } } },
    { libraries: { mymodel: 'C:\\Users\\me\\work\\models\\m\\build\\mymodel' } });
  assert.match(lua, /dylib_path = "C:\\\\Users\\\\me\\\\work\\\\models/);
  assert.match(remote.mapText(lua, 'c:\\users\\me\\work', '/r/work'), /dylib_path = "\/r\/work\/models\/m\/build\/mymodel";/);
  assert.strictEqual(remote.mapText('a="C:\\Users\\me\\work\\x\\y.img", b="C:/Users/me/work/z", c="C:\\Users\\me\\work2\\q"', 'C:\\Users\\me\\work', '/r'),
    'a="/r/x/y.img", b="/r/z", c="C:\\Users\\me\\work2\\q"');
  // The platform's files: ${TOP} ones under the Windows folder; an absolute /path
  // can only be on the Linux host (remoteOnly, nothing to compare or upload).
  const doc = { schemaVersion: '0.1', name: 'w', modules: {
    loader_0: { type: 'loader', params: { 'load_0.bin_file': '${TOP}/fw/Image.bin', 'load_1.bin_file': '/data/images/initrd.img' } } } };
  const files = remote.platformFiles(doc, 'C:\\Users\\me\\work\\platforms\\u');
  const img = files.find((f) => /Image\.bin$/.test(f.file));
  assert.strictEqual(img.file, 'C:\\Users\\me\\work\\platforms\\u\\fw\\Image.bin');
  assert.ok(!img.remoteOnly);
  assert.strictEqual(remote.mapPath('C:\\Users\\me\\work', '/r/work', img.file), '/r/work/platforms/u/fw/Image.bin');
  const rd = files.find((f) => /initrd/.test(f.file));
  assert.deepStrictEqual([rd.file, rd.remoteOnly], ['/data/images/initrd.img', true]);
  // On Linux the same absolute path is a local file as before.
  assert.ok(!remote.platformFiles(doc, '/w/platforms/u').find((f) => /initrd/.test(f.file)).remoteOnly);
});

testAsync('remote: checking and uploading files with the remote shell commands', async () => {
  const remote = require('../lib/remote');
  const { spawn } = require('child_process');
  // "ssh" that runs the remote command in a local shell, so the commands themselves are tested.
  const calls = [];
  const spawnFn = (cmd, args, opts) => { calls.push(args); return spawn('bash', ['-c', args[args.length - 1]], opts); };
  const rc = remote.config({ host: 'sim', root: '/r' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-remote-'));
  const local = path.join(dir, 'local.bin');
  fs.writeFileSync(local, Buffer.alloc(70000, 7));
  fs.writeFileSync(path.join(dir, 'same.txt'), 'abc');
  const there = path.join(dir, 'there');
  fs.mkdirSync(there);
  fs.writeFileSync(path.join(there, 'same.txt'), 'abc');
  fs.writeFileSync(path.join(there, 'other.txt'), 'abcdef');
  fs.writeFileSync(path.join(dir, 'other.txt'), 'abc');
  const st = await remote.checkFiles(rc, [
    { local, remote: path.join(there, 'sub dir', "it's.bin") },
    { local: path.join(dir, 'same.txt'), remote: path.join(there, 'same.txt') },
    { local: path.join(dir, 'other.txt'), remote: path.join(there, 'other.txt') },
  ], { spawnFn });
  assert.deepStrictEqual(st.map((x) => [x.state, x.localSize, x.remoteSize]), [['missing', 70000, null], ['ok', 3, 3], ['size', 3, 6]]);
  assert.strictEqual(calls[0][calls[0].length - 2], 'sim');
  let progress = 0;
  await remote.upload(rc, local, path.join(there, 'sub dir', "it's.bin"), { spawnFn, onProgress: (n) => { progress = n; } });
  assert.strictEqual(progress, 70000);
  assert.ok(fs.readFileSync(path.join(there, 'sub dir', "it's.bin")).equals(fs.readFileSync(local)));
  assert.ok(!fs.existsSync(path.join(there, 'sub dir', "it's.bin.vp-upload")));
  await remote.writeText(rc, path.join(there, 'new', 'p.lua'), 'print(1)\n', { spawnFn });
  assert.strictEqual(fs.readFileSync(path.join(there, 'new', 'p.lua'), 'utf8'), 'print(1)\n');
  assert.strictEqual(await remote.home(rc, { spawnFn }), os.homedir());
  // A failing command reports what it printed; exit code 255 is ssh itself.
  const fail = (code, msg) => (cmd, args, opts) => spawn('bash', ['-c', `echo ${msg} >&2; exit ${code}`], opts);
  await assert.rejects(remote.runOk(rc, 'x', { spawnFn: fail(1, 'nope') }), /nope/);
  await assert.rejects(remote.runOk(rc, 'x', { spawnFn: fail(255, 'Permission denied') }), /cannot connect with ssh to sim: Permission denied.*without a password/);
  // A tool on the host (dtc for VS Code on Windows): stdin in, binary stdout back.
  const bytes = await remote.toolRunner(rc, 'printf', { spawnFn })(['\\001\\377%s', 'x'], '');
  assert.ok(Buffer.isBuffer(bytes) && bytes.equals(Buffer.from([1, 255, 0x78])));
  const echo = await remote.toolRunner(rc, 'cat', { spawnFn })([], 'DTS in');
  assert.strictEqual(echo.toString(), 'DTS in');
  await assert.rejects(remote.toolRunner(rc, 'no-such-tool-vp', { spawnFn })([], ''), /no-such-tool-vp is not installed on sim/);
  // A model folder sent next to what is already there (its remote build/ stays).
  const model = path.join(dir, 'model');
  fs.mkdirSync(path.join(model, 'src'), { recursive: true });
  fs.mkdirSync(path.join(model, 'build'));
  fs.writeFileSync(path.join(model, 'm.model.json'), '{}');
  fs.writeFileSync(path.join(model, 'src', 'm.cc'), '// m');
  fs.writeFileSync(path.join(model, 'build', 'm.so'), 'local build');
  const entries = remote.folderEntries(model, (rel) => !/^build(\/|$)/.test(rel));
  assert.deepStrictEqual(entries.map((e) => e.path).sort(), ['m.model.json', 'src/m.cc']);
  const rmodel = path.join(there, 'models', 'm');
  fs.mkdirSync(path.join(rmodel, 'build'), { recursive: true });
  fs.writeFileSync(path.join(rmodel, 'build', 'm.so'), 'remote build');
  await remote.uploadFiles(rc, entries, rmodel, require('../lib/tar').write, path.join(dir, 'up.tar.gz'), { spawnFn });
  assert.strictEqual(fs.readFileSync(path.join(rmodel, 'src', 'm.cc'), 'utf8'), '// m');
  assert.strictEqual(fs.readFileSync(path.join(rmodel, 'build', 'm.so'), 'utf8'), 'remote build');
  assert.ok(!fs.existsSync(path.join(dir, 'up.tar.gz')));
  fs.rmSync(dir, { recursive: true, force: true });
});

testAsync('remote password login: askpass server, launcher and helper; ssh options and hooks', async () => {
  const askpass = require('../lib/askpass');
  const remote = require('../lib/remote');
  const { spawnSync, spawn } = require('child_process');
  assert.strictEqual(askpass.promptKind("me@sim's password: "), 'password');
  assert.strictEqual(askpass.promptKind('Enter passphrase for key /home/me/.ssh/id_ed25519: '), 'password');
  assert.strictEqual(askpass.promptKind('Are you sure you want to continue connecting (yes/no/[fingerprint])? '), 'confirm');
  assert.strictEqual(askpass.promptKind('Verification code: '), 'other');
  assert.ok(askpass.offersPassword('me@sim: Permission denied (publickey,password).'));
  assert.ok(!askpass.offersPassword('me@sim: Permission denied (publickey).'));
  assert.ok(askpass.authRefused('Permission denied, please try again.') && !askpass.authRefused('Connection refused'));
  // The real thing: the launcher runs the helper with this Node, which asks the server.
  const asked = [];
  const srv = await askpass.startServer(async (q) => { asked.push(q); return q.kind === 'confirm' ? 'no' : 's3cret pa$$ "x"'; });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-askpass-'));
  const launcher = askpass.writeLauncher(dir);
  assert.ok(fs.statSync(launcher).mode & 0o100);
  const env = askpass.sshEnv({ launcher, node: process.execPath, port: srv.port, token: srv.token, host: 'me@sim' });
  assert.strictEqual(env.SSH_ASKPASS_REQUIRE, 'force');
  const ask = (prompt, e = env) => new Promise((resolve) => {
    const p = spawn(launcher, [prompt], { env: Object.assign({}, process.env, e) });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code, out }));
  });
  assert.deepStrictEqual(await ask("me@sim's password: "), { code: 0, out: 's3cret pa$$ "x"\n' });
  assert.deepStrictEqual(asked[0], { host: 'me@sim', prompt: "me@sim's password: ", kind: 'password' });
  assert.deepStrictEqual(await ask('continue connecting (yes/no)? '), { code: 0, out: 'no\n' });
  // A wrong token gets no answer: the helper exits 1 and ssh gives up.
  assert.strictEqual((await ask('password: ', Object.assign({}, env, { VP_ASKPASS_TOKEN: 'x'.repeat(48) }))).code, 1);
  assert.strictEqual(asked.length, 2);
  // No answer (the input box was closed): exit 1.
  const srv2 = await askpass.startServer(async () => null);
  assert.strictEqual((await ask('password: ', askpass.sshEnv({ launcher, node: process.execPath, port: srv2.port, token: srv2.token, host: 'h' }))).code, 1);
  srv.close(); srv2.close();
  // ssh options: BatchMode for keys; prompts allowed and new host keys accepted for passwords.
  const rc = remote.config({ host: 'me@sim', root: '/r' });
  assert.deepStrictEqual(remote.sshArgsFor(rc, 'true').slice(0, 2), ['-o', 'BatchMode=yes']);
  let refused = 0, accepted = 0;
  rc.askpass = { env: { SSH_ASKPASS: launcher, VP_ASKPASS_TOKEN: 't' }, onRefused: () => refused++, onAccepted: () => accepted++ };
  assert.deepStrictEqual(remote.sshArgsFor(rc, 'true').slice(0, 6), ['-o', 'BatchMode=no', '-o', 'NumberOfPasswordPrompts=1', '-o', 'StrictHostKeyChecking=accept-new']);
  assert.deepStrictEqual(remote.terminalArgs(rc, { cwd: '/r', command: 'x' }).slice(0, 7), ['-o', 'BatchMode=no', '-o', 'NumberOfPasswordPrompts=1', '-o', 'StrictHostKeyChecking=accept-new', '-tt']);
  // Every ssh gets the askpass environment; a refused password is forgotten, a login that worked is reported.
  let seenEnv;
  const fake = (code, err) => (cmd, args, opts) => { seenEnv = opts.env; return spawn('bash', ['-c', `echo '${err}' >&2; exit ${code}`], opts); };
  await assert.rejects(remote.runOk(rc, 'x', { spawnFn: fake(255, 'me@sim: Permission denied (publickey,password).') }), /password was not accepted; the next try asks again/);
  assert.strictEqual(seenEnv.VP_ASKPASS_TOKEN, 't');
  assert.strictEqual(seenEnv.PATH, process.env.PATH);
  assert.deepStrictEqual([refused, accepted], [1, 0]);
  await remote.runOk(rc, 'x', { spawnFn: fake(0, '') });
  assert.deepStrictEqual([refused, accepted], [1, 1]);
  await assert.rejects(remote.runOk(rc, 'x', { spawnFn: fake(255, 'ssh: connect to host sim port 22: Connection refused') }), (e) => !/password was not accepted/.test(e.message));
  assert.deepStrictEqual([refused, accepted], [1, 1]);
  // Key login refused: the error carries ssh's message, for the offer to use a password.
  delete rc.askpass;
  await assert.rejects(remote.runOk(rc, 'x', { spawnFn: fake(255, 'me@sim: Permission denied (publickey,password).') }),
    (e) => askpass.offersPassword(e.sshStderr) && /set "vpStudio.remote.auth" to "password"/.test(e.message));
  fs.rmSync(dir, { recursive: true, force: true });
  // On Windows the launcher is vp-askpass.exe (OpenSSH for Windows runs only .exe as SSH_ASKPASS):
  // shipped next to askpass.js, a 64-bit Windows program built from tools/askpass/vp-askpass.c.
  const exe = askpass.writeLauncher(path.join(os.tmpdir(), 'unused'), 'win32');
  assert.strictEqual(exe, path.join(__dirname, '..', 'lib', 'vp-askpass.exe'));
  const pe = fs.readFileSync(exe);
  assert.strictEqual(pe.toString('latin1', 0, 2), 'MZ');
  const peAt = pe.readUInt32LE(0x3c);
  assert.strictEqual(pe.toString('latin1', peAt, peAt + 4), 'PE\0\0');
  assert.strictEqual(pe.readUInt16LE(peAt + 4), 0x8664); // x86-64
  // It reads the same variables sshEnv sets, and is in the .vsix.
  const src = fs.readFileSync(path.join(__dirname, '..', 'tools', 'askpass', 'vp-askpass.c'), 'utf8');
  for (const v of ['VP_ASKPASS_NODE', 'VP_ASKPASS_SCRIPT']) { assert.ok(src.includes(v) && env[v] !== undefined, v); }
  // A Windows user folder with non-ASCII characters (潘國才): OpenSSH cannot start
  // the launcher there ("CreateProcessW failed error:2", 2026-11-21), so it is copied to
  // an ASCII folder of this user under ProgramData, limited to the user with icacls.
  assert.ok(askpass.sshSafePath('C:\\Users\\me\\.vscode\\extensions\\novatek.vp-studio-0.2.0\\lib\\vp-askpass.exe'));
  assert.ok(!askpass.sshSafePath('C:\\Users\\潘國才\\.vscode\\x.exe') && !askpass.sshSafePath('C:\\Users\\Pan Kuo\\x.exe'));
  assert.strictEqual(askpass.sidFrom('"vm\\pan","S-1-5-21-1004336348-1177238915-682003330-1001"\r\n'), 'S-1-5-21-1004336348-1177238915-682003330-1001');
  assert.strictEqual(askpass.sidFrom('garbage'), null);
  const sid = 'S-1-5-21-1-2-3-1001';
  const wdir = askpass.windowsLauncherDir(sid, { ProgramData: 'C:\\ProgramData' });
  assert.match(wdir, /^C:\\ProgramData\\VPStudio-[0-9a-f]{16}$/);
  assert.strictEqual(askpass.windowsLauncherDir(sid, { ProgramData: 'D:\\資料', SystemDrive: 'C:' }).startsWith('C:\\ProgramData\\VPStudio-'), true);
  const files = new Map([['C:\\Users\\潘國才\\ext\\lib\\vp-askpass.exe', Buffer.from('MZ launcher v1')]]);
  const fsx = {
    mkdirSync: (d) => { files.set(d + '\\', null); },
    readFileSync: (f) => { if (!files.has(f) || files.get(f) === null) throw new Error('ENOENT ' + f); return files.get(f); },
    writeFileSync: (f, b) => { files.set(f, Buffer.from(b)); },
  };
  const runs = [];
  const run = (cmd, args) => { runs.push([cmd, ...args]); return cmd === 'whoami' ? `"vm\\潘國才","${sid}"\r\n` : 'processed 1 files'; };
  const orig = 'C:\\Users\\潘國才\\ext\\lib\\vp-askpass.exe';
  const copy = askpass.windowsLauncher({ exe: orig, run, env: { ProgramData: 'C:\\ProgramData' }, fsx });
  assert.strictEqual(copy, wdir + '\\vp-askpass.exe');
  assert.ok(askpass.sshSafePath(copy));
  assert.deepStrictEqual(runs[1], ['icacls', wdir, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F']);
  assert.ok(files.get(copy).equals(files.get(orig)));
  assert.ok(askpass.launcherIntact(copy, orig, fsx));
  files.set(copy, Buffer.from('something else'));
  assert.ok(!askpass.launcherIntact(copy, orig, fsx));
  askpass.windowsLauncher({ exe: orig, run, env: { ProgramData: 'C:\\ProgramData' }, fsx }); // rewritten
  assert.ok(askpass.launcherIntact(copy, orig, fsx));
  // An ASCII path is used where it is; icacls failing (another user's folder) stops it.
  assert.strictEqual(askpass.windowsLauncher({ exe: 'C:\\Users\\me\\lib\\vp-askpass.exe', run: () => { throw new Error('not called'); } }), 'C:\\Users\\me\\lib\\vp-askpass.exe');
  assert.throws(() => askpass.windowsLauncher({ exe: orig, env: {}, fsx, run: (cmd) => { if (cmd === 'icacls') throw new Error('Access is denied.'); return `"x","${sid}"`; } }), /Access is denied/);
  assert.ok(!/^(lib\/\*\*|\*\.exe|lib\/vp-askpass\.exe)$/m.test(fs.readFileSync(path.join(__dirname, '..', '.vscodeignore'), 'utf8')));
});

testAsync('remote: the simulator is found when a QBox or build folder was given for it', async () => {
  const remote = require('../lib/remote');
  const { spawn } = require('child_process');
  const spawnFn = (cmd, args, opts) => spawn('bash', ['-c', args[args.length - 1]], opts);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-exe-'));
  const q = path.join(dir, 'my qbox');
  fs.mkdirSync(path.join(q, 'build'), { recursive: true });
  fs.writeFileSync(path.join(q, 'build', 'platforms-vp'), '#!/bin/sh\n', { mode: 0o755 });
  const exe = path.join(q, 'build', 'platforms-vp');
  // 2026-11-21: "…/qbox/build" given, so the build folder was taken as …/qbox (no CMakeCache.txt).
  const given = remote.config({ host: 'h', root: '/r', executable: path.join(q, 'build') + '/' });
  assert.strictEqual(given.executable, path.join(q, 'build'));
  assert.strictEqual(given.buildDir, q);
  for (const g of [exe, path.join(q, 'build'), q]) assert.strictEqual(await remote.findExecutable(given, g, { spawnFn }), exe, g);
  assert.strictEqual(await remote.findExecutable(given, path.join(dir, 'nothing'), { spawnFn }), null);
  // Relative to remote.root.
  const rel = remote.config({ host: 'h', root: dir, executable: 'my qbox' });
  assert.strictEqual(await remote.findExecutable(rel, undefined, { spawnFn }), exe);
  fs.rmSync(dir, { recursive: true, force: true });
});

testAsync('device tree: dtc as a runner (on the simulation host) gets the DTS on stdin and gives the DTB', async () => {
  const launch = require('../lib/launch');
  const dir = workspace();
  const d = load();
  d.devicetree = { output: '${TOP}/fw/gen.dtb' };
  const seen = [];
  const r = await launch.writeDeviceTree(d, path.join(dir, 'ubuntu-aarch64.platform.json'),
    async (args, input) => { seen.push(args, input); return Buffer.from([0xd0, 0x0d, 0xfe, 0xed]); });
  assert.deepStrictEqual(seen[0], ['-q', '-I', 'dts', '-O', 'dtb', '-o', '-', '-']);
  assert.match(seen[1], /^\/dts-v1\/;/);
  assert.strictEqual(fs.readFileSync(r.dts, 'utf8'), seen[1]);
  assert.ok(fs.readFileSync(r.dtb).equals(Buffer.from([0xd0, 0x0d, 0xfe, 0xed])));
  // The Device tree tab's comparison runs dtc the same way.
  const dtcompare = require('../lib/dtcompare');
  assert.strictEqual((await dtcompare.runDtc(async (args, input) => Buffer.from(`${args.join(' ')}|${input}`), ['-I', 'dtb'], 'x')).toString(), '-I dtb|x');
});

test('settings that name this machine\'s programs and hosts are machine-overridable', () => {
  // In a VS Code Remote-SSH window the extension runs on the Linux machine; the
  // Windows user settings (remote.host = the Linux machine itself, 2026-11-21)
  // must not apply there, or VP Studio sshes to itself and the forwards clash.
  const props = require('../package.json').contributes.configuration.properties;
  for (const k of ['vpStudio.executable', 'vpStudio.simAgent.library', 'vpStudio.dtc', 'vpStudio.debug.targetGdb',
    'vpStudio.remote.host', 'vpStudio.remote.root', 'vpStudio.remote.executable', 'vpStudio.remote.sshArgs', 'vpStudio.remote.auth']) {
    assert.strictEqual(props[k].scope, 'machine-overridable', k);
  }
});

test('tasks set their working folder (no ${workspaceFolder} when no folder is open)', () => {
  const ext = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  const execs = ext.match(/new vscode\.(Shell|Process)Execution\([^\n]*/g) || [];
  assert.ok(execs.length >= 4, execs.length);
  for (const e of execs) assert.match(e, /cwd: taskCwd\(/, e);
});

test('Windows: extension.js parses, local-only commands are hidden by vpStudio.localSim', () => {
  new (require('vm').Script)(fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8'));
  const menu = require('../lib/menu');
  const titles = menu.titlesFrom(require('../package.json'));
  const shown = (ctx) => menu.visible(ctx, titles).flatMap((g) => g.items.map((i) => i.command));
  const linux = shown({ 'vpStudio.localSim': true });
  const win = shown({ 'vpStudio.localSim': false });
  for (const c of ['vpStudio.buildQbox', 'vpStudio.buildSimAgent', 'vpStudio.checkQBox', 'vpStudio.startOpenOcd', 'vpStudio.startFromCheckpoint']) {
    assert.ok(linux.includes(c) && !win.includes(c), c);
  }
  for (const c of ['vpStudio.start', 'vpStudio.remote.selectHost', 'vpStudio.remote.buildSimAgent', 'vpStudio.remote.buildModel', 'vpStudio.buildModel', 'vpStudio.generateDeviceTree']) {
    assert.ok(win.includes(c), c);
  }
});

test('images: K-03 Linux Image with CPUs starting in EL3 is a warning', () => {
  const dir = workspace();
  const img = Buffer.alloc(4096);
  img.writeUInt32LE(0x644d5241, 0x38); // "ARM\x64"
  fs.writeFileSync(path.join(dir, 'fw', 'Artifacts', 'Image.bin'), img);
  const run = (d) => images.collect(d, core.analyze(d, { catalog }), dir, { catalog }).problems.filter((p) => /EL3/.test(p.message));
  const d = load();
  assert.strictEqual(images.isArm64Image(path.join(dir, 'fw', 'Artifacts', 'Image.bin')), true);
  assert.strictEqual(images.isArm64Image(path.join(dir, 'fw', 'Artifacts', 'ubuntu.dtb')), false);
  assert.deepStrictEqual(run(d), []); // the example sets has_el3: false
  delete d.modules.cpu.params.has_el3; // model default: true
  let w = run(d);
  assert.strictEqual(w.length, 1);
  assert.strictEqual(w[0].module, 'cpu');
  assert.ok(/^cpu_0\.\.cpu_7 start in EL3 \(has_el3 is true, the model default\), but load\[0\] Image\.bin is a Linux kernel/.test(w[0].message), w[0].message);
  d.modules.cpu.perIndex['0'].params.has_el3 = false;
  assert.ok(/^cpu_1\.\.cpu_7 start/.test(run(d)[0].message));
  // Through a variable, explicitly true: no "model default".
  d.variables.push({ name: 'EL3', value: true });
  d.modules.cpu.params.has_el3 = '${EL3}';
  assert.ok(!/model default/.test(run(d)[0].message));
  d.variables[d.variables.length - 1].value = false;
  assert.deepStrictEqual(run(d), []);
  d.modules.cpu.params.has_el3 = true;
  // EL3 firmware loaded too (by name, or any ELF): no warning.
  fs.writeFileSync(path.join(dir, 'fw', 'bl31.bin'), Buffer.alloc(64));
  const fw = JSON.parse(JSON.stringify(d));
  fw.modules.load.entries.push({ bin_file: '${TOP}fw/bl31.bin', address: '0x90000000' });
  assert.deepStrictEqual(run(fw), []);
  makeElf(path.join(dir, 'fw', 'boot.elf'), [{ paddr: 0x90000000n, memsz: 0x100n }]);
  const elf = JSON.parse(JSON.stringify(d));
  elf.modules.load.entries.push({ elf_file: '${TOP}fw/boot.elf' });
  assert.deepStrictEqual(run(elf), []);
  // Without a catalog no CPU type is known to have has_el3: no warning.
  const nocat = JSON.parse(JSON.stringify(d));
  assert.deepStrictEqual(images.collect(nocat, core.analyze(nocat), dir).problems.filter((p) => /EL3/.test(p.message)), []);
  assert.strictEqual(images.boolValue('${X}', { variables: [{ name: 'X', value: '${Y}' }, { name: 'Y', value: 'true' }] }), true);
  assert.strictEqual(images.boolValue({ $lua: 'x' }, {}), undefined);
});

test('ftrace: parse, match calls and returns, name, summarize, write a Chrome trace', () => {
  const ftrace = require('../lib/ftrace');
  const K = 0xffff800008000000n;
  const OFF = 0x1234600000n; // KASLR, 2 MiB steps
  const fns = [
    { name: 'main_loop', start: K + 0x1000n, size: 0x100n },
    { name: 'work', start: K + 0x2000n, size: 0x100n },
    { name: 'leaf', start: K + 0x3000n, size: 0x100n },
    { name: 'tail', start: K + 0x4000n, size: 0x100n },
    { name: 'cpu_switch_to', start: K + 0x5000n, size: 0x100n },
  ];
  const run = (n) => fns.find((f) => f.name === n).start + OFF;
  // [kind, from, to, ns, insns]
  const cpu0 = [
    [1, run('main_loop') + 0x10n, run('work'), 100, 1000],      // main_loop -> work
    [1, run('work') + 0x20n, run('leaf'), 150, 1010],           //   work -> leaf
    [2, run('leaf') + 0x40n, run('work') + 0x24n, 200, 1030],   //   leaf returns
    [1, run('work') + 0x30n, run('leaf'), 210, 1040],           //   work -> leaf (again)
    [2, run('leaf') + 0x40n, run('work') + 0x34n, 260, 1050],
    [1, run('work') + 0x50n, run('tail'), 270, 1060],           //   work -> tail, which returns to main_loop (as after a tail call)
    [2, run('tail') + 0x8n, run('main_loop') + 0x14n, 300, 1100],
    [2, run('main_loop') + 0x80n, 0x400000n, 310, 1110],        // return without a recorded call
    [1, run('main_loop') + 0x90n, 0xfffffbff00001000n, 320, 1120], // call into a module
    [2, 0xfffffbff00001010n, run('main_loop') + 0x94n, 330, 1130],
  ];
  const cpu3 = [
    [1, 0x400100n, 0x400800n, 50, 10],                          // user space
    [1, run('work') + 0x60n, run('cpu_switch_to'), 60, 20],
    [2, run('cpu_switch_to') + 0x40n, run('work') + 0x64n, 90, 40], // to another task, at the same return address
    [1, run('work') + 0x20n, run('leaf'), 95, 50],              // still open at the end
  ];
  const cpus = [[0, cpu0, cpu0.length], [3, cpu3, 9]];
  const parts = [Buffer.from('VPFTRC01', 'latin1'), Buffer.alloc(8)];
  parts[1].writeUInt32LE(1, 0); parts[1].writeUInt32LE(cpus.length, 4);
  for (const [cpu, ev, total] of cpus) {
    const h = Buffer.alloc(24);
    h.writeUInt32LE(cpu, 0); h.writeBigUInt64LE(BigInt(total), 8); h.writeBigUInt64LE(BigInt(ev.length), 16);
    parts.push(h);
    for (const [kind, from, to, ns, insns] of ev) {
      const r = Buffer.alloc(32);
      r.writeBigUInt64LE(from | BigInt(kind), 0); r.writeBigUInt64LE(to, 8);
      r.writeBigUInt64LE(BigInt(ns), 16); r.writeBigUInt64LE(BigInt(insns), 24);
      parts.push(r);
    }
  }
  const tr = ftrace.parse(Buffer.concat(parts));
  assert.strictEqual(tr.cpus.length, 2);
  assert.deepStrictEqual(tr.cpus[0].events[0], { kind: 1, from: run('main_loop') + 0x10n, to: run('work'), ns: 100, insns: 1000 });
  assert.throws(() => ftrace.parse(Buffer.from('nope')), /not a VP Studio function trace/);
  assert.throws(() => ftrace.parse(Buffer.concat(parts).subarray(0, 100)), /truncated/);

  assert.strictEqual(ftrace.guessOffset(tr, fns), OFF);
  const b = ftrace.build(tr, { functions: fns, offset: OFF });
  assert.strictEqual(b.start, 50);
  assert.strictEqual(b.end, 330);
  const c0 = b.cpus[0];
  assert.deepStrictEqual(c0.slices.map((s) => [s.name, s.start, s.end, s.depth, s.insns, s.self]), [
    ['work', 100, 300, 0, 100, 30],
    ['leaf', 150, 200, 1, 20, 20],
    ['leaf', 210, 260, 1, 10, 10],
    ['tail', 270, 300, 1, 40, 40],
    ['module 0xfffffbff00001000', 320, 330, 0, 10, 10],
  ]);
  assert.strictEqual(c0.unmatched, 1);
  const c3 = b.cpus[1];
  assert.deepStrictEqual(c3.slices.map((s) => [s.name, s.depth, s.open]), [
    ['user 0x400800', 0, true], ['cpu_switch_to', 1, true], ['leaf', 0, true]]);
  assert.strictEqual(c3.switches, 1);
  assert.deepStrictEqual(b.functions.get('leaf'), { calls: 3, insns: 30 + 0, self: 30, ns: 100 + 0, user: false });
  const top = ftrace.topFunctions(b, 2);
  assert.deepStrictEqual(top.map((f) => f.name), ['tail', 'leaf']);

  const md = ftrace.summary(b, { title: 'Function trace: demo', symbolFile: 'vmlinux', offset: OFF, jsonFile: 'demo.json' });
  assert.ok(/^# Function trace: demo/.test(md));
  assert.ok(/14 calls and returns on 2 CPUs/.test(md), md);
  assert.ok(/kept only the newest records on cpu 3 \(4 of 9\)/.test(md), md);
  assert.ok(/KASLR offset 0x1234600000/.test(md));
  assert.ok(/\| `work` \| 1 \| 30 \|/.test(md), md);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vps-ft-'));
  const file = path.join(dir, 't.json');
  ftrace.writeChromeTrace(file, b, { title: 'demo' });
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const x = j.traceEvents.filter((e) => e.ph === 'X');
  assert.strictEqual(x.length, 8);
  // CPU n is tid n + 1: Perfetto treats tid 0 as the idle thread and merges it into another track.
  assert.deepStrictEqual(x[0], { ph: 'X', name: 'work', pid: 1000, tid: 1, ts: 0.05, dur: 0.2, args: { insns: 100, self: 30 } });
  assert.ok(j.traceEvents.some((e) => e.ph === 'M' && e.name === 'thread_name' && e.tid === 4 && e.args.name === 'cpu 3'));
  assert.ok(x.find((e) => e.tid === 4 && e.name === 'leaf').args.open);
  assert.ok(j.traceEvents.every((e) => e.tid !== 0 && e.tid !== e.pid));
  // Rounded ends: a callee never ends after its caller (Perfetto reports that as an import error).
  for (const t of new Set(x.map((e) => e.tid))) {
    const stack = [];
    for (const e of x.filter((y) => y.tid === t)) {
      const s0 = Math.round(e.ts * 1000), e0 = s0 + Math.round(e.dur * 1000);
      while (stack.length && stack[stack.length - 1] <= s0) stack.pop();
      if (stack.length) assert.ok(e0 <= stack[stack.length - 1], e.name);
      stack.push(e0);
    }
  }
  // Without symbols, kernel functions are addresses; without matches the offset is 0.
  assert.strictEqual(ftrace.build(tr).cpus[0].slices[0].name, '0x' + run('work').toString(16));
  assert.strictEqual(ftrace.guessOffset(tr, []), 0n);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ftrace: a BL whose function returns elsewhere ends its frame (JIT code, trampolines)', () => {
  const ftrace = require('../lib/ftrace');
  const M = 0xfffffbfffdbf7400n; // module space, no symbol
  const ev = (kind, from, to, ns, insns) => ({ kind, from, to, ns, insns });
  const fns = [{ name: 'run_prog', start: 0xffff800008001000n, size: 0x100n }];
  const tr = { cpus: [{ cpu: 0, total: 6, events: [
    ev(1, 0xffff800008001010n, 0xffff800008001000n, 0, 0),       // something -> run_prog (its caller's frame not recorded)
    ev(1, M + 0x1cn, M + 0x24n, 10, 100),                          //   bl +8 inside the JIT code
    ev(2, M + 0x74n, 0xffff800008001044n, 20, 121),                //   which returns into run_prog, not to M + 0x20
    ev(1, M + 0x1cn, M + 0x24n, 30, 200),
    ev(2, M + 0x74n, 0xffff800008001044n, 40, 221),
    ev(2, 0xffff800008001080n, 0xffff800008001014n, 50, 300),      // run_prog returns
  ] }] };
  const b = ftrace.build(tr, { functions: fns });
  assert.deepStrictEqual(b.cpus[0].slices.map((s) => [s.name, s.depth, s.insns, s.open]), [
    ['run_prog', 0, 300, false],
    ['module 0xfffffbfffdbf7424', 1, 21, false],
    ['module 0xfffffbfffdbf7424', 1, 21, false],
  ]);
  assert.strictEqual(b.cpus[0].unmatched, 0);
});

test('menu: every command is in a group, package.json matches, when clauses follow the state', () => {
  const menu = require('../lib/menu');
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const declared = pkg.contributes.commands.map((c) => c.command);
  const hidden = new Set(pkg.contributes.menus.commandPalette.filter((m) => m.when === 'false').map((m) => m.command));
  // Buttons of their own views, and the menu itself, are not in the menu.
  const own = new Set(['vpStudio.menu', 'vpStudio.refreshRegisters', 'vpStudio.refreshParams', 'vpStudio.refreshGuest']);
  const inMenu = menu.commands();
  assert.strictEqual(new Set(inMenu).size, inMenu.length, 'a command is in the menu twice');
  for (const c of inMenu) assert.ok(declared.includes(c), `${c} is not a declared command`);
  assert.deepStrictEqual(declared.filter((c) => !hidden.has(c) && !own.has(c) && !inMenu.includes(c)), [], 'commands missing from the menu');
  // Every entry of the Actions view has an icon (a codicon in package.json).
  const iconOf = menu.titlesFrom(pkg);
  assert.deepStrictEqual(inMenu.filter((c) => !iconOf[c].icon), [], 'menu commands without an icon');
  // ...and the icon exists (a name that does not shows nothing; checked when the
  // codicons that come with the standalone application are installed).
  // debug-configure is an alias VS Code and Theia add to the font.
  const css = path.join(__dirname, '..', 'theia', 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css');
  if (fs.existsSync(css)) {
    const known = fs.readFileSync(css, 'utf8');
    const used = [...new Set([...Object.values(iconOf).map((t) => t.icon), ...menu.GROUPS.map((g) => g.icon)].filter(Boolean))];
    assert.deepStrictEqual(used.filter((i) => i !== 'debug-configure' && !known.includes(`.codicon-${i}:before`)), [], 'icons that do not exist');
  }
  // The "VP Studio ▾" submenus in package.json are exactly what lib/menu.js describes.
  const c = menu.contributions();
  assert.deepStrictEqual(pkg.contributes.submenus, c.submenus);
  for (const [k, v] of Object.entries(c.menus)) assert.deepStrictEqual(pkg.contributes.menus[k], v, k);
  assert.deepStrictEqual(pkg.contributes.menus['editor/title'][0], c.editorTitle);
  assert.ok(pkg.contributes.views.vpStudio.some((v) => v.id === 'vpStudio.actions'));

  assert.strictEqual(menu.evaluate('', {}), true);
  assert.strictEqual(menu.evaluate('a && !b', { a: true }), true);
  assert.strictEqual(menu.evaluate('a && !b', { a: true, b: true }), false);
  assert.strictEqual(menu.evaluate('x || a && b', { a: true, b: true }), true);
  assert.throws(() => menu.evaluate('a == 1', {}), /unsupported/);

  const titles = menu.titlesFrom(pkg);
  const flat = (ctx) => menu.visible(ctx, titles).flatMap((g) => g.items.map((i) => i.command));
  const idle = flat({});
  assert.ok(idle.includes('vpStudio.start') && idle.includes('vpStudio.connectAgent'));
  assert.ok(!idle.includes('vpStudio.pause') && !idle.includes('vpStudio.stop') && !idle.includes('vpStudio.ftrace.record'));
  const running = flat({ 'vpStudio.running': true, 'vpStudio.agentConnected': true });
  assert.ok(running.includes('vpStudio.pause') && running.includes('vpStudio.stop') && running.includes('vpStudio.ftrace.record'));
  assert.ok(!running.includes('vpStudio.start') && !running.includes('vpStudio.continue') && !running.includes('vpStudio.connectAgent'));
  const paused = flat({ 'vpStudio.running': true, 'vpStudio.agentConnected': true, 'vpStudio.paused': true });
  assert.ok(paused.includes('vpStudio.continue') && !paused.includes('vpStudio.pause'));
  const sim = menu.visible({}, titles).find((g) => g.id === 'simulation');
  assert.strictEqual(sim.items[0].label, 'Start Simulation');
  assert.strictEqual(sim.items[0].icon, 'play');
  // A separator only before the first item of a later section that shows.
  assert.deepStrictEqual(sim.items.filter((i) => i.separatorBefore).map((i) => i.command), ['vpStudio.connectAgent']);
  const ana = menu.visible({}, titles).find((g) => g.id === 'analysis');
  assert.deepStrictEqual(ana.items.map((i) => [i.command, i.separatorBefore]), [
    ['vpStudio.showTrace', false], ['vpStudio.showProfile', true], ['vpStudio.ftrace.convert', true],
    ['vpStudio.perf.newSweep', true], ['vpStudio.perf.open', false], ['vpStudio.perf.createExample', false]]);
  // Running performance experiments needs QBox on this machine.
  const anaLocal = menu.visible({ 'vpStudio.localSim': true }, titles).find((g) => g.id === 'analysis');
  assert.ok(anaLocal.items.some((i) => i.command === 'vpStudio.perf.run') && anaLocal.items.some((i) => i.command === 'vpStudio.perf.sweep'));
  assert.strictEqual(ana.items[1].icon, 'flame');
});

test('menu: the standalone application puts the same menu in its menu bar', () => {
  const file = path.join(__dirname, '..', 'theia', 'vp-studio-menu', 'lib', 'frontend-module.js');
  let mod;
  try { mod = require(file); } catch (e) {
    if (/Cannot find module '@theia/.test(e.message)) { console.log('     (skipped: theia/node_modules not installed)'); return; }
    throw e;
  }
  const menu = require('../lib/menu');
  const submenus = [];
  const actions = [];
  mod.registerMenus({
    registerSubmenu: (p, label) => submenus.push([p.join('/'), label]),
    registerMenuAction: (p, a) => actions.push(Object.assign({ path: p.join('/') }, a)),
  });
  assert.deepStrictEqual(submenus.slice(0, 3), [
    ['menubar/8_vpstudio', 'VP Studio'], ['menubar/8_vpstudio/1_groups/1_simulation', 'Simulation'], ['menubar/8_vpstudio/1_groups/2_analysis', 'Analysis']]);
  assert.deepStrictEqual(actions.map((a) => a.commandId), menu.commands());
  const pause = actions.find((a) => a.commandId === 'vpStudio.pause');
  assert.deepStrictEqual(pause, { path: 'menubar/8_vpstudio/1_groups/1_simulation/2_section', commandId: 'vpStudio.pause', label: 'Pause Simulation', order: '01', when: 'vpStudio.agentConnected && !vpStudio.paused' });
});

test('container-sshd.sh: valid shell, shipped, documented (INSTALL.md section 11)', () => {
  const root = path.join(__dirname, '..');
  const script = path.join(root, 'tools/container/container-sshd.sh');
  const r = require('child_process').spawnSync('bash', ['-n', script], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const text = fs.readFileSync(script, 'utf8');
  // Keys only, forwarding for VP Studio's -L, the image's environment passed on.
  for (const line of ['PasswordAuthentication no', 'AllowTcpForwarding local', 'PermitUserEnvironment yes']) assert.ok(text.includes(line), line);
  assert.match(fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8'), /^!tools\/container\/\*\*$/m);
  const install = fs.readFileSync(path.join(root, 'INSTALL.md'), 'utf8');
  assert.match(install, /## 11\. Windows 電腦搭配 server 上的容器/);
  assert.match(install, /container-sshd\.sh --key/);
});

test('perf: at_bus is a bus for the view, not for the agent and probes; only traffic_gen may bind to it', () => {
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'examples', 'perf', 'ddr-contention.platform.json'), 'utf8'));
  const a = core.analyze(d);
  assert.deepStrictEqual(a.buses, ['bus']);
  assert.deepStrictEqual(a.routers, []);
  assert.deepStrictEqual(a.problems, []);
  assert.deepStrictEqual(a.memoryMap.map((r) => [r.instance, r.bus]), [['ddr', 'bus']]);
  assert.strictEqual(require('../lib/trace').tracePoints(d).length, 0);
  assert.strictEqual(require('../lib/dataflow').hasDataFlow(a, 'cpu'), true);
  // The connect flow treats at_bus like a router: the device end writes the binding.
  assert.strictEqual(require('../lib/connect').declaringEnd(d, 'ddr', 'bus'), 'a');
  // A QEMU-style initiator on an at_bus is flagged.
  const bad = JSON.parse(JSON.stringify(d));
  bad.modules.load = { type: 'loader', ports: { initiator_socket: { bind: 'bus.target_socket' } } };
  assert.ok(core.analyze(bad).problems.some((p) => /takes approximately-timed initiators only/.test(p.message) && p.severity === 'warning'));
  // The two-channel example: two DRAM controllers, each 512 MiB, on the same bus; its sweep fits it.
  const d2 = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'examples', 'perf', 'ddr-2ch.platform.json'), 'utf8'));
  const a2 = core.analyze(d2, { catalog: JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'catalog', 'qbox-catalog.json'), 'utf8')) });
  assert.deepStrictEqual(a2.problems, []);
  assert.deepStrictEqual(a2.memoryMap.map((r) => [r.instance, Number(r.start), Number(r.size)]), [['ddr0', 0, 0x20000000], ['ddr1', 0x20000000, 0x20000000]]);
  const sw2 = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'examples', 'perf', 'ddr-2ch.perfsweep.json'), 'utf8'));
  assert.deepStrictEqual(require('../lib/perf').checkSweep(sw2, d2), []);
  // Each generator stays in its channel.
  const inCh = (g, base) => { const p = d2.modules[g].params; return Number(p.address) >= base && Number(p.address) + Number(p.size) <= base + 0x20000000; };
  assert.ok(inCh('display', 0) && inCh('dma', 0x20000000) && inCh('cpu', 0x20000000));
  // Two DDRs, each behind its own MAU with QoS; every example file is copied by Create Performance Example.
  const cat = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'catalog', 'qbox-catalog.json'), 'utf8'));
  const d3 = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'examples', 'perf', 'mau-2ddr.platform.json'), 'utf8'));
  const a3 = core.analyze(d3, { catalog: cat });
  assert.deepStrictEqual(a3.problems, []);
  assert.deepStrictEqual(a3.memoryMap.map((r) => [r.instance, Number(r.start), Number(r.size)]), [['ddr0', 0, 0x80000000], ['ddr1', 0x80000000, 0x60000000]]);
  assert.deepStrictEqual(a3.buses.map((b) => b.name || b).sort(), ['mau0', 'mau1']);
  const sw3 = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'examples', 'perf', 'mau-qos.perfsweep.json'), 'utf8'));
  assert.deepStrictEqual(require('../lib/perf').checkSweep(sw3, d3), []);
  const ext = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  const listed = JSON.parse(/const PERF_EXAMPLES = (\[[^\]]*\]);/.exec(ext)[1].replace(/'/g, '"'));
  assert.deepStrictEqual(listed.slice().sort(), fs.readdirSync(path.join(__dirname, '..', 'examples', 'perf')).filter((f) => f.endsWith('.json')).sort());
  // The Ubuntu example: routers and buses are the same.
  const u = core.analyze(load());
  assert.deepStrictEqual(u.routers, u.buses);
  // The generated Lua loads the perf library for every perf module.
  const lua = core.generate(d);
  assert.strictEqual((lua.match(/dylib_path = "perf"/g) || []).length, 6);
  // The schema accepts the example and the sweep.
  const Ajv = (() => { try { return require('ajv'); } catch (e) { return null; } })();
  if (Ajv) {
    const ajv = new Ajv({ allErrors: true, strict: false });
    assert.ok(ajv.validate(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'schemas', 'qbox-platform.schema.json'), 'utf8')), d), JSON.stringify(ajv.errors));
    const sw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'examples', 'perf', 'cpu-outstanding.perfsweep.json'), 'utf8'));
    assert.ok(ajv.validate(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'schemas', 'vp-perfsweep.schema.json'), 'utf8')), sw), JSON.stringify(ajv.errors));
  }
});

const PERF_STATS = {
  format: 'vp-perf-stats', version: 1, complete: true, simTimeNs: 1000000,
  initiators: [
    { name: 'platform.cpu', label: 'cpu', issued: 10, reads: 7, writes: 3, bytes: 640, bandwidthMBps: 812.5, latencyNs: { count: 10, mean: 95, p50: 90, p99: 180, max: 200, histogram: { upperNs: [100, 200], counts: [8, 2] } }, done: true },
    { name: 'platform.sub.display', label: 'display', issued: 4, reads: 4, writes: 0, bytes: 256, bandwidthMBps: 3000, latencyNs: { count: 4, mean: 50, p50: 50, p99: 60, max: 60 }, done: true },
  ],
  buses: [{ name: 'platform.bus', requestBusyNs: 10, responseBusyNs: 20, requestUtilization: 0.01, responseUtilization: 0.02, waitNs: { cpu: { count: 10, mean: 3, p99: 9 } } }],
  memories: [{ name: 'platform.ddr', reads: 11, writes: 3, bytes: 896, rowHits: 6, rowMisses: 4, rowConflicts: 4, rowHitRate: 0.43, refreshes: 128, dataBusyNs: 50, dataBusUtilization: 0.25, bandwidthMBps: 0.9, serviceNs: { count: 14, mean: 40, p99: 70 } }],
};

test('perf: statistics, metric paths, sweeps, checks and CSV', () => {
  const perf = require('../lib/perf');
  assert.throws(() => perf.parseStats('{"a":1}'), /not a VP Studio perf statistics file/);
  const st = perf.parseStats(JSON.stringify(PERF_STATS));
  assert.strictEqual(perf.metric(st, 'initiators.cpu.latencyNs.p99'), 180);
  assert.strictEqual(perf.metric(st, 'initiator.display.bandwidthMBps'), 3000);       // singular section name
  assert.strictEqual(perf.metric(st, 'initiators.sub.display.bandwidthMBps'), 3000);  // a name with a dot
  assert.strictEqual(perf.metric(st, 'memories.ddr.rowHitRate'), 0.43);
  assert.strictEqual(perf.metric(st, 'buses.bus.waitNs.cpu.p99'), 9);
  assert.strictEqual(perf.metric(st, 'simTimeNs'), 1000000);
  assert.strictEqual(perf.metric(st, 'initiators.gpu.bandwidthMBps'), undefined);
  assert.strictEqual(perf.metric(st, 'initiators.cpu.latencyNs'), undefined); // not a number
  const all = perf.listMetrics(st);
  assert.ok(all.includes('initiators.cpu.latencyNs.p99') && all.includes('memories.ddr.dataBusUtilization') && all.includes('buses.bus.waitNs.cpu.p99'));
  assert.ok(!all.some((m) => /histogram|\.name$|\.label$/.test(m)));
  const sm = perf.summary(st);
  assert.deepStrictEqual(sm.initiators.map((g) => [g.label, g.p99]), [['cpu', 180], ['display', 60]]);
  assert.deepStrictEqual(sm.memories[0].label, 'ddr');
  assert.match(perf.runCsv(st), /^kind,name,.*\ninitiator,cpu,7,3,640,812\.5,95,90,180,200,,\n/);

  // Sweeps.
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'examples', 'perf', 'ddr-contention.platform.json'), 'utf8'));
  const spec = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'examples', 'perf', 'cpu-outstanding.perfsweep.json'), 'utf8'));
  assert.deepStrictEqual(perf.checkSweep(spec, d), []);
  assert.strictEqual(perf.runCount(spec), 12);
  const runs = perf.expandSweep(spec);
  assert.strictEqual(runs.length, 12);
  assert.deepStrictEqual(runs[0].values, { 'ddr.scheduler': 'fr_fcfs', 'cpu.max_outstanding': 1 });
  assert.deepStrictEqual(runs[10].overrides, [{ instance: 'ddr', param: 'scheduler', value: 'fcfs' }, { instance: 'cpu', param: 'max_outstanding', value: 16 }]);
  assert.strictEqual(perf.runLabel(runs[10].values), 'ddr.scheduler=fcfs, cpu.max_outstanding=16');
  assert.deepStrictEqual(perf.splitParam('periph.dma.rate_mbps'), { instance: 'periph.dma', param: 'rate_mbps' });
  assert.throws(() => perf.splitParam('rate'), /<module>\.<parameter>/);
  const bad = perf.checkSweep({ sweep: [{ param: 'gpu.x', values: [] }], checks: [{ metric: 'a' }, { metric: 'b', min: 1, where: { 'z.y': 1 } }] }, d);
  assert.ok(bad.some((p) => /no module gpu/.test(p)) && bad.some((p) => /non-empty list/.test(p)) && bad.some((p) => /give "min", "max"/.test(p)) && bad.some((p) => /does not vary/.test(p)));
  assert.match(perf.checkSweep({}, d)[0], /"sweep" must list/);

  // Lua for one run: the overrides and the statistics file; a perf_stats is added when there is none.
  const lua = perf.runLua(d, { overrides: runs[10].overrides, outFile: '/tmp/x/run-9.json' });
  assert.ok(lua.includes('platform["ddr"]["scheduler"] = "fcfs"') && lua.includes('platform["cpu"]["max_outstanding"] = 16'));
  assert.ok(lua.includes('platform["stats"]["output"] = "/tmp/x/run-9.json"') && lua.includes('platform["stats"]["stop_when_done"] = true'));
  const noStats = JSON.parse(JSON.stringify(d));
  delete noStats.modules.stats;
  assert.match(perf.runLua(noStats, { outFile: '/o.json' }), /platform\["perf_stats"\] = \{ moduletype = "perf_stats"; dylib_path = "perf"; output = "\/o\.json"; stop_when_done = true \}/);

  // Checks and CSV over results.
  const results = {
    sweep: [{ param: 'bus.arbitration', values: ['round_robin', 'priority'] }, { param: 'cpu.max_outstanding', values: [1, 2, 4] }],
    runs: [
      { index: 0, values: { 'bus.arbitration': 'priority', 'cpu.max_outstanding': 1 }, label: 'p1', ok: true, metrics: { 'initiators.display.bandwidthMBps': 2950.5 } },
      { index: 1, values: { 'bus.arbitration': 'priority', 'cpu.max_outstanding': 2 }, label: 'p2', ok: true, metrics: { 'initiators.display.bandwidthMBps': 2800 } },
      { index: 2, values: { 'bus.arbitration': 'round_robin', 'cpu.max_outstanding': 2 }, label: 'r2', ok: true, metrics: { 'initiators.display.bandwidthMBps': 100 } },
      { index: 3, values: { 'bus.arbitration': 'priority', 'cpu.max_outstanding': 4 }, label: 'p4', ok: false, error: 'timed out', metrics: {} },
    ],
  };
  const cr = perf.evaluateChecks(results, [{ metric: 'initiators.display.bandwidthMBps', min: 2900, where: { 'bus.arbitration': 'priority' } }]);
  assert.deepStrictEqual(cr.map((c) => c.ok), [true, false, false]); // round_robin is skipped by "where"
  assert.match(cr[1].message, /2800 \(expected >= 2900\)/);
  assert.match(cr[2].message, /run failed: timed out/);
  const csv = perf.resultsCsv(results).split('\n');
  assert.strictEqual(csv[0], 'run,bus.arbitration,cpu.max_outstanding,ok,initiators.display.bandwidthMBps,error');
  assert.strictEqual(csv[4], '3,priority,4,false,,timed out');
  assert.strictEqual(perf.fmt(2950.5), '2951');
  assert.strictEqual(perf.fmt(0.4321), '0.432');
  assert.match(perf.resultsDir('/w/a.perfsweep.json', new Date('2026-11-21T08:09:10Z')), /\/w\/perf-results\/a-20261121-080910$/);
  const tpl = perf.sweepTemplate(d, 'ddr-contention.platform.json');
  assert.deepStrictEqual(tpl.sweep.map((s) => s.param), ['cpu.max_outstanding', 'bus.arbitration']);
  assert.deepStrictEqual(perf.checkSweep(tpl, d), []);
});

test('perf: at_bus QoS per master (masters): parsing, checks, sweeps and statistics', () => {
  const qos = require('../lib/qos');
  const perf = require('../lib/perf');
  const core = require('../lib/core');
  // The text perf.so reads.
  const p = qos.parseMasters('display: priority=3 min_mbps=6000;\n cpu@ddr0: max_mbps=8000, outstanding=8 ; ');
  assert.deepStrictEqual(p.errors, []);
  assert.deepStrictEqual(p.entries, [
    { name: 'display', settings: { priority: 3, min_mbps: 6000 } },
    { name: 'cpu@ddr0', settings: { max_mbps: 8000, outstanding: 8 } }]);
  assert.strictEqual(qos.formatMasters(p.entries), 'display: priority=3 min_mbps=6000; cpu@ddr0: max_mbps=8000 outstanding=8');
  assert.deepStrictEqual(qos.parseMasters('a: speed=1; b min=2; c: max_mbps=x; d: outstanding=-1').errors, [
    'a: unknown key speed (priority, max_mbps, min_mbps, outstanding, window_ns)', '"b min=2" is not <master>: key=value ...',
    'c: max_mbps needs a number, got "x"', 'd: outstanding cannot be negative']);
  assert.strictEqual(qos.setMaster('display: priority=3', 'display', 'min_mbps', 6000), 'display: priority=3 min_mbps=6000');
  assert.strictEqual(qos.setMaster('display: priority=3', 'cpu', 'max_mbps', '7000'), 'display: priority=3; cpu: max_mbps=7000');
  assert.throws(() => qos.setMaster('', 'cpu', 'speed', 1), /unknown QoS key speed/);
  assert.deepStrictEqual(qos.qosPath('mau0.masters.display.min_mbps'), { instance: 'mau0', master: 'display', key: 'min_mbps' });
  assert.deepStrictEqual(qos.qosPath('soc.mau0.masters.cpu@ddr0.priority'), { instance: 'soc.mau0', master: 'cpu@ddr0', key: 'priority' });
  assert.strictEqual(qos.qosPath('mau0.masters'), null);
  assert.strictEqual(qos.qosPath('mau0.masters.display.speed'), null);
  assert.ok(qos.matches('dma', 'periph.dma', 'dma') && qos.matches('periph.dma', 'periph.dma', 'x') && !qos.matches('ma', 'periph.dma', 'x'));

  // Two DDRs behind their own MAU (at_bus + dram_ctrl).
  const gen = (address, bus, extra) => ({ type: 'traffic_gen', dylib: 'perf', params: Object.assign({ address, count: 0, duration_ns: 1000 }, extra), ports: { initiator_socket: { bind: bus + '.target_socket' } } });
  const doc = { schemaVersion: '0.2', name: 'mau', platform: { moduletype: 'Container' }, modules: {
    display: gen('0x0', 'mau0'), cpu_ddr0: gen('0x40000000', 'mau0', { label: 'cpu@ddr0' }), dma: gen('0x80000000', 'mau1'),
    mau0: { type: 'at_bus', dylib: 'perf', params: { arbitration: 'priority', masters: 'display: min_mbps=6000; cpu@ddr0: max_mbps=7000' } },
    mau1: { type: 'at_bus', dylib: 'perf', params: {} },
    ddr0: { type: 'dram_ctrl', dylib: 'perf', params: { qos: true }, ports: { target_socket: { address: '0x0', size: '0x80000000', bind: 'mau0.initiator_socket' } } },
    ddr1: { type: 'dram_ctrl', dylib: 'perf', ports: { target_socket: { address: '0x80000000', size: '0x60000000', bind: 'mau1.initiator_socket' } } },
  } };
  const cat = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'catalog', 'qbox-catalog.json'), 'utf8'));
  assert.deepStrictEqual(core.analyze(doc, { catalog: cat }).problems, []);
  const bad = JSON.parse(JSON.stringify(doc));
  bad.modules.mau0.params = { masters: 'display: priority=2 bogus=1; dma: max_mbps=1; cpu_ddr0: outstanding=4; cpu@ddr0: priority=1' };
  assert.deepStrictEqual(core.analyze(bad).problems.map((x) => `${x.severity} ${x.module}: ${x.message}`), [
    'error mau0: mau0.masters: display: unknown key bogus (priority, max_mbps, min_mbps, outstanding, window_ns)',
    'warning mau0: mau0.masters: display has a priority, which is used only with "arbitration": "priority"',
    'warning mau0: mau0.masters: dma is not a traffic_gen whose accesses reach mau0 (display, cpu_ddr0); its settings are not used',
    'warning mau0: mau0.masters: cpu@ddr0 has a priority, which is used only with "arbitration": "priority"',
    'warning mau0: mau0.masters: cpu_ddr0 matches cpu_ddr0 and cpu@ddr0; only the first is used']);

  // Sweeping one QoS value: folded into the bus's masters text, starting from the platform's.
  const spec = { platform: 'x', sweep: [{ param: 'mau0.masters.cpu@ddr0.max_mbps', values: [4000, 8000] }, { param: 'mau0.masters.dma2.priority', values: [1] }] };
  assert.deepStrictEqual(perf.checkSweep(spec, doc), []);
  assert.deepStrictEqual(perf.checkSweep({ platform: 'x', sweep: [{ param: 'ddr0.masters.display.priority', values: [1] }, { param: 'nope.masters.a.priority', values: [1] }] }, doc), [
    'sweep[0]: ddr0 is a dram_ctrl; QoS settings (masters) belong to an at_bus', 'sweep[1]: the platform has no module nope']);
  const run = perf.expandSweep(spec)[1];
  assert.deepStrictEqual(perf.foldQos(doc, run.overrides), [
    { instance: 'mau0', param: 'masters', value: 'display: min_mbps=6000; cpu@ddr0: max_mbps=8000; dma2: priority=1' }]);
  // vp-run --param: a plain masters text first, then one value; other parameters pass through.
  assert.deepStrictEqual(perf.foldQos(doc, [{ instance: 'mau0', param: 'masters', value: 'display: priority=1' }, { instance: 'mau0.masters.display', param: 'max_mbps', value: 100 }, { instance: 'ddr0', param: 'qos', value: false }]), [
    { instance: 'mau0', param: 'masters', value: 'display: priority=1 max_mbps=100' }, { instance: 'ddr0', param: 'qos', value: false }]);
  const lua = perf.runLua(doc, { overrides: run.overrides, outFile: '/tmp/s.json' });
  assert.ok(lua.includes('platform["mau0"]["masters"] = "display: min_mbps=6000; cpu@ddr0: max_mbps=8000; dma2: priority=1"'), lua);

  // Statistics from perf 1.1.0 carry each master's bandwidth, settings and effect per bus.
  const stats = { format: 'vp-perf-stats', version: 1, complete: true, simTimeNs: 1000, initiators: [], memories: [], buses: [{
    name: 'platform.mau0', requestUtilization: 0.4, responseUtilization: 0.97, waitNs: { display: { count: 2, mean: 1, p99: 3 } },
    masters: { display: { bytes: 128, bandwidthMBps: 6000, grants: 2, urgentGrants: 2, limitedGrants: 0, limitWaitNs: 0, responseWaitNs: { count: 2, mean: 5, p99: 53.75 }, qos: 'min_mbps=6000' } } }] };
  assert.deepStrictEqual(perf.summary(stats).buses[0].masters, [{ label: 'display', qos: 'min_mbps=6000', bandwidthMBps: 6000, grants: 2, urgentGrants: 2, limitedGrants: 0, limitWaitNs: 0, waitP99: 3, responseWaitP99: 53.75 }]);
  assert.strictEqual(perf.metric(stats, 'buses.mau0.masters.display.urgentGrants'), 2);
  assert.strictEqual(perf.metric(stats, 'buses.mau0.masters.display.responseWaitNs.p99'), 53.75);
  assert.ok(perf.listMetrics(stats).includes('buses.mau0.masters.display.bandwidthMBps'));
});

test('perf: a system bus (crossbar) in front of two MAUs: relative_addresses, QoS behind a bus, data flow, statistics', () => {
  const core = require('../lib/core');
  const perf = require('../lib/perf');
  const dataflow = require('../lib/dataflow');
  const cat = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'catalog', 'qbox-catalog.json'), 'utf8'));
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'examples', 'perf', 'mau-sysbus.platform.json'), 'utf8'));
  const a = core.analyze(d, { catalog: cat });
  assert.deepStrictEqual(a.problems, []);
  assert.deepStrictEqual(a.buses.slice().sort(), ['mau0', 'mau1', 'sysbus']);
  const sw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'examples', 'perf', 'mau-sysbus.perfsweep.json'), 'utf8'));
  assert.deepStrictEqual(perf.checkSweep(sw, d), []);
  // The MAUs decode the same absolute addresses: the system bus passes them on unchanged.
  const lua = core.generate(d);
  assert.ok(lua.includes('target_socket = {address = 0x80000000, size = 0x60000000, relative_addresses = false, bind = "&sysbus.initiator_socket"};'), lua);
  assert.ok(lua.includes('topology = "crossbar";'));
  // The Ubuntu example has no such port: its Lua is unchanged (no relative_addresses anywhere).
  assert.ok(!core.generate(load()).includes('relative_addresses'));
  // Data flow from the CPU: DDR1 at its own address behind MAU1, not at 0x8000_0000 + 0x8000_0000.
  const reach = dataflow.reachFrom(a, 'cpu')[0].targets.map((t) => [t.instance, t.depth, '0x' + t.start.toString(16)]);
  assert.deepStrictEqual(reach, [['mau0', 0, '0x0'], ['ddr0', 1, '0x0'], ['mau1', 0, '0x80000000'], ['ddr1', 1, '0x80000000']]);
  const by = dataflow.reachedBy(a, 'ddr1').map((r) => [r.bus, '0x' + r.start.toString(16), r.path.join('>'), r.initiators.map((i) => i.base).join(',')]);
  assert.deepStrictEqual(by, [['sysbus', '0x80000000', 'sysbus>mau1', 'display,cpu,dma']]);
  // With relative addresses (the default) the window start is added, as on QBox's router.
  const rel = JSON.parse(JSON.stringify(d));
  delete rel.modules.mau1.ports.target_socket.relative_addresses;
  assert.strictEqual(dataflow.reachFrom(core.analyze(rel), 'cpu')[0].targets.find((t) => t.instance === 'ddr1').start, 0x100000000n);
  // QoS on a MAU names the masters behind the system bus.
  const bad = JSON.parse(JSON.stringify(d));
  bad.modules.mau0.params.masters = 'cpu: priority=3; dma: min_mbps=1';
  // Every master on the system bus counts as reaching each MAU behind it (the check does not decode addresses).
  assert.deepStrictEqual(core.analyze(bad).problems, []);
  bad.modules.mau0.params.masters = 'cpu: priority=3; gpu: min_mbps=1';
  assert.deepStrictEqual(core.analyze(bad).problems.map((x) => x.message), [
    'mau0.masters: gpu is not a traffic_gen whose accesses reach mau0 (display, cpu, dma); its settings are not used']);
  // The schema takes relative_addresses only with an address.
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'schemas', 'qbox-platform.schema.json'), 'utf8'));
  assert.strictEqual(schema.$defs.port.properties.relative_addresses.type, 'boolean');
  assert.deepStrictEqual(schema.$defs.port.dependentRequired.relative_addresses, ['address']);
  // Statistics of a crossbar: topology and each channel.
  const stats = { format: 'vp-perf-stats', version: 1, complete: true, simTimeNs: 1000, initiators: [], memories: [], buses: [{
    name: 'platform.sysbus', topology: 'crossbar', requestUtilization: 0.65, responseUtilization: 0.89, waitNs: {}, masters: {},
    channels: { request: { 'to mau0': 0.35, 'to mau1': 0.65 }, response: { 'to cpu': 0.89, 'to display': 0.47 } } }] };
  const b = perf.summary(stats).buses[0];
  assert.strictEqual(b.topology, 'crossbar');
  assert.deepStrictEqual(b.channels.request, { 'to mau0': 0.35, 'to mau1': 0.65 });
  assert.strictEqual(perf.metric(stats, 'buses.sysbus.channels.response.to cpu'), 0.89);
  assert.strictEqual(perf.summary({ initiators: [], memories: [], buses: [{ name: 'platform.bus', requestUtilization: 0.1, responseUtilization: 0.2 }] }).buses[0].topology, 'shared');
  // Failed accesses (perf 1.2.0) are counted apart and fail the run: a missing relative_addresses made them look like bandwidth.
  const lat = { count: 1, mean: 1, p50: 1, p99: 1, max: 1 };
  const failed = { initiators: [
    { name: 'platform.cpu', label: 'cpu', reads: 17153, writes: 7327, errors: 24098, firstError: 'access at 0x959f1e40 failed: TLM_ADDRESS_ERROR_RESPONSE', latencyNs: lat },
    { name: 'platform.display', label: 'display', reads: 10, writes: 0, errors: 0, latencyNs: lat }], buses: [], memories: [] };
  assert.deepStrictEqual(perf.failures(failed), ['cpu: 24098 of 48578 accesses failed (access at 0x959f1e40 failed: TLM_ADDRESS_ERROR_RESPONSE)']);
  assert.deepStrictEqual(perf.summary(failed).initiators.map((g) => g.errors), [24098, 0]);
  assert.deepStrictEqual(perf.failures({ initiators: [{ name: 'platform.x', reads: 1, writes: 0, latencyNs: lat }] }), []);
});

test('perf: the Performance panel has no style attributes and its script compiles', () => {
  const pv = require('../lib/perfview');
  const html = pv.render('N3', 'x', 'Performance: t');
  assert.ok(!/<[a-z]+ [^>]*style="/.test(html.replace(/<style[\s\S]*?<\/style>/, '')));
  const scripts = [...html.matchAll(/<script nonce="N3">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.strictEqual(scripts.length, 1);
  assert.doesNotThrow(() => new Function(scripts[0]));
  for (const id of ['rerun', 'stop', 'csv', 'reveal', 'stats', 'body', 'tip', 'state-t']) assert.ok(html.includes(`id="${id}"`), id);
});

testAsync('perf: a sweep runs every combination with a stand-in simulator and keeps going after a failed run', async () => {
  const perf = require('../lib/perf');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-perf-'));
  // The stand-in reads the Lua, writes statistics where it is told, bandwidth = 100 x max_outstanding;
  // max_outstanding 3 "crashes" without statistics.
  const js = path.join(dir, 'fake.js');
  fs.writeFileSync(js, `const fs=require('fs');const lua=fs.readFileSync(process.argv[3],'utf8');
const out=/\\["output"\\] = "([^"]+)"/.exec(lua)[1];const n=Number((/\\["max_outstanding"\\] = (\\d+)/.exec(lua)||[0,1])[1]);
if(n===3){console.log('boom');process.exit(7)}
fs.writeFileSync(out,JSON.stringify({format:'vp-perf-stats',version:1,complete:true,simTimeNs:1000,initiators:[{name:'platform.cpu',label:'cpu',reads:1,writes:0,bytes:64,bandwidthMBps:100*n,latencyNs:{count:1,mean:10,p50:10,p99:10,max:10}}],buses:[],memories:[]}));console.log('perf: done');`);
  const exe = path.join(dir, 'fake-sim');
  fs.writeFileSync(exe, `#!/bin/sh\nexec "$VP_TEST_NODE" "${js}" "$@"\n`, { mode: 0o755 });
  process.env.VP_TEST_NODE = process.execPath;
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'examples', 'perf', 'ddr-contention.platform.json'), 'utf8'));
  const platformFile = path.join(dir, 'p.platform.json');
  fs.writeFileSync(platformFile, JSON.stringify(d));
  const spec = { platform: 'p.platform.json', sweep: [{ param: 'cpu.max_outstanding', values: [1, 2, 3, 4] }], metrics: ['initiators.cpu.bandwidthMBps'], checks: [{ metric: 'initiators.cpu.bandwidthMBps', min: 150 }] };
  const seen = [];
  const r = await perf.runSweep({ spec, doc: d, platformFile, exe, cwd: dir, outDir: path.join(dir, 'out'), jobs: 2, onProgress: (p) => seen.push(p.done) });
  assert.deepStrictEqual(seen, [1, 2, 3, 4]);
  assert.deepStrictEqual(r.runs.map((x) => [x.index, x.ok, x.metrics['initiators.cpu.bandwidthMBps']]), [[0, true, 100], [1, true, 200], [2, false, undefined], [3, true, 400]]);
  assert.match(r.runs[2].error, /no statistics were written \(exit 7\): boom/);
  assert.deepStrictEqual(r.checkResults.map((c) => c.ok), [false, true, false, true]);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'out', 'results.json'), 'utf8'));
  assert.strictEqual(saved.format, 'vp-perf-sweep');
  assert.ok(fs.existsSync(path.join(dir, 'out', 'results.csv')) && fs.existsSync(path.join(dir, 'out', 'run-3.json')));
  // The Lua files next to the platform are removed.
  assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.lua')), []);
  // One experiment; a timeout stops the simulator.
  const one = await perf.runExperiment({ doc: d, platformFile, exe, cwd: dir, outFile: path.join(dir, 'one.json') });
  assert.ok(one.ok && one.stats.initiators[0].bandwidthMBps === 100, JSON.stringify(one.error)); // no override: the stand-in's default
  const hang = path.join(dir, 'hang-sim');
  fs.writeFileSync(hang, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
  const t = await perf.runExperiment({ doc: d, platformFile, exe: hang, cwd: dir, outFile: path.join(dir, 'h.json'), timeoutMs: 300 });
  assert.ok(!t.ok && /timed out/.test(t.error));
  // vp-run --perf-sweep with JUnit: a failed check exits with 1.
  const vprun = require('../bin/vp-run.js');
  const specFile = path.join(dir, 's.perfsweep.json');
  fs.writeFileSync(specFile, JSON.stringify(spec));
  fs.writeFileSync(path.join(dir, 'perf.so'), '');
  const o = vprun.parseArgs(['--perf-sweep', specFile, '--exe', exe, '--qbox', dir, '--out', path.join(dir, 'o2'), '--junit', path.join(dir, 'j.xml'), '--quiet']);
  const logs = [];
  const code = await vprun.perfSweepCmd(o, (x) => logs.push(x));
  assert.strictEqual(code, vprun.EXIT.FAIL, logs.join('\n'));
  const xml = fs.readFileSync(path.join(dir, 'j.xml'), 'utf8');
  assert.match(xml, /tests="5" failures="3"/); // 4 checks (2 fail) + the failed run
  // --param reaches perf runs: max_outstanding 3 makes the stand-in fail.
  const po = vprun.parseArgs(['--perf', '--exe', exe, '--qbox', dir, '--out', path.join(dir, 'p3.json'), '--param', 'cpu.max_outstanding=3', '--quiet', platformFile]);
  assert.strictEqual(await vprun.perfCmd(po, () => {}), vprun.EXIT.SIM);
  const po2 = vprun.parseArgs(['--perf', '--exe', exe, '--qbox', dir, '--out', path.join(dir, 'p2.json'), '--param', 'cpu.max_outstanding=2', '--quiet', platformFile]);
  assert.strictEqual(await vprun.perfCmd(po2, () => {}), vprun.EXIT.PASS);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'p2.json'), 'utf8')).initiators[0].bandwidthMBps, 200);
  assert.throws(() => vprun.parseArgs(['--perf-sweep', specFile, 'p.platform.json']), /give no platform file/);
  assert.throws(() => vprun.parseArgs(['--perf', '--expect', 'x', 'p.platform.json']), /takes no steps/);
  fs.rmSync(dir, { recursive: true, force: true });
});

(async () => {
  for (const [name, fn] of asyncTests) {
    await fn();
    passed++;
    console.log('ok   ' + name);
  }
  console.log(`\n${passed} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
