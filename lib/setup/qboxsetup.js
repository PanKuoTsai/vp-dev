'use strict';
// Build QBox from VP Studio: what a QBox folder and its build directory are
// (commit, patches, configuration, products), the settings of a build, and
// the arguments of tools/qbox-pin/build-qbox.sh. The Build QBox view
// (lib/webview/qboxview.js) shows these. No VS Code dependency.

const fs = require('fs');
const path = require('path');
const pinLib = require('./pin');
const jsonedit = require('../platform/jsonedit');

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } };
const isEmptyDir = (p) => { try { return fs.readdirSync(p).length === 0; } catch (e) { return false; } };
const mtime = (p) => { try { return fs.statSync(p).mtimeMs; } catch (e) { return null; } };

/**
 * What a folder is: 'qbox' (a QBox source tree: CMakePresets.json and
 * systemc-components), 'empty' (missing or empty: the pinned QBox is cloned
 * into it), or 'other'.
 */
function folderKind(dir) {
  if (!dir) return 'other';
  if (!isDir(dir) || isEmptyDir(dir)) return 'empty';
  if (fs.existsSync(path.join(dir, 'CMakePresets.json')) && isDir(path.join(dir, 'systemc-components'))) return 'qbox';
  return 'other';
}

/**
 * Folders to offer as the QBox source, most likely first, without duplicates:
 * the one the simulator setting points into (<src>/build/platforms-vp), then
 * the workspace folders that are QBox trees. [{ dir, kind, why }]
 */
function sourceCandidates(exePath, folders = []) {
  const out = [];
  const add = (dir, why) => {
    const d = path.resolve(dir);
    if (out.some((c) => c.dir === d)) return;
    out.push({ dir: d, kind: folderKind(d), why });
  };
  if (exePath) {
    const build = path.dirname(exePath);
    if (path.basename(build) === 'build') add(path.dirname(build), 'where vpStudio.executable expects QBox');
  }
  for (const f of folders) if (folderKind(f) === 'qbox') add(f, 'workspace folder');
  return out;
}

/**
 * Choices for the CPM source cache. env: the CPM_SOURCE_CACHE environment
 * variable (or ''). [{ id, label, detail, dir (null: no cache, undefined: choose) }].
 */
function cacheChoices(src, env = '') {
  const out = [];
  const packagesUpper = src ? path.join(src, 'Packages') : null;
  const packagesLower = src ? path.join(src, 'packages') : null;
  if (packagesUpper && isDir(packagesUpper)) {
    out.push({ id: 'Packages', label: packagesUpper, detail: 'QBox finds this folder by itself and keeps the dependencies\' sources there', dir: packagesUpper });
  }
  if (env) out.push({ id: 'env', label: env, detail: 'from the CPM_SOURCE_CACHE environment variable', dir: env });
  if (packagesLower && isDir(packagesLower) && packagesLower !== packagesUpper) {
    out.push({ id: 'packages', label: packagesLower, detail: 'an existing packages folder (lower case: QBox does not find it by itself)', dir: packagesLower });
  }
  out.push({ id: 'none', label: 'No package cache', detail: 'download the dependencies into build/_deps (QBox\'s default)', dir: null });
  out.push({ id: 'choose', label: 'Choose a folder…', detail: 'keep the dependencies\' sources in a folder of your choice (shared by several QBox builds)', dir: undefined });
  return out;
}

/** QBox's configure presets for Linux: [{ name, label }] (hidden, macOS and Windows ones left out). */
function presets(src) {
  let d;
  try { d = JSON.parse(fs.readFileSync(path.join(src, 'CMakePresets.json'), 'utf8')); } catch (e) { return []; }
  return (d.configurePresets || [])
    .filter((p) => !p.hidden && !/^(mac|win)/.test(p.name))
    .map((p) => ({ name: p.name, label: p.displayName || p.name }));
}

/** The compiler a preset uses: 'clang' or 'gcc'. */
const compilerOf = (preset) => (/clang/.test(String(preset)) ? 'clang' : 'gcc');

/**
 * What a build directory was configured with, from its CMakeCache.txt:
 * { configured, buildType, compiler ('gcc'|'clang'), targets: [..] | null,
 *   cpm: folder | null, generator, preset (a guess: gcc, gcc-debug, clang, clang-debug) }.
 */
