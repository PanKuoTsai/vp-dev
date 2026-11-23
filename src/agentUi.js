'use strict';
// The sim agent connection: connecting, status bar, pause, continue, run for and run until.
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const simagent = require('../lib/sim/simagent');
const launch = require('../lib/sim/launch');
const shared = require('./shared');
const common = require('./common');
const catalogUi = require('./catalogUi');
const traceUi = require('./traceUi');
const excUi = require('./excUi');
const gicUi = require('./gicUi');
const crossUi = require('./crossUi');
const profileUi = require('./profileUi');
const menuUi = require('./menuUi');

const AGENT_INSTANCE = launch.AGENT_INSTANCE;

/**
 * Path of the agent library without ".so" (QBox appends it), or undefined when
 * disabled or not built. "vpStudio.simAgent.library" empty means the copy
 * built in the extension folder by tools/sim-agent/build.sh.
 */
function simAgentLibrary({ quiet = false } = {}) {
  const setting = (common.cfg().get('simAgent.library') || '').trim();
  if (setting === 'none') return undefined;
  // sim_agent.so; vp_sim_agent.so is the name of builds before 2026-11-20.
  let file = setting || catalogUi.firstExisting(catalogUi.buildDir('sim-agent', 'sim_agent.so'), path.join(common.ROOT, 'tools', 'sim-agent', 'sim_agent.so'),
    catalogUi.buildDir('sim-agent', 'vp_sim_agent.so'), path.join(common.ROOT, 'tools', 'sim-agent', 'vp_sim_agent.so')) ||
    catalogUi.buildDir('sim-agent', 'sim_agent.so');
  if (!path.isAbsolute(file)) {
    const folder = (vscode.workspace.workspaceFolders || [])[0];
    if (folder) file = path.join(folder.uri.fsPath, file);
  }
  if (!file.endsWith('.so')) file += '.so';
  if (!fs.existsSync(file)) {
    if (!shared.agentLibWarned && !quiet) {
      shared.agentLibWarned = true;
      const own = !setting;
      vscode.window.showWarningMessage(
        `VP Studio: the sim agent is not built${own ? '' : ` (${file} not found)`}, so pause, continue, the parameter view, ` +
        'tracing and debugger time sync are off. ' +
        (own ? 'Build it once for your QBox with "VP Studio: Build Sim Agent".' : 'Build it, or fix "vpStudio.simAgent.library" ("none" hides this message).'),
        ...(own ? ['Build Sim Agent'] : []), 'Open Settings').then((p) => {
        if (p === 'Build Sim Agent') vscode.commands.executeCommand('vpStudio.buildSimAgent');
        else if (p === 'Open Settings') vscode.commands.executeCommand('workbench.action.openSettings', 'vpStudio.simAgent.library');
      });
    }
    return undefined;
  }
  return file.slice(0, -3);
}

function setAgentContext() {
  const paused = !!shared.agentStatus && shared.agentStatus.state === 'paused';
  menuUi.setCtx('vpStudio.agentConnected', !!shared.agent);
  menuUi.setCtx('vpStudio.paused', !!shared.agent && paused);
}

function updateAgentItem(phase) {
  if (phase === 'connecting') {
    shared.agentItem.text = '$(sync~spin) VP agent';
    shared.agentItem.tooltip = 'Waiting for the simulation to start the sim agent';
    shared.agentItem.command = undefined;
    shared.agentItem.show();
    return;
  }
  if (!shared.agent) { shared.agentItem.hide(); return; }
  const s = shared.agentStatus || {};
  const t = simagent.formatTime(s.time && s.time.seconds);
  if (s.state === 'paused') {
    shared.agentItem.text = `$(debug-continue) Paused at ${t}${s.breakpointHit ? ` · breakpoint #${s.breakpointHit.breakpoint}` : ''}${s.exceptionHit ? ` · exception on CPU ${s.exceptionHit[2]}` : ''}`;
    const tip = new vscode.MarkdownString('Simulation paused. Click to continue.\n\n'
      + '[Continue](command:vpStudio.continue) · [Run For…](command:vpStudio.runFor) · [Run Until…](command:vpStudio.runUntil)');
    tip.isTrusted = { enabledCommands: ['vpStudio.continue', 'vpStudio.runFor', 'vpStudio.runUntil'] };
    shared.agentItem.tooltip = tip;
    shared.agentItem.command = 'vpStudio.continue';
  } else if (s.state === 'halted') {
    shared.agentItem.text = `$(debug-breakpoint-unsupported) Halted by debugger at ${t}`;
    shared.agentItem.tooltip = 'A debugger has stopped the CPUs, so simulated time is stopped too. Continue in the debugger to resume.';
    shared.agentItem.command = undefined;
  } else if (s.stopAt) {
    const at = simagent.formatTime(s.stopAt.seconds);
    shared.agentItem.text = `$(debug-pause) ${t} → ${at}`;
    shared.agentItem.tooltip = `Simulated time. Pauses by itself at ${at}. Click to pause now.`;
    shared.agentItem.command = 'vpStudio.pause';
  } else {
    shared.agentItem.text = `$(debug-pause) ${t}`;
    shared.agentItem.tooltip = 'Simulated time. Click to pause the simulation.';
    shared.agentItem.command = 'vpStudio.pause';
  }
  shared.agentItem.show();
}

