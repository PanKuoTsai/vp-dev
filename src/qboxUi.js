'use strict';
// Building: the Build QBox view, the sim agent, the bundled modules and wizard models.
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const qboxsetup = require('../lib/setup/qboxsetup');
const qboxview = require('../lib/webview/qboxview');
const pin = require('../lib/setup/pin');
const shared = require('./shared');
const common = require('./common');
const catalogUi = require('./catalogUi');
const platformFiles = require('./platformFiles');
const modelUi = require('./modelUi');
const simUi = require('./simUi');
const agentUi = require('./agentUi');
const platformView = require('./platformView');
const menuUi = require('./menuUi');

/** QBox build folder of the configured simulator (where compile_commands.json is). */
function qboxBuildDir() {
  const { exePath } = simUi.simulatorPath(undefined);
  const where = pin.qboxSourceOf(exePath);
  return where ? where.build : path.dirname(exePath);
}

/**
 * Run a build script of VP Studio (tools/<dir>/build.sh) against the user's
 * QBox build in a terminal task. Returns the exit code, or undefined when there
 * is no QBox build to build against.
 */
async function runToolBuild(title, dir, extraArgs = [], env = {}) {
  const build = qboxBuildDir();
  if (!fs.existsSync(path.join(build, 'compile_commands.json'))) {
    vscode.window.showErrorMessage(`Building the ${title} needs a QBox build: no compile_commands.json in ${build}. Build QBox, or set "vpStudio.executable" to its platforms-vp.`);
    return undefined;
  }
  const script = path.join(common.ROOT, 'tools', dir, 'build.sh');
  const task = new vscode.Task({ type: 'shell', tool: dir }, vscode.TaskScope.Workspace, `Build ${title}`, 'VP Studio',
    new vscode.ShellExecution('bash', [script, build, ...extraArgs], { cwd: common.taskCwd(build), env: Object.assign({ VP_QBOX_CATALOG: catalogUi.catalogToolPath() }, env) }), []);
  task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, clear: true };
  const exec = await vscode.tasks.executeTask(task);
  return new Promise((resolve) => {
    const sub = vscode.tasks.onDidEndTaskProcess((e) => { if (e.execution === exec) { sub.dispose(); resolve(e.exitCode); } });
  });
}

const qboxRun = { running: false, last: null };

const QBOX_FORM_KEY = 'vpStudio.qboxBuild';

function qboxPin() {
  try { return JSON.parse(fs.readFileSync(path.join(common.ROOT, 'qbox.pin.json'), 'utf8')); } catch (e) { return {}; }
}

/** The QBox folder VP Studio runs now: the parent of the simulator's build directory, else a QBox workspace folder. */
function qboxSrcDefault() {
  const { exePath } = simUi.simulatorPath(undefined);
  const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
  const c = qboxsetup.sourceCandidates(exePath, folders);
  return c.length ? c[0].dir : (folders[0] || '');
}

/** Whether the QBox folder has local changes to tracked files (git status), cached per folder. */
function qboxDirtyOf(src) {
  if (shared.qboxDirty.src === src) return shared.qboxDirty.value;
  shared.qboxDirty = { src, value: null };
  if (qboxsetup.folderKind(src) === 'qbox') {
    require('child_process').execFile('git', ['-C', src, 'status', '--porcelain', '--untracked-files=no'], { timeout: 10000 }, (err, out) => {
      if (shared.qboxDirty.src !== src) return;
      shared.qboxDirty.value = err ? null : out.trim().length > 0;
      qboxPost();
    });
  }
  return null;
}

/**
 * What the host lacks for QBox's build (tools/qbox-pin/check-deps.sh), per
 * preset (the compiler). Runs in the background; null until it has answered.
 * force: run again (Check again, after a failed build).
 */
