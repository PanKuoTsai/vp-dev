'use strict';
// Minimal tar (POSIX ustar with pax headers for long names and large sizes),
// streamed, so a 4 GB disk image never sits in memory. Only regular files and
// folders: enough for delivery kits (lib/kit.js), readable by GNU and BSD tar.
// No VS Code dependency.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { Readable, Writable } = require('stream');

/** Returned by read()'s onEntry to stop reading (the rest of the archive is not read). */
const STOP = Symbol('stop');
class Stopped extends Error {}

const BLOCK = 512;
const MAX_OCTAL_SIZE = 0o77777777777; // 11 octal digits: 8 GiB - 1

function octal(n, width) {
  return n.toString(8).padStart(width - 1, '0') + '\0';
}

/** A 512-byte header. name/prefix must already fit. */
function rawHeader({ name, prefix = '', size = 0, type = '0', mode = 0o644, mtime = 0 }) {
  const b = Buffer.alloc(BLOCK, 0);
  b.write(name, 0, 100, 'utf8');
  b.write(octal(mode, 8), 100, 'ascii');
  b.write(octal(0, 8), 108, 'ascii');
  b.write(octal(0, 8), 116, 'ascii');
  b.write(octal(size, 12), 124, 'ascii');
  b.write(octal(Math.floor(mtime), 12), 136, 'ascii');
  b.fill(' ', 148, 156);
  b.write(type, 156, 'ascii');
  b.write('ustar\0', 257, 'ascii');
  b.write('00', 263, 'ascii');
  b.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += b[i];
  b.write(octal(sum, 7) + ' ', 148, 'ascii');
  return b;
}

/** Split a path into ustar name (<=100 bytes) and prefix (<=155 bytes), or null. */
function splitName(p) {
  if (Buffer.byteLength(p) <= 100) return { name: p, prefix: '' };
  for (let i = p.lastIndexOf('/'); i > 0; i = p.lastIndexOf('/', i - 1)) {
    const prefix = p.slice(0, i);
    const name = p.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100 && name) return { name, prefix };
  }
  return null;
}

/** A pax record "len key=value\n" (len counts itself). */
function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  let len = Buffer.byteLength(body);
  let digits = String(len).length;
  while (String(len + digits).length !== digits) digits++;
  return `${len + digits}${body}`;
}

/** Header block(s) for an entry: a pax header first when the path or size does not fit. */
function headerBlocks(entryPath, size, type, mode, mtime) {
  const split = splitName(entryPath);
  const pax = [];
  if (!split) pax.push(paxRecord('path', entryPath));
  if (size > MAX_OCTAL_SIZE) pax.push(paxRecord('size', String(size)));
  const out = [];
  if (pax.length) {
    const data = Buffer.from(pax.join(''), 'utf8');
    out.push(rawHeader({ name: 'PaxHeader', size: data.length, type: 'x', mtime }), data, padding(data.length));
  }
  const s = split || { name: entryPath.slice(-100), prefix: '' };
  out.push(rawHeader({ name: s.name, prefix: s.prefix, size: size > MAX_OCTAL_SIZE ? 0 : size, type, mode, mtime }));
  return out;
}

const padding = (n) => Buffer.alloc((BLOCK - (n % BLOCK)) % BLOCK, 0);

/** Entry path as stored: forward slashes, no leading "./" or "/", no "..". Throws. */
function cleanPath(p) {
  const parts = String(p).replace(/\\/g, '/').split('/').filter((x) => x && x !== '.');
  if (!parts.length || parts.includes('..')) throw new Error(`unsafe path in archive: ${p}`);
  return parts.join('/');
}

/**
 * Write a .tar.gz (or .tar when gzip is false). entries: [{ path, file } |
 * { path, data } | { path, dir: true }], in order. data may be a function of
 * the files written so far (for a checksum list at the end). onProgress(bytesDone,
 * bytesTotal). Resolves { files: [{ path, size, sha256 }] } with the sha256 of
 * each file's content, computed while it is written.
 */
