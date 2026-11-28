'use strict';
// Debugging the target: debug configurations, the OpenOCD port, the CPU Registers view, third-party debuggers.
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const core = require('../lib/platform/core');
const images = require('../lib/platform/images');
const simagent = require('../lib/sim/simagent');
const debugdap = require('../lib/debug/debugdap');
const guestlinux = require('../lib/debug/guestlinux');
const thirdparty = require('../lib/debug/thirdparty');
const cpuregs = require('../lib/debug/cpuregs');
const cpuregsview = require('../lib/webview/cpuregsview');
const layout = require('../lib/debug/layout');
const breakpoints = require('../lib/debug/breakpoints');
const gdbtargets = require('../lib/debug/gdbtargets');
const common = require('./common');
const shared = require('./shared');
const catalogUi = require('./catalogUi');
const platformFiles = require('./platformFiles');
const simUi = require('./simUi');
const mmuUi = require('./mmuUi');
const linuxUi = require('./linuxUi');
const memoryUi = require('./memoryUi');
const gdbUi = require('./gdbUi');

/**
 * Third-Party Debugger Setup… (G-11): a TRACE32 script and a guide for
 * TRACE32, Arm DS and other GDB clients, with the platform's gdbstub address.
 */
async function cmdThirdPartyDebuggers(arg) {
  const uri = await platformFiles.pickPlatform(arg);
  if (!uri) return;
  const loaded = await platformFiles.load(uri);
  if (!loaded) return;
  const c = common.cfg();
  const target = thirdparty.gdbTarget(loaded.data, catalogUi.analyzeWithCatalog(loaded.data), { port: c.get('debug.gdbPort'), cpuInstance: c.get('debug.cpuInstance') });
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
  await common.showMarkdown(mdFile);
  const how = target.source === 'platform' ? '' : ' Start it with "Start Simulation with Target Debug Port".';
  vscode.window.showInformationMessage(`Wrote ${vscode.workspace.asRelativePath(cmmFile)} (TRACE32) and the guide for TRACE32, Arm DS and other GDB clients. The gdbstub is ${hostSel.label}:${target.port}.${how}`);
}

/** Start Simulation with OpenOCD Port (G-13): the JTAG debug port on a free TCP port. */
async function cmdStartOpenOcd(arg) {
  const uri = await platformFiles.pickPlatform(arg);
  if (!uri) return;
  let data;
  try { data = JSON.parse((await vscode.workspace.openTextDocument(uri)).getText()); } catch (e) { vscode.window.showErrorMessage(`Cannot read the platform: ${e.message}`); return; }
  const t = debugdap.targets(data);
  const blocking = t.problems.filter((p) => !/different routers/.test(p));
  if (blocking.length) { vscode.window.showErrorMessage(`Cannot add the OpenOCD debug port: ${blocking.join(' ')}`); return; }
  const port = await simagent.freePort();
  await simUi.start(uri, false, [], { openocd: { port } });
}

