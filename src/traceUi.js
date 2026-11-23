'use strict';
// Transaction trace: the panel, probes, bus breakpoints and Start Simulation with Tracing.
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const core = require('../lib/platform/core');
const trace = require('../lib/analysis/trace');
const traceview = require('../lib/webview/traceview');
const shared = require('./shared');
const crossUi = require('./crossUi');
const common = require('./common');
const catalogUi = require('./catalogUi');
const platformFiles = require('./platformFiles');
const simUi = require('./simUi');
const agentUi = require('./agentUi');
const platformView = require('./platformView');

const TRACE_KEEP = 100000;

const breaksKey = 'vpStudio.breakpoints';
function breaks() {
  if (!shared.traceBreaks) shared.traceBreaks = (shared.extContext && shared.extContext.workspaceState.get(breaksKey, [])) || [];
  return shared.traceBreaks;
}
async function saveBreaks(list) {
  shared.traceBreaks = list;
  if (shared.extContext) await shared.extContext.workspaceState.update(breaksKey, list);
}
const breakActive = (b) => !b.point || shared.tracePoints.includes(b.point);

/** Send the breakpoints to the agent (when it can take them) and show them in the panel. */
async function syncBreaks({ added = false, error } = {}) {
  const list = breaks();
  if (shared.agent && shared.agentMethods.includes('break.set')) {
    try {
      const st = await shared.agent.request('trace.getStatus');
      shared.tracePoints = st.points || shared.tracePoints;
      showProbes(st);
      await shared.agent.request('break.set', { breakpoints: list.filter(breakActive) });
    } catch (e) {
      error = error || `The simulator did not take the breakpoints: ${e.message}`;
    }
  } else if (shared.agent && list.length && !error) {
    error = 'This sim agent has no bus breakpoints (they need agent 0.5.0 or later): run "VP Studio: Build Sim Agent", then restart the simulation.';
    if (shared.oldAgentWarned !== shared.agent) {
      shared.oldAgentWarned = shared.agent;
      vscode.window.showWarningMessage('VP Studio: the running simulation\'s sim agent is too old for bus breakpoints (they need 0.5.0). Build the new agent, then stop and start the simulation again.', 'Build Sim Agent')
        .then((p) => p && vscode.commands.executeCommand('vpStudio.buildSimAgent'));
    }
  }
  if (shared.tracePanel) {
    shared.tracePanel.webview.postMessage({
      type: 'breakpoints', added, error,
      list: list.map((b) => ({ id: b.id, label: trace.breakLabel(b), active: !shared.agent || breakActive(b) })),
    });
  }
}

/** Keep the probes of a trace.getStatus result and show them in the trace panel. */
function showProbes(st) {
  if (st && Array.isArray(st.probes)) shared.traceProbes = st.probes;
  postTxState();
  if (shared.tracePanel) {
    shared.tracePanel.webview.postMessage({
      type: 'probes', list: shared.traceProbes, choose: !!shared.agent && shared.agentMethods.includes('trace.setPoints'),
      hint: shared.agent && !shared.agentMethods.includes('trace.setPoints') ? 'This sim agent records at every tracer it was started with. To turn probes on and off while running, build sim agent 0.9.0 and start again.' : '',
    });
  }
}

/** Tell the trace panel (and the status bar) about a breakpoint hit, or that it is over. */
function showHit(status) {
  const hit = status && status.state === 'paused' ? status.breakpointHit : undefined;
  if (shared.tracePanel) shared.tracePanel.webview.postMessage({ type: 'hit', text: hit ? trace.describeHit(hit) : null, seq: hit && hit.record.seq });
  if (hit && status.reason === 'breakpoint') {
    vscode.window.setStatusBarMessage(`VP Studio: ${trace.describeHit(hit).split(/\.(?: |$)/)[0]}`, 10000);
    showTracePanel(true);
  }
}

/**
 * A bus access clicked in the trace panel: its route (initiator -> router ->
 * device) lit up in the platform view of the running simulation. The view is
 * opened or moved next to the trace panel, never on top of it.
 */
