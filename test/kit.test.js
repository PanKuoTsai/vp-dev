'use strict';
// Run with: node test/kit.test.js (every file: npm test)
const { test, testAsync } = require('./harness');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

test('kit file names: one .tar.gz, never doubled by a save dialog', () => {
  const kit = require('../lib/setup/kit');
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

testAsync('kit: tar archives with long names, read back and by GNU tar', async () => {
  const tar = require('../lib/setup/tar');
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
  const kit = require('../lib/setup/kit');
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