/** debug/<platform>.openocd.cfg next to the platform, for the running simulation's port. */
async function writeOpenOcdConfig(uri, doc, port) {
  const dir = path.join(path.dirname(uri.fsPath), 'debug');
  await fs.promises.mkdir(dir, { recursive: true });
  const name = path.basename(uri.fsPath, common.SUFFIX);
  const file = path.join(dir, `${name}.openocd.cfg`);
  const n = debugdap.targets(doc).cpus.length;
  await fs.promises.writeFile(file, debugdap.openocdConfig({ port, cpus: n, platform: name }), 'utf8');
  const cmd = `openocd -f "${file}"`;
  const gdb = 'gdb-multiarch -ex "target extended-remote localhost:3333"';
  const pick = await vscode.window.showInformationMessage(
    `OpenOCD debug port on 127.0.0.1:${port} (${n} core${n === 1 ? '' : 's'}). Run: ${cmd}. Then telnet localhost 4444 for OpenOCD's commands (halt, resume, step, reg, mdw, bp, vp_status), or gdb on port 3333 (one thread per core).`,
    'Open Configuration', 'Copy Command', 'Copy gdb Command');
  if (pick === 'Open Configuration') await vscode.window.showTextDocument(vscode.Uri.file(file));
  if (pick === 'Copy Command') await vscode.env.clipboard.writeText(cmd);
  if (pick === 'Copy gdb Command') await vscode.env.clipboard.writeText(gdb);
}

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
      else if (m.type === 'memory') memoryUi.showMemory(String(m.value || ''));
      else if (m.type === 'disassembly') openDisassembly();
      else if (m.type === 'translate') mmuUi.cmdTranslate(String(m.value || ''));
    });
    view.onDidChangeVisibility(() => { if (view.visible) this.refresh(); });
  }
  post(m) { this.last = m; if (this.view) this.view.webview.postMessage(m); }
  sessionStarted(s) { if (s.type === linuxUi.DEBUG_TYPE) { this.session = s; this.stopped = false; this.post({ type: 'regs', state: 'running', thread: undefined, regs: [] }); } }
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
    if (!item || !item.session || item.session.type !== linuxUi.DEBUG_TYPE || item.threadId === undefined) return;
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
  const c = common.cfg();
  const found = arg instanceof vscode.Uri ? [arg] : await vscode.workspace.findFiles('**/*' + common.SUFFIX, '**/node_modules/**', 2);
  const active = vscode.window.activeTextEditor;
  // The platform in the editor, else the one that is running (a terminal or a panel may have the focus), else the only one.
  const platformUri = active && common.isPlatform(active.document) ? active.document.uri
    : shared.runningPlatform ? shared.runningPlatform : found.length === 1 ? found[0] : undefined;
  const symbols = platformUri ? await symbolFilesFor(platformUri) : [];
  // Without a symbol file, leave "program" out: the CDT adapter aborts the
  // attach when "program" names a file that does not exist, and gdb works
  // without symbols (registers, memory, disassembly; QEMU describes the CPU).
  const target = {
    name: 'VP: attach to target software', type: 'gdbtarget', request: 'attach',
    gdb: c.get('debug.targetGdb'),
    // 127.0.0.1, not localhost: the SSH forward of a remote simulation listens on
    // IPv4 only, and Windows resolves localhost to ::1 first.
    target: { host: common.IS_WINDOWS ? '127.0.0.1' : 'localhost', port: String(c.get('debug.gdbPort')) },
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
  const wanted = common.IS_WINDOWS ? [target] : [
    target,
    {
      name: 'VP: attach to simulator process (models)', type: 'gdb', request: 'attach',
      program: '${workspaceFolder}/' + c.get('executable'), processId: '${input:vpStudioPid}',
    },
  ];
  // More QEMU instances: one configuration per instance (its own gdb port, no kernel symbols),
  // and a compound that attaches to all of them.
  let targets = [];
  if (platformUri) {
    try {
      const data = JSON.parse((await vscode.workspace.openTextDocument(platformUri)).getText());
      targets = gdbtargets.targets(data, { basePort: Number(c.get('debug.gdbPort')), preferCpu: c.get('debug.cpuInstance'), param: c.get('debug.gdbPortParam') });
    } catch (e) { targets = []; }
  }
  const extra = targets.slice(1).map((t, k) => {
    const x = Object.assign({}, target, { name: gdbtargets.configName(t, k + 1), target: Object.assign({}, target.target, { port: String(t.port) }) });
    delete x.program;
    delete x.initCommands;
    return x;
  });
  if (targets.length > 1) target.target.port = String(targets[0].port);
  wanted.splice(1, 0, ...extra);
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
  if (!common.IS_WINDOWS && !inputs.some((x) => x.id === input.id)) inputs.push(input);
  if (extra.length) {
    const compounds = (launch.get('compounds') || []).filter((x) => x.name !== gdbtargets.COMPOUND_NAME);
    compounds.push({ name: gdbtargets.COMPOUND_NAME, configurations: [target.name, ...extra.map((x) => x.name)] });
    await launch.update('compounds', compounds, vscode.ConfigurationTarget.WorkspaceFolder);
  }
  await launch.update('configurations', configs, vscode.ConfigurationTarget.WorkspaceFolder);
  await launch.update('inputs', inputs, vscode.ConfigurationTarget.WorkspaceFolder);
  const sym = symbols.length
    ? `Target symbols: ${path.basename(symbols[0])}.`
    : 'No symbol file is set for this platform, so the debugger shows registers, memory and disassembly only. For source-level debugging choose one (for example vmlinux) under "Software images" in the platform view and run this command again.';
  vscode.window.showInformationMessage(
    (added ? `Added ${added} debug configuration(s) to launch.json. ` : relinked ? 'Updated the target debug configuration. ' : 'The debug configurations are already in launch.json. ') +
    sym + (target.openGdbConsole ? ' Type gdb commands (info threads, x/4i $pc) in the "gdb" terminal that opens with the debug session.' : '') +
    (added ? ' They need the CDT GDB Debug Adapter extension.' : '') +
    (extra.length ? ` The platform has ${targets.length} QEMU instances (${targets.map((t) => `${t.qemu} on port ${t.port}`).join(', ')}): "${gdbtargets.COMPOUND_NAME}" attaches to all of them.` : ''));
}

