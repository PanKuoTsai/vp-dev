'use strict';
// Interrupts (GIC) panel: the state of every interrupt of the running
// platform's GICv3, read through the sim agent (mem.read), with the device that
// drives it and why it does not reach a CPU. Read when the simulation stops
// (paused, or halted by a debugger), on Refresh, and every second with Live.
const vscode = require('vscode');
const path = require('path');
const crypto = require('crypto');
const gic = require('../lib/analysis/gic');
const simagent = require('../lib/sim/simagent');
const gicview = require('../lib/webview/gicview');
const shared = require('./shared');
const common = require('./common');

let panel;
let live = false;
let timer;
let busy = false;
let lastState;

function cmdShowGic() {
  if (panel) { panel.reveal(undefined, false); refresh().catch(() => {}); return; }
  const name = shared.runningPlatform ? path.basename(shared.runningPlatform.fsPath, common.SUFFIX) : 'simulation';
  panel = vscode.window.createWebviewPanel('vpStudio.gic', `Interrupts: ${name}`,
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false }, { enableScripts: true, retainContextWhenHidden: true });
  panel.webview.html = gicview.render(crypto.randomBytes(16).toString('hex'), panel.webview.cspSource, `Interrupts (GIC): ${name}`);
  panel.onDidDispose(() => { panel = undefined; setLive(false); });
  panel.onDidChangeViewState(() => { if (panel && panel.visible && !live) refresh().catch(() => {}); });
  panel.webview.onDidReceiveMessage((m) => handle(m).catch((e) => vscode.window.showErrorMessage(`Interrupts: ${e.message}`)));
}

function setLive(on) {
  live = !!on;
  clearInterval(timer);
  timer = undefined;
  if (live) timer = setInterval(() => { if (panel && panel.visible) refresh().catch(() => {}); }, 1000);
}

/**
 * mem.read every request, a few at a time; a failed read gives no data for its
 * key. Agent 0.15.0 splits a request into register accesses itself (width);
 * an older one gets one request per register.
 */
async function readAll(reads, busIndex) {
  const width = shared.agentMethods.includes('exc.getStatus');
  const list = width ? reads : gic.oneByOne(reads);
  const out = [];
  for (let i = 0; i < list.length; i += 16) {
    const part = list.slice(i, i + 16);
    const got = await Promise.all(part.map((r) => shared.agent.request('mem.read', Object.assign({ address: gic.hexs(r.address), size: r.size, bus: busIndex }, width ? { width: r.width } : {}), { timeoutMs: 10000 })
      .then((x) => ({ read: r, data: x.data }), () => ({ read: r, data: '' }))));
    out.push(...got);
  }
  return out;
}

/** The distributor's head, then the redistributors one by one until GICR_TYPER.Last. */
async function readProbe(g) {
  const results = await readAll(gic.probeReads(g), g.bus);
  for (let i = 0; i < gic.redistFrames(g); i++) {
    const [res] = await readAll([gic.redistHeadRead(g, i)], g.bus);
    if (!res.data) break;
    results.push(res);
    const b = Buffer.from(res.data, 'hex');
    if (b.length >= 16 && (b.readUInt32LE(8) & 0x10)) break;
  }
  return gic.gather(results);
}

async function refresh() {
  if (!panel || busy) return;
  const post = (m) => panel && panel.webview.postMessage(Object.assign({ type: 'gic', live }, m));
  if (!shared.agent || !shared.runningDoc) { post({ problem: 'Start a simulation (VP Studio: Start Simulation) to see its interrupt controller.' }); return; }
  if (!shared.agentMethods.includes('mem.read')) { post({ problem: 'This sim agent cannot read registers (that needs agent 0.6.0). Run "VP Studio: Build Sim Agent" and start the simulation again.' }); return; }
  const gics = gic.layout(shared.runningDoc);
  if (!gics.length) { post({ problem: 'The running platform has no arm_gicv3 with its dist_iface and redist_iface on a bus.' }); return; }
  busy = true;
  try {
    const g = gics[0];
    const probeData = await readProbe(g);
    const probe = gic.parseProbe(g, probeData);
    if (!probe.redists.length || !probeData.get('dist.head') || !probeData.get('dist.head').length) {
      post({ problem: `Could not read ${g.name} at ${gic.hexs(g.dist)} through the sim agent.` });
      return;
    }
    const data = gic.gather(await readAll(gic.stateReads(g, probe), g.bus));
    for (const [k, v] of probeData) data.set(k, v);
    const st = gic.interpret(g, probe, data);
    const s = shared.agentStatus || {};
    lastState = st;
    post({
      gic: st.gic, dist: st.dist, cpus: st.cpus, summary: gic.summary(st), at: s.time ? simagent.formatTime(s.time.seconds) : '', running: s.state === 'running',
      others: gics.length > 1 ? gics.slice(1).map((x) => x.name) : [],
      rows: st.rows.map((r) => Object.assign({}, r, { interesting: gic.interesting(r) })),
    });
  } finally { busy = false; }
}

async function handle(m) {
  if (!m) return;
  if (m.type === 'ready' || m.type === 'refresh') await refresh();
  else if (m.type === 'live') { setLive(!!m.on); await refresh(); } else if (m.type === 'copy') await vscode.env.clipboard.writeText(String(m.text || ''));
}

/** From the agent's status: read again when the simulation stops (paused, or halted by a debugger). */
function onStatus(status, previous) {
  if (!panel || !panel.visible || !status) return;
  const stopped = (s) => s && (s.state === 'paused' || s.state === 'halted');
  if (stopped(status) && !stopped(previous)) refresh().catch(() => {});
}

exports.cmdShowGic = cmdShowGic;
exports.onStatus = onStatus;
exports.lastState = () => lastState;
