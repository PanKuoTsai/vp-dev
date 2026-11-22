'use strict';
// Profile (G-05): the panel, the symbol file and the KASLR offset.
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const core = require('../lib/platform/core');
const images = require('../lib/platform/images');
const elfsym = require('../lib/analysis/elfsym');
const profile = require('../lib/analysis/profile');
const profileview = require('../lib/webview/profileview');
const shared = require('./shared');
const common = require('./common');
const platformFiles = require('./platformFiles');
const simUi = require('./simUi');

async function cmdStartProfile(arg) {
  const uri = await platformFiles.pickPlatform(arg);
  if (!uri) return;
  await simUi.start(uri, false, [], { profile: true });
}

function showProfilePanel(uri, preserveFocus) {
  if (shared.profilePanel) { shared.profilePanel.reveal(undefined, preserveFocus); return; }
  const name = uri ? path.basename(uri.fsPath, common.SUFFIX) : 'simulation';
  shared.profilePanel = vscode.window.createWebviewPanel('vpStudio.profile', `Profile: ${name}`,
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: !!preserveFocus }, { enableScripts: true, retainContextWhenHidden: true });
  const nonce = crypto.randomBytes(16).toString('hex');
  shared.profilePanel.webview.html = profileview.render(nonce, shared.profilePanel.webview.cspSource, `Profile: ${name}`);
  shared.profilePanel.onDidDispose(() => { shared.profilePanel = undefined; clearInterval(shared.profileTimer); shared.profileTimer = undefined; });
  shared.profilePanel.webview.onDidReceiveMessage((m) => handleProfileMessage(m).catch((e) => vscode.window.showErrorMessage(`Profile: ${e.message}`)));
}

/** The symbol file for the profile: chosen for this platform, else the platform's first one. */
function profileSymbolFile() {
  const uri = shared.profileState.uri;
  if (!uri) return undefined;
  const chosen = shared.extContext && shared.extContext.workspaceState.get(`vpStudio.profileSymbols.${uri.toString()}`);
  if (chosen) return chosen;
  try {
    const files = images.collect(shared.runningDoc, core.analyze(shared.runningDoc), path.dirname(uri.fsPath)).symbolFiles;
    return files[0];
  } catch (e) { return undefined; }
}

function loadProfileSymbols() {
  const file = profileSymbolFile();
  if (!file) { shared.profileSymbols = undefined; return undefined; }
  let mtime = 0;
  try { mtime = fs.statSync(file).mtimeMs; } catch (e) { return (shared.profileSymbols = { file, error: 'not found' }); }
  if (shared.profileSymbols && shared.profileSymbols.file === file && shared.profileSymbols.mtime === mtime) return shared.profileSymbols;
  try {
    shared.profileSymbols = { file, mtime, symbols: elfsym.readSymbols(file) };
  } catch (e) {
    shared.profileSymbols = { file, mtime, error: e.message };
  }
  shared.profileState.offset = undefined; // a new file: find the offset again
  return shared.profileSymbols;
}

/**
 * KASLR offset of an arm64 Linux kernel: find the loaded image with the arm64
 * Image magic and read the kimage_vaddr it relocated at boot (lib/analysis/profile.js).
 * 0 when it cannot tell (no such symbol, image or bus access).
 */
async function findKernelOffset(symbols) {
  const kv = profile.kimageVaddrOffset(symbols);
  if (!kv || !shared.agent || !shared.agentMethods.includes('mem.read') || !shared.runningDoc) return 0n;
  let loaders = [];
  try { loaders = images.collect(shared.runningDoc, core.analyze(shared.runningDoc), path.dirname(shared.profileState.uri.fsPath)).loaders; } catch (e) { return 0n; }
  for (const l of loaders) {
    for (const e of l.entries) {
      const at = e.ranges && e.ranges[0] && e.ranges[0].start;
      if (at === undefined || e.kind !== 'bin') continue;
      try {
        const m = await shared.agent.request('mem.read', { address: '0x' + (BigInt(at) + 0x38n).toString(16), size: 4 });
        if (!profile.isArm64Image(m.data)) continue;
        const v = await shared.agent.request('mem.read', { address: '0x' + (BigInt(at) + kv.offset).toString(16), size: 8 });
        return profile.kaslrOffset(v.data, kv.text);
      } catch (err) { /* not mapped or no bus: try the next */ }
    }
  }
  return 0n;
}