/** Open VS Code's Disassembly View at the instruction pointer of the CPU and frame selected in Call Stack. */
async function openDisassembly() {
  const [section, key] = [layout.SOURCE_SETTING.slice(0, layout.SOURCE_SETTING.lastIndexOf('.')), layout.SOURCE_SETTING.slice(layout.SOURCE_SETTING.lastIndexOf('.') + 1)];
  const cfg = vscode.workspace.getConfiguration(section);
  if (layout.offerPlainDisassembly(cfg.inspect(key))) {
    const pick = await vscode.window.showInformationMessage(
      'With source lines mixed in, the Disassembly View shows the kernel\'s instructions out of address order. Show instructions only in this workspace?',
      { modal: true, detail: `Sets "${layout.SOURCE_SETTING}": false in the workspace settings. Change it back in Settings at any time.` }, 'Instructions Only', 'Keep Source Lines');
    if (pick === 'Instructions Only') await cfg.update(key, false, vscode.workspace.workspaceFolders ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);
    else if (pick === 'Keep Source Lines') await cfg.update(key, true, vscode.workspace.workspaceFolders ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);
    else return false;
  }
  try { await vscode.commands.executeCommand(layout.DISASSEMBLY_COMMAND); return true; } catch (e) {
    vscode.window.showWarningMessage(`Could not open the Disassembly View: ${e.message}`);
    return false;
  }
}

const tabLabels = () => (vscode.window.tabGroups ? vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((t) => t.label)) : []);

/**
 * Debug Layout: the Run and Debug side bar (Call Stack, Breakpoints, CPU and
 * Peripheral Registers), the source on the left, Disassembly above Memory on the
 * right. Panes that are already open are kept, not opened again.
 */
async function cmdDebugLayout() {
  const s = vscode.debug.activeDebugSession;
  if (!s || s.type !== linuxUi.DEBUG_TYPE) {
    vscode.window.showWarningMessage('Attach the debugger to the target ("VP: attach to target software") first, then use Debug Layout.');
    return;
  }
  await vscode.commands.executeCommand('workbench.view.debug');
  const stopped = shared.cpuRegsView && shared.cpuRegsView.stopped;
  const need = layout.missingPanes(tabLabels());
  const problems = [];
  try { await vscode.commands.executeCommand('vscode.setEditorLayout', layout.EDITOR_LAYOUT); } catch (e) { problems.push(`editor layout: ${e.message}`); }
  if (!stopped) {
    vscode.window.showInformationMessage('Debug Layout: pause the target (F6), then run Debug Layout again to open Disassembly and Memory.');
    return;
  }
  if (need.disassembly) {
    await vscode.commands.executeCommand('workbench.action.focusSecondEditorGroup');
    if (!await openDisassembly()) problems.push('disassembly');
  }
  if (need.memory) {
    await vscode.commands.executeCommand('workbench.action.focusThirdEditorGroup');
    if (!await memoryUi.showMemory('$sp')) problems.push('memory');
  }
  await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
  if (problems.length) vscode.window.showWarningMessage(`Debug Layout: could not open ${problems.join(', ')}.`);
}

/**
 * Add Conditional Breakpoint…: a breakpoint on a function with a condition and
 * a hit count. The CDT adapter ignores both on function breakpoints, so this
 * sets a source line breakpoint at the function's first line, found in gdb.
 */