async function showRouteInPlatform(m) {
  const uri = shared.runningPlatform;
  if (!uri) {
    vscode.window.showInformationMessage('VP Studio: routes are shown for a simulation started with Start Simulation (a manual Connect does not say which platform it runs).');
    return;
  }
  const n = Number(m.length);
  const detail = `${m.dir === 'W' ? 'write' : 'read'} ${m.address}${n ? ` · ${n} byte${n === 1 ? '' : 's'}` : ''}${m.value ? ` · ${m.value}` : ''} · ${Number(m.time).toFixed(6)} s · #${m.seq}` +
    (m.initiator ? '' : ' · initiator unknown (it needs sim agent 0.12.0)');
  const spec = { region: m.point, initiator: m.initiator || undefined, detail };
  const key = uri.toString();
  const panel = common.panels.get(key);
  const traceCol = shared.tracePanel && shared.tracePanel.viewColumn;
  const other = traceCol === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One;
  if (panel && panel.visible && panel.viewColumn !== traceCol) {
    panel.webview.postMessage({ type: 'route', spec });
    return;
  }
  common.pendingRoute.set(key, { id: ++shared.routeSeq, spec });
  if (panel) {
    await platformView.renderPanel(uri, panel);
    panel.reveal(panel.viewColumn === traceCol ? other : panel.viewColumn, true);
    return;
  }
  await platformView.cmdShowPlatform(uri, { column: other, preserveFocus: true });
}

function showTracePanel(preserveFocus) {
  if (shared.tracePanel) { shared.tracePanel.reveal(undefined, preserveFocus); return; }
  shared.tracePanel = vscode.window.createWebviewPanel('vpStudio.trace', shared.traceTitle,
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: !!preserveFocus }, { enableScripts: true, retainContextWhenHidden: true });
  const nonce = crypto.randomBytes(16).toString('hex');
  shared.tracePanel.webview.html = traceview.render(nonce, shared.tracePanel.webview.cspSource, shared.traceTitle);
  shared.tracePanel.onDidDispose(() => { shared.tracePanel = undefined; if (!traceWanted()) { clearInterval(shared.traceTimer); shared.traceTimer = undefined; } });
  shared.tracePanel.webview.onDidReceiveMessage((m) => handleTraceMessage(m).catch((e) => vscode.window.showErrorMessage(`Trace: ${e.message}`)));
}

