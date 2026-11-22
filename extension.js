'use strict';
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const core = require('./lib/platform/core');
const view = require('./lib/webview/view');
const images = require('./lib/platform/images');
const jsonedit = require('./lib/platform/jsonedit');
const simagent = require('./lib/sim/simagent');
const debugdap = require('./lib/debug/debugdap');
const qboxsetup = require('./lib/setup/qboxsetup');
const qboxview = require('./lib/webview/qboxview');
const params = require('./lib/platform/params');
const modules = require('./lib/platform/modules');
const connect = require('./lib/platform/connect');
const hostports = require('./lib/sim/hostports');
const disklock = require('./lib/sim/disklock');
const trace = require('./lib/analysis/trace');
const traceview = require('./lib/webview/traceview');
const pin = require('./lib/setup/pin');
const diskspace = require('./lib/sim/diskspace');
const modelgen = require('./lib/generate/modelgen');
const models = require('./lib/generate/models');
const launch = require('./lib/sim/launch');
const registers = require('./lib/analysis/registers');
const elfsym = require('./lib/analysis/elfsym');
const profile = require('./lib/analysis/profile');
const ftrace = require('./lib/analysis/ftrace');
const menu = require('./lib/menu');
const profileview = require('./lib/webview/profileview');
const perf = require('./lib/analysis/perf');
const perfview = require('./lib/webview/perfview');
const guestlinux = require('./lib/debug/guestlinux');
const kit = require('./lib/setup/kit');
const checkpoint = require('./lib/sim/checkpoint');
const ipxact = require('./lib/generate/ipxact');
const thirdparty = require('./lib/debug/thirdparty');
const remote = require('./lib/sim/remote');
const askpass = require('./lib/sim/askpass');
const devicetree = require('./lib/generate/devicetree');
const dtcompare = require('./lib/generate/dtcompare');
const restructure = require('./lib/platform/restructure');
const cpuregs = require('./lib/debug/cpuregs');
const cpuregsview = require('./lib/webview/cpuregsview');

const SUFFIX = '.platform.json';
const isPlatform = (doc) => !!doc && doc.fileName.endsWith(SUFFIX);
const cfg = () => vscode.workspace.getConfiguration('vpStudio');
const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
// VS Code on Windows: QBox runs only on Linux, so simulations always run on a
// simulation host (remote.*), and what builds or runs QBox here is not offered.
const IS_WINDOWS = process.platform === 'win32';

let diagnostics;
let terminal;
let statusItem;
let menuItem;           // "VP Studio" in the status bar: the menu
const panels = new Map(); // uri string -> WebviewPanel
const pendingSelect = new Map(); // uri string -> module to select at the next render
const pendingRoute = new Map();  // uri string -> { id, spec } transaction route to show at the next render
let routeSeq = 0;
let extContext;
let runningPlatform; // uri of the platform the current simulation was started from
let runningDoc;       // its description as started
let runningBuses = []; // the routers the agent's bus_N sockets are bound to
let runningRemote; // {host, ...} while the running simulation is on a remote host (F-03)
let runningOverrides = []; // parameter overrides of the running simulation (its disk images, for checkpoints)
let restoreReported = false; // a failed restore was shown
let versionOutput;

// ------------------------------------------------------------------ catalog

let catalogCache = { file: null, mtime: 0, data: undefined, warned: null };

/**
 * The QBox component catalog used to check platforms, or undefined when
 * disabled or unreadable. "vpStudio.catalog" empty means the catalog bundled
 * with the extension (generated from the pinned QBox commit).
 */
function catalog() {
  const setting = (cfg().get('catalog') || '').trim();
  if (setting === 'none') return undefined;
  let file = path.join(__dirname, 'catalog', 'qbox-catalog.json');
  if (setting) {
    const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    file = path.isAbsolute(setting) || !folder ? setting : path.join(folder.uri.fsPath, setting);
  }
  try {
    const mtime = fs.statSync(file).mtimeMs;
    if (catalogCache.file !== file || catalogCache.mtime !== mtime) {
      catalogCache = { file, mtime, data: JSON.parse(fs.readFileSync(file, 'utf8')), warned: null };
      mergedCache = null;
    }
    return withModels(catalogCache.data);
  } catch (e) {
    if (catalogCache.warned !== file) {
      catalogCache = { file: null, mtime: 0, data: undefined, warned: file };
      vscode.window.showWarningMessage(`VP Studio: cannot read component catalog ${file} (${e.message}). Module types, ports and parameters are not checked.`);
    }
    return undefined;
  }
}

// Models built with the modeling wizard join the catalog, so platforms can
// use them like QBox's own modules. The list of their catalog files is kept
// up to date by refreshModelCatalogs (file watchers), so catalog() stays sync.
let modelCatalogFiles = [];
let mergedCache = null; // { base, key, catalog }
let clashWarned = new Set();
/**
 * Module libraries that come with VP Studio, as { type, title, dir (under
 * tools/), command }. Each is built on the user's machine against their QBox;
 * platforms name only the type, and the extension supplies the library path
 * when it generates Lua. None in this version (the Cortex-A73 module was
 * removed on 2026-11-18).
 */
const BUNDLED = [];
/**
 * Where the libraries VP Studio builds on the user's machine go: the
 * extension's user data folder, which stays writable when the extension itself
 * is not (the Theia application) and survives updates of the extension.
 * Libraries built inside the extension folder by older versions or by hand are
 * still found (legacyDir).
 */
function buildDir(...parts) {
  const base = extContext && extContext.globalStorageUri ? extContext.globalStorageUri.fsPath : path.join(__dirname, '.vp-build');
  return path.join(base, 'build', ...parts);
}
const firstExisting = (...files) => files.find((f) => fs.existsSync(f));
const bundledCatalogFile = (b) => firstExisting(
  buildDir(b.dir, `${b.type}.catalog.json`),
  path.join(__dirname, 'tools', b.dir, 'build', `${b.type}.catalog.json`)) || buildDir(b.dir, `${b.type}.catalog.json`);
/** The component catalog tool, built on first use by the scripts that need it. */
const catalogToolPath = () => firstExisting(path.join(__dirname, 'tools', 'qbox-catalog', 'qbox-catalog')) || buildDir('qbox-catalog', 'qbox-catalog');

function withModels(base) {
  const bundled = BUNDLED.filter((b) => fs.existsSync(bundledCatalogFile(b)));
  const files = bundled.map(bundledCatalogFile).concat(modelCatalogFiles);
  const key = files.map((f) => { try { return `${f}@${fs.statSync(f).mtimeMs}`; } catch (e) { return f; } }).join('|');
  if (mergedCache && mergedCache.base === base && mergedCache.key === key) return mergedCache.catalog;
  const unbuilt = BUNDLED.filter((b) => !bundled.includes(b)).map((b) => ({
    type: b.type,
    hint: `${b.type} comes with VP Studio but has not been built for your QBox yet. Run "VP Studio: Build ${b.title}".`,
  }));
  const r = models.merge(base, bundled.map((b) => models.loadModelCatalog(bundledCatalogFile(b), { bundled: true }))
    .concat(modelCatalogFiles.map((f) => models.loadModelCatalog(f))), unbuilt);
  for (const t of r.clashes) {
    if (clashWarned.has(t)) continue;
    clashWarned.add(t);
    vscode.window.showWarningMessage(`VP Studio: the model ${t} has the name of a QBox module type, so it is left out of the catalog. Rename the model.`);
  }
  mergedCache = { base, key, catalog: r.catalog };
  return r.catalog;
}

let modelSpecs = []; // [{file, spec}] of the workspace's models, for the register view
let workspaceRegisterFiles = []; // the workspace's *.registers.json, for the register view
async function refreshModelCatalogs() {
  workspaceRegisterFiles = (await vscode.workspace.findFiles('**/*.registers.json', '**/node_modules/**', 200)).map((u) => u.fsPath).sort();
  const specs = await vscode.workspace.findFiles('**/*.model.json', '**/node_modules/**', 200);
  const files = [];
  const found = [];
  for (const u of specs) {
    try {
      const spec = JSON.parse(await fs.promises.readFile(u.fsPath, 'utf8'));
      if (spec && typeof spec.name === 'string') {
        found.push({ file: u.fsPath, spec });
        const f = models.catalogFileFor(u.fsPath, spec.name);
        if (fs.existsSync(f)) files.push(f);
      }
    } catch (e) { /* not valid yet */ }
  }
  modelSpecs = found;
  if (files.join('|') !== modelCatalogFiles.join('|')) {
    modelCatalogFiles = files;
    vscode.workspace.textDocuments.forEach(refreshDiagnostics);
    for (const [key, panel] of panels) renderPanel(vscode.Uri.parse(key), panel);
  }
}

const analyzeWithCatalog = (data) => core.analyze(data, { catalog: catalog() });

// ------------------------------------------------------------------ helpers

async function pickPlatform(arg) {
  if (arg instanceof vscode.Uri) return arg;
  const active = vscode.window.activeTextEditor;
  if (active && isPlatform(active.document)) return active.document.uri;
  const found = await vscode.workspace.findFiles('**/*' + SUFFIX, '**/node_modules/**', 50);
  if (found.length === 0) {
    vscode.window.showWarningMessage('No *.platform.json file found in this workspace. Run "VP Studio: Create Example Platform" to add one.');
    return undefined;
  }
  if (found.length === 1) return found[0];
  const pick = await vscode.window.showQuickPick(
    found.map((u) => ({ label: path.basename(u.fsPath), description: vscode.workspace.asRelativePath(u), uri: u })),
    { placeHolder: 'Select a platform description' });
  return pick && pick.uri;
}

async function load(uri) {
  const doc = await vscode.workspace.openTextDocument(uri);
  try {
    return { textDoc: doc, data: JSON.parse(doc.getText()) };
  } catch (e) {
    vscode.window.showErrorMessage(`${path.basename(uri.fsPath)} is not valid JSON: ${e.message}`);
    return undefined;
  }
}

/** Find the line where a module (or one of its ports) is defined, for diagnostics and reveal. */
function locate(textDoc, moduleName, portName) {
  const text = textDoc.getText();
  if (moduleName) {
    const at = modules.definitionOffset(text, moduleName, portName);
    if (at !== null) return textDoc.lineAt(textDoc.positionAt(at).line).range;
  }
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let from = Math.max(0, text.search(/"modules"\s*:/));
  if (moduleName) {
    const m = new RegExp(`"${esc(moduleName)}"\\s*:`).exec(text.slice(from));
    if (m) {
      from += m.index;
      if (portName) {
        const p = new RegExp(`"${esc(portName).replace(/\d+/g, '(\\d+|\\{i\\})')}"\\s*:`).exec(text.slice(from));
        if (p) from += p.index;
      }
    }
  }
  const pos = textDoc.positionAt(from);
  return textDoc.lineAt(pos.line).range;
}

function refreshDiagnostics(textDoc) {
  if (!isPlatform(textDoc)) return;
  let data;
  try { data = JSON.parse(textDoc.getText()); } catch (e) { diagnostics.delete(textDoc.uri); return; }
  if (!data || typeof data.modules !== 'object') { diagnostics.delete(textDoc.uri); return; }
  const sev = { error: vscode.DiagnosticSeverity.Error, warning: vscode.DiagnosticSeverity.Warning, info: vscode.DiagnosticSeverity.Information };
  let problems;
  try {
    const analysis = analyzeWithCatalog(data);
    problems = analysis.problems.concat(images.collect(data, analysis, path.dirname(textDoc.uri.fsPath), { catalog: catalog() }).problems);
  } catch (e) { problems = [{ severity: 'error', message: e.message }]; }
  diagnostics.set(textDoc.uri, problems.map((p) => {
    const d = new vscode.Diagnostic(locate(textDoc, p.module, p.port), p.message, sev[p.severity]);
    d.source = 'VP Studio';
    return d;
  }));
}

function luaPathFor(uri, data) {
  return launch.luaPathFor(uri.fsPath, data);
}

/** Validate, generate and write the Lua file. Returns its path, or undefined when blocked by errors. */
async function generateFor(uri, options) {
  const r = await generateText(uri, options);
  if (!r) return undefined;
  const out = luaPathFor(uri, r.data);
  await fs.promises.writeFile(out, r.lua, 'utf8');
  return out;
}

/** The Lua of a platform as text ({lua, data}), or undefined after saying why not. */
async function generateText(uri, options) {
  const loaded = await load(uri);
  if (!loaded) return undefined;
  let analysis;
  let lua;
  try {
    analysis = analyzeWithCatalog(loaded.data);
    const errors = analysis.problems.filter((p) => p.severity === 'error');
    if (errors.length) {
      refreshDiagnostics(loaded.textDoc);
      vscode.window.showErrorMessage(`Not generated: ${errors.length} error(s) in ${path.basename(uri.fsPath)}. First: ${errors[0].message}`);
      return undefined;
    }
    // Types built outside QBox that the platform does not locate itself get
    // this machine's library path (only in the generated Lua).
    lua = core.generate(loaded.data, Object.assign({ libraries: models.libraries(catalog()) }, options));
  } catch (e) {
    vscode.window.showErrorMessage(`Generation failed: ${e.message}`);
    return undefined;
  }
  return { lua, data: loaded.data };
}

// ------------------------------------------------------------------ device tree

/**
 * The device tree compiler: the "vpStudio.dtc" command on this machine, or dtc
 * on the simulation host when it is set to "remote", and on Windows (no dtc
 * there) when a simulation host is set.
 */
function dtcTool() {
  const set = String(cfg().get('dtc') || '').trim();
  let rc;
  try { rc = remoteSettings(); } catch (e) { rc = undefined; }
  if (rc && (set === 'remote' || (IS_WINDOWS && (!set || set === 'dtc')))) return remote.toolRunner(rc, 'dtc', { timeoutMs: 60000 });
  return set && set !== 'remote' ? set : 'dtc';
}

function outputChannel() {
  if (!versionOutput) versionOutput = vscode.window.createOutputChannel('VP Studio');
  return versionOutput;
}

/**
 * Generate <name>.generated.dts next to the platform and compile it with dtc
 * to devicetree.output (or <name>.generated.dtb). Returns { dts, dtb, notes };
 * throws with dtc's message when it fails.
 */
async function deviceTreeFor(uri, data) {
  let r;
  try {
    r = await launch.writeDeviceTree(data, uri.fsPath, dtcTool());
  } catch (e) {
    throw new Error(/ not found;/.test(e.message) ? `${e.message} or set "vpStudio.dtc"` : e.message);
  }
  const { dts, dtb } = r;
  const ch = outputChannel();
  ch.appendLine(`Device tree for ${path.basename(uri.fsPath)}: ${dts} -> ${dtb}`);
  for (const n of r.notes) ch.appendLine(`  ${n.level === 'warning' ? 'Warning' : 'Note'}: ${n.text}`);
  return { dts, dtb, notes: r.notes };
}

/**
 * The Device tree tab of the platform view: the tree generated from the
 * platform now, compared with a DTB the loader loads or the DTS written last.
 * against: 'none' | 'output' | 'dtb:<module>:<index>' | 'auto' (a loaded DTB, else the last DTS, else none).
 */
async function deviceTreePane(uri, against) {
  const loaded = await load(uri);
  if (!loaded) return null;
  const data = loaded.data;
  const topDir = path.dirname(uri.fsPath);
  const candidates = [];
  const files = new Map();
  for (const l of images.collect(data, analyzeWithCatalog(data), topDir).loaders) {
    for (const e of l.entries) {
      if (e.kind === 'raw' || !e.exists || !dtcompare.isFdt(e.resolved)) continue;
      const id = `dtb:${l.module}:${e.index}`;
      candidates.push({ id, label: `DTB loaded by ${l.module}: ${vscode.workspace.asRelativePath(e.resolved)}` });
      files.set(id, { kind: 'dtb', file: e.resolved, label: vscode.workspace.asRelativePath(e.resolved) });
    }
  }
  let out = null;
  try { out = devicetree.outputPaths(data, uri.fsPath); } catch (e) { out = null; }
  if (out && fs.existsSync(out.dts)) {
    candidates.push({ id: 'output', label: `DTS written last: ${vscode.workspace.asRelativePath(out.dts)}` });
    files.set('output', { kind: 'dts', file: out.dts, label: vscode.workspace.asRelativePath(out.dts) });
  }
  if (against === 'auto' || (against !== 'none' && !files.has(against))) against = candidates.length ? candidates[0].id : 'none';
  const r = { candidates, against, notes: [], text: '' };
  try {
    const g = devicetree.generate(data, { topDir });
    r.text = g.dts;
    r.notes = g.notes;
    const other = files.get(against);
    if (other) {
      r.oldLabel = other.label;
      r.result = await dtcompare.compare(g.dts, other, dtcTool());
    }
  } catch (e) {
    r.error = `Cannot ${r.text ? 'compare' : 'generate'} the device tree: ${e.message}`;
  }
  return { type: 'deviceTree', against, html: view.deviceTreePane(r) };
}

async function cmdGenerateDeviceTree(arg) {
  const uri = await pickPlatform(arg);
  if (!uri) return;
  const loaded = await load(uri);
  if (!loaded) return;
  let r;
  try {
    r = await deviceTreeFor(uri, loaded.data);
  } catch (e) {
    vscode.window.showErrorMessage(`Device tree not generated: ${e.message}`);
    return;
  }
  const w = r.notes.filter((n) => n.level === 'warning').length;
  const msg = `Generated ${vscode.workspace.asRelativePath(r.dts)} and ${path.basename(r.dtb)}` +
    (w ? `, with ${w} warning${w > 1 ? 's' : ''}` : '') + (r.notes.length ? ' (see the VP Studio output)' : '') + '.';
  const pick = await (w ? vscode.window.showWarningMessage : vscode.window.showInformationMessage)(msg, 'Open DTS', ...(r.notes.length ? ['Show Notes'] : []));
  if (pick === 'Open DTS') vscode.window.showTextDocument(vscode.Uri.file(r.dts), { preview: true });
  else if (pick === 'Show Notes') outputChannel().show(true);
}

// ------------------------------------------------------------------ modeling wizard

const MODEL_SUFFIX = '.model.json';
const isModel = (doc) => !!doc && doc.fileName.endsWith(MODEL_SUFFIX);
let modelDiagnostics;

/** Problems of a model description, placed on the JSON property they are about. */
function refreshModelDiagnostics(textDoc) {
  if (!isModel(textDoc)) return;
  const text = textDoc.getText();
  let spec;
  try { spec = JSON.parse(text); } catch (e) { modelDiagnostics.delete(textDoc.uri); return; }
  const { problems } = modelgen.check(spec);
  let root;
  try { root = jsonedit.scan(text); } catch (e) { root = null; }
  const sev = { error: vscode.DiagnosticSeverity.Error, warning: vscode.DiagnosticSeverity.Warning };
  modelDiagnostics.set(textDoc.uri, problems.map((p) => {
    // "registers[2].offset" -> ["registers", 2, "offset"]; fall back to the closest found.
    const keys = String(p.path || '').split(/[.[\]]/).filter(Boolean).map((k) => (/^\d+$/.test(k) ? Number(k) : k));
    let node = null;
    for (let n = keys.length; n > 0 && root && !node; n--) node = jsonedit.find(root, keys.slice(0, n));
    const at = node ? node.start : 0;
    const d = new vscode.Diagnostic(textDoc.lineAt(textDoc.positionAt(at).line).range, p.message, sev[p.severity]);
    d.source = 'VP Studio';
    return d;
  }));
}

async function pickModel(arg) {
  if (arg instanceof vscode.Uri) return arg;
  const ed = vscode.window.activeTextEditor;
  if (ed && isModel(ed.document)) return ed.document.uri;
  const found = await vscode.workspace.findFiles('**/*' + MODEL_SUFFIX, '**/node_modules/**', 50);
  if (!found.length) { vscode.window.showWarningMessage('No *.model.json in this workspace. Run "VP Studio: New Model…" first.'); return undefined; }
  if (found.length === 1) return found[0];
  const sel = await vscode.window.showQuickPick(found.map((u) => ({ label: vscode.workspace.asRelativePath(u), u })), { placeHolder: 'Which model?' });
  return sel && sel.u;
}

/** Write the model's C++ (generated files every time, starter files once). */
async function generateModel(uri, quiet) {
  const textDoc = await vscode.workspace.openTextDocument(uri);
  let spec;
  try { spec = JSON.parse(textDoc.getText()); } catch (e) {
    if (!quiet) vscode.window.showErrorMessage(`${path.basename(uri.fsPath)} is not valid JSON: ${e.message}`);
    return undefined;
  }
  try {
    const r = models.writeFiles(uri.fsPath, spec);
    if (!quiet || r.written.length) {
      vscode.window.setStatusBarMessage(`VP Studio: ${r.written.length ? 'wrote ' + r.written.join(', ') : 'model code is up to date'}`, 8000);
    }
    return r;
  } catch (e) {
    if (!quiet) vscode.window.showErrorMessage(`Model code not generated: ${e.message.split('\n')[0]}${e.message.includes('\n') ? ' (see the Problems panel)' : ''}`);
    return undefined;
  }
}

async function cmdNewModel() {
  const folder = (vscode.workspace.workspaceFolders || [])[0];
  if (!folder) { vscode.window.showWarningMessage('Open a folder first.'); return; }
  const name = await vscode.window.showInputBox({
    title: 'New Model', prompt: 'Name of the module type (also the C++ class name)', value: 'my_device',
    validateInput: (v) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(v.trim()) ? undefined : 'Use letters, digits and _, not starting with a digit.'),
  });
  if (!name) return;
  const n = name.trim();
  const cat = catalog();
  if (cat && cat.modules && cat.modules[n] && !cat.modules[n].model) {
    vscode.window.showErrorMessage(`${n} is already a QBox module type; choose another name.`);
    return;
  }
  const def = vscode.Uri.joinPath(folder.uri, 'models', n);
  const picked = await vscode.window.showOpenDialog({
    canSelectFolders: true, canSelectFiles: false, canSelectMany: false, defaultUri: folder.uri,
    openLabel: 'Create Here', title: `Folder to create the model folder ${n} in (default: models/)`,
  });
  const dir = picked && picked[0] ? vscode.Uri.joinPath(picked[0], n) : def;
  const spec = path.join(dir.fsPath, n + MODEL_SUFFIX);
  if (fs.existsSync(spec)) { vscode.window.showErrorMessage(`${vscode.workspace.asRelativePath(spec)} already exists.`); return; }
  await fs.promises.mkdir(dir.fsPath, { recursive: true });
  await fs.promises.writeFile(spec, JSON.stringify(modelgen.template(n), null, 2) + '\n', 'utf8');
  models.writeFiles(spec, modelgen.template(n));
  await vscode.window.showTextDocument(vscode.Uri.file(spec), { preview: false });
  vscode.window.showTextDocument(vscode.Uri.file(path.join(dir.fsPath, 'include', n + '.h')), { preview: false, viewColumn: vscode.ViewColumn.Beside, preserveFocus: true });
  vscode.window.showInformationMessage(`Created model ${n}. Edit the registers, parameters and ports in ${n}.model.json (saving regenerates ${n}_regs.h), add behaviour in ${n}.h, then run "Build Model".`, 'Build Model')
    .then((p) => p && cmdBuildModel(vscode.Uri.file(spec)));
}

/**
 * Import IP-XACT… (G-10): the register map of an IP-XACT component becomes a
 * new model, the registers of an existing model, or a register description
 * (*.registers.json) of a platform module type for the Peripheral Registers view.
 */
async function cmdImportIpxact(arg) {
  const folder = (vscode.workspace.workspaceFolders || [])[0];
  if (!folder) { vscode.window.showWarningMessage('Open a folder first.'); return; }
  let file = arg instanceof vscode.Uri ? arg.fsPath : undefined;
  if (!file) {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false, defaultUri: folder.uri, openLabel: 'Import', title: 'IP-XACT component to import',
      filters: { 'IP-XACT': ['xml', 'ipxact', 'spirit'], 'All files': ['*'] },
    });
    if (!picked || !picked[0]) return;
    file = picked[0].fsPath;
  }
  const doc = ipxact.parse(await fs.promises.readFile(file, 'utf8'));
  const usable = doc.blocks.filter((b) => b.registers.length);
  if (!usable.length) {
    throw new Error(`${path.basename(file)} has no address block with registers${doc.notes.length ? ': ' + doc.notes.join(' ') : ''}`);
  }
  let block = usable[0];
  if (usable.length > 1) {
    const sel = await vscode.window.showQuickPick(usable.map((b) => ({ label: b.key, description: ipxact.blockSummary(b), detail: b.description || undefined, b })),
      { title: `Import IP-XACT: ${doc.vlnv.name || path.basename(file)}`, placeHolder: 'Which address block?' });
    if (!sel) return;
    block = sel.b;
  }
  const modelFiles = await vscode.workspace.findFiles('**/*' + MODEL_SUFFIX, '**/node_modules/**', 100);
  const choices = [
    { label: 'New model', detail: 'Create a modeling-wizard model with these registers; add behaviour, parameters and ports, then Build Model.', kind: 'new' },
  ];
  if (modelFiles.length) choices.push({ label: 'Replace the registers of a model…', detail: 'Keep its parameters, ports and your C++; regenerate the register code.', kind: 'update' });
  choices.push({ label: 'Register description for a module type…', detail: 'For a module that already exists (a QBox or QEMU device): the Peripheral Registers view then shows its registers.', kind: 'desc' });
  const what = await vscode.window.showQuickPick(choices, { title: `Import ${block.key} (${ipxact.blockSummary(block)})`, placeHolder: 'Import as' });
  if (!what) return;

  const report = () => {
    const out = outputChannel();
    out.appendLine(`Imported IP-XACT ${file} (${doc.standard}), address block ${block.key}: ${ipxact.blockSummary(block)}`);
    for (const n of doc.notes.concat(block.notes)) out.appendLine(`  note: ${n}`);
    const count = doc.notes.length + block.notes.length;
    return count ? ` ${count} note${count === 1 ? '' : 's'} on what was not imported as-is: see the VP Studio output.` : '';
  };

  if (what.kind === 'new') {
    const cat = catalog();
    const name = await vscode.window.showInputBox({
      title: 'Import IP-XACT: new model', prompt: 'Name of the module type (also the C++ class name)', value: ipxact.modelNameFor(doc, block),
      validateInput: (v) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(v.trim())) return 'Use letters, digits and _, not starting with a digit.';
        if (modelgen.RESERVED.has(v.trim())) return `${v.trim()} cannot be used as a name.`;
        if (cat && cat.modules && cat.modules[v.trim()] && !cat.modules[v.trim()].model) return `${v.trim()} is already a QBox module type.`;
        return undefined;
      },
    });
    if (!name) return;
    const n = name.trim();
    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: true, canSelectFiles: false, canSelectMany: false, defaultUri: folder.uri,
      openLabel: 'Create Here', title: `Folder to create the model folder ${n} in (default: models/)`,
    });
    const dir = picked && picked[0] ? path.join(picked[0].fsPath, n) : path.join(folder.uri.fsPath, 'models', n);
    const specFile = path.join(dir, n + MODEL_SUFFIX);
    if (fs.existsSync(specFile)) throw new Error(`${vscode.workspace.asRelativePath(specFile)} already exists; use "Replace the registers of a model…"`);
    const { spec, problems } = ipxact.toModel(doc, block, { name: n });
    const errors = problems.filter((p) => p.severity === 'error');
    if (errors.length) throw new Error(errors.map((e) => e.message).join(' '));
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(specFile, JSON.stringify(spec, null, 2) + '\n', 'utf8');
    models.writeFiles(specFile, spec);
    await vscode.window.showTextDocument(vscode.Uri.file(specFile), { preview: false });
    vscode.window.showInformationMessage(`Created model ${n} with ${spec.registers.length} registers from ${path.basename(file)}. Add parameters and signal ports in ${n}.model.json, behaviour in ${n}.h, then run "Build Model".${report()}`, 'Build Model')
      .then((p) => p && cmdBuildModel(vscode.Uri.file(specFile)));
    return;
  }

  if (what.kind === 'update') {
    let target = modelFiles[0];
    if (modelFiles.length > 1) {
      const sel = await vscode.window.showQuickPick(modelFiles.map((u) => ({ label: vscode.workspace.asRelativePath(u), u })), { placeHolder: 'Replace the registers of which model?' });
      if (!sel) return;
      target = sel.u;
    }
    const existing = JSON.parse(await fs.promises.readFile(target.fsPath, 'utf8'));
    const old = (existing.registers || []).length;
    const ok = await vscode.window.showWarningMessage(`Replace the ${old} register${old === 1 ? '' : 's'} of ${existing.name} with the ${block.registers.length} of ${block.key}? Parameters, ports and the files you edit (${existing.name}.h, .cc) stay; hooks for registers that no longer exist will not compile until you remove them.`,
      { modal: true }, 'Replace');
    if (ok !== 'Replace') return;
    const { spec, problems } = ipxact.toModel(doc, block, { existing });
    const errors = problems.filter((p) => p.severity === 'error');
    if (errors.length) throw new Error(errors.map((e) => e.message).join(' '));
    await fs.promises.writeFile(target.fsPath, JSON.stringify(spec, null, 2) + '\n', 'utf8');
    models.writeFiles(target.fsPath, spec);
    await vscode.window.showTextDocument(target, { preview: false });
    vscode.window.showInformationMessage(`${existing.name} now has the ${spec.registers.length} registers of ${block.key}; ${existing.name}_regs.h is regenerated.${report()}`, 'Build Model')
      .then((p) => p && cmdBuildModel(target));
    return;
  }

  // A register description of an existing module type.
  const cat = catalog();
  const types = Object.entries((cat && cat.modules) || {})
    .filter(([, m]) => !m.isContainer && ((m.introspection && m.introspection.ports) || []).some((p) => p.kind === 'tlm_target'))
    .map(([t, m]) => ({ label: t, description: m.model ? 'model' : (m.source || '').split('/').slice(0, 2).join('/'), t, m }));
  const ty = await vscode.window.showQuickPick(types, { title: `Registers of ${block.key} describe which module type?`, placeHolder: 'Module type (with a bus target port)', matchOnDescription: true });
  if (!ty) return;
  const ports = ty.m.introspection.ports.filter((p) => p.kind === 'tlm_target');
  let port = ports[0].name;
  if (ports.length > 1) {
    const sel = await vscode.window.showQuickPick(ports.map((p) => ({ label: p.name })), { placeHolder: `Which bus port of ${ty.t} has these registers?` });
    if (!sel) return;
    port = sel.label;
  }
  const out = path.join(folder.uri.fsPath, 'registers', `${ty.t}${port === 'target_socket' ? '' : '.' + port}.registers.json`);
  if (fs.existsSync(out)) {
    const ok = await vscode.window.showWarningMessage(`${vscode.workspace.asRelativePath(out)} exists. Replace it?`, { modal: true }, 'Replace');
    if (ok !== 'Replace') return;
  }
  const desc = ipxact.toDescription(doc, block, { types: [ty.t], port });
  registers.expand(desc, path.basename(out)); // throws on a description the view could not use
  await fs.promises.mkdir(path.dirname(out), { recursive: true });
  await fs.promises.writeFile(out, JSON.stringify(desc, null, 2) + '\n', 'utf8');
  await refreshModelCatalogs();
  await vscode.window.showTextDocument(vscode.Uri.file(out), { preview: false });
  vscode.window.showInformationMessage(`Wrote ${vscode.workspace.asRelativePath(out)}: the Peripheral Registers view shows these ${desc.registers.length} registers for every ${ty.t} on a bus.${report()}`);
}

/** QBox build folder of the configured simulator (where compile_commands.json is). */
function qboxBuildDir() {
  const { exePath } = simulatorPath(undefined);
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
  const script = path.join(__dirname, 'tools', dir, 'build.sh');
  const task = new vscode.Task({ type: 'shell', tool: dir }, vscode.TaskScope.Workspace, `Build ${title}`, 'VP Studio',
    new vscode.ShellExecution('bash', [script, build, ...extraArgs], { cwd: taskCwd(build), env: Object.assign({ VP_QBOX_CATALOG: catalogToolPath() }, env) }), []);
  task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, clear: true };
  const exec = await vscode.tasks.executeTask(task);
  return new Promise((resolve) => {
    const sub = vscode.tasks.onDidEndTaskProcess((e) => { if (e.execution === exec) { sub.dispose(); resolve(e.exitCode); } });
  });
}

// ------------------------------------------------------------------ Build QBox view

let qboxPanel;
const qboxRun = { running: false, last: null };
let qboxForm = null;
let qboxDirty = { src: null, value: null };
const QBOX_FORM_KEY = 'vpStudio.qboxBuild';

function qboxPin() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'qbox.pin.json'), 'utf8')); } catch (e) { return {}; }
}

/** The QBox folder VP Studio runs now: the parent of the simulator's build directory, else a QBox workspace folder. */
function qboxSrcDefault() {
  const { exePath } = simulatorPath(undefined);
  const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
  const c = qboxsetup.sourceCandidates(exePath, folders);
  return c.length ? c[0].dir : (folders[0] || '');
}

/** Whether the QBox folder has local changes to tracked files (git status), cached per folder. */
function qboxDirtyOf(src) {
  if (qboxDirty.src === src) return qboxDirty.value;
  qboxDirty = { src, value: null };
  if (qboxsetup.folderKind(src) === 'qbox') {
    require('child_process').execFile('git', ['-C', src, 'status', '--porcelain', '--untracked-files=no'], { timeout: 10000 }, (err, out) => {
      if (qboxDirty.src !== src) return;
      qboxDirty.value = err ? null : out.trim().length > 0;
      qboxPost();
    });
  }
  return null;
}

