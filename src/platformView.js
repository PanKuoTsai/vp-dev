'use strict';
// The platform view panel: opening it, what is collapsed, rendering.
const vscode = require('vscode');
const path = require('path');
const crypto = require('crypto');
const view = require('../lib/webview/view');
const images = require('../lib/platform/images');
const params = require('../lib/platform/params');
const connect = require('../lib/platform/connect');
const shared = require('./shared');
const common = require('./common');
const catalogUi = require('./catalogUi');
const platformFiles = require('./platformFiles');
const traceUi = require('./traceUi');
const platformEdit = require('./platformEdit');

async function cmdShowPlatform(arg, place = {}) {
  const uri = await platformFiles.pickPlatform(arg);
  if (!uri) return;
  const key = uri.toString();
  let panel = common.panels.get(key);
  if (!panel) {
    // Full width by default (module list, diagram and inspector side by side);
    // vpStudio.platformView.openBeside puts it next to the JSON instead.
    const beside = vscode.workspace.getConfiguration('vpStudio').get('platformView.openBeside', false);
    panel = vscode.window.createWebviewPanel('vpStudio.platform', `Platform: ${path.basename(uri.fsPath, common.SUFFIX)}`,
      { viewColumn: place.column || (beside ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active), preserveFocus: !!place.preserveFocus },
      { enableScripts: true, retainContextWhenHidden: false });
    common.panels.set(key, panel);
    panel.onDidDispose(() => { common.panels.delete(key); traceUi.txWatch.delete(key); });
    // Hidden, the page is gone (no retained context); it asks again when shown.
    panel.onDidChangeViewState(() => { if (!panel.visible) traceUi.txWatch.delete(key); });
    panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg && msg.type !== 'reveal') {
        const reply = (m) => panel.webview.postMessage(m);
        try { await platformEdit.handleFormMessage(uri, msg, reply); } catch (e) { vscode.window.showErrorMessage(`Could not update the platform: ${e.message}`); }
        return;
      }
      if (msg && msg.type === 'reveal') {
        const textDoc = await vscode.workspace.openTextDocument(uri);
        const range = platformFiles.locate(textDoc, msg.module);
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
    const saved = shared.extContext ? shared.extContext.workspaceState.get('vpStudio.collapsed', {}) : {};
    collapsedState.set(key, new Set(saved[key] || []));
  }
  return collapsedState.get(key);
}
function saveCollapsed(uri) {
  if (!shared.extContext) return;
  const saved = Object.assign({}, shared.extContext.workspaceState.get('vpStudio.collapsed', {}));
  saved[uri.toString()] = [...collapsedFor(uri)];
  shared.extContext.workspaceState.update('vpStudio.collapsed', saved);
}

async function renderPanel(uri, panel) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const textDoc = await vscode.workspace.openTextDocument(uri);
  try {
    const data = JSON.parse(textDoc.getText());
    const analysis = catalogUi.analyzeWithCatalog(data);
    const img = images.collect(data, analysis, path.dirname(uri.fsPath), { catalog: catalogUi.catalog() });
    const forms = params.moduleForms(data, analysis, catalogUi.catalog());
    const select = common.pendingSelect.get(uri.toString());
    common.pendingSelect.delete(uri.toString());
    const route = common.pendingRoute.get(uri.toString());
    common.pendingRoute.delete(uri.toString());
    const cat = catalogUi.catalog();
    const connections = new Map([...forms.keys()].map((b) => [b, connect.portRows(data, cat, b)]));
    const collapsed = new Set([...collapsedFor(uri)].filter((c) => analysis.instances.some((i) => i.isContainer && i.name === c)));
    panel.webview.html = view.render(data, analysis, nonce, panel.webview.cspSource, img, forms, { select, connections, collapsed, route });
  } catch (e) {
    const safe = String(e.message).replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
    panel.webview.html = `<!DOCTYPE html><html><body><p>Cannot show this platform: ${safe}</p><p>Fix the JSON and save to refresh.</p></body></html>`;
  }
}

Object.assign(exports, { cmdShowPlatform, collapsedFor, saveCollapsed, renderPanel });
