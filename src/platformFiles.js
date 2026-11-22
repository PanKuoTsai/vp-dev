'use strict';
// Platform files: picking one, loading it, its diagnostics, and generating its Lua.
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const core = require('../lib/platform/core');
const images = require('../lib/platform/images');
const modules = require('../lib/platform/modules');
const models = require('../lib/generate/models');
const launch = require('../lib/sim/launch');
const shared = require('./shared');
const common = require('./common');
const catalogUi = require('./catalogUi');

async function pickPlatform(arg) {
  if (arg instanceof vscode.Uri) return arg;
  const active = vscode.window.activeTextEditor;
  if (active && common.isPlatform(active.document)) return active.document.uri;
  const found = await vscode.workspace.findFiles('**/*' + common.SUFFIX, '**/node_modules/**', 50);
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
  if (!common.isPlatform(textDoc)) return;
  let data;
  try { data = JSON.parse(textDoc.getText()); } catch (e) { shared.diagnostics.delete(textDoc.uri); return; }
  if (!data || typeof data.modules !== 'object') { shared.diagnostics.delete(textDoc.uri); return; }
  const sev = { error: vscode.DiagnosticSeverity.Error, warning: vscode.DiagnosticSeverity.Warning, info: vscode.DiagnosticSeverity.Information };
  let problems;
  try {
    const analysis = catalogUi.analyzeWithCatalog(data);
    problems = analysis.problems.concat(images.collect(data, analysis, path.dirname(textDoc.uri.fsPath), { catalog: catalogUi.catalog() }).problems);
  } catch (e) { problems = [{ severity: 'error', message: e.message }]; }
  shared.diagnostics.set(textDoc.uri, problems.map((p) => {
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
    analysis = catalogUi.analyzeWithCatalog(loaded.data);
    const errors = analysis.problems.filter((p) => p.severity === 'error');
    if (errors.length) {
      refreshDiagnostics(loaded.textDoc);
      vscode.window.showErrorMessage(`Not generated: ${errors.length} error(s) in ${path.basename(uri.fsPath)}. First: ${errors[0].message}`);
      return undefined;
    }
    // Types built outside QBox that the platform does not locate itself get
    // this machine's library path (only in the generated Lua).
    lua = core.generate(loaded.data, Object.assign({ libraries: models.libraries(catalogUi.catalog()) }, options));
  } catch (e) {
    vscode.window.showErrorMessage(`Generation failed: ${e.message}`);
    return undefined;
  }
  return { lua, data: loaded.data };
}

exports.pickPlatform = pickPlatform;
exports.load = load;
exports.locate = locate;
exports.refreshDiagnostics = refreshDiagnostics;
exports.luaPathFor = luaPathFor;
exports.generateFor = generateFor;
exports.generateText = generateText;