function qboxStatus(src) {
  const lib = simAgentLibrary({ quiet: true });
  return qboxsetup.inspect(src, { pin: qboxPin(), studioDir: __dirname, dirty: qboxDirtyOf(src), agentLib: lib ? lib + '.so' : null, cmakeTools: cmakeToolsState() });
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
  if (!qboxPanel || !qboxForm) return;
  const pin = qboxPin();
  const st = qboxStatus(qboxForm.src);
  const pinnedTargets = (pin.build && pin.build.libqemuTargets) || ['aarch64'];
  const targets = [...new Set([...pinnedTargets, ...((st.cache && st.cache.targets) || []), ...(qboxForm.targets || [])])];
  const presets = st.presets.length ? st.presets : [{ name: (pin.build && pin.build.preset) || 'gcc', label: (pin.build && pin.build.preset) || 'gcc' }];
  const check = qboxsetup.check(qboxForm, st, { simulator: simulatorPath(undefined).exePath });
  const script = path.join(__dirname, 'tools', 'qbox-pin', 'build-qbox.sh');
  const built = qboxForm.src ? path.join(path.resolve(qboxForm.src), 'build', 'platforms-vp') : '';
  qboxPanel.webview.postMessage({
    type: 'state', status: st, form: qboxForm,
    choices: { presets, targets, cache: qboxsetup.cacheChoices(qboxForm.src, process.env.CPM_SOURCE_CACHE || '') },
    check, compilerChange: check.errors.some((e) => /cannot change the compiler/.test(e)),
    command: qboxForm.src ? `bash ${qboxsetup.commandLine(qboxsetup.argsFor(qboxForm, script))}` : '',
    running: qboxRun.running, last: qboxRun.last,
    simulator: path.resolve(simulatorPath(undefined).exePath), built,
  });
}

function qboxSave() {
  if (extContext && qboxForm) extContext.workspaceState.update(QBOX_FORM_KEY, qboxForm);
}

/**
 * Build QBox: a view with the QBox folder, its build settings, the package
 * cache, VP Studio's patches and what to do afterwards; Build runs
 * tools/qbox-pin/build-qbox.sh (checkout, patches, configure, build) for both
 * the first build and later ones.
 */
async function cmdBuildQbox() {
  if (qboxPanel) { qboxPanel.reveal(undefined, false); qboxPost(); return; }
  qboxPanel = vscode.window.createWebviewPanel('vpStudio.qboxBuild', 'Build QBox', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
  const nonce = crypto.randomBytes(16).toString('hex');
  qboxPanel.webview.html = qboxview.render(nonce, qboxPanel.webview.cspSource);
  qboxPanel.onDidDispose(() => { qboxPanel = undefined; });
  qboxPanel.webview.onDidReceiveMessage((m) => qboxMessage(m).catch((e) => vscode.window.showErrorMessage(`Build QBox: ${e.message}`)));
}

async function qboxMessage(m) {
  if (!m) return;
  if (m.type === 'ready') {
    const saved = extContext && extContext.workspaceState.get(QBOX_FORM_KEY);
    qboxForm = saved && saved.src !== undefined ? saved : qboxDefaults(qboxSrcDefault());
    qboxPost();
  } else if (m.type === 'set' && m.form) {
    const f = m.form;
    if (f.src !== qboxForm.src) {
      // Another folder: its own configuration decides the defaults.
      qboxForm = qboxDefaults(f.src, f);
      qboxForm.src = f.src;
    } else {
      qboxForm = Object.assign(qboxForm, {
        preset: String(f.preset || qboxForm.preset), targets: Array.isArray(f.targets) ? f.targets.map(String) : qboxForm.targets,
        cache: f.cache && typeof f.cache === 'object' ? { mode: String(f.cache.mode), dir: f.cache.dir ? String(f.cache.dir) : null } : qboxForm.cache,
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
      defaultUri: isSrc ? (qboxForm.src ? vscode.Uri.file(qboxForm.src) : undefined) : (qboxForm.cache && qboxForm.cache.dir ? vscode.Uri.file(qboxForm.cache.dir) : undefined),
    });
    if (!u || !u.length) { qboxPost(); return; }
    if (isSrc) { const src = u[0].fsPath; qboxForm = qboxDefaults(src, qboxForm); qboxForm.src = src; } else qboxForm.cache = { mode: 'custom', dir: u[0].fsPath };
    qboxSave();
    qboxPost();
  } else if (m.type === 'command') {
    const cmd = { checkQbox: 'vpStudio.checkQBox', buildSimAgent: 'vpStudio.buildSimAgent' }[m.name];
    if (cmd) await vscode.commands.executeCommand(cmd);
    qboxPost();
  } else if (m.type === 'moveBuild') {
    const build = path.join(qboxForm.src, 'build');
    const to = `${build}.${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-')}`;
    const ok = await vscode.window.showWarningMessage(`Move ${build} to ${path.basename(to)}?`, { modal: true, detail: 'The next build then configures a new build directory with the chosen compiler. Delete the old one yourself once the new build works.' }, 'Move');
    if (ok !== 'Move') return;
    fs.renameSync(build, to);
    vscode.window.showInformationMessage(`Moved the old build directory to ${to}.`);
    qboxPost();
  } else if (m.type === 'cmakeToolsOff') {
    const st = qboxStatus(qboxForm.src);
    if (!st.cmakeTools) { qboxPost(); return; }
    const f = st.cmakeTools.file;
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, qboxsetup.cmakeToolsOffText(text));
    vscode.window.showInformationMessage(`CMake Tools no longer configures QBox by itself: set ${qboxsetup.CMAKE_TOOLS_OFF.join(', ')} to false in ${f}.`);
    qboxPost();
  } else if (m.type === 'build') {
    await qboxBuild();
  }
}

async function qboxBuild() {
  const st = qboxStatus(qboxForm.src);
  const check = qboxsetup.check(qboxForm, st, { simulator: simulatorPath(undefined).exePath });
  if (check.errors.length || qboxRun.running) { qboxPost(); return; }
  if (ctxState['vpStudio.running']) {
    const pick = await vscode.window.showWarningMessage(
      'A simulation is running. Building QBox replaces libraries it has loaded, which can crash it.', { modal: true }, 'Stop and Build', 'Build Anyway');
    if (!pick) return;
    if (pick === 'Stop and Build') await vscode.commands.executeCommand('vpStudio.stop');
  }
  const form = JSON.parse(JSON.stringify(qboxForm));
  const args = qboxsetup.argsFor(form, path.join(__dirname, 'tools', 'qbox-pin', 'build-qbox.sh'));
  const task = new vscode.Task({ type: 'shell', tool: 'qbox' }, vscode.TaskScope.Workspace, 'Build QBox', 'VP Studio',
    new vscode.ShellExecution('bash', args, { cwd: taskCwd(form.src), env: { ELECTRON_RUN_AS_NODE: '' } }), []);
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
  qboxDirty = { src: null, value: null };
  mergedCache = null;
  const notes = [];
  if (code === 0) {
    const built = path.join(path.resolve(form.src), 'build', 'platforms-vp');
    if (form.useForSim && path.resolve(simulatorPath(undefined).exePath) !== built) {
      await vscode.workspace.getConfiguration('vpStudio').update('executable', built, vscode.ConfigurationTarget.Workspace);
      notes.push(`vpStudio.executable is now ${built}`);
    }
    // Build Sim Agent builds against the QBox VP Studio uses (vpStudio.executable).
    const agentHere = form.agent && path.resolve(simulatorPath(undefined).exePath) === built;
    if (form.agent && !agentHere) notes.push('sim agent not built: VP Studio uses another QBox (tick "Use this QBox for simulations")');
    qboxRun.last = { code, at: Date.now(), text: notes.join('; ') };
    qboxPost();
    if (agentHere) await cmdBuildSimAgent();
  } else {
    qboxRun.last = { code, at: Date.now(), text: 'see the terminal' };
    vscode.window.showErrorMessage(`Building QBox failed (exit code ${code}); see the terminal.`);
  }
  qboxPost();
}

/** Build the sim agent into the extension folder, where Start Simulation looks for it. */
async function cmdBuildSimAgent() {
  fs.mkdirSync(buildDir('sim-agent'), { recursive: true });
  const code = await runToolBuild('Sim Agent', 'sim-agent', [buildDir('sim-agent', 'sim_agent.so')]);
  if (code === undefined) return;
  agentLibWarned = false;
  if (code === 0) vscode.window.showInformationMessage('Built the sim agent for your QBox. Simulations started from VP Studio now include it: pause, continue, parameters, tracing.');
  else vscode.window.showErrorMessage(`Building the sim agent failed (exit code ${code}); see the terminal.`);
}

/** Build a module library that comes with VP Studio (tools/<dir>/build.sh) against the user's QBox. */
async function cmdBuildBundled(b) {
  const build = qboxBuildDir();
  const code = await runToolBuild(b.title, b.dir, ['--out', buildDir(b.dir)]);
  if (code === undefined) return;
  mergedCache = null;
  vscode.workspace.textDocuments.forEach(refreshDiagnostics);
  for (const [key, panel] of panels) renderPanel(vscode.Uri.parse(key), panel);
  if (code === 0) vscode.window.showInformationMessage(`Built the ${b.title} (${b.type}) for ${build}. Platforms can use type "${b.type}"; no "dylib" is needed.`);
  else vscode.window.showErrorMessage(`Building the ${b.title} failed (exit code ${code}); see the terminal.`);
}

async function cmdBuildModel(arg) {
  const uri = await pickModel(arg);
  if (!uri) return;
  const textDoc = await vscode.workspace.openTextDocument(uri);
  if (textDoc.isDirty) await textDoc.save();
  if (!(await generateModel(uri, false))) return;
  const build = qboxBuildDir();
  if (!fs.existsSync(path.join(build, 'compile_commands.json'))) {
    vscode.window.showErrorMessage(`Building a model needs a QBox build: no compile_commands.json in ${build}. Build QBox, or set "vpStudio.executable" to its platforms-vp.`);
    return;
  }
  const script = path.join(__dirname, 'tools', 'model-build', 'build.sh');
  const dir = path.dirname(uri.fsPath);
  const task = new vscode.Task({ type: 'shell', model: dir }, vscode.TaskScope.Workspace, `Build model ${path.basename(dir)}`, 'VP Studio',
    new vscode.ShellExecution('bash', [script, build, dir], { cwd: taskCwd(dir), env: { VP_QBOX_CATALOG: catalogToolPath() } }), []);
  task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, clear: true };
  const exec = await vscode.tasks.executeTask(task);
  const code = await new Promise((resolve) => {
    const sub = vscode.tasks.onDidEndTaskProcess((e) => { if (e.execution === exec) { sub.dispose(); resolve(e.exitCode); } });
  });
  await refreshModelCatalogs();
  const name = (() => { try { return JSON.parse(textDoc.getText()).name; } catch (e) { return path.basename(dir); } })();
  if (code === 0) {
    vscode.window.showInformationMessage(`Built ${name}; its self-test passed, and it is in the component catalog: "Add Module…" in a platform lists it.`);
  } else {
    vscode.window.showErrorMessage(code === 3 ? `${name} was built, but its self-test failed; see the terminal.` : `Building ${name} failed (exit code ${code}); see the terminal.`);
  }
}

// ------------------------------------------------------------------ checkpoints (G-08)

async function cmdSaveCheckpoint() {
  if (runningRemote) {
    vscode.window.showWarningMessage(`Checkpoints of remote simulations are not supported yet: the checkpoint files and disk copies would be on ${runningRemote.host}.`);
    return;
  }
  if (!agent || !runningPlatform || !runningDoc) {
    vscode.window.showWarningMessage('Save Checkpoint needs a simulation started with "VP Studio: Start Simulation" and its sim agent connected.');
    return;
  }
  let info;
  try { info = await agent.request('agent.getInfo'); } catch (e) { vscode.window.showErrorMessage(`The sim agent did not answer: ${e.message}`); return; }
  if (!(info.methods || []).includes('ckpt.save')) {
    vscode.window.showErrorMessage(`This sim agent (${info.version}) cannot save checkpoints; it needs ${checkpoint.MIN_AGENT}. Rebuild it with "VP Studio: Build Sim Agent" and start the simulation again.`);
    return;
  }
  if (info.checkpoints === false) {
    const pick = await vscode.window.showErrorMessage(
      "This QBox's libqemu does not save the state of its devices (GIC, virtio, …), so a checkpoint would not run.", {
        modal: true,
        detail: 'Apply VP Studio\'s patches/libqemu/0001-register-device-vmstate.patch in libqemu\'s sources (QBox\'s build/_deps/libqemu-src, or libqemu_SOURCE_DIR in build/CMakeCache.txt when QBox uses a CPM source cache) with git apply and rebuild QBox (cmake --build build), or build QBox with tools/qbox-pin/build-qbox.sh.',
      }, 'Check QBox Version');
    if (pick) vscode.commands.executeCommand('vpStudio.checkQBox');
    return;
  }
  const root = checkpoint.rootFor(runningPlatform.fsPath);
  const name = await vscode.window.showInputBox({
    title: 'Save Checkpoint',
    prompt: `Name of the checkpoint (a folder in ${vscode.workspace.asRelativePath(root)})`,
    value: checkpoint.defaultName(runningDoc),
    validateInput: (v) => (/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(v) ? undefined : 'Letters, digits, ".", "_" and "-"'),
  });
  if (!name) return;
  const dir = path.join(root, name);
  if (fs.existsSync(dir)) {
    const ok = await vscode.window.showWarningMessage(`A checkpoint ${name} exists already.`, { modal: true }, 'Replace');
    if (ok !== 'Replace') return;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  let p;
  try {
    p = checkpoint.plan(runningDoc, {
      catalog: catalog(), descs: registerTree.descriptions().descs, buses: runningBuses,
      topDir: path.dirname(runningPlatform.fsPath), overrides: runningOverrides,
    });
  } catch (e) {
    vscode.window.showErrorMessage(`Cannot save a checkpoint: ${e.message}`);
    return;
  }
  if (p.unsaved.length) {
    const list = p.unsaved.map((u) => `• ${u.instance} (${u.type})`).join('\n');
    const go = await vscode.window.showWarningMessage(`The state of ${p.unsaved.length} SystemC model${p.unsaved.length > 1 ? 's' : ''} is not saved.`, {
      modal: true, detail: `${list}\n\nThey start from their reset state when the checkpoint is loaded, which may make the guest misbehave.`,
    }, 'Save Anyway');
    if (go !== 'Save Anyway') return;
  }
  const { exePath } = simulatorPath(runningPlatform);
  const src = pin.qboxSourceOf(exePath);
  const t0 = Date.now();
  let m;
  try {
    m = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Saving checkpoint ${name}` }, (progress) =>
      checkpoint.save(agent, dir, p, {
        name, platformFile: runningPlatform.fsPath, platformText: fs.readFileSync(runningPlatform.fsPath, 'utf8'),
        qboxCommit: src ? pin.gitHead(src.source) : undefined, agentVersion: info.version,
      }, { onPhase: (what) => progress.report({ message: what }) }));
  } catch (e) {
    vscode.window.showErrorMessage(`The checkpoint was not saved: ${e.message}`);
    return;
  }
  const out = outputChannel();
  out.appendLine(`Checkpoint ${dir}: simulated ${m.time.text}, ${checkpoint.fmtSize(checkpoint.diskUsage(dir))}, saved in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  for (const s of p.skipped) out.appendLine(`  not saved: ${s.instance} (${s.why})`);
  const pick = await vscode.window.showInformationMessage(
    `Saved checkpoint ${name} at ${simagent.formatTime(m.time.seconds)} (${checkpoint.fmtSize(checkpoint.diskUsage(dir))}).`, 'Reveal', 'Details');
  if (pick === 'Reveal') vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(path.join(dir, checkpoint.MANIFEST)));
  else if (pick === 'Details') out.show(true);
}

async function cmdStartFromCheckpoint(arg) {
  const uri = await pickPlatform(arg);
  if (!uri) return;
  const found = checkpoint.list(checkpoint.rootFor(uri.fsPath), uri.fsPath);
  if (!found.length) {
    vscode.window.showInformationMessage(`No checkpoints of ${path.basename(uri.fsPath)} yet. Start the simulation, bring the guest to the point you want, and run "VP Studio: Save Checkpoint…".`);
    return;
  }
  const pick = await vscode.window.showQuickPick(found.map((c) => ({
    label: c.manifest.name,
    description: c.manifest.time ? `at ${simagent.formatTime(c.manifest.time.seconds)}` : '',
    detail: `saved ${new Date(c.manifest.created).toLocaleString()} · ${checkpoint.fmtSize(checkpoint.diskUsage(c.dir))}`,
    c,
  })), { title: `Start ${path.basename(uri.fsPath, SUFFIX)} from a checkpoint`, placeHolder: 'The guest goes on from where the checkpoint was saved; its disk images are copied first' });
  if (!pick) return;
  const how = await vscode.window.showQuickPick([
    { label: 'Start', debug: false },
    { label: 'Start with Target Debug Port', debug: true, description: 'to attach a debugger' },
  ], { title: `Start from ${pick.c.manifest.name}` });
  if (!how) return;
  await start(uri, how.debug, [], { restore: { dir: pick.c.dir, manifest: pick.c.manifest } });
}

// ------------------------------------------------------------------ delivery kits (G-09)

const GIB = 1 << 30;

/** Run fn(report, signal) under a cancellable notification; report({ phase, done, total }) moves the bar. */
function withKitProgress(title, fn) {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, (progress, token) => {
    const ac = new AbortController();
    token.onCancellationRequested(() => ac.abort());
    let shown = 0;
    let phase = '';
    const report = ({ phase: ph, done, total }) => {
      const pct = total ? Math.floor((done / total) * 100) : 0;
      if (ph !== phase) { phase = ph; shown = 0; progress.report({ message: `${ph} 0%` }); }
      if (pct > shown) { progress.report({ increment: 0, message: `${ph} ${pct}%` }); shown = pct; }
    };
    return fn(report, ac.signal);
  });
}

/**
 * Third-Party Debugger Setup… (G-11): a TRACE32 script and a guide for
 * TRACE32, Arm DS and other GDB clients, with the platform's gdbstub address.
 */
async function cmdThirdPartyDebuggers(arg) {
  const uri = await pickPlatform(arg);
  if (!uri) return;
  const loaded = await load(uri);
  if (!loaded) return;
  const c = cfg();
  const target = thirdparty.gdbTarget(loaded.data, analyzeWithCatalog(loaded.data), { port: c.get('debug.gdbPort'), cpuInstance: c.get('debug.cpuInstance') });
  const addresses = [];
  for (const [ifname, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) addresses.push({ label: a.address, description: ifname });
  }
  const hostname = os.hostname();
  const hostSel = await vscode.window.showQuickPick([
    { label: 'localhost', description: 'The debugger runs on this machine (or reaches it through an SSH tunnel)' },
    { label: hostname, description: 'This machine\'s name, for a debugger on another machine' },
    ...addresses,
  ], { title: 'Third-Party Debugger Setup', placeHolder: `Where does the debugger connect to? (gdb port ${target.port})` });
  if (!hostSel) return;
  const base = path.basename(uri.fsPath).replace(/\.platform\.json$/, '');
  const dir = path.join(path.dirname(uri.fsPath), 'debug');
  const cmmFile = path.join(dir, `${base}.trace32.cmm`);
  const mdFile = path.join(dir, `${base}.debuggers.md`);
  const symbols = await symbolFilesFor(uri);
  const values = Object.assign({ platform: path.basename(uri.fsPath), host: hostSel.label, symbols, cmmFile, hostNames: [hostname, ...addresses.map((a) => a.label)] }, target);
  await fs.promises.mkdir(dir, { recursive: true });
  // TRACE32 runs on Windows too: CRLF line ends there are harmless and Notepad shows them.
  await fs.promises.writeFile(cmmFile, thirdparty.trace32Script(values).replace(/\n/g, '\r\n'), 'utf8');
  await fs.promises.writeFile(mdFile, thirdparty.guide(values), 'utf8');
  await showMarkdown(mdFile);
  const how = target.source === 'platform' ? '' : ' Start it with "Start Simulation with Target Debug Port".';
  vscode.window.showInformationMessage(`Wrote ${vscode.workspace.asRelativePath(cmmFile)} (TRACE32) and the guide for TRACE32, Arm DS and other GDB clients. The gdbstub is ${hostSel.label}:${target.port}.${how}`);
}

async function cmdExportKit(arg) {
  const uri = await pickPlatform(arg);
  if (!uri) return;
  const textDoc = await vscode.workspace.openTextDocument(uri);
  if (textDoc.isDirty) await textDoc.save();
  const loaded = await load(uri);
  if (!loaded) return;
  let p;
  try {
    p = kit.plan(loaded.data, uri.fsPath, { catalog: catalog(), pinFile: path.join(__dirname, 'qbox.pin.json'), bundledTypes: BUNDLED.map((b) => b.type) });
  } catch (e) {
    vscode.window.showErrorMessage(`Cannot make a kit of ${path.basename(uri.fsPath)}: ${e.message}`);
    return;
  }
  if (p.missing.length) {
    const list = p.missing.map((m) => `• ${m.ref}`).join('\n');
    const go = await vscode.window.showWarningMessage(`${p.missing.length} file${p.missing.length > 1 ? 's' : ''} the platform names ${p.missing.length > 1 ? 'do' : 'does'} not exist:`,
      { modal: true, detail: `${list}\n\nThe kit will not boot without ${p.missing.length > 1 ? 'them' : 'it'} unless the receiver adds ${p.missing.length > 1 ? 'them' : 'it'}.` }, 'Export Without Them');
    if (!go) return;
  }
  const items = p.files.map((f) => ({
    label: path.posix.basename(f.path),
    description: `${kit.ROLE_NAMES[f.role] || f.role} · ${kit.fmtSize(f.size)}`,
    detail: f.path,
    picked: f.size < GIB,
    file: f,
  }));
  const chosen = await pickMany(items, {
    title: `Export Kit: ${p.name}`,
    placeHolder: 'Files to put in the kit. Unchecked ones are left out; the README gives their size and sha256 so the receiver can add them.',
    ignoreFocusOut: true,
  });
  if (!chosen) return;
  const omit = new Set(p.files.filter((f) => !chosen.some((c) => c.file === f)).map((f) => f.path));
  const urls = {};
  for (const f of p.files.filter((x) => omit.has(x.path))) {
    const url = await vscode.window.showInputBox({
      title: `Left out: ${path.posix.basename(f.path)} (${kit.fmtSize(f.size)})`,
      prompt: 'Where can the receiver get this file? A URL or a note for the README (optional; Enter to skip).',
      ignoreFocusOut: true,
    });
    if (url === undefined) return;
    if (url.trim()) urls[f.path] = url.trim();
  }
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(folder ? folder.uri.fsPath : path.dirname(uri.fsPath), `${p.name}-kit.tar.gz`)),
    filters: { 'VP Studio kit': ['tar.gz', 'tgz'] },
    title: 'Save the kit',
  });
  if (!target) return;
  const file = kit.kitFileName(target.fsPath);
  const { exePath } = simulatorPath(uri);
  const src = pin.qboxSourceOf(exePath);
  const used = src && pin.gitHead(src.source);
  const t0 = Date.now();
  let m;
  try {
    m = await withKitProgress(`Exporting kit ${p.name}`, (report, signal) => kit.exportKit(p, file, {
      omit, urls, allowMissing: true, signal, onProgress: report,
      vpStudio: extContext && extContext.extension ? extContext.extension.packageJSON.version : undefined,
      qboxUsed: used ? { commit: used } : undefined,
    }));
  } catch (e) {
    vscode.window.showErrorMessage(e.message === 'cancelled' ? 'Kit export cancelled.' : `Kit not written: ${e.message}`);
    return;
  }
  const out = outputChannel();
  out.appendLine(`Kit ${file}: ${m.files.length} files, ${kit.fmtSize(m.archive.size)}, in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  for (const x of m.omitted) out.appendLine(`  left out ${x.path} (${kit.fmtSize(x.size)}, sha256 ${x.sha256})${x.url ? ` from ${x.url}` : ''}`);
  for (const x of p.missing) out.appendLine(`  not found ${x.ref}`);
  for (const n of p.notes) out.appendLine(`  note: ${n}`);
  const left = m.omitted.length ? `, ${m.omitted.length} file${m.omitted.length > 1 ? 's' : ''} left out` : '';
  const pick = await vscode.window.showInformationMessage(`Wrote ${path.basename(file)}: ${m.files.length} files, ${kit.fmtSize(m.archive.size)}${left}.`, 'Reveal', 'Details');
  if (pick === 'Reveal') vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(file));
  else if (pick === 'Details') out.show(true);
}

async function cmdOpenKit(arg) {
  let archive = arg instanceof vscode.Uri ? arg : undefined;
  if (!archive) {
    const picked = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'VP Studio kit': ['tar.gz', 'tgz', 'tar'] }, title: 'Open a VP Studio kit' });
    if (!picked) return;
    archive = picked[0];
  }
  let head;
  try {
    head = await kit.readManifest(archive.fsPath);
  } catch (e) {
    vscode.window.showErrorMessage(e.message);
    return;
  }
  const ws = (vscode.workspace.workspaceFolders || [])[0];
  const into = await vscode.window.showOpenDialog({
    canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
    defaultUri: ws ? ws.uri : vscode.Uri.file(path.dirname(archive.fsPath)),
    openLabel: `Unpack ${head.top} here`,
    title: `Where to unpack ${head.manifest.name} (a folder ${head.top} is made there)`,
  });
  if (!into) return;
  const unpack = (overwrite) => withKitProgress(`Opening kit ${head.manifest.name}`, (report) => kit.importKit(archive.fsPath, into[0].fsPath, { overwrite, onProgress: report }));
  let r;
  try {
    r = await unpack(false);
  } catch (e) {
    if (e.code !== 'EEXIST') { vscode.window.showErrorMessage(`Kit not opened: ${e.message}`); return; }
    const again = await vscode.window.showWarningMessage(`${e.message}.`, { modal: true, detail: 'Unpacking again overwrites the files of the kit there; other files stay.' }, 'Overwrite');
    if (!again) return;
    try { r = await unpack(true); } catch (e2) { vscode.window.showErrorMessage(`Kit not opened: ${e2.message}`); return; }
  }
  const out = outputChannel();
  out.appendLine(`Kit ${head.manifest.name} unpacked to ${r.dir}`);
  if (r.bad.length) {
    for (const b of r.bad) out.appendLine(`  damaged: ${b}`);
    vscode.window.showErrorMessage(`${r.bad.length} file${r.bad.length > 1 ? 's' : ''} of the kit ${r.bad.length > 1 ? 'are' : 'is'} damaged (checksum or size wrong): ${r.bad.slice(0, 3).join(', ')}${r.bad.length > 3 ? ', …' : ''}. Get the kit again.`, 'Details')
      .then((x) => x && out.show(true));
  }
  // The QBox version it was tested with.
  const want = r.manifest.qbox && r.manifest.qbox.commit;
  let local;
  try { local = pin.readPin(path.join(__dirname, 'qbox.pin.json')); } catch (e) { local = undefined; }
  if (want && local && local.qbox.commit !== want) {
    out.appendLine(`  the kit was tested with QBox ${pin.short(want)}; this VP Studio pins ${pin.short(local.qbox.commit)}`);
    vscode.window.showWarningMessage(`The kit was tested with QBox ${pin.short(want)}, this VP Studio with ${pin.short(local.qbox.commit)}. It may still work; see qbox/qbox.pin.json in the kit.`);
  }
  // What the receiver has to build or add.
  const cat = catalog();
  for (const t of r.manifest.bundled || []) {
    const b = BUNDLED.find((x) => x.type === t);
    if (b && !fs.existsSync(bundledCatalogFile(b))) {
      vscode.window.showInformationMessage(`The platform uses ${t}, which has not been built on this machine yet.`, `Build ${b.title}`)
        .then((x) => x && vscode.commands.executeCommand(b.command));
    }
  }
  for (const m of r.manifest.models || []) {
    const spec = path.join(r.dir, ...m.spec.split('/'));
    if (cat && cat.modules && cat.modules[m.name]) continue;
    vscode.window.showInformationMessage(`The kit has the model ${m.name}; build it before starting the platform.`, 'Build Model')
      .then((x) => x && cmdBuildModel(vscode.Uri.file(spec)));
  }
  for (const o of kit.omittedReport(r.dir, r.manifest)) {
    if (o.state === 'present') continue;
    out.appendLine(`  ${o.state === 'missing' ? 'to add' : 'wrong size'}: ${o.path} (${kit.fmtSize(o.size)}, sha256 ${o.sha256})${o.url ? ` from ${o.url}` : ''}`);
    omittedPrompt(r.dir, o);
  }
  // Open it.
  const inWs = !!vscode.workspace.getWorkspaceFolder(vscode.Uri.file(r.platform));
  await vscode.window.showTextDocument(vscode.Uri.file(r.platform), { preview: false });
  vscode.commands.executeCommand('vpStudio.showPlatform', vscode.Uri.file(r.platform));
  if (!inWs) {
    const add = await vscode.window.showInformationMessage(`Opened ${path.basename(r.platform)} from ${r.dir}. Add the kit to the workspace, so its models and files are found?`, 'Add to Workspace');
    if (add) vscode.workspace.updateWorkspaceFolders((vscode.workspace.workspaceFolders || []).length, 0, { uri: vscode.Uri.file(r.dir) });
  }
}

/** Ask for a file the kit left out: pick one (checked against the kit's sha256, then copied into place) or see where to get it. */
async function omittedPrompt(dir, o) {
  const name = path.posix.basename(o.path);
  const buttons = ['Locate…', ...(o.url ? ['Where to Get It'] : []), 'Copy Checksum'];
  const pick = await vscode.window.showWarningMessage(
    `The kit leaves out ${name} (${kit.fmtSize(o.size)})${o.state === 'size' ? ', and the file there has the wrong size' : ''}. Add it before starting the platform.`, ...buttons);
  if (pick === 'Copy Checksum') { vscode.env.clipboard.writeText(`${o.sha256}  ${o.path}`); return; }
  if (pick === 'Where to Get It') {
    if (/^https?:\/\//.test(o.url)) vscode.env.openExternal(vscode.Uri.parse(o.url));
    else vscode.window.showInformationMessage(`${name}: ${o.url}`);
    return;
  }
  if (pick !== 'Locate…') return;
  const f = await vscode.window.showOpenDialog({ canSelectMany: false, title: `Locate ${name} (${kit.fmtSize(o.size)})` });
  if (!f) return;
  const src = f[0].fsPath;
  if (fs.statSync(src).size !== o.size) {
    vscode.window.showErrorMessage(`${path.basename(src)} is ${kit.fmtSize(fs.statSync(src).size)}, but the kit expects ${kit.fmtSize(o.size)}. Not copied.`);
    return;
  }
  try {
    await withKitProgress(`Checking and copying ${name}`, async (report, signal) => {
      const ok = await kit.checkOmitted(o, src, (done) => { if (signal.aborted) throw new Error('cancelled'); report({ phase: 'checksum', done, total: o.size }); });
      if (!ok) throw new Error(`${path.basename(src)} is not the file the kit was made with (its sha256 differs)`);
      report({ phase: 'copying', done: 0, total: 1 });
      await fs.promises.mkdir(path.dirname(o.file), { recursive: true });
      await fs.promises.copyFile(src, o.file);
    });
  } catch (e) {
    vscode.window.showErrorMessage(e.message === 'cancelled' ? `${name} not copied.` : `${e.message}.`);
    return;
  }
  vscode.window.showInformationMessage(`Copied ${name} into the kit.`);
}

// ------------------------------------------------------------------ commands

async function cmdGenerate(arg) {
  const uri = await pickPlatform(arg);
  if (!uri) return;
  const out = await generateFor(uri);
  if (!out) return;
  const open = await vscode.window.showInformationMessage(`Generated ${vscode.workspace.asRelativePath(out)}`, 'Open');
  if (open) vscode.window.showTextDocument(vscode.Uri.file(out), { preview: true });
}

/** traceIds: trace points ("module.port") to put a vp_tracer in front of. opts.profile: sample the guest's program counter. */
/**
 * Add the sim agent, its probes and profiling to the generate options.
 * agentLib: the library path (without .so) as the simulator sees it;
 * agentVersion: its version. Returns { probeIds, recording } or undefined
 * after saying why the start cannot go on.
 */
function addAgentOptions(options, platform, { agentLib, agentVersion, agentPort, traceIds, opts, restore, qboxBuild }) {
  const c = cfg();
  // G-12: with agent 0.9.0, a probe goes at every place one fits; only the
  // chosen ones (traceIds) record from the start, the others wait for
  // "Choose Probes…". Older agents record at every tracer, so only the chosen.
  let probeIds = traceIds;
  let recording;
  if (agentLib && c.get('probes.insertAll') !== false && pin.versionAtLeast(agentVersion, '0.9.0')) {
    probeIds = trace.probeList(platform.data, catalog()).map((p) => p.id);
    for (const id of traceIds) if (!probeIds.includes(id)) probeIds.push(id);
    recording = traceIds;
  }
  if (!agentLib) return { probeIds, recording };
  // One bus socket per router, for the register view (mem.read / mem.write).
  runningBuses = core.analyze(platform.data).routers;
  options.extraModules = [launch.agentModule(agentLib, agentPort, runningBuses, restore ? restore.agentParams : {})];
  if (opts.ftrace && !pin.versionAtLeast(agentVersion, ftrace.MIN_AGENT)) {
    vscode.window.showErrorMessage(`The function trace needs sim agent ${ftrace.MIN_AGENT} or later (this one is ${agentVersion || 'older'}). Rebuild it with "VP Studio: Build Sim Agent".`, 'Build Sim Agent')
      .then((x) => x && vscode.commands.executeCommand('vpStudio.buildSimAgent'));
    return undefined;
  }
  if (opts.profile || opts.ftrace) {
    // QBox's libidlinker plugin gives the agent a QEMU plugin id (G-05).
    const q = core.analyze(platform.data).instances.find((i) => i.type === 'QemuInstance');
    if (!q) { vscode.window.showErrorMessage(`${opts.profile ? 'Profiling' : 'The function trace'} needs a QemuInstance in the platform.`); return undefined; }
    if (opts.profile) options.extraModules[0].params.profile = true;
    if (opts.ftrace) {
      options.extraModules[0].params.ftrace = true;
      const n = Number(c.get('ftrace.bufferPerCpu'));
      if (Number.isInteger(n) && n > 0) options.extraModules[0].params.ftrace_buffer = n;
    }
    options.overrides = (options.overrides || []).concat([
      { instance: q.name, param: 'qemu_args.-plugin', value: `libidlinker.so,key=platform.${AGENT_INSTANCE}.profile_id` },
    ]);
  }
  // The probes and the debug port: QBox components for agent 0.14.0, the agent's library before.
  const libs = trace.probeLibraries(agentVersion, agentLib, pin.versionAtLeast);
  const qboxHas = (file) => !libs.inQbox || !qboxBuild || fs.existsSync(path.join(qboxBuild, file));
  if (opts.openocd) {
    // G-13: the JTAG debug port OpenOCD connects to (agent 0.13.0, QBox's debug_dap from 0.14.0).
    if (!pin.versionAtLeast(agentVersion, debugdap.MIN_AGENT)) {
      vscode.window.showErrorMessage(`The OpenOCD debug port needs sim agent ${debugdap.MIN_AGENT} or later (this one is ${agentVersion || 'older'}). Rebuild it with "VP Studio: Build Sim Agent".`, 'Build Sim Agent')
        .then((x) => x && vscode.commands.executeCommand('vpStudio.buildSimAgent'));
      return undefined;
    }
    try {
      if (!qboxHas('debug_dap.so')) throw new Error(`QBox's build (${qboxBuild}) has no debug_dap.so. Build it there: cmake --build ${qboxBuild} --target debug_dap`);
      options.extraModules.push(debugdap.dapModule(platform.data, opts.openocd.port, libs.dap, libs.types.dap));
    } catch (e) {
      vscode.window.showErrorMessage(`Cannot add the OpenOCD debug port: ${e.message}`);
      return undefined;
    }
  }
  if (probeIds.length) {
    try {
      if (!qboxHas('probes.so')) throw new Error(`QBox's build (${qboxBuild}) has no probes.so. Build it there: cmake --build ${qboxBuild} --target probes`);
      const t = trace.traceOptions(platform.data, probeIds, libs.probes, catalog(), { recording, router: pin.versionAtLeast(agentVersion, '0.12.0'), types: libs.types });
      options.extraModules.push(...t.extraModules);
      options.portOverrides = t.portOverrides;
    } catch (e) {
      vscode.window.showErrorMessage(`Cannot trace: ${e.message}`);
      return undefined;
    }
  }
  return { probeIds, recording };
}

