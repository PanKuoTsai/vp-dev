'use strict';
// Kernel module symbols for the target debugger: match the modules the guest
// kernel has loaded (vp-linux.py's -vp-lsmod) with .ko files on this machine,
// or extract them from the platform's ext4 disk image (debugfs, read-only),
// and give gdb an add-symbol-file per module at the addresses the kernel
// loaded its sections to. No VS Code dependency.

const fs = require('fs');
const path = require('path');

/** Module names use "_" where file names may have "-" (snd-hda-intel.ko is snd_hda_intel). */
const normalize = (name) => String(name).replace(/-/g, '_');

/** The module name of a file: "drivers/net/virtio_net.ko" -> "virtio_net"; null for other files. */
function moduleOfFile(file) {
  const m = /([^/\\]+)\.ko$/.exec(String(file));
  return m ? normalize(m[1]) : null;
}

/**
 * .ko files under the folders, by module name (the first one found wins): Map(name -> path).
 * Compressed modules (.ko.zst, .ko.xz) are counted in `compressed` but not used.
 */
function indexFiles(dirs, { maxDepth = 10, maxFiles = 200000 } = {}) {
  const found = new Map();
  let compressed = 0;
  let seen = 0;
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      if (++seen > maxFiles) return;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < maxDepth) walk(p, depth + 1); continue; }
      if (/\.ko\.(zst|xz|gz)$/.test(e.name)) { compressed++; continue; }
      const name = moduleOfFile(e.name);
      if (name && !found.has(name)) found.set(name, p);
    }
  };
  for (const d of dirs) if (d) walk(d, 0);
  return { files: found, compressed };
}

/** modules.dep: Map(module name -> path relative to /lib/modules/<release>). */
function parseModulesDep(text) {
  const out = new Map();
  for (const line of String(text).split('\n')) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const rel = line.slice(0, i).trim();
    const name = moduleOfFile(rel);
    if (name && !out.has(name)) out.set(name, rel);
  }
  return out;
}

// Sections that are gone once a module has loaded (the kernel frees them) or carry no code or data.
const SKIP = /^(\.init|\.exit|__ksymtab|__kcrctab|\.note|\.gnu\.linkonce)/;

/**
 * gdb's add-symbol-file for a loaded module: .text at its address, then the other sections the
 * kernel reports (sysfs section attributes); without them, .text at the module's base.
 */
function addSymbolFile(file, mod) {
  if (/["\n]/.test(String(file))) throw new Error(`a file name with quotes: ${file}`);
  const secs = (mod.sections || []).filter((s) => s.name && /^0x[0-9a-f]+$/i.test(s.address) && !/^0x0+$/i.test(s.address));
  const text = secs.find((s) => s.name === '.text');
  const parts = [`add-symbol-file "${file}" ${text ? text.address : mod.base}`];
  for (const s of secs) if (s !== text && !SKIP.test(s.name) && /^[\w.$-]+$/.test(s.name)) parts.push(`-s ${s.name} ${s.address}`);
  return parts.join(' ');
}

/** A module as loaded: the same name at another address is another load. */
const loadKey = (mod) => `${normalize(mod.name)}@${mod.base}`;

/**
 * What to do for each loaded module: { load: [{mod, file, command}], missing: [mod], done: [mod] }.
 * files: Map(name -> path); loaded: Set of loadKey()s already given to gdb in this session.
 */
function plan(mods, files, loaded = new Set()) {
  const out = { load: [], missing: [], done: [] };
  for (const mod of mods || []) {
    if (mod.state === 'unformed') continue;
    if (loaded.has(loadKey(mod))) { out.done.push(mod); continue; }
    const file = files.get(normalize(mod.name));
    if (!file) { out.missing.push(mod); continue; }
    out.load.push({ mod, file, command: addSymbolFile(file, mod) });
  }
  return out;
}

/** debugfs (e2fsprogs) arguments that read an ext4 image without changing it: -c is catastrophic (read-only) mode. */
const debugfsArgs = (image, request) => ['-c', '-R', request, image];

/** Where extracted modules go: next to the kernel's symbol file, by release, as in /lib/modules. */
const extractDir = (symbolFile, release) => path.join(path.dirname(symbolFile), 'modules', release);

module.exports = { normalize, moduleOfFile, indexFiles, parseModulesDep, addSymbolFile, loadKey, plan, debugfsArgs, extractDir };
