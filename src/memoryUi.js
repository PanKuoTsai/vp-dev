'use strict';
// Viewing target memory while debugging: VP Studio opens Eclipse CDT's Memory
// Inspector at an address or expression (Show Memory…, the CPU Registers view)
// and offers to install it when it is missing, so nobody has to look for it.
const vscode = require('vscode');
const memview = require('../lib/debug/memview');
const shared = require('./shared');

const DONT_ASK = 'vpStudio.memoryInspector.dontAsk';
let offered = false;     // offered once in this window already
let last = '';           // last address or expression asked for
// Debug sessions that started before Memory Inspector was installed: it never saw
// them start, so it cannot read memory in them until the debugger is reattached.
const before = new Set();

const installed = () => vscode.extensions.getExtension(memview.EXTENSION_ID);

/** Resolves when Memory Inspector shows up in the extension list, or false after `ms`. */
function waitForInspector(ms) {
  if (installed()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (ok) => { clearTimeout(timer); sub.dispose(); resolve(ok); };
    const sub = vscode.extensions.onDidChange(() => { if (installed()) done(true); });
    const timer = setTimeout(() => done(!!installed()), ms);
  });
}

/** Install Memory Inspector from the extension gallery (Marketplace in VS Code, Open VSX in Theia). */
async function install() {
  try {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Installing Memory Inspector (Eclipse CDT)…' }, async () => {
      await vscode.commands.executeCommand('workbench.extensions.installExtension', memview.EXTENSION_ID);
      if (!await waitForInspector(60000)) throw new Error('it did not appear in the extension list');
    });
    return true;
  } catch (e) {
    const pick = await vscode.window.showErrorMessage(`Could not install Memory Inspector: ${e.message}. Install "${memview.EXTENSION_ID}" from the Extensions view.`, 'Open Extensions');
    if (pick) vscode.commands.executeCommand('workbench.extensions.search', memview.EXTENSION_ID);
    return false;
  }
}

/** Memory Inspector, installed (after asking) and activated; false when the user declines or it fails. */
async function ensureInspector() {
  let ext = installed();
  if (!ext) {
    const pick = await vscode.window.showInformationMessage(
      'Viewing memory uses Memory Inspector from Eclipse CDT, which is not installed. Install it now?',
      { modal: true, detail: `${memview.EXTENSION_ID} (EPL-2.0) reads memory through the debugger. It is installed once and then used by every debug session.` }, 'Install');
    if (pick !== 'Install' || !await install()) return false;
    ext = installed();
  }
  if (ext && !ext.isActive) await ext.activate();
  return true;
}

/**
 * Reattach `session` (the simulation keeps running: an attach session is
 * disconnected, not terminated) so Memory Inspector sees the new session.
 */
async function reattach(session) {
  const config = Object.assign({}, session.configuration);
  const folder = session.workspaceFolder;
  await vscode.debug.stopDebugging(session);
  await new Promise((r) => setTimeout(r, 1500));
  const ok = await vscode.debug.startDebugging(folder, config);
  if (ok) vscode.window.showInformationMessage('Debugger reattached. Pause the target, then show memory again.');
  return ok;
}

/** Tell the user Memory Inspector cannot read memory in `session` yet; offer to reattach. */
async function offerReattach(session) {
  const pick = await vscode.window.showInformationMessage(
    'Memory Inspector was installed after this debug session started, so it cannot read memory in it. Reattach the debugger?',
    { modal: true, detail: 'The debugger disconnects and attaches again; the simulation keeps running.' }, 'Reattach');
  if (pick === 'Reattach') await reattach(session);
}

function debugSession() {
  const s = vscode.debug.activeDebugSession;
  return s && memview.DEBUG_TYPES.includes(s.type) ? s : undefined;
}

/**
 * Show Memory…: open a Memory Inspector tab at `expression` (an address such as
 * 0xffff8000080ebd80, or anything gdb can evaluate: &jiffies, $sp). Asks when
 * no expression is given. Memory is read through the CPU selected in Call Stack.
 */
