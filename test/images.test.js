'use strict';
// Run with: node test/images.test.js (every file: npm test)
const { test } = require('./harness');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const core = require('../lib/platform/core');
const view = require('../lib/webview/view');
const os = require('os');
const images = require('../lib/platform/images');
const { load, workspace, catalog } = require('./helpers');

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

test('images: the files a loader would fail on at start', () => {
  const os = require('os');
  const images = require('../lib/platform/images');
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
