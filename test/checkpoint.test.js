'use strict';
// Run with: node test/checkpoint.test.js (every file: npm test)
const { test, testAsync } = require('./harness');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

test('checkpoint: what a checkpoint of the Ubuntu platform holds', () => {
  const ck = require('../lib/sim/checkpoint');
  const reg = require('../lib/analysis/registers');
  const doc = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'templates', 'ubuntu-aarch64.platform.json'), 'utf8'));
  const cat = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'catalog', 'qbox-catalog.json'), 'utf8'));
  const top = '/plat';
  const p = ck.plan(doc, { catalog: cat, descs: reg.loadDir(path.join(__dirname, '..', 'registers')).descs, buses: ['router'], topDir: top });
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
  assert.deepStrictEqual(ck.plan(d2, { catalog: cat, topDir: top, descs: reg.loadDir(path.join(__dirname, '..', 'registers')).descs, buses: ['router'] }).unsaved, [{ instance: 'mystery_0', type: 'my_model' }]);
  // Without register descriptions the PL011 has no way to be saved either.
  assert.deepStrictEqual(ck.plan(doc, { catalog: cat, topDir: top }).unsaved, [{ instance: 'pl011_uart_0', type: 'Pl011' }]);
});

testAsync('checkpoint: save refuses a disk in a snapshot overlay, and runs the guest on afterwards', async () => {
  const ck = require('../lib/sim/checkpoint');
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
  const ck = require('../lib/sim/checkpoint');
  const doc = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'templates', 'ubuntu-aarch64.platform.json'), 'utf8'));
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
