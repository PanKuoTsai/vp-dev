'use strict';
// Device tree: dtc, the generated DTS and DTB, and the Device tree tab of the platform view.
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const view = require('../lib/webview/view');
const images = require('../lib/platform/images');
const launch = require('../lib/sim/launch');
const remote = require('../lib/sim/remote');
const devicetree = require('../lib/generate/devicetree');
const dtcompare = require('../lib/generate/dtcompare');
const common = require('./common');
const catalogUi = require('./catalogUi');
const platformFiles = require('./platformFiles');
const remoteUi = require('./remoteUi');

/**
 * The device tree compiler: the "vpStudio.dtc" command on this machine, or dtc
 * on the simulation host when it is set to "remote", and on Windows (no dtc
 * there) when a simulation host is set.
 */
function dtcTool() {
  const set = String(common.cfg().get('dtc') || '').trim();
  let rc;
  try { rc = remoteUi.remoteSettings(); } catch (e) { rc = undefined; }
  if (rc && (set === 'remote' || (common.IS_WINDOWS && (!set || set === 'dtc')))) return remote.toolRunner(rc, 'dtc', { timeoutMs: 60000 });
  return set && set !== 'remote' ? set : 'dtc';
}

/**
 * Generate <name>.generated.dts next to the platform and compile it with dtc
 * to devicetree.output (or <name>.generated.dtb). Returns { dts, dtb, notes };
 * throws with dtc's message when it fails.
 */
async function deviceTreeFor(uri, data) {
  let r;
  try {
    r = await launch.writeDeviceTree(data, uri.fsPath, dtcTool());
  } catch (e) {
    throw new Error(/ not found;/.test(e.message) ? `${e.message} or set "vpStudio.dtc"` : e.message);
  }
  const { dts, dtb } = r;
  const ch = common.outputChannel();
  ch.appendLine(`Device tree for ${path.basename(uri.fsPath)}: ${dts} -> ${dtb}`);
  for (const n of r.notes) ch.appendLine(`  ${n.level === 'warning' ? 'Warning' : 'Note'}: ${n.text}`);
  return { dts, dtb, notes: r.notes };
}

/**
 * The Device tree tab of the platform view: the tree generated from the
 * platform now, compared with a DTB the loader loads or the DTS written last.
 * against: 'none' | 'output' | 'dtb:<module>:<index>' | 'auto' (a loaded DTB, else the last DTS, else none).
 */
async function deviceTreePane(uri, against) {
  const loaded = await platformFiles.load(uri);
  if (!loaded) return null;
  const data = loaded.data;
  const topDir = path.dirname(uri.fsPath);
  const candidates = [];
  const files = new Map();
  for (const l of images.collect(data, catalogUi.analyzeWithCatalog(data), topDir).loaders) {
    for (const e of l.entries) {
      if (e.kind === 'raw' || !e.exists || !dtcompare.isFdt(e.resolved)) continue;
      const id = `dtb:${l.module}:${e.index}`;
      candidates.push({ id, label: `DTB loaded by ${l.module}: ${vscode.workspace.asRelativePath(e.resolved)}` });
      files.set(id, { kind: 'dtb', file: e.resolved, label: vscode.workspace.asRelativePath(e.resolved) });
    }
  }
  let out;
  try { out = devicetree.outputPaths(data, uri.fsPath); } catch (e) { out = null; }
  if (out && fs.existsSync(out.dts)) {
    candidates.push({ id: 'output', label: `DTS written last: ${vscode.workspace.asRelativePath(out.dts)}` });
    files.set('output', { kind: 'dts', file: out.dts, label: vscode.workspace.asRelativePath(out.dts) });
  }
  if (against === 'auto' || (against !== 'none' && !files.has(against))) against = candidates.length ? candidates[0].id : 'none';
  const r = { candidates, against, notes: [], text: '' };
  try {
    const g = devicetree.generate(data, { topDir });
    r.text = g.dts;
    r.notes = g.notes;
    const other = files.get(against);
    if (other) {
      r.oldLabel = other.label;
      r.result = await dtcompare.compare(g.dts, other, dtcTool());
    }
  } catch (e) {
    r.error = `Cannot ${r.text ? 'compare' : 'generate'} the device tree: ${e.message}`;
  }
  return { type: 'deviceTree', against, html: view.deviceTreePane(r) };
}

async function cmdGenerateDeviceTree(arg) {
  const uri = await platformFiles.pickPlatform(arg);
  if (!uri) return;
  const loaded = await platformFiles.load(uri);
  if (!loaded) return;
  let r;
  try {
    r = await deviceTreeFor(uri, loaded.data);
  } catch (e) {
    vscode.window.showErrorMessage(`Device tree not generated: ${e.message}`);
    return;
  }
  const w = r.notes.filter((n) => n.level === 'warning').length;
  const msg = `Generated ${vscode.workspace.asRelativePath(r.dts)} and ${path.basename(r.dtb)}` +
    (w ? `, with ${w} warning${w > 1 ? 's' : ''}` : '') + (r.notes.length ? ' (see the VP Studio output)' : '') + '.';
  const pick = await (w ? vscode.window.showWarningMessage : vscode.window.showInformationMessage)(msg, 'Open DTS', ...(r.notes.length ? ['Show Notes'] : []));
  if (pick === 'Open DTS') vscode.window.showTextDocument(vscode.Uri.file(r.dts), { preview: true });
  else if (pick === 'Show Notes') common.outputChannel().show(true);
}

exports.deviceTreeFor = deviceTreeFor;
exports.deviceTreePane = deviceTreePane;
exports.cmdGenerateDeviceTree = cmdGenerateDeviceTree;