function readCache(build) {
  let text;
  try { text = fs.readFileSync(path.join(build, 'CMakeCache.txt'), 'utf8'); } catch (e) { return { configured: false }; }
  const get = (k) => { const m = new RegExp(`^${k}:[A-Z]*=(.*)$`, 'm').exec(text); return m ? m[1] : null; };
  const cxx = get('CMAKE_CXX_COMPILER') || '';
  const cxxId = get('CMAKE_CXX_COMPILER_ID') || '';
  const compiler = /clang/i.test(cxxId) || /clang/.test(path.basename(cxx)) ? 'clang' : 'gcc';
  const buildType = get('CMAKE_BUILD_TYPE') || '';
  const t = get('LIBQEMU_TARGETS');
  const cpm = get('CPM_SOURCE_CACHE');
  return {
    configured: true, buildType, compiler,
    targets: t ? t.split(';').filter(Boolean) : null,
    cpm: cpm && cpm !== 'OFF' ? cpm : null,
    generator: get('CMAKE_GENERATOR') || '',
    preset: compiler + (/debug/i.test(buildType) ? '-debug' : ''),
  };
}

// The CMake Tools extension configures a folder with a CMakePresets.json by
// itself when the folder is opened, and again when CMakeLists.txt changes: for
// QBox that is the preset's defaults (every QEMU target, no package cache),
// which undoes Build QBox's settings and downloads the dependencies again.
const CMAKE_TOOLS_ID = 'ms-vscode.cmake-tools';
const CMAKE_TOOLS_OFF = ['cmake.configureOnOpen', 'cmake.automaticReconfigure', 'cmake.configureOnEdit'];

/** Parse a VS Code settings file (JSON with comments and trailing commas). Throws when it cannot. */
function parseSettings(text) {
  let out = '', i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') { const m = /^"(?:[^"\\]|\\.)*"/.exec(text.slice(i)); if (!m) throw new Error('unterminated string'); out += m[0]; i += m[0].length; }
    else if (text.startsWith('//', i)) { const e = text.indexOf('\n', i); i = e < 0 ? text.length : e; }
    else if (text.startsWith('/*', i)) { const e = text.indexOf('*/', i + 2); if (e < 0) throw new Error('unterminated comment'); i = e + 2; }
    else { out += c; i++; }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1') || '{}');
}

/**
 * Whether CMake Tools would configure the QBox folder by itself.
 * opts: { installed (the extension is installed and enabled), user ({key: value}
 * of the user settings) }. Returns null when CMake Tools is not installed, else
 * { file (<src>/.vscode/settings.json), unreadable, auto (the settings of
 * CMAKE_TOOLS_OFF that are not false), configuredBy (build/ has CMake Tools'
 * file API query, so it configured the build directory at least once) }.
 */
