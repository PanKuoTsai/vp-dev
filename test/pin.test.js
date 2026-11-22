'use strict';
// Run with: node test/pin.test.js (every file: npm test)
const { test } = require('./harness');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const pin = require('../lib/setup/pin');

const C1 = 'a'.repeat(40), C2 = 'b'.repeat(40), C3 = 'c'.repeat(40);

test('pin: bundled qbox.pin.json is valid and matches the bundled catalog', () => {
  const p = pin.readPin(path.join(__dirname, '..', 'qbox.pin.json'));
  const cat = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'catalog', 'qbox-catalog.json'), 'utf8'));
  assert.strictEqual(cat.qbox.commit, p.qbox.commit);
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'vp-pin-'));
  fs.writeFileSync(path.join(dir, 'p.json'), JSON.stringify({ pinVersion: 1, qbox: { commit: 'adfde79', patches: [] } }));
  assert.throws(() => pin.readPin(path.join(dir, 'p.json')), /40-character/);
});

test('pin: gitHead reads detached, loose, packed and worktree refs', () => {
  const os = require('os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-git-'));
  const repo = path.join(root, 'repo');
  const gd = path.join(repo, '.git');
  fs.mkdirSync(path.join(gd, 'refs', 'heads'), { recursive: true });
  fs.writeFileSync(path.join(gd, 'HEAD'), C1 + '\n');
  assert.strictEqual(pin.gitHead(repo), C1);
  fs.writeFileSync(path.join(gd, 'HEAD'), 'ref: refs/heads/main\n');
  assert.strictEqual(pin.gitHead(repo), null);
  fs.writeFileSync(path.join(gd, 'packed-refs'), `# pack-refs with: peeled\n${C2} refs/heads/main\n`);
  assert.strictEqual(pin.gitHead(repo), C2);
  fs.writeFileSync(path.join(gd, 'refs', 'heads', 'main'), C3 + '\n');
  assert.strictEqual(pin.gitHead(repo), C3);
  // A worktree: .git is a file; HEAD is in its own git dir, refs in the common one.
  const wt = path.join(root, 'wt');
  const wgd = path.join(gd, 'worktrees', 'wt');
  fs.mkdirSync(wgd, { recursive: true });
  fs.mkdirSync(wt);
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${wgd}\n`);
  fs.writeFileSync(path.join(wgd, 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(wgd, 'commondir'), '../..\n');
  assert.strictEqual(pin.gitHead(wt), C3);
  assert.strictEqual(pin.gitHead(path.join(root, 'nothing')), null);
});

test('pin: libqemu sources and patches in a CPM source cache (CPM_SOURCE_CACHE)', () => {
  const os = require('os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-cpm-'));
  const src = path.join(root, 'qbox');
  const lq = path.join(src, 'packages', 'libqemu', '0123abcd');
  fs.mkdirSync(path.join(src, 'build'), { recursive: true });
  fs.mkdirSync(lq, { recursive: true });
  fs.writeFileSync(path.join(src, 'build', 'CMakeCache.txt'),
    `CMAKE_HOME_DIRECTORY:INTERNAL=${src}\nCPM_SOURCE_CACHE:PATH=${path.join(src, 'packages')}\nlibqemu_SOURCE_DIR:STATIC=${lq}\n`);
  const where = pin.qboxSourceOf(path.join(src, 'build', 'platforms-vp'));
  assert.strictEqual(where.libqemu, lq);
  // Only CPM's own record: still found.
  fs.writeFileSync(path.join(src, 'build', 'CMakeCache.txt'), `CMAKE_HOME_DIRECTORY:INTERNAL=${src}\nCPM_PACKAGE_libqemu_SOURCE_DIR:INTERNAL=${lq}\n`);
  assert.strictEqual(pin.qboxSourceOf(path.join(src, 'build', 'platforms-vp')).libqemu, lq);
  // The patch check looks there, not in build/_deps.
  const studio = path.join(root, 'studio');
  fs.mkdirSync(path.join(studio, 'patches'), { recursive: true });
  fs.writeFileSync(path.join(lq, 'a.c'), 'int x = 1;\n');
  fs.writeFileSync(path.join(studio, 'patches', 'p.patch'), 'Subject: [PATCH] t\n---\n--- a/a.c\n+++ b/a.c\n@@ -1 +1 @@\n-int x = 0;\n+int x = 1;\n');
  const rep = pin.patchReport({ libqemu: { patches: ['patches/p.patch'] } }, studio, { ...where, build: path.join(src, 'build') });
  assert.strictEqual(rep.length, 1);
  assert.strictEqual(rep[0].target, 'libqemu');
  assert.strictEqual(rep[0].applied, true);
});

test('pin: versionReport finds the QBox of the simulator and reports mismatches', () => {
  const os = require('os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-ver-'));
  const src = path.join(root, 'qbox');
  fs.mkdirSync(path.join(src, '.git'), { recursive: true });
  fs.mkdirSync(path.join(src, 'build', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(src, '.git', 'HEAD'), C1 + '\n');
  fs.writeFileSync(path.join(src, 'build', 'CMakeCache.txt'), `# cache\nCMAKE_HOME_DIRECTORY:INTERNAL=${src}\n`);
  const exe = path.join(src, 'build', 'platforms-vp');
  assert.deepStrictEqual(pin.qboxSourceOf(path.join(src, 'build', 'bin', 'x')), { source: src, build: path.join(src, 'build'), libqemu: path.join(src, 'build', '_deps', 'libqemu-src') });
  const lib = path.join(root, 'vp_sim_agent.so');
  const p = { pinVersion: 1, qbox: { commit: C1, patches: [] } };

  // All the same: nothing to report.
  fs.writeFileSync(path.join(root, 'vp_sim_agent.json'), JSON.stringify({ qbox: { commit: C1 } }));
  let r = pin.versionReport({ pin: p, exePath: exe, catalog: { qbox: { commit: C1 } }, agentLib: lib });
  assert.deepStrictEqual(r.problems, []);
  assert.strictEqual(r.simulator.commit, C1);
  assert.match(pin.formatReport(r), /Everything matches/);

  // Simulator moved on: pin, catalog and agent all differ from it.
  fs.writeFileSync(path.join(src, '.git', 'HEAD'), C2 + '\n');
  r = pin.versionReport({ pin: p, exePath: exe, catalog: { qbox: { commit: C1 } }, agentLib: lib });
  assert.deepStrictEqual(r.problems.map((x) => x.level), ['warning', 'warning', 'warning']);
  assert.match(r.problems[0].text, /QBox bbbbbbbbbbbb, but .* tested with QBox aaaaaaaaaaaa/);
  assert.match(r.problems[1].text, /catalog was made from QBox aaaaaaaaaaaa/);
  assert.match(r.problems[2].text, /sim agent was built against QBox aaaaaaaaaaaa/);

  // Agent without a record, catalog off, no agent: notes only where it cannot tell.
  fs.unlinkSync(path.join(root, 'vp_sim_agent.json'));
  r = pin.versionReport({ pin: { pinVersion: 1, qbox: { commit: C2, patches: [] } }, exePath: exe, catalog: undefined, agentLib: lib });
  assert.deepStrictEqual(r.problems.map((x) => x.level), ['info']);
  assert.match(r.problems[0].text, /does not record/);
  r = pin.versionReport({ pin: p, exePath: path.join(root, 'elsewhere', 'platforms-vp'), catalog: undefined, agentLib: undefined });
  assert.deepStrictEqual(r.problems.map((x) => x.level), ['info']);
  assert.match(pin.formatReport(r), /Simulator: unknown[\s\S]*Component catalog: off[\s\S]*Sim agent: not used/);
});

