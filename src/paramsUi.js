'use strict';
// The Simulation Parameters view and Set Value.
const vscode = require('vscode');
const path = require('path');
const core = require('../lib/platform/core');
const simagent = require('../lib/sim/simagent');
const params = require('../lib/platform/params');
const shared = require('./shared');
const catalogUi = require('./catalogUi');
const platformEdit = require('./platformEdit');

class ParamTree {
  constructor() {
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
    this.roots = [];
    this.message = undefined;
  }
  clear() { this.roots = []; this.emitter.fire(); }
  async load() {
    if (!shared.agent) return this.clear();
    try {
      const res = await shared.agent.request('cci.listParams', {}, { timeoutMs: 30000 });
      this.roots = simagent.buildParamTree(res.params || []);
    } catch (e) {
      this.roots = [];
      vscode.window.setStatusBarMessage(`VP Studio: could not read parameters (${e.message})`, 10000);
    }
    this.emitter.fire();
  }
  getChildren(node) { return node ? node.children || [] : this.roots; }
  getTreeItem(node) {
    if (!node.param) {
      const item = new vscode.TreeItem(node.label,
        this.roots.length === 1 && node === this.roots[0] ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
      item.iconPath = new vscode.ThemeIcon('symbol-namespace');
      item.tooltip = node.path;
      item.id = 'o:' + node.path;
      return item;
    }
    const p = node.param;
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
    item.id = 'p:' + node.path;
    item.description = simagent.formatValue(p.value);
    item.iconPath = new vscode.ThemeIcon(p.isPreset ? 'symbol-property' : 'symbol-variable');
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${p.name}**\n\n`);
    md.appendCodeblock(JSON.stringify(p.value, null, 2) || 'null', 'json');
    md.appendMarkdown(`\n\`${p.type}\`${p.isPreset ? ' · set by the configuration' : p.isDefault ? ' · default' : ' · changed'}\n\n`);
    if (p.description) md.appendText(p.description);
    const ro = simagent.readOnlyReason(p);
    md.appendMarkdown(ro ? `\n\n*Read-only: ${ro}.*` : '\n\n*Set Value… changes it in the running simulation.*');
    item.tooltip = md;
    item.contextValue = ro ? 'vpParamReadOnly' : 'vpParam';
    return item;
  }
}

/**
 * Set a parameter of the running simulation, then offer to write the same
 * value into the platform description so the next start uses it.
 */
async function cmdSetParam(node) {
  if (!node || !node.param) return;
  if (!shared.agent) { vscode.window.showWarningMessage('Not connected to a simulation.'); return; }
  const p = node.param;
  const ro = simagent.readOnlyReason(p);
  if (ro) { vscode.window.showWarningMessage(`${p.name} cannot be set while the simulation runs: ${ro}.`); return; }
  const hint = p.category === 'string' ? 'Text, without quotes' : p.category === 'integer' ? 'Decimal or 0x hex'
    : p.category === 'bool' ? 'true or false' : p.category === 'real' ? 'A number' : 'JSON';
  const text = await vscode.window.showInputBox({
    title: `Set ${p.name}`,
    prompt: `${p.type} · now ${simagent.formatValue(p.value)} · ${hint}`,
    value: simagent.paramInputText(p),
    validateInput: (t) => simagent.parseParamValue(t, p).error,
  });
  if (text === undefined) return;
  const { json } = simagent.parseParamValue(text, p);
  let res;
  try {
    res = await shared.agent.request('cci.setParam', { name: p.name, valueJson: json });
  } catch (e) {
    const why = e.code === -32004 && /conversion/.test(e.message) ? `${p.type} does not accept ${json}`
      : e.code === -32601 ? 'this sim agent is older than 0.3.0 and cannot set parameters; rebuild it with tools/sim-agent/build.sh' : e.message;
    vscode.window.showErrorMessage(`Could not set ${p.name}: ${why}.`);
    return;
  }
  node.param = res;
  shared.paramTree.emitter.fire(node);
  // Only offer to save what maps to a parameter the platform can hold.
  let target;
  let why = shared.runningPlatform ? '' : ' It cannot be saved in the platform: this simulation was not started from VP Studio, so its platform file is unknown.';
  if (shared.runningPlatform) {
    try {
      const doc = JSON.parse((await vscode.workspace.openTextDocument(shared.runningPlatform)).getText());
      const t = params.runtimeTarget(doc, core.analyze(doc), p.name);
      if (t && t.platform) {
        target = t;
      } else if (t) {
        const row = params.findRow(params.moduleForms(doc, core.analyze(doc), catalogUi.catalog()), t.base, t.name, t.index);
        if (row && !row.lua) target = t;
        else why = row ? ` It cannot be saved in the platform: ${t.instance}.${t.name} is a Lua expression there.` : ` It cannot be saved in the platform: the component catalog does not list ${t.name} for ${t.instance}.`;
      } else {
        why = ` It cannot be saved in the platform: ${p.name} does not belong to a module of ${path.basename(shared.runningPlatform.fsPath)}.`;
      }
    } catch (e) { why = ' It cannot be saved in the platform right now: the platform file is not valid JSON.'; }
  }
  const msg = `${p.name} = ${simagent.formatValue(res.value)}. When a model uses the new value is up to the model: many read their parameters only at start, so it may only take effect after a restart.${why}`;
  const pick = await vscode.window.showInformationMessage(msg, ...(target ? ['Save in Platform'] : []));
  if (pick !== 'Save in Platform') return;
  try {
    const value = p.category === 'integer' ? params.schemaValue(BigInt(json)) : JSON.parse(json);
    if (target.platform) {
      await platformEdit.editPlatform(shared.runningPlatform, (t) => params.setPlatformParamEdit(t, target.name, value));
      vscode.window.showInformationMessage(`Saved ${target.name} = ${JSON.stringify(value)} in "platform" → "params" of ${path.basename(shared.runningPlatform.fsPath)} (not saved to disk yet).`);
      return;
    }
    await platformEdit.editPlatform(shared.runningPlatform, (t) => params.setParamEdit(t, target.base, target.name, value, target.index));
    vscode.window.showInformationMessage(`Saved ${target.name} = ${JSON.stringify(value)} for ${target.index === null ? target.base : target.instance} in ${path.basename(shared.runningPlatform.fsPath)} (not saved to disk yet).`);
  } catch (e) {
    vscode.window.showErrorMessage(`Could not save it in the platform: ${e.message}`);
  }
}

async function cmdCopyParam(node) {
  if (node && node.param) await vscode.env.clipboard.writeText(`${node.param.name} = ${JSON.stringify(node.param.value)}`);
}

Object.assign(exports, { ParamTree, cmdSetParam, cmdCopyParam });
