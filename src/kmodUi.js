'use strict';
// Kernel module symbols in target debug sessions: Load Kernel Module Symbols,
// and the same without questions at the first stop of a session
// (vpStudio.debug.moduleSymbols). The modules come from the running kernel
// (vp-linux.py's -vp-lsmod); their .ko files from vpStudio.debug.moduleDirs,
// or extracted from the platform's ext4 disk image with debugfs.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const km = require('../lib/debug/kmodules');
const guestlinux = require('../lib/debug/guestlinux');
const disklock = require('../lib/sim/disklock');
const shared = require('./shared');
const common = require('./common');
const linuxUi = require('./linuxUi');
const gdbUi = require('./gdbUi');
const debugUi = require('./debugUi');

const loaded = new Map(); // session id -> Set of km.loadKey()s given to gdb
const autoDone = new Set(); // sessions whose first stop has been handled

function sessionOf() {
  const s = vscode.debug.activeDebugSession;
  return s && s.type === linuxUi.DEBUG_TYPE ? s : undefined;
}

/** The kernel's symbol file: the session's program, else the running platform's first one. */
async function symbolFile(s) {
  const prog = s && s.configuration && s.configuration.program;
  if (prog && fs.existsSync(prog)) return prog;
  if (shared.runningPlatform) return (await debugUi.symbolFilesFor(shared.runningPlatform))[0];
  return undefined;
}

/** The folders searched for .ko files: the setting's, then where extraction puts them. */
function searchDirs(sym, release) {
  const dirs = (common.cfg().get('debug.moduleDirs') || []).filter((d) => typeof d === 'string' && d);
  if (sym && release) dirs.push(km.extractDir(sym, release));
  return dirs;
}

/** debugfs, if it is installed (e2fsprogs; often in /sbin, outside a user's PATH). */
function debugfsTool() {
  for (const t of ['debugfs', '/sbin/debugfs', '/usr/sbin/debugfs']) {
    try { if (cp.spawnSync(t, ['-V'], { stdio: 'ignore' }).status === 0) return t; } catch (e) { /* next */ }
  }
  return undefined;
}

/** ext4 images among the running platform's disks (by the superblock magic). */
function ext4Images() {
  if (!shared.runningDoc || !shared.runningPlatform) return [];
  let disks;
  try { disks = disklock.diskImages(shared.runningDoc, path.dirname(shared.runningPlatform.fsPath)); } catch (e) { return []; }
  return disks.map((d) => d.file).filter((f) => {
    try {
      const fd = fs.openSync(f, 'r');
      const b = Buffer.alloc(2);
      fs.readSync(fd, b, 0, 2, 1024 + 0x38);
      fs.closeSync(fd);
      return b.readUInt16LE(0) === 0xef53;
    } catch (e) { return false; }
  });
}

