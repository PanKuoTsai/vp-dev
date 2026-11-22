'use strict';
// QBox version pinning: the commit a VP Studio release was tested with
// (qbox.pin.json), the commit the simulator, the component catalog and the
// sim agent each come from, and the mismatches between them.
// No VS Code dependency; reads files only (no git process).

const fs = require('fs');
const path = require('path');

const HASH = /^[0-9a-f]{40}$/;
const short = (c) => (c ? c.slice(0, 12) : 'unknown');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return undefined; }
}

/** The pin file, checked. Throws when it is missing or malformed. */
function readPin(file) {
  const pin = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (pin.pinVersion !== 1) throw new Error(`${file}: unsupported pinVersion ${pin.pinVersion}`);
  if (!pin.qbox || !HASH.test(pin.qbox.commit || '')) throw new Error(`${file}: qbox.commit must be a full 40-character commit hash`);
  if (!Array.isArray(pin.qbox.patches)) throw new Error(`${file}: qbox.patches must be a list`);
  if (pin.libqemu !== undefined && !Array.isArray(pin.libqemu.patches)) throw new Error(`${file}: libqemu.patches must be a list`);
  return pin;
}

/** The git directory of a checkout (.git, or the one a .git file points to), or null. */
function gitDir(dir) {
  const dotgit = path.join(dir, '.git');
  let st;
  try { st = fs.statSync(dotgit); } catch (e) { return null; }
  if (st.isDirectory()) return dotgit;
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotgit, 'utf8'));
  return m ? path.resolve(dir, m[1]) : null;
}

/** Commit checked out in a git checkout, or null. Follows refs and packed-refs, and worktrees. */
function gitHead(dir) {
  const gd = gitDir(dir);
  if (!gd) return null;
  let common = gd;
  try { common = path.resolve(gd, fs.readFileSync(path.join(gd, 'commondir'), 'utf8').trim()); } catch (e) { /* not a worktree */ }
  let head;
  try { head = fs.readFileSync(path.join(gd, 'HEAD'), 'utf8').trim(); } catch (e) { return null; }
  for (let depth = 0; depth < 5; depth++) {
    if (HASH.test(head)) return head;
    const m = /^ref:\s*(\S+)$/.exec(head);
    if (!m) return null;
    const ref = m[1];
    let next = null;
    for (const base of [gd, common]) {
      try { next = fs.readFileSync(path.join(base, ref), 'utf8').trim(); break; } catch (e) { /* try the next place */ }
    }
    if (next === null) {
      try {
        const line = fs.readFileSync(path.join(common, 'packed-refs'), 'utf8').split('\n')
          .find((l) => l.endsWith(' ' + ref));
        next = line ? line.split(' ')[0] : null;
      } catch (e) { /* no packed refs */ }
    }
    if (next === null) return null;
    head = next;
  }
  return null;
}

/**
 * The QBox source and build directories of a simulator executable, from the
 * CMakeCache.txt of the build it sits in (its directory or up to two above),
 * or null when it is not in a CMake build directory.
 */
