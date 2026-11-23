'use strict';
// Address Translation panel: a virtual address as the CPU selected in Call
// Stack translates it (lib/debug/mmu.js). The CPU's system registers come
// from gdb; the descriptors are read from physical memory through the sim
// agent (mem.read), or with gdb's "monitor xp" when there is no agent. The
// last address is translated again at every new stop and when another CPU
// is chosen.
const vscode = require('vscode');
const crypto = require('crypto');
const mmu = require('../lib/debug/mmu');
const core = require('../lib/platform/core');
const guestlinux = require('../lib/debug/guestlinux');
const mmuview = require('../lib/webview/mmuview');
const shared = require('./shared');
const linuxUi = require('./linuxUi');
const gdbUi = require('./gdbUi');
const memoryUi = require('./memoryUi');
const crossUi = require('./crossUi');

let panel;
let lastExpr = '';
let busy = false;
let again = false;
let timer;
const regNumbers = new Map(); // session id -> Map(name -> register number)

function post(m) { if (panel) panel.webview.postMessage(Object.assign({ type: 'mmu' }, m)); }

/** Open the panel; expr (optional) is translated right away. */
function cmdTranslate(expr) {
  if (typeof expr === 'string' && expr.trim()) lastExpr = expr.trim();
  if (panel) { panel.reveal(undefined, false); if (lastExpr) translate().catch(() => {}); return; }
  panel = vscode.window.createWebviewPanel('vpStudio.mmu', 'Address Translation',
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false }, { enableScripts: true, retainContextWhenHidden: true });
  panel.webview.html = mmuview.render(crypto.randomBytes(16).toString('hex'), panel.webview.cspSource);
  panel.onDidDispose(() => { panel = undefined; });
  panel.webview.onDidReceiveMessage((m) => handle(m).catch((e) => post({ error: e.message })));
}

async function handle(m) {
  if (!m) return;
  if (m.type === 'ready') { post({ expr: lastExpr, cpu: cpuInfo() }); if (lastExpr) await translate(); }
  else if (m.type === 'translate') { lastExpr = String(m.expr || '').trim(); await translate(); }
  else if (m.type === 'copy') { await vscode.env.clipboard.writeText(String(m.text || '')); vscode.window.setStatusBarMessage('VP Studio: copied', 3000); }
  else if (m.type === 'memory') await memoryUi.showMemory(String(m.va || ''));
  else if (m.type === 'register') {
    if (!(await crossUi.revealRegister(String(m.pa || '').replace(/_/g, '')))) vscode.window.showInformationMessage('No register description covers this physical address (Peripheral Registers).');
  }
}

function cpuInfo() {
  const v = shared.cpuRegsView;
  const s = v && v.session;
  if (!s || s.type !== linuxUi.DEBUG_TYPE) return { state: 'none' };
  return { state: v.stopped ? 'stopped' : 'running', thread: v.thread };
}

/** The system registers of gdb thread `thread`, read by number (just these, not all 400). */
async function readRegisters(s, thread) {
  const run = (cmd) => s.customRequest('evaluate', guestlinux.evaluateArgs(cmd)).then(guestlinux.parseResult);
  if (!regNumbers.has(s.id)) {
    const names = ((await run('-data-list-register-names')) || {})['register-names'] || [];
    const want = new Map(mmu.REGISTERS.map((n) => [n.toLowerCase(), n]));
    const map = new Map();
    names.forEach((n, i) => { const k = want.get(String(n).toLowerCase()); if (k) map.set(k, i); });
    regNumbers.set(s.id, map);
  }
  const map = regNumbers.get(s.id);
  if (!map.size) throw new Error('gdb does not list TCR_EL1 and the other translation registers for this target');
  const values = await run(`-data-list-register-values --thread ${Number(thread)} --frame 0 x ${[...map.values()].join(' ')}`);
  const byNumber = new Map([...map].map(([n, i]) => [String(i), n]));
  return mmu.pickRegisters(((values && values['register-values']) || []).map((rv) => ({ name: byNumber.get(String(rv.number)), value: rv.value })));
}

/** A reader of one 64-bit descriptor: the sim agent when there is one, else gdb's monitor xp. */
function descriptorReader(s) {
  if (shared.agent && shared.agentMethods.includes('mem.read')) {
    return async (pa) => {
      try {
        const r = await shared.agent.request('mem.read', { address: '0x' + pa.toString(16), size: 8, bus: 0 }, { timeoutMs: 10000 });
        const b = Buffer.from(r.data, 'hex');
        return b.length === 8 ? b.readBigUInt64LE(0) : null;
      } catch (e) { return null; }
    };
  }
  return async (pa) => mmu.parseXp(await gdbUi.cli(s, `monitor xp /1gx 0x${pa.toString(16)}`).catch(() => ''));
}

async function translate() {
  if (!panel) return;
  if (busy) { again = true; return; }
  busy = true;
  try {
    do {
      again = false;
      await translateOnce();
    } while (again);
  } finally { busy = false; }
}

async function translateOnce() {
  const cpu = cpuInfo();
  if (!lastExpr) { post({ cpu }); return; }
  if (cpu.state === 'none') { post({ cpu, expr: lastExpr, error: 'Attach the debugger to the target ("VP: attach to target software") and pause it: translation uses the selected CPU\'s registers.' }); return; }
  if (cpu.state !== 'stopped') { post({ cpu, expr: lastExpr, error: 'Pause the target (F6): the CPU\'s registers can only be read while it is stopped.' }); return; }
  const s = shared.cpuRegsView.session;
  const threads = ((await s.customRequest('threads')) || {}).threads || [];
  const thread = threads.some((t) => t.id === cpu.thread) ? cpu.thread : (threads[0] || {}).id || 1;
  const t = threads.find((x) => x.id === thread);
  cpu.thread = thread;
  // CDT names a thread "8 (CPU#7 [halted ])": QEMU's run state, not the debugger's; keep the CPU.
  const m = t && /CPU#(\d+)/.exec(t.name);
  cpu.name = m ? `CPU ${m[1]} (thread ${thread})` : t ? t.name : `thread ${thread}`;
  let va;
  try { va = await gdbUi.evaluateAddress(s, lastExpr); } catch (e) { post({ cpu, expr: lastExpr, error: e.message }); return; }
  const regs = await readRegisters(s, thread);
  const res = await mmu.translate(va, regs, descriptorReader(s));
  const map = shared.runningDoc ? core.analyze(shared.runningDoc).memoryMap : [];
  post({ cpu, expr: lastExpr, result: mmu.forView(res, map), reader: shared.agent && shared.agentMethods.includes('mem.read') ? 'sim agent' : 'gdb monitor xp' });
}

/** A new stop, or another CPU chosen in Call Stack: translate the last address again. */
function onDebugChange() {
  if (!panel || !panel.visible) return;
  post({ cpu: cpuInfo() });
  if (lastExpr && cpuInfo().state === 'stopped') {
    clearTimeout(timer);
    timer = setTimeout(() => translate().catch(() => {}), 400);
  }
}

function sessionEnded(s) { regNumbers.delete(s.id); onDebugChange(); }

exports.cmdTranslate = cmdTranslate;
exports.onDebugChange = onDebugChange;
exports.sessionEnded = sessionEnded;