/** What every start does once the simulator's terminal is open. */
function afterStart({ uri, platform, options, debug, port, traceIds, probeIds, recording, opts, restore, agentPort, hostPortValues, movedPorts, where, remoteInfo }) {
  runningPlatform = uri;
  runningDoc = platform.data;
  runningOverrides = (options.overrides || []).slice();
  runningRemote = remoteInfo;
  restoreReported = false;
  registerTree.reset();
  setRunning(true, [where || '', debug ? `gdb port ${port}` : '', traceIds.length ? `tracing ${traceIds.length}` : '',
    recording && probeIds.length ? `${probeIds.length} probes` : '', opts.profile ? 'profiling' : '', opts.ftrace ? 'function trace' : '',
    opts.openocd ? `OpenOCD port ${opts.openocd.port}` : '',
    restore ? `from checkpoint ${opts.restore.manifest.name}` : ''].filter(Boolean).join(', '));
  traceProbes = [];
  traceTitle = `Transaction Trace: ${path.basename(uri.fsPath, SUFFIX)}`;
  profileState = { uri, offset: undefined, offsetAt: 0 };
  if (opts.profile) showProfilePanel(uri, true);
  if (agentPort) connectAgent({ port: agentPort, auto: true, handshake: !!remoteInfo });
  if (traceIds.length) showTracePanel(true);
  const portList = Object.entries(hostPortValues).map(([k, v]) => `${k}=${v}`).join(', ');
  if (portList) statusItem.tooltip = `Stop the simulation\nHost ports${remoteInfo ? ' (on this machine)' : ''}: ${portList}`;
  if (movedPorts.length) {
    vscode.window.showInformationMessage(
      'Some host ports were taken, so this simulation uses others: ' +
      movedPorts.map((m) => `${m.name} ${m.from === null ? '?' : m.from} → ${m.to}`).join(', ') + '.');
  }
  if (opts.openocd) writeOpenOcdConfig(uri, platform.data, opts.openocd.port).catch((e) => vscode.window.showErrorMessage(`Could not write the OpenOCD configuration: ${e.message}`));
  if (debug) {
    vscode.window.showInformationMessage(
      `Simulation started with a gdb server requested on port ${port}${remoteInfo ? ` (forwarded from ${remoteInfo.host})` : ''}. Attach with the "VP: attach to target software" debug configuration.`,
      'Add Debug Configurations').then((p) => p && cmdAddDebugConfigs(uri));
  }
}

async function start(arg, debug, traceIds = [], opts = {}) {
  const uri = await pickPlatform(arg);
  if (!uri) return;
  const c = cfg();
  let rc;
  try { rc = remoteSettings(); } catch (e) {
    vscode.window.showErrorMessage(`VP Studio: ${e.message}`, 'Open Settings').then((p) => p && vscode.commands.executeCommand('workbench.action.openSettings', 'vpStudio.remote'));
    return;
  }
  if (rc) {
    try { await startRemote(uri, rc, debug, traceIds, opts); } catch (e) {
      if (await offerPasswordLogin(rc, e)) { start(arg, debug, traceIds, opts); return; }
      vscode.window.showErrorMessage(`Remote simulation on ${rc.host}: ${e.message}`);
    }
    return;
  }
  if (IS_WINDOWS) { needHost('Start Simulation'); return; }
  const { cwd, exePath } = simulatorPath(uri);
  if (!fs.existsSync(exePath)) {
    const pick = await vscode.window.showErrorMessage(
      `Simulator executable not found: ${exePath}. Build QBox first, or set "vpStudio.executable".`, 'Open Settings');
    if (pick) vscode.commands.executeCommand('workbench.action.openSettings', 'vpStudio.executable');
    return;
  }
  warnVersions(exePath);
  const port = c.get('debug.gdbPort');
  const options = debug
    ? { overrides: [{ instance: c.get('debug.cpuInstance'), param: c.get('debug.gdbPortParam'), value: port }] }
    : {};
  // Host ports the platform forwards (QEMU hostfwd): keep each configured
  // port when free, move it to a free one otherwise, so a second simulation
  // does not fail with "Could not set up host forwarding rule".
  let movedPorts = [];
  let hostPortValues = {};
  const platform = await load(uri);
  if (!platform) return;
  // G-08: start from a checkpoint. The disks are copies (or snapshot=on), so
  // the lock and free-space checks of the platform's own images do not apply.
  let restore;
  if (opts.restore) {
    try {
      restore = checkpoint.restorePlan(opts.restore.manifest, opts.restore.dir, platform.data, { platformText: platform.textDoc.getText() });
    } catch (e) {
      vscode.window.showErrorMessage(`Cannot start from the checkpoint: ${e.message}`);
      return;
    }
    const errs = restore.problems.filter((p) => p.level === 'error');
    if (errs.length) { vscode.window.showErrorMessage(`Cannot start from the checkpoint: ${errs[0].text}`); return; }
    for (const w of restore.problems.filter((p) => p.level === 'warning')) {
      const go = await vscode.window.showWarningMessage(w.text, { modal: true }, 'Start Anyway');
      if (go !== 'Start Anyway') return;
    }
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Checkpoint ${opts.restore.manifest.name}` },
        (progress) => checkpoint.prepare(restore, (what) => progress.report({ message: what })));
    } catch (e) {
      vscode.window.showErrorMessage(`Cannot copy the checkpoint's disk images: ${e.message}`);
      return;
    }
    options.overrides = (options.overrides || []).concat(restore.overrides);
  }
  // A platform that names a devicetree.output gets it regenerated, so the
  // device tree always matches the modules being started.
  if (platform.data.devicetree && platform.data.devicetree.output) {
    try {
      await deviceTreeFor(uri, platform.data);
    } catch (e) {
      const pick = await vscode.window.showErrorMessage(`The device tree could not be generated: ${e.message}`, { modal: true, detail: 'Starting anyway uses the device tree file as it is now.' }, 'Start Anyway');
      if (pick !== 'Start Anyway') return;
    }
  }
  // A loader file that does not exist stops the simulator at start ("cannot get
  // file size"); say which one first. After the device tree step, so a
  // generated DTB is already there.
  try {
    const missing = images.missingFiles(images.collect(platform.data, core.analyze(platform.data), path.dirname(uri.fsPath)));
    if (missing.length) {
      const dt = platform.data.devicetree;
      const list = missing.map((m) => `${m.module}[${m.index}]: ${m.file}`).join('\n');
      const hint = missing.some((m) => /\.dtb$/i.test(m.resolved)) && !(dt && dt.output)
        ? '\n\nA device tree file is missing. To have VP Studio generate it at every start, set "devicetree": {"output": …} in the platform to the same path.'
        : '';
      const pick = await vscode.window.showWarningMessage(`${missing.length === 1 ? 'A file' : `${missing.length} files`} the loader needs ${missing.length === 1 ? 'does' : 'do'} not exist.`, {
        modal: true,
        detail: `${list}\n\nThe simulator would stop at start ("cannot get file size").${hint}`,
      }, 'Start Anyway');
      if (pick !== 'Start Anyway') return;
    }
  } catch (e) { /* the image check is advisory */ }
  // QEMU locks a disk image while a simulation writes to it, so a second
  // simulation of the same platform would stop at start. Say so first.
  const locked = restore ? [] : disklock.lockedImages(platform.data, path.dirname(uri.fsPath));
  if (locked.length) {
    const l = locked[0];
    const who = l.holders.length
      ? ` by ${l.holders.map((h) => `${path.basename((h.cmd || '?').split(' ')[0])} (pid ${h.pid})`).join(', ')}` : ' by another process';
    const pick = await vscode.window.showWarningMessage(`The disk image of ${l.module} is in use${who}.`, {
      modal: true,
      detail: `${l.file}\n\nQEMU locks a disk image while a simulation writes to it, so this simulation would stop at start with "Failed to get write lock". Stop the other simulation first, or give this platform its own copy of the image.`,
    }, 'Start Anyway');
    if (pick !== 'Start Anyway') return;
  }
  // A guest whose disk is full still boots, but services that write state fail
  // (2026-11-15: name resolution, time sync, hostname on the Ubuntu platform).
  // Warn without blocking the start.
  try {
    const low = restore ? [] : diskspace.lowImages(disklock.diskImages(platform.data, path.dirname(uri.fsPath)));
    if (low.length) warnLowDisk(low);
  } catch (e) { /* advisory */ }
  try {
    const chosen = await hostports.choosePorts(hostports.hostPortVariables(platform.data));
    hostPortValues = chosen.values;
    movedPorts = chosen.moved;
    if (Object.keys(hostPortValues).length) options.variableValues = hostPortValues;
  } catch (e) {
    vscode.window.showWarningMessage(`VP Studio: could not check host ports (${e.message}); starting with the configured ones.`);
  }
  const agentLib = simAgentLibrary();
  let agentPort;
  if ((opts.profile || opts.ftrace || opts.openocd) && !agentLib) {
    vscode.window.showErrorMessage(`${opts.profile ? 'Profiling' : opts.ftrace ? 'The function trace' : 'The OpenOCD debug port'} needs the sim agent library. Build it with "VP Studio: Build Sim Agent".`, 'Build Sim Agent')
      .then((x) => x && vscode.commands.executeCommand('vpStudio.buildSimAgent'));
    return;
  }
  if (restore && !(agentLib && pin.versionAtLeast(pin.agentVersion(agentLib + '.so'), checkpoint.MIN_AGENT))) {
    vscode.window.showErrorMessage(`Starting from a checkpoint needs sim agent ${checkpoint.MIN_AGENT} or later. Rebuild it with "VP Studio: Build Sim Agent".`, 'Build Sim Agent')
      .then((x) => x && vscode.commands.executeCommand('vpStudio.buildSimAgent'));
    return;
  }
  if (traceIds.length && !agentLib) {
    vscode.window.showErrorMessage('Tracing needs the sim agent library (sim_agent.so). Build it with tools/sim-agent/build.sh, or set "vpStudio.simAgent.library".');
    return;
  }
  if (agentLib) agentPort = await simagent.freePort();
  const added = addAgentOptions(options, platform, { agentLib, agentVersion: pin.agentVersion(agentLib && agentLib + '.so'), agentPort, traceIds, opts, restore, qboxBuild: path.dirname(exePath) });
  if (!added) return;
  const { probeIds, recording } = added;
  const lua = await generateFor(uri, options);
  if (!lua) return;
  disconnectAgent();
  if (terminal) terminal.dispose();
  terminal = vscode.window.createTerminal({ name: `VP: ${path.basename(uri.fsPath, SUFFIX)}`, cwd });
  terminal.show(false);
  // Send the command once the terminal's shell exists: the standalone
  // application (Theia) drops text sent to a new terminal before that, so a
  // second Start after Stop showed only a prompt (2026-11-18). VS Code queues
  // it either way.
  const term = terminal;
  const line = `${shq(exePath)} ${c.get('luaFlag')} ${shq(lua)}`;
  Promise.resolve(term.processId).then(() => term.sendText(line), () => term.sendText(line));
  afterStart({ uri, platform, options, debug, port, traceIds, probeIds, recording, opts, restore, agentPort, hostPortValues, movedPorts });
}

// ------------------------------------------------------------------ remote simulation (F-03)

/** On Windows: say that this needs a Linux simulation host, and offer to choose one. */
function needHost(what) {
  vscode.window.showWarningMessage(`${what}: QBox runs only on Linux, so on Windows VP Studio runs simulations on a Linux simulation host over SSH. Choose one first.`,
    'Select Simulation Host…').then((p) => p && vscode.commands.executeCommand('vpStudio.remote.selectHost'));
}

/** A command that needs QBox on this machine: on Windows it says so and points to the remote one. */
const localOnly = (what, fn, instead) => (...args) => {
  if (!IS_WINDOWS) return fn(...args);
  vscode.window.showWarningMessage(`${what} needs QBox on this machine, which runs only on Linux.${instead ? ` On Windows, use "${instead}".` : ' It is not available in VP Studio on Windows.'}`);
  return undefined;
};

/** The remote host settings, or undefined when simulations run on this machine. Throws on bad settings. */
function remoteSettings() {
  const c = cfg();
  const rc = remote.config({ host: c.get('remote.host'), root: c.get('remote.root'), executable: c.get('remote.executable'), sshArgs: c.get('remote.sshArgs') });
  if (rc && c.get('remote.auth') === 'password') rc.askpass = askpassFor(rc.host);
  return rc;
}

// ------------------------------------------------------------------ password login (vpStudio.remote.auth)
//
// ssh asks through VP Studio's askpass program (lib/sim/askpass.js); the password
// is asked once in VS Code and kept in this window's memory, or, when the user
// chooses so, in VS Code's secret storage (the Windows Credential Manager, the
// login keyring on Linux).

let askpassServer;           // { port, token, close } once started
let askpassStarting;
let askpassLauncher;
let askpassError;            // why it could not start (shown instead of "try again")
const sshPasswords = new Map();   // "<host>|<what>" -> password, this window only
const askingPassword = new Map(); // the same key -> the pending input box, so parallel ssh calls ask once
const newPasswords = new Set();   // hosts whose password was just typed: offer to remember it once it works
const secretKey = (host) => `vpStudio.ssh.password.${host}`;

/** Start the askpass server (when password login is set or chosen). */
function ensureAskpass() {
  if (askpassServer) return Promise.resolve(askpassServer);
  if (!askpassStarting) {
    askpassError = undefined;
    askpassStarting = askpass.startServer(askpassAnswer).then((srv) => {
      try {
        askpassLauncher = askpass.writeLauncher(path.join(extContext.globalStorageUri.fsPath, 'askpass'));
      } catch (e) {
        srv.close();
        throw e;
      }
      askpassServer = srv;
      return srv;
    });
    askpassStarting.catch((e) => {
      askpassStarting = undefined;
      askpassError = e;
      outputChannel().appendLine(`Password login could not start: ${e.message}`);
    });
  }
  return askpassStarting;
}

/** rc.askpass for a host: the ssh environment and what to do when the password is refused or accepted. */
function askpassFor(host) {
  if (!askpassServer) {
    const why = askpassError;
    ensureAskpass().catch(() => {});
    throw new Error(why ? `Password login could not start: ${why.message}` : 'Password login is starting; try again in a moment.');
  }
  // The Windows copy of the launcher (non-ASCII user folders) is checked before each use.
  if (IS_WINDOWS && !askpass.launcherIntact(askpassLauncher)) askpassLauncher = askpass.writeLauncher('');
  return {
    env: askpass.sshEnv({ launcher: askpassLauncher, node: process.execPath, port: askpassServer.port, token: askpassServer.token, host }),
    onRefused: () => forgetPassword(host, { keepStored: false }),
    onAccepted: () => offerRememberPassword(host),
  };
}

/** Answer one ssh prompt: a password (asked once), "no" to yes/no questions. */
async function askpassAnswer({ host, prompt, kind }) {
  if (kind === 'confirm') return 'no'; // an unknown or changed host key: not accepted silently
  // A key's passphrase or a one-time code is asked every time; the host password once.
  const reusable = kind === 'password' && !/passphrase|verification|one-time|OTP|token/i.test(prompt);
  const key = `${host}|${reusable ? 'password' : prompt}`;
  if (reusable && sshPasswords.has(key)) return sshPasswords.get(key);
  if (reusable) {
    try {
      const stored = await extContext.secrets.get(secretKey(host));
      if (stored) { sshPasswords.set(key, stored); return stored; }
    } catch (e) { /* no secret storage here */ }
  }
  if (askingPassword.has(key)) return askingPassword.get(key);
  const asking = Promise.resolve(vscode.window.showInputBox({
    title: `VP Studio: ssh ${host}`,
    prompt: reusable ? `${prompt.trim()} (VP Studio keeps it while this window is open)` : prompt.trim(),
    password: kind !== 'other' || /pass|code|PIN/i.test(prompt),
    ignoreFocusOut: true,
  })).then((v) => {
    askingPassword.delete(key);
    if (v === undefined) return null;
    if (reusable) { sshPasswords.set(key, v); newPasswords.add(host); }
    return v;
  });
  askingPassword.set(key, asking);
  return asking;
}

/** After the first login with a typed password: keep it in the secret storage? */
function offerRememberPassword(host) {
  if (!newPasswords.delete(host)) return;
  vscode.window.showInformationMessage(`Logged in to ${host} with the password. Remember it in VS Code's secret storage, so VP Studio does not ask in the next sessions?`,
    'Remember', 'This Session Only').then(async (pick) => {
    if (pick !== 'Remember') return;
    const pw = sshPasswords.get(`${host}|password`);
    if (pw === undefined) return;
    try { await extContext.secrets.store(secretKey(host), pw); } catch (e) { vscode.window.showWarningMessage(`Could not store the password: ${e.message}`); }
  });
}

/** Forget a host's password (a refused one, or on request). */
async function forgetPassword(host, { keepStored = false } = {}) {
  sshPasswords.delete(`${host}|password`);
  newPasswords.delete(host);
  if (!keepStored) { try { await extContext.secrets.delete(secretKey(host)); } catch (e) { /* none */ } }
}

/**
 * When key login was refused and the server takes passwords: offer to switch
 * to password login. Resolves true when switched.
 */
async function offerPasswordLogin(rc, err) {
  if (!rc || rc.askpass || !err || !askpass.offersPassword(err.sshStderr)) return false;
  const pick = await vscode.window.showWarningMessage(`${rc.host} did not accept a key login, but it takes a password.`, {
    modal: true,
    detail: 'VP Studio can log in with your password instead: it asks once and keeps it while this window is open (you can also have it remembered). A key login (ssh-keygen, then add the public key to ~/.ssh/authorized_keys on the host) needs no password at all.',
  }, 'Use Password');
  if (pick !== 'Use Password') return false;
  await ensureAskpass();
  const target = vscode.workspace.workspaceFolders ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  await cfg().update('remote.auth', 'password', target);
  return true;
}

/** Forget Remote Password: the current host's, from this session and the secret storage. */
async function cmdForgetPassword() {
  const host = String(cfg().get('remote.host') || '').trim();
  if (!host) { vscode.window.showInformationMessage('No simulation host is set.'); return; }
  await forgetPassword(host);
  vscode.window.showInformationMessage(`VP Studio forgot the password of ${host}.${cfg().get('remote.auth') === 'password' ? ' It asks again at the next login.' : ''}`);
}

const remoteHomes = new Map();
async function remoteHomeOf(rc) {
  const key = `${rc.host}|${rc.sshArgs.join(' ')}`;
  if (!remoteHomes.has(key)) remoteHomes.set(key, await remote.home(rc));
  return remoteHomes.get(key);
}

/** The local workspace folder a platform is in, which remote.root mirrors. */
function localRootFor(uri) {
  const folder = vscode.workspace.getWorkspaceFolder(uri) || (vscode.workspace.workspaceFolders || [])[0];
  return folder ? folder.uri.fsPath : path.dirname(uri.fsPath);
}

/** Where a library VP Studio builds lives on the remote host (without .so). */
const remoteLib = (homeDir, dir, name) => `${remote.remoteBuildDir(homeDir, dir)}/${name}`;

/**
 * Start Simulation on the remote host: generate here, check and upload the
 * files there, run the simulator in ssh -tt, forward the agent, gdb and host
 * ports to this machine.
 */
async function startRemote(uri, rc, debug, traceIds, opts) {
  const c = cfg();
  if (opts.restore) { vscode.window.showErrorMessage('Starting from a checkpoint is not supported for remote simulations yet.'); return; }
  const localRoot = localRootFor(uri);
  const platformDir = path.dirname(uri.fsPath);
  const remotePlatformDir = remote.mapPath(localRoot, rc.root, platformDir);
  if (!remotePlatformDir) throw new Error(`${uri.fsPath} is not inside the workspace folder ${localRoot}, which "vpStudio.remote.root" mirrors`);
  const platform = await load(uri);
  if (!platform) return;
  const status = vscode.window.setStatusBarMessage(`$(sync~spin) VP Studio: preparing the simulation on ${rc.host}…`);
  try {
    const homeDir = await remoteHomeOf(rc);
    // The device tree is generated here and sent along.
    const generated = [];
    if (platform.data.devicetree && platform.data.devicetree.output) {
      try {
        const r = await deviceTreeFor(uri, platform.data);
        if (r && r.dtb) generated.push(r.dtb);
      } catch (e) {
        const pick = await vscode.window.showErrorMessage(`The device tree could not be generated: ${e.message}`, { modal: true, detail: 'Starting anyway uses the device tree file on the remote host as it is.' }, 'Start Anyway');
        if (pick !== 'Start Anyway') return;
      }
    }
    // What the remote host must have: the simulator, the platform's files, the agent.
    const agentRemote = remoteLib(homeDir, 'sim-agent', 'sim_agent');
    const wantAgent = (c.get('simAgent.library') || '').trim() !== 'none';
    const files = remote.platformFiles(platform.data, platformDir).filter((f) => f.role !== 'symbols')
      .map((f) => (f.remoteOnly ? { local: '', remote: f.file, role: f.role } : { local: f.file, remote: remote.mapPath(localRoot, rc.root, f.file), role: f.role }));
    const outside = files.filter((f) => !f.remote);
    if (outside.length) {
      const pick = await vscode.window.showWarningMessage(`${outside.length} file${outside.length === 1 ? '' : 's'} of the platform ${outside.length === 1 ? 'is' : 'are'} outside the workspace folder, so VP Studio does not know where ${outside.length === 1 ? 'it is' : 'they are'} on ${rc.host}.`,
        { modal: true, detail: outside.map((f) => f.local).join('\n') + '\n\nThe Lua names them with the same absolute paths.' }, 'Start Anyway');
      if (pick !== 'Start Anyway') return;
    }
    const checks = [{ local: '', remote: rc.executable, role: 'simulator' }, { local: '', remote: `${rc.buildDir}/compile_commands.json`, role: 'qboxbuild' }, ...files.filter((f) => f.remote)];
    if (wantAgent) checks.push({ local: '', remote: agentRemote + '.so', role: 'agent' }, { local: '', remote: agentRemote + '.json', role: 'agent-info' });
    for (const b of BUNDLED) checks.push({ local: '', remote: remoteLib(homeDir, b.dir, b.type) + '.so', role: 'bundled', type: b.type });
    const state = await remote.checkFiles(rc, checks);
    const get = (role) => state.find((x) => x.role === role);
    // A QBox or build folder given for the simulator (no build next to it): find the program, offer to fix the setting.
    if (get('simulator').state === 'missing' || get('qboxbuild').state === 'missing') {
      const fixed = await fixRemoteExecutable(rc, 'Start Simulation');
      if (fixed) { status.dispose(); return startRemote(uri, fixed, debug, traceIds, opts); }
    }
    if (get('simulator').state === 'missing') {
      vscode.window.showErrorMessage(`No simulator at ${rc.executable} on ${rc.host}. Build QBox there, or set "vpStudio.remote.root" / "vpStudio.remote.executable".`, 'Open Settings')
        .then((p) => p && vscode.commands.executeCommand('workbench.action.openSettings', 'vpStudio.remote'));
      return;
    }
    const fileStates = state.filter((x) => x.local && x.role !== 'agent');
    const toSend = fileStates.filter((x) => x.state === 'missing' || generated.includes(x.local));
    const differ = fileStates.filter((x) => x.state === 'size' && !generated.includes(x.local));
    const notHere = toSend.filter((x) => x.localSize === null);
    if (notHere.length) {
      const pick = await vscode.window.showWarningMessage(`${notHere.length} file${notHere.length === 1 ? '' : 's'} the platform needs ${notHere.length === 1 ? 'is' : 'are'} on neither machine.`,
        { modal: true, detail: notHere.map((x) => x.local).join('\n') }, 'Start Anyway');
      if (pick !== 'Start Anyway') return;
    }
    const sendable = toSend.filter((x) => x.localSize !== null);
    const askSend = sendable.filter((x) => !generated.includes(x.local));
    let send = sendable.filter((x) => generated.includes(x.local));
    if (askSend.length || differ.length) {
      const fmt = (x) => `${x.remote} (${checkpoint.fmtSize(x.localSize || 0)}${x.state === 'size' ? `, ${checkpoint.fmtSize(x.remoteSize)} there` : ''})`;
      const detail = [
        askSend.length ? `Missing on ${rc.host}:\n${askSend.map(fmt).join('\n')}` : '',
        differ.length ? `A different size on ${rc.host}:\n${differ.map(fmt).join('\n')}` : '',
      ].filter(Boolean).join('\n\n');
      const buttons = askSend.length ? ['Upload', 'Start Anyway'] : ['Upload', 'Keep Theirs'];
      const pick = await vscode.window.showWarningMessage(`The remote host does not have the same files as this machine.`, { modal: true, detail }, ...buttons);
      if (!pick) return;
      if (pick === 'Upload') send = send.concat(askSend, differ);
    }
    if (send.length) {
      const total = send.reduce((n, x) => n + x.localSize, 0);
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Uploading to ${rc.host}` }, async (progress) => {
        let done = 0;
        for (const x of send) {
          let last = 0;
          await remote.upload(rc, x.local, x.remote, {
            onProgress: (sent) => {
              progress.report({ message: `${path.basename(x.local)} (${checkpoint.fmtSize(done + sent)} of ${checkpoint.fmtSize(total)})`, increment: total ? ((sent - last) / total) * 100 : 0 });
              last = sent;
            },
          });
          done += x.localSize;
        }
      });
    }

    // Ports: free ones on the remote host for the simulator, the same or free ones here for the forwards.
    const busy = remote.listeningPorts(await remote.runOk(rc, 'cat /proc/net/tcp /proc/net/tcp6 2>/dev/null; true'));
    const hostVars = hostports.hostPortVariables(platform.data);
    const gdbPort = c.get('debug.gdbPort');
    const agentState = get('agent');
    const agentLib = wantAgent && agentState && agentState.state !== 'missing' ? agentRemote : undefined;
    const wanted = [...hostVars.map((v) => ({ name: v.name, preferred: v.port }))];
    if (agentLib) wanted.push({ name: '@agent' });
    if (debug) wanted.push({ name: '@gdb', preferred: gdbPort });
    const remotePorts = remote.pickPorts(busy, wanted);
    const forwards = [];
    const localOf = {};
    const used = new Set();
    for (const w of wanted) {
      let lp = w.name === '@agent' ? undefined : w.name === '@gdb' ? gdbPort : remotePorts[w.name];
      if (!lp || used.has(lp) || !(await hostports.isPortFree(lp, '127.0.0.1'))) lp = await simagent.freePort();
      used.add(lp);
      localOf[w.name] = lp;
      forwards.push({ local: lp, remote: remotePorts[w.name] });
    }
    const options = {};
    if (debug) options.overrides = [{ instance: c.get('debug.cpuInstance'), param: c.get('debug.gdbPortParam'), value: remotePorts['@gdb'] }];
    const hostPortValues = {};
    const movedPorts = [];
    for (const v of hostVars) {
      hostPortValues[v.name] = localOf[v.name];
      if (localOf[v.name] !== v.port) movedPorts.push({ name: v.name, from: v.port, to: localOf[v.name] });
    }
    if (hostVars.length) options.variableValues = Object.fromEntries(hostVars.map((v) => [v.name, remotePorts[v.name]]));

    if (!agentLib && wantAgent) {
      vscode.window.showWarningMessage(`The sim agent is not built on ${rc.host}, so pause, continue, parameters, tracing and the register view are off. Run "VP Studio: Build Sim Agent on Remote Host".`, 'Build Sim Agent on Remote Host')
        .then((p) => p && vscode.commands.executeCommand('vpStudio.remote.buildSimAgent'));
    }
    if (opts.openocd) { vscode.window.showErrorMessage('The OpenOCD debug port is not available for remote simulation yet: start it on this machine.'); return; }
    if ((traceIds.length || opts.profile || opts.ftrace) && !agentLib) { vscode.window.showErrorMessage(`Tracing and profiling need the sim agent on ${rc.host}.`); return; }
    let agentVersion = null;
    if (agentLib) {
      try { agentVersion = JSON.parse(await remote.runOk(rc, `cat ${remote.shq(agentRemote + '.json')}`)).version || null; } catch (e) { agentVersion = null; }
    }
    const added = addAgentOptions(options, platform, { agentLib, agentVersion, agentPort: remotePorts['@agent'], traceIds, opts });
    if (!added) return;
    const { probeIds, recording } = added;
    // Libraries VP Studio builds: the remote builds (a platform's own dylib wins in the generator).
    const libraries = {};
    for (const b of BUNDLED) {
      const st = state.find((x) => x.role === 'bundled' && x.type === b.type);
      if (st && st.state !== 'missing') libraries[b.type] = remoteLib(homeDir, b.dir, b.type);
    }
    // Models built in the workspace: their library on the remote host is the
    // same place under remote.root (Build Model on Remote Host builds it there).
    const modelLibs = {};
    for (const [type, lib] of Object.entries(models.libraries(catalog()))) modelLibs[type] = remote.mapPath(localRoot, rc.root, lib) || lib;
    const r = await generateText(uri, Object.assign(options, { libraries: Object.assign(modelLibs, libraries) }));
    if (!r) return;
    // Local absolute paths (models next to the platform, this machine's builds) become the remote ones.
    const lua = remote.mapText(remote.mapText(r.lua, localRoot, rc.root), buildDir(), `${homeDir}/.vp-studio/build`);
    const remoteLua = remote.mapPath(localRoot, rc.root, luaPathFor(uri, r.data));
    await remote.writeText(rc, remoteLua, lua);
    disconnectAgent();
    if (terminal) terminal.dispose();
    const args = remote.terminalArgs(rc, { forwards, cwd: rc.root, command: `${remote.shq(rc.executable)} ${c.get('luaFlag')} ${remote.shq(remoteLua)}` });
    terminal = vscode.window.createTerminal({ name: `VP: ${path.basename(uri.fsPath, SUFFIX)} @ ${rc.host}`, shellPath: 'ssh', shellArgs: args, env: rc.askpass ? rc.askpass.env : undefined });
    terminal.show(false);
    outputChannel().appendLine(`Remote simulation: ${remote.commandLine(args)}`);
    afterStart({
      uri, platform, options, debug, port: localOf['@gdb'], traceIds, probeIds, recording, opts, agentPort: localOf['@agent'],
      hostPortValues, movedPorts, where: `on ${rc.host}`, remoteInfo: { host: rc.host, forwards, remoteLua },
    });
    if (debug && localOf['@gdb'] !== gdbPort) {
      vscode.window.showWarningMessage(`Port ${gdbPort} is taken on this machine, so the gdb server is forwarded to ${localOf['@gdb']}. Change the port in the "VP: attach to target software" configuration for this session.`);
    }
  } finally {
    status.dispose();
  }
}

/** Send VP Studio's build sources (tools/<dirs>) to the remote host: <home>/.vp-studio/src. */
async function uploadBuildSources(rc, homeDir, dirs) {
  const entries = [];
  const skip = (rel) => /(^|\/)build(\/|$)/.test(rel) || /\.(so|o)$/.test(rel) || rel === 'tools/qbox-catalog/qbox-catalog' || rel === 'tools/sim-agent/sim_agent.json' || rel === 'tools/sim-agent/vp_sim_agent.json';
  for (const d of dirs) {
    const walk = (rel) => {
      for (const e of fs.readdirSync(path.join(__dirname, rel), { withFileTypes: true })) {
        const r = `${rel}/${e.name}`;
        if (skip(r)) continue;
        if (e.isDirectory()) walk(r);
        else entries.push({ path: r, file: path.join(__dirname, r) });
      }
    };
    walk(`tools/${d}`);
  }
  const tmp = path.join(os.tmpdir(), `vp-studio-src-${process.pid}-${Date.now()}.tar.gz`);
  await remote.uploadTree(rc, entries, `${homeDir}/.vp-studio/src`, require('./lib/setup/tar').write, tmp);
}

/** Build a library of VP Studio on the remote host against its QBox, in a terminal task. */
async function cmdRemoteBuild(what) {
  let rc = remoteSettings();
  if (!rc) { vscode.window.showWarningMessage('Set "vpStudio.remote.host" first (or run "VP Studio: Select Simulation Host…").'); return; }
  const homeDir = await remoteHomeOf(rc);
  rc = await remoteBuildReady(rc, what === 'sim-agent' ? 'Building the sim agent' : `Building ${what}`);
  if (!rc) return;
  const dirs = what === 'sim-agent' ? ['sim-agent'] : [what, 'qbox-catalog'];
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Sending the build sources to ${rc.host}` }, () => uploadBuildSources(rc, homeDir, dirs));
  const src = `${homeDir}/.vp-studio/src/tools/${what}/build.sh`;
  const out = remote.remoteBuildDir(homeDir, what);
  const env = `VP_QBOX_CATALOG=${remote.shq(remote.remoteBuildDir(homeDir, 'qbox-catalog') + '/qbox-catalog')}`;
  const cmd = what === 'sim-agent'
    ? `mkdir -p ${remote.shq(out)} && bash ${remote.shq(src)} ${remote.shq(rc.buildDir)} ${remote.shq(out + '/sim_agent.so')}`
    : `${env} bash ${remote.shq(src)} ${remote.shq(rc.buildDir)} --out ${remote.shq(out)}`;
  const title = what === 'sim-agent' ? 'Sim Agent' : (BUNDLED.find((b) => b.dir === what) || { title: what }).title;
  const code = await runRemoteTask(rc, `remote-${what}`, `Build ${title} on ${rc.host}`, cmd);
  if (code === 0) vscode.window.showInformationMessage(`Built the ${title} on ${rc.host} (${out}). Remote simulations use it.`);
  else vscode.window.showErrorMessage(`Building the ${title} on ${rc.host} failed (exit code ${code}); see the terminal.`);
}