function cmakeTools(src, opts = {}) {
  if (!opts.installed || !src) return null;
  const file = path.join(src, '.vscode', 'settings.json');
  let folder = {}, unreadable = false;
  try { folder = parseSettings(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') unreadable = true; }
  if (!folder || typeof folder !== 'object' || Array.isArray(folder)) { folder = {}; unreadable = true; }
  const user = opts.user || {};
  const value = (k) => (folder[k] !== undefined ? folder[k] : user[k] !== undefined ? user[k] : true);
  return {
    file, unreadable,
    auto: CMAKE_TOOLS_OFF.filter((k) => value(k) !== false),
    configuredBy: isDir(path.join(src, 'build', '.cmake', 'api', 'v1', 'query', 'client-vscode')),
  };
}

/**
 * The text of a settings file with CMAKE_TOOLS_OFF set to false, keeping the
 * rest. text: the file's text, or '' when it does not exist. Throws for a file
 * with comments (jsonedit does not keep them).
 */
function cmakeToolsOffText(text) {
  let t = text && text.trim() ? text : '{}\n';
  if (/\/\/|\/\*/.test(t.replace(/"(?:[^"\\]|\\.)*"/g, '""'))) throw new Error('the settings file has comments; set ' + CMAKE_TOOLS_OFF.join(', ') + ' to false in it yourself');
  parseSettings(t);
  for (const k of CMAKE_TOOLS_OFF) t = jsonedit.apply(t, jsonedit.setProperty(t, [], k, () => 'false'));
  return t.endsWith('\n') ? t : t + '\n';
}

/**
 * Everything the Build QBox view shows about a QBox folder.
 * opts: { pin (qbox.pin.json, parsed), studioDir, dirty (git status of tracked
 * files: true/false/null when unknown), agentLib (sim agent .so or null),
 * cmakeTools (cmakeTools() options) }.
 */
function inspect(src, opts = {}) {
  const pin = opts.pin || {};
  const kind = folderKind(src);
  const build = src ? path.join(src, 'build') : null;
  const cache = build ? readCache(build) : { configured: false };
  const head = kind === 'qbox' ? pinLib.gitHead(src) : null;
  const pinned = pin.qbox ? pin.qbox.commit : null;
  const libqemu = build && cache.configured ? (pinLib.qboxSourceOf(path.join(build, 'platforms-vp')) || {}).libqemu : null;
  const patches = kind === 'qbox' ? pinLib.patchReport(pin, opts.studioDir, { source: src, build, libqemu: libqemu || (build && path.join(build, '_deps', 'libqemu-src')) }) : [];
  const product = (f) => { const p = build ? path.join(build, f) : null; const t = p && mtime(p); return { file: f, exists: !!t, mtime: t }; };
  const products = ['platforms-vp', 'probes.so', 'debug_dap.so', 'perf.so'].map(product);
  const agentT = opts.agentLib ? mtime(opts.agentLib) : null;
  const probesT = products[1].mtime;
  return {
    src, kind, build, cache, head, pinned, atPin: !!head && !!pinned && head === pinned,
    // VP Studio's components (systemc-components/probes, debug_dap): only in a QBox they were added to.
    hasProbes: kind === 'qbox' && isDir(path.join(src, 'systemc-components', 'probes')),
    // A VP Studio patch that adds them (patches/qbox/0002-vp-studio-probes-debug-dap.patch).
    probesPatch: ((pin.qbox && pin.qbox.patches) || []).some((x) => /probes/.test(x)),
    dirty: opts.dirty === undefined ? null : opts.dirty,
    patches, products,
    agent: opts.agentLib ? { lib: opts.agentLib, exists: !!agentT, version: agentT ? pinLib.agentVersion(opts.agentLib) : null, older: !!agentT && !!probesT && agentT < probesT } : null,
    presets: kind === 'qbox' ? presets(src) : [],
    cmakeTools: kind === 'qbox' ? cmakeTools(src, opts.cmakeTools) : null,
  };
}

/**
 * Settings for the form when nothing was saved: from the build directory when
 * it is configured (so Build changes nothing), else from the pin.
 * { src, preset, targets, cache: {mode (a cacheChoices id, or 'custom'), dir}, jobs, patches, checkout, agent, useForSim }
 * opts: { env (CPM_SOURCE_CACHE) }.
 */
function defaults(status, pin = {}, jobs = 4, opts = {}) {
  const b = pin.build || {};
  const c = status.cache || {};
  const cachedPreset = c.configured ? (status.presets.some((p) => p.name === c.preset) ? c.preset : null) : null;
  // The option that matches the configured cache (or QBox's own Packages), else none.
  const choices = cacheChoices(status.src, opts.env || '');
  let cache = { mode: 'none', dir: null };
  const want = c.configured ? c.cpm : (status.src && isDir(path.join(status.src, 'Packages')) ? path.join(status.src, 'Packages') : null);
  if (want) {
    const hit = choices.find((x) => x.dir && path.resolve(x.dir) === path.resolve(want));
    cache = hit ? { mode: hit.id, dir: hit.dir } : { mode: 'custom', dir: want };
  }
  return {
    src: status.src || '',
    preset: cachedPreset || b.preset || 'gcc',
    targets: (c.configured && c.targets) || (b.libqemuTargets || ['aarch64']).slice(),
    cache, jobs,
    patches: true,
    checkout: false,
    agent: !!status.hasProbes || (!!status.probesPatch && status.kind !== 'other'), // the sim agent links to QBox's probes.so
    useForSim: true,
  };
}

/** The CPM cache folder a form setting stands for, or null (none, or QBox's own Packages). */
function cacheDir(form) {
  const c = form.cache || {};
  if (!c.dir || c.mode === 'none') return null;
  if (form.src && path.resolve(c.dir) === path.join(path.resolve(form.src), 'Packages')) return null; // QBox uses it by itself
  return c.dir;
}

/**
 * The output of tools/qbox-pin/check-deps.sh --tsv:
 * { items: [{ state ('ok'|'missing'|'old'), what, pkg, note }], missing: [those not ok],
 *   packages: [Ubuntu package names, once each], distro: { id, like },
 *   install: 'sudo apt install …' on Debian or Ubuntu, else null }.
 */
function parseDeps(text) {
  const items = [];
  let distro = { id: '', like: '' };
  for (const line of String(text || '').split('\n')) {
    const f = line.replace(/\r$/, '').split('\t');
    if (f[0] === 'distro') distro = { id: f[1] || '', like: f[2] || '' };
    else if (['ok', 'missing', 'old'].includes(f[0]) && f[1]) items.push({ state: f[0], what: f[1], pkg: f[2] || '', note: f[3] || '' });
  }
  const missing = items.filter((i) => i.state !== 'ok');
  const packages = [...new Set(missing.map((i) => i.pkg).filter(Boolean))];
  const debian = /\b(debian|ubuntu)\b/.test(`${distro.id} ${distro.like}`);
  return { items, missing, packages, distro, install: packages.length && debian ? `sudo apt install ${packages.join(' ')}` : null };
}

/** The sentence check() shows for missing host packages. */
function depsText(deps) {
  const list = deps.missing.map((i) => (i.state === 'old' ? `${i.what} (${i.note})` : `${i.what} (${i.pkg})`)).join(', ');
  return `This host lacks what QBox's build needs: ${list}. `
    + (deps.install ? `Install with: ${deps.install}` : 'Install them with your distribution\'s package manager (the names are Ubuntu\'s), or see QBox\'s scripts/install_dependencies.sh.');
}

/**
 * What stops or deserves a warning before building:
 * { errors: [text], warnings: [text], changes: [text] }.
 * changes: what differs from the configured build directory.
 * opts: { simulator (the platforms-vp VP Studio uses), deps (parseDeps() of
 * check-deps.sh for the form's preset, or null while unknown) }.
 */
function check(form, status, opts = {}) {
  const errors = [];
  const warnings = [];
  const changes = [];
  if (!form.src) errors.push('Choose the QBox folder.');
  else if (status.kind === 'other') errors.push(`${form.src} is neither a QBox source tree (CMakePresets.json and systemc-components) nor empty.`);
  if (!form.targets || !form.targets.length) errors.push('Choose at least one QEMU target.');
  if (form.cache && form.cache.mode === 'custom' && !form.cache.dir) errors.push('Choose the package cache folder, or another option.');
  const c = status.cache || {};
  // Missing host packages stop CMake or libqemu's configure halfway, and
  // build-qbox.sh refuses to start without them.
  if (opts.deps && opts.deps.missing.length) errors.push(depsText(opts.deps));
  if (status.kind === 'qbox' && status.head && status.pinned && !status.atPin) {
    if (form.checkout && status.dirty) errors.push(`The QBox folder is at ${status.head.slice(0, 12)}, not the pinned ${status.pinned.slice(0, 12)}, and has local changes: commit or stash them before checking out the pinned commit.`);
    else if (form.checkout) warnings.push(`Checks out the pinned commit ${status.pinned.slice(0, 12)} (the folder is at ${status.head.slice(0, 12)}).`);
    else warnings.push(`The QBox folder is at ${status.head.slice(0, 12)}, not the pinned ${status.pinned.slice(0, 12)}: VP Studio is tested with the pinned commit.`);
  }
  if (c.configured) {
    if (compilerOf(form.preset) !== c.compiler) {
      errors.push(`The build directory was configured with ${c.compiler}; ${form.preset} uses ${compilerOf(form.preset)}. CMake cannot change the compiler of a build directory: move the old one aside first.`);
    }
    if (c.buildType && /debug/.test(form.preset) !== /debug/i.test(c.buildType)) changes.push(`build type ${c.buildType} → ${/debug/.test(form.preset) ? 'Debug' : 'Release'} (rebuilds everything)`);
    const was = (c.targets || []).slice().sort().join(';');
    const now = (form.targets || []).slice().sort().join(';');
    if (c.targets && was !== now) changes.push(`QEMU targets ${(c.targets || []).join(', ')} → ${form.targets.join(', ')} (builds the added ones)`);
    const dir = cacheDir(form);
    const cpmWas = c.cpm || null;
    if ((dir || null) !== cpmWas && !(dir === null && form.cache.mode === 'Packages' && cpmWas && path.resolve(cpmWas) === path.join(path.resolve(form.src), 'Packages'))) {
      changes.push(`package cache ${cpmWas || 'none'} → ${dir || (form.cache.mode === 'Packages' ? 'Packages' : 'none')} (downloads the dependencies again)`);
    }
  }
  if (form.agent && !form.useForSim && opts.simulator && form.src && path.resolve(opts.simulator) !== path.join(path.resolve(form.src), 'build', 'platforms-vp')) {
    warnings.push('The sim agent is built for the QBox VP Studio uses, which is not this one: with "Use this QBox for simulations" off, it is not built.');
  }
  if (form.agent && !status.hasProbes && !(status.probesPatch && form.patches)) {
    warnings.push(status.probesPatch
      ? 'This QBox has no VP Studio components (systemc-components/probes, debug_dap), which come with VP Studio\'s patches: turn on "Apply the patches", or turn off "Build the sim agent" (it links to probes.so).'
      : 'This QBox has no VP Studio components (systemc-components/probes, debug_dap): the sim agent, which links to probes.so, cannot be built against it.');
  }
  if (!form.patches) warnings.push('VP Studio\'s patches are not applied: multi-CPU platforms then need keep_alive, and checkpoints do not work.');
  const ct = status.cmakeTools;
  if (ct && ct.auto.length) {
    warnings.push('CMake Tools configures this QBox by itself when its folder is opened in VS Code, with the preset\'s defaults (every QEMU target, no package cache): that undoes these settings and downloads the dependencies again.'
      + (ct.configuredBy ? ' It has configured this build directory before: check the settings below.' : '')
      + ' Turn off its auto-configure for this folder.');
  }
  return { errors, warnings, changes };
}

/**
 * Arguments of build-qbox.sh. form: the view's settings; status: inspect().
 * Only QBox is built here (no catalog); the sim agent is built by VP Studio
 * after it when asked.
 */
function buildArgs({ script, src, cache = null, targets = null, jobs = null, preset = null, patches = true, checkout = true, depsCheck = true }) {
  const args = [script, '--no-catalog', '--no-agent'];
  if (!depsCheck) args.push('--no-deps-check');
  if (jobs) args.push('--jobs', String(jobs));
  if (preset) args.push('--preset', preset);
  if (targets) args.push('--targets', targets);
  if (cache) args.push('--cpm-cache', cache);
  if (!patches) args.push('--no-patches');
  if (!checkout) args.push('--no-checkout');
  args.push(src);
  return args;
}

/** buildArgs for the view's settings. */
function argsFor(form, script, opts = {}) {
  return buildArgs({
    script, src: form.src, cache: cacheDir(form), targets: (form.targets || []).join(';'),
    jobs: form.jobs, preset: form.preset, patches: form.patches !== false, checkout: !!form.checkout,
    depsCheck: !opts.skipDeps,
  });
}

/** A shell command line for showing (quoted only where needed). */
function commandLine(args) {
  return args.map((a) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${String(a).replace(/'/g, "'\\''")}'`)).join(' ');
}

module.exports = { CMAKE_TOOLS_ID, CMAKE_TOOLS_OFF, parseSettings, cmakeTools, cmakeToolsOffText, folderKind, sourceCandidates, cacheChoices, presets, compilerOf, readCache, inspect, defaults, cacheDir, parseDeps, depsText, check, buildArgs, argsFor, commandLine };
