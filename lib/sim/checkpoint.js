'use strict';
// Checkpoints (G-08): save a running simulation and start a new one from
// that point. The sim agent saves the QEMU device state, the SystemC
// memories (gs_memory, through DMI) and the registers of SystemC peripherals
// (ckpt.save); this module decides what to save for a platform, copies the
// disk images, writes the manifest, and works out how to start from it
// (agent parameter restore_from plus the disk overrides). Shared by the
// extension and vp-run. No VS Code dependency.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const core = require('../platform/core');
const disklock = require('./disklock');
const registers = require('../analysis/registers');

const CHECKPOINT_VERSION = 1;
const MANIFEST = 'checkpoint.json';
const MIN_AGENT = '0.10.0';

/** Module types with nothing to save: no state, or state that only matters while building the platform. */
const STATELESS = new Set([
  'Container', 'router', 'addrtr', 'biflow_router', 'loader', 'keep_alive', 'realtimelimiter',
  'char_backend_stdio', 'char_backend_file', 'char_backend_socket', 'global_peripheral_initiator',
  'QemuInstanceManager', 'QemuInstance', 'vp_sim_agent', 'sim_agent', 'vp_tracer', 'vp_signal_tracer', 'tracer', 'signal_tracer', 'vp_debug_dap', 'debug_dap',
]);