/**
 * When vpStudio.remote.executable is not the simulator program (a QBox or
 * build folder was typed for it), find the program there and offer to set
 * it. Resolves the settings to use from now on, or null when nothing was fixed.
 */
async function fixRemoteExecutable(rc, what) {
  let found;
  try { found = await remote.findExecutable(rc); } catch (e) { return null; }
  if (!found || found === rc.executable) return null;
  const pick = await vscode.window.showWarningMessage(`"vpStudio.remote.executable" is ${rc.executable}, which is not the simulator program on ${rc.host}.`, {
    modal: true,
    detail: `${what} needs platforms-vp in the QBox build folder (it reads CMakeCache.txt and compile_commands.json next to it). Found: ${found}`,
  }, `Use ${found}`);
  if (!pick) return null;
  const c = cfg();
  const i = c.inspect('remote.executable') || {};
  const target = i.workspaceFolderValue !== undefined ? vscode.ConfigurationTarget.WorkspaceFolder
    : i.workspaceValue !== undefined || (i.globalValue === undefined && vscode.workspace.workspaceFolders) ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
  await c.update('remote.executable', found, target);
  return remoteSettings();
}

/**
 * Before building on the remote host: its QBox build must be there
 * (compile_commands.json next to the simulator). Resolves the settings to use,
 * or null after saying what is wrong.
 */
async function remoteBuildReady(rc, what) {
  const st = await remote.checkFiles(rc, [{ local: '', remote: `${rc.buildDir}/compile_commands.json` }]);
  if (st[0].state !== 'missing') return rc;
  const fixed = await fixRemoteExecutable(rc, what);
  if (fixed) return fixed;
  vscode.window.showErrorMessage(`${what}: no QBox build at ${rc.buildDir} on ${rc.host} (no compile_commands.json). Set "vpStudio.remote.executable" to the platforms-vp of a QBox build there, e.g. /home/me/qbox/build/platforms-vp.`, 'Open Settings')
    .then((p) => p && vscode.commands.executeCommand('workbench.action.openSettings', 'vpStudio.remote.executable'));
  return null;
}

/**
 * The working folder of VP Studio's tasks. Without one, VS Code starts a task
 * in ${workspaceFolder}, which fails with "Cannot resolve variable
 * workspaceFolder. Please open a folder." when no folder is open (2026-11-21:
 * Build QBox in a VS Code window without a folder). preferred when it is a
 * folder, else the first workspace folder, else the home folder.
 */
function taskCwd(preferred) {
  try { if (preferred && fs.statSync(preferred).isDirectory()) return preferred; } catch (e) { /* gone */ }
  const f = (vscode.workspace.workspaceFolders || [])[0];
  return f ? f.uri.fsPath : os.homedir();
}

/** Run a command on the remote host in a terminal task (ssh -tt); resolves its exit code. */
async function runRemoteTask(rc, id, name, cmd) {
  const task = new vscode.Task({ type: 'shell', tool: id }, vscode.TaskScope.Workspace, name, 'VP Studio',
    new vscode.ProcessExecution('ssh', [...rc.sshArgs, ...(rc.askpass ? remote.authOptions(rc) : []), '-tt', rc.host, cmd], Object.assign({ cwd: taskCwd() }, rc.askpass ? { env: rc.askpass.env } : {})), []);
  task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, clear: true };
  const exec = await vscode.tasks.executeTask(task);
  return new Promise((resolve) => {
    const sub = vscode.tasks.onDidEndTaskProcess((e) => { if (e.execution === exec) { sub.dispose(); resolve(e.exitCode); } });
  });
}

/**
 * Build Model on Remote Host: generate the model's code here, send the model
 * folder to its place under remote.root (without build/), build it there
 * against the remote QBox with tools/model-build, and bring its catalog entry
 * back, so platforms here can use the model and remote simulations load it.
 * The only way to build a model in VS Code on Windows.
 */
async function cmdRemoteBuildModel(arg) {
  let rc;
  try { rc = remoteSettings(); } catch (e) { vscode.window.showErrorMessage(`VP Studio: ${e.message}`); return; }
  if (!rc) { needHost('Build Model on Remote Host'); return; }
  const uri = await pickModel(arg);
  if (!uri) return;
  const textDoc = await vscode.workspace.openTextDocument(uri);
  if (textDoc.isDirty) await textDoc.save();
  if (!(await generateModel(uri, false))) return;
  const dir = path.dirname(uri.fsPath);
  const remoteDir = remote.mapPath(localRootFor(uri), rc.root, dir);
  if (!remoteDir) { vscode.window.showErrorMessage(`${dir} is not inside the workspace folder, which "vpStudio.remote.root" mirrors on ${rc.host}.`); return; }
  const name = (() => { try { return JSON.parse(textDoc.getText()).name; } catch (e) { return path.basename(dir); } })();
  const homeDir = await remoteHomeOf(rc);
  rc = await remoteBuildReady(rc, `Building ${name}`);
  if (!rc) return;
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Sending ${name} to ${rc.host}` }, async () => {
    await uploadBuildSources(rc, homeDir, ['model-build', 'qbox-catalog']);
    await remote.uploadFiles(rc, remote.folderEntries(dir, (rel) => !/^build(\/|$)/.test(rel)), remoteDir, require('./lib/setup/tar').write,
      path.join(os.tmpdir(), `vp-studio-model-${process.pid}-${Date.now()}.tar.gz`));
  });
  const script = `${homeDir}/.vp-studio/src/tools/model-build/build.sh`;
  const cmd = `VP_QBOX_CATALOG=${remote.shq(remote.remoteBuildDir(homeDir, 'qbox-catalog') + '/qbox-catalog')} bash ${remote.shq(script)} ${remote.shq(rc.buildDir)} ${remote.shq(remoteDir)}`;
  const code = await runRemoteTask(rc, `remote-model-${name}`, `Build model ${name} on ${rc.host}`, cmd);
  // The catalog entry (and which QBox) back here, next to the model, where the catalog looks for it.
  if (code === 0 || code === 3) {
    fs.mkdirSync(path.join(dir, 'build'), { recursive: true });
    for (const f of [`${name}.catalog.json`, `${name}.json`]) {
      try { fs.writeFileSync(path.join(dir, 'build', f), await remote.runOk(rc, `cat ${remote.shq(`${remoteDir}/build/${f}`)}`)); } catch (e) { /* not made */ }
    }
  }
  await refreshModelCatalogs();
  if (code === 0) vscode.window.showInformationMessage(`Built ${name} on ${rc.host}; its self-test passed, and it is in the component catalog: "Add Module…" in a platform lists it.`);
  else vscode.window.showErrorMessage(code === 3 ? `${name} was built on ${rc.host}, but its self-test failed; see the terminal.` : `Building ${name} on ${rc.host} failed (exit code ${code}); see the terminal.`);
}

/** Check Remote Host: what a remote simulation needs, in the output. */
async function cmdCheckRemote() {
  let rc;
  try { rc = remoteSettings(); } catch (e) { vscode.window.showErrorMessage(e.message); return; }
  if (!rc) { vscode.window.showInformationMessage('Simulations run on this machine ("vpStudio.remote.host" is empty). Run "VP Studio: Select Simulation Host…" to use another machine.'); return; }
  const out = outputChannel();
  out.show(true);
  out.appendLine(`Remote host ${rc.host} (root ${rc.root}):`);
  const line = (ok, text) => out.appendLine(`  ${ok ? '✓' : '✗'} ${text}`);
  let homeDir;
  try {
    homeDir = await remote.home(rc);
    line(true, `${rc.askpass ? 'ssh logs in with the password' : 'ssh logs in with a key'}; home ${homeDir}`);
  } catch (e) {
    line(false, e.message);
    if (await offerPasswordLogin(rc, e)) cmdCheckRemote();
    return;
  }
  const agent = remoteLib(homeDir, 'sim-agent', 'sim_agent');
  const checks = [
    { remote: rc.executable, what: 'simulator' },
    { remote: `${rc.buildDir}/compile_commands.json`, what: 'QBox build (for building the sim agent there)' },
    { remote: agent + '.so', what: 'sim agent (Build Sim Agent on Remote Host)' },
    ...BUNDLED.map((b) => ({ remote: remoteLib(homeDir, b.dir, b.type) + '.so', what: `${b.title} (optional)` })),
  ];
  const st = await remote.checkFiles(rc, checks.map((x) => ({ local: '', remote: x.remote })));
  st.forEach((x, i) => line(x.state !== 'missing', `${checks[i].what}: ${x.remote}${x.state === 'missing' ? ' not found' : ''}`));
  // A QBox or build folder given for the simulator: find the program and offer to fix the setting.
  if (st[0].state === 'missing' || st[1].state === 'missing') {
    if (await fixRemoteExecutable(rc, 'Simulating and building on the remote host')) { cmdCheckRemote(); return; }
  }
  try {
    const v = JSON.parse(await remote.runOk(rc, `cat ${remote.shq(agent + '.json')}`));
    line(true, `sim agent ${v.version}, built against QBox ${String(v.qbox && v.qbox.commit || v.qboxCommit || '?').slice(0, 12)}`);
  } catch (e) { /* not built */ }
  try {
    const head = (await remote.runOk(rc, `git -C ${remote.shq(rc.root)} rev-parse HEAD 2>/dev/null || true`)).trim();
    const p = pin.readPin(path.join(__dirname, 'qbox.pin.json'));
    if (head) line(head === p.qbox.commit, `QBox commit ${head.slice(0, 12)}${head === p.qbox.commit ? ' (the pinned one)' : `, VP Studio pins ${p.qbox.commit.slice(0, 12)}`}`);
  } catch (e) { /* no git */ }
  try {
    const fwd = await remote.runOk(rc, 'cat /proc/net/tcp >/dev/null && echo ok');
    line(fwd.trim() === 'ok', 'free ports can be found (/proc/net/tcp)');
  } catch (e) { line(false, `cannot read /proc/net/tcp: ${e.message}`); }
}

/** Select Simulation Host…: this machine, a Host of ~/.ssh/config, or another. */
async function cmdSelectHost() {
  const c = cfg();
  const hosts = [];
  try {
    const text = fs.readFileSync(path.join(os.homedir(), '.ssh', 'config'), 'utf8');
    for (const m of text.matchAll(/^\s*Host\s+(.+)$/gim)) for (const h of m[1].split(/\s+/)) if (h && !/[*?!]/.test(h)) hosts.push(h);
  } catch (e) { /* no ssh config */ }
  const current = c.get('remote.host') || '';
  const items = [
    { label: 'This machine', description: current ? '' : 'current', host: '' },
    ...hosts.map((h) => ({ label: h, description: h === current ? 'current (~/.ssh/config)' : '~/.ssh/config', host: h })),
    { label: 'Other host…', description: 'user@host', host: undefined },
  ];
  if (current && !hosts.includes(current)) items.splice(1, 0, { label: current, description: 'current', host: current });
  const sel = await vscode.window.showQuickPick(items, { title: 'Select Simulation Host', placeHolder: 'Where Start Simulation runs the simulator' });
  if (!sel) return;
  let host = sel.host;
  if (host === undefined) {
    host = await vscode.window.showInputBox({ title: 'Simulation host', prompt: 'ssh destination: user@host, or a Host of ~/.ssh/config', value: current,
      validateInput: (v) => (/^[^\s-][^\s]*$/.test(v.trim()) ? undefined : 'An ssh destination, without spaces') });
    if (host === undefined) return;
    host = host.trim();
  }
  const target = vscode.workspace.workspaceFolders ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  await c.update('remote.host', host, target);
  if (!host) { vscode.window.showInformationMessage('Simulations run on this machine.'); return; }
  // `c` is a snapshot taken before the updates below; keep what was entered.
  let remoteRoot = String(c.get('remote.root') || '');
  if (!remoteRoot) {
    const root = await vscode.window.showInputBox({ title: `Folder on ${host}`, prompt: `Absolute path on ${host} of the folder that matches this workspace folder (the QBox folder, or the folder that holds your platforms)`,
      placeHolder: '/home/me/qbox', validateInput: (v) => (v.trim().startsWith('/') ? undefined : 'An absolute path') });
    if (!root) return;
    remoteRoot = root.trim();
    await c.update('remote.root', remoteRoot, target);
  }
  // The simulator: by default <root>/build/platforms-vp, which fits only when
  // the folder is the QBox folder; ask while it is still the default.
  const exe = c.inspect('remote.executable') || {};
  if (exe.workspaceValue === undefined && exe.globalValue === undefined && exe.workspaceFolderValue === undefined) {
    const root = remoteRoot.replace(/\/+$/, '') || '/';
    const v = await vscode.window.showInputBox({ title: `Simulator on ${host}`,
      prompt: `The simulator program on ${host}: the platforms-vp file in the QBox build folder, e.g. /home/me/qbox/build/platforms-vp (absolute, or relative to ${root}). Leave it as it is when ${root} is the QBox folder.`,
      value: 'build/platforms-vp', validateInput: (x) => (x.trim() ? undefined : 'A path') });
    if (v === undefined) return;
    if (v.trim() !== 'build/platforms-vp') await c.update('remote.executable', v.trim(), target);
  }
  await cmdCheckRemote();
}

/** Say which disk images are almost full, and how to free space in a Linux guest. */
function warnLowDisk(low) {
  const l = low[0];
  const more = low.length > 1 ? ` (and ${low.length - 1} more)` : '';
  vscode.window.showWarningMessage(
    `The disk image of ${l.module} is almost full: ${diskspace.fmtBytes(l.available)} free of ${diskspace.fmtBytes(l.size)}${more}. Services in the guest that write to it may fail to start.`,
    'How to Free Space').then((pick) => {
    if (pick !== 'How to Free Space') return;
    const ch = outputChannel();
    ch.appendLine('');
    for (const x of low) ch.appendLine(`${x.module}: ${diskspace.fmtBytes(x.available)} free of ${diskspace.fmtBytes(x.size)} (${x.file})`);
    ch.appendLine([
      '',
      'A full root file system still boots, but services that write state fail, for example',
      '"Failed to start Network Name Resolution" and "systemd-journald: No space left on device".',
      '',
      'Each time the simulation ends without the guest shutting down (Stop Simulation, Ctrl-\\),',
      'systemd keeps the journal it was writing as a *.journal~ file. To free that space, log in',
      'to the guest as root and run:',
      '',
      '    journalctl --vacuum-size=32M',
      '    rm -f /var/log/journal/*/*.journal~',
      '    df -h /',
      '',
      'Then end the simulation with "poweroff" in the guest, so no new *.journal~ is left.',
      'To keep it from filling up again, limit the journal in the image (SystemMaxUse= in',
      '/etc/systemd/journald.conf) or make the image larger.',
    ].join('\n'));
    ch.show(true);
  });
}

/** Working directory and simulator executable for a platform (or the first workspace folder). */
function simulatorPath(uri) {
  const c = cfg();
  const exe = c.get('executable');
  const at = (cwd) => ({ cwd, exePath: path.isAbsolute(exe) ? exe : path.join(cwd, exe) });
  if (c.get('workingDirectory')) return at(c.get('workingDirectory'));
  const folder = (uri && vscode.workspace.getWorkspaceFolder(uri)) || (vscode.workspace.workspaceFolders || [])[0];
  const first = at(folder ? folder.uri.fsPath : uri ? path.dirname(uri.fsPath) : process.cwd());
  if (fs.existsSync(first.exePath)) return first;
  // A platform in a folder of its own (an unpacked kit added to the
  // workspace): the QBox folder is another workspace folder.
  for (const f of vscode.workspace.workspaceFolders || []) {
    const other = at(f.uri.fsPath);
    if (fs.existsSync(other.exePath)) return other;
  }
  return first;
}

// ------------------------------------------------------------------ QBox version

function versionReport(exePath) {
  let p;
  try { p = pin.readPin(path.join(__dirname, 'qbox.pin.json')); } catch (e) { p = undefined; }
  const lib = simAgentLibrary({ quiet: true });
  return pin.versionReport({ pin: p, exePath, catalog: catalog(), agentLib: lib && lib + '.so', studioDir: __dirname });
}

/**
 * Warn (without blocking the start) when the simulator, the catalog and the
 * sim agent do not come from the tested QBox commit. "Don't Show Again"
 * silences that exact set of mismatches.
 */
function warnVersions(exePath) {
  let r;
  try { r = versionReport(exePath); } catch (e) { return; }
  const warnings = r.problems.filter((x) => x.level === 'warning');
  if (!warnings.length) return;
  const key = crypto.createHash('sha1').update(warnings.map((w) => w.text).join('\n')).digest('hex');
  const dismissed = extContext ? extContext.globalState.get('vpStudio.versionWarningsDismissed', []) : [];
  if (dismissed.includes(key)) return;
  const more = warnings.length > 1 ? ` (and ${warnings.length - 1} more)` : '';
  vscode.window.showWarningMessage(`VP Studio: ${warnings[0].text}${more}`, 'Details', "Don't Show Again").then((pick) => {
    if (pick === 'Details') showVersionReport(r);
    else if (pick === "Don't Show Again" && extContext) extContext.globalState.update('vpStudio.versionWarningsDismissed', [...dismissed, key].slice(-20));
  });
}

function showVersionReport(r) {
  outputChannel().clear();
  versionOutput.appendLine(pin.formatReport(r));
  versionOutput.appendLine('');
  versionOutput.appendLine('To build the tested QBox with a matching sim agent and catalog: tools/qbox-pin/build-qbox.sh <dir>');
  versionOutput.show(true);
}

function cmdCheckQBox() {
  const ed = vscode.window.activeTextEditor;
  const { exePath } = simulatorPath(ed && isPlatform(ed.document) ? ed.document.uri : undefined);
  const r = versionReport(exePath);
  showVersionReport(r);
  const w = r.problems.filter((x) => x.level === 'warning').length;
  vscode.window.showInformationMessage(w ? `QBox version check: ${w} mismatch${w > 1 ? 'es' : ''}; see the VP Studio output.` : `QBox version check: the simulator, catalog and sim agent match${r.pinned && r.simulator && r.simulator.commit === r.pinned ? ' the tested QBox ' + pin.short(r.pinned) : ''}.`);
}

function cmdStop() {
  if (!terminal) {
    vscode.window.showInformationMessage('No simulation was started from VP Studio.');
    return;
  }
  terminal.dispose();
  terminal = undefined;
  disconnectAgent();
  setRunning(false);
}

// ------------------------------------------------------------------ sim agent

const AGENT_INSTANCE = launch.AGENT_INSTANCE;
let agent;            // connected SimAgentClient
let agentAttempt = 0; // bumped to cancel a pending connection attempt
let agentStatus;      // last sim.getStatus result
let agentMethods = []; // methods the connected agent offers (agent.getInfo)
let agentPoll;
let agentItem;
let agentLibWarned = false;
let paramTree;

/**
 * Path of the agent library without ".so" (QBox appends it), or undefined when
 * disabled or not built. "vpStudio.simAgent.library" empty means the copy
 * built in the extension folder by tools/sim-agent/build.sh.
 */
function simAgentLibrary({ quiet = false } = {}) {
  const setting = (cfg().get('simAgent.library') || '').trim();
  if (setting === 'none') return undefined;
  // sim_agent.so; vp_sim_agent.so is the name of builds before 2026-11-20.
  let file = setting || firstExisting(buildDir('sim-agent', 'sim_agent.so'), path.join(__dirname, 'tools', 'sim-agent', 'sim_agent.so'),
    buildDir('sim-agent', 'vp_sim_agent.so'), path.join(__dirname, 'tools', 'sim-agent', 'vp_sim_agent.so')) ||
    buildDir('sim-agent', 'sim_agent.so');
  if (!path.isAbsolute(file)) {
    const folder = (vscode.workspace.workspaceFolders || [])[0];
    if (folder) file = path.join(folder.uri.fsPath, file);
  }
  if (!file.endsWith('.so')) file += '.so';
  if (!fs.existsSync(file)) {
    if (!agentLibWarned && !quiet) {
      agentLibWarned = true;
      const own = !setting;
      vscode.window.showWarningMessage(
        `VP Studio: the sim agent is not built${own ? '' : ` (${file} not found)`}, so pause, continue, the parameter view, ` +
        'tracing and debugger time sync are off. ' +
        (own ? 'Build it once for your QBox with "VP Studio: Build Sim Agent".' : 'Build it, or fix "vpStudio.simAgent.library" ("none" hides this message).'),
        ...(own ? ['Build Sim Agent'] : []), 'Open Settings').then((p) => {
        if (p === 'Build Sim Agent') vscode.commands.executeCommand('vpStudio.buildSimAgent');
        else if (p === 'Open Settings') vscode.commands.executeCommand('workbench.action.openSettings', 'vpStudio.simAgent.library');
      });
    }
    return undefined;
  }
  return file.slice(0, -3);
}

function setAgentContext() {
  const paused = !!agentStatus && agentStatus.state === 'paused';
  setCtx('vpStudio.agentConnected', !!agent);
  setCtx('vpStudio.paused', !!agent && paused);
}

function updateAgentItem(phase) {
  if (phase === 'connecting') {
    agentItem.text = '$(sync~spin) VP agent';
    agentItem.tooltip = 'Waiting for the simulation to start the sim agent';
    agentItem.command = undefined;
    agentItem.show();
    return;
  }
  if (!agent) { agentItem.hide(); return; }
  const s = agentStatus || {};
  const t = simagent.formatTime(s.time && s.time.seconds);
  if (s.state === 'paused') {
    agentItem.text = `$(debug-continue) Paused at ${t}${s.breakpointHit ? ` · breakpoint #${s.breakpointHit.breakpoint}` : ''}`;
    const tip = new vscode.MarkdownString('Simulation paused. Click to continue.\n\n'
      + '[Continue](command:vpStudio.continue) · [Run For…](command:vpStudio.runFor) · [Run Until…](command:vpStudio.runUntil)');
    tip.isTrusted = { enabledCommands: ['vpStudio.continue', 'vpStudio.runFor', 'vpStudio.runUntil'] };
    agentItem.tooltip = tip;
    agentItem.command = 'vpStudio.continue';
  } else if (s.state === 'halted') {
    agentItem.text = `$(debug-breakpoint-unsupported) Halted by debugger at ${t}`;
    agentItem.tooltip = 'A debugger has stopped the CPUs, so simulated time is stopped too. Continue in the debugger to resume.';
    agentItem.command = undefined;
  } else if (s.stopAt) {
    const at = simagent.formatTime(s.stopAt.seconds);
    agentItem.text = `$(debug-pause) ${t} → ${at}`;
    agentItem.tooltip = `Simulated time. Pauses by itself at ${at}. Click to pause now.`;
    agentItem.command = 'vpStudio.pause';
  } else {
    agentItem.text = `$(debug-pause) ${t}`;
    agentItem.tooltip = 'Simulated time. Click to pause the simulation.';
    agentItem.command = 'vpStudio.pause';
  }
  agentItem.show();
}

function applyStatus(status) {
  if (!status || typeof status !== 'object') return;
  const wasPaused = agentStatus && agentStatus.state === 'paused';
  agentStatus = status;
  setAgentContext();
  updateAgentItem();
  showHit(status);
  if (status.restore && status.restore.state === 'failed' && !restoreReported) {
    restoreReported = true;
    vscode.window.showErrorMessage(`The checkpoint could not be loaded, so the simulation stays paused: ${status.restore.error}`, 'Check QBox Version')
      .then((x) => x && vscode.commands.executeCommand('vpStudio.checkQBox'));
  }
  if (status.reason === 'time' && status.state === 'paused' && status.time && status.requestedTime) {
    vscode.window.setStatusBarMessage(`VP Studio: paused at ${simagent.formatTime(status.time.seconds)} as requested (${simagent.formatTime(status.requestedTime.seconds)})`, 8000);
  }
  // Parameters may change while running; reading them on pause gives a consistent snapshot.
  if (status.state === 'paused' && !wasPaused) paramTree.load();
  const stopped = status.state === 'paused' || status.state === 'halted';
  if (stopped !== registerTree.stopped) registerTree.setStopped(stopped);
}

/** Connect to an agent. auto: started by "Start Simulation", so wait for elaboration and stay quiet on failure. */
async function connectAgent({ host = '127.0.0.1', port, auto, handshake = false }) {
  disconnectAgent();
  const attempt = ++agentAttempt;
  updateAgentItem('connecting');
  const client = await simagent.connectWithRetry({
    host, port, totalMs: auto ? 120000 : 3000, shouldStop: () => attempt !== agentAttempt, handshake,
  });
  if (attempt !== agentAttempt) { if (client) client.close(); return; }
  if (!client) {
    updateAgentItem();
    const msg = `Could not connect to the sim agent at ${host}:${port}.`;
    if (auto) vscode.window.setStatusBarMessage(`VP Studio: ${msg}`, 10000);
    else vscode.window.showErrorMessage(msg);
    return;
  }
  let info;
  try {
    info = await client.request('agent.getInfo');
    if (info.protocol !== simagent.PROTOCOL) {
      client.close();
      vscode.window.showErrorMessage(`The sim agent speaks protocol ${info.protocol}; this extension needs ${simagent.PROTOCOL}. Rebuild tools/sim-agent.`);
      updateAgentItem();
      return;
    }
  } catch (e) {
    client.close();
    updateAgentItem();
    if (!auto) vscode.window.showErrorMessage(`Sim agent at ${host}:${port}: ${e.message}`);
    return;
  }
  if (attempt !== agentAttempt) { client.close(); return; }
  agent = client;
  agentStatus = undefined;
  agentMethods = Array.isArray(info.methods) ? info.methods : [];
  client.on('notification', (method, params) => { if (method === 'sim.stateChanged') applyStatus(params); });
  client.on('close', () => {
    if (agent !== client) return;
    agent = undefined;
    agentStatus = undefined;
    clearInterval(agentPoll);
    setAgentContext();
    updateAgentItem();
    paramTree.clear();
    traceDisconnected();
    clearInterval(profileTimer); profileTimer = undefined; // the next connection starts it again
  });
  let busy = false;
  const poll = async () => {
    if (busy || agent !== client) return;
    busy = true;
    try { applyStatus(await client.request('sim.getStatus')); } catch (e) { /* closed or slow: next tick */ }
    busy = false;
  };
  agentPoll = setInterval(poll, 1000);
  await poll();
  paramTree.load();  traceConnected(); profileConnected();
}

// ------------------------------------------------------------------ transaction trace

let tracePanel;
let traceTitle = 'Transaction Trace';
let traceSince = 0;
let traceTimer;
let traceRecords = [];       // kept for CSV export, newest last
let tracePoints = [];
let traceProbes = [];        // [{name, kind, recording}] of the running simulation (agent 0.9.0)
let traceDropped = 0;        // records the simulator discarded before they were read
const TRACE_KEEP = 100000;
// Bus breakpoints, kept for the workspace so they apply again to the next run.
// Each: the break.set object plus its id. Only those on a traced point (or on
// any point) are sent to the agent.
let traceBreaks;
const breaksKey = 'vpStudio.breakpoints';
function breaks() {
  if (!traceBreaks) traceBreaks = (extContext && extContext.workspaceState.get(breaksKey, [])) || [];
  return traceBreaks;
}
async function saveBreaks(list) {
  traceBreaks = list;
  if (extContext) await extContext.workspaceState.update(breaksKey, list);
}
const breakActive = (b) => !b.point || tracePoints.includes(b.point);
let oldAgentWarned; // the agent connection already told it is too old

/** Send the breakpoints to the agent (when it can take them) and show them in the panel. */
async function syncBreaks({ added = false, error } = {}) {
  const list = breaks();
  if (agent && agentMethods.includes('break.set')) {
    try {
      const st = await agent.request('trace.getStatus');
      tracePoints = st.points || tracePoints;
      showProbes(st);
      await agent.request('break.set', { breakpoints: list.filter(breakActive) });
    } catch (e) {
      error = error || `The simulator did not take the breakpoints: ${e.message}`;
    }
  } else if (agent && list.length && !error) {
    error = 'This sim agent has no bus breakpoints (they need agent 0.5.0 or later): run "VP Studio: Build Sim Agent", then restart the simulation.';
    if (oldAgentWarned !== agent) {
      oldAgentWarned = agent;
      vscode.window.showWarningMessage('VP Studio: the running simulation\'s sim agent is too old for bus breakpoints (they need 0.5.0). Build the new agent, then stop and start the simulation again.', 'Build Sim Agent')
        .then((p) => p && vscode.commands.executeCommand('vpStudio.buildSimAgent'));
    }
  }
  if (tracePanel) {
    tracePanel.webview.postMessage({
      type: 'breakpoints', added, error,
      list: list.map((b) => ({ id: b.id, label: trace.breakLabel(b), active: !agent || breakActive(b) })),
    });
  }
}

/** Keep the probes of a trace.getStatus result and show them in the trace panel. */
function showProbes(st) {
  if (st && Array.isArray(st.probes)) traceProbes = st.probes;
  postTxState();
  if (tracePanel) {
    tracePanel.webview.postMessage({
      type: 'probes', list: traceProbes, choose: !!agent && agentMethods.includes('trace.setPoints'),
      hint: agent && !agentMethods.includes('trace.setPoints') ? 'This sim agent records at every tracer it was started with. To turn probes on and off while running, build sim agent 0.9.0 and start again.' : '',
    });
  }
}

/** Tell the trace panel (and the status bar) about a breakpoint hit, or that it is over. */
function showHit(status) {
  const hit = status && status.state === 'paused' ? status.breakpointHit : undefined;
  if (tracePanel) tracePanel.webview.postMessage({ type: 'hit', text: hit ? trace.describeHit(hit) : null, seq: hit && hit.record.seq });
  if (hit && status.reason === 'breakpoint') {
    vscode.window.setStatusBarMessage(`VP Studio: ${trace.describeHit(hit).split(/\.(?: |$)/)[0]}`, 10000);
    showTracePanel(true);
  }
}

/**
 * A bus access clicked in the trace panel: its route (initiator -> router ->
 * device) lit up in the platform view of the running simulation. The view is
 * opened or moved next to the trace panel, never on top of it.
 */
async function showRouteInPlatform(m) {
  const uri = runningPlatform;
  if (!uri) {
    vscode.window.showInformationMessage('VP Studio: routes are shown for a simulation started with Start Simulation (a manual Connect does not say which platform it runs).');
    return;
  }
  const n = Number(m.length);
  const detail = `${m.dir === 'W' ? 'write' : 'read'} ${m.address}${n ? ` · ${n} byte${n === 1 ? '' : 's'}` : ''}${m.value ? ` · ${m.value}` : ''} · ${Number(m.time).toFixed(6)} s · #${m.seq}` +
    (m.initiator ? '' : ' · initiator unknown (it needs sim agent 0.12.0)');
  const spec = { region: m.point, initiator: m.initiator || undefined, detail };
  const key = uri.toString();
  const panel = panels.get(key);
  const traceCol = tracePanel && tracePanel.viewColumn;
  const other = traceCol === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One;
  if (panel && panel.visible && panel.viewColumn !== traceCol) {
    panel.webview.postMessage({ type: 'route', spec });
    return;
  }
  pendingRoute.set(key, { id: ++routeSeq, spec });
  if (panel) {
    await renderPanel(uri, panel);
    panel.reveal(panel.viewColumn === traceCol ? other : panel.viewColumn, true);
    return;
  }
  await cmdShowPlatform(uri, { column: other, preserveFocus: true });
}

function showTracePanel(preserveFocus) {
  if (tracePanel) { tracePanel.reveal(undefined, preserveFocus); return; }
  tracePanel = vscode.window.createWebviewPanel('vpStudio.trace', traceTitle,
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: !!preserveFocus }, { enableScripts: true, retainContextWhenHidden: true });
  const nonce = crypto.randomBytes(16).toString('hex');
  tracePanel.webview.html = traceview.render(nonce, tracePanel.webview.cspSource, traceTitle);
  tracePanel.onDidDispose(() => { tracePanel = undefined; if (!traceWanted()) { clearInterval(traceTimer); traceTimer = undefined; } });
  tracePanel.webview.onDidReceiveMessage((m) => handleTraceMessage(m).catch((e) => vscode.window.showErrorMessage(`Trace: ${e.message}`)));
}