async function refreshProfile() {
  if (!shared.profilePanel || !shared.agent) return;
  if (!shared.agentMethods.includes('profile.read')) {
    shared.profilePanel.webview.postMessage({ type: 'profile', problem: 'this sim agent cannot profile (that needs agent 0.8.0); run "VP Studio: Build Sim Agent" and start again', rows: [] });
    return;
  }
  const res = await shared.agent.request('profile.read', shared.profileCpu === '' ? {} : { cpu: Number(shared.profileCpu) }, { timeoutMs: 30000 });
  const sym = loadProfileSymbols();
  const fns = sym && sym.symbols ? sym.symbols.functions : [];
  if (sym && sym.symbols && (shared.profileState.offset === undefined || (shared.profileState.retry && Date.now() - shared.profileState.offsetAt > 10000))) {
    shared.profileState.offset = await findKernelOffset(sym.symbols);
    shared.profileState.offsetAt = Date.now();
  }
  const offset = shared.profileState.offset || 0n;
  const sum = profile.summarize(res.blocks || [], fns, offset);
  const warning = profile.symbolWarning(sum, !!(sym && sym.symbols)) || (sym && sym.error ? `Symbol file ${sym.file}: ${sym.error}` : '');
  shared.profileState.retry = !!warning; // the kernel may not have relocated itself yet when it was read
  const shown = res.cpus.filter((c) => shared.profileCpu === '' || String(c.cpu) === shared.profileCpu).reduce((s, c) => s + c.samples, 0);
  const text = !res.active ? '' : `${sum.total} samples${shared.profileCpu === '' ? '' : ` on cpu ${shared.profileCpu}`} (one every ${res.period} instructions, about ${(shown * res.period / 1e9).toFixed(2)} billion instructions) in the last ${res.seconds.toFixed(0)} s of host time` +
    (offset ? ` · kernel KASLR offset 0x${offset.toString(16)}` : '') + (res.enabled ? '' : ' · sampling is off');
  shared.profilePanel.webview.postMessage({
    type: 'profile', active: res.active, problem: res.problem || (res.active ? '' : 'the simulation was not started with profiling'),
    enabled: res.enabled, cpus: res.cpus, total: sum.total, text, warning,
    stats: res.active ? { cpu: shared.profileCpu, period: res.period, instructions: shown * res.period, seconds: res.seconds, offset: offset ? `0x${offset.toString(16)}` : '' } : {},
    symbolFile: sym ? path.basename(sym.file) : '', rows: sum.rows.slice(0, 300),
  });
}

function profileConnected() {
  if (!shared.profilePanel || !shared.agent || shared.profileTimer) return;
  const client = shared.agent;
  let busy = false;
  shared.profileTimer = setInterval(async () => {
    if (busy || shared.agent !== client) return;
    busy = true;
    try { await refreshProfile(); } catch (e) { /* next tick */ }
    busy = false;
  }, 2000);
  refreshProfile().catch(() => {});
}

async function handleProfileMessage(m) {
  if (!m) return;
  if (m.type === 'ready') { profileConnected(); return; }
  if (!shared.agent) throw new Error('not connected to a simulation');
  if (m.type === 'cpu') shared.profileCpu = String(m.cpu || '');
  else if (m.type === 'sampling') await shared.agent.request('profile.setEnabled', { enabled: !!m.enabled });
  else if (m.type === 'reset') await shared.agent.request('profile.reset');
  else if (m.type === 'chooseSymbols') {
    const picked = await vscode.window.showOpenDialog({ canSelectMany: false, title: 'Symbol file of the software to profile (for example vmlinux)' });
    if (!picked || !picked.length || !shared.profileState.uri) return;
    await shared.extContext.workspaceState.update(`vpStudio.profileSymbols.${shared.profileState.uri.toString()}`, picked[0].fsPath);
  }
  await refreshProfile();
}

Object.assign(exports, { cmdStartProfile, showProfilePanel, loadProfileSymbols, findKernelOffset, profileConnected });