function qboxDepsOf(preset, force = false) {
  const d = shared.qboxDeps;
  if (d.preset === preset && !force) return d.value;
  shared.qboxDeps = { preset, value: force && d.preset === preset ? d.value : null, at: 0 };
  const script = path.join(common.ROOT, 'tools', 'qbox-pin', 'check-deps.sh');
  require('child_process').execFile('bash', [script, '--tsv', '--preset', String(preset || 'gcc')], { timeout: 30000 }, (err, out) => {
    if (shared.qboxDeps.preset !== preset) return;
    // Exit code 1 only says something is missing; the lines say what.
    shared.qboxDeps.value = out && out.trim() ? qboxsetup.parseDeps(out) : null;
    shared.qboxDeps.at = Date.now();
    qboxPost();
  });
  return shared.qboxDeps.value;
}

function qboxStatus(src) {
  const lib = agentUi.simAgentLibrary({ quiet: true });
  return qboxsetup.inspect(src, { pin: qboxPin(), studioDir: common.ROOT, dirty: qboxDirtyOf(src), agentLib: lib ? lib + '.so' : null, cmakeTools: cmakeToolsState() });
}

/** Whether CMake Tools is installed, and its auto-configure settings in the user settings. */
function cmakeToolsState() {
  if (!vscode.extensions.getExtension(qboxsetup.CMAKE_TOOLS_ID)) return { installed: false };
  const user = {};
  for (const k of qboxsetup.CMAKE_TOOLS_OFF) {
    const i = vscode.workspace.getConfiguration().inspect(k);
    if (i && i.globalValue !== undefined) user[k] = i.globalValue;
  }
  return { installed: true, user };
}

function qboxDefaults(src, keep = {}) {
  const st = qboxStatus(src);
  const f = qboxsetup.defaults(st, qboxPin(), Math.max(1, os.cpus().length), { env: process.env.CPM_SOURCE_CACHE || '' });
  for (const k of ['agent', 'useForSim', 'jobs']) if (keep[k] !== undefined) f[k] = keep[k];
  return f;
}

/** Everything the view shows, from the form and the folder's state. */
function qboxPost() {
  if (!shared.qboxPanel || !shared.qboxForm) return;
  const pin = qboxPin();
  const st = qboxStatus(shared.qboxForm.src);
  const pinnedTargets = (pin.build && pin.build.libqemuTargets) || ['aarch64'];
  const targets = [...new Set([...pinnedTargets, ...((st.cache && st.cache.targets) || []), ...(shared.qboxForm.targets || [])])];
  const presets = st.presets.length ? st.presets : [{ name: (pin.build && pin.build.preset) || 'gcc', label: (pin.build && pin.build.preset) || 'gcc' }];
  const deps = qboxDepsOf(shared.qboxForm.preset);
  const check = qboxsetup.check(shared.qboxForm, st, { simulator: simUi.simulatorPath(undefined).exePath, deps });
  const script = path.join(common.ROOT, 'tools', 'qbox-pin', 'build-qbox.sh');
  const built = shared.qboxForm.src ? path.join(path.resolve(shared.qboxForm.src), 'build', 'platforms-vp') : '';
  shared.qboxPanel.webview.postMessage({
    type: 'state', status: st, form: shared.qboxForm,
    choices: { presets, targets, cache: qboxsetup.cacheChoices(shared.qboxForm.src, process.env.CPM_SOURCE_CACHE || '') },
    check, compilerChange: check.errors.some((e) => /cannot change the compiler/.test(e)),
    command: shared.qboxForm.src ? `bash ${qboxsetup.commandLine(qboxsetup.argsFor(shared.qboxForm, script))}` : '',
    deps: deps ? { missing: deps.missing, install: deps.install, at: shared.qboxDeps.at } : null,
    running: qboxRun.running, last: qboxRun.last,
    simulator: path.resolve(simUi.simulatorPath(undefined).exePath), built,
  });
}

function qboxSave() {
  if (shared.extContext && shared.qboxForm) shared.extContext.workspaceState.update(QBOX_FORM_KEY, shared.qboxForm);
}

/**
 * Build QBox: a view with the QBox folder, its build settings, the package
 * cache, VP Studio's patches and what to do afterwards; Build runs
 * tools/qbox-pin/build-qbox.sh (checkout, patches, configure, build) for both
 * the first build and later ones.
 */