async function handleTraceMessage(m) {
  if (!m) return;
  if (m.type === 'ready') {
    // A (re)loaded page gets what was already read, then the polling continues.
    if (traceRecords.length) tracePanel.webview.postMessage({ type: 'records', records: traceRecords, points: tracePoints });
    traceConnected();
    await syncBreaks();
    showHit(agentStatus);
  } else if (m.type === 'clear') {
    if (agent) await agent.request('trace.clear');
    traceRecords = [];
    if (tracePanel) tracePanel.webview.postMessage({ type: 'cleared' });
    postTx({ type: 'tx', records: [], reset: true });
  } else if (m.type === 'setRecording') {
    if (!agent) throw new Error('not connected to a simulation');
    const st = await agent.request('trace.setEnabled', { enabled: !!m.enabled });
    if (tracePanel) tracePanel.webview.postMessage({ type: 'recording', enabled: st.enabled });
  } else if (m.type === 'addBreak') {
    let spec;
    try {
      spec = trace.parseBreakInput(m);
    } catch (e) {
      await syncBreaks({ error: e.message });
      return;
    }
    const list = breaks();
    spec.id = list.reduce((n, b) => Math.max(n, b.id), 0) + 1;
    await saveBreaks([...list, spec]);
    await syncBreaks({ added: true });
  } else if (m.type === 'removeBreak') {
    await saveBreaks(breaks().filter((b) => b.id !== m.id));
    await syncBreaks();
  } else if (m.type === 'showRoute') {
    await showRouteInPlatform(m);
  } else if (m.type === 'continue') {
    await cmdContinue();
  } else if (m.type === 'chooseProbes') {
    await cmdChooseProbes();
  } else if (m.type === 'stopProbe') {
    if (!agent) throw new Error('not connected to a simulation');
    showProbes(await agent.request('trace.setPoints', { points: [m.name], recording: false }));
    await rememberProbes();
  } else if (m.type === 'exportVcd') {
    const sig = traceRecords.filter((r) => r.dir === 'S');
    if (!sig.length) {
      vscode.window.showInformationMessage('No signal changes to export. Turn on a signal probe (an interrupt line) with "Probes…", or choose one under "Signals" in Start Simulation with Tracing.');
      return;
    }
    const folder = (vscode.workspace.workspaceFolders || [])[0];
    const target = await vscode.window.showSaveDialog({
      defaultUri: folder ? vscode.Uri.joinPath(folder.uri, 'signals.vcd') : undefined, filters: { VCD: ['vcd'] }, title: 'Export the signal changes as VCD',
    });
    if (!target) return;
    // Changes older than the ones kept here are gone, so the level before the first one is unknown then.
    const dropped = traceRecords.length >= TRACE_KEEP || traceDropped > 0;
    await fs.promises.writeFile(target.fsPath, trace.toVcd(traceRecords, { initial: dropped ? 'x' : '0' }), 'utf8');
    vscode.window.showInformationMessage(`Exported ${sig.length} signal changes to ${vscode.workspace.asRelativePath(target)}. Open it with a waveform viewer such as GTKWave.`);
  } else if (m.type === 'export') {
    if (!traceRecords.length) { vscode.window.showInformationMessage('No accesses to export yet.'); return; }
    const folder = (vscode.workspace.workspaceFolders || [])[0];
    const target = await vscode.window.showSaveDialog({
      defaultUri: folder ? vscode.Uri.joinPath(folder.uri, 'trace.csv') : undefined, filters: { CSV: ['csv'] }, title: 'Export the transaction trace',
    });
    if (!target) return;
    await fs.promises.writeFile(target.fsPath, trace.toCsv(traceRecords), 'utf8');
    vscode.window.showInformationMessage(`Exported ${traceRecords.length} accesses to ${vscode.workspace.asRelativePath(target)}.`);
  }
}

// Platform views showing their Transactions tab (uri strings). Only the view
// of the running platform gets records; the others are told whose they are.
const txWatch = new Set();
const txKey = () => (runningPlatform ? runningPlatform.toString() : '');
const txWatching = () => !!txKey() && txWatch.has(txKey());
const traceWanted = () => !!tracePanel || txWatching();

/** What the Transactions tab of the platform view at key shows above its table. */
function txState(key) {
  const mine = !!runningPlatform && runningPlatform.toString() === key;
  const on = traceProbes.filter((p) => p.recording).length;
  return {
    type: 'txState', mine, connected: mine && !!agent, other: !mine && !!runningPlatform && !!agent ? path.basename(runningPlatform.fsPath, SUFFIX) : '',
    probes: traceProbes.length, recordingProbes: on, kept: traceRecords.length,
  };
}
function postTxState() {
  for (const key of txWatch) { const p = panels.get(key); if (p) p.webview.postMessage(txState(key)); }
}
function postTx(msg) {
  if (!txWatching()) return;
  const p = panels.get(txKey());
  if (p) p.webview.postMessage(msg);
}

/** Poll the agent for new trace records while the panel or a Transactions tab is open and a simulation is connected. */
function traceConnected() {
  postTxState();
  if (!traceWanted() || !agent || traceTimer) return;
  const client = agent;
  let busy = false;
  const tick = async () => {
    if (busy || agent !== client) return;
    if (!traceWanted()) { clearInterval(traceTimer); traceTimer = undefined; return; }
    busy = true;
    try {
      // Drain in pages so a burst (console output, say) does not lag behind.
      for (let pages = 0; pages < 10; pages++) {
        const res = await client.request('trace.read', { since: traceSince, max: 5000 });
        const recs = trace.decodeRecords(res);
        tracePoints = res.points || tracePoints;
        traceDropped = res.dropped || 0;
        if (recs.length) {
          traceSince = recs[recs.length - 1].seq;
          traceRecords.push(...recs);
          if (traceRecords.length > TRACE_KEEP) traceRecords = traceRecords.slice(traceRecords.length - TRACE_KEEP);
        } else if (res.lastSeq < traceSince) {
          traceSince = 0; // the simulator counts from 0 again (a new run, or cleared)
        }
        if (tracePanel) tracePanel.webview.postMessage({ type: 'records', records: recs, points: tracePoints, status: { lastSeq: res.lastSeq, dropped: res.dropped } });
        if (recs.length) postTx({ type: 'tx', records: recs, status: { lastSeq: res.lastSeq, dropped: res.dropped } });
        if (recs.length < 5000) break;
      }
    } catch (e) { /* closed or slow: next tick */ }
    busy = false;
  };
  traceTimer = setInterval(tick, 500);
  tick();
  syncBreaks().catch(() => {});
}

function traceDisconnected() {
  clearInterval(traceTimer);
  traceTimer = undefined;
  if (tracePanel) tracePanel.webview.postMessage({ type: 'ended' });
  postTxState();
}

// ------------------------------------------------------------------ function trace (G-05)

let ftraceStatusMessage; // the status bar message while recording

async function cmdStartFtrace(arg) {
  const uri = await pickPlatform(arg);
  if (!uri) return;
  await start(uri, false, [], { ftrace: true });
}

/** The agent's function trace status, or undefined after saying why it cannot be used. */
async function ftraceStatus() {
  if (!agent) { vscode.window.showErrorMessage('No simulation is connected. Start one with "VP Studio: Start Simulation with Function Trace".'); return undefined; }
  if (!agentMethods.includes('ftrace.getStatus')) {
    vscode.window.showErrorMessage(`This sim agent has no function trace (that needs agent ${ftrace.MIN_AGENT}). Run "VP Studio: Build Sim Agent" and start again.`);
    return undefined;
  }
  const st = await agent.request('ftrace.getStatus');
  if (!st.active) {
    const again = await vscode.window.showErrorMessage(`The function trace is off: ${st.problem || 'the simulation was not started with it'}.`, 'Start Simulation with Function Trace');
    if (again && runningPlatform) vscode.window.showInformationMessage('Stop this simulation first, then run "Start Simulation with Function Trace".');
    return undefined;
  }
  return st;
}

async function cmdFtraceRecord() {
  const st = await ftraceStatus();
  if (!st) return;
  const pick = await vscode.window.showQuickPick([
    { label: 'Kernel', space: 'kernel', description: 'calls made at EL1 (recommended: kernel symbols resolve)' },
    { label: 'Everything', space: 'all', description: 'kernel and user space' },
    { label: 'User space', space: 'user', description: 'shown by address: program symbols are not loaded' },
  ], { title: 'Function trace: what to record', placeHolder: `Recording starts now and keeps the newest ${st.capacity.toLocaleString('en-US')} calls and returns per CPU` });
  if (!pick) return;
  await agent.request('ftrace.clear');
  await agent.request('ftrace.setEnabled', { enabled: true, space: pick.space });
  if (ftraceStatusMessage) ftraceStatusMessage.dispose();
  ftraceStatusMessage = vscode.window.setStatusBarMessage('$(record) Recording function trace');
  const next = await vscode.window.showInformationMessage('Recording the function trace. Run the part of interest (Run For… stops after a set time), then save.', 'Stop and Save');
  if (next) await cmdFtraceSave();
}

async function cmdFtraceSave() {
  const st = await ftraceStatus();
  if (!st) return;
  await agent.request('ftrace.setEnabled', { enabled: false });
  if (ftraceStatusMessage) { ftraceStatusMessage.dispose(); ftraceStatusMessage = undefined; }
  if (runningRemote) {
    vscode.window.showErrorMessage('The function trace of a simulation on a remote host cannot be saved yet: the agent writes the file on that host.');
    return;
  }
  if (!st.cpus.length) { vscode.window.showWarningMessage('The function trace is empty: start recording with "Function Trace: Start Recording…" first.'); return; }
  const uri = runningPlatform;
  const dir = uri ? path.join(path.dirname(uri.fsPath), 'traces') : path.join(os.tmpdir(), 'vp-studio-traces');
  fs.mkdirSync(dir, { recursive: true });
  const d = new Date();
  const two = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
  const file = path.join(dir, `${uri ? path.basename(uri.fsPath, SUFFIX) : 'simulation'}-${stamp}.vpft`);
  const res = await agent.request('ftrace.save', { path: file }, { timeoutMs: 120000 });
  await convertFtrace(file, { live: true, events: res.events });
}

async function cmdFtraceConvert(arg) {
  let file = arg && arg.fsPath;
  if (!file) {
    const picked = await vscode.window.showOpenDialog({ canSelectMany: false, title: 'Function trace to convert', filters: { 'Function trace': ['vpft'] } });
    if (!picked || !picked.length) return;
    file = picked[0].fsPath;
  }
  await convertFtrace(file, { live: false });
}

/** The symbol file for a function trace: the running platform's, the last one used, or one the user picks. */
async function ftraceSymbolFile(live) {
  const last = extContext.globalState.get('vpStudio.ftraceSymbols');
  if (live) {
    const sym = loadProfileSymbols();
    if (sym && sym.symbols) return sym.file;
  }
  const items = [];
  if (last && fs.existsSync(last)) items.push({ label: path.basename(last), description: last, file: last });
  items.push({ label: 'Choose…', choose: true }, { label: 'No symbols', description: 'functions by address' });
  const pick = await vscode.window.showQuickPick(items, { title: 'Symbol file of the traced software (for example vmlinux)' });
  if (!pick) return null;
  if (pick.choose) {
    const f = await vscode.window.showOpenDialog({ canSelectMany: false, title: 'Symbol file (ELF with a symbol table, for example vmlinux)' });
    if (!f || !f.length) return null;
    return f[0].fsPath;
  }
  return pick.file;
}

async function convertFtrace(file, { live, events }) {
  const symbolFile = await ftraceSymbolFile(live);
  if (symbolFile === null) return;
  const base = file.replace(/\.vpft$/, '');
  const jsonFile = base + '.json';
  const mdFile = base + '.md';
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Function trace${events ? `: ${events.toLocaleString('en-US')} records` : ''}` }, async (progress) => {
    progress.report({ message: 'reading' });
    const tr = ftrace.parse(fs.readFileSync(file));
    let functions = [];
    let offset = 0n;
    if (symbolFile) {
      progress.report({ message: 'reading symbols' });
      try {
        const sym = live && profileSymbols && profileSymbols.file === symbolFile && profileSymbols.symbols ? profileSymbols.symbols : elfsym.readSymbols(symbolFile);
        functions = sym.functions;
        // The running kernel's own idea of its address, else what the calls say.
        offset = live ? await findKernelOffset(sym) : 0n;
        if (!offset) offset = ftrace.guessOffset(tr, functions);
        extContext.globalState.update('vpStudio.ftraceSymbols', symbolFile);
      } catch (e) {
        vscode.window.showWarningMessage(`Symbol file ${symbolFile}: ${e.message}. Functions are shown by address.`);
      }
    }
    progress.report({ message: 'matching calls and returns' });
    await new Promise((r) => setImmediate(r));
    const built = ftrace.build(tr, { functions, offset });
    progress.report({ message: 'writing the timeline' });
    await new Promise((r) => setImmediate(r));
    const title = path.basename(base);
    ftrace.writeChromeTrace(jsonFile, built, { title });
    fs.writeFileSync(mdFile, ftrace.summary(built, { title: `Function trace: ${title}`, symbolFile, offset, traceFile: path.basename(file), jsonFile: path.basename(jsonFile) }));
  });
  showMarkdown(mdFile);
  const act = await vscode.window.showInformationMessage(`Function trace written: ${path.basename(jsonFile)} (timeline for Perfetto UI) and ${path.basename(mdFile)} (summary).`, 'Open Perfetto UI', 'Reveal Timeline File');
  if (act === 'Open Perfetto UI') vscode.env.openExternal(vscode.Uri.parse('https://ui.perfetto.dev'));
  else if (act === 'Reveal Timeline File') vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(jsonFile));
}

// ------------------------------------------------------------------ profile (G-05)

let profilePanel;
let profileTimer;
let profileState = {};     // { uri, offset (KASLR, BigInt), offsetAt }
let profileCpu = '';
let profileSymbols;        // { file, mtime, symbols } | { file, error }

/** Start Simulation with OpenOCD Port (G-13): the JTAG debug port on a free TCP port. */
async function cmdStartOpenOcd(arg) {
  const uri = await pickPlatform(arg);
  if (!uri) return;
  let data;
  try { data = JSON.parse((await vscode.workspace.openTextDocument(uri)).getText()); } catch (e) { vscode.window.showErrorMessage(`Cannot read the platform: ${e.message}`); return; }
  const t = debugdap.targets(data);
  const blocking = t.problems.filter((p) => !/different routers/.test(p));
  if (blocking.length) { vscode.window.showErrorMessage(`Cannot add the OpenOCD debug port: ${blocking.join(' ')}`); return; }
  const port = await simagent.freePort();
  await start(uri, false, [], { openocd: { port } });
}

/** debug/<platform>.openocd.cfg next to the platform, for the running simulation's port. */
async function writeOpenOcdConfig(uri, doc, port) {
  const dir = path.join(path.dirname(uri.fsPath), 'debug');
  await fs.promises.mkdir(dir, { recursive: true });
  const name = path.basename(uri.fsPath, SUFFIX);
  const file = path.join(dir, `${name}.openocd.cfg`);
  const n = debugdap.targets(doc).cpus.length;
  await fs.promises.writeFile(file, debugdap.openocdConfig({ port, cpus: n, platform: name }), 'utf8');
  const cmd = `openocd -f "${file}"`;
  const pick = await vscode.window.showInformationMessage(
    `OpenOCD debug port on 127.0.0.1:${port} (${n} core${n === 1 ? '' : 's'}). Run: ${cmd}, then use telnet localhost 4444: vp_halt <n>, vp_resume <n>, vp_halt_all, vp_resume_all, vp_status, vp.sys mdw <address>.`,
    'Open Configuration', 'Copy Command');
  if (pick === 'Open Configuration') await vscode.window.showTextDocument(vscode.Uri.file(file));
  if (pick === 'Copy Command') await vscode.env.clipboard.writeText(cmd);
}

async function cmdStartProfile(arg) {
  const uri = await pickPlatform(arg);
  if (!uri) return;
  await start(uri, false, [], { profile: true });
}

function showProfilePanel(uri, preserveFocus) {
  if (profilePanel) { profilePanel.reveal(undefined, preserveFocus); return; }
  const name = uri ? path.basename(uri.fsPath, SUFFIX) : 'simulation';
  profilePanel = vscode.window.createWebviewPanel('vpStudio.profile', `Profile: ${name}`,
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: !!preserveFocus }, { enableScripts: true, retainContextWhenHidden: true });
  const nonce = crypto.randomBytes(16).toString('hex');
  profilePanel.webview.html = profileview.render(nonce, profilePanel.webview.cspSource, `Profile: ${name}`);
  profilePanel.onDidDispose(() => { profilePanel = undefined; clearInterval(profileTimer); profileTimer = undefined; });
  profilePanel.webview.onDidReceiveMessage((m) => handleProfileMessage(m).catch((e) => vscode.window.showErrorMessage(`Profile: ${e.message}`)));
}

/** The symbol file for the profile: chosen for this platform, else the platform's first one. */
function profileSymbolFile() {
  const uri = profileState.uri;
  if (!uri) return undefined;
  const chosen = extContext && extContext.workspaceState.get(`vpStudio.profileSymbols.${uri.toString()}`);
  if (chosen) return chosen;
  try {
    const files = images.collect(runningDoc, core.analyze(runningDoc), path.dirname(uri.fsPath)).symbolFiles;
    return files[0];
  } catch (e) { return undefined; }
}

function loadProfileSymbols() {
  const file = profileSymbolFile();
  if (!file) { profileSymbols = undefined; return undefined; }
  let mtime = 0;
  try { mtime = fs.statSync(file).mtimeMs; } catch (e) { return (profileSymbols = { file, error: 'not found' }); }
  if (profileSymbols && profileSymbols.file === file && profileSymbols.mtime === mtime) return profileSymbols;
  try {
    profileSymbols = { file, mtime, symbols: elfsym.readSymbols(file) };
  } catch (e) {
    profileSymbols = { file, mtime, error: e.message };
  }
  profileState.offset = undefined; // a new file: find the offset again
  return profileSymbols;
}

/**
 * KASLR offset of an arm64 Linux kernel: find the loaded image with the arm64
 * Image magic and read the kimage_vaddr it relocated at boot (lib/analysis/profile.js).
 * 0 when it cannot tell (no such symbol, image or bus access).
 */
async function findKernelOffset(symbols) {
  const kv = profile.kimageVaddrOffset(symbols);
  if (!kv || !agent || !agentMethods.includes('mem.read') || !runningDoc) return 0n;
  let loaders = [];
  try { loaders = images.collect(runningDoc, core.analyze(runningDoc), path.dirname(profileState.uri.fsPath)).loaders; } catch (e) { return 0n; }
  for (const l of loaders) {
    for (const e of l.entries) {
      const at = e.ranges && e.ranges[0] && e.ranges[0].start;
      if (at === undefined || e.kind !== 'bin') continue;
      try {
        const m = await agent.request('mem.read', { address: '0x' + (BigInt(at) + 0x38n).toString(16), size: 4 });
        if (!profile.isArm64Image(m.data)) continue;
        const v = await agent.request('mem.read', { address: '0x' + (BigInt(at) + kv.offset).toString(16), size: 8 });
        return profile.kaslrOffset(v.data, kv.text);
      } catch (err) { /* not mapped or no bus: try the next */ }
    }
  }
  return 0n;
}

async function refreshProfile() {
  if (!profilePanel || !agent) return;
  if (!agentMethods.includes('profile.read')) {
    profilePanel.webview.postMessage({ type: 'profile', problem: 'this sim agent cannot profile (that needs agent 0.8.0); run "VP Studio: Build Sim Agent" and start again', rows: [] });
    return;
  }
  const res = await agent.request('profile.read', profileCpu === '' ? {} : { cpu: Number(profileCpu) }, { timeoutMs: 30000 });
  const sym = loadProfileSymbols();
  const fns = sym && sym.symbols ? sym.symbols.functions : [];
  if (sym && sym.symbols && (profileState.offset === undefined || (profileState.retry && Date.now() - profileState.offsetAt > 10000))) {
    profileState.offset = await findKernelOffset(sym.symbols);
    profileState.offsetAt = Date.now();
  }
  const offset = profileState.offset || 0n;
  const sum = profile.summarize(res.blocks || [], fns, offset);
  const warning = profile.symbolWarning(sum, !!(sym && sym.symbols)) || (sym && sym.error ? `Symbol file ${sym.file}: ${sym.error}` : '');
  profileState.retry = !!warning; // the kernel may not have relocated itself yet when it was read
  const shown = res.cpus.filter((c) => profileCpu === '' || String(c.cpu) === profileCpu).reduce((s, c) => s + c.samples, 0);
  const text = !res.active ? '' : `${sum.total} samples${profileCpu === '' ? '' : ` on cpu ${profileCpu}`} (one every ${res.period} instructions, about ${(shown * res.period / 1e9).toFixed(2)} billion instructions) in the last ${res.seconds.toFixed(0)} s of host time` +
    (offset ? ` · kernel KASLR offset 0x${offset.toString(16)}` : '') + (res.enabled ? '' : ' · sampling is off');
  profilePanel.webview.postMessage({
    type: 'profile', active: res.active, problem: res.problem || (res.active ? '' : 'the simulation was not started with profiling'),
    enabled: res.enabled, cpus: res.cpus, total: sum.total, text, warning,
    stats: res.active ? { cpu: profileCpu, period: res.period, instructions: shown * res.period, seconds: res.seconds, offset: offset ? `0x${offset.toString(16)}` : '' } : {},
    symbolFile: sym ? path.basename(sym.file) : '', rows: sum.rows.slice(0, 300),
  });
}

function profileConnected() {
  if (!profilePanel || !agent || profileTimer) return;
  const client = agent;
  let busy = false;
  profileTimer = setInterval(async () => {
    if (busy || agent !== client) return;
    busy = true;
    try { await refreshProfile(); } catch (e) { /* next tick */ }
    busy = false;
  }, 2000);
  refreshProfile().catch(() => {});
}

async function handleProfileMessage(m) {
  if (!m) return;
  if (m.type === 'ready') { profileConnected(); return; }
  if (!agent) throw new Error('not connected to a simulation');
  if (m.type === 'cpu') profileCpu = String(m.cpu || '');
  else if (m.type === 'sampling') await agent.request('profile.setEnabled', { enabled: !!m.enabled });
  else if (m.type === 'reset') await agent.request('profile.reset');
  else if (m.type === 'chooseSymbols') {
    const picked = await vscode.window.showOpenDialog({ canSelectMany: false, title: 'Symbol file of the software to profile (for example vmlinux)' });
    if (!picked || !picked.length || !profileState.uri) return;
    await extContext.workspaceState.update(`vpStudio.profileSymbols.${profileState.uri.toString()}`, picked[0].fsPath);
  }
  await refreshProfile();
}

/** Probes recording now, remembered per platform as the next "Start Simulation with Tracing" choice. */
async function rememberProbes() {
  if (!extContext || !runningPlatform) return;
  await extContext.workspaceState.update(`vpStudio.trace.${runningPlatform.toString()}`, traceProbes.filter((p) => p.recording).map((p) => p.name));
}

/**
 * G-12: choose which probes of the running simulation record. Every place a
 * probe fits got one at the start; this only turns recording on and off.
 */
async function cmdChooseProbes() {
  if (!agent) {
    vscode.window.showWarningMessage('Not connected to a simulation. Start one with "VP Studio: Start Simulation".');
    return;
  }
  if (!agentMethods.includes('trace.setPoints')) {
    const p = await vscode.window.showWarningMessage('This sim agent cannot turn probes on and off while running (that needs agent 0.9.0). Build the new agent, then stop and start the simulation again.', 'Build Sim Agent');
    if (p) vscode.commands.executeCommand('vpStudio.buildSimAgent');
    return;
  }
  const st = await agent.request('trace.getStatus');
  showProbes(st);
  if (!traceProbes.length) {
    vscode.window.showInformationMessage(cfg().get('probes.insertAll') === false
      ? 'This simulation has no probes: "vpStudio.probes.insertAll" is off. Turn it on and start again, or use "Start Simulation with Tracing".'
      : 'This simulation has no probes: the platform has no bus-mapped port or signal a probe fits in (replicated modules and {i} ports are left out).');
    return;
  }
  const info = new Map((runningDoc ? trace.probeList(runningDoc, catalog()) : []).map((p) => [p.id, p]));
  const KIND = { bus: 'Bus', memory: 'Memory', signal: 'Signals' };
  const items = [];
  for (const kind of ['bus', 'memory', 'signal']) {
    const list = traceProbes.filter((p) => p.kind === kind);
    if (!list.length) continue;
    items.push({ label: KIND[kind], kind: vscode.QuickPickItemKind.Separator });
    for (const p of list) {
      items.push({
        label: p.name, picked: p.recording, name: p.name,
        description: (info.get(p.name) || {}).description || kind,
        detail: kind === 'memory' ? 'While it records, CPUs lose direct access (DMI) to this memory: every access is seen, and the simulation runs slower' : undefined,
      });
    }
  }
  const picked = await pickMany(items, {
    title: 'Probes: choose which ones record',
    placeHolder: 'Every bus-mapped port and signal has a probe; the checked ones record. Changes apply at once, without a restart.',
  });
  if (!picked || !agent) return;
  const want = new Set(picked.map((p) => p.name));
  const on = traceProbes.filter((p) => want.has(p.name) && !p.recording).map((p) => p.name);
  const off = traceProbes.filter((p) => !want.has(p.name) && p.recording).map((p) => p.name);
  let res;
  if (off.length) res = await agent.request('trace.setPoints', { points: off, recording: false });
  if (on.length) res = await agent.request('trace.setPoints', { points: on, recording: true });
  if (res) showProbes(res);
  await rememberProbes();
  if (on.length) {
    showTracePanel(true);
    traceConnected();
    if (!res.enabled) {
      const p = await vscode.window.showInformationMessage('Recording is paused in the Transaction Trace panel, so the probes record nothing yet.', 'Resume Recording');
      if (p && agent) { const s = await agent.request('trace.setEnabled', { enabled: true }); if (tracePanel) tracePanel.webview.postMessage({ type: 'recording', enabled: s.enabled }); }
    }
  }
}

/** Ask which bus-mapped ports to trace, then start the simulation with tracers in front of them. */
async function cmdStartTrace(context, arg) {
  const uri = await pickPlatform(arg);
  if (!uri) return;
  const loaded = await load(uri);
  if (!loaded) return;
  const points = trace.tracePoints(loaded.data);
  const signals = trace.signalPoints(loaded.data, catalog());
  if (!points.length && !signals.length) { vscode.window.showWarningMessage('This platform has no bus-mapped port or signal that can be traced.'); return; }
  const key = `vpStudio.trace.${uri.toString()}`;
  const last = context.workspaceState.get(key);
  const items = points.map((p) => ({
    label: p.id,
    description: `${p.address === null ? '?' : core.hex(p.address)}${p.size !== null && p.size !== undefined ? ` (${core.hex(p.size)})` : ''} · ${p.type}`,
    detail: p.memory ? 'Memory: traced with DMI on, so accesses the CPU makes directly are not seen' : undefined,
    picked: last ? last.includes(p.id) : !p.memory,
    id: p.id,
  }));
  if (signals.length) {
    items.push({ label: 'Signals', kind: vscode.QuickPickItemKind.Separator });
    for (const s of signals) {
      items.push({ label: s.id, description: `→ ${s.dest}.${s.destPort} · signal`, picked: last ? last.includes(s.id) : false, id: s.id });
    }
  }
  const picked = await pickMany(items, {
    title: 'Start Simulation with Tracing',
    placeHolder: 'Bus-mapped ports to record accesses to, and signals (interrupt lines) to record changes of',
  });
  if (!picked || !picked.length) return;
  const ids = picked.map((p) => p.id);
  await context.workspaceState.update(key, ids);
  traceSince = 0;
  traceRecords = [];
  if (tracePanel) tracePanel.webview.postMessage({ type: 'cleared' });
  postTx({ type: 'tx', records: [], reset: true });
  await start(uri, false, ids);
}


function disconnectAgent() {
  agentAttempt++;
  if (agent) agent.close(); // the close handler resets the state
  else if (agentItem) updateAgentItem();
}

async function agentCall(method, params) {
  if (!agent) {
    vscode.window.showWarningMessage('Not connected to a simulation. Start one with "VP Studio: Start Simulation", or run "VP Studio: Connect to Sim Agent".');
    return undefined;
  }
  try {
    return await agent.request(method, params);
  } catch (e) {
    vscode.window.showErrorMessage(`${method} failed: ${e.message}`);
    return undefined;
  }
}

async function cmdPause() { applyStatus(await agentCall('sim.pause')); }
async function cmdContinue() { applyStatus(await agentCall('sim.continue')); }

/** Run for a while (absolute: until a simulated time), then pause. */
async function runTimed(absolute) {
  const method = absolute ? 'sim.runUntil' : 'sim.runFor';
  if (!agent) return agentCall(method);
  if (!agentMethods.includes(method)) {
    const p = await vscode.window.showWarningMessage(
      'This sim agent cannot stop at a simulated time (that needs agent 0.4.0 or later). Rebuild it, then restart the simulation.',
      'Build Sim Agent');
    if (p) vscode.commands.executeCommand('vpStudio.buildSimAgent');
    return undefined;
  }
  if (agentStatus && agentStatus.state === 'halted') {
    vscode.window.showWarningMessage('A debugger has the target stopped. Continue in the debugger first.');
    return undefined;
  }
  const now = agentStatus && agentStatus.time ? agentStatus.time.seconds : undefined;
  const key = absolute ? 'vpStudio.runUntil.last' : 'vpStudio.runFor.last';
  const input = await vscode.window.showInputBox({
    title: absolute ? 'Run Until' : 'Run For',
    prompt: absolute
      ? `Simulated time to pause at${now !== undefined ? ` (now ${simagent.formatTime(now)})` : ''}. Units: s, ms, us, ns, ps.`
      : 'Simulated time to run before pausing. Units: s, ms, us, ns, ps.',
    value: extContext.workspaceState.get(key, absolute ? '' : '100 ms'),
    placeHolder: absolute ? '30 s' : '100 ms',
    validateInput: (v) => {
      try {
        const t = simagent.parseSimTime(v);
        if (absolute && now !== undefined && t.seconds <= now) return `Enter a time after the current time (${simagent.formatTime(now)})`;
        if (!absolute && t.seconds === 0) return 'Enter a time greater than 0';
        return undefined;
      } catch (e) {
        return e.message;
      }
    },
  });
  if (input === undefined) return undefined;
  const t = simagent.parseSimTime(input);
  await extContext.workspaceState.update(key, input.trim());
  const status = await agentCall(method, absolute ? { time: t.text } : { duration: t.text });
  applyStatus(status);
  return status;
}

async function cmdConnectAgent() {
  const input = await vscode.window.showInputBox({
    title: 'Connect to Sim Agent',
    prompt: 'Address of a running simulation\'s sim agent (it prints "sim-agent: listening on HOST:PORT" at start)',
    placeHolder: '127.0.0.1:51000',
    validateInput: (v) => (/^([^:\s]+:)?\d{1,5}$/.test(v.trim()) ? undefined : 'Enter PORT or HOST:PORT'),
  });
  if (!input) return;
  const m = /^(?:([^:\s]+):)?(\d+)$/.exec(input.trim());
  runningPlatform = undefined; // started elsewhere: which platform it runs is unknown
  await connectAgent({ host: m[1] || '127.0.0.1', port: Number(m[2]), auto: false });
}

/*
 * Peripheral Registers view. Peripherals of the running platform that a
 * register description covers (catalog/registers, wizard models); their
 * registers are read with the agent's mem.read while the simulation is
 * paused (or halted by a debugger), once per pause, when a peripheral is
 * expanded. Registers whose reading changes the device are read only on
 * request.
 */
class RegisterTree {
  constructor() {
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
    this.stopped = false;
    this.values = new Map(); // "periph id|reg name" -> {value} | {error}
    this.reading = new Map(); // periph id -> Promise
  }
  reset() { this.values.clear(); this.reading.clear(); this.stopped = false; this.emitter.fire(); }
  setStopped(stopped) {
    this.stopped = stopped;
    this.values.clear(); // values of the last pause are old once it runs again
    this.reading.clear();
    this.emitter.fire();
  }
  refresh() { this.values.clear(); this.reading.clear(); this.emitter.fire(); }
  descriptions() {
    // The workspace's descriptions come first, so they win over the shipped ones for the same type and port.
    const own = registers.loadFiles(workspaceRegisterFiles);
    const shipped = registers.loadDir(path.join(__dirname, 'catalog', 'registers'));
    const descs = own.descs.concat(shipped.descs);
    const problems = own.problems.concat(shipped.problems);
    for (const m of modelSpecs) {
      try { descs.push(registers.fromModelSpec(m.spec, m.file)); } catch (e) { problems.push(`${path.basename(m.file)}: ${e.message}`); }
    }
    return { descs, problems };
  }
  peripherals() {
    if (!runningDoc) return [];
    return registers.peripherals(runningDoc, this.descriptions().descs, runningBuses);
  }
  note(text, icon = 'info') {
    const item = new vscode.TreeItem(text, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon(icon);
    return { item };
  }
  async getChildren(node) {
    if (!agent) return [];
    if (!node) {
      if (!agentMethods.includes('mem.read')) return [this.note('This sim agent cannot read registers (that needs agent 0.6.0). Run "VP Studio: Build Sim Agent" and start the simulation again.', 'warning')];
      if (!runningDoc) return [this.note('Registers are shown for simulations started with "Start Simulation".')];
      const ps = this.peripherals();
      if (!ps.length) return [this.note('No peripheral of this platform has a register description.')];
      return ps.map((p) => ({ periph: p }));
    }
    if (node.field) return [];
    if (node.regNode) {
      const v = this.values.get(`${node.periph.id}|${node.reg.name}`);
      return node.reg.fields.map((f) => ({ periph: node.periph, reg: node.reg, field: f, value: v && v.value }));
    }
    if (node.periph) {
      if (!this.stopped) return [this.note('Pause the simulation to read the registers.', 'debug-pause')];
      await this.readPeriph(node.periph);
      return node.periph.registers.map((r) => ({ periph: node.periph, reg: r, regNode: true }));
    }
    return [];
  }
  readPeriph(p) {
    if (!this.reading.has(p.id)) {
      this.reading.set(p.id, (async () => {
        for (const r of p.registers) {
          if (registers.notReadReason(r)) continue;
          await this.readReg(p, r);
        }
      })());
    }
    return this.reading.get(p.id);
  }
  async readReg(p, r) {
    const key = `${p.id}|${r.name}`;
    try {
      const res = await agent.request('mem.read', { address: '0x' + (p.address + r.offset).toString(16), size: r.size, bus: p.busIndex });
      this.values.set(key, { value: registers.fromBytes(res.data) });
    } catch (e) {
      this.values.set(key, { error: e.message });
    }
  }
  getTreeItem(node) {
    if (node.item) return node.item;
    const p = node.periph;
    if (!node.reg) {
      const item = new vscode.TreeItem(p.module, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = 'r:' + p.id;
      item.description = `${p.type} · ${registers.hexOf(p.address, 4).replace(/_/g, '')}`;
      item.tooltip = `${p.title}\n${p.id} at ${'0x' + p.address.toString(16)} on ${p.bus}`;
      item.iconPath = new vscode.ThemeIcon('plug', new vscode.ThemeColor(MODULE_ROLE_LOOK.periph.color));
      item.contextValue = 'vpPeriph';
      return item;
    }
    const r = node.reg;
    const addr = '0x' + (p.address + r.offset).toString(16);
    const v = this.values.get(`${p.id}|${r.name}`);
    if (!node.field) {
      const item = new vscode.TreeItem(r.name, r.fields.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
      item.id = `r:${p.id}|${r.name}`;
      const why = registers.notReadReason(r);
      item.description = v && v.value !== undefined ? registers.hexOf(v.value, r.size) : v && v.error ? 'read failed' : why ? `not read: ${why}` : '';
      const md = new vscode.MarkdownString();
      md.appendMarkdown(`**${r.name}** · offset 0x${r.offset.toString(16)} · ${addr} · ${r.size * 8} bits · ${r.access}\n\n`);
      if (r.description) md.appendText(r.description + '\n\n');
      if (v && v.error) md.appendText(`Read failed: ${v.error}\n\n`);
      if (r.readSideEffect) md.appendMarkdown('*Reading this register changes the device (for example, it takes a received character), so it is read only with Read Now.*');
      item.tooltip = md;
      item.iconPath = new vscode.ThemeIcon(r.access === 'ro' ? 'lock' : 'symbol-field');
      item.contextValue = ['vpReg', r.access === 'ro' ? 'RO' : 'W', why ? 'Unread' : ''].join('');
      return item;
    }
    const f = node.field;
    const item = new vscode.TreeItem(`${f.name} ${registers.bitsText(f)}`, vscode.TreeItemCollapsibleState.None);
    item.id = `r:${p.id}|${r.name}|${f.name}`;
    if (node.value !== undefined) {
      const fv = registers.fieldValue(node.value, f);
      item.description = f.msb === f.lsb ? String(fv) : `0x${fv.toString(16)} (${fv})`;
    }
    item.tooltip = f.description || `${f.name}, bits ${registers.bitsText(f)} of ${r.name}`;
    item.iconPath = new vscode.ThemeIcon('symbol-constant');
    // A field is set by read-modify-write, which needs a readable register (w1c writes the field alone).
    const settable = r.access !== 'ro' && (r.access === 'w1c' || !registers.notReadReason(r));
    item.contextValue = settable ? 'vpField' : 'vpFieldRO';
    return item;
  }
}
let registerTree;

function registerStopped() {
  if (!agent) { vscode.window.showWarningMessage('Not connected to a simulation.'); return false; }
  if (!registerTree.stopped) { vscode.window.showWarningMessage('Pause the simulation first: registers are read and written while it is paused.'); return false; }
  return true;
}

/** Read a register now, even one whose reading changes the device. */
async function cmdReadRegister(node) {
  if (!node || !node.reg || !registerStopped()) return;
  await registerTree.readReg(node.periph, node.reg);
  registerTree.emitter.fire();
}

/** Write a register, or a field of it (read-modify-write), after asking. */
async function cmdSetRegister(node) {
  if (!node || !node.reg || !registerStopped()) return;
  const p = node.periph;
  const r = node.reg;
  const f = node.field;
  if (r.access === 'ro') { vscode.window.showWarningMessage(`${r.name} is read-only.`); return; }
  const key = `${p.id}|${r.name}`;
  const cur = registerTree.values.get(key);
  const curValue = cur && cur.value;
  const bits = f ? f.msb - f.lsb + 1 : r.size * 8;
  const now = f ? (curValue !== undefined ? registers.fieldValue(curValue, f) : undefined) : curValue;
  const text = await vscode.window.showInputBox({
    title: `Set ${f ? `${r.name}.${f.name} ${registers.bitsText(f)}` : r.name} of ${p.module}`,
    prompt: `${bits} bit${bits > 1 ? 's' : ''}${now !== undefined ? ` · now 0x${now.toString(16)}` : ''}${r.access === 'w1c' ? ' · write 1 to clear' : ''}. Decimal, 0x hex or 0b binary.`,
    value: now !== undefined ? '0x' + now.toString(16) : '',
    validateInput: (t) => { try { registers.parseValue(t, bits); return undefined; } catch (e) { return e.message; } },
  });
  if (text === undefined) return;
  const v = registers.parseValue(text, bits);
  let regValue = v;
  if (f) {
    if (r.access === 'w1c') regValue = registers.withField(0n, f, v); // only this field's 1s clear
    else if (curValue === undefined) { vscode.window.showWarningMessage(`${r.name} has not been read, so its other fields are unknown; set the whole register instead.`); return; }
    else regValue = registers.withField(curValue, f, v);
  }
  const addr = p.address + r.offset;
  const pick = await vscode.window.showWarningMessage(`Write ${registers.hexOf(regValue, r.size)} to ${r.name} of ${p.module} (0x${addr.toString(16)})?`, {
    modal: true,
    detail: 'The device sees it as a write from the bus, as if the CPU wrote it: it may act on it (send data, clear an interrupt, reset a queue). The guest software is not told.',
  }, 'Write');
  if (pick !== 'Write') return;
  try {
    await agent.request('mem.write', { address: '0x' + addr.toString(16), data: registers.toBytes(regValue, r.size), bus: p.busIndex });
  } catch (e) {
    vscode.window.showErrorMessage(`Writing ${r.name} failed: ${e.message}`);
    return;
  }
  if (!registers.notReadReason(r)) await registerTree.readReg(p, r);
  registerTree.emitter.fire();
}

// ---------------------------------------------------------------- G-06: Linux awareness

const DEBUG_TYPE = 'gdbtarget';
const linuxScript = () => path.join(extContext.extensionPath, 'tools', 'gdb', 'vp-linux.py');

/**
 * Guest Processes: the Linux processes of the target, read through the CDT
 * debug session with tools/gdb/vp-linux.py while the target is stopped.
 * Reads only while the view is visible: a read takes about a second of gdb
 * time, which would slow every step otherwise.
 */
class GuestTree {
  constructor() {
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
    this.session = undefined;   // the debug session it reads from
    this.stopped = false;
    this.data = undefined;      // processTree result
    this.stale = true;          // the target ran since the last read
    this.loaded = new Set();    // session ids where the script is loaded
    this.busy = undefined;
    this.view = undefined;
  }
  attach(view) {
    this.view = view;
    view.onDidChangeVisibility(() => { if (view.visible && this.stale) this.refresh(); });
    this.show();
  }
  sessionStarted(s) { if (s.type === DEBUG_TYPE) { this.session = s; this.stopped = false; this.data = undefined; this.show(); this.context(); } }
  sessionEnded(s) {
    this.loaded.delete(s.id);
    if (this.session && this.session.id === s.id) {
      this.session = vscode.debug.activeDebugSession && vscode.debug.activeDebugSession.type === DEBUG_TYPE ? vscode.debug.activeDebugSession : undefined;
      this.stopped = false; this.data = undefined; this.show(); this.context();
    }
  }
  context() { setCtx('vpStudio.guestDebug', !!this.session); }
  onStopped(s) {
    this.session = s; this.stopped = true; this.stale = true;
    clearTimeout(this.timer);
    // After CDT has answered VS Code's own requests for the new stop.
    this.timer = setTimeout(() => { if (this.view && this.view.visible) this.refresh(); else this.show(); }, 400);
  }
  onRunning(s) { if (this.session && s.id === this.session.id) { this.stopped = false; this.stale = true; clearTimeout(this.timer); this.show(); } }

  /** A gdb (MI) command through CDT; loads the script first when this gdb lacks it. */
  async mi(command) {
    const s = this.session;
    try {
      return guestlinux.parseResult(await s.customRequest('evaluate', guestlinux.evaluateArgs(command)));
    } catch (e) {
      if (!guestlinux.notLoaded(e.message) || this.loaded.has(s.id)) throw e;
      await s.customRequest('evaluate', guestlinux.evaluateArgs(guestlinux.sourceCommand(linuxScript())));
      this.loaded.add(s.id);
      return guestlinux.parseResult(await s.customRequest('evaluate', guestlinux.evaluateArgs(command)));
    }
  }

  async refresh() {
    if (!this.session || !this.stopped) { this.show(); return; }
    if (this.busy) return this.busy;
    this.busy = (async () => {
      this.error = undefined;
      try {
        this.data = guestlinux.processTree(guestlinux.normalizePs(await this.mi('-vp-ps -t')));
        this.stale = false;
      } catch (e) {
        this.data = undefined;
        this.error = e.message;
      }
      this.busy = undefined;
      this.show();
    })();
    return this.busy;
  }

  show() {
    if (this.view) {
      let msg;
      if (!this.session) msg = 'Attach the debugger to the target ("VP: attach to target software") to see the guest\'s Linux processes.';
      else if (!this.stopped) msg = this.data ? 'The target is running; this list is from the last stop. Pause it to read again.' : 'Pause the target in the debugger to read the guest\'s Linux processes.';
      else if (this.error) msg = this.error;
      else if (this.stale && !this.data) msg = 'Reading…';
      this.view.message = msg;
      const c = this.data && this.data.count;
      this.view.description = c ? `${c.processes} processes, ${c.threads} threads` : undefined;
    }
    this.emitter.fire();
  }

  getChildren(node) {
    if (!this.data) return [];
    if (!node) return [{ kind: 'cpus' }, ...this.data.roots.map((n) => ({ kind: 'proc', n }))];
    if (node.kind === 'cpus') return this.data.cpus.map((c) => ({ kind: 'cpu', c }));
    if (node.kind === 'proc') return [...node.n.threads.map((t) => ({ kind: 'thread', t })), ...node.n.children.map((n) => ({ kind: 'proc', n }))];
    return [];
  }

  getTreeItem(node) {
    const None = vscode.TreeItemCollapsibleState.None;
    if (node.kind === 'cpus') {
      const busy = this.data.cpus.filter((c) => !c.idle).length;
      const item = new vscode.TreeItem('CPUs', vscode.TreeItemCollapsibleState.Expanded);
      item.id = 'g:cpus';
      item.description = `${busy} of ${this.data.cpus.length} running a task`;
      item.iconPath = new vscode.ThemeIcon('circuit-board');
      return item;
    }
    if (node.kind === 'cpu') {
      const l = guestlinux.cpuLabel(node.c);
      const item = new vscode.TreeItem(l.label, None);
      item.id = 'g:cpu' + node.c.cpu;
      item.description = l.description;
      item.iconPath = new vscode.ThemeIcon(node.c.idle ? 'debug-pause' : 'play', node.c.idle ? undefined : new vscode.ThemeColor('debugIcon.startForeground'));
      return item;
    }
    const isThread = node.kind === 'thread';
    const p = isThread ? node.t : node.n.proc;
    const l = guestlinux.procLabel(p, isThread);
    const kids = isThread ? 0 : node.n.threads.length + node.n.children.length;
    // systemd open, the kernel threads closed: there are a hundred of them.
    const state = !kids ? None : p.pid === 1 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;
    const item = new vscode.TreeItem(l.label, state);
    item.id = 'g:' + p.pid;
    item.description = l.description;
    item.tooltip = guestlinux.procTooltip(p, isThread);
    item.iconPath = new vscode.ThemeIcon(p.running >= 0 ? 'play' : isThread ? 'debug-stackframe-dot' : p.kernel ? 'gear' : 'terminal',
      p.running >= 0 ? new vscode.ThemeColor('debugIcon.startForeground') : undefined);
    item.contextValue = 'vpGuestTask';
    return item;
  }
}

let guestTree;

/**
 * CPU Registers (Run and Debug side bar): the registers of the selected CPU
 * (gdb thread) of the target debug session, read with gdb MI through CDT when
 * the target stops, another CPU is selected in Call Stack, or the view shows.
 */
class CpuRegsView {
  constructor() {
    this.view = undefined;
    this.session = undefined;
    this.stopped = false;
    this.thread = undefined;     // gdb thread (CPU) shown
    this.names = new Map();      // session id -> -data-list-register-names result
    this.cur = new Map();        // thread -> { seq, values: Map(name -> value) } of its latest read
    this.before = new Map();     // thread -> values read at an earlier stop: what "changed" compares with
    this.last = undefined;       // last message posted
    this.stopSeq = 0;            // stops seen
  }
  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = cpuregsview.render(crypto.randomBytes(16).toString('hex'), view.webview.cspSource);
    view.webview.onDidReceiveMessage((m) => {
      if (!m) return;
      if (m.type === 'ready') { if (this.last) this.post(this.last); this.refresh(); }
      else if (m.type === 'refresh') this.refresh(true);
      else if (m.type === 'copy') vscode.env.clipboard.writeText(String(m.text || ''));
    });
    view.onDidChangeVisibility(() => { if (view.visible) this.refresh(); });
  }
  post(m) { this.last = m; if (this.view) this.view.webview.postMessage(m); }
  sessionStarted(s) { if (s.type === DEBUG_TYPE) { this.session = s; this.stopped = false; this.post({ type: 'regs', state: 'running', thread: undefined, regs: [] }); } }
  sessionEnded(s) {
    this.names.delete(s.id);
    if (this.session && this.session.id === s.id) { this.session = undefined; this.stopped = false; this.cur.clear(); this.before.clear(); this.post({ type: 'regs', state: 'none', regs: [] }); }
  }
  onStopped(s, threadId) {
    this.session = s; this.stopped = true; this.stopSeq++;
    if (threadId !== undefined) this.thread = threadId;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.refresh(), 300); // after VS Code's own requests for the stop
  }
  onRunning(s) {
    if (!this.session || s.id !== this.session.id) return;
    this.stopped = false;
    if (this.last) this.post(Object.assign({}, this.last, { state: 'running' }));
  }
  /** Another CPU or frame chosen in Call Stack. */
  onActiveStackItem(item) {
    if (!item || !item.session || item.session.type !== DEBUG_TYPE || item.threadId === undefined) return;
    if (item.threadId === this.thread && item.session === this.session) return;
    this.session = item.session; this.thread = item.threadId;
    this.refresh();
  }
  async refresh(force) {
    if (!this.view || !this.view.visible) return;
    const s = this.session;
    if (!s) { this.post({ type: 'regs', state: 'none', regs: [] }); return; }
    if (!this.stopped && !force) return;
    if (this.busy) return;
    this.busy = true;
    try {
      const run = (cmd) => s.customRequest('evaluate', guestlinux.evaluateArgs(cmd)).then(guestlinux.parseResult);
      const threads = ((await s.customRequest('threads')) || {}).threads || [];
      if (this.thread === undefined || !threads.some((t) => t.id === this.thread)) this.thread = threads.length ? threads[0].id : 1;
      const t = threads.find((x) => x.id === this.thread);
      if (!this.names.has(s.id)) this.names.set(s.id, await run('-data-list-register-names'));
      const values = await run(cpuregs.valuesCommand(this.thread));
      // Mark what changed since this CPU's read at an earlier stop; re-reading the same stop keeps that base.
      const c = this.cur.get(this.thread);
      if (c && c.seq < this.stopSeq) this.before.set(this.thread, c.values);
      const regs = cpuregs.snapshot(this.names.get(s.id), values, this.before.get(this.thread));
      const cpsr = regs.find((r) => r.name === 'cpsr');
      this.cur.set(this.thread, { seq: this.stopSeq, values: new Map(regs.map((r) => [r.name, r.value])) });
      this.post({ type: 'regs', state: this.stopped ? 'stopped' : 'running', thread: { id: this.thread, name: t ? t.name : `thread ${this.thread}` }, regs, pstate: cpsr ? cpuregs.decodePstate(cpsr.value) : null });
    } catch (e) {
      this.post({ type: 'regs', state: this.stopped ? 'stopped' : 'running', thread: undefined, regs: this.last ? this.last.regs || [] : [], error: `Could not read the registers: ${e.message}` });
    }
    this.busy = false;
  }
}
let cpuRegsView;

/**
 * Map the kernel sources: the stopped frame names a file on the machine the
 * kernel was built on (/build/linux-…/arch/arm64/kernel/idle.c); the user picks
 * the local tree; gdb gets set substitute-path at once and at every attach.
 */
async function cmdMapSources() {
  const s = guestTree.session;
  if (!s) { vscode.window.showWarningMessage('Attach the debugger to the target first ("VP: attach to target software").'); return; }
  if (!guestTree.stopped) { vscode.window.showWarningMessage('Pause the target in the debugger first, so that VP Studio can see which source file it needs.'); return; }
  const item = vscode.debug.activeStackItem;
  const threadId = item && item.session === s && item.threadId !== undefined ? item.threadId : (cpuRegsView && cpuRegsView.thread) || 1;
  const st = await s.customRequest('stackTrace', { threadId, startFrame: 0, levels: 40 });
  const frames = (st && st.stackFrames) || [];
  const missing = frames.find((f) => f.source && f.source.path && !fs.existsSync(f.source.path));
  if (!missing) {
    vscode.window.showInformationMessage(frames.some((f) => f.source && f.source.path) ? 'The sources of the current stack are already found.' : 'The current stack has no source files (no symbols?). Stop in kernel code that vmlinux describes and try again.');
    return;
  }
  const picked = await vscode.window.showOpenDialog({
    canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Use this source tree',
    title: `Folder with the kernel source (built at ${path.posix.dirname(missing.source.path)})`,
  });
  if (!picked || !picked[0]) return;
  const root = picked[0].fsPath;
  const m = guestlinux.sourceMapping(missing.source.path, root, (p) => fs.existsSync(p));
  if (!m) {
    vscode.window.showErrorMessage(`${root} has no file matching ${missing.source.path} (looked for every tail of the path, such as ${missing.source.path.split('/').slice(-3).join('/')}). Pick the top folder of the same kernel version's source.`);
    return;
  }
  const map = Object.assign({}, cfg().get('debug.sourceMap') || {}, { [m.from]: m.to });
  await cfg().update('debug.sourceMap', map, vscode.ConfigurationTarget.Workspace);
  for (const cmd of guestlinux.substituteCommands({ [m.from]: m.to })) await s.customRequest('evaluate', guestlinux.evaluateArgs(cmd));
  const ed = await vscode.window.showTextDocument(vscode.Uri.file(m.file), { preview: true, preserveFocus: false });
  const line = Math.max(0, (missing.line || 1) - 1);
  ed.selection = new vscode.Selection(line, 0, line, 0);
  ed.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenter);
  vscode.window.showInformationMessage(`Kernel sources: ${m.from} is now read from ${m.to}. The next stop shows the source in the editor; the mapping is saved in the workspace settings (vpStudio.debug.sourceMap) and applied at every attach.`);
}

