'use strict';
// Small things every file uses: the settings, the platform file suffix, the open platform views, pickers.
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const shared = require('./shared');

// The folder of the extension (this file is in src/).
const ROOT = path.join(__dirname, '..');

const SUFFIX = '.platform.json';
const isPlatform = (doc) => !!doc && doc.fileName.endsWith(SUFFIX);
const cfg = () => vscode.workspace.getConfiguration('vpStudio');
const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

// VS Code on Windows: QBox runs only on Linux, so simulations always run on a
// simulation host (remote.*), and what builds or runs QBox here is not offered.
const IS_WINDOWS = process.platform === 'win32';

const panels = new Map(); // uri string -> WebviewPanel
const pendingSelect = new Map(); // uri string -> module to select at the next render
const pendingRoute = new Map();  // uri string -> { id, spec } transaction route to show at the next render

function outputChannel() {
  if (!shared.versionOutput) shared.versionOutput = vscode.window.createOutputChannel('VP Studio');
  return shared.versionOutput;
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

exports.ROOT = ROOT;
exports.SUFFIX = SUFFIX;
exports.isPlatform = isPlatform;
exports.cfg = cfg;
exports.shq = shq;
exports.IS_WINDOWS = IS_WINDOWS;
exports.panels = panels;
exports.pendingSelect = pendingSelect;
exports.pendingRoute = pendingRoute;
exports.outputChannel = outputChannel;
exports.taskCwd = taskCwd;
exports.showMarkdown = showMarkdown;
exports.pickMany = pickMany;