async function write(outFile, entries, { gzip = true, level = 6, onProgress, signal } = {}) {
  const sizes = entries.map((e) => (e.dir || typeof e.data === 'function' ? 0 : e.data !== undefined ? Buffer.byteLength(e.data) : fs.statSync(e.file).size));
  const total = sizes.reduce((a, b) => a + b, 0);
  const files = [];
  let done = 0;
  async function* blocks() {
    for (let k = 0; k < entries.length; k++) {
      if (signal && signal.aborted) throw new Error('cancelled');
      const e = entries[k];
      const p = cleanPath(e.path) + (e.dir ? '/' : '');
      const mtime = (e.mtime || Date.now()) / 1000;
      if (e.dir) {
        for (const b of headerBlocks(p, 0, '5', 0o755, mtime)) yield b;
        continue;
      }
      const data = typeof e.data === 'function' ? e.data(files.slice()) : e.data;
      const size = typeof e.data === 'function' ? Buffer.byteLength(data) : sizes[k];
      for (const b of headerBlocks(p, size, '0', e.mode || 0o644, mtime)) yield b;
      const hash = crypto.createHash('sha256');
      let got = 0;
      if (data !== undefined) {
        const buf = Buffer.from(data);
        hash.update(buf);
        got = buf.length;
        yield buf;
      } else {
        for await (const chunk of fs.createReadStream(e.file, { highWaterMark: 1 << 20 })) {
          if (signal && signal.aborted) throw new Error('cancelled');
          let c = chunk;
          if (got + c.length > size) c = c.subarray(0, size - got); // the file grew while we read it
          hash.update(c);
          got += c.length;
          done += c.length;
          if (onProgress) onProgress(done, total);
          yield c;
          if (got >= size) break;
        }
      }
      if (got < size) throw new Error(`${e.file}: the file got shorter while it was read`);
      if (data !== undefined) { done += got; if (onProgress) onProgress(done, total); }
      yield padding(size);
      files.push({ path: p, size, sha256: hash.digest('hex') });
    }
    yield Buffer.alloc(BLOCK * 2, 0);
  }
  await fs.promises.mkdir(path.dirname(path.resolve(outFile)), { recursive: true });
  const tmp = `${outFile}.part`;
  try {
    const stages = [Readable.from(blocks())];
    if (gzip) stages.push(zlib.createGzip({ level }));
    stages.push(fs.createWriteStream(tmp));
    await pipeline(...stages);
    await fs.promises.rename(tmp, outFile);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (x) { /* none */ }
    throw e;
  }
  return { files, total };
}

function parseOctal(b, start, len) {
  const s = b.toString('ascii', start, start + len).replace(/\0.*$/, '').trim();
  return s ? parseInt(s, 8) : 0;
}