function qboxSourceOf(exePath) {
  let dir = path.dirname(path.resolve(exePath));
  for (let i = 0; i < 3; i++) {
    const cache = path.join(dir, 'CMakeCache.txt');
    let text;
    try { text = fs.readFileSync(cache, 'utf8'); } catch (e) { text = null; }
    if (text !== null) {
      const m = /^CMAKE_HOME_DIRECTORY:INTERNAL=(.*)$/m.exec(text);
      if (!m) return null;
      // libqemu's sources: build/_deps/libqemu-src, or elsewhere when QBox
      // uses a CPM source cache (CPM_SOURCE_CACHE, e.g. <qbox>/packages).
      const lq = /^libqemu_SOURCE_DIR:[A-Z]+=(.+)$/m.exec(text) || /^CPM_PACKAGE_libqemu_SOURCE_DIR:[A-Z]+=(.+)$/m.exec(text);
      return { source: m[1].trim(), build: dir, libqemu: lq ? lq[1].trim() : path.join(dir, '_deps', 'libqemu-src') };
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/** QBox commit recorded next to a sim agent library (sim_agent.json), null if not recorded, undefined if no library. */
function agentCommit(libPath) {
  if (!libPath) return undefined;
  const info = readJson(libPath.replace(/\.so$/, '') + '.json');
  return info && info.qbox && HASH.test(info.qbox.commit || '') ? info.qbox.commit : null;
}

/** Version of a sim agent library from sim_agent.json ("0.9.0"), null when not recorded (agents before 0.9.0). */
function agentVersion(libPath) {
  if (!libPath) return null;
  const info = readJson(libPath.replace(/\.so$/, '') + '.json');
  return info && typeof info.version === 'string' && /^\d+\.\d+\.\d+$/.test(info.version) ? info.version : null;
}

/** Whether version "a.b.c" is at least min; false for null. */
function versionAtLeast(version, min) {
  if (!version) return false;
  const a = version.split('.').map(Number);
  const b = min.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

/**
 * Whether a unified diff is applied to the tree at root, without git: every
 * line the patch adds is in its file. true, false, or null when a file the
 * patch changes is missing (the tree is not there, or not built yet).
 */
function patchApplied(patchText, root) {
  const files = new Map();
  const created = new Set();
  let cur = null, fromNull = false;
  for (const line of String(patchText).split('\n')) {
    if (/^--- /.test(line)) { fromNull = /^--- \/dev\/null\s*$/.test(line); continue; }
    const m = /^\+\+\+ (?:b\/)?(.+?)\s*$/.exec(line);
    if (m) { cur = m[1] === '/dev/null' ? null : m[1]; if (cur && !files.has(cur)) files.set(cur, []); if (cur && fromNull) created.add(cur); continue; }
    if (cur && line.startsWith('+') && line.slice(1).trim()) files.get(cur).push(line.slice(1).trim());
  }
  if (!files.size) return null;
  for (const [f, added] of files) {
    let text;
    try { text = fs.readFileSync(path.join(root, f), 'utf8'); } catch (e) { if (created.has(f) && fs.existsSync(root)) return false; return null; }
    const have = new Set(text.split('\n').map((l) => l.trim()));
    if (!added.every((l) => have.has(l))) return false;
  }
  return true;
}

/** "Subject:" of a patch file, or its name. */
function patchTitle(file) {
  try {
    const m = /^Subject:\s*(?:\[PATCH[^\]]*\]\s*)?(.+)$/m.exec(fs.readFileSync(file, 'utf8'));
    if (m) return m[1].trim();
  } catch (e) { /* the name then */ }
  return path.basename(file);
}

/**
 * The pinned patches and whether the simulator's QBox has them: QBox patches
 * in its source tree, libqemu patches in libqemu's sources (simulator.libqemu).
 * [{ file, target: 'qbox'|'libqemu', title, applied: true|false|null }]
 */
function patchReport(pin, studioDir, simulator) {
  if (!pin || !studioDir) return [];
  const out = [];
  const add = (list, target, root) => {
    for (const p of list || []) {
      const file = path.join(studioDir, p);
      let text = null;
      try { text = fs.readFileSync(file, 'utf8'); } catch (e) { /* missing patch file */ }
      out.push({ file: p, target, title: patchTitle(file), applied: text !== null && root ? patchApplied(text, root) : null });
    }
  };
  add(pin.qbox && pin.qbox.patches, 'qbox', simulator && simulator.source);
  add(pin.libqemu && pin.libqemu.patches, 'libqemu', simulator && (simulator.libqemu || (simulator.build && path.join(simulator.build, '_deps', 'libqemu-src'))));
  return out;
}

/**
 * Compare the pinned commit with what the simulator, catalog and agent come from.
 * input: { pin, exePath, catalog (parsed catalog or undefined), agentLib (path to the .so or undefined) }
 * Returns { pinned, simulator: {commit, source, build} | null, catalog, agent, problems: [{level, text}] }
 * level: "warning" (results may be wrong), "info" (cannot tell).
 */
function versionReport({ pin, exePath, catalog, agentLib, studioDir }) {
  const pinned = pin ? pin.qbox.commit : null;
  const problems = [];
  const where = qboxSourceOf(exePath);
  const simulator = where ? { ...where, commit: gitHead(where.source) } : null;
  const simCommit = simulator && simulator.commit;
  const catCommit = catalog && catalog.qbox && HASH.test(catalog.qbox.commit || '') ? catalog.qbox.commit : null;
  const agent = agentCommit(agentLib);

  if (!simulator) {
    problems.push({ level: 'info', text: `Cannot tell which QBox ${exePath} was built from (no CMakeCache.txt next to it).` });
  } else if (!simCommit) {
    problems.push({ level: 'info', text: `Cannot tell which QBox commit ${simulator.source} is at (not a git checkout).` });
  } else if (pinned && simCommit !== pinned) {
    problems.push({ level: 'warning', text: `The simulator comes from QBox ${short(simCommit)}, but this VP Studio was tested with QBox ${short(pinned)}.` });
  }
  if (catalog && catCommit && simCommit && catCommit !== simCommit) {
    problems.push({ level: 'warning', text: `The component catalog was made from QBox ${short(catCommit)}, not ${short(simCommit)}; module, port and parameter checks may not match this simulator. Regenerate it with tools/qbox-catalog.` });
  }
  if (agent === null) {
    problems.push({ level: 'info', text: 'The sim agent library does not record which QBox it was built against. Rebuild it with tools/sim-agent/build.sh.' });
  } else if (agent && simCommit && agent !== simCommit) {
    problems.push({ level: 'warning', text: `The sim agent was built against QBox ${short(agent)}, not ${short(simCommit)}; loading it may fail or crash the simulator. Rebuild it with tools/sim-agent/build.sh.` });
  }
  const patches = patchReport(pin, studioDir, simulator);
  for (const p of patches) {
    if (p.applied !== false) continue;
    const where = p.target === 'libqemu' ? (simulator.libqemu || `${simulator.build}/_deps/libqemu-src`) : simulator.source;
    problems.push({ level: 'warning', text: `The pinned patch ${p.file} ("${p.title}") is not applied to ${where}. Apply it with git apply there and rebuild QBox (cmake --build build), or build with tools/qbox-pin/build-qbox.sh.` });
  }
  return { pinned, simulator, catalog: catalog ? catCommit : undefined, agent, patches, problems };
}

/** Plain-text summary of a versionReport, for an output channel. */
function formatReport(r) {
  const lines = [
    `Tested QBox (qbox.pin.json): ${r.pinned || 'not pinned'}`,
    `Simulator: ${r.simulator ? `${r.simulator.commit || 'unknown commit'} (source ${r.simulator.source}, build ${r.simulator.build})` : 'unknown'}`,
    `Component catalog: ${r.catalog || (r.catalog === null ? 'no commit recorded' : 'off')}`,
    `Sim agent: ${r.agent === undefined ? 'not used' : r.agent || 'no commit recorded'}`,
  ];
  for (const p of r.patches || []) lines.push(`Patch ${p.file}: ${p.applied === true ? 'applied' : p.applied === false ? 'NOT applied' : 'cannot tell'}`);
  lines.push('', r.problems.length ? r.problems.map((p) => `${p.level === 'warning' ? 'Warning' : 'Note'}: ${p.text}`).join('\n') : 'Everything matches.');
  return lines.join('\n');
}

module.exports = { readPin, gitHead, qboxSourceOf, agentCommit, agentVersion, versionAtLeast, versionReport, formatReport, short, patchApplied, patchReport };