/** The guest kernel's log (printk ring buffer), read through the debugger, in an editor. */
async function cmdShowKernelLog() {
  if (!guestTree.session) { vscode.window.showWarningMessage('Attach the debugger to the target first ("VP: attach to target software").'); return; }
  if (!guestTree.stopped) { vscode.window.showWarningMessage('Pause the target in the debugger first: the kernel log is read from guest memory while it is stopped.'); return; }
  const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Reading the guest kernel log' }, () => guestTree.mi('-vp-dmesg'));
  const text = guestlinux.formatDmesg(r);
  const textDoc = await vscode.workspace.openTextDocument({ content: text || '(the kernel log is empty)\n', language: 'log' });
  await vscode.window.showTextDocument(textDoc, { preview: false });
}

/** Debug configurations of the CDT adapter get the Linux script (vpStudio.debug.linuxAwareness). */
const linuxConfigProvider = {
  resolveDebugConfigurationWithSubstitutedVariables(folder, config) {
    if (config.type !== DEBUG_TYPE) return config;
    // Kernel sources built elsewhere (Map Kernel Sources…), then the Linux script.
    const mapped = guestlinux.withSourceMap(config, cfg().get('debug.sourceMap'));
    if (cfg().get('debug.linuxAwareness') === false) return mapped;
    return guestlinux.withLinuxAwareness(mapped, linuxScript());
  },
};

class ParamTree {
  constructor() {
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
    this.roots = [];
    this.message = undefined;
  }
  clear() { this.roots = []; this.emitter.fire(); }
  async load() {
    if (!agent) return this.clear();
    try {
      const res = await agent.request('cci.listParams', {}, { timeoutMs: 30000 });
      this.roots = simagent.buildParamTree(res.params || []);
    } catch (e) {
      this.roots = [];
      vscode.window.setStatusBarMessage(`VP Studio: could not read parameters (${e.message})`, 10000);
    }
    this.emitter.fire();
  }
  getChildren(node) { return node ? node.children || [] : this.roots; }
  getTreeItem(node) {
    if (!node.param) {
      const item = new vscode.TreeItem(node.label,
        this.roots.length === 1 && node === this.roots[0] ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
      item.iconPath = new vscode.ThemeIcon('symbol-namespace');
      item.tooltip = node.path;
      item.id = 'o:' + node.path;
      return item;
    }
    const p = node.param;
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
    item.id = 'p:' + node.path;
    item.description = simagent.formatValue(p.value);
    item.iconPath = new vscode.ThemeIcon(p.isPreset ? 'symbol-property' : 'symbol-variable');
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${p.name}**\n\n`);
    md.appendCodeblock(JSON.stringify(p.value, null, 2) || 'null', 'json');
    md.appendMarkdown(`\n\`${p.type}\`${p.isPreset ? ' · set by the configuration' : p.isDefault ? ' · default' : ' · changed'}\n\n`);
    if (p.description) md.appendText(p.description);
    const ro = simagent.readOnlyReason(p);
    md.appendMarkdown(ro ? `\n\n*Read-only: ${ro}.*` : '\n\n*Set Value… changes it in the running simulation.*');
    item.tooltip = md;
    item.contextValue = ro ? 'vpParamReadOnly' : 'vpParam';
    return item;
  }
}

/**
 * Set a parameter of the running simulation, then offer to write the same
 * value into the platform description so the next start uses it.
 */
async function cmdSetParam(node) {
  if (!node || !node.param) return;
  if (!agent) { vscode.window.showWarningMessage('Not connected to a simulation.'); return; }
  const p = node.param;
  const ro = simagent.readOnlyReason(p);
  if (ro) { vscode.window.showWarningMessage(`${p.name} cannot be set while the simulation runs: ${ro}.`); return; }
  const hint = p.category === 'string' ? 'Text, without quotes' : p.category === 'integer' ? 'Decimal or 0x hex'
    : p.category === 'bool' ? 'true or false' : p.category === 'real' ? 'A number' : 'JSON';
  const text = await vscode.window.showInputBox({
    title: `Set ${p.name}`,
    prompt: `${p.type} · now ${simagent.formatValue(p.value)} · ${hint}`,
    value: simagent.paramInputText(p),
    validateInput: (t) => simagent.parseParamValue(t, p).error,
  });
  if (text === undefined) return;
  const { json } = simagent.parseParamValue(text, p);
  let res;
  try {
    res = await agent.request('cci.setParam', { name: p.name, valueJson: json });
  } catch (e) {
    const why = e.code === -32004 && /conversion/.test(e.message) ? `${p.type} does not accept ${json}`
      : e.code === -32601 ? 'this sim agent is older than 0.3.0 and cannot set parameters; rebuild it with tools/sim-agent/build.sh' : e.message;
    vscode.window.showErrorMessage(`Could not set ${p.name}: ${why}.`);
    return;
  }
  node.param = res;
  paramTree.emitter.fire(node);
  // Only offer to save what maps to a parameter the platform can hold.
  let target;
  let why = runningPlatform ? '' : ' It cannot be saved in the platform: this simulation was not started from VP Studio, so its platform file is unknown.';
  if (runningPlatform) {
    try {
      const doc = JSON.parse((await vscode.workspace.openTextDocument(runningPlatform)).getText());
      const t = params.runtimeTarget(doc, core.analyze(doc), p.name);
      if (t && t.platform) {
        target = t;
      } else if (t) {
        const row = params.findRow(params.moduleForms(doc, core.analyze(doc), catalog()), t.base, t.name, t.index);
        if (row && !row.lua) target = t;
        else why = row ? ` It cannot be saved in the platform: ${t.instance}.${t.name} is a Lua expression there.` : ` It cannot be saved in the platform: the component catalog does not list ${t.name} for ${t.instance}.`;
      } else {
        why = ` It cannot be saved in the platform: ${p.name} does not belong to a module of ${path.basename(runningPlatform.fsPath)}.`;
      }
    } catch (e) { why = ' It cannot be saved in the platform right now: the platform file is not valid JSON.'; }
  }
  const msg = `${p.name} = ${simagent.formatValue(res.value)}. When a model uses the new value is up to the model: many read their parameters only at start, so it may only take effect after a restart.${why}`;
  const pick = await vscode.window.showInformationMessage(msg, ...(target ? ['Save in Platform'] : []));
  if (pick !== 'Save in Platform') return;
  try {
    const value = p.category === 'integer' ? params.schemaValue(BigInt(json)) : JSON.parse(json);
    if (target.platform) {
      await editPlatform(runningPlatform, (t) => params.setPlatformParamEdit(t, target.name, value));
      vscode.window.showInformationMessage(`Saved ${target.name} = ${JSON.stringify(value)} in "platform" → "params" of ${path.basename(runningPlatform.fsPath)} (not saved to disk yet).`);
      return;
    }
    await editPlatform(runningPlatform, (t) => params.setParamEdit(t, target.base, target.name, value, target.index));
    vscode.window.showInformationMessage(`Saved ${target.name} = ${JSON.stringify(value)} for ${target.index === null ? target.base : target.instance} in ${path.basename(runningPlatform.fsPath)} (not saved to disk yet).`);
  } catch (e) {
    vscode.window.showErrorMessage(`Could not save it in the platform: ${e.message}`);
  }
}

async function cmdCopyParam(node) {
  if (node && node.param) await vscode.env.clipboard.writeText(`${node.param.name} = ${JSON.stringify(node.param.value)}`);
}

function setRunning(running, detail) {
  setCtx('vpStudio.running', running);
  statusItem.text = running ? `$(debug-stop) VP running${detail ? ' (' + detail + ')' : ''}` : '$(play) VP';
  statusItem.tooltip = running ? 'Stop the simulation' : 'Start the simulation';
  statusItem.command = running ? 'vpStudio.stop' : 'vpStudio.start';
  statusItem.show();
}

async function cmdShowPlatform(arg, place = {}) {
  const uri = await pickPlatform(arg);
  if (!uri) return;
  const key = uri.toString();
  let panel = panels.get(key);
  if (!panel) {
    // Full width by default (module list, diagram and inspector side by side);
    // vpStudio.platformView.openBeside puts it next to the JSON instead.
    const beside = vscode.workspace.getConfiguration('vpStudio').get('platformView.openBeside', false);
    panel = vscode.window.createWebviewPanel('vpStudio.platform', `Platform: ${path.basename(uri.fsPath, SUFFIX)}`,
      { viewColumn: place.column || (beside ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active), preserveFocus: !!place.preserveFocus },
      { enableScripts: true, retainContextWhenHidden: false });
    panels.set(key, panel);
    panel.onDidDispose(() => { panels.delete(key); txWatch.delete(key); });
    // Hidden, the page is gone (no retained context); it asks again when shown.
    panel.onDidChangeViewState(() => { if (!panel.visible) txWatch.delete(key); });
    panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg && msg.type !== 'reveal') {
        const reply = (m) => panel.webview.postMessage(m);
        try { await handleFormMessage(uri, msg, reply); } catch (e) { vscode.window.showErrorMessage(`Could not update the platform: ${e.message}`); }
        return;
      }
      if (msg && msg.type === 'reveal') {
        const textDoc = await vscode.workspace.openTextDocument(uri);
        const range = locate(textDoc, msg.module);
        // Where the JSON already shows, else beside the view (never on top of it), so both stay in sight.
        const shown = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri.toString() && e.viewColumn !== panel.viewColumn);
        const column = shown ? shown.viewColumn : vscode.ViewColumn.Beside;
        const ed = await vscode.window.showTextDocument(textDoc, { viewColumn: column, preserveFocus: false });
        ed.selection = new vscode.Selection(range.start, range.start);
        ed.revealRange(range, vscode.TextEditorRevealType.InCenter);
      }
    });
  } else {
    panel.reveal(place.column, true);
  }
  await renderPanel(uri, panel);
}

// Subsystems drawn collapsed, per platform file; kept across sessions.
const collapsedState = new Map();
function collapsedFor(uri) {
  const key = uri.toString();
  if (!collapsedState.has(key)) {
    const saved = extContext ? extContext.workspaceState.get('vpStudio.collapsed', {}) : {};
    collapsedState.set(key, new Set(saved[key] || []));
  }
  return collapsedState.get(key);
}
function saveCollapsed(uri) {
  if (!extContext) return;
  const saved = Object.assign({}, extContext.workspaceState.get('vpStudio.collapsed', {}));
  saved[uri.toString()] = [...collapsedFor(uri)];
  extContext.workspaceState.update('vpStudio.collapsed', saved);
}

async function renderPanel(uri, panel) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const textDoc = await vscode.workspace.openTextDocument(uri);
  try {
    const data = JSON.parse(textDoc.getText());
    const analysis = analyzeWithCatalog(data);
    const img = images.collect(data, analysis, path.dirname(uri.fsPath), { catalog: catalog() });
    const forms = params.moduleForms(data, analysis, catalog());
    const select = pendingSelect.get(uri.toString());
    pendingSelect.delete(uri.toString());
    const route = pendingRoute.get(uri.toString());
    pendingRoute.delete(uri.toString());
    const cat = catalog();
    const connections = new Map([...forms.keys()].map((b) => [b, connect.portRows(data, cat, b)]));
    const collapsed = new Set([...collapsedFor(uri)].filter((c) => analysis.instances.some((i) => i.isContainer && i.name === c)));
    panel.webview.html = view.render(data, analysis, nonce, panel.webview.cspSource, img, forms, { select, connections, collapsed, route });
  } catch (e) {
    const safe = String(e.message).replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
    panel.webview.html = `<!DOCTYPE html><html><body><p>Cannot show this platform: ${safe}</p><p>Fix the JSON and save to refresh.</p></body></html>`;
  }
}


// ------------------------------------------------------------------ performance experiments (architecture exploration)

let perfPanel;
let perfLast;      // {kind: 'run', uri} or {kind: 'sweep', file}: what Run Again repeats
let perfShown;     // the message the panel shows, re-sent when it reloads
let perfDir;       // folder of the results shown (Results button)
let perfAbort;     // {aborted, onAbort} of the running experiment or sweep

function showPerfPanel(title) {
  if (perfPanel) {
    perfPanel.title = title;
    perfPanel.reveal(undefined, false);
    return;
  }
  perfPanel = vscode.window.createWebviewPanel('vpStudio.perf', title, vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
  const nonce = crypto.randomBytes(16).toString('hex');
  perfPanel.webview.html = perfview.render(nonce, perfPanel.webview.cspSource, title);
  perfPanel.onDidDispose(() => { perfPanel = undefined; });
  perfPanel.webview.onDidReceiveMessage((m) => perfMessage(m).catch((e) => vscode.window.showErrorMessage(`Performance: ${e.message}`)));
}

const postPerf = (m) => { if (perfPanel) perfPanel.webview.postMessage(m); };

function perfStatus(kind, text, running, warn) {
  perfStatus.last = { type: 'status', kind, text, running: !!running, warn: warn === undefined ? '' : warn };
  postPerf(perfStatus.last);
}

async function perfMessage(m) {
  if (m.type === 'ready') {
    if (perfStatus.last) postPerf(perfStatus.last);
    if (perfShown) postPerf(perfShown);
    return;
  }
  if (m.type !== 'command') return;
  if (m.command === 'stop' && perfAbort) {
    perfAbort.aborted = true;
    if (perfAbort.onAbort) perfAbort.onAbort();
  } else if (m.command === 'rerun' && perfLast) {
    if (perfLast.kind === 'run') await cmdPerfRun(perfLast.uri);
    else await cmdPerfSweep(vscode.Uri.file(perfLast.file));
  } else if (m.command === 'reveal' && perfDir) {
    vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(perfDir));
  } else if (m.command === 'csv' && perfShown) {
    const isSweep = perfShown.type === 'sweep';
    const name = isSweep ? 'results.csv' : `${path.basename(perfShown.file || 'run', '.json')}.csv`;
    const to = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(perfDir || os.homedir(), name)), filters: { CSV: ['csv'] } });
    if (!to) return;
    await fs.promises.writeFile(to.fsPath, isSweep ? perf.resultsCsv(perfShown.results) : perf.runCsv(perfShown.stats));
    vscode.window.showInformationMessage(`Wrote ${to.fsPath}`);
  }
}

/** The simulator for a performance run, or undefined after saying why not (local QBox with perf.so). */
function perfSimulator(uri) {
  if (IS_WINDOWS) { vscode.window.showErrorMessage('Performance experiments run QBox on this machine; VS Code on Windows has no local QBox. Use the vp-run command line on the simulation host (vp-run --perf).'); return undefined; }
  const { cwd, exePath } = simulatorPath(uri);
  if (!fs.existsSync(exePath)) {
    vscode.window.showErrorMessage(`Simulator executable not found: ${exePath}. Build QBox first, or set "vpStudio.executable".`, 'Build QBox')
      .then((x) => x && vscode.commands.executeCommand('vpStudio.buildQbox'));
    return undefined;
  }
  if (!fs.existsSync(path.join(path.dirname(exePath), `${perf.LIBRARY}.so`))) {
    vscode.window.showErrorMessage(`QBox's build (${path.dirname(exePath)}) has no ${perf.LIBRARY}.so, the performance models. They come with VP Studio's QBox patch 0003: run "VP Studio: Build QBox" with the patches applied.`, 'Build QBox')
      .then((x) => x && vscode.commands.executeCommand('vpStudio.buildQbox'));
    return undefined;
  }
  return { cwd, exePath };
}

/** The platform, checked, for a performance run: {data} or undefined. */
async function perfPlatform(uri) {
  const loaded = await load(uri);
  if (!loaded) return undefined;
  if (!perf.isPerfPlatform(loaded.data)) {
    vscode.window.showErrorMessage(`${path.basename(uri.fsPath)} has no performance models (traffic_gen, at_bus, dram_ctrl, perf_stats). See examples/perf in VP Studio, or "VP Studio: Create Performance Example".`);
    return undefined;
  }
  const errors = analyzeWithCatalog(loaded.data).problems.filter((p) => p.severity === 'error');
  if (errors.length) {
    refreshDiagnostics(loaded.textDoc);
    vscode.window.showErrorMessage(`${path.basename(uri.fsPath)} has ${errors.length} error(s). First: ${errors[0].message}`);
    return undefined;
  }
  return loaded;
}