async function cmdBuildQbox() {
  if (shared.qboxPanel) { shared.qboxPanel.reveal(undefined, false); qboxPost(); return; }
  shared.qboxPanel = vscode.window.createWebviewPanel('vpStudio.qboxBuild', 'Build QBox', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
  const nonce = crypto.randomBytes(16).toString('hex');
  shared.qboxPanel.webview.html = qboxview.render(nonce, shared.qboxPanel.webview.cspSource);
  shared.qboxPanel.onDidDispose(() => { shared.qboxPanel = undefined; });
  shared.qboxPanel.webview.onDidReceiveMessage((m) => qboxMessage(m).catch((e) => vscode.window.showErrorMessage(`Build QBox: ${e.message}`)));
}

async function qboxMessage(m) {
  if (!m) return;
  if (m.type === 'ready') {
    const saved = shared.extContext && shared.extContext.workspaceState.get(QBOX_FORM_KEY);
    shared.qboxForm = saved && saved.src !== undefined ? saved : qboxDefaults(qboxSrcDefault());
    qboxPost();
  } else if (m.type === 'set' && m.form) {
    const f = m.form;
    if (f.src !== shared.qboxForm.src) {
      // Another folder: its own configuration decides the defaults.
      shared.qboxForm = qboxDefaults(f.src, f);
      shared.qboxForm.src = f.src;
    } else {
      shared.qboxForm = Object.assign(shared.qboxForm, {
        preset: String(f.preset || shared.qboxForm.preset), targets: Array.isArray(f.targets) ? f.targets.map(String) : shared.qboxForm.targets,
        cache: f.cache && typeof f.cache === 'object' ? { mode: String(f.cache.mode), dir: f.cache.dir ? String(f.cache.dir) : null } : shared.qboxForm.cache,
        jobs: Math.max(1, Math.min(256, Number(f.jobs) || 1)), patches: f.patches !== false, checkout: !!f.checkout, agent: !!f.agent, useForSim: !!f.useForSim,
      });
    }
    qboxSave();
    qboxPost();
  } else if (m.type === 'browse') {
    const isSrc = m.field === 'src';
    const u = await vscode.window.showOpenDialog({
      canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
      openLabel: isSrc ? 'Use for QBox' : 'Use as package cache', title: isSrc ? 'QBox source folder (or an empty folder for a new clone)' : 'Folder for the dependencies\' sources (CPM_SOURCE_CACHE)',
      defaultUri: isSrc ? (shared.qboxForm.src ? vscode.Uri.file(shared.qboxForm.src) : undefined) : (shared.qboxForm.cache && shared.qboxForm.cache.dir ? vscode.Uri.file(shared.qboxForm.cache.dir) : undefined),
    });
    if (!u || !u.length) { qboxPost(); return; }
    if (isSrc) { const src = u[0].fsPath; shared.qboxForm = qboxDefaults(src, shared.qboxForm); shared.qboxForm.src = src; } else shared.qboxForm.cache = { mode: 'custom', dir: u[0].fsPath };
    qboxSave();
    qboxPost();
  } else if (m.type === 'command') {
    const cmd = { checkQbox: 'vpStudio.checkQBox', buildSimAgent: 'vpStudio.buildSimAgent' }[m.name];
    if (cmd) await vscode.commands.executeCommand(cmd);
    qboxPost();
  } else if (m.type === 'moveBuild') {
    const build = path.join(shared.qboxForm.src, 'build');
    const to = `${build}.${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-')}`;
    const ok = await vscode.window.showWarningMessage(`Move ${build} to ${path.basename(to)}?`, { modal: true, detail: 'The next build then configures a new build directory with the chosen compiler. Delete the old one yourself once the new build works.' }, 'Move');
    if (ok !== 'Move') return;
    fs.renameSync(build, to);
    vscode.window.showInformationMessage(`Moved the old build directory to ${to}.`);
    qboxPost();
  } else if (m.type === 'cmakeToolsOff') {
    const st = qboxStatus(shared.qboxForm.src);
    if (!st.cmakeTools) { qboxPost(); return; }
    const f = st.cmakeTools.file;
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, qboxsetup.cmakeToolsOffText(text));
    vscode.window.showInformationMessage(`CMake Tools no longer configures QBox by itself: set ${qboxsetup.CMAKE_TOOLS_OFF.join(', ')} to false in ${f}.`);
    qboxPost();
  } else if (m.type === 'depsAgain') {
    qboxDepsOf(shared.qboxForm.preset, true);
    qboxPost();
  } else if (m.type === 'copyDeps') {
    const d = shared.qboxDeps.value;
    if (d && d.install) {
      await vscode.env.clipboard.writeText(d.install);
      vscode.window.showInformationMessage(`Copied: ${d.install}. Run it in a terminal on this host, then press Check again.`);
    }
  } else if (m.type === 'build') {
    await qboxBuild({ skipDeps: !!m.skipDeps });
  }
}

