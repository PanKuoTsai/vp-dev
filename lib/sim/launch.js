'use strict';
// Steps of "start a simulation" shared by the VS Code extension and the vp-run
// command line (bin/vp-run.js): where the generated Lua goes, the sim agent
// module, the checks made before a start, the device tree, and where the
// libraries VP Studio builds on this machine live. No VS Code dependency.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const core = require('../platform/core');
const images = require('../platform/images');
const disklock = require('./disklock');
const diskspace = require('./diskspace');
const devicetree = require('../generate/devicetree');
const models = require('../generate/models');

const SUFFIX = '.platform.json';
const AGENT_INSTANCE = 'sim_agent';
const EXTENSION_ID = 'novatek.vp-studio';

/** <name>.generated.lua next to the platform file. */
function luaPathFor(platformFile, data) {
  return path.join(path.dirname(platformFile), `${(data && data.name) || path.basename(platformFile, SUFFIX)}.generated.lua`);
}

/**
 * The extraModules entry that adds the sim agent. dylib is the library path
 * without ".so". buses: routers to give the agent an initiator on (bus_0,
 * bus_1, ...), for reading and writing peripheral registers (agent 0.6.0).
 */
function agentModule(dylib, port, buses = [], extraParams = {}) {
  // A library built before 2026-11-20 (vp_sim_agent.so) registers the type under its old name.
  const type = /(^|[\/])vp_sim_agent$/.test(String(dylib)) ? 'vp_sim_agent' : 'sim_agent';
  const m = { name: AGENT_INSTANCE, type, dylib, params: Object.assign({ port }, extraParams) };
  if (buses.length) {
    m.params.buses = buses.length;
    m.ports = {};
    buses.forEach((b, i) => { m.ports[`bus_${i}`] = { bind: `${b}.target_socket` }; });
  }
  return m;
}

/**
 * Overrides that open every writable disk image with snapshot=on, so the guest
 * never writes to the image file: its changes are kept in a temporary file and
 * dropped at the end. For test runs, which then leave no journal behind (K-11).
 */
function snapshotOverrides(doc) {
  const out = [];
  for (const inst of core.analyze(doc).instances) {
    if (inst.isContainer) continue;
    for (const [param, v] of Object.entries(inst.params)) {
      if (typeof v !== 'string' || !/(^|,)file=/.test(v)) continue;
      const opts = v.split(',').map((kv) => kv.split('=')[0]);
      const on = (k) => new RegExp(`(^|,)${k}=(on|true|yes|1)(,|$)`, 'i').test(v);
      if (on('readonly') || on('read-only') || on('snapshot')) continue;
      const kept = opts.includes('snapshot') ? v.replace(/(^|,)snapshot=[^,]*/, '$1snapshot=on') : `${v},snapshot=on`;
      out.push({ instance: inst.name, param, value: kept });
    }
  }
  return out;
}

/**
 * What would stop or hurt a start, without asking anyone:
 * missing: loader files that do not exist (the simulator stops: "cannot get file size");
 * locked: writable disk images another process holds (QEMU: 'Failed to get "write" lock');
 * low: disk images that are almost full (guest services fail).
 */
function preflight(doc, topDir) {
  let missing = [];
  try {
    missing = images.missingFiles(images.collect(doc, core.analyze(doc), topDir));
  } catch (e) { /* advisory */ }
  let locked = [];
  try { locked = disklock.lockedImages(doc, topDir); } catch (e) { /* Linux only */ }
  let low = [];
  try { low = diskspace.lowImages(disklock.diskImages(doc, topDir)); } catch (e) { /* advisory */ }
  return { missing, locked, low };
}

/**
 * Write <name>.generated.dts and compile it with dtc to the platform's
 * devicetree.output (or <name>.generated.dtb). Resolves { dts, dtb, notes };
 * rejects with dtc's message.
 */