async function handleTraceMessage(m) {
  if (!m) return;
  if (m.type === 'ready') {
    // A (re)loaded page gets what was already read, then the polling continues.
    if (shared.traceRecords.length) shared.tracePanel.webview.postMessage({ type: 'records', records: shared.traceRecords, points: shared.tracePoints });
    shared.tracePanel.webview.postMessage(Object.assign({ type: 'stopMark' }, crossUi.currentMark()));
    traceConnected();
    await syncBreaks();
    showHit(shared.agentStatus);
  } else if (m.type === 'clear') {
    if (shared.agent) await shared.agent.request('trace.clear');
    shared.traceRecords = [];
    if (shared.tracePanel) shared.tracePanel.webview.postMessage({ type: 'cleared' });
    postTx({ type: 'tx', records: [], reset: true });
  } else if (m.type === 'setRecording') {
    if (!shared.agent) throw new Error('not connected to a simulation');
    const st = await shared.agent.request('trace.setEnabled', { enabled: !!m.enabled });
    if (shared.tracePanel) shared.tracePanel.webview.postMessage({ type: 'recording', enabled: st.enabled });
  } else if (m.type === 'addBreak') {
    let spec;
    try {
      spec = trace.parseBreakInput(m);
    } catch (e) {
      await syncBreaks({ error: e.message });
      return;
    }
    const list = breaks();
    spec.id = list.reduce((n, b) => Math.max(n, b.id), 0) + 1;
    await saveBreaks([...list, spec]);
    await syncBreaks({ added: true });
  } else if (m.type === 'removeBreak') {
    await saveBreaks(breaks().filter((b) => b.id !== m.id));
    await syncBreaks();
  } else if (m.type === 'showRoute') {
    if (m.dir !== 'S') crossUi.revealRegister(m.address).catch(() => {});
    await showRouteInPlatform(m);
  } else if (m.type === 'continue') {
    await agentUi.cmdContinue();
  } else if (m.type === 'chooseProbes') {
    await cmdChooseProbes();
  } else if (m.type === 'stopProbe') {
    if (!shared.agent) throw new Error('not connected to a simulation');
    showProbes(await shared.agent.request('trace.setPoints', { points: [m.name], recording: false }));
    await rememberProbes();
  } else if (m.type === 'exportVcd') {
    const sig = shared.traceRecords.filter((r) => r.dir === 'S');
    if (!sig.length) {
      vscode.window.showInformationMessage('No signal changes to export. Turn on a signal probe (an interrupt line) with "Probes…", or choose one under "Signals" in Start Simulation with Tracing.');
      return;
    }
    const folder = (vscode.workspace.workspaceFolders || [])[0];
    const target = await vscode.window.showSaveDialog({
      defaultUri: folder ? vscode.Uri.joinPath(folder.uri, 'signals.vcd') : undefined, filters: { VCD: ['vcd'] }, title: 'Export the signal changes as VCD',
    });
    if (!target) return;
    // Changes older than the ones kept here are gone, so the level before the first one is unknown then.
    const dropped = shared.traceRecords.length >= TRACE_KEEP || shared.traceDropped > 0;
    await fs.promises.writeFile(target.fsPath, trace.toVcd(shared.traceRecords, { initial: dropped ? 'x' : '0' }), 'utf8');
    vscode.window.showInformationMessage(`Exported ${sig.length} signal changes to ${vscode.workspace.asRelativePath(target)}. Open it with a waveform viewer such as GTKWave.`);
  } else if (m.type === 'export') {
    if (!shared.traceRecords.length) { vscode.window.showInformationMessage('No accesses to export yet.'); return; }
    const folder = (vscode.workspace.workspaceFolders || [])[0];
    const target = await vscode.window.showSaveDialog({
      defaultUri: folder ? vscode.Uri.joinPath(folder.uri, 'trace.csv') : undefined, filters: { CSV: ['csv'] }, title: 'Export the transaction trace',
    });
    if (!target) return;
    await fs.promises.writeFile(target.fsPath, trace.toCsv(shared.traceRecords), 'utf8');
    vscode.window.showInformationMessage(`Exported ${shared.traceRecords.length} accesses to ${vscode.workspace.asRelativePath(target)}.`);
  }
}

// Platform views showing their Transactions tab (uri strings). Only the view
// of the running platform gets records; the others are told whose they are.
const txWatch = new Set();
const txKey = () => (shared.runningPlatform ? shared.runningPlatform.toString() : '');
const txWatching = () => !!txKey() && txWatch.has(txKey());
const traceWanted = () => !!shared.tracePanel || txWatching();

/** What the Transactions tab of the platform view at key shows above its table. */
function txState(key) {
  const mine = !!shared.runningPlatform && shared.runningPlatform.toString() === key;
  const on = shared.traceProbes.filter((p) => p.recording).length;
  return {
    type: 'txState', mine, connected: mine && !!shared.agent, other: !mine && !!shared.runningPlatform && !!shared.agent ? path.basename(shared.runningPlatform.fsPath, common.SUFFIX) : '',
    probes: shared.traceProbes.length, recordingProbes: on, kept: shared.traceRecords.length,
  };
}
function postTxState() {
  for (const key of txWatch) { const p = common.panels.get(key); if (p) p.webview.postMessage(txState(key)); }
}
/** Mark the accesses made since the previous stop, in the panel and the Transactions tab (cross-probing). */
function postStopMark(mark) {
  const msg = { type: 'stopMark', from: mark.from, to: mark.to };
  if (shared.tracePanel) shared.tracePanel.webview.postMessage(msg);
  postTx(msg);
}

function postTx(msg) {
  if (!txWatching()) return;
  const p = common.panels.get(txKey());
  if (p) p.webview.postMessage(msg);
}