test('pin: whether the pinned patches are applied, without git', () => {
  const pin = require('../lib/setup/pin');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-patch-'));
  fs.mkdirSync(path.join(root, 'hw'));
  const patch = 'Subject: [PATCH] t\n---\n--- a/hw/x.c\n+++ b/hw/x.c\n@@ -1,2 +1,3 @@\n int a;\n+int marker = 1;\n-old();\n+  new();\n';
  fs.writeFileSync(path.join(root, 'hw', 'x.c'), 'int a;\nold();\n');
  assert.strictEqual(pin.patchApplied(patch, root), false);
  fs.writeFileSync(path.join(root, 'hw', 'x.c'), 'int a;\nint marker = 1;\n  new();\n');
  assert.strictEqual(pin.patchApplied(patch, root), true);
  assert.strictEqual(pin.patchApplied(patch, path.join(root, 'nope')), null);
  // The pinned libqemu patch adds the marker the agent looks for.
  const p = pin.readPin(path.join(__dirname, '..', 'qbox.pin.json'));
  assert.deepStrictEqual(p.libqemu.patches, ['patches/libqemu/0001-register-device-vmstate.patch']);
  const text = fs.readFileSync(path.join(__dirname, '..', p.libqemu.patches[0]), 'utf8');
  assert.match(text, /^\+int libqemu_device_vmstate = 1;$/m);
  const agent = fs.readFileSync(path.join(__dirname, '..', 'tools', 'sim-agent', 'sim_agent.cc'), 'utf8');
  assert.ok(agent.includes('dlsym(h, "libqemu_device_vmstate")'));
  // The patches ship in the .vsix (build-qbox.sh and Check QBox Version read them there).
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', '.vscodeignore'), 'utf8'), /^patches/m);
});