async function qboxBuild(opts = {}) {
  const st = qboxStatus(shared.qboxForm.src);
  const deps = opts.skipDeps ? null : qboxDepsOf(shared.qboxForm.preset);
  const check = qboxsetup.check(shared.qboxForm, st, { simulator: simUi.simulatorPath(undefined).exePath, deps });
  if (check.errors.length || qboxRun.running) { qboxPost(); return; }
  if (opts.skipDeps) {
    const ok = await vscode.window.showWarningMessage('Build without checking the host\'s packages?', { modal: true, detail: 'Use this when the check is wrong for this host (for example, libraries installed where pkg-config does not look). If a package is really missing, CMake or libqemu\'s configure stops with an error.' }, 'Build Anyway');
    if (ok !== 'Build Anyway') return;
  }
  if (menuUi.ctxState['vpStudio.running']) {
    const pick = await vscode.window.showWarningMessage(
      'A simulation is running. Building QBox replaces libraries it has loaded, which can crash it.', { modal: true }, 'Stop and Build', 'Build Anyway');
    if (!pick) return;
    if (pick === 'Stop and Build') await vscode.commands.executeCommand('vpStudio.stop');
  }
  const form = JSON.parse(JSON.stringify(shared.qboxForm));
  const args = qboxsetup.argsFor(form, path.join(common.ROOT, 'tools', 'qbox-pin', 'build-qbox.sh'), { skipDeps: !!opts.skipDeps });
  const task = new vscode.Task({ type: 'shell', tool: 'qbox' }, vscode.TaskScope.Workspace, 'Build QBox', 'VP Studio',
    new vscode.ShellExecution('bash', args, { cwd: common.taskCwd(form.src), env: { ELECTRON_RUN_AS_NODE: '' } }), []);
  task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, clear: true };
  qboxRun.running = true;
  qboxPost();
  let code;
  try {
    const exec = await vscode.tasks.executeTask(task);
    code = await new Promise((resolve) => {
      const sub = vscode.tasks.onDidEndTaskProcess((e) => { if (e.execution === exec) { sub.dispose(); resolve(e.exitCode); } });
    });
  } finally {
    qboxRun.running = false;
  }
  shared.qboxDirty = { src: null, value: null };
  shared.mergedCache = null;
  const notes = [];
  if (code === 0) {
    const built = path.join(path.resolve(form.src), 'build', 'platforms-vp');
    if (form.useForSim && path.resolve(simUi.simulatorPath(undefined).exePath) !== built) {
      await vscode.workspace.getConfiguration('vpStudio').update('executable', built, vscode.ConfigurationTarget.Workspace);
      notes.push(`vpStudio.executable is now ${built}`);
    }
    // Build Sim Agent builds against the QBox VP Studio uses (vpStudio.executable).
    const agentHere = form.agent && path.resolve(simUi.simulatorPath(undefined).exePath) === built;
    if (form.agent && !agentHere) notes.push('sim agent not built: VP Studio uses another QBox (tick "Use this QBox for simulations")');
    qboxRun.last = { code, at: Date.now(), text: notes.join('; ') };
    qboxPost();
    if (agentHere) await cmdBuildSimAgent();
  } else {
    qboxRun.last = { code, at: Date.now(), text: 'see the terminal' };
    qboxDepsOf(form.preset, true); // a package may be what failed
    vscode.window.showErrorMessage(`Building QBox failed (exit code ${code}); see the terminal.`);
  }
  qboxPost();
}

