'use strict';
// Run with: node test/qboxsetup.test.js (every file: npm test)
const { test } = require('./harness');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

test('Build QBox, first build: QBox folder, CPM source cache and build-qbox.sh arguments', () => {
  const qs = require('../lib/setup/qboxsetup');
  const os = require('os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-qbox-setup-'));
  try {
    const q = path.join(root, 'qbox');
    fs.mkdirSync(path.join(q, 'systemc-components'), { recursive: true });
    fs.writeFileSync(path.join(q, 'CMakePresets.json'), '{}');
    const other = path.join(root, 'notes');
    fs.mkdirSync(other); fs.writeFileSync(path.join(other, 'a.txt'), 'x');
    assert.strictEqual(qs.folderKind(q), 'qbox');
    assert.strictEqual(qs.folderKind(path.join(root, 'new')), 'empty');
    assert.strictEqual(qs.folderKind(other), 'other');
    // The folder vpStudio.executable points into comes first, then QBox workspace folders, no duplicates.
    const c = qs.sourceCandidates(path.join(q, 'build', 'platforms-vp'), [q, other]);
    assert.deepStrictEqual(c.map((x) => [x.dir, x.kind]), [[q, 'qbox']]);
    assert.deepStrictEqual(qs.sourceCandidates(path.join(root, 'fresh', 'build', 'platforms-vp'), [q]).map((x) => x.kind), ['empty', 'qbox']);
    // Cache choices: none and choose always; Packages (found by QBox), the environment and a lower-case packages folder when there.
    assert.deepStrictEqual(qs.cacheChoices(q, '').map((x) => x.id), ['none', 'choose']);
    fs.mkdirSync(path.join(q, 'packages'));
    assert.deepStrictEqual(qs.cacheChoices(q, '/cache/cpm').map((x) => [x.id, x.dir]), [['env', '/cache/cpm'], ['packages', path.join(q, 'packages')], ['none', null], ['choose', undefined]]);
    // Only QBox is built here: no catalog, no sim agent.
    assert.deepStrictEqual(qs.buildArgs({ script: '/s/build-qbox.sh', src: q }), ['/s/build-qbox.sh', '--no-catalog', '--no-agent', q]);
    assert.deepStrictEqual(qs.buildArgs({ script: 's', src: q, cache: '/c', targets: 'aarch64', jobs: 4 }), ['s', '--no-catalog', '--no-agent', '--jobs', '4', '--targets', 'aarch64', '--cpm-cache', '/c', q]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  // The script takes the options.
  const sh = fs.readFileSync(path.join(__dirname, '..', 'tools', 'qbox-pin', 'build-qbox.sh'), 'utf8');
  assert.ok(sh.includes('--cpm-cache) cpm="$2"') && sh.includes('--no-agent) agent=0') && sh.includes('-DCPM_SOURCE_CACHE='));
  // build-info.json goes into the build folder, and DEST/vp-studio is made only
  // for the agent or the catalog: Build QBox (--no-agent --no-catalog) leaves no
  // untracked folder in the QBox source tree (2026-11-21).
  assert.ok(sh.includes('"$dest/build/vp-studio-build-info.json"') && !sh.includes('$out/build-info.json'));
  assert.ok(sh.includes('if [ "$agent" = 1 ] || [ "$catalog" = 1 ]; then mkdir -p "$out"; fi'));
  assert.ok(!/^mkdir -p "\$out"$/m.test(sh));
  const ex = fs.readFileSync(path.join(__dirname, '..', 'tools', 'container', 'extract.sh'), 'utf8');
  assert.ok(ex.includes('/opt/qbox/build/vp-studio-build-info.json'));
});

test('QBox patch 0002: VP Studio components as a patch, registered in the pin, detected applied or not', () => {
  const pinLib = require('../lib/setup/pin');
  const qs = require('../lib/setup/qboxsetup');
  const os = require('os');
  const pin = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'qbox.pin.json'), 'utf8'));
  const rel = 'patches/qbox/0002-vp-studio-probes-debug-dap.patch';
  assert.ok(pin.qbox.patches.includes(rel));
  for (const p of pin.qbox.patches.concat(pin.libqemu.patches)) assert.ok(fs.existsSync(path.join(__dirname, '..', p)), p);
  const text = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  for (const f of ['probes/include/probes.h', 'probes/src/probes.cc', 'debug_dap/include/debug_dap.h', 'debug_dap/src/debug_dap.cc']) assert.ok(text.includes('+++ b/systemc-components/' + f), f);
  assert.ok(text.includes('+add_subdirectory(probes)') && text.includes('+add_subdirectory(debug_dap)'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-patch-'));
  try {
    const q = path.join(root, 'qbox');
    fs.mkdirSync(path.join(q, 'systemc-components'), { recursive: true });
    fs.writeFileSync(path.join(q, 'CMakePresets.json'), '{}');
    fs.writeFileSync(path.join(q, 'systemc-components', 'CMakeLists.txt'), 'add_subdirectory(uart)\n');
    // A clean QBox: the files the patch creates are missing, so "not applied" (was "unknown").
    assert.strictEqual(pinLib.patchApplied(text, q), false);
    const mini = '--- a/x.txt\n+++ b/x.txt\n@@\n+added line\n--- /dev/null\n+++ b/new/y.txt\n@@\n+new file line\n';
    fs.writeFileSync(path.join(q, 'x.txt'), 'added line\n');
    assert.strictEqual(pinLib.patchApplied(mini, q), false);
    fs.mkdirSync(path.join(q, 'new')); fs.writeFileSync(path.join(q, 'new', 'y.txt'), 'new file line\n');
    assert.strictEqual(pinLib.patchApplied(mini, q), true);
    // Build QBox: with the patch in the pin, a QBox without the components still builds the agent when the patches are applied.
    const st = qs.inspect(q, { pin });
    assert.strictEqual(st.hasProbes, false);
    assert.strictEqual(st.probesPatch, true);
    const f = qs.defaults(st, pin, 4, {});
    assert.strictEqual(f.agent, true);
    const agentWarn = (form) => qs.check(form, st).warnings.filter((w) => /VP Studio components/.test(w));
    assert.deepStrictEqual(agentWarn(f), []);
    assert.ok(/turn on "Apply the patches"/.test(agentWarn(Object.assign({}, f, { patches: false }))[0]));
    // The agent is built against the QBox VP Studio uses: warn when that is another one and this one is not taken.
    const other = { simulator: '/elsewhere/build/platforms-vp' };
    assert.ok(qs.check(Object.assign({}, f, { useForSim: false }), st, other).warnings.some((w) => /not built/.test(w)));
    assert.ok(!qs.check(Object.assign({}, f, { useForSim: true }), st, other).warnings.some((w) => /not built/.test(w)));
    assert.ok(!qs.check(Object.assign({}, f, { useForSim: false }), st, { simulator: path.join(q, 'build', 'platforms-vp') }).warnings.some((w) => /not built/.test(w)));
    const empty = qs.inspect(path.join(root, 'new-clone'), { pin });
    assert.strictEqual(qs.defaults(empty, pin, 4, {}).agent, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('QBox patch 0003: the perf models, registered after 0002, away from 0002\'s lines', () => {
  const pin = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'qbox.pin.json'), 'utf8'));
  const rel = 'patches/qbox/0003-vp-studio-perf-models.patch';
  assert.ok(pin.qbox.patches.indexOf(rel) > pin.qbox.patches.indexOf('patches/qbox/0002-vp-studio-probes-debug-dap.patch'));
  const text = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  assert.match(text, /^From: VP Studio\nSubject: \[PATCH\] systemc-components: add VP Studio's perf models\n/);
  for (const f of ['perf/CMakeLists.txt', 'perf/README.md', 'perf/include/perf.h', 'perf/src/perf.cc']) assert.ok(text.includes('+++ b/systemc-components/' + f), f);
  for (const t of ['traffic_gen', 'at_bus', 'dram_ctrl', 'perf_stats']) assert.ok(text.includes(`GSC_MODULE_REGISTER_C(${t})`), t);
  // The CMakeLists line goes at the end of the file, more than 3 lines from 0002's: build-qbox.sh
  // recognises an applied patch with "git apply --reverse --check", which needs each patch's context intact.
  const hunk = /\+\+\+ b\/systemc-components\/CMakeLists\.txt\n(@@[^\n]*\n(?:[ +-][^\n]*\n)+)/.exec(text)[1];
  assert.ok(hunk.includes('+add_subdirectory(perf)') && !/probes|debug_dap|realtimelimiter/.test(hunk));
  // The catalog knows the types, from perf.so.
  const cat = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'catalog', 'qbox-catalog.json'), 'utf8'));
  for (const t of ['traffic_gen', 'at_bus', 'dram_ctrl', 'perf_stats']) assert.strictEqual(cat.modules[t].library, 'perf.so', t);
  assert.deepStrictEqual(cat.modules.at_bus.introspection.ports.map((p) => [p.name, p.kind]), [['target_socket', 'tlm_target'], ['initiator_socket', 'tlm_initiator']]);
  assert.ok(cat.modules.dram_ctrl.introspection.params.some((p) => p.name === 'scheduler' && p.default === 'fr_fcfs'));
  // Add Module writes the library: the types are not named like it.
  assert.deepStrictEqual(require('../lib/platform/modules').moduleDef(cat, 'traffic_gen'), { type: 'traffic_gen', dylib: 'perf' });
  // perf 1.1.0: QoS per master on at_bus, priority scheduling in dram_ctrl; perf.so and lib/analysis/qos.js know the same keys.
  assert.ok(cat.modules.at_bus.introspection.params.some((p) => p.name === 'masters' && p.default === ''));
  assert.ok(cat.modules.dram_ctrl.introspection.params.some((p) => p.name === 'qos' && p.default === false));
  assert.match(text, /PERF_VERSION "1\.2\.0"/);
  // perf 1.2.0: a crossbar, and buses behind buses.
  assert.ok(cat.modules.at_bus.introspection.params.some((p) => p.name === 'topology' && p.default === 'shared'));
  assert.ok(cat.modules.at_bus.introspection.params.some((p) => p.name === 'input_queue' && p.default === 1));
  for (const k of Object.keys(require('../lib/analysis/qos').KEYS)) assert.ok(text.includes(`k == "${k}"`), k);
});