async function writeDeviceTree(doc, platformFile, dtc = 'dtc') {
  const r = devicetree.generate(doc, { topDir: path.dirname(platformFile) });
  const { dts, dtb } = devicetree.outputPaths(doc, platformFile);
  await fs.promises.mkdir(path.dirname(dts), { recursive: true });
  await fs.promises.writeFile(dts, r.dts, 'utf8');
  if (typeof dtc === 'function') {
    // dtc elsewhere (the simulation host): DTS on stdin, DTB on stdout.
    const out = await dtc(['-q', '-I', 'dts', '-O', 'dtb', '-o', '-', '-'], r.dts);
    await fs.promises.writeFile(dtb, out);
    return { dts, dtb, notes: r.notes };
  }
  await new Promise((resolve, reject) => execFile(dtc, ['-q', '-I', 'dts', '-O', 'dtb', '-o', dtb, dts], (err, so, se) => {
    if (!err) return resolve();
    reject(new Error(err.code === 'ENOENT'
      ? `${dtc} not found; install the device tree compiler (Ubuntu: apt install device-tree-compiler)`
      : `dtc: ${(se || err.message).trim()}`));
  }));
  return { dts, dtb, notes: r.notes };
}

/**
 * Folders where VP Studio keeps what it builds on this machine (sim agent,
 * bundled modules), most likely first: the extension's user data folder in
 * VS Code, VSCodium and the VP Studio application (Theia), then the
 * extension folder itself (older versions, or a build by hand).
 */
function buildDirs(extensionDir, home = os.homedir()) {
  const config = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  return [
    path.join(config, 'Code', 'User', 'globalStorage', EXTENSION_ID, 'build'),
    path.join(config, 'VSCodium', 'User', 'globalStorage', EXTENSION_ID, 'build'),
    path.join(home, '.theia', 'globalStorage', EXTENSION_ID, 'build'),
    path.join(extensionDir, 'tools'),
  ];
}

/** First existing file among dirs/<sub...>, or undefined. */
function findBuilt(dirs, ...sub) {
  for (const d of dirs) {
    const f = path.join(d, ...sub);
    if (fs.existsSync(f)) return f;
  }
  return undefined;
}

/** *.model.json files under dir (not in node_modules, build or hidden folders), at most `limit`. */
function findModelSpecs(dir, limit = 200, depth = 6) {
  const out = [];
  const walk = (d, level) => {
    if (out.length >= limit || level > depth) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      if (out.length >= limit) return;
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'build' || e.name === '_deps') continue;
        walk(path.join(d, e.name), level + 1);
      } else if (e.name.endsWith('.model.json')) {
        out.push(path.join(d, e.name));
      }
    }
  };
  walk(dir, 0);
  return out;
}

/**
 * The QBox catalog plus the libraries built on this machine: VP Studio's own
 * modules (bundled: [{type, dir}], found in buildDirs) and wizard models
 * (modelSpecs, built next to their spec). Returns { catalog, clashes }.
 */
function catalogWithLocal(base, { bundled = [], dirs = [], modelSpecs = [] } = {}) {
  const loaded = [];
  for (const b of bundled) {
    const f = findBuilt(dirs, b.dir, `${b.type}.catalog.json`) || findBuilt(dirs, b.dir, 'build', `${b.type}.catalog.json`);
    if (f) loaded.push(models.loadModelCatalog(f, { bundled: true }));
  }
  for (const spec of modelSpecs) {
    try {
      const s = JSON.parse(fs.readFileSync(spec, 'utf8'));
      const f = s && typeof s.name === 'string' && models.catalogFileFor(spec, s.name);
      if (f && fs.existsSync(f)) loaded.push(models.loadModelCatalog(f));
    } catch (e) { /* a spec being written */ }
  }
  return models.merge(base, loaded);
}

module.exports = {
  SUFFIX, AGENT_INSTANCE, EXTENSION_ID,
  luaPathFor, agentModule, snapshotOverrides, preflight, writeDeviceTree,
  buildDirs, findBuilt, findModelSpecs, catalogWithLocal,
};
