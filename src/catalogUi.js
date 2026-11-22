'use strict';
// The component catalog in use: the bundled one, a configured one, and the models of the workspace merged in.
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const core = require('../lib/platform/core');
const models = require('../lib/generate/models');
const shared = require('./shared');
const common = require('./common');
const platformFiles = require('./platformFiles');
const platformView = require('./platformView');

/**
 * The QBox component catalog used to check platforms, or undefined when
 * disabled or unreadable. "vpStudio.catalog" empty means the catalog bundled
 * with the extension (generated from the pinned QBox commit).
 */
function catalog() {
  const setting = (common.cfg().get('catalog') || '').trim();
  if (setting === 'none') return undefined;
  let file = path.join(common.ROOT, 'catalog', 'qbox-catalog.json');
  if (setting) {
    const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    file = path.isAbsolute(setting) || !folder ? setting : path.join(folder.uri.fsPath, setting);
  }
  try {
    const mtime = fs.statSync(file).mtimeMs;
    if (shared.catalogCache.file !== file || shared.catalogCache.mtime !== mtime) {
      shared.catalogCache = { file, mtime, data: JSON.parse(fs.readFileSync(file, 'utf8')), warned: null };
      shared.mergedCache = null;
    }
    return withModels(shared.catalogCache.data);
  } catch (e) {
    if (shared.catalogCache.warned !== file) {
      shared.catalogCache = { file: null, mtime: 0, data: undefined, warned: file };
      vscode.window.showWarningMessage(`VP Studio: cannot read component catalog ${file} (${e.message}). Module types, ports and parameters are not checked.`);
    }
    return undefined;
  }
}

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
  const base = shared.extContext && shared.extContext.globalStorageUri ? shared.extContext.globalStorageUri.fsPath : path.join(common.ROOT, '.vp-build');
  return path.join(base, 'build', ...parts);
}
const firstExisting = (...files) => files.find((f) => fs.existsSync(f));
const bundledCatalogFile = (b) => firstExisting(
  buildDir(b.dir, `${b.type}.catalog.json`),
  path.join(common.ROOT, 'tools', b.dir, 'build', `${b.type}.catalog.json`)) || buildDir(b.dir, `${b.type}.catalog.json`);

/** The component catalog tool, built on first use by the scripts that need it. */
const catalogToolPath = () => firstExisting(path.join(common.ROOT, 'tools', 'qbox-catalog', 'qbox-catalog')) || buildDir('qbox-catalog', 'qbox-catalog');

function withModels(base) {
  const bundled = BUNDLED.filter((b) => fs.existsSync(bundledCatalogFile(b)));
  const files = bundled.map(bundledCatalogFile).concat(shared.modelCatalogFiles);
  const key = files.map((f) => { try { return `${f}@${fs.statSync(f).mtimeMs}`; } catch (e) { return f; } }).join('|');
  if (shared.mergedCache && shared.mergedCache.base === base && shared.mergedCache.key === key) return shared.mergedCache.catalog;
  const unbuilt = BUNDLED.filter((b) => !bundled.includes(b)).map((b) => ({
    type: b.type,
    hint: `${b.type} comes with VP Studio but has not been built for your QBox yet. Run "VP Studio: Build ${b.title}".`,
  }));
  const r = models.merge(base, bundled.map((b) => models.loadModelCatalog(bundledCatalogFile(b), { bundled: true }))
    .concat(shared.modelCatalogFiles.map((f) => models.loadModelCatalog(f))), unbuilt);
  for (const t of r.clashes) {
    if (shared.clashWarned.has(t)) continue;
    shared.clashWarned.add(t);
    vscode.window.showWarningMessage(`VP Studio: the model ${t} has the name of a QBox module type, so it is left out of the catalog. Rename the model.`);
  }
  shared.mergedCache = { base, key, catalog: r.catalog };
  return r.catalog;
}

async function refreshModelCatalogs() {
  shared.workspaceRegisterFiles = (await vscode.workspace.findFiles('**/*.registers.json', '**/node_modules/**', 200)).map((u) => u.fsPath).sort();
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
  shared.modelSpecs = found;
  if (files.join('|') !== shared.modelCatalogFiles.join('|')) {
    shared.modelCatalogFiles = files;
    vscode.workspace.textDocuments.forEach(platformFiles.refreshDiagnostics);
    for (const [key, panel] of common.panels) platformView.renderPanel(vscode.Uri.parse(key), panel);
  }
}

const analyzeWithCatalog = (data) => core.analyze(data, { catalog: catalog() });

exports.catalog = catalog;
exports.BUNDLED = BUNDLED;
exports.buildDir = buildDir;
exports.firstExisting = firstExisting;
exports.bundledCatalogFile = bundledCatalogFile;
exports.catalogToolPath = catalogToolPath;
exports.refreshModelCatalogs = refreshModelCatalogs;
exports.analyzeWithCatalog = analyzeWithCatalog;