async function cmdAddConditionalBreakpoint() {
  const s = vscode.debug.activeDebugSession;
  if (!s || s.type !== linuxUi.DEBUG_TYPE) {
    vscode.window.showWarningMessage('Attach the debugger to the target ("VP: attach to target software") first.');
    return;
  }
  if (!(shared.cpuRegsView && shared.cpuRegsView.stopped)) {
    vscode.window.showWarningMessage('Pause the target (F6) first: the function is looked up in gdb, which needs a stopped target.');
    return;
  }
  const name = await vscode.window.showInputBox({ title: 'Conditional Breakpoint (1/3): function', placeHolder: 'update_process_times', prompt: 'Function to stop in',
    validateInput: (v) => { try { breakpoints.symbolCommand(v.trim()); return undefined; } catch (e) { return 'Enter a function name'; } } });
  if (!name) return;
  const fn = name.trim();
  let locs;
  try {
    const body = await s.customRequest('evaluate', guestlinux.evaluateArgs(breakpoints.symbolCommand(fn)));
    locs = breakpoints.functionLocations(guestlinux.parseResult(body), fn);
  } catch (e) { vscode.window.showErrorMessage(`Could not look up ${fn}: ${e.message}`); return; }
  if (!locs.length) { vscode.window.showErrorMessage(`No function ${fn} with debug information. Check the name and that the symbol file (for example vmlinux) is loaded.`); return; }
  let loc = locs[0];
  if (locs.length > 1) {
    const items = locs.map((l) => ({ label: `${path.basename(l.file)}:${l.line}`, description: l.file }));
    const pick = await vscode.window.showQuickPick(items, { title: `${fn} is defined in more than one file` });
    if (!pick) return;
    loc = locs[items.indexOf(pick)];
  }
  // The line gdb stops at for `break <function>` in the function's own code: the declaration line
  // can name only copies inlined into callers.
  try {
    const addr = breakpoints.functionAddress(await gdbUi.mi(s, `-data-evaluate-expression &${fn}`));
    const ins = await gdbUi.mi(s, `-break-insert -d ${fn}`);
    const num = breakpoints.breakpointNumber(ins);
    if (num) await gdbUi.mi(s, `-break-delete ${num}`).catch(() => {});
    const entry = breakpoints.entryLine(ins, addr);
    if (entry && entry.line && (!entry.file || path.basename(entry.file) === path.basename(loc.file))) loc = { file: loc.file, line: entry.line };
  } catch (e) { /* keep the declaration line */ }
  const condition = await vscode.window.showInputBox({ title: 'Conditional Breakpoint (2/3): condition', prompt: 'A C expression gdb evaluates at each hit; empty for none. Registers are $x0, $sp…',
    placeHolder: 'user_tick == 0' });
  if (condition === undefined) return;
  const hitText = await vscode.window.showInputBox({ title: 'Conditional Breakpoint (3/3): hit count', prompt: 'N: stop once, on the Nth hit (the breakpoint then goes away in gdb). >N: stop on every hit after the Nth. Empty: every hit.',
    placeHolder: '>5', validateInput: (v) => { try { breakpoints.normalizeHitCount(v); return undefined; } catch (e) { return e.message; } } });
  if (hitText === undefined) return;
  const hit = breakpoints.normalizeHitCount(hitText);
  const at = new vscode.Location(vscode.Uri.file(loc.file), new vscode.Position(loc.line - 1, 0));
  vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(at, true, condition.trim() || undefined, hit || undefined)]);
  vscode.window.showInformationMessage(`Breakpoint: ${breakpoints.describe(fn, loc, condition.trim(), hit)}. It is in the Breakpoints view; right-click it there to edit the condition or hit count.`);
}

exports.cmdThirdPartyDebuggers = cmdThirdPartyDebuggers;
exports.cmdAddConditionalBreakpoint = cmdAddConditionalBreakpoint;
exports.cmdDebugLayout = cmdDebugLayout;
exports.openDisassembly = openDisassembly;
exports.cmdStartOpenOcd = cmdStartOpenOcd;
exports.writeOpenOcdConfig = writeOpenOcdConfig;
exports.CpuRegsView = CpuRegsView;
exports.symbolFilesFor = symbolFilesFor;
exports.cmdAddDebugConfigs = cmdAddDebugConfigs;