/** Build the sim agent into the extension folder, where Start Simulation looks for it. */
async function cmdBuildSimAgent() {
  fs.mkdirSync(catalogUi.buildDir('sim-agent'), { recursive: true });
  const code = await runToolBuild('Sim Agent', 'sim-agent', [catalogUi.buildDir('sim-agent', 'sim_agent.so')]);
  if (code === undefined) return;
  shared.agentLibWarned = false;
  if (code === 0) vscode.window.showInformationMessage('Built the sim agent for your QBox. Simulations started from VP Studio now include it: pause, continue, parameters, tracing.');
  else vscode.window.showErrorMessage(`Building the sim agent failed (exit code ${code}); see the terminal.`);
}

/** Build a module library that comes with VP Studio (tools/<dir>/build.sh) against the user's QBox. */
async function cmdBuildBundled(b) {
  const build = qboxBuildDir();
  const code = await runToolBuild(b.title, b.dir, ['--out', catalogUi.buildDir(b.dir)]);
  if (code === undefined) return;
  shared.mergedCache = null;
  vscode.workspace.textDocuments.forEach(platformFiles.refreshDiagnostics);
  for (const [key, panel] of common.panels) platformView.renderPanel(vscode.Uri.parse(key), panel);
  if (code === 0) vscode.window.showInformationMessage(`Built the ${b.title} (${b.type}) for ${build}. Platforms can use type "${b.type}"; no "dylib" is needed.`);
  else vscode.window.showErrorMessage(`Building the ${b.title} failed (exit code ${code}); see the terminal.`);
}

async function cmdBuildModel(arg) {
  const uri = await modelUi.pickModel(arg);
  if (!uri) return;
  const textDoc = await vscode.workspace.openTextDocument(uri);
  if (textDoc.isDirty) await textDoc.save();
  if (!(await modelUi.generateModel(uri, false))) return;
  const build = qboxBuildDir();
  if (!fs.existsSync(path.join(build, 'compile_commands.json'))) {
    vscode.window.showErrorMessage(`Building a model needs a QBox build: no compile_commands.json in ${build}. Build QBox, or set "vpStudio.executable" to its platforms-vp.`);
    return;
  }
  const script = path.join(common.ROOT, 'tools', 'model-build', 'build.sh');
  const dir = path.dirname(uri.fsPath);
  const task = new vscode.Task({ type: 'shell', model: dir }, vscode.TaskScope.Workspace, `Build model ${path.basename(dir)}`, 'VP Studio',
    new vscode.ShellExecution('bash', [script, build, dir], { cwd: common.taskCwd(dir), env: { VP_QBOX_CATALOG: catalogUi.catalogToolPath() } }), []);
  task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, clear: true };
  const exec = await vscode.tasks.executeTask(task);
  const code = await new Promise((resolve) => {
    const sub = vscode.tasks.onDidEndTaskProcess((e) => { if (e.execution === exec) { sub.dispose(); resolve(e.exitCode); } });
  });
  await catalogUi.refreshModelCatalogs();
  const name = (() => { try { return JSON.parse(textDoc.getText()).name; } catch (e) { return path.basename(dir); } })();
  if (code === 0) {
    vscode.window.showInformationMessage(`Built ${name}; its self-test passed, and it is in the component catalog: "Add Module…" in a platform lists it.`);
  } else {
    vscode.window.showErrorMessage(code === 3 ? `${name} was built, but its self-test failed; see the terminal.` : `Building ${name} failed (exit code ${code}); see the terminal.`);
  }
}

exports.cmdBuildQbox = cmdBuildQbox;
exports.cmdBuildSimAgent = cmdBuildSimAgent;
exports.cmdBuildBundled = cmdBuildBundled;
exports.cmdBuildModel = cmdBuildModel;