/** Poll the agent for new trace records while the panel or a Transactions tab is open and a simulation is connected. */
function traceConnected() {
  postTxState();
  if (!traceWanted() || !shared.agent || shared.traceTimer) return;
  const client = shared.agent;
  let busy = false;
  const tick = async () => {
    if (busy || shared.agent !== client) return;
    if (!traceWanted()) { clearInterval(shared.traceTimer); shared.traceTimer = undefined; return; }
    busy = true;
    try {
      // Drain in pages so a burst (console output, say) does not lag behind.
      for (let pages = 0; pages < 10; pages++) {
        const res = await client.request('trace.read', { since: shared.traceSince, max: 5000 });
        const recs = trace.decodeRecords(res);
        shared.tracePoints = res.points || shared.tracePoints;
        shared.traceDropped = res.dropped || 0;
        if (recs.length) {
          shared.traceSince = recs[recs.length - 1].seq;
          shared.traceRecords.push(...recs);
          if (shared.traceRecords.length > TRACE_KEEP) shared.traceRecords = shared.traceRecords.slice(shared.traceRecords.length - TRACE_KEEP);
        } else if (res.lastSeq < shared.traceSince) {
          shared.traceSince = 0; // the simulator counts from 0 again (a new run, or cleared)
        }
        if (shared.tracePanel) shared.tracePanel.webview.postMessage({ type: 'records', records: recs, points: shared.tracePoints, status: { lastSeq: res.lastSeq, dropped: res.dropped } });
        if (recs.length) postTx({ type: 'tx', records: recs, status: { lastSeq: res.lastSeq, dropped: res.dropped } });
        if (recs.length < 5000) break;
      }
    } catch (e) { /* closed or slow: next tick */ }
    busy = false;
  };
  shared.traceTimer = setInterval(tick, 500);
  tick();
  syncBreaks().catch(() => {});
}

function traceDisconnected() {
  clearInterval(shared.traceTimer);
  shared.traceTimer = undefined;
  if (shared.tracePanel) shared.tracePanel.webview.postMessage({ type: 'ended' });
  postTxState();
}

/** Probes recording now, remembered per platform as the next "Start Simulation with Tracing" choice. */
async function rememberProbes() {
  if (!shared.extContext || !shared.runningPlatform) return;
  await shared.extContext.workspaceState.update(`vpStudio.trace.${shared.runningPlatform.toString()}`, shared.traceProbes.filter((p) => p.recording).map((p) => p.name));
}

/**
 * G-12: choose which probes of the running simulation record. Every place a
 * probe fits got one at the start; this only turns recording on and off.
 */
