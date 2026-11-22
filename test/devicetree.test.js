'use strict';
// Run with: node test/devicetree.test.js (every file: npm test)
const { test, testAsync } = require('./harness');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const core = require('../lib/core');
const view = require('../lib/view');
const os = require('os');
const { load, workspace } = require('./helpers');

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
