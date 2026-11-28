'use strict';
// Create Tutorial Workspace: the vplogger tutorial (templates/tutorial) next
// to the Ubuntu AArch64 platform of a QBox folder. What goes where, the
// tutorial's platform and the checks before; the extension copies and asks.
// No VS Code dependency.

const fs = require('fs');
const path = require('path');

const NAME = 'vplogger-tutorial';
const SUFFIX = '.platform.json';
const SOURCE_PREFIX = '/vplogger'; // where the programs' debug information says vplogger.c is

/** <qbox>/platforms/ubuntu, where the Ubuntu platform's ${TOP} files are. */
const ubuntuDir = (qbox) => path.join(qbox, 'platforms', 'ubuntu');

/**
 * What a QBox folder has for the tutorial: { ok, dir, artifacts, image,
 * vmlinux (path or null), missing: [file names] }. ok when the Ubuntu
 * platform's kernel and disk image are there (INSTALL.md, section 6).
 */
function inspect(qbox) {
  const dir = ubuntuDir(qbox);
  const artifacts = path.join(dir, 'fw', 'Artifacts');
  const need = ['Image.bin', 'image_ext4.img', 'image_ext4_initrd.img', 'ubuntu.dtb'];
  const missing = need.filter((f) => !fs.existsSync(path.join(artifacts, f)));
  if (!fs.existsSync(path.join(dir, 'fw', 'arm64_bootloader.lua'))) missing.unshift('fw/arm64_bootloader.lua');
  let vmlinux = null;
  try {
    const v = fs.readdirSync(artifacts).filter((f) => /^vmlinux/.test(f) && !/\.(gz|xz|zst|bz2)$/.test(f)).sort();
    if (v.length) vmlinux = path.join(artifacts, v[v.length - 1]);
  } catch (e) { /* no Artifacts folder: in missing already */ }
  return { ok: missing.length === 0, dir, artifacts, image: path.join(artifacts, 'image_ext4.img'), vmlinux, missing };
}

/**
 * The tutorial's platform: the Ubuntu AArch64 template, named for the
 * tutorial, with the kernel's symbol file (vmlinux, when there is one) for
 * the debugger and the profiler.
 */
function platform(template, { vmlinux = null, dir = '.' } = {}) {
  const d = JSON.parse(JSON.stringify(template));
  delete d.$schema; // the extension associates the schema by file name
  d.name = NAME;
  d.description = 'The VP Studio tutorial (vplogger-tutorial/TUTORIAL.md): the Ubuntu AArch64 platform, with the tutorial programs in /opt/vplogger of its disk image.';
  if (vmlinux) {
    const rel = path.relative(dir, vmlinux).split(path.sep).join('/');
    d.debug = Object.assign({}, d.debug, { symbols: [rel.startsWith('..') ? vmlinux : '${TOP}' + rel] });
  }
  return d;
}

/** Every file under the tutorial template, as paths relative to it (sorted). */
function files(templateDir) {
  const out = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(templateDir, rel), { withFileTypes: true })) {
      const r = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) walk(r);
      else if (e.isFile()) out.push(r);
    }
  };
  walk('');
  return out.sort();
}

/**
 * Copy the template into <dir>/vplogger-tutorial and write the platform
 * next to it. Keeps the execute bit of scripts and programs. Returns
 * { platformFile, folder, copied: [relative paths] }.
 */
function create(templateDir, ubuntuTemplate, qbox, { vmlinux = null } = {}) {
  const dir = ubuntuDir(qbox);
  const folder = path.join(dir, NAME);
  const copied = [];
  for (const rel of files(templateDir)) {
    const from = path.join(templateDir, rel);
    const to = path.join(folder, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (/\.json$/.test(rel)) {
      // Its "$schema" path holds only in templates/; VP Studio gives the schema by the file's name.
      const data = JSON.parse(fs.readFileSync(from, 'utf8'));
      delete data.$schema;
      fs.writeFileSync(to, JSON.stringify(data, null, 2) + '\n');
    } else fs.copyFileSync(from, to);
    const mode = fs.statSync(from).mode;
    // A .vsix does not keep file modes: scripts and the programs are made executable here.
    if ((mode & 0o111) || /\.sh$/.test(rel) || /^vplogger\/bin\//.test(rel.split(path.sep).join('/'))) fs.chmodSync(to, 0o755);
    copied.push(rel);
  }
  const platformFile = path.join(dir, NAME + SUFFIX);
  fs.writeFileSync(platformFile, JSON.stringify(platform(ubuntuTemplate, { vmlinux, dir }), null, 2) + '\n');
  return { platformFile, folder, copied };
}

/** What exists already: the platform file and the folder, for a Replace question. */
function existing(qbox) {
  const dir = ubuntuDir(qbox);
  return [path.join(dir, NAME + SUFFIX), path.join(dir, NAME)].filter((p) => fs.existsSync(p));
}

/** The source mapping for the programs' debug information: { '/vplogger': <folder>/vplogger }. */
const sourceMap = (folder) => ({ [SOURCE_PREFIX]: path.join(folder, 'vplogger') });

module.exports = { NAME, SOURCE_PREFIX, ubuntuDir, inspect, platform, files, create, existing, sourceMap };
