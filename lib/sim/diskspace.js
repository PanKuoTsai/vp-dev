'use strict';
// Free space of a platform's writable ext2/3/4 disk images, read from the file
// system's superblock without mounting or booting anything. A guest whose root
// file system is full still boots, but services that write state (systemd's
// journal, name resolution, time sync) fail. Each unclean stop of the
// simulator leaves the journal it was writing behind, so the space runs out
// over many runs. No VS Code dependency.

const fs = require('fs');

const EXT_MAGIC = 0xef53;

/**
 * The ext2/3/4 file system in an image file (no partition table), or null:
 * { blockSize, blocks, free, reserved, available, size } in bytes except the
 * block counts. available leaves out the blocks reserved for root, which
 * services running as other users cannot use. The counts are those of the
 * last clean unmount, so they are approximate after an unclean stop.
 */
function readExt(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const sb = Buffer.alloc(1024);
    if (fs.readSync(fd, sb, 0, 1024, 1024) < 1024) return null;
    if (sb.readUInt16LE(0x38) !== EXT_MAGIC) return null;
    const is64 = (sb.readUInt32LE(0x60) & 0x80) !== 0; // INCOMPAT_64BIT: high halves are valid
    const count = (lo, hi) => BigInt(sb.readUInt32LE(lo)) + (is64 ? BigInt(sb.readUInt32LE(hi)) << 32n : 0n);
    const blockSize = 1024 << sb.readUInt32LE(0x18);
    const blocks = count(0x04, 0x150);
    const reserved = count(0x08, 0x154);
    const free = count(0x0c, 0x158);
    const avail = free > reserved ? free - reserved : 0n;
    return {
      blockSize,
      blocks: Number(blocks),
      free: Number(free),
      reserved: Number(reserved),
      size: Number(blocks) * blockSize,
      available: Number(avail) * blockSize,
    };
  } catch (e) {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Below this, a guest's services may fail to start: 5% of the file system, at most 256 MiB. */
const lowThreshold = (size) => Math.min(size * 0.05, 256 * 1024 * 1024);

const isLow = (info) => !!info && info.available < lowThreshold(info.size);

/** "16 MB", "1.2 GB" */
function fmtBytes(n) {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(n / 1024 ** 2)} MB`;
}

/**
 * Writable disk images (as found by disklock.diskImages) whose file system is
 * almost full: [{ module, file, available, size, threshold }].
 */
function lowImages(images) {
  const out = [];
  for (const img of images) {
    if (!img.writable) continue;
    const info = readExt(img.file);
    if (isLow(info)) out.push({ module: img.module, file: img.file, available: info.available, size: info.size, threshold: lowThreshold(info.size) });
  }
  return out;
}

module.exports = { readExt, isLow, lowThreshold, lowImages, fmtBytes };
