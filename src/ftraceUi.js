'use strict';
// Function trace (G-05): recording, saving and converting.
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const elfsym = require('../lib/analysis/elfsym');
const ftrace = require('../lib/analysis/ftrace');
const shared = require('./shared');
const common = require('./common');
const platformFiles = require('./platformFiles');
const simUi = require('./simUi');
const profileUi = require('./profileUi');

async function cmdStartFtrace(arg) {
  const uri = await platformFiles.pickPlatform(arg);
  if (!uri) return;
  await simUi.start(uri, false, [], { ftrace: true });
}

/** The agent's function trace status, or undefined after saying why it cannot be used. */
async function ftraceStatus() {
  if (!shared.agent) { vscode.window.showErrorMessage('No simulation is connected. Start one with "VP Studio: Start Simulation with Function Trace".'); return undefined; }
  if (!shared.agentMethods.includes('ftrace.getStatus')) {
    vscode.window.showErrorMessage(`This sim agent has no function trace (that needs agent ${ftrace.MIN_AGENT}). Run "VP Studio: Build Sim Agent" and start again.`);
    return undefined;
  }
  const st = await shared.agent.request('ftrace.getStatus');
  if (!st.active) {
    const again = await vscode.window.showErrorMessage(`The function trace is off: ${st.problem || 'the simulation was not started with it'}.`, 'Start Simulation with Function Trace');
    if (again && shared.runningPlatform) vscode.window.showInformationMessage('Stop this simulation first, then run "Start Simulation with Function Trace".');
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
  await shared.agent.request('ftrace.clear');
  await shared.agent.request('ftrace.setEnabled', { enabled: true, space: pick.space });
  if (shared.ftraceStatusMessage) shared.ftraceStatusMessage.dispose();
  shared.ftraceStatusMessage = vscode.window.setStatusBarMessage('$(record) Recording function trace');
  const next = await vscode.window.showInformationMessage('Recording the function trace. Run the part of interest (Run For… stops after a set time), then save.', 'Stop and Save');
  if (next) await cmdFtraceSave();
}

async function cmdFtraceSave() {
  const st = await ftraceStatus();
  if (!st) return;
  await shared.agent.request('ftrace.setEnabled', { enabled: false });
  if (shared.ftraceStatusMessage) { shared.ftraceStatusMessage.dispose(); shared.ftraceStatusMessage = undefined; }
  if (shared.runningRemote) {
    vscode.window.showErrorMessage('The function trace of a simulation on a remote host cannot be saved yet: the agent writes the file on that host.');
    return;
  }
  if (!st.cpus.length) { vscode.window.showWarningMessage('The function trace is empty: start recording with "Function Trace: Start Recording…" first.'); return; }
  const uri = shared.runningPlatform;
  const dir = uri ? path.join(path.dirname(uri.fsPath), 'traces') : path.join(os.tmpdir(), 'vp-studio-traces');
  fs.mkdirSync(dir, { recursive: true });
  const d = new Date();
  const two = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
  const file = path.join(dir, `${uri ? path.basename(uri.fsPath, common.SUFFIX) : 'simulation'}-${stamp}.vpft`);
  const res = await shared.agent.request('ftrace.save', { path: file }, { timeoutMs: 120000 });
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
  const last = shared.extContext.globalState.get('vpStudio.ftraceSymbols');
  if (live) {
    const sym = profileUi.loadProfileSymbols();
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
        const sym = live && shared.profileSymbols && shared.profileSymbols.file === symbolFile && shared.profileSymbols.symbols ? shared.profileSymbols.symbols : elfsym.readSymbols(symbolFile);
        functions = sym.functions;
        // The running kernel's own idea of its address, else what the calls say.
        offset = live ? await profileUi.findKernelOffset(sym) : 0n;
        if (!offset) offset = ftrace.guessOffset(tr, functions);
        shared.extContext.globalState.update('vpStudio.ftraceSymbols', symbolFile);
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
  common.showMarkdown(mdFile);
  const act = await vscode.window.showInformationMessage(`Function trace written: ${path.basename(jsonFile)} (timeline for Perfetto UI) and ${path.basename(mdFile)} (summary).`, 'Open Perfetto UI', 'Reveal Timeline File');
  if (act === 'Open Perfetto UI') vscode.env.openExternal(vscode.Uri.parse('https://ui.perfetto.dev'));
  else if (act === 'Reveal Timeline File') vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(jsonFile));
}

exports.cmdStartFtrace = cmdStartFtrace;
exports.cmdFtraceRecord = cmdFtraceRecord;
exports.cmdFtraceSave = cmdFtraceSave;
exports.cmdFtraceConvert = cmdFtraceConvert;
