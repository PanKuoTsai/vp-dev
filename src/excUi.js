'use strict';
// Exceptions & Interrupts (sim agent 0.15.0, exc.*): the panel, the catch
// rules (kept per workspace and applied to every new simulation) and what
// happens when one stops the simulation.
const vscode = require('vscode');
const path = require('path');
const crypto = require('crypto');
const exceptions = require('../lib/debug/exceptions');
const excview = require('../lib/webview/excview');
const ftrace = require('../lib/analysis/ftrace');
const shared = require('./shared');
const common = require('./common');
const profileUi = require('./profileUi');

const CATCH_KEY = 'vpStudio.exceptions.catch';
const KEEP = 500; // events sent to the page at a time
let panel;
let timer;
let lastSeq = 0;
let lastHitSeq = 0;
let calls = { seq: undefined, data: null }; // the calls before the current catch, read once per catch

const START_FTRACE = 'Start the simulation with "Start Simulation with Function Trace" and turn recording on ("Function Trace: Start Recording…") to see the calls that led to a caught exception.';

/**
 * The calls the CPU of a caught exception made last (sim agent's function trace, ftrace.tail), named
 * with the platform's symbol file: { cpu, rows, open, recording, symbols } or { note }.
 */
async function callsFor(hit) {
  if (calls.seq === hit.seq) return calls.data;
  let data;
  if (!shared.agentMethods.includes('ftrace.tail')) data = { note: `This sim agent cannot list recent calls; rebuild it ("VP Studio: Build Sim Agent"). ${START_FTRACE}` };
  else {
    try {
      const res = await shared.agent.request('ftrace.tail', { cpu: hit.cpu, count: 400 }, { timeoutMs: 10000 });
      if (!res.records.length) data = { note: res.enabled ? `No calls recorded on CPU ${hit.cpu}.` : `The function trace is not recording. ${START_FTRACE}` };
      else {
        const events = ftrace.tailEvents(res);
        const sym = profileUi.loadProfileSymbols();
        let functions = [];
        let offset = 0n;
        if (sym && sym.symbols) {
          functions = sym.symbols.functions;
          if (shared.profileState.offset === undefined) shared.profileState.offset = await profileUi.findKernelOffset(sym.symbols);
          offset = shared.profileState.offset || ftrace.guessOffset({ cpus: [{ events }] }, functions);
        }
        const r = ftrace.recentCalls(events, ftrace.namer(functions, offset), { vectors: hit.toPc ? [BigInt(hit.toPc)] : [] });
        data = { cpu: hit.cpu, rows: r.rows.slice(-120), open: r.open, recording: res.enabled, symbols: functions.length > 0 };
      }
    } catch (e) {
      data = { note: /not started with the function trace/.test(e.message) ? START_FTRACE : `Could not read the function trace: ${e.message}` };
    }
  }
  calls = { seq: hit.seq, data };
  return data;
}

function savedCatch() {
  const v = shared.extContext && shared.extContext.workspaceState.get(CATCH_KEY);
  return v && Array.isArray(v.ids) ? { ids: v.ids, origin: v.origin || 'any', syscalls: typeof v.syscalls === 'string' ? v.syscalls : '' } : { ids: [], origin: 'any', syscalls: '' };
}

/** The agent rules for a saved choice; throws on an unknown system call name. */
function rulesOf(c) {
  return exceptions.rulesFor(c.ids, c.origin, c.ids.includes('svc') ? exceptions.parseSyscalls(c.syscalls) : []);
}

const supported = () => !!shared.agent && shared.agentMethods.includes('exc.getStatus');

function cmdShowExceptions() {
  if (panel) { panel.reveal(undefined, false); return; }
  const name = shared.runningPlatform ? path.basename(shared.runningPlatform.fsPath, common.SUFFIX) : 'simulation';
  panel = vscode.window.createWebviewPanel('vpStudio.exceptions', `Exceptions: ${name}`,
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false }, { enableScripts: true, retainContextWhenHidden: true });
  panel.webview.html = excview.render(crypto.randomBytes(16).toString('hex'), panel.webview.cspSource, `Exceptions & Interrupts: ${name}`, exceptions.CATCH);
  panel.onDidDispose(() => { panel = undefined; clearInterval(timer); timer = undefined; });
  panel.webview.onDidReceiveMessage((m) => handleMessage(m).catch((e) => vscode.window.showErrorMessage(`Exceptions: ${e.message}`)));
}