function applyStatus(status) {
  if (!status || typeof status !== 'object') return;
  const wasPaused = shared.agentStatus && shared.agentStatus.state === 'paused';
  const previous = shared.agentStatus;
  shared.agentStatus = status;
  setAgentContext();
  updateAgentItem();
  traceUi.showHit(status);
  excUi.showHit(status);
  gicUi.onStatus(status, previous);
  if (status.restore && status.restore.state === 'failed' && !shared.restoreReported) {
    shared.restoreReported = true;
    vscode.window.showErrorMessage(`The checkpoint could not be loaded, so the simulation stays paused: ${status.restore.error}`, 'Check QBox Version')
      .then((x) => x && vscode.commands.executeCommand('vpStudio.checkQBox'));
  }
  if (status.reason === 'time' && status.state === 'paused' && status.time && status.requestedTime) {
    vscode.window.setStatusBarMessage(`VP Studio: paused at ${simagent.formatTime(status.time.seconds)} as requested (${simagent.formatTime(status.requestedTime.seconds)})`, 8000);
  }
  // Parameters may change while running; reading them on pause gives a consistent snapshot.
  if (status.state === 'paused' && !wasPaused) shared.paramTree.load();
  const stopped = status.state === 'paused' || status.state === 'halted';
  crossUi.agentState(stopped);
}

/** Connect to an agent. auto: started by "Start Simulation", so wait for elaboration and stay quiet on failure. */
async function connectAgent({ host = '127.0.0.1', port, auto, handshake = false }) {
  disconnectAgent();
  const attempt = ++shared.agentAttempt;
  updateAgentItem('connecting');
  const client = await simagent.connectWithRetry({
    host, port, totalMs: auto ? 120000 : 3000, shouldStop: () => attempt !== shared.agentAttempt, handshake,
  });
  if (attempt !== shared.agentAttempt) { if (client) client.close(); return; }
  if (!client) {
    updateAgentItem();
    const msg = `Could not connect to the sim agent at ${host}:${port}.`;
    if (auto) vscode.window.setStatusBarMessage(`VP Studio: ${msg}`, 10000);
    else vscode.window.showErrorMessage(msg);
    return;
  }
  let info;
  try {
    info = await client.request('agent.getInfo');
    if (info.protocol !== simagent.PROTOCOL) {
      client.close();
      vscode.window.showErrorMessage(`The sim agent speaks protocol ${info.protocol}; this extension needs ${simagent.PROTOCOL}. Rebuild tools/sim-agent.`);
      updateAgentItem();
      return;
    }
  } catch (e) {
    client.close();
    updateAgentItem();
    if (!auto) vscode.window.showErrorMessage(`Sim agent at ${host}:${port}: ${e.message}`);
    return;
  }
  if (attempt !== shared.agentAttempt) { client.close(); return; }
  shared.agent = client;
  shared.agentStatus = undefined;
  shared.agentMethods = Array.isArray(info.methods) ? info.methods : [];
  client.on('notification', (method, params) => { if (method === 'sim.stateChanged') applyStatus(params); });
  client.on('close', () => {
    if (shared.agent !== client) return;
    shared.agent = undefined;
    shared.agentStatus = undefined;
    clearInterval(shared.agentPoll);
    setAgentContext();
    updateAgentItem();
    shared.paramTree.clear();
    traceUi.traceDisconnected();
    clearInterval(shared.profileTimer); shared.profileTimer = undefined; // the next connection starts it again
  });
  let busy = false;
  const poll = async () => {
    if (busy || shared.agent !== client) return;
    busy = true;
    try { applyStatus(await client.request('sim.getStatus')); } catch (e) { /* closed or slow: next tick */ }
    busy = false;
  };
  shared.agentPoll = setInterval(poll, 1000);
  await poll();
  shared.paramTree.load();  traceUi.traceConnected(); profileUi.profileConnected(); excUi.excConnected();
}

