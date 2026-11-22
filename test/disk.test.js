'use strict';
// Run with: node test/disk.test.js (every file: npm test)
const { test } = require('./harness');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const disklock = require('../lib/sim/disklock');
const { load } = require('./helpers');

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

test('disk space: ext4 superblock free space and the low-space check', () => {
  const os = require('os');
  const diskspace = require('../lib/sim/diskspace');
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