test('Build QBox: CMake Tools configuring QBox by itself, and turning it off', () => {
  const qs = require('../lib/setup/qboxsetup');
  const os = require('os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-qbox-cmt-'));
  try {
    const q = path.join(root, 'qbox');
    fs.mkdirSync(path.join(q, 'systemc-components'), { recursive: true });
    fs.writeFileSync(path.join(q, 'CMakePresets.json'), '{}');
    // Not installed: nothing to say.
    assert.strictEqual(qs.cmakeTools(q, {}), null);
    assert.strictEqual(qs.inspect(q, {}).cmakeTools, null);
    // Installed, no settings: all three default to true.
    const a = qs.cmakeTools(q, { installed: true });
    assert.deepStrictEqual(a.auto, qs.CMAKE_TOOLS_OFF);
    assert.strictEqual(a.configuredBy, false);
    // User settings count unless the folder overrides them.
    assert.deepStrictEqual(qs.cmakeTools(q, { installed: true, user: { 'cmake.configureOnOpen': false } }).auto, ['cmake.automaticReconfigure', 'cmake.configureOnEdit']);
    fs.mkdirSync(path.join(q, '.vscode'));
    const f = path.join(q, '.vscode', 'settings.json');
    fs.writeFileSync(f, '{\n    // mine\n    "a.b": "x//y",\n    "cmake.configureOnOpen": true,\n}\n');
    assert.deepStrictEqual(qs.parseSettings(fs.readFileSync(f, 'utf8')), { 'a.b': 'x//y', 'cmake.configureOnOpen': true });
    assert.strictEqual(qs.cmakeTools(q, { installed: true, user: { 'cmake.configureOnOpen': false } }).auto[0], 'cmake.configureOnOpen');
    // A file with comments is not rewritten.
    assert.throws(() => qs.cmakeToolsOffText(fs.readFileSync(f, 'utf8')), /comments/);
    // Turning off: keeps other settings, sets existing keys and adds the others.
    const t = qs.cmakeToolsOffText('{\n    "vpStudio.platformView.openBeside": false,\n    "cmake.configureOnOpen": true\n}\n');
    assert.deepStrictEqual(JSON.parse(t), { 'vpStudio.platformView.openBeside': false, 'cmake.configureOnOpen': false, 'cmake.automaticReconfigure': false, 'cmake.configureOnEdit': false });
    assert.ok(t.includes('\n    "cmake.configureOnEdit": false'));
    assert.deepStrictEqual(JSON.parse(qs.cmakeToolsOffText('')), { 'cmake.configureOnOpen': false, 'cmake.automaticReconfigure': false, 'cmake.configureOnEdit': false });
    fs.writeFileSync(f, qs.cmakeToolsOffText(''));
    assert.deepStrictEqual(qs.cmakeTools(q, { installed: true }).auto, []);
    // A build directory CMake Tools configured, while it still would: one warning saying so.
    fs.writeFileSync(f, '{}');
    fs.mkdirSync(path.join(q, 'build', '.cmake', 'api', 'v1', 'query', 'client-vscode'), { recursive: true });
    const st = qs.inspect(q, { cmakeTools: { installed: true } });
    assert.strictEqual(st.cmakeTools.configuredBy, true);
    const w = qs.check({ src: q, targets: ['aarch64'], cache: { mode: 'none' }, patches: true, checkout: false, agent: false }, st).warnings.filter((x) => /CMake Tools/.test(x));
    assert.strictEqual(w.length, 1);
    assert.ok(/has configured this build directory before/.test(w[0]));
    fs.writeFileSync(f, qs.cmakeToolsOffText('{}'));
    assert.ok(!qs.check({ src: q, targets: ['aarch64'], cache: { mode: 'none' }, patches: true, checkout: false, agent: false }, qs.inspect(q, { cmakeTools: { installed: true } })).warnings.some((x) => /CMake Tools/.test(x)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Build QBox view: what the build directory was configured with, defaults that change nothing, checks', () => {
  const qs = require('../lib/setup/qboxsetup');
  const os = require('os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-qbox-view-'));
  try {
    const q = path.join(root, 'qbox');
    fs.mkdirSync(path.join(q, 'systemc-components'), { recursive: true });
    fs.mkdirSync(path.join(q, 'packages'));
    fs.writeFileSync(path.join(q, 'CMakePresets.json'), JSON.stringify({ configurePresets: [
      { name: '_base', hidden: true }, { name: 'gcc', displayName: 'GCC (Release, Make)' }, { name: 'gcc-debug' }, { name: 'clang' }, { name: 'mac' }, { name: 'win-gcc' }] }));
    assert.deepStrictEqual(qs.presets(q).map((p) => p.name), ['gcc', 'gcc-debug', 'clang']);
    // Not configured yet: the pin decides.
    const pin = { qbox: { commit: 'a'.repeat(40), patches: [] }, build: { preset: 'gcc', libqemuTargets: ['aarch64', 'riscv64'] } };
    let st = qs.inspect(q, { pin, studioDir: root });
    assert.strictEqual(st.cache.configured, false);
    let f = qs.defaults(st, pin, 4);
    assert.deepStrictEqual([f.preset, f.targets, f.cache.mode, f.checkout, f.patches], ['gcc', ['aarch64', 'riscv64'], 'none', false, true]);
    // No VP Studio components in this QBox: the sim agent (linked to probes.so) is not built by default, and asking for it warns.
    assert.deepStrictEqual([st.hasProbes, f.agent], [false, false]);
    assert.ok(/cannot be built/.test(qs.check(Object.assign({}, f, { agent: true }), st).warnings.join(' ')));
    fs.mkdirSync(path.join(q, 'systemc-components', 'probes'));
    assert.strictEqual(qs.defaults(qs.inspect(q, { pin, studioDir: root }), pin, 4).agent, true);
    // Configured (as the user's QBox): aarch64 only, a lower-case packages cache, GCC Release.
    fs.mkdirSync(path.join(q, 'build'));
    fs.writeFileSync(path.join(q, 'build', 'CMakeCache.txt'), [
      'CMAKE_BUILD_TYPE:STRING=Release', 'CMAKE_CXX_COMPILER:FILEPATH=/usr/lib/ccache/c++', 'LIBQEMU_TARGETS:UNINITIALIZED=aarch64',
      `CPM_SOURCE_CACHE:PATH=${path.join(q, 'packages')}`, 'CMAKE_GENERATOR:INTERNAL=Unix Makefiles'].join('\n'));
    st = qs.inspect(q, { pin, studioDir: root });
    assert.deepStrictEqual([st.cache.compiler, st.cache.buildType, st.cache.targets, st.cache.preset], ['gcc', 'Release', ['aarch64'], 'gcc']);
    f = qs.defaults(st, pin, 4);
    // Defaults are the configured settings, so Build changes nothing (no rebuild of other targets).
    assert.deepStrictEqual([f.preset, f.targets, f.cache.mode, f.cache.dir], ['gcc', ['aarch64'], 'packages', path.join(q, 'packages')]);
    assert.deepStrictEqual(qs.check(f, st), { errors: [], warnings: [], changes: [] });
    assert.deepStrictEqual(qs.argsFor(f, 'b.sh'), ['b.sh', '--no-catalog', '--no-agent', '--jobs', '4', '--preset', 'gcc', '--targets', 'aarch64', '--cpm-cache', path.join(q, 'packages'), '--no-checkout', q]);
    // Changes are listed; a compiler change is refused (CMake cannot do it in place).
    const g = Object.assign({}, f, { targets: ['aarch64', 'riscv64'], preset: 'gcc-debug', cache: { mode: 'none', dir: null } });
    const c = qs.check(g, st);
    assert.deepStrictEqual(c.errors, []);
    assert.strictEqual(c.changes.length, 3);
    assert.ok(/QEMU targets aarch64 → aarch64, riscv64/.test(c.changes.join(' ')) && /Release → Debug/.test(c.changes.join(' ')) && /package cache .* → none/.test(c.changes.join(' ')));
    assert.ok(/cannot change the compiler/.test(qs.check(Object.assign({}, f, { preset: 'clang' }), st).errors[0]));
    assert.ok(/at least one QEMU target/.test(qs.check(Object.assign({}, f, { targets: [] }), st).errors[0]));
    assert.ok(/patches are not applied/.test(qs.check(Object.assign({}, f, { patches: false }), st).warnings[0]));
    // Not at the pinned commit: a warning; checking out over local changes: refused.
    const other = Object.assign({}, st, { head: 'b'.repeat(40), pinned: 'a'.repeat(40), atPin: false, dirty: true });
    assert.ok(/not the pinned/.test(qs.check(f, other).warnings[0]));
    assert.ok(/commit or stash/.test(qs.check(Object.assign({}, f, { checkout: true }), other).errors[0]));
    const a2 = qs.argsFor(Object.assign({}, f, { checkout: true, patches: false }), 'b.sh');
    assert.ok(a2.includes('--no-patches') && !a2.includes('--no-checkout') && a2[a2.length - 1] === q);
    // QBox's own Packages folder is not passed (QBox uses it by itself).
    assert.strictEqual(qs.cacheDir({ src: q, cache: { mode: 'Packages', dir: path.join(q, 'Packages') } }), null);
    assert.strictEqual(qs.commandLine(['bash', "/a b/it's"]), "bash '/a b/it'\\''s'");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Build QBox view: the page script compiles, no style attributes, stable ids', () => {
  const html = require('../lib/webview/qboxview').render('N3', 'x');
  const scripts = [...html.matchAll(/<script nonce="N3">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length === 1);
  assert.doesNotThrow(() => new Function(scripts[0]));
  assert.ok(!/<[^>]+\sstyle=/.test(html));
  for (const id of ['src', 'src-browse', 'checkout', 'preset', 'targets', 'jobs', 'cache', 'cache-dir', 'cache-browse', 'patches', 'plist', 'agent', 'useForSim', 'msgs', 'cmd', 'build', 'move']) {
    assert.ok(html.includes(`id="${id}"`), id);
  }
  assert.ok(html.includes("post({ type: 'ready' })") && html.includes("post({ type: 'build' })"));
});

test('Build QBox: host packages from check-deps.sh stop the build, with the apt command', () => {
  const qs = require('../lib/setup/qboxsetup');
  const os = require('os');
  const cp = require('child_process');
  const tsv = 'ok\tcmake\tcmake\t\nmissing\tlibzip\tlibzip-dev\t\nold\tcmake\tcmake\tversion 3.16; QBox\'s presets need 3.21 or newer\n'
    + 'missing\tsdl2\tlibsdl2-dev\t--enable-sdl\nmissing\tlibzip\tlibzip-dev\t\ndistro\tubuntu\tdebian\n';
  const d = qs.parseDeps(tsv);
  assert.strictEqual(d.items.length, 5);
  assert.deepStrictEqual(d.missing.map((i) => i.what), ['libzip', 'cmake', 'sdl2', 'libzip']);
  assert.deepStrictEqual(d.packages, ['libzip-dev', 'cmake', 'libsdl2-dev']);
  assert.strictEqual(d.install, 'sudo apt install libzip-dev cmake libsdl2-dev');
  // Not Debian or Ubuntu: no apt command.
  assert.strictEqual(qs.parseDeps('missing\tlibzip\tlibzip-dev\t\ndistro\tfedora\t\n').install, null);
  assert.strictEqual(qs.parseDeps('ok\tgit\tgit\t\ndistro\tubuntu\tdebian\n').install, null);
  // check(): an error (Build stays off) that names the packages and the command.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-deps-'));
  try {
    const form = { src: tmp, preset: 'gcc', targets: ['aarch64'], cache: { mode: 'none' }, patches: true, agent: false, useForSim: true };
    const st = qs.inspect(tmp);
    const c = qs.check(form, st, { deps: d });
    const e = c.errors.find((x) => /^This host lacks/.test(x));
    assert.ok(e && e.includes('libzip (libzip-dev)') && e.includes('sudo apt install libzip-dev cmake libsdl2-dev') && e.includes('presets need 3.21'), e);
    assert.ok(!qs.check(form, st, { deps: qs.parseDeps('ok\tgit\tgit\t\n') }).errors.some((x) => /host lacks/.test(x)));
    assert.ok(!qs.check(form, st, { deps: null }).errors.some((x) => /host lacks/.test(x)));
    // Build Anyway passes --no-deps-check.
    assert.ok(qs.argsFor(form, 'b.sh', { skipDeps: true }).includes('--no-deps-check'));
    assert.ok(!qs.argsFor(form, 'b.sh').includes('--no-deps-check'));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  // The script: every line in the format above, exit code 1 when something is
  // missing (no pkg-config modules found), and build-qbox.sh runs it.
  const script = path.join(__dirname, '..', 'tools', 'qbox-pin', 'check-deps.sh');
  const r = cp.spawnSync('bash', [script, '--tsv', '--preset', 'clang-lto'], { encoding: 'utf8', env: Object.assign({}, process.env, { PKG_CONFIG_LIBDIR: '/nonexistent', PKG_CONFIG_PATH: '' }) });
  assert.strictEqual(r.status, 1, r.stderr);
  const p = qs.parseDeps(r.stdout);
  assert.ok(r.stdout.trim().split('\n').every((l) => /^(ok|missing|old|distro)\t/.test(l)), r.stdout);
  for (const w of ['libelf', 'libzip', 'glib-2.0', 'pixman-1', 'slirp', 'sdl2', 'epoxy', 'libjpeg', 'virglrenderer']) assert.ok(p.missing.some((i) => i.what === w), w);
  for (const w of ['cmake', 'git', 'make', 'clang', 'clang++', 'ld.lld', 'libfdt.h', 'asio.hpp', 'python3 venv']) assert.ok(p.items.some((i) => i.what === w), w);
  assert.ok(!p.items.some((i) => i.what === 'gcc'));
  const human = cp.spawnSync('bash', [script], { encoding: 'utf8', env: Object.assign({}, process.env, { PKG_CONFIG_LIBDIR: '/nonexistent', PKG_CONFIG_PATH: '' }) });
  assert.strictEqual(human.status, 1);
  assert.ok(/libzip  \(package libzip-dev\)/.test(human.stderr), human.stderr);
  const sh = fs.readFileSync(path.join(__dirname, '..', 'tools', 'qbox-pin', 'build-qbox.sh'), 'utf8');
  assert.ok(sh.includes('bash "$here/check-deps.sh" --preset "$preset" || exit 1') && sh.includes('--no-deps-check) depscheck=0'));
  // Checked before cloning.
  assert.ok(sh.indexOf('check-deps.sh" --preset "$preset"') < sh.indexOf('git -C "$dest" init'));
  const html = require('../lib/webview/qboxview').render('n', 'c');
  for (const id of ['deps-actions', 'deps-copy', 'deps-again', 'deps-skip']) assert.ok(html.includes(`id="${id}"`), id);
  assert.ok(html.includes("post({ type: 'build', skipDeps: true })"));
});

test('tutorial: Create Tutorial Workspace checks the Ubuntu files, copies the tutorial and writes its platform', () => {
  const tut = require('../lib/setup/tutorial');
  const core = require('../lib/platform/core');
  const os = require('os');
  const qbox = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-tut-'));
  try {
    const art = path.join(qbox, 'platforms', 'ubuntu', 'fw', 'Artifacts');
    fs.mkdirSync(art, { recursive: true });
    let st = tut.inspect(qbox);
    assert.strictEqual(st.ok, false);
    assert.deepStrictEqual(st.missing, ['fw/arm64_bootloader.lua', 'Image.bin', 'image_ext4.img', 'image_ext4_initrd.img', 'ubuntu.dtb']);
    for (const f of ['Image.bin', 'image_ext4.img', 'image_ext4_initrd.img', 'ubuntu.dtb', 'vmlinux-5.15.0-203-generic']) fs.writeFileSync(path.join(art, f), 'x');
    fs.writeFileSync(path.join(qbox, 'platforms', 'ubuntu', 'fw', 'arm64_bootloader.lua'), '');
    st = tut.inspect(qbox);
    assert.strictEqual(st.ok, true);
    assert.strictEqual(st.vmlinux, path.join(art, 'vmlinux-5.15.0-203-generic'));
    assert.deepStrictEqual(tut.existing(qbox), []);
    const templateDir = path.join(__dirname, '..', 'templates', 'tutorial');
    const ubuntu = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'templates', 'ubuntu-aarch64.platform.json'), 'utf8'));
    const made = tut.create(templateDir, ubuntu, qbox, { vmlinux: st.vmlinux });
    assert.strictEqual(made.platformFile, path.join(qbox, 'platforms', 'ubuntu', 'vplogger-tutorial.platform.json'));
    const doc = JSON.parse(fs.readFileSync(made.platformFile, 'utf8'));
    assert.strictEqual(doc.name, 'vplogger-tutorial');
    assert.strictEqual(doc.$schema, undefined);
    assert.deepStrictEqual(doc.debug.symbols, ['${TOP}fw/Artifacts/vmlinux-5.15.0-203-generic']);
    assert.deepStrictEqual(doc.modules, ubuntu.modules); // the Ubuntu platform itself, unchanged
    for (const f of ['TUTORIAL.md', 'install-vplogger.sh', 'ci/vplogger-ci.sh', 'vplogger/vplogger.c', 'vplogger/build.sh',
      'vplogger/bin/vplogger-bug', 'vplogger/bin/vplogger-fix1', 'vplogger/bin/vplogger-fix2',
      'perf/logger-ddr.platform.json', 'perf/logger-ddr.perfsweep.json', 'perf/vplogger-fix1.replay.csv', 'perf/vplogger-fix2.replay.csv']) {
      assert.ok(made.copied.includes(f.split('/').join(path.sep)), f);
    }
    for (const f of ['install-vplogger.sh', 'ci/vplogger-ci.sh', 'vplogger/bin/vplogger-fix2']) assert.ok(fs.statSync(path.join(made.folder, f)).mode & 0o100, f);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(made.folder, 'perf', 'logger-ddr.platform.json'), 'utf8')).$schema, undefined);
    assert.deepStrictEqual(tut.existing(qbox).map((p) => path.basename(p)), ['vplogger-tutorial.platform.json', 'vplogger-tutorial']);
    assert.deepStrictEqual(tut.sourceMap(made.folder), { '/vplogger': path.join(made.folder, 'vplogger') });
    // No vmlinux: no debug.symbols.
    assert.strictEqual(tut.platform(ubuntu, { dir: '/x' }).debug, ubuntu.debug);
  } finally { fs.rmSync(qbox, { recursive: true, force: true }); }
  // The shipped programs carry no path of the machine they were built on.
  for (const f of ['vplogger-bug', 'vplogger-fix1', 'vplogger-fix2']) {
    const b = fs.readFileSync(path.join(__dirname, '..', 'templates', 'tutorial', 'vplogger', 'bin', f)).toString('latin1');
    assert.ok(!/\/home\/|\/Users\//.test(b), f);
    assert.ok(b.includes('/vplogger'), f);
  }
  // The scripts are valid shell; the model's sweep and platform belong together.
  const cp = require('child_process');
  for (const f of ['install-vplogger.sh', 'ci/vplogger-ci.sh', 'vplogger/build.sh']) {
    assert.strictEqual(cp.spawnSync('bash', ['-n', path.join(__dirname, '..', 'templates', 'tutorial', f)]).status, 0, f);
  }
  const sweep = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'templates', 'tutorial', 'perf', 'logger-ddr.perfsweep.json'), 'utf8'));
  assert.strictEqual(sweep.platform, 'logger-ddr.platform.json');
  const perfDoc = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'templates', 'tutorial', 'perf', 'logger-ddr.platform.json'), 'utf8'));
  assert.deepStrictEqual(core.analyze(perfDoc).problems.filter((p) => p.level === 'error'), []);
});