function disconnectAgent() {
  shared.agentAttempt++;
  if (shared.agent) shared.agent.close(); // the close handler resets the state
  else if (shared.agentItem) updateAgentItem();
}

async function agentCall(method, params) {
  if (!shared.agent) {
    vscode.window.showWarningMessage('Not connected to a simulation. Start one with "VP Studio: Start Simulation", or run "VP Studio: Connect to Sim Agent".');
    return undefined;
  }
  try {
    return await shared.agent.request(method, params);
  } catch (e) {
    vscode.window.showErrorMessage(`${method} failed: ${e.message}`);
    return undefined;
  }
}

async function cmdPause() { applyStatus(await agentCall('sim.pause')); }
async function cmdContinue() { applyStatus(await agentCall('sim.continue')); }

/** Run for a while (absolute: until a simulated time), then pause. */
async function runTimed(absolute) {
  const method = absolute ? 'sim.runUntil' : 'sim.runFor';
  if (!shared.agent) return agentCall(method);
  if (!shared.agentMethods.includes(method)) {
    const p = await vscode.window.showWarningMessage(
      'This sim agent cannot stop at a simulated time (that needs agent 0.4.0 or later). Rebuild it, then restart the simulation.',
      'Build Sim Agent');
    if (p) vscode.commands.executeCommand('vpStudio.buildSimAgent');
    return undefined;
  }
  if (shared.agentStatus && shared.agentStatus.state === 'halted') {
    vscode.window.showWarningMessage('A debugger has the target stopped. Continue in the debugger first.');
    return undefined;
  }
  const now = shared.agentStatus && shared.agentStatus.time ? shared.agentStatus.time.seconds : undefined;
  const key = absolute ? 'vpStudio.runUntil.last' : 'vpStudio.runFor.last';
  const input = await vscode.window.showInputBox({
    title: absolute ? 'Run Until' : 'Run For',
    prompt: absolute
      ? `Simulated time to pause at${now !== undefined ? ` (now ${simagent.formatTime(now)})` : ''}. Units: s, ms, us, ns, ps.`
      : 'Simulated time to run before pausing. Units: s, ms, us, ns, ps.',
    value: shared.extContext.workspaceState.get(key, absolute ? '' : '100 ms'),
    placeHolder: absolute ? '30 s' : '100 ms',
    validateInput: (v) => {
      try {
        const t = simagent.parseSimTime(v);
        if (absolute && now !== undefined && t.seconds <= now) return `Enter a time after the current time (${simagent.formatTime(now)})`;
        if (!absolute && t.seconds === 0) return 'Enter a time greater than 0';
        return undefined;
      } catch (e) {
        return e.message;
      }
    },
  });
  if (input === undefined) return undefined;
  const t = simagent.parseSimTime(input);
  await shared.extContext.workspaceState.update(key, input.trim());
  const status = await agentCall(method, absolute ? { time: t.text } : { duration: t.text });
  applyStatus(status);
  return status;
}

async function cmdConnectAgent() {
  const input = await vscode.window.showInputBox({
    title: 'Connect to Sim Agent',
    prompt: 'Address of a running simulation\'s sim agent (it prints "sim-agent: listening on HOST:PORT" at start)',
    placeHolder: '127.0.0.1:51000',
    validateInput: (v) => (/^([^:\s]+:)?\d{1,5}$/.test(v.trim()) ? undefined : 'Enter PORT or HOST:PORT'),
  });
  if (!input) return;
  const m = /^(?:([^:\s]+):)?(\d+)$/.exec(input.trim());
  shared.runningPlatform = undefined; // started elsewhere: which platform it runs is unknown
  await connectAgent({ host: m[1] || '127.0.0.1', port: Number(m[2]), auto: false });
}

exports.AGENT_INSTANCE = AGENT_INSTANCE;
exports.simAgentLibrary = simAgentLibrary;
exports.setAgentContext = setAgentContext;
exports.connectAgent = connectAgent;
exports.disconnectAgent = disconnectAgent;
exports.cmdPause = cmdPause;
exports.cmdContinue = cmdContinue;
exports.runTimed = runTimed;
exports.cmdConnectAgent = cmdConnectAgent;