/** Copy the modules' .ko files out of the image into dest (read-only debugfs). Returns how many arrived. */
function extract(tool, image, release, mods, dest) {
  const run = (args, input) => cp.spawnSync(tool, args, { input, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' });
  const dep = run(km.debugfsArgs(image, `cat /lib/modules/${release}/modules.dep`));
  const paths = km.parseModulesDep(dep.stdout || '');
  if (!paths.size) throw new Error(`no /lib/modules/${release}/modules.dep in ${path.basename(image)}`);
  const cmds = [];
  for (const m of mods) {
    const rel = paths.get(km.normalize(m.name));
    if (!rel || /["\n]/.test(rel)) continue;
    const out = path.join(dest, rel);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    cmds.push(`dump -p "/lib/modules/${release}/${rel}" "${out}"`);
  }
  if (!cmds.length) return 0;
  const file = path.join(dest, '.vp-debugfs-commands');
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(file, cmds.join('\n') + '\n');
  try { run(['-c', '-f', file, image]); } finally { fs.rmSync(file, { force: true }); }
  return mods.filter((m) => paths.has(km.normalize(m.name)) && fs.existsSync(path.join(dest, paths.get(km.normalize(m.name))))).length;
}

/**
 * Load the symbols of every loaded module that has a .ko here. quiet: the automatic run at a
 * session's first stop (no questions, no extraction; a status bar message only).
 */
async function loadModules({ quiet = false } = {}) {
  const s = sessionOf();
  if (!s) { if (!quiet) vscode.window.showWarningMessage('Attach the debugger to the target ("VP: attach to target software") first.'); return; }
  if (!(shared.cpuRegsView && shared.cpuRegsView.stopped)) { if (!quiet) vscode.window.showWarningMessage('Pause the target (F6) first.'); return; }
  let list;
  try {
    const body = await s.customRequest('evaluate', guestlinux.evaluateArgs('-vp-lsmod'));
    list = guestlinux.parseResult(body);
  } catch (e) {
    if (quiet) return;
    if (guestlinux.notLoaded(e.message)) vscode.window.showWarningMessage('The Linux script is not loaded in this debug session (setting vpStudio.debug.linuxAwareness, and vmlinux as the program); attach again.');
    else vscode.window.showErrorMessage(`Could not list the guest's modules: ${e.message}`);
    return;
  }
  const mods = (list && list.modules) || [];
  const release = (list && list.release) || '';
  if (!mods.length) { if (!quiet) vscode.window.showInformationMessage('The guest kernel has no modules loaded.'); return; }
  const sym = await symbolFile(s);
  const done = loaded.get(s.id) || new Set();
  loaded.set(s.id, done);
  let index = km.indexFiles(searchDirs(sym, release));
  let p = km.plan(mods, index.files, done);
  if (p.missing.length && !quiet && !common.IS_WINDOWS && sym && release) {
    const tool = debugfsTool();
    const images = tool ? ext4Images() : [];
    if (images.length) {
      const dest = km.extractDir(sym, release);
      const go = await vscode.window.showInformationMessage(
        `${p.missing.length} of the guest's ${mods.length} modules have no .ko file here. Copy them out of the disk image ${path.basename(images[0])} (read only) into ${dest}?`,
        { modal: true, detail: 'The files come from /lib/modules/' + release + ' of the image. Folders of your own .ko files (with debug info, for example from a -dbgsym package) go in the setting vpStudio.debug.moduleDirs; they are searched first.' }, 'Copy and Load');
      if (go === 'Copy and Load') {
        try {
          await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Copying ${p.missing.length} modules out of ${path.basename(images[0])}` },
            async () => extract(tool, images[0], release, p.missing, dest));
        } catch (e) { vscode.window.showErrorMessage(`Could not copy the modules: ${e.message}`); }
        index = km.indexFiles(searchDirs(sym, release));
        p = km.plan(mods, index.files, done);
      }
    }
  }
  let ok = 0;
  const failed = [];
  for (const x of p.load) {
    const out = await gdbUi.cli(s, x.command, { timeoutMs: 120000 }).catch((e) => `error: ${e.message}`);
    if (/error|No such file|not in executable format/i.test(out)) failed.push(`${x.mod.name}: ${out.trim().split('\n').slice(-1)[0]}`);
    else { ok++; done.add(km.loadKey(x.mod)); }
  }
  const missing = p.missing.map((m) => m.name);
  const msg = `Kernel modules: symbols of ${ok} loaded${p.done.length ? `, ${p.done.length} already` : ''}${missing.length ? `; no .ko for ${missing.length} (${missing.slice(0, 6).join(', ')}${missing.length > 6 ? ', …' : ''})` : ''}${index.compressed ? `; ${index.compressed} compressed .ko files skipped` : ''}.`;
  if (failed.length) vscode.window.showWarningMessage(`${msg} Failed: ${failed.join('; ')}`);
  else if (quiet) { if (ok) vscode.window.setStatusBarMessage(`VP Studio: ${msg}`, 10000); } else vscode.window.showInformationMessage(msg);
}

function cmdLoadModules() { return loadModules({ quiet: false }); }

/** First stop of a target session: load what can be loaded without asking. */
function onStopped(s) {
  if (!s || s.type !== linuxUi.DEBUG_TYPE || autoDone.has(s.id)) return;
  if (common.cfg().get('debug.moduleSymbols') === false || common.cfg().get('debug.linuxAwareness') === false) return;
  autoDone.add(s.id);
  setTimeout(() => loadModules({ quiet: true }).catch(() => {}), 1500); // after VS Code's own requests for the stop
}

function sessionEnded(s) { loaded.delete(s.id); autoDone.delete(s.id); }

exports.cmdLoadModules = cmdLoadModules;
exports.onStopped = onStopped;
exports.sessionEnded = sessionEnded;