const perfTimeoutMs = () => Math.max(10, Number(cfg().get('perf.timeoutSeconds')) || 600) * 1000;

async function cmdPerfRun(arg) {
  if (perfAbort) { vscode.window.showWarningMessage('A performance run is going on; stop it in the Performance panel first.'); return; }
  const uri = await pickPlatform(arg);
  if (!uri) return;
  const sim = perfSimulator(uri);
  if (!sim) return;
  const loaded = await perfPlatform(uri);
  if (!loaded) return;
  const name = path.basename(uri.fsPath, SUFFIX);
  const outDir = path.join(path.dirname(uri.fsPath), 'perf-results');
  const outFile = path.join(outDir, `${name}.perf.json`);
  perfLast = { kind: 'run', uri };
  perfDir = outDir;
  showPerfPanel(`Performance: ${name}`);
  perfStatus('live', 'Running', true);
  const ch = outputChannel();
  ch.appendLine(`\n=== Performance run of ${name} (${new Date().toLocaleString()})`);
  perfAbort = { aborted: false };
  let r;
  try {
    r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Performance run: ${name}`, cancellable: true }, (progress, token) => {
      token.onCancellationRequested(() => { perfAbort.aborted = true; if (perfAbort.onAbort) perfAbort.onAbort(); });
      return perf.runExperiment({
        doc: loaded.data, platformFile: uri.fsPath, exe: sim.exePath, cwd: sim.cwd, outFile, timeoutMs: perfTimeoutMs(), signal: perfAbort,
        generateOptions: { libraries: models.libraries(catalog()) }, onOutput: (t) => ch.append(t),
      });
    });
  } finally {
    const aborted = perfAbort.aborted;
    perfAbort = undefined;
    if (aborted) { perfStatus('idle', 'Stopped', false); return; }
  }
  if (r.stats) {
    perfShown = { type: 'run', summary: perf.summary(r.stats), stats: r.stats, platform: path.basename(uri.fsPath), file: outFile };
    postPerf(perfShown);
  }
  if (r.ok) {
    perfStatus('good', `Done in ${r.seconds.toFixed(1)} s`, false);
  } else {
    perfStatus('bad', 'Failed', false, r.error);
    vscode.window.showErrorMessage(`Performance run failed: ${r.error}`, 'Show Output').then((x) => x && ch.show(true));
  }
}

/** The sweep file to run: the argument, the active editor, or one picked from the workspace. */
async function pickSweep(arg) {
  if (arg instanceof vscode.Uri && arg.fsPath.endsWith(perf.SWEEP_SUFFIX)) return arg;
  const ed = vscode.window.activeTextEditor;
  if (ed && ed.document.uri.fsPath.endsWith(perf.SWEEP_SUFFIX)) {
    if (ed.document.isDirty) await ed.document.save();
    return ed.document.uri;
  }
  const found = await vscode.workspace.findFiles('**/*' + perf.SWEEP_SUFFIX, '**/node_modules/**', 100);
  if (!found.length) {
    const x = await vscode.window.showWarningMessage(`No *${perf.SWEEP_SUFFIX} file in this workspace.`, 'New Performance Sweep…');
    if (x) vscode.commands.executeCommand('vpStudio.perf.newSweep');
    return undefined;
  }
  if (found.length === 1) return found[0];
  const pick = await vscode.window.showQuickPick(found.map((u) => ({ label: path.basename(u.fsPath), description: vscode.workspace.asRelativePath(u), uri: u })), { placeHolder: 'Select a performance sweep' });
  return pick && pick.uri;
}

async function cmdPerfSweep(arg) {
  if (perfAbort) { vscode.window.showWarningMessage('A performance run is going on; stop it in the Performance panel first.'); return; }
  const file = await pickSweep(arg);
  if (!file) return;
  let spec, platformFile, doc;
  try {
    ({ spec, platformFile, doc } = perf.loadSweep(file.fsPath));
  } catch (e) {
    vscode.window.showErrorMessage(`Cannot read the sweep: ${e.message}`);
    return;
  }
  const problems = perf.checkSweep(spec, doc);
  if (problems.length) { vscode.window.showErrorMessage(`${path.basename(file.fsPath)}: ${problems[0]}${problems.length > 1 ? ` (and ${problems.length - 1} more)` : ''}`); return; }
  const puri = vscode.Uri.file(platformFile);
  const sim = perfSimulator(puri);
  if (!sim) return;
  const loaded = await perfPlatform(puri);
  if (!loaded) return;
  const total = perf.runCount(spec);
  const outDir = perf.resultsDir(file.fsPath);
  perfLast = { kind: 'sweep', file: file.fsPath };
  perfDir = outDir;
  const name = path.basename(file.fsPath, perf.SWEEP_SUFFIX);
  showPerfPanel(`Performance: ${name}`);
  perfStatus('live', `Running 0 of ${total}`, true);
  const ch = outputChannel();
  ch.appendLine(`\n=== Performance sweep ${name}: ${total} runs into ${outDir}`);
  perfAbort = { aborted: false };
  let results;
  try {
    results = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Performance sweep: ${name}`, cancellable: true }, (progress, token) => {
      token.onCancellationRequested(() => { perfAbort.aborted = true; if (perfAbort.onAbort) perfAbort.onAbort(); });
      return perf.runSweep({
        spec, doc: loaded.data, platformFile, exe: sim.exePath, cwd: sim.cwd, outDir, specFile: file.fsPath, signal: perfAbort,
        jobs: Number(cfg().get('perf.jobs')) || undefined,
        timeoutMs: perfTimeoutMs(),
        generateOptions: { libraries: models.libraries(catalog()) },
        onProgress: ({ done, run }) => {
          progress.report({ increment: 100 / total, message: `${done} of ${total}` });
          perfStatus('live', `Running ${done} of ${total}`, true);
          ch.appendLine(`run ${run.index} (${run.label}): ${run.ok ? `ok, ${run.seconds.toFixed(1)} s` : run.error}`);
        },
      });
    });
  } finally {
    perfAbort = undefined;
  }
  perfShown = { type: 'sweep', results };
  postPerf(perfShown);
  const failedRuns = results.runs.filter((r) => !r.ok).length;
  const failedChecks = results.checkResults.filter((c) => !c.ok).length;
  const warn = [failedRuns ? `${failedRuns} run(s) failed (see the table and the VP Studio output)` : '', failedChecks ? `${failedChecks} check(s) failed` : ''].filter(Boolean).join('; ');
  perfStatus(results.cancelled ? 'idle' : warn ? 'warn' : 'good', results.cancelled ? `Stopped after ${results.runs.length} of ${total}` : `${results.runs.length} runs done`, false, warn);
}

async function cmdPerfNewSweep(arg) {
  const uri = await pickPlatform(arg);
  if (!uri) return;
  const loaded = await load(uri);
  if (!loaded) return;
  if (!perf.isPerfPlatform(loaded.data)) { vscode.window.showErrorMessage(`${path.basename(uri.fsPath)} has no performance models (traffic_gen, at_bus, dram_ctrl).`); return; }
  const base = path.basename(uri.fsPath, SUFFIX);
  let file = path.join(path.dirname(uri.fsPath), `${base}${perf.SWEEP_SUFFIX}`);
  for (let n = 2; fs.existsSync(file); n++) file = path.join(path.dirname(uri.fsPath), `${base}-${n}${perf.SWEEP_SUFFIX}`);
  const spec = perf.sweepTemplate(loaded.data, path.basename(uri.fsPath));
  await fs.promises.writeFile(file, JSON.stringify(spec, null, 2) + '\n');
  await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
  vscode.window.showInformationMessage('Edit the parameters and values to sweep, the metrics to plot and any checks, then run "VP Studio: Run Performance Sweep".');
}

async function cmdPerfOpen(arg) {
  let file = arg instanceof vscode.Uri ? arg.fsPath : undefined;
  if (!file) {
    const pick = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'Performance results': ['json'] }, openLabel: 'Open Results' });
    if (!pick || !pick.length) return;
    file = pick[0].fsPath;
  }
  const j = JSON.parse(await fs.promises.readFile(file, 'utf8'));
  perfDir = path.dirname(file);
  if (j && j.format === 'vp-perf-sweep') {
    perfLast = undefined;
    showPerfPanel(`Performance: ${path.basename(path.dirname(file))}`);
    perfShown = { type: 'sweep', results: j };
    perfStatus('idle', 'Saved results', false);
  } else {
    const stats = perf.parseStats(JSON.stringify(j));
    perfLast = undefined;
    showPerfPanel(`Performance: ${path.basename(file, '.json')}`);
    perfShown = { type: 'run', summary: perf.summary(stats), stats, file };
    perfStatus('idle', 'Saved results', false);
  }
  postPerf(perfShown);
}

// ------------------------------------------------------------------ software images form

/** Apply one text edit computed from the current document text and parsed data. */
async function editPlatform(uri, makeEdit) {
  const textDoc = await vscode.workspace.openTextDocument(uri);
  const text = textDoc.getText();
  const edit = makeEdit(text, JSON.parse(text));
  if (!edit) return;
  const we = new vscode.WorkspaceEdit();
  we.replace(uri, new vscode.Range(textDoc.positionAt(edit.start), textDoc.positionAt(edit.end)), edit.text);
  if (!(await vscode.workspace.applyEdit(we))) throw new Error('the editor rejected the change');
}

async function pickFile(uri, title, elfOnly) {
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false, title, defaultUri: vscode.Uri.file(path.dirname(uri.fsPath)),
    filters: elfOnly ? { 'ELF files': ['elf', 'axf', 'out', '*'] } : { 'Images': ['bin', 'elf', 'img', 'dtb', 'axf', '*'] },
  });
  return picked && picked[0] ? picked[0].fsPath : undefined;
}

const entriesEdit = (text, moduleName, entries) =>
  jsonedit.setProperty(text, core.jsonPath(moduleName), 'entries', (ind) => jsonedit.renderRows(entries, ind));

function rowsFromEntries(entries) {
  return entries.map((e, orig) => {
    const kind = images.kindOf(e);
    return { orig, kind, file: kind === 'bin' ? e.bin_file : e.elf_file, address: typeof e.address === 'string' || typeof e.address === 'number' ? String(e.address) : '' };
  });
}

// ------------------------------------------------------------------ add and delete modules

/** container: where to add ('' for the top level); undefined asks when the platform has subsystems. */
async function cmdAddModule(arg, container) {
  const uri = await pickPlatform(arg);
  if (!uri) return;
  const cat = catalog();
  if (!cat) {
    vscode.window.showWarningMessage('Adding a module needs the component catalog, which is turned off ("vpStudio.catalog").');
    return;
  }
  const loaded = await load(uri);
  if (!loaded) return;
  const data = loaded.data;
  const analysis = core.analyze(data);
  const typeOf = new Map(analysis.instances.map((i) => [i.name, i.type]));
  if (container === undefined) {
    const where = modules.containerChoices(data);
    if (where.length > 1) {
      const sel = await vscode.window.showQuickPick(where.map((c) => ({ label: c || '(top level)', description: c ? 'subsystem' : '', c })),
        { title: 'Add Module', placeHolder: 'Where should the new module go?' });
      if (!sel) return;
      container = sel.c;
    } else container = '';
  }
  const SUBSYSTEM = '$(folder) Subsystem';
  const choices = [{ label: SUBSYSTEM, description: 'a Container holding other modules', type: 'Container', subsystem: true }]
    .concat(modules.typeChoices(cat).map((c) => ({ label: c.type, description: c.summary, detail: c.source, type: c.type })));

  const pick = await vscode.window.showQuickPick(
    choices,
    { title: container ? `Add Module to ${container}` : 'Add Module', placeHolder: 'Type of the new module (from the QBox component catalog)', matchOnDescription: true, matchOnDetail: true });
  if (!pick) return;

  const name = await vscode.window.showInputBox({
    title: `Add ${pick.subsystem ? 'subsystem' : pick.type}${container ? ` to ${container}` : ''}`, prompt: 'Name of the new instance',
    value: modules.suggestName(data, analysis, pick.subsystem ? 'subsys' : pick.type, container),
    validateInput: (v) => modules.nameProblem(data, analysis, v.trim(), container) || undefined,
  });
  if (!name) return;
  const inst = name.trim();
  const full = container ? `${container}.${inst}` : inst;
  if (pick.subsystem) {
    pendingSelect.set(uri.toString(), full);
    await editPlatform(uri, (text, fresh) => {
      const why = modules.nameProblem(fresh, core.analyze(fresh), inst, container);
      if (why) throw new Error(why);
      return modules.addModuleEdit(text, inst, { type: 'Container', modules: {} }, container);
    });
    if (!panels.get(uri.toString())) await cmdShowPlatform(uri);
    vscode.window.setStatusBarMessage(`VP Studio: added subsystem ${full}. Use "Add module here…" in its panel to fill it.`, 10000);
    return;
  }

  const args = [];
  const specs = modules.argSpecs(cat, pick.type);
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    if (spec.ref) {
      const c = modules.argCandidates(analysis, spec.expects);
      if (!c.names.length) {
        vscode.window.showErrorMessage(`${pick.type} needs a ${spec.expects} as constructor argument, but this platform has no module to pass. Add one first.`);
        return;
      }
      const sel = await vscode.window.showQuickPick(
        c.names.map((n) => ({ label: n, description: typeOf.get(n) })),
        { title: `${full}: ${spec.label}`, placeHolder: c.exact ? `Choose the ${spec.expects} to pass` : `No ${spec.expects} module found; choose the module to pass` });
      if (!sel) return;
      args.push({ ref: sel.label });
    } else {
      const v = await vscode.window.showInputBox({
        title: `${inst}: ${spec.label}`, prompt: `Value passed to the constructor (${spec.decl})`,
        value: modules.existingArg(data, pick.type, i),
      });
      if (v === undefined) return;
      args.push(v);
    }
  }

  pendingSelect.set(uri.toString(), full);
  try {
    await editPlatform(uri, (text, fresh) => {
      const why = modules.nameProblem(fresh, core.analyze(fresh), inst, container);
      if (why) throw new Error(why);
      return modules.addModuleEdit(text, inst, modules.moduleDef(cat, pick.type, args, path.dirname(uri.fsPath)), container);
    });
  } catch (e) {
    pendingSelect.delete(uri.toString());
    throw e;
  }
  const panel = panels.get(uri.toString());
  if (!panel) await cmdShowPlatform(uri);
  const required = (cat.modules[pick.type].requiredParams || []);
  vscode.window.setStatusBarMessage(
    `VP Studio: added ${full} (${pick.type}). Its ports are not connected yet` + (required.length ? `; it needs ${required.join(', ')}.` : '.'), 10000);
}

async function deleteModule(uri, base) {
  const loaded = await load(uri);
  if (!loaded) return;
  const plan = modules.deletePlan(loaded.data, base);
  if (plan.blockers.length) {
    const who = [...new Set(plan.blockers.map((b) => b.module))];
    vscode.window.showErrorMessage(`Cannot delete ${base}`, {
      modal: true,
      detail: `${who.join(', ')} ${who.length > 1 ? 'take' : 'takes'} it as a constructor argument and could not be built without it. Delete or change ${who.length > 1 ? 'those modules' : 'that module'} first.`,
    });
    return;
  }
  const n = plan.bindings.length;
  const list = plan.bindings.slice(0, 12).map((b) => `${b.module}.${b.port} → ${b.bind}`).join('\n');
  const isSub = !!core.modulesOf(loaded.data)[base].container;
  const inside = plan.contents.length ? `It holds ${plan.contents.length} module${plan.contents.length > 1 ? 's' : ''}, deleted with it: ${plan.contents.slice(0, 8).join(', ')}${plan.contents.length > 8 ? ' …' : ''}.\n\n` : '';
  const detail = inside + (n
    ? `This also removes ${n} connection${n > 1 ? 's' : ''} to it from other modules:\n${list}${n > 12 ? `\n… and ${n - 12} more` : ''}\n\nUndo (Ctrl+Z in the JSON file) brings everything back.`
    : `No other module is connected to it.${inside ? ' Undo (Ctrl+Z in the JSON file) brings everything back.' : ''}`);
  const ok = await vscode.window.showWarningMessage(`Delete ${isSub ? 'subsystem' : 'module'} ${base}?`, { modal: true, detail }, 'Delete');
  if (ok !== 'Delete') return;
  await editPlatform(uri, (text, fresh) => {
    const p = modules.deletePlan(fresh, base);
    if (p.blockers.length) throw new Error(`${base} is now used as a constructor argument; nothing was deleted`);
    return modules.minimalEdit(text, modules.deleteModuleText(text, base, p));
  });
}

// ------------------------------------------------------------------ connections

const KIND_TEXT = { tlm_initiator: 'bus initiator', tlm_target: 'bus target', signal_out: 'signal out', signal_in: 'signal in', biflow: 'byte stream' };

function usageText(row) {
  const parts = row.out.map((o) => `→ ${o.bind}`).concat(row.in.map((i) => `← ${i.from}.${i.key}`));
  if (!parts.length) return 'not connected';
  return parts.length > 3 ? `${parts.slice(0, 3).join(', ')} … (${parts.length})` : parts.join(', ');
}

/**
 * Connect a port of module a, asking for whatever is not given: the port, the
 * other module b, its port, the instance and vector index, and the address
 * and size when a mapped socket goes on a bus.
 */
async function connectFlow(uri, a, portA, b) {
  const cat = catalog();
  if (!cat) { vscode.window.showWarningMessage('Connecting ports needs the component catalog, which is turned off ("vpStudio.catalog").'); return; }
  const loaded = await load(uri);
  if (!loaded) return;
  const data = loaded.data;
  const analysis = core.analyze(data);
  const mods = core.modulesOf(data);
  if (!mods[a]) throw new Error(`module ${a} no longer exists`);
  // A subsystem block stands for its modules: ask which one.
  const member = async (c, what) => {
    const inner = Object.keys(mods).filter((n) => n.startsWith(c + '.') && !mods[n].container);
    if (!inner.length) { vscode.window.showWarningMessage(`${c} has no modules to connect yet.`); return undefined; }
    const sel = await vscode.window.showQuickPick(inner.map((n) => ({ label: n, description: mods[n].type })), { title: `Connect: ${what} inside ${c}`, placeHolder: `Which module of ${c}?` });
    return sel && sel.label;
  };
  if (mods[a].container) { a = await member(a, 'module to connect'); if (!a) return; portA = undefined; }
  if (b && mods[b] && mods[b].container) { b = await member(b, 'module to connect to'); if (!b) return; }
  const title = (step) => `Connect ${a}${b ? ` → ${b}` : ''}: ${step}`;

  if (!portA) {
    let rows = connect.portRows(data, cat, a).filter((r) => r.kind);
    if (b) rows = rows.filter((r) => connect.compatiblePorts(cat, mods[b].type, r.kind).length);
    if (!rows.length) {
      vscode.window.showWarningMessage(b ? `No port of ${a} (${mods[a].type}) fits a port of ${b} (${mods[b].type}).` : `The component catalog lists no ports for ${mods[a].type}.`);
      return;
    }
    const sel = await vscode.window.showQuickPick(rows.map((r) => ({
      label: r.name, description: (KIND_TEXT[r.kind] || r.kind) + (r.vector ? ', vector' : ''), detail: usageText(r),
    })), { title: title(`port of ${a}`), placeHolder: `Which port of ${a} (${mods[a].type})?`, matchOnDetail: true });
    if (!sel) return;
    portA = sel.label;
  }
  const pa = connect.portOf(cat, mods[a].type, portA);
  if (!pa) { vscode.window.showWarningMessage(`${mods[a].type} has no port ${portA} in the component catalog.`); return; }

  if (!b) {
    const cands = connect.compatibleModules(data, cat, a, pa.kind);
    if (!cands.length) { vscode.window.showWarningMessage(`No other module has a port that fits ${a}.${pa.name} (${KIND_TEXT[pa.kind] || pa.kind}).`); return; }
    const sel = await vscode.window.showQuickPick(cands.map((n) => ({ label: n, description: mods[n].type })),
      { title: title(`module to connect ${a}.${pa.name} to`), placeHolder: `Modules with a port that fits a ${KIND_TEXT[pa.kind] || pa.kind}` });
    if (!sel) return;
    b = sel.label;
  }
  const pbs = connect.compatiblePorts(cat, mods[b].type, pa.kind);
  if (!pbs.length) { vscode.window.showWarningMessage(`${b} (${mods[b].type}) has no port that fits ${a}.${pa.name} (${KIND_TEXT[pa.kind] || pa.kind}).`); return; }
  let pb = pbs[0];
  if (pbs.length > 1) {
    const rowsB = new Map(connect.portRows(data, cat, b).map((r) => [r.name, r]));
    const sel = await vscode.window.showQuickPick(pbs.map((p) => ({
      label: p.name, description: (KIND_TEXT[p.kind] || p.kind) + (p.vector ? ', vector' : ''), detail: rowsB.has(p.name) ? usageText(rowsB.get(p.name)) : '', port: p,
    })), { title: title(`port of ${b}`), placeHolder: `Which port of ${b} (${mods[b].type})?` });
    if (!sel) return;
    pb = sel.port;
  }

  // The device end writes a binding to a bus; otherwise the end you started from.
  const aEnd = { base: a, port: pa };
  const bEnd = { base: b, port: pb };
  const [D, O] = connect.declaringEnd(data, a, b) === 'a' ? [aEnd, bEnd] : [bEnd, aEnd];
  const dRepl = mods[D.base].count !== undefined;

  const insts = connect.peerInstances(data, analysis, D.base, O.base);
  let oInst = insts[0];
  if (insts.length > 1) {
    const sel = await vscode.window.showQuickPick(insts.map((n) => ({
      label: n, description: n.endsWith('_{i}') ? `each instance of ${D.base} to the ${O.base} instance with the same number` : '',
    })), { title: title(`instance of ${O.base}`), placeHolder: `${O.base} has ${insts.length - (insts[0].endsWith('_{i}') ? 1 : 0)} instances; which one?` });
    if (!sel) return;
    oInst = sel.label;
  }
  const askIndex = async (end) => {
    const v = await vscode.window.showInputBox({
      title: title(`index of ${end.base}.${end.port.name}`),
      prompt: `${end.port.name} is a vector port: which element (${end.port.name}_N)?` + (dRepl ? ' {i} uses the number of each instance.' : ''),
      value: String(connect.nextIndex(data, end.base, end.port.name)),
      validateInput: (x) => connect.indexProblem(x, dRepl) || undefined,
    });
    return v === undefined ? undefined : v.trim();
  };
  let dKey = D.port.name;
  if (D.port.vector) { const i = await askIndex(D); if (i === undefined) return; dKey += `_${i}`; }
  let oPort = O.port.name;
  if (O.port.vector) { const i = await askIndex(O); if (i === undefined) return; oPort += `_${i}`; }

  const entry = {};
  if (connect.needsAddress(data, D.port.kind, O.base)) {
    const address = await vscode.window.showInputBox({
      title: title(`address of ${D.base}.${dKey} on ${O.base}`), prompt: 'Start address on the bus', placeHolder: '0x09000000',
      validateInput: (x) => connect.addressProblem(x) || undefined,
    });
    if (address === undefined) return;
    const size = await vscode.window.showInputBox({
      title: title(`size of ${D.base}.${dKey} on ${O.base}`), prompt: 'Size of the address range', value: '0x1000',
      validateInput: (x) => connect.addressProblem(x) || undefined,
    });
    if (size === undefined) return;
    entry.address = address.trim();
    entry.size = size.trim();
  }
  entry.bind = `${oInst}.${oPort}`;

  const existing = connect.declared(data, D.base).find((x) => x.key === dKey && x.scope === null);
  if (existing && existing.bind !== entry.bind) {
    const ok = await vscode.window.showWarningMessage(`${D.base}.${dKey} is already connected to ${existing.bind}.`,
      { modal: true, detail: `Replace that connection with ${entry.bind}?` }, 'Replace');
    if (ok !== 'Replace') return;
  }
  await editPlatform(uri, (text) => connect.bindEdit(text, D.base, dKey, entry));
  vscode.window.setStatusBarMessage(`VP Studio: connected ${D.base}.${dKey} → ${entry.bind}` + (D.base !== a ? ` (written on ${D.base}, the device end)` : ''), 8000);
}

