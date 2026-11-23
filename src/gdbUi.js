'use strict';
// gdb conveniences in the Debug menu: Find in Memory…, View Address as
// Type…, Load Symbol File at Address…, CPU Stepping…, QEMU Monitor…. They
// run through the attached target debug session (CDT GDB); a gdb CLI
// command's text comes back as the adapter's output events, which a tracker
// collects while the command runs.
const vscode = require('vscode');
const path = require('path');
const tools = require('../lib/debug/gdbtools');
const jump = require('../lib/debug/jump');
const guestlinux = require('../lib/debug/guestlinux');
const shared = require('./shared');
const memoryUi = require('./memoryUi');
const linuxUi = require('./linuxUi');

const listeners = new Set();

/** Registered in activate: forwards the target sessions' output events to whoever is collecting. */
function trackerFactory() {
  return {
    createDebugAdapterTracker(session) {
      return {
        onDidSendMessage(m) {
          if (m && m.type === 'event' && m.event === 'output' && m.body && typeof m.body.output === 'string') for (const l of listeners) l(session, m.body);
        },
      };
    },
  };
}

function session(quiet) {
  const s = vscode.debug.activeDebugSession;
  if (s && s.type === linuxUi.DEBUG_TYPE) return s;
  if (!quiet) vscode.window.showWarningMessage('Attach the debugger to the target ("VP: attach to target software") first.');
  return undefined;
}

const stopped = () => !!(shared.cpuRegsView && shared.cpuRegsView.stopped);

/** Run a gdb CLI command in session s; resolves with what it printed. */
async function cli(s, command, { timeoutMs = 30000 } = {}) {
  let text = '';
  const l = (from, body) => { if (from === s && body.category !== 'telemetry') text += body.output; };
  listeners.add(l);
  try {
    await Promise.race([
      s.customRequest('evaluate', guestlinux.evaluateArgs(command)),
      new Promise((resolve, reject) => setTimeout(() => reject(new Error(`gdb did not answer "${command}" in ${timeoutMs / 1000} s`)), timeoutMs)),
    ]);
    await new Promise((r) => setTimeout(r, 200)); // console output can trail the answer
  } finally { listeners.delete(l); }
  return text;
}

/** A value gdb computes: an address or an expression, as a BigInt. */
async function evaluateAddress(s, expr) {
  const e = String(expr).trim();
  if (/^0x[0-9a-f]+$/i.test(e)) return BigInt(e);
  const body = await s.customRequest('evaluate', guestlinux.evaluateArgs(`-data-evaluate-expression "(unsigned long)(${e.replace(/"/g, '\\"')})"`));
  const r = guestlinux.parseResult(body);
  if (!r || r.value === undefined) throw new Error(`gdb could not evaluate ${e}`);
  return BigInt(String(r.value).split(/\s/)[0]);
}

// Monitor output as read-only documents (vp-monitor:), so closing one never asks to save it.
const SCHEME = 'vp-monitor';
const texts = new Map();
let seq = 0;
const provider = { provideTextDocumentContent: (uri) => texts.get(uri.toString()) || '' };

async function openText(title, content) {
  const uri = vscode.Uri.from({ scheme: SCHEME, path: `/${++seq} ${title.replace(/[\\/]/g, ' ')}.txt` });
  texts.set(uri.toString(), `${title}\n\n${content}`);
  if (texts.size > 50) texts.delete(texts.keys().next().value);
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: true });
}

// ------------------------------------------------------------ Find in Memory…