async function refresh(reset) {
  if (!panel) return;
  const c = savedCatch();
  if (!supported()) {
    panel.webview.postMessage({ type: 'exc', catch: c, problem: shared.agent
      ? `This sim agent cannot record exceptions (that needs agent ${exceptions.MIN_AGENT}). Run "VP Studio: Build Sim Agent" and start the simulation again.`
      : 'Start a simulation (VP Studio: Start Simulation) to record its exceptions and interrupts.' });
    return;
  }
  const st = await shared.agent.request('exc.getStatus');
  if (reset || st.total < lastSeq) lastSeq = 0;
  let events = [];
  if (st.active) {
    const r = await shared.agent.request('exc.read', { after: lastSeq, max: KEEP }, { timeoutMs: 10000 });
    // Far behind (the page was closed a while): take the newest only.
    if (r.events.length === KEEP && st.total - r.last > KEEP) {
      lastSeq = st.total - KEEP;
      return refresh(false);
    }
    events = r.events.map(exceptions.decode);
    lastSeq = r.last;
  }
  const s = shared.agentStatus || {};
  const hit = s.state === 'paused' && s.exceptionHit ? exceptions.decode(s.exceptionHit) : null;
  panel.webview.postMessage({
    type: 'exc', reset: !!reset, active: st.active, problem: st.problem || (st.active ? '' : 'The simulation was not started with exception recording. Turn on the setting vpStudio.exceptions.record and start again.'),
    recording: st.recording, total: st.total, hits: st.hits, counts: exceptions.countRows(st.counts), events,
    hit, calls: hit ? await callsFor(hit) : null,
    paused: s.state === 'paused', debugging: !!vscode.debug.activeDebugSession, catch: c,
  });
}

/** After connecting to an agent: apply the saved catch rules and start polling the open panel. */
async function excConnected() {
  if (!supported()) { refresh().catch(() => {}); return; }
  lastSeq = 0;
  const c = savedCatch();
  if (c.ids.length) {
    try { await shared.agent.request('exc.setCatch', { rules: rulesOf(c) }); } catch (e) { /* not recording, or a bad saved list: nothing to catch with */ }
  }
  startTimer();
}

function startTimer() {
  if (!panel || timer) { refresh(true).catch(() => {}); return; }
  const client = shared.agent;
  let busy = false;
  timer = setInterval(async () => {
    if (!panel || !panel.visible || busy || !shared.agent || shared.agent !== client) return;
    busy = true;
    try { await refresh(false); } catch (e) { /* next tick */ }
    busy = false;
  }, 700);
  refresh(true).catch(() => {});
}

async function handleMessage(m) {
  if (!m) return;
  if (m.type === 'ready') { lastSeq = 0; if (shared.agent) startTimer(); else refresh().catch(() => {}); return; }
  if (m.type === 'catch') {
    const c = { ids: (m.ids || []).filter((id) => exceptions.CATCH.some((x) => x.id === id)), origin: ['any', 'el0', 'el1', 'el2'].includes(m.origin) ? m.origin : 'any', syscalls: String(m.syscalls || '') };
    let rules;
    try { rules = rulesOf(c); } catch (e) {
      panel.webview.postMessage({ type: 'exc', catch: Object.assign({}, c, { error: `${e.message}: use names such as openat or numbers` }) });
      return;
    }
    await shared.extContext.workspaceState.update(CATCH_KEY, c);
    if (supported()) await shared.agent.request('exc.setCatch', { rules });
  } else if (m.type === 'continue') {
    // With the debugger attached, it saw the pause as a stop: continue there, so it knows
    // the target runs again (the agent follows the VM; sim agent 0.15.0).
    const s = vscode.debug.activeDebugSession;
    if (s && s.type === 'gdbtarget') await vscode.commands.executeCommand('workbench.action.debug.continue');
    else await vscode.commands.executeCommand('vpStudio.continue');
  } else if (m.type === 'disassembly') {
    await vscode.commands.executeCommand('vpStudio.showDisassembly');
  } else if (m.type === 'copy') {
    await vscode.env.clipboard.writeText(String(m.text || ''));
  } else {
    if (!supported()) throw new Error('not connected to a simulation that records exceptions');
    if (m.type === 'recording') await shared.agent.request('exc.setRecording', { recording: !!m.on });
    else if (m.type === 'clear') { await shared.agent.request('exc.clear'); lastSeq = 0; await refresh(true); return; }
  }
  await refresh(false);
}

/** From the agent's status: an exception catch stopped the simulation. */
function showHit(status) {
  const raw = status && status.state === 'paused' && status.reason === 'exception' ? status.exceptionHit : undefined;
  if (!raw || raw[0] === lastHitSeq) { if (panel) refresh(false).catch(() => {}); return; }
  lastHitSeq = raw[0];
  const e = exceptions.decode(raw);
  vscode.window.setStatusBarMessage(`VP Studio: stopped on ${e.title}`, 15000);
  if (!panel) cmdShowExceptions();
  else panel.reveal(undefined, true);
  startTimer();
}

/** The agent parameters and overrides that turn recording on at start (agent 0.15.0). */
function wanted(agentVersion, versionAtLeast) {
  return versionAtLeast(agentVersion, exceptions.MIN_AGENT) && common.cfg().get('exceptions.record') !== false;
}

exports.cmdShowExceptions = cmdShowExceptions;
exports.excConnected = excConnected;
exports.showHit = showHit;
exports.wanted = wanted;