async function showMemory(expression) {
  if (!debugSession()) {
    vscode.window.showWarningMessage('Attach the debugger to the target ("VP: attach to target software") and pause it to view memory.');
    return false;
  }
  let expr = typeof expression === 'string' ? memview.normalize(expression) : '';
  if (!expr) {
    const input = await vscode.window.showInputBox({
      title: 'Show Memory',
      prompt: 'Address or expression. Memory is read as the CPU selected in Call Stack sees it (virtual addresses).',
      placeHolder: '0xffff8000080ebd80, &jiffies, $sp',
      value: last,
      validateInput: (v) => (memview.normalize(v) ? undefined : 'Enter an address or an expression'),
    });
    if (input === undefined) return false;
    expr = memview.normalize(input);
  }
  last = expr;
  const session = debugSession();
  if (!installed()) before.add(session.id);
  if (!await ensureInspector()) return false;
  if (before.has(session.id)) { await offerReattach(session); return false; }
  const cmds = await vscode.commands.getCommands(true);
  if (cmds.includes(memview.GO_TO_COMMAND)) await vscode.commands.executeCommand(memview.GO_TO_COMMAND, memview.goToArgs(expr));
  else {
    await vscode.commands.executeCommand(memview.SHOW_COMMAND);
    vscode.window.showInformationMessage(`Type ${expr} in the Memory tab's Address field.`);
  }
  return true;
}

/**
 * Memory Layout…: how Memory Inspector groups bytes into words and how many words go on a row.
 * Written to the user settings (memory-inspector.groupings.*); a Memory tab opened before keeps its
 * own layout (its gear button changes that tab alone).
 */
async function cmdMemoryLayout() {
  const cfg = vscode.workspace.getConfiguration(memview.SECTION);
  const now = memview.describeLayout(cfg.get(memview.KEYS.mau), cfg.get(memview.KEYS.group), cfg.get(memview.KEYS.row));
  const size = await vscode.window.showQuickPick(memview.WORD_SIZES.map((n) => ({
    label: n === 1 ? 'Bytes' : `${n * 8}-bit words`, description: `${n} byte${n === 1 ? '' : 's'}${n === now.wordBytes ? ' · current' : ''}`, n,
  })), { title: `Memory Layout (1/2): word size · now ${now.text}` });
  if (!size) return;
  const row = await vscode.window.showQuickPick(memview.ROW_CHOICES.map((r) => ({
    label: r === 'Autofit' ? 'As many as fit' : `${r} per row`,
    description: (r === 'Autofit' ? 'follows the width of the tab' : `${Number(r) * size.n} bytes a row`) + (r === now.wordsPerRow && size.n === now.wordBytes ? ' · current' : ''), r,
  })), { title: `Memory Layout (2/2): ${size.label.toLowerCase()} per row` });
  if (!row) return;
  for (const [k, v] of Object.entries(memview.layoutSettings(size.n, row.r))) await cfg.update(k, v, vscode.ConfigurationTarget.Global);
  const d = memview.describeLayout(1, size.n, row.r);
  vscode.window.showInformationMessage(`Memory Inspector: ${d.text}. Memory tabs opened from now on use it; a tab already open keeps its layout (change it with the gear in that tab).`);
}

/** A debug session started: remember whether Memory Inspector saw it, and offer it once when missing (until "Don't Ask Again"). */
async function sessionStarted(session) {
  if (!session || !memview.DEBUG_TYPES.includes(session.type) || installed()) return;
  before.add(session.id);
  if (offered) return;
  const state = shared.extContext && shared.extContext.globalState;
  if (state && state.get(DONT_ASK)) return;
  offered = true;
  const pick = await vscode.window.showInformationMessage(
    'Install Memory Inspector (Eclipse CDT) to view and edit target memory while debugging, without gdb commands?', 'Install', "Don't Ask Again");
  if (pick === 'Install') {
    if (!await install()) return;
    const live = vscode.debug.activeDebugSession && vscode.debug.activeDebugSession.id === session.id;
    const again = await vscode.window.showInformationMessage(
      'Memory Inspector is installed. Use "VP Studio: Show Memory…" or the "mem" button next to a register in CPU Registers.' +
      (live ? ' It can read memory from the next debug session: reattach the debugger first.' : ''), ...(live ? ['Reattach'] : []));
    if (again === 'Reattach') await reattach(session);
  }
  else if (pick && state) state.update(DONT_ASK, true);
}

function sessionEnded(session) { if (session) before.delete(session.id); }

module.exports = { showMemory, sessionStarted, sessionEnded, ensureInspector, cmdMemoryLayout };
