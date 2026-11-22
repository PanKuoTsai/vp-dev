'use strict';
// Disk images a platform opens for writing, and whether another process
// (another simulator, usually) already holds QEMU's lock on one. A QEMU
// instance locks a writable image, so a second simulator of the same platform
// fails with 'Failed to get "write" lock'; checking before the start lets the
// launcher say so plainly. Linux only (reads /proc); elsewhere nothing is
// reported. No VS Code dependency.

const fs = require('fs');
const path = require('path');
const core = require('../platform/core');

/**
 * Images named by file=... in QEMU option strings among the parameters
 * (blkdev_str and the like): [{ module, param, file, writable }]. ${TOP} is the
 * folder of the generated Lua (next to the platform file); other ${VAR}s are
 * replaced when the variable is a plain string or number.
 */
function diskImages(doc, topDir) {
  const vars = new Map((doc.variables || []).map((v) => [v.name, v.value]));
  const expandText = (s) => {
    let ok = true;
    const out = s.replace(/\$\{([A-Za-z_]\w*)\}/g, (m, name) => {
      if (name === 'TOP') return topDir.endsWith('/') ? topDir : topDir + '/';
      const v = vars.get(name);
      if (typeof v === 'string' || typeof v === 'number') return String(v);
      ok = false;
      return m;
    });
    return ok ? out : null;
  };
  const seen = new Set();
  const out = [];
  for (const inst of core.analyze(doc).instances) {
    for (const [param, v] of Object.entries(inst.params)) {
      if (typeof v !== 'string' || !/(^|,)file=/.test(v)) continue;
      const opts = new Map(v.split(',').map((kv) => { const i = kv.indexOf('='); return i < 0 ? [kv, ''] : [kv.slice(0, i), kv.slice(i + 1)]; }));
      const raw = opts.get('file');
      const file = raw && expandText(raw);
      if (!file) continue;
      const on = (k) => /^(on|true|yes|1)$/i.test(opts.get(k) || '');
      const writable = !on('readonly') && !on('read-only') && !on('snapshot');
      const key = `${inst.base}|${param}|${file}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ module: inst.base, param, file: path.resolve(file), writable, options: v });
    }
  }
  return out;
}

/** Linux device number to [major, minor] (glibc's encoding). */
function devParts(dev) {
  const d = BigInt(dev);
  const major = Number(((d >> 8n) & 0xfffn) | ((d >> 32n) & ~0xfffn));
  const minor = Number((d & 0xffn) | ((d >> 12n) & ~0xffn));
  return [major, minor];
}

/** Lines of /proc/locks text that lock the file with this device and inode. */
function locksOn(procLocks, major, minor, ino) {
  // Device is "%02x:%02x", inode decimal: "103:04:8951619".
  const want = `${major.toString(16).padStart(2, '0')}:${minor.toString(16).padStart(2, '0')}:${ino}`;
  return procLocks.split('\n').filter((l) => l.split(/\s+/).includes(want));
}

/** Processes (pid and command) with the file open, among those we may inspect. */
function openers(file, proc = '/proc') {
  const out = [];
  let pids = [];
  try { pids = fs.readdirSync(proc).filter((d) => /^\d+$/.test(d)); } catch (e) { return out; }
  for (const pid of pids) {
    if (Number(pid) === process.pid) continue;
    let fds;
    try { fds = fs.readdirSync(`${proc}/${pid}/fd`); } catch (e) { continue; }
    for (const fd of fds) {
      let target;
      try { target = fs.readlinkSync(`${proc}/${pid}/fd/${fd}`); } catch (e) { continue; }
      if (target === file) {
        let cmd = '';
        try { cmd = fs.readFileSync(`${proc}/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' '); } catch (e) { /* gone */ }
        out.push({ pid: Number(pid), cmd });
        break;
      }
    }
  }
  return out;
}

/**
 * Writable images of the platform that another process holds a lock on:
 * [{ module, param, file, holders: [{pid, cmd}] }]. Empty off Linux.
 */
function lockedImages(doc, topDir) {
  if (process.platform !== 'linux') return [];
  let procLocks;
  try { procLocks = fs.readFileSync('/proc/locks', 'utf8'); } catch (e) { return []; }
  const out = [];
  for (const img of diskImages(doc, topDir)) {
    if (!img.writable) continue;
    let st;
    try { st = fs.statSync(img.file); } catch (e) { continue; }
    const [major, minor] = devParts(st.dev);
    if (locksOn(procLocks, major, minor, st.ino).length) out.push(Object.assign({ holders: openers(img.file) }, img));
  }
  return out;
}

module.exports = { diskImages, devParts, locksOn, openers, lockedImages };