function parsePax(buf) {
  const out = {};
  let i = 0;
  while (i < buf.length) {
    const sp = buf.indexOf(0x20, i);
    if (sp < 0) break;
    const len = parseInt(buf.toString('ascii', i, sp), 10);
    if (!(len > 0)) break;
    const rec = buf.toString('utf8', sp + 1, i + len - 1);
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

/**
 * Read a tar or tar.gz stream. For each entry calls
 * onEntry({ path, type: 'file'|'dir'|'other', size }) and, for files, expects
 * either undefined (skip the content) or a Writable to receive the content.
 * Content is hashed on the way: resolves [{ path, type, size, sha256 }].
 */
async function read(file, onEntry, { onProgress } = {}) {
  const fd = await fs.promises.open(file, 'r');
  const magic = Buffer.alloc(2);
  await fd.read(magic, 0, 2, 0);
  await fd.close();
  const gz = magic[0] === 0x1f && magic[1] === 0x8b;
  const total = fs.statSync(file).size;
  const results = [];
  let buf = Buffer.alloc(0);
  let state = { kind: 'header' };
  let pax = {};
  let longName = null;
  let readBytes = 0;
  let ended = false;

  const consume = async (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (ended) { buf = Buffer.alloc(0); return; }
      if (state.kind === 'header') {
        if (buf.length < BLOCK) return;
        const h = buf.subarray(0, BLOCK);
        buf = buf.subarray(BLOCK);
        if (h.every((x) => x === 0)) { ended = true; continue; }
        let sum = 0;
        for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
        if (sum !== parseOctal(h, 148, 8)) throw new Error('not a tar archive (bad header checksum)');
        const type = String.fromCharCode(h[156] || 0x30);
        let size = parseOctal(h, 124, 12);
        const name = h.toString('utf8', 0, 100).replace(/\0.*$/s, '');
        const prefix = h.toString('ascii', 257, 262) === 'ustar' ? h.toString('utf8', 345, 500).replace(/\0.*$/s, '') : '';
        if (type === 'x' || type === 'g' || type === 'L') {
          state = { kind: 'meta', type, size, left: size, parts: [] };
          continue;
        }
        let p = pax.path || longName || (prefix ? `${prefix}/${name}` : name);
        if (pax.size) size = Number(pax.size);
        pax = {};
        longName = null;
        const kind = type === '0' || type === '\0' || type === '7' ? 'file' : type === '5' ? 'dir' : 'other';
        p = p.replace(/\/+$/, '');
        const entry = { path: p, type: kind, size: kind === 'dir' ? 0 : size };
        const sink = await onEntry(entry);
        if (sink === STOP) throw new Stopped();
        if (kind === 'dir' || size === 0) {
          if (sink) await new Promise((res, rej) => sink.end((err) => (err ? rej(err) : res())));
          results.push(Object.assign(entry, kind === 'file' ? { sha256: crypto.createHash('sha256').digest('hex') } : {}));
          if (size === 0) continue;
        }
        state = { kind: 'data', entry, left: size, pad: (BLOCK - (size % BLOCK)) % BLOCK, sink, hash: crypto.createHash('sha256') };
        continue;
      }
      if (state.kind === 'meta') {
        const need = state.left + ((BLOCK - (state.size % BLOCK)) % BLOCK);
        if (buf.length < need) return;
        const data = buf.subarray(0, state.size);
        buf = buf.subarray(need);
        if (state.type === 'x') pax = parsePax(data);
        else if (state.type === 'L') longName = data.toString('utf8').replace(/\0.*$/s, '');
        state = { kind: 'header' };
        continue;
      }
      if (state.kind === 'data') {
        if (state.left > 0) {
          if (!buf.length) return;
          const n = Math.min(buf.length, state.left);
          const piece = buf.subarray(0, n);
          buf = buf.subarray(n);
          state.left -= n;
          state.hash.update(piece);
          if (state.sink && !state.sink.write(piece)) await new Promise((res) => state.sink.once('drain', res));
          if (state.left > 0) return;
        }
        if (buf.length < state.pad) return;
        buf = buf.subarray(state.pad);
        if (state.sink) await new Promise((res, rej) => state.sink.end((err) => (err ? rej(err) : res())));
        results.push(Object.assign(state.entry, { sha256: state.hash.digest('hex') }));
        state = { kind: 'header' };
      }
    }
  };

  const source = fs.createReadStream(file, { highWaterMark: 1 << 20 });
  source.on('data', (c) => { readBytes += c.length; if (onProgress) onProgress(readBytes, total); });
  const stages = [source];
  if (gz) stages.push(zlib.createGunzip());
  stages.push(new Writable({
    write(chunk, enc, cb) { consume(chunk).then(() => cb(), cb); },
    final(cb) {
      if (state.kind !== 'header' || (!ended && buf.length)) return cb(new Error('the archive ends in the middle of a file'));
      cb();
    },
  }));
  try {
    await pipeline(...stages);
  } catch (e) {
    if (!(e instanceof Stopped)) throw e;
  }
  return results;
}

/** One file's content from an archive, as a Buffer (for small files such as the manifest), or undefined. */
async function readFile(file, wanted) {
  let out;
  const chunks = [];
  await read(file, (e) => {
    if (out !== undefined) return STOP;
    if (e.type !== 'file' || e.path !== wanted) return undefined;
    return new Writable({ write(c, enc, cb) { chunks.push(Buffer.from(c)); cb(); }, final(cb) { out = Buffer.concat(chunks); cb(); } });
  });
  return out;
}

module.exports = { write, read, readFile, cleanPath, splitName, paxRecord, BLOCK, STOP };