async function disconnectFlow(uri, module, key, scope) {
  const loaded = await load(uri);
  if (!loaded) return;
  const item = connect.declared(loaded.data, module).find((x) => x.key === key && String(x.scope) === String(scope));
  if (!item) return;
  await editPlatform(uri, (text) => connect.unbindEdit(text, item));
  vscode.window.setStatusBarMessage(`VP Studio: disconnected ${module}.${key} from ${item.bind}. Ctrl+Z in the JSON file undoes it.`, 8000);
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Replace a module's model type, keeping its connections where the new type has the same ports. */
async function swapFlow(uri, base) {
  const loaded = await load(uri);
  if (!loaded) return;
  const cat = catalog();
  const mod = core.modulesOf(loaded.data)[base];
  if (!mod) return;
  const choices = restructure.swapChoices(loaded.data, cat, base);
  const pick = await vscode.window.showQuickPick(choices.map((c) => ({
    label: c.type,
    description: !c.checked ? 'ports unknown, cannot be checked' : c.lost ? `loses ${plural(c.lost, 'connection')}` : c.rename ? `keeps all connections, ${plural(c.rename, 'port')} renamed` : 'keeps all connections',
    detail: c.summary, c,
  })), { title: `Replace ${base} (${mod.type})`, placeHolder: 'New model type; the best fits come first', matchOnDescription: true, matchOnDetail: true });
  if (!pick) return;
  let plan;
  try { plan = restructure.swapPlan(loaded.data, cat, base, pick.label, path.dirname(uri.fsPath)); } catch (e) {
    vscode.window.showErrorMessage(`Cannot replace ${base}: ${e.message}`);
    return;
  }
  const args = plan.args.now.slice();
  for (const a of plan.args.ask) {
    if (a.spec.ref) {
      const sel = await vscode.window.showQuickPick(a.candidates.names.map((n) => ({ label: n })), { title: `${plan.newType}: ${a.spec.label}`, placeHolder: `Module to pass (${a.spec.expects})` });
      if (!sel) return;
      args[a.index] = { ref: sel.label };
    } else {
      const v = await vscode.window.showInputBox({ title: `${plan.newType}: ${a.spec.label}`, prompt: a.spec.decl, ignoreFocusOut: true });
      if (v === undefined) return;
      args[a.index] = v;
    }
  }
  const lines = [];
  if (plan.unchecked) lines.push(`The component catalog cannot look into ${plan.newType}: its ports and parameters are not checked.`);
  if (plan.keep.length) lines.push(`Connections kept: ${plan.keep.join(', ')}`);
  for (const r of plan.rename) lines.push(`Port renamed: ${r.from} → ${r.to} (its connections follow)`);
  for (const l of plan.lost) lines.push(`Removed: ${l.port} (${plural(l.connections, 'connection')}); ${plan.newType} has no such ${l.kind || 'port'}${l.choices.length > 1 ? `, it has ${l.choices.join(', ')}` : ''}`);
  if (plan.dropParams.length) lines.push(`Parameters removed (${plan.newType} does not have them): ${plan.dropParams.map((p) => (p.scope === null ? p.name : `${p.name} (${base}_${p.scope})`)).join(', ')}`);
  const fmtArg = (a) => (a && typeof a === 'object' ? a.ref : JSON.stringify(a));
  if (JSON.stringify(args) !== JSON.stringify(plan.args.old)) lines.push(`Constructor arguments: ${args.length ? args.map(fmtArg).join(', ') : 'none'}`);
  if (plan.dylib.now !== plan.dylib.old) lines.push(`Library (dylib): ${plan.dylib.old || 'none'} → ${plan.dylib.now || 'none'}`);
  const ok = await vscode.window.showWarningMessage(`Replace ${base} (${plan.oldType}) with ${plan.newType}?`,
    { modal: true, detail: `${lines.join('\n')}\n\nCtrl+Z in the JSON file undoes it.` }, 'Replace');
  if (ok !== 'Replace') return;
  pendingSelect.set(uri.toString(), base);
  await editPlatform(uri, (text, data) => modules.minimalEdit(text, restructure.swapText(text, data, plan, args)));
  vscode.window.setStatusBarMessage(`VP Studio: ${base} is now a ${plan.newType}. Ctrl+Z in the JSON file undoes it.`, 8000);
}

/** Group modules of one container into a new subsystem. */
async function groupFlow(uri, bases) {
  const loaded = await load(uri);
  if (!loaded || !bases.length) return;
  const data = loaded.data;
  const flat = core.flatten(data);
  const container = flat.parent[bases[0]];
  if (bases.some((b) => flat.parent[b] !== container)) {
    vscode.window.showWarningMessage('The modules to group must be in the same subsystem, or all at the top level.');
    return;
  }
  const analysis = analyzeWithCatalog(data);
  let suggestion = 'subsystem';
  for (let n = 0; modules.nameProblem(data, analysis, suggestion, container); n++) suggestion = `subsystem_${n}`;
  const name = await vscode.window.showInputBox({
    title: `Group ${plural(bases.length, 'module')} into a subsystem`, prompt: `Name of the new subsystem${container ? ` inside ${container}` : ''}`,
    value: suggestion, ignoreFocusOut: true, validateInput: (v) => modules.nameProblem(data, analysis, v.trim(), container),
  });
  if (!name) return;
  let plan;
  try { plan = restructure.groupPlan(data, bases, name.trim()); } catch (e) {
    vscode.window.showErrorMessage(`Cannot group: ${e.message}`);
    return;
  }
  const w = plan.rewrites;
  const detail = (w.length
    ? `${plural(w.length, 'reference')} from other modules will reach them through ${plan.name}:\n${w.slice(0, 10).map((x) => `${x.module}: ${x.from} → ${x.to}`).join('\n')}${w.length > 10 ? `\n… and ${w.length - 10} more` : ''}`
    : 'No other module refers to them, so nothing else changes.') + '\n\nEvery connection stays the same. Ctrl+Z in the JSON file undoes it.';
  const ok = await vscode.window.showInformationMessage(`Group ${bases.join(', ')} into the subsystem ${plan.path}?`, { modal: true, detail }, 'Group');
  if (ok !== 'Group') return;
  pendingSelect.set(uri.toString(), plan.path);
  await editPlatform(uri, (text) => modules.minimalEdit(text, restructure.groupText(text, plan)));
  vscode.window.setStatusBarMessage(`VP Studio: grouped ${plural(bases.length, 'module')} into ${plan.path}. Ctrl+Z in the JSON file undoes it.`, 8000);
}

async function handleFormMessage(uri, msg, reply) {
  const topDir = path.dirname(uri.fsPath);
  switch (msg.type) {
    case 'command': {
      // Buttons in the view's header; only these commands, always for this platform.
      const commands = { generate: 'vpStudio.generate', start: 'vpStudio.start', startTrace: 'vpStudio.startTrace', trace: 'vpStudio.showTrace', probes: 'vpStudio.chooseProbes' };
      return commands[msg.command] ? vscode.commands.executeCommand(commands[msg.command], uri) : undefined;
    }
    case 'txWatch': {
      // The Transactions tab opened (or closed): records of the running platform go to it.
      const key = uri.toString();
      if (!msg.on) { txWatch.delete(key); return undefined; }
      txWatch.add(key);
      reply(txState(key));
      if (runningPlatform && runningPlatform.toString() === key) reply({ type: 'tx', records: traceRecords.slice(-5000), reset: true });
      traceConnected();
      return undefined;
    }
    case 'swapModule':
      return swapFlow(uri, String(msg.module));
    case 'groupModules':
      return groupFlow(uri, Array.isArray(msg.modules) ? msg.modules.map(String) : []);
    case 'deviceTree': {
      const m = await deviceTreePane(uri, String(msg.against || 'auto'));
      return m ? reply(m) : undefined;
    }
    case 'deviceTreeWrite': {
      const loaded = await load(uri);
      if (!loaded) return undefined;
      try {
        const r = await deviceTreeFor(uri, loaded.data);
        vscode.window.setStatusBarMessage(`VP Studio: wrote ${vscode.workspace.asRelativePath(r.dts)} and ${path.basename(r.dtb)}`, 8000);
      } catch (e) {
        vscode.window.showErrorMessage(`Device tree not generated: ${e.message}`);
      }
      const m = await deviceTreePane(uri, String(msg.against || 'auto'));
      return m ? reply(m) : undefined;
    }
    case 'addModule':
      return cmdAddModule(uri, typeof msg.container === 'string' && msg.container ? msg.container : undefined);
    case 'toggleSubsystem': {
      const set = collapsedFor(uri);
      const m = String(msg.module);
      if (set.has(m)) set.delete(m); else set.add(m);
      saveCollapsed(uri);
      pendingSelect.set(uri.toString(), m);
      const panel = panels.get(uri.toString());
      return panel ? renderPanel(uri, panel) : undefined;
    }
    case 'deleteModule':
      return deleteModule(uri, String(msg.module));
    case 'connect':
      return connectFlow(uri, String(msg.module), msg.port ? String(msg.port) : undefined, msg.peer ? String(msg.peer) : undefined);
    case 'disconnect':
      return disconnectFlow(uri, String(msg.module), String(msg.key), msg.scope === null || msg.scope === undefined ? null : String(msg.scope));
    case 'setParam':
    case 'resetParam': {
      const name = String(msg.name);
      const module = String(msg.module);
      const index = msg.index === null || msg.index === undefined ? null : String(msg.index);
      return editPlatform(uri, (text, data) => {
        if (msg.type === 'resetParam') return params.resetParamEdit(text, module, name, index);
        // The input kind comes from the form row built here, not from the webview.
        const row = params.findRow(params.moduleForms(data, core.analyze(data), catalog()), module, name, index);
        if (!row && index !== null) throw new Error(`${module} has no instance ${index}`);
        if (row && row.locked) { reply({ type: 'paramError', module, index, name, message: row.locked }); return undefined; }
        const r = params.parseInput(msg.input, row ? row.kind : 'json');
        if (r.error) { reply({ type: 'paramError', module, index, name, message: r.error }); return undefined; }
        if (r.reset) return params.resetParamEdit(text, module, name, index);
        if (row && row.set && JSON.stringify(row.value) === JSON.stringify(r.value)) return undefined;
        return params.setParamEdit(text, module, name, r.value, index);
      });
    }
    case 'setImages':
      return editPlatform(uri, (text, data) => {
        const mod = core.modulesOf(data)[msg.module];
        if (!mod) throw new Error(`module ${msg.module} no longer exists`);
        return entriesEdit(text, msg.module, images.rebuildEntries(mod.entries || [], msg.rows));
      });
    case 'browseImage':
    case 'addImage': {
      const file = await pickFile(uri, msg.type === 'addImage' ? 'Select an image to load into memory' : 'Select the image file', false);
      if (!file) return undefined;
      const kind = images.isElf(file) ? 'elf' : 'bin';
      return editPlatform(uri, (text, data) => {
        const mod = core.modulesOf(data)[msg.module];
        if (!mod) throw new Error(`module ${msg.module} no longer exists`);
        const old = mod.entries || [];
        const rows = rowsFromEntries(old);
        const fallback = images.collect(data, core.analyze(data), topDir).defaultAddress;
        const row = { orig: null, kind, file: images.toTemplate(file, topDir), address: fallback };
        if (msg.type === 'addImage') {
          rows.push(row);
        } else {
          const cur = rows[msg.index];
          if (!cur || cur.kind === 'raw') throw new Error('that entry cannot be changed here');
          rows[msg.index] = Object.assign(row, { orig: msg.index, address: cur.address || fallback });
        }
        return entriesEdit(text, msg.module, images.rebuildEntries(old, rows));
      });
    }
    case 'addLoader':
      return editPlatform(uri, (text, data) => {
        const bus = core.analyze(data).routers[0];
        if (!bus) throw new Error('the platform has no router to attach a loader to');
        let name = 'load';
        for (let n = 1; core.modulesOf(data)[name]; n++) name = `load_${n}`;
        return jsonedit.setProperty(text, ['modules'], name, (ind) => {
          const s = '  ';
          return `{\n${ind}${s}"type": "loader",\n${ind}${s}"ports": {\n${ind}${s}${s}"initiator_socket": { "bind": "${bus}.target_socket" }\n${ind}${s}},\n${ind}${s}"entries": []\n${ind}}`;
        });
      });
    case 'browseSymbols': {
      const file = await pickFile(uri, 'Select an ELF file with debug symbols (for example vmlinux)', true);
      if (!file) return undefined;
      if (!images.isElf(file)) {
        vscode.window.showWarningMessage(`${path.basename(file)} is not an ELF file, so a debugger cannot read symbols from it.`);
        return undefined;
      }
      const value = JSON.stringify([images.toTemplate(file, topDir)]);
      return editPlatform(uri, (text, data) => (data.debug && typeof data.debug === 'object'
        ? jsonedit.setProperty(text, ['debug'], 'symbols', () => value)
        : jsonedit.setProperty(text, [], 'debug', () => `{ "symbols": ${value} }`)));
    }
    case 'clearSymbols':
      return editPlatform(uri, (text) => jsonedit.removeProperty(text, [], 'debug'));
    default:
      return undefined;
  }
}

/** Symbol files for the debugger: explicit debug.symbols first, then loaded ELF images. */
async function symbolFilesFor(uri) {
  try {
    const textDoc = await vscode.workspace.openTextDocument(uri);
    const data = JSON.parse(textDoc.getText());
    return images.collect(data, core.analyze(data), path.dirname(uri.fsPath)).symbolFiles;
  } catch (e) { return []; }
}

const GDB_ARGUMENTS = ['-q', '-iex', 'set pagination off'];

async function cmdAddDebugConfigs(arg) {
  const folder = (vscode.workspace.workspaceFolders || [])[0];
  if (!folder) { vscode.window.showWarningMessage('Open a folder first.'); return; }
  const c = cfg();
  const found = arg instanceof vscode.Uri ? [arg] : await vscode.workspace.findFiles('**/*' + SUFFIX, '**/node_modules/**', 2);
  const active = vscode.window.activeTextEditor;
  const platformUri = active && isPlatform(active.document) ? active.document.uri : found.length === 1 ? found[0] : undefined;
  const symbols = platformUri ? await symbolFilesFor(platformUri) : [];
  // Without a symbol file, leave "program" out: the CDT adapter aborts the
  // attach when "program" names a file that does not exist, and gdb works
  // without symbols (registers, memory, disassembly; QEMU describes the CPU).
  const target = {
    name: 'VP: attach to target software', type: 'gdbtarget', request: 'attach',
    gdb: c.get('debug.targetGdb'),
    // 127.0.0.1, not localhost: the SSH forward of a remote simulation listens on
    // IPv4 only, and Windows resolves localhost to ::1 first.
    target: { host: IS_WINDOWS ? '127.0.0.1' : 'localhost', port: String(c.get('debug.gdbPort')) },
  };
  // A real gdb console in a terminal: in the Debug Console, gdb commands need a
  // leading ">" (CDT's rule), which looks like the console's own "›" prompt and
  // confused users. Not on Windows, where CDT does not support it.
  if (process.platform !== 'win32') target.openGdbConsole = true;
  // Ubuntu's gdb asks "Enable debuginfod for this session? (y or [n])" when it
  // loads symbols if DEBUGINFOD_URLS is set, and the attach waits for the
  // answer (2026-11-15). The symbols are local, so turn debuginfod off for gdb.
  // An empty value, not null: with openGdbConsole CDT deletes a null key from its
  // copy of the environment and sends the rest to runInTerminal, whose env is
  // merged over the terminal's own, so the variable came back. gdb treats an
  // empty DEBUGINFOD_URLS as unset (checked with gdb 15.1).
  target.environment = { DEBUGINFOD_URLS: '' };
  // In a short terminal panel gdb stops at "--Type <RET> for more" while it
  // prints its banner and the attach waits there (2026-11-15). -q drops the
  // banner; -iex turns paging off before anything is loaded.
  target.gdbArguments = GDB_ARGUMENTS.slice();
  if (symbols[0]) target.program = symbols[0];
  if (symbols.length > 1) target.initCommands = symbols.slice(1).map((f) => `add-symbol-file ${JSON.stringify(f)}`);
  // Attaching to the simulator process (to debug SystemC models) needs it on
  // this machine: not on Windows, where it runs on the simulation host.
  const wanted = IS_WINDOWS ? [target] : [
    target,
    {
      name: 'VP: attach to simulator process (models)', type: 'gdb', request: 'attach',
      program: '${workspaceFolder}/' + c.get('executable'), processId: '${input:vpStudioPid}',
    },
  ];
  const input = { id: 'vpStudioPid', type: 'promptString', description: 'Process id of the simulator (pgrep platforms-vp)' };
  const launch = vscode.workspace.getConfiguration('launch', folder.uri);
  const configs = (launch.get('configurations') || []).slice();
  const inputs = (launch.get('inputs') || []).slice();
  let added = 0;
  let relinked = false;
  for (const w of wanted) {
    const at = configs.findIndex((x) => x.name === w.name);
    if (at < 0) { configs.push(w); added++; continue; }
    // Keep the user's edits, but follow the platform's symbol file when it has one,
    // and drop the placeholder path older versions wrote.
    if (w === target && symbols.length && configs[at].program !== w.program) {
      configs[at] = Object.assign({}, configs[at], { program: w.program }, w.initCommands ? { initCommands: w.initCommands } : {});
      relinked = true;
    } else if (w === target && !symbols.length && /\/path\/to\/vmlinux$/.test(configs[at].program || '')) {
      configs[at] = Object.assign({}, configs[at]);
      delete configs[at].program;
      relinked = true;
    }
    // Configurations from older versions get the gdb console and the debuginfod
    // setting, unless the user set them.
    if (w === target && w.openGdbConsole && configs[at].openGdbConsole === undefined) {
      configs[at] = Object.assign({}, configs[at], { openGdbConsole: true });
      relinked = true;
    }
    if (w === target && configs[at].gdbArguments === undefined) {
      configs[at] = Object.assign({}, configs[at], { gdbArguments: GDB_ARGUMENTS.slice() });
      relinked = true;
    }
    // null is what earlier versions wrote; it does not work with the gdb console.
    const env = configs[at].environment;
    if (w === target && (env === undefined || env === null)) {
      configs[at] = Object.assign({}, configs[at], { environment: { DEBUGINFOD_URLS: '' } });
      relinked = true;
    } else if (w === target && typeof env === 'object' && (!('DEBUGINFOD_URLS' in env) || env.DEBUGINFOD_URLS === null)) {
      configs[at] = Object.assign({}, configs[at], { environment: Object.assign({}, env, { DEBUGINFOD_URLS: '' }) });
      relinked = true;
    }
  }
  if (!IS_WINDOWS && !inputs.some((x) => x.id === input.id)) inputs.push(input);
  await launch.update('configurations', configs, vscode.ConfigurationTarget.WorkspaceFolder);
  await launch.update('inputs', inputs, vscode.ConfigurationTarget.WorkspaceFolder);
  const sym = symbols.length
    ? `Target symbols: ${path.basename(symbols[0])}.`
    : 'No symbol file is set for this platform, so the debugger shows registers, memory and disassembly only. For source-level debugging choose one (for example vmlinux) under "Software images" in the platform view and run this command again.';
  vscode.window.showInformationMessage(
    (added ? `Added ${added} debug configuration(s) to launch.json. ` : relinked ? 'Updated the target debug configuration. ' : 'The debug configurations are already in launch.json. ') +
    sym + (target.openGdbConsole ? ' Type gdb commands (info threads, x/4i $pc) in the "gdb" terminal that opens with the debug session.' : '') +
    (added ? ' They need the CDT GDB Debug Adapter extension.' : ''));
}

async function cmdCreateExample(context) {
  const folder = (vscode.workspace.workspaceFolders || [])[0];
  if (!folder) { vscode.window.showWarningMessage('Open the QBox source folder first.'); return; }
  const def = vscode.Uri.joinPath(folder.uri, 'platforms', 'ubuntu', 'ubuntu-aarch64' + SUFFIX);
  const target = await vscode.window.showSaveDialog({ defaultUri: def, filters: { 'Platform description': ['json'] },
    title: 'Save next to the firmware folder the platform refers to' });
  if (!target) return;
  const src = path.join(context.extensionPath, 'examples', 'ubuntu-aarch64' + SUFFIX);
  const data = JSON.parse(await fs.promises.readFile(src, 'utf8'));
  delete data.$schema; // the extension associates the schema by file name
  await fs.promises.writeFile(target.fsPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  vscode.window.showTextDocument(target);
}

/** The performance examples (examples/perf), copied together; the first is opened. */
const PERF_EXAMPLES = ['ddr-contention.platform.json', 'cpu-outstanding.perfsweep.json', 'ddr-2ch.platform.json', 'ddr-2ch.perfsweep.json',
  'mau-2ddr.platform.json', 'mau-qos.perfsweep.json', 'mau-sysbus.platform.json', 'mau-sysbus.perfsweep.json'];

/** Copy the performance examples (platforms of perf models and their sweeps) into a folder of the workspace. */
async function cmdPerfCreateExample(context) {
  const folder = (vscode.workspace.workspaceFolders || [])[0];
  const pick = await vscode.window.showOpenDialog({
    canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Put the Example Here',
    defaultUri: folder ? folder.uri : undefined, title: 'Folder for the performance examples (one DDR channel, two channels, two DDRs with QoS, a system bus) and their sweeps',
  });
  if (!pick || !pick.length) return;
  const dir = pick[0].fsPath;
  const src = path.join(context.extensionPath, 'examples', 'perf');
  const names = PERF_EXAMPLES;
  const there = names.filter((n) => fs.existsSync(path.join(dir, n)));
  if (there.length) {
    const ok = await vscode.window.showWarningMessage(`${there.join(', ')} ${there.length > 1 ? 'exist' : 'exists'} in ${dir}. Replace?`, { modal: true }, 'Replace');
    if (ok !== 'Replace') return;
  }
  for (const n of names) {
    const data = JSON.parse(await fs.promises.readFile(path.join(src, n), 'utf8'));
    delete data.$schema; // the extension associates the schema by file name
    await fs.promises.writeFile(path.join(dir, n), JSON.stringify(data, null, 2) + '\n', 'utf8');
  }
  await vscode.window.showTextDocument(vscode.Uri.file(path.join(dir, names[0])), { preview: false });
  vscode.window.showInformationMessage('Performance example created. Run it with "VP Studio: Run Performance Experiment", or its sweep with "Run Performance Sweep".');
}

// ------------------------------------------------------------------ tree view

// Icons and colors of module roles in the tree views, close to the platform view's role colors.
const MODULE_ROLE_LOOK = {
  compute: { icon: 'chip', color: 'charts.blue' },
  memory: { icon: 'database', color: 'charts.orange' },
  irq: { icon: 'zap', color: 'charts.purple' },
  periph: { icon: 'plug', color: 'charts.green' },
  pcie: { icon: 'extensions', color: 'charts.green' },
  boot: { icon: 'rocket', color: 'charts.red' },
  bus: { icon: 'git-merge', color: 'charts.blue' },
  subsystem: { icon: 'folder', color: 'charts.foreground' },
  infra: { icon: 'gear', color: undefined },
};

class ModuleTree {
  constructor() {
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
  }
  refresh() { this.emitter.fire(); }
  /**
   * The platform whose modules are listed: the active editor's, else the last
   * one seen, else one in sight or open. Focus in a view (the tree itself, the
   * platform view) leaves no active text editor, in Theia at once.
   */
  current() {
    const ed = vscode.window.activeTextEditor;
    if (ed && isPlatform(ed.document)) this.last = ed.document;
    if (!this.last || this.last.isClosed) {
      const seen = vscode.window.visibleTextEditors.find((e) => isPlatform(e.document));
      const open = seen ? seen.document : vscode.workspace.textDocuments.find((d) => isPlatform(d));
      if (open) this.last = open;
    }
    return this.last && !this.last.isClosed ? this.last : undefined;
  }
  getTreeItem(el) { return el; }
  getChildren(el) {
    if (el) return el.children || [];
    const textDoc = this.current();
    if (!textDoc) return [];
    let analysis;
    try { analysis = core.analyze(JSON.parse(textDoc.getText())); } catch (e) { return []; }
    // Grouped by role like the platform view's module list, each role with its icon and color.
    const byBase = new Map();
    for (const inst of analysis.instances) {
      if (!byBase.has(inst.base)) byBase.set(inst.base, []);
      byBase.get(inst.base).push(inst);
    }
    const roles = new Map(view.groups(analysis).map((g) => [g.base, g.role]));
    const byRole = new Map();
    for (const [base, list] of byBase) {
      const role = roles.get(base) || 'infra';
      if (!byRole.has(role)) byRole.set(role, []);
      const first = list[0];
      const item = new vscode.TreeItem(list.length > 1 ? `${base} ×${list.length}` : base,
        first.ports.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
      const region = analysis.memoryMap.find((m) => m.base === base);
      item.description = (region ? `${view.fmtAddr(region.start)} · ` : '') + (first.isContainer ? 'subsystem' : first.type);
      item.tooltip = `${base} (${first.isContainer ? 'subsystem' : first.type})${region ? `\n${core.hex(region.start)} – ${core.hex(region.end)}` : ''}`;
      const look = MODULE_ROLE_LOOK[role] || MODULE_ROLE_LOOK.infra;
      item.iconPath = new vscode.ThemeIcon(look.icon, look.color ? new vscode.ThemeColor(look.color) : undefined);
      item.command = { command: 'vpStudio.reveal', title: 'Reveal', arguments: [textDoc.uri, base] };
      item.children = first.ports.map((p) => {
        const c = new vscode.TreeItem(p.name);
        c.description = (p.address !== undefined && p.address !== null ? `${core.hex(p.address)}  ` : '') + `→ ${p.bind}`;
        c.iconPath = new vscode.ThemeIcon(p.raw.address !== undefined ? 'symbol-field' : 'plug');
        c.command = { command: 'vpStudio.reveal', title: 'Reveal', arguments: [textDoc.uri, base, p.name] };
        return c;
      });
      byRole.get(role).push({ item, n: first.isContainer ? 1 : list.length });
    }
    const items = [];
    for (const role of view.ROLE_ORDER) {
      if (!byRole.has(role)) continue;
      const list = byRole.get(role);
      const head = new vscode.TreeItem(view.ROLE_LABEL[role], role === 'infra' ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded);
      head.id = `role:${role}`;
      head.description = String(list.reduce((s, x) => s + x.n, 0));
      const look = MODULE_ROLE_LOOK[role] || MODULE_ROLE_LOOK.infra;
      head.iconPath = new vscode.ThemeIcon('circle-filled', look.color ? new vscode.ThemeColor(look.color) : undefined);
      head.children = list.map((x) => x.item);
      items.push(head);
    }
    return items;
  }
}

async function cmdReveal(uri, moduleName, portName) {
  const textDoc = await vscode.workspace.openTextDocument(uri);
  const range = locate(textDoc, moduleName, portName);
  const ed = await vscode.window.showTextDocument(textDoc, { preserveFocus: true });
  ed.selection = new vscode.Selection(range.start, range.start);
  ed.revealRange(range, vscode.TextEditorRevealType.InCenter);
}

/**
 * Show a Markdown file rendered, or as text where there is no Markdown
 * preview (the standalone application has none).
 */
async function showMarkdown(file) {
  const uri = vscode.Uri.file(file);
  const cmds = await vscode.commands.getCommands(true);
  if (cmds.includes('markdown.showPreview')) {
    try { await vscode.commands.executeCommand('markdown.showPreview', uri); return; } catch (e) { /* fall back to the text */ }
  }
  await vscode.window.showTextDocument(uri, { preview: false });
}

/**
 * A multi-select QuickPick whose items with `picked: true` start checked.
 * showQuickPick({canPickMany}) ignores `picked` in the standalone application
 * (Theia), so every multi-select picker goes through this. Resolves to the
 * chosen items, or undefined when dismissed. options: title, placeHolder,
 * ignoreFocusOut, matchOnDescription, matchOnDetail.
 */
function pickMany(items, options = {}) {
  return new Promise((resolve) => {
    const qp = vscode.window.createQuickPick();
    qp.canSelectMany = true;
    qp.title = options.title;
    qp.placeholder = options.placeHolder;
    qp.ignoreFocusOut = !!options.ignoreFocusOut;
    qp.matchOnDescription = !!options.matchOnDescription;
    qp.matchOnDetail = !!options.matchOnDetail;
    qp.items = items;
    qp.selectedItems = items.filter((i) => i.picked);
    let accepted = false;
    qp.onDidAccept(() => { accepted = true; resolve([...qp.selectedItems]); qp.hide(); });
    qp.onDidHide(() => { if (!accepted) resolve(undefined); qp.dispose(); });
    qp.show();
  });
}

// ------------------------------------------------------------------ the VP Studio menu

const ctxState = {};       // the context keys VP Studio sets, for the Actions view and the menu
let actionsTree;
let commandTitles;

/** Set a context key (menus, views) and keep the Actions view in step. */
function setCtx(key, value) {
  vscode.commands.executeCommand('setContext', key, value);
  if (ctxState[key] === value) return;
  ctxState[key] = value;
  if (actionsTree) actionsTree.refresh();
}

function titles() {
  if (!commandTitles) commandTitles = menu.titlesFrom(require('./package.json'));
  return commandTitles;
}

/** The Actions view: the VP Studio menu as a tree, only what can run now. */
class ActionsTree {
  constructor() { this.emitter = new vscode.EventEmitter(); this.onDidChangeTreeData = this.emitter.event; }
  refresh() { this.emitter.fire(); }
  getTreeItem(n) { return n.item; }
  getChildren(n) {
    if (n) return n.children;
    return menu.visible(ctxState, titles()).map((g) => {
      const item = new vscode.TreeItem(g.label, vscode.TreeItemCollapsibleState.Expanded);
      item.id = `group.${g.id}`;
      item.iconPath = new vscode.ThemeIcon(g.icon);
      return {
        item,
        children: g.items.map((i) => {
          const it = new vscode.TreeItem(i.label, vscode.TreeItemCollapsibleState.None);
          it.id = `cmd.${i.command}`;
          it.command = { command: i.command, title: i.label };
          if (i.icon) it.iconPath = new vscode.ThemeIcon(i.icon);
          it.tooltip = `VP Studio: ${i.label}`;
          return { item: it };
        }),
      };
    });
  }
}

/** The menu as two quick picks: a group, then a command (status bar, "VP Studio: Menu…"). */
async function cmdMenu() {
  const groups = menu.visible(ctxState, titles());
  const g = await vscode.window.showQuickPick(groups.map((x) => ({
    label: `$(${x.icon}) ${x.label}`, description: x.items.map((i) => i.label).slice(0, 3).join(', ') + (x.items.length > 3 ? ', …' : ''), group: x,
  })), { title: 'VP Studio', placeHolder: 'Choose a group' });
  if (!g) return;
  const items = [];
  for (const i of g.group.items) {
    if (i.separatorBefore) items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    items.push({ label: `${i.icon ? `$(${i.icon}) ` : ''}${i.label}`, command: i.command });
  }
  const c = await vscode.window.showQuickPick(items, { title: `VP Studio: ${g.group.label}`, placeHolder: 'Choose a command' });
  if (c && c.command) vscode.commands.executeCommand(c.command);
}

// ------------------------------------------------------------------ activation

function activate(context) {
  extContext = context;
  setCtx('vpStudio.localSim', !IS_WINDOWS);
  if (cfg().get('remote.auth') === 'password') ensureAskpass().catch(() => {});
  setCtx('vpStudio.passwordLogin', cfg().get('remote.auth') === 'password');
  context.subscriptions.push({ dispose: () => askpassServer && askpassServer.close() });
  diagnostics = vscode.languages.createDiagnosticCollection('vpStudio');
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  agentItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
  menuItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 51);
  menuItem.text = '$(circuit-board) VP Studio';
  menuItem.tooltip = 'VP Studio menu';
  menuItem.command = 'vpStudio.menu';
  menuItem.show();
  actionsTree = new ActionsTree();
  const tree = new ModuleTree();
  paramTree = new ParamTree();
  registerTree = new RegisterTree();
  guestTree = new GuestTree();
  setRunning(false);
  setAgentContext();

  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  reg('vpStudio.menu', cmdMenu);
  reg('vpStudio.generate', cmdGenerate);
  reg('vpStudio.start', (arg) => start(arg, false));
  reg('vpStudio.startDebug', (arg) => start(arg, true));
  reg('vpStudio.startTrace', (arg) => cmdStartTrace(context, arg));
  reg('vpStudio.showTrace', () => { showTracePanel(false); traceConnected(); });
  reg('vpStudio.chooseProbes', () => cmdChooseProbes());
  reg('vpStudio.stop', cmdStop);
  reg('vpStudio.showPlatform', cmdShowPlatform);
  reg('vpStudio.addDebugConfigurations', cmdAddDebugConfigs);
  reg('vpStudio.createExample', () => cmdCreateExample(context));
  reg('vpStudio.perf.createExample', () => cmdPerfCreateExample(context).catch((e) => vscode.window.showErrorMessage(`Could not create the example: ${e.message}`)));
  reg('vpStudio.reveal', cmdReveal);
  reg('vpStudio.pause', cmdPause);
  reg('vpStudio.continue', cmdContinue);
  reg('vpStudio.runFor', () => runTimed(false));
  reg('vpStudio.refreshRegisters', () => registerTree.refresh());
  reg('vpStudio.startProfile', cmdStartProfile);
  reg('vpStudio.startOpenOcd', localOnly('The OpenOCD debug port', cmdStartOpenOcd));
  reg('vpStudio.startFtrace', cmdStartFtrace);
  reg('vpStudio.ftrace.record', cmdFtraceRecord);
  reg('vpStudio.ftrace.save', cmdFtraceSave);
  reg('vpStudio.ftrace.convert', cmdFtraceConvert);
  reg('vpStudio.showProfile', () => { showProfilePanel(profileState.uri || runningPlatform, false); profileConnected(); });
  reg('vpStudio.setRegister', cmdSetRegister);
  reg('vpStudio.readRegister', cmdReadRegister);
  reg('vpStudio.runUntil', () => runTimed(true));
  reg('vpStudio.connectAgent', cmdConnectAgent);
  reg('vpStudio.refreshParams', () => paramTree.load());
  reg('vpStudio.refreshGuest', () => guestTree.refresh());
  reg('vpStudio.showKernelLog', () => cmdShowKernelLog().catch((e) => vscode.window.showErrorMessage(`Could not read the kernel log: ${e.message}`)));
  reg('vpStudio.showCpuRegisters', () => vscode.commands.executeCommand('vpStudio.cpuRegisters.focus'));
  reg('vpStudio.mapSources', () => cmdMapSources().catch((e) => vscode.window.showErrorMessage(`Could not map the kernel sources: ${e.message}`)));
  reg('vpStudio.copyParam', cmdCopyParam);
  reg('vpStudio.setParam', (node) => cmdSetParam(node).catch((e) => vscode.window.showErrorMessage(`Could not set the parameter: ${e.message}`)));
  reg('vpStudio.checkQBox', localOnly('Check QBox Version', cmdCheckQBox, 'Check Remote Host'));
  reg('vpStudio.generateDeviceTree', cmdGenerateDeviceTree);
  reg('vpStudio.exportKit', cmdExportKit);
  reg('vpStudio.saveCheckpoint', () => cmdSaveCheckpoint().catch((e) => vscode.window.showErrorMessage(`Save Checkpoint failed: ${e.message}`)));
  reg('vpStudio.startFromCheckpoint', localOnly('Start from Checkpoint', (arg) => cmdStartFromCheckpoint(arg).catch((e) => vscode.window.showErrorMessage(`Start from Checkpoint failed: ${e.message}`))));
  reg('vpStudio.openKit', cmdOpenKit);
  reg('vpStudio.buildSimAgent', localOnly('Build Sim Agent', () => cmdBuildSimAgent().catch((e) => vscode.window.showErrorMessage(`Could not build the sim agent: ${e.message}`)), 'Build Sim Agent on Remote Host'));
  reg('vpStudio.perf.run', localOnly('Performance experiments', (arg) => cmdPerfRun(arg).catch((e) => vscode.window.showErrorMessage(`Performance run failed: ${e.message}`))));
  reg('vpStudio.perf.sweep', localOnly('Performance sweeps', (arg) => cmdPerfSweep(arg).catch((e) => vscode.window.showErrorMessage(`Performance sweep failed: ${e.message}`))));
  reg('vpStudio.perf.newSweep', (arg) => cmdPerfNewSweep(arg).catch((e) => vscode.window.showErrorMessage(`Could not create the sweep: ${e.message}`)));
  reg('vpStudio.perf.open', (arg) => cmdPerfOpen(arg).catch((e) => vscode.window.showErrorMessage(`Could not open the results: ${e.message}`)));
  reg('vpStudio.buildQbox', localOnly('Build QBox', () => cmdBuildQbox().catch((e) => vscode.window.showErrorMessage(`Could not build QBox: ${e.message}`))));
  for (const b of BUNDLED) reg(b.command, () => cmdBuildBundled(b).catch((e) => vscode.window.showErrorMessage(`Could not build the ${b.title}: ${e.message}`)));
  reg('vpStudio.newModel', () => cmdNewModel().catch((e) => vscode.window.showErrorMessage(`Could not create the model: ${e.message}`)));
  reg('vpStudio.generateModel', async (arg) => { const u = await pickModel(arg); if (u) await generateModel(u, false); });
  reg('vpStudio.remote.selectHost', () => cmdSelectHost().catch((e) => vscode.window.showErrorMessage(`VP Studio: ${e.message}`)));
  reg('vpStudio.remote.forgetPassword', () => cmdForgetPassword().catch((e) => vscode.window.showErrorMessage(`VP Studio: ${e.message}`)));
  reg('vpStudio.remote.check', () => cmdCheckRemote().catch((e) => vscode.window.showErrorMessage(`VP Studio: ${e.message}`)));
  reg('vpStudio.remote.buildSimAgent', () => cmdRemoteBuild('sim-agent').catch((e) => vscode.window.showErrorMessage(`Could not build the sim agent on the remote host: ${e.message}`)));
  for (const b of BUNDLED) reg(`vpStudio.remote.build.${b.dir}`, () => cmdRemoteBuild(b.dir).catch((e) => vscode.window.showErrorMessage(`Could not build the ${b.title} on the remote host: ${e.message}`)));
  reg('vpStudio.thirdPartyDebuggers', (arg) => cmdThirdPartyDebuggers(arg).catch((e) => vscode.window.showErrorMessage(`Could not write the debugger set-up: ${e.message}`)));
  reg('vpStudio.importIpxact', (arg) => cmdImportIpxact(arg).catch((e) => vscode.window.showErrorMessage(`Could not import the IP-XACT file: ${e.message}`)));
  reg('vpStudio.buildModel', (arg) => (IS_WINDOWS ? cmdRemoteBuildModel(arg) : cmdBuildModel(arg)).catch((e) => vscode.window.showErrorMessage(`Could not build the model: ${e.message}`)));
  reg('vpStudio.remote.buildModel', (arg) => cmdRemoteBuildModel(arg).catch((e) => vscode.window.showErrorMessage(`Could not build the model on the remote host: ${e.message}`)));
  modelDiagnostics = vscode.languages.createDiagnosticCollection('vpStudio.models');
  const refreshModels = () => refreshModelCatalogs().catch(() => {});
  for (const glob of ['**/*.model.json', '**/build/*.catalog.json', '**/*.registers.json']) {
    const w = vscode.workspace.createFileSystemWatcher(glob);
    context.subscriptions.push(w, w.onDidCreate(refreshModels), w.onDidChange(refreshModels), w.onDidDelete(refreshModels));
  }
  context.subscriptions.push(modelDiagnostics,
    vscode.workspace.onDidOpenTextDocument(refreshModelDiagnostics),
    vscode.workspace.onDidChangeTextDocument((e) => refreshModelDiagnostics(e.document)),
    vscode.workspace.onDidSaveTextDocument((d) => { if (isModel(d)) generateModel(d.uri, true); }));
  vscode.workspace.textDocuments.forEach(refreshModelDiagnostics);
  refreshModels();
  reg('vpStudio.addModule', (arg) => cmdAddModule(arg).catch((e) => vscode.window.showErrorMessage(`Could not add the module: ${e.message}`)));

  let timer;
  const changed = (textDoc) => {
    if (!isPlatform(textDoc)) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      refreshDiagnostics(textDoc);
      tree.refresh();
      const panel = panels.get(textDoc.uri.toString());
      if (panel) renderPanel(textDoc.uri, panel);
    }, 300);
  };

  context.subscriptions.push(
    diagnostics, statusItem, agentItem, menuItem,
    { dispose: disconnectAgent },
    vscode.window.registerTreeDataProvider('vpStudio.actions', actionsTree),
    vscode.window.registerTreeDataProvider('vpStudio.modules', tree),
    vscode.window.registerTreeDataProvider('vpStudio.params', paramTree),
    vscode.window.registerTreeDataProvider('vpStudio.registers', registerTree),
    ...guestViews(),
    vscode.workspace.onDidOpenTextDocument(changed),
    vscode.workspace.onDidChangeTextDocument((e) => changed(e.document)),
    vscode.workspace.onDidCloseTextDocument((d) => diagnostics.delete(d.uri)),
    vscode.window.onDidChangeActiveTextEditor(() => tree.refresh()),
    vscode.window.onDidCloseTerminal((t) => { if (t === terminal) { terminal = undefined; disconnectAgent(); setRunning(false); } }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('vpStudio.catalog')) vscode.workspace.textDocuments.forEach(refreshDiagnostics);
      if (e.affectsConfiguration('vpStudio.remote.auth')) {
        setCtx('vpStudio.passwordLogin', cfg().get('remote.auth') === 'password');
        if (cfg().get('remote.auth') === 'password') ensureAskpass().catch(() => {});
      }
    }),
  );
  vscode.workspace.textDocuments.forEach(refreshDiagnostics);
}

/** The Guest Processes view and the debug hooks it needs (G-06). */
function guestViews() {
  const view = vscode.window.createTreeView('vpStudio.guest', { treeDataProvider: guestTree });
  guestTree.attach(view);
  cpuRegsView = new CpuRegsView();
  if (vscode.debug.activeDebugSession) { guestTree.sessionStarted(vscode.debug.activeDebugSession); cpuRegsView.sessionStarted(vscode.debug.activeDebugSession); }
  const extra = [];
  // Selecting another CPU in Call Stack (VS Code 1.90+; not in every host).
  if (typeof vscode.debug.onDidChangeActiveStackItem === 'function') extra.push(vscode.debug.onDidChangeActiveStackItem((item) => cpuRegsView.onActiveStackItem(item)));
  return [
    view,
    vscode.window.registerWebviewViewProvider('vpStudio.cpuRegisters', cpuRegsView),
    ...extra,
    vscode.debug.registerDebugConfigurationProvider(DEBUG_TYPE, linuxConfigProvider),
    vscode.debug.registerDebugAdapterTrackerFactory(DEBUG_TYPE, {
      createDebugAdapterTracker(s) {
        return {
          onDidSendMessage(m) {
            if (m.type !== 'event') return;
            if (m.event === 'stopped') { guestTree.onStopped(s); cpuRegsView.onStopped(s, m.body && m.body.threadId); }
            else if (m.event === 'continued') { guestTree.onRunning(s); cpuRegsView.onRunning(s); }
          },
          onWillReceiveMessage(m) {
            // VS Code's own resume requests: CDT does not always send "continued".
            if (m.type === 'request' && /^(continue|next|stepIn|stepOut|stepBack|reverseContinue)$/.test(m.command)) { guestTree.onRunning(s); cpuRegsView.onRunning(s); }
          },
        };
      },
    }),
    vscode.debug.onDidStartDebugSession((s) => { guestTree.sessionStarted(s); cpuRegsView.sessionStarted(s); }),
    vscode.debug.onDidTerminateDebugSession((s) => { guestTree.sessionEnded(s); cpuRegsView.sessionEnded(s); }),
  ];
}

function deactivate() {
  disconnectAgent();
  if (terminal) terminal.dispose();
}

module.exports = { activate, deactivate };