async function cmdChooseProbes() {
  if (!shared.agent) {
    vscode.window.showWarningMessage('Not connected to a simulation. Start one with "VP Studio: Start Simulation".');
    return;
  }
  if (!shared.agentMethods.includes('trace.setPoints')) {
    const p = await vscode.window.showWarningMessage('This sim agent cannot turn probes on and off while running (that needs agent 0.9.0). Build the new agent, then stop and start the simulation again.', 'Build Sim Agent');
    if (p) vscode.commands.executeCommand('vpStudio.buildSimAgent');
    return;
  }
  const st = await shared.agent.request('trace.getStatus');
  showProbes(st);
  if (!shared.traceProbes.length) {
    vscode.window.showInformationMessage(common.cfg().get('probes.insertAll') === false
      ? 'This simulation has no probes: "vpStudio.probes.insertAll" is off. Turn it on and start again, or use "Start Simulation with Tracing".'
      : 'This simulation has no probes: the platform has no bus-mapped port or signal a probe fits in (replicated modules and {i} ports are left out).');
    return;
  }
  const info = new Map((shared.runningDoc ? trace.probeList(shared.runningDoc, catalogUi.catalog()) : []).map((p) => [p.id, p]));
  const KIND = { bus: 'Bus', memory: 'Memory', signal: 'Signals' };
  const items = [];
  for (const kind of ['bus', 'memory', 'signal']) {
    const list = shared.traceProbes.filter((p) => p.kind === kind);
    if (!list.length) continue;
    items.push({ label: KIND[kind], kind: vscode.QuickPickItemKind.Separator });
    for (const p of list) {
      items.push({
        label: p.name, picked: p.recording, name: p.name,
        description: (info.get(p.name) || {}).description || kind,
        detail: kind === 'memory' ? 'While it records, CPUs lose direct access (DMI) to this memory: every access is seen, and the simulation runs slower' : undefined,
      });
    }
  }
  const picked = await common.pickMany(items, {
    title: 'Probes: choose which ones record',
    placeHolder: 'Every bus-mapped port and signal has a probe; the checked ones record. Changes apply at once, without a restart.',
  });
  if (!picked || !shared.agent) return;
  const want = new Set(picked.map((p) => p.name));
  const on = shared.traceProbes.filter((p) => want.has(p.name) && !p.recording).map((p) => p.name);
  const off = shared.traceProbes.filter((p) => !want.has(p.name) && p.recording).map((p) => p.name);
  let res;
  if (off.length) res = await shared.agent.request('trace.setPoints', { points: off, recording: false });
  if (on.length) res = await shared.agent.request('trace.setPoints', { points: on, recording: true });
  if (res) showProbes(res);
  await rememberProbes();
  if (on.length) {
    showTracePanel(true);
    traceConnected();
    if (!res.enabled) {
      const p = await vscode.window.showInformationMessage('Recording is paused in the Transaction Trace panel, so the probes record nothing yet.', 'Resume Recording');
      if (p && shared.agent) { const s = await shared.agent.request('trace.setEnabled', { enabled: true }); if (shared.tracePanel) shared.tracePanel.webview.postMessage({ type: 'recording', enabled: s.enabled }); }
    }
  }
}

/** Ask which bus-mapped ports to trace, then start the simulation with tracers in front of them. */
async function cmdStartTrace(context, arg) {
  const uri = await platformFiles.pickPlatform(arg);
  if (!uri) return;
  const loaded = await platformFiles.load(uri);
  if (!loaded) return;
  const points = trace.tracePoints(loaded.data);
  const signals = trace.signalPoints(loaded.data, catalogUi.catalog());
  if (!points.length && !signals.length) { vscode.window.showWarningMessage('This platform has no bus-mapped port or signal that can be traced.'); return; }
  const key = `vpStudio.trace.${uri.toString()}`;
  const last = context.workspaceState.get(key);
  const items = points.map((p) => ({
    label: p.id,
    description: `${p.address === null ? '?' : core.hex(p.address)}${p.size !== null && p.size !== undefined ? ` (${core.hex(p.size)})` : ''} · ${p.type}`,
    detail: p.memory ? 'Memory: traced with DMI on, so accesses the CPU makes directly are not seen' : undefined,
    picked: last ? last.includes(p.id) : !p.memory,
    id: p.id,
  }));
  if (signals.length) {
    items.push({ label: 'Signals', kind: vscode.QuickPickItemKind.Separator });
    for (const s of signals) {
      items.push({ label: s.id, description: `→ ${s.dest}.${s.destPort} · signal`, picked: last ? last.includes(s.id) : false, id: s.id });
    }
  }
  const picked = await common.pickMany(items, {
    title: 'Start Simulation with Tracing',
    placeHolder: 'Bus-mapped ports to record accesses to, and signals (interrupt lines) to record changes of',
  });
  if (!picked || !picked.length) return;
  const ids = picked.map((p) => p.id);
  await context.workspaceState.update(key, ids);
  shared.traceSince = 0;
  shared.traceRecords = [];
  if (shared.tracePanel) shared.tracePanel.webview.postMessage({ type: 'cleared' });
  postTx({ type: 'tx', records: [], reset: true });
  await simUi.start(uri, false, ids);
}

exports.showHit = showHit;
exports.postStopMark = postStopMark;
exports.showTracePanel = showTracePanel;
exports.txWatch = txWatch;
exports.txState = txState;
exports.traceConnected = traceConnected;
exports.traceDisconnected = traceDisconnected;
exports.cmdChooseProbes = cmdChooseProbes;
exports.cmdStartTrace = cmdStartTrace;