async function cmdFindMemory() {
  const s = session(true);
  const canPhys = !!shared.agent && shared.agentMethods.includes('mem.read');
  const spaces = [];
  if (s) spaces.push({ label: 'Virtual addresses', description: 'as the CPU selected in Call Stack sees them (debugger)', space: 'virtual' });
  if (canPhys) spaces.push({ label: 'Physical addresses', description: 'on the bus, through the sim agent (no debugger needed)', space: 'physical' });
  if (!spaces.length) { vscode.window.showWarningMessage('Find in Memory needs the debugger attached to the target, or a simulation with the sim agent.'); return; }
  const space = spaces.length === 1 ? spaces[0] : await vscode.window.showQuickPick(spaces, { title: 'Find in Memory (1/4): address space' });
  if (!space) return;
  if (space.space === 'virtual' && !stopped()) { vscode.window.showWarningMessage('Pause the target (F6) first.'); return; }
  const startText = await vscode.window.showInputBox({ title: 'Find in Memory (2/4): start', prompt: space.space === 'virtual' ? 'Address or expression, e.g. 0xffff800008000000 or &_text' : 'Physical address, e.g. 0x80000000', placeHolder: '0x80000000' });
  if (!startText) return;
  const lenText = await vscode.window.showInputBox({ title: 'Find in Memory (3/4): length', prompt: `How many bytes to search (at most ${tools.MAX_SEARCH[space.space] / 1024 / 1024} MiB): 0x100000, 64k, 16M`, value: '16M',
    validateInput: (v) => { try { const n = tools.parseSize(v); return n > 0n && n <= BigInt(tools.MAX_SEARCH[space.space]) ? undefined : 'Too large'; } catch (e) { return e.message; } } });
  if (!lenText) return;
  const patText = await vscode.window.showInputBox({ title: 'Find in Memory (4/4): pattern', prompt: '"text", hex: d0 0d fe ed (bytes in order), or a number such as 0xd00dfeed (as stored, little-endian; add :be for big-endian)',
    validateInput: (v) => { try { tools.parsePattern(v); return undefined; } catch (e) { return e.message; } } });
  if (!patText) return;
  let start;
  try { start = space.space === 'virtual' ? await evaluateAddress(s, startText) : BigInt(startText.trim()); } catch (e) { vscode.window.showErrorMessage(`Find in Memory: ${e.message}`); return; }
  const pattern = tools.parsePattern(patText);
  const length = tools.parseSize(lenText);
  const read = space.space === 'virtual'
    ? async (a, n) => {
      try {
        const r = await s.customRequest('readMemory', { memoryReference: '0x' + a.toString(16), count: n });
        if (!r || !r.data) return null;
        const b = Buffer.from(r.data, 'base64');
        return b.length ? b : null;
      } catch (e) { return null; }
    }
    : async (a, n) => {
      try {
        const r = await shared.agent.request('mem.read', { address: '0x' + a.toString(16), size: n, bus: 0 }, { timeoutMs: 10000 });
        return Buffer.from(r.data, 'hex');
      } catch (e) { return null; }
    };
  const res = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Searching ${lenText} from 0x${start.toString(16)} for ${pattern.text}`, cancellable: true }, (progress, token) => {
    let last = 0;
    return tools.search(read, start, length, pattern.bytes, {
      chunk: space.space === 'virtual' ? 65536 : 4096,
      cancelled: () => token.isCancellationRequested,
      progress: (done, total) => { const pct = Math.floor((done / total) * 100); if (pct > last) { progress.report({ increment: pct - last }); last = pct; } },
    });
  });
  const unread = res.unreadable ? ` · ${res.unreadable} bytes could not be read` : '';
  if (!res.hits.length) { vscode.window.showInformationMessage(`Find in Memory: ${pattern.text} not found${unread}.`); return; }
  const items = res.hits.map((h) => ({ label: '0x' + h.toString(16), description: `+0x${(h - start).toString(16)}`, h }));
  const pick = await vscode.window.showQuickPick(items, {
    title: `${res.hits.length}${res.truncated ? '+' : ''} matches for ${pattern.text}${unread}`,
    placeHolder: space.space === 'virtual' ? 'Pick one to show it in Memory Inspector' : 'Pick one to copy its address (physical: see it with QEMU Monitor… → xp)',
  });
  if (!pick) return;
  if (space.space === 'virtual') await memoryUi.showMemory(pick.label);
  else { await vscode.env.clipboard.writeText(pick.label); vscode.window.setStatusBarMessage(`VP Studio: copied ${pick.label}`, 5000); }
}

// ------------------------------------------------------------ View Address as Type…

async function cmdViewAsType() {
  const s = session();
  if (!s) return;
  const type = await vscode.window.showInputBox({ title: 'View Address as Type (1/2): type', prompt: 'A C type from the symbol file', placeHolder: 'struct task_struct' });
  if (!type) return;
  const addr = await vscode.window.showInputBox({ title: 'View Address as Type (2/2): address', prompt: 'An address or an expression. Registers by their gdb names, for example $SP_EL0 (system registers are in capitals) or $x0', placeHolder: '0xffff800008223dc0, &init_task or $SP_EL0' });
  if (!addr) return;
  let expr;
  try { expr = tools.castExpression(type, addr); } catch (e) { vscode.window.showErrorMessage(e.message); return; }
  try {
    await vscode.commands.executeCommand('workbench.debug.action.focusWatchView');
    await vscode.commands.executeCommand('debug.addToWatchExpressions', { variable: { evaluateName: expr }, sessionId: s.id });
  } catch (e) {
    await vscode.env.clipboard.writeText(expr);
    vscode.window.showInformationMessage(`Add this to Watch (copied): ${expr}`);
  }
}

// ------------------------------------------------------------ Load Symbol File at Address…

async function cmdLoadSymbols() {
  const s = session();
  if (!s) return;
  if (!stopped()) { vscode.window.showWarningMessage('Pause the target (F6) first.'); return; }
  const files = await vscode.window.showOpenDialog({ canSelectMany: false, title: 'ELF file with symbols (a kernel module .ko, a library, firmware…)' });
  if (!files || !files.length) return;
  const addr = await vscode.window.showInputBox({ title: `Load ${path.basename(files[0].fsPath)}: address of its .text`, prompt: 'Where its .text section is loaded, e.g. 0xffff800001234000 (for a Linux module: cat /sys/module/<name>/sections/.text as root)' });
  if (!addr) return;
  let cmd;
  try { cmd = tools.addSymbolFileCommand(files[0].fsPath, addr); } catch (e) { vscode.window.showErrorMessage(e.message); return; }
  const out = await cli(s, cmd, { timeoutMs: 120000 });
  if (/error|No such file|not in executable format/i.test(out)) vscode.window.showErrorMessage(`gdb: ${out.trim().split('\n').slice(-1)[0]}`);
  else vscode.window.showInformationMessage(`Symbols of ${path.basename(files[0].fsPath)} loaded at ${addr.trim()}.`);
}

// ------------------------------------------------------------ CPU Stepping…

async function cmdStepping() {
  const s = session();
  if (!s) return;
  if (!stopped()) { vscode.window.showWarningMessage('Pause the target (F6) first.'); return; }
  const now = tools.parseLocking(await cli(s, 'show scheduler-locking'));
  const pick = await vscode.window.showQuickPick(tools.STEPPING.map((m) => ({ label: m.label, detail: m.detail, description: m.mode === now ? 'current' : '', mode: m.mode })), { title: 'CPU stepping' });
  if (!pick || pick.mode === now) return;
  await cli(s, `set scheduler-locking ${pick.mode}`);
  vscode.window.setStatusBarMessage(`VP Studio: ${pick.label.toLowerCase()}`, 6000);
}

// ------------------------------------------------------------ Jump to Cursor

/** MI command in session s; resolves with its result record (throws on ^error). */
async function mi(s, command) {
  const body = await s.customRequest('evaluate', guestlinux.evaluateArgs(command));
  const r = guestlinux.parseResult(body);
  if (r === undefined || r === null) throw new Error(`gdb: ${(body && body.result) || command}`);
  return r;
}

/**
 * Move the selected CPU's PC to the line under the editor cursor (or to an address typed in), as
 * VS Code's Jump to Cursor would if the CDT adapter supported it. Only the PC changes: registers
 * and the stack stay as they are.
 */
async function cmdJumpToCursor(uri) {
  const s = session();
  if (!s) return;
  if (!stopped()) { vscode.window.showWarningMessage('Pause the target (F6) first.'); return; }
  const view = shared.cpuRegsView;
  const threads = ((await s.customRequest('threads')) || {}).threads || [];
  const thread = threads.some((t) => t.id === view.thread) ? view.thread : (threads[0] || {}).id;
  if (thread === undefined) throw new Error('the debugger lists no CPU');
  const cpuName = ((threads.find((t) => t.id === thread) || {}).name || `thread ${thread}`).replace(/\s*\[.*$/, '').replace(/^\d+ \((.*)$/, '$1');
  const editor = vscode.window.activeTextEditor;
  const target = uri instanceof vscode.Uri ? uri : editor && editor.document.uri;
  let addresses = [];
  let where;
  if (target && target.scheme === 'file' && editor && editor.document.uri.toString() === target.toString()) {
    const line = editor.selection.active.line + 1;
    const map = vscode.workspace.getConfiguration('vpStudio').get('debug.sourceMap') || {};
    where = `${path.basename(target.fsPath)}:${line}`;
    for (const loc of jump.locationCandidates(target.fsPath, line, map, { win32: process.platform === 'win32' })) {
      let r;
      try { r = await mi(s, `-break-insert -t -d ${loc}`); } catch (e) { continue; }
      addresses = jump.breakpointAddresses(r);
      if (r.bkpt && r.bkpt.number) await mi(s, `-break-delete ${r.bkpt.number}`).catch(() => {});
      if (addresses.length) break;
    }
    if (!addresses.length) { vscode.window.showWarningMessage(`The debugger has no code for ${where}: no symbols for this file, or no instruction on this line. Map the kernel sources (Map Kernel Sources…) or pick another line.`); return; }
  } else {
    const text = await vscode.window.showInputBox({ title: `Jump ${cpuName} to`, prompt: 'Address or expression: the PC is set there (registers and stack stay as they are)', placeHolder: '0xffff800008010000 or some_function' });
    if (!text) return;
    addresses = [{ address: await evaluateAddress(s, text) }];
    where = text;
  }
  // The function the CPU is in now: with several addresses for the line, the one there wins.
  let current;
  try { current = (((await s.customRequest('stackTrace', { threadId: thread, startFrame: 0, levels: 1 })) || {}).stackFrames || [])[0]; } catch (e) { current = undefined; }
  let pick = jump.chooseAddress(addresses, current && String(current.name).replace(/\(.*$/, '').trim());
  if (!pick) {
    const c = await vscode.window.showQuickPick(addresses.map((a) => ({ label: '0x' + a.address.toString(16), description: a.func || '', a })), { title: `${where} has code in ${addresses.length} places: jump to which?` });
    if (!c) return;
    pick = c.a;
  }
  const before = tools.parseLocking(await cli(s, 'show scheduler-locking')) || 'replay';
  const [lock, brk, go] = jump.jumpCommands(thread, pick.address);
  await mi(s, lock);
  let ok;
  try {
    await mi(s, brk);
    view.stopped = false;
    await mi(s, go);
    // The CPU stops on the temporary breakpoint right away; then put the locking back.
    const t0 = Date.now();
    while (Date.now() - t0 < 5000 && !view.stopped) await new Promise((r) => setTimeout(r, 100));
    ok = view.stopped;
  } finally {
    await mi(s, `-gdb-set scheduler-locking ${before}`).catch(() => {});
  }
  // A line without code resolves to the next one that has some.
  const asked = /:(\d+)$/.exec(where);
  const landed = asked && pick.line && pick.line !== Number(asked[1]) ? ` → line ${pick.line}` : '';
  if (ok) vscode.window.setStatusBarMessage(`VP Studio: ${cpuName} jumped to ${where}${landed} (0x${pick.address.toString(16)})`, 8000);
  else vscode.window.showWarningMessage(`${cpuName} did not stop at 0x${pick.address.toString(16)} within 5 seconds. Pause it (F6).`);
}

// ------------------------------------------------------------ QEMU Monitor…

async function cmdMonitor() {
  const s = session();
  if (!s) return;
  if (!stopped()) { vscode.window.showWarningMessage('Pause the target (F6) first: gdb sends monitor commands while it has the target stopped.'); return; }
  const items = tools.MONITOR.map((m) => ({ label: m.label, detail: m.detail, ask: !!m.ask })).concat([{ label: 'Other…', detail: 'Any QEMU monitor (HMP) command, for example info qtree', ask: false }]);
  const pick = await vscode.window.showQuickPick(items, { title: 'QEMU Monitor', matchOnDetail: true });
  if (!pick) return;
  let cmd = pick.label;
  if (pick.label === 'Other…') {
    cmd = await vscode.window.showInputBox({ title: 'QEMU Monitor command', placeHolder: 'info qtree' });
    if (!cmd) return;
  } else if (pick.ask) {
    const a = await vscode.window.showInputBox({ title: 'Physical memory (xp)', prompt: 'Physical address; 64 words of 32 bits are shown', placeHolder: '0x80000000' });
    if (!a) return;
    try { cmd = tools.xpCommand(a, 64); } catch (e) { vscode.window.showErrorMessage(e.message); return; }
  }
  const out = await cli(s, `monitor ${cmd}`, { timeoutMs: 60000 });
  await openText(`QEMU monitor: ${cmd}`, out.trim() || '(no output)');
}

exports.SCHEME = SCHEME;
exports.provider = provider;
exports.trackerFactory = trackerFactory;
exports.cli = cli;
exports.evaluateAddress = evaluateAddress;
exports.cmdFindMemory = cmdFindMemory;
exports.cmdViewAsType = cmdViewAsType;
exports.cmdLoadSymbols = cmdLoadSymbols;
exports.cmdStepping = cmdStepping;
exports.cmdJumpToCursor = cmdJumpToCursor;
exports.cmdMonitor = cmdMonitor;
