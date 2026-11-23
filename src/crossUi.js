'use strict';
// Cross-probing: at each new stop, the Peripheral Registers view marks the
// registers and fields that changed since the previous stop, and the
// Transaction Trace panel and the platform view's Transactions tab mark the
// bus accesses made since then. A stop is the debugger's stopped event when a
// target debug session is attached (stepping included), or else the sim
// agent's pause or halt. Clicking an access shows its register.
//
// With a debugger attached the agent's own state is not used to start a stop:
// after a single step the agent sees the VM's clock move and reports a short
// "running" ~200 ms later, which would make the values just read the base.
const vscode = require('vscode');
const registers = require('../lib/analysis/registers');
const shared = require('./shared');
const linuxUi = require('./linuxUi');
const traceUi = require('./traceUi');

let debugStopped = false;
let agentStopped = false;
let timer;
let boundary = 0; // trace sequence number at the last stop
let mark = { from: 0, to: 0 };

const debugActive = () => { const s = vscode.debug.activeDebugSession; return !!(s && s.type === linuxUi.DEBUG_TYPE); };

/** A stopped event of the target debug session (one per CPU at times: debounced). */
function debugStoppedEvent() {
  debugStopped = true;
  clearTimeout(timer);
  timer = setTimeout(() => newStop().catch(() => {}), 300);
}

/** The debugger resumes the target (continue or a step). */
function debugRunningEvent() {
  debugStopped = false;
  clearTimeout(timer);
  if (shared.registerTree) shared.registerTree.running();
}

/** The sim agent's state changed: paused or halted (stopped), or running. */
function agentState(stopped) {
  if (stopped === agentStopped) return;
  agentStopped = stopped;
  if (!shared.registerTree) return;
  if (debugActive()) { shared.registerTree.setReadable(stopped || debugStopped); return; }
  if (stopped) { clearTimeout(timer); timer = setTimeout(() => newStop().catch(() => {}), 300); } else shared.registerTree.running();
}

/** A session ended or a new simulation: forget the stops. */
function reset() { debugStopped = false; agentStopped = false; boundary = 0; mark = { from: 0, to: 0 }; clearTimeout(timer); }

async function newStop() {
  if (shared.registerTree) shared.registerTree.newStop();
  if (!shared.agent || !shared.agentMethods.includes('trace.getStatus')) return;
  let last;
  try { last = (await shared.agent.request('trace.getStatus')).lastSeq; } catch (e) { return; }
  if (typeof last !== 'number') return;
  const from = last < boundary ? 0 : boundary; // counting starts again after a clear
  boundary = last;
  mark = { from, to: last };
  traceUi.postStopMark(mark);
}

/** The marks for a page that opens now. */
const currentMark = () => mark;

/**
 * Show the register at a bus address in the Peripheral Registers view (the
 * one in Run and Debug while debugging), if a description covers it.
 */
async function revealRegister(address) {
  const tree = shared.registerTree;
  if (!tree || !shared.registerViews) return false;
  let hit;
  try { hit = registers.registerAt(tree.peripherals(), BigInt(address)); } catch (e) { return false; }
  if (!hit) return false;
  const el = tree.elementFor(hit.periph.id, hit.reg.name);
  if (!el) return false;
  const [main, inDebug] = shared.registerViews;
  const view = inDebug && (inDebug.visible || debugActive()) ? inDebug : main;
  try { await view.reveal(el, { select: true, focus: false, expand: true }); } catch (e) { return false; }
  return true;
}

exports.debugStoppedEvent = debugStoppedEvent;
exports.debugRunningEvent = debugRunningEvent;
exports.agentState = agentState;
exports.reset = reset;
exports.currentMark = currentMark;
exports.revealRegister = revealRegister;