/** Whether a module type lives in QEMU (its state is in QEMU's device state), from the catalog; null when unknown. */
function isQemuType(type, catalog) {
  const m = catalog && catalog.modules && catalog.modules[type];
  if (!m) return null;
  if (/^qemu-components\//.test(m.source || '')) return true;
  return (m.args || []).some((a) => a.expects === 'QemuInstance' || a.expects === 'QemuInstanceManager');
}

const hex = (v) => '0x' + BigInt(v).toString(16);

/**
 * What a checkpoint of this platform holds.
 * options: catalog, descs (register descriptions: registers.loadDir), buses
 * (the routers the agent's bus_N sockets are bound to, in order), topDir.
 * Returns { memories: [{name, address, size, bus}], registers: [{name, address, size, bus}],
 *   disks: [{module, param, file}], skipped: [{instance, type, why}], unsaved: [{instance, type}] }.
 * unsaved: SystemC models whose state is not saved (a checkpoint may then not work).
 */
function plan(doc, { catalog, descs = [], buses = [], topDir, overrides = [] } = {}) {
  const analysis = core.analyze(doc, { catalog });
  const typeOf = new Map(analysis.instances.map((i) => [i.name, i]));
  const memories = [];
  const skipped = [];
  const covered = new Set();
  for (const mm of analysis.memoryMap) {
    const inst = typeOf.get(mm.instance);
    if (!inst || inst.type !== 'gs_memory') continue;
    covered.add(mm.instance);
    const busIndex = buses.indexOf(mm.bus);
    if (busIndex < 0) { skipped.push({ instance: mm.instance, type: inst.type, why: `on ${mm.bus}, which the agent has no socket on` }); continue; }
    const dmi = inst.params && inst.params.dmi_allow;
    if (dmi === false || dmi === 'false') {
      // Background memory such as fallback_0 (32 GiB, no DMI): through debug
      // accesses it would take far too long. It only catches stray accesses.
      skipped.push({ instance: mm.instance, type: inst.type, why: 'no DMI (dmi_allow is false)' });
      continue;
    }
    memories.push({ name: mm.instance, address: hex(mm.start), size: hex(mm.size), bus: busIndex });
  }
  const regs = [];
  for (const p of registers.peripherals(doc, descs, buses)) {
    if (isQemuType(p.type, catalog) !== false) continue; // QEMU saves its own devices
    covered.add(p.module);
    for (const r of p.registers) {
      if (r.access !== 'rw' || r.readSideEffect) continue;
      regs.push({ name: `${p.module}.${r.name}`, address: hex(p.address + BigInt(r.offset)), size: r.size || 4, bus: p.busIndex });
    }
  }
  const unsaved = [];
  for (const inst of analysis.instances) {
    if (inst.isContainer || covered.has(inst.name) || STATELESS.has(inst.type)) continue;
    if (isQemuType(inst.type, catalog) === true) continue;
    unsaved.push({ instance: inst.name, type: inst.type });
  }
  const images = topDir ? disklock.diskImages(withOverrides(doc, overrides, analysis), topDir) : [];
  const disks = images.filter((d) => d.writable).map((d) => ({ module: d.module, param: d.param, file: d.file }));
  // snapshot=on: the guest's writes are in a temporary overlay QEMU deletes,
  // so the file on disk is not what the guest sees and cannot be saved.
  const volatile = images.filter((d) => !d.writable && /(^|,)snapshot=(on|true|yes|1)(,|$)/i.test(d.options || '')).map((d) => ({ module: d.module, file: d.file }));
  return { memories, registers: regs, disks, volatile, skipped, unsaved };
}

/**
 * The document with parameter overrides ({instance, param, value}, as
 * core.generate takes them) written into the modules, so that the disk
 * images a simulation really uses are found (a restored simulation runs on
 * copies, and vp-run --param may change them).
 */
function withOverrides(doc, overrides, analysis) {
  if (!overrides || !overrides.length) return doc;
  const copy = JSON.parse(JSON.stringify(doc));
  for (const o of overrides) {
    if (typeof o.value !== 'string') continue;
    const inst = analysis.instances.find((i) => i.name === o.instance || i.base === o.instance);
    if (!inst) continue;
    let def = copy;
    for (const k of core.jsonPath(inst.base)) def = def && def[k];
    if (!def || typeof def !== 'object') continue;
    def.params = Object.assign({}, def.params, { [o.param]: o.value });
  }
  return copy;
}

/** sha256 of a platform file's text. */
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

/** Copy a (sparse) file: cp keeps the holes of a 4 GB disk image; Node's copyFile does not. */
function copySparse(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  return new Promise((resolve, reject) => {
    execFile('cp', ['--sparse=always', '--reflink=auto', '-f', from, to], (err) => {
      if (!err) return resolve();
      fs.promises.copyFile(from, to).then(resolve, reject);
    });
  });
}

/** File name of a disk image in a checkpoint. */
const diskFileName = (d, i) => `disk-${String(d.module).replace(/[^A-Za-z0-9_.-]/g, '_')}-${i}${path.extname(d.file) || '.img'}`;

/**
 * Save a checkpoint of the running simulation into dir. client: a connected
 * SimAgentClient. p: plan(). Pauses the simulation if it runs, and runs it
 * again afterwards unless stayPaused. Resolves the manifest.
 * info: { name, platformFile, platformText, qboxCommit, agentVersion }.
 */
async function save(client, dir, p, info, { stayPaused = false, onPhase = () => {} } = {}) {
  if (p.volatile && p.volatile.length) {
    throw new Error(`the disk image of ${p.volatile[0].module} is opened with snapshot=on: the guest's writes are in a temporary overlay, so the disk cannot be saved. Run without snapshot (vp-run without --snapshot) to save checkpoints.`);
  }
  const before = await client.request('sim.getStatus');
  if (before.state === 'ended') throw new Error('the simulation has ended');
  const wasRunning = before.state === 'running';
  if (wasRunning) await client.request('sim.pause');
  fs.mkdirSync(dir, { recursive: true });
  let res;
  try {
    onPhase('saving the device state and memory');
    res = await client.request('ckpt.save', { dir, memories: p.memories, registers: p.registers }, { timeoutMs: 600000 });
    const disks = [];
    for (let i = 0; i < p.disks.length; i++) {
      const d = p.disks[i];
      const file = diskFileName(d, i);
      onPhase(`copying ${path.basename(d.file)}`);
      await copySparse(d.file, path.join(dir, file));
      disks.push({ module: d.module, param: d.param, source: d.file, file, size: fs.statSync(d.file).size });
    }
    const manifest = {
      checkpoint: CHECKPOINT_VERSION,
      name: info.name || path.basename(dir),
      created: new Date().toISOString(),
      platform: { file: info.platformFile, name: path.basename(info.platformFile || ''), sha256: info.platformText !== undefined ? sha256(info.platformText) : undefined },
      qbox: info.qboxCommit ? { commit: info.qboxCommit } : undefined,
      agent: info.agentVersion,
      time: res.time,
      devices: res.devices,
      memories: res.memories,
      registers: (res.registers || []).map((r) => r.name),
      disks,
      skipped: p.skipped.length ? p.skipped : undefined,
      unsaved: p.unsaved.length ? p.unsaved : undefined,
    };
    fs.writeFileSync(path.join(dir, MANIFEST), JSON.stringify(manifest, null, 2) + '\n');
    return manifest;
  } finally {
    if (wasRunning && !stayPaused) await client.request('sim.continue').catch(() => {});
  }
}

/** The manifest of a checkpoint folder. Throws when it is not one. */
function readManifest(dir) {
  let m;
  try {
    m = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8'));
  } catch (e) {
    throw new Error(`${dir} is not a checkpoint (no readable ${MANIFEST})`);
  }
  if (m.checkpoint !== CHECKPOINT_VERSION) throw new Error(`${dir}: checkpoint format ${m.checkpoint} is not supported (this VP Studio reads ${CHECKPOINT_VERSION})`);
  for (const f of ['agent.json', 'devices.qemu']) {
    if (!fs.existsSync(path.join(dir, f))) throw new Error(`${dir}: ${f} is missing`);
  }
  return m;
}

/** Checkpoints under root (one folder each), newest first: [{ dir, manifest }]. Unreadable ones are left out. */
function list(root, platformFile) {
  let names;
  try { names = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch (e) { return []; }
  const out = [];
  for (const n of names) {
    const dir = path.join(root, n);
    try {
      const manifest = readManifest(dir);
      if (platformFile && manifest.platform && manifest.platform.name && manifest.platform.name !== path.basename(platformFile)) continue;
      out.push({ dir, manifest });
    } catch (e) { /* not a checkpoint */ }
  }
  return out.sort((a, b) => String(b.manifest.created).localeCompare(String(a.manifest.created)));
}

/** Where checkpoints of a platform go: checkpoints/ next to it. */
const rootFor = (platformFile) => path.join(path.dirname(platformFile), 'checkpoints');

/** A default checkpoint name: <platform>-<yyyymmdd-hhmmss>. */
function defaultName(doc, now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${(doc && doc.name) || 'platform'}-${stamp}`;
}

/** A disk option string ("file=...,format=raw,...") with another file, and snapshot=on if asked. */
function withDiskFile(value, file, snapshot) {
  const parts = String(value).split(',');
  let found = false;
  const out = parts.map((kv) => {
    if (kv.startsWith('file=')) { found = true; return `file=${file}`; }
    return kv;
  }).filter((kv) => !(snapshot && kv.startsWith('snapshot=')));
  if (!found) out.unshift(`file=${file}`);
  if (snapshot) out.push('snapshot=on');
  return out.join(',');
}

/**
 * How to start the platform from a checkpoint.
 * snapshot: open the checkpoint's own disk images with snapshot=on (nothing
 * is copied, and the guest's disk writes are dropped at the end); otherwise
 * each disk is copied to <dir>/run/ first and the simulation uses that copy,
 * so the checkpoint stays as it was.
 * Returns { overrides: [{instance, param, value}], copies: [{from, to}],
 *   agentParams: {restore_from, restore_paused}, problems: [{level, text}] }.
 */
function restorePlan(manifest, dir, doc, { snapshot = false, paused = false, platformText } = {}) {
  const problems = [];
  if (platformText !== undefined && manifest.platform && manifest.platform.sha256 && manifest.platform.sha256 !== sha256(platformText)) {
    problems.push({ level: 'warning', text: 'The platform has changed since the checkpoint was saved. Changes to modules, CPUs or connections make the load fail or the guest misbehave.' });
  }
  const analysis = core.analyze(doc);
  const overrides = [];
  const copies = [];
  for (const d of manifest.disks || []) {
    const inst = analysis.instances.find((i) => i.base === d.module || i.name === d.module);
    const value = inst && inst.params && inst.params[d.param];
    if (typeof value !== 'string') {
      problems.push({ level: 'error', text: `The platform has no ${d.module}.${d.param} for the disk image ${d.file}.` });
      continue;
    }
    const saved = path.join(dir, d.file);
    const use = snapshot ? saved : path.join(dir, 'run', d.file);
    if (!snapshot) copies.push({ from: saved, to: use });
    overrides.push({ instance: inst.name, param: d.param, value: withDiskFile(value, use, snapshot) });
  }
  return { overrides, copies, agentParams: { restore_from: path.resolve(dir), restore_paused: !!paused }, problems };
}

/** Carry out the copies of a restorePlan. */
async function prepare(rp, onPhase = () => {}) {
  for (const c of rp.copies) {
    onPhase(`copying ${path.basename(c.from)}`);
    await copySparse(c.from, c.to);
  }
}

/** Human-readable size. */
const fmtSize = (n) => (n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(1)} GiB` : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MiB` : `${Math.round(n / 1024)} KiB`);

/** Bytes a checkpoint folder takes on disk (sparse files count what they use). */
function diskUsage(dir) {
  let total = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else { try { total += fs.statSync(f).blocks * 512; } catch (x) { /* gone */ } }
    }
  };
  try { walk(dir); } catch (e) { /* gone */ }
  return total;
}

module.exports = {
  CHECKPOINT_VERSION, MANIFEST, MIN_AGENT, STATELESS,
  isQemuType, plan, save, readManifest, list, rootFor, defaultName, withDiskFile, restorePlan, prepare,
  copySparse, sha256, fmtSize, diskUsage, diskFileName,
};
