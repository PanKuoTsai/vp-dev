'use strict';
// The Platform Modules view.
const vscode = require('vscode');
const core = require('../lib/platform/core');
const view = require('../lib/webview/view');
const common = require('./common');
const platformFiles = require('./platformFiles');

// Icons and colors of module roles in the tree views, close to the platform view's role colors.
const MODULE_ROLE_LOOK = {
  compute: { icon: 'chip', color: 'charts.blue' },
  memory: { icon: 'database', color: 'charts.orange' },
  irq: { icon: 'zap', color: 'charts.purple' },
  periph: { icon: 'plug', color: 'charts.green' },
  pcie: { icon: 'extensions', color: 'charts.green' },
  boot: { icon: 'rocket', color: 'charts.red' },
  bus: { icon: 'git-merge', color: 'charts.blue' },
  subsystem: { icon: 'folder', color: 'charts.foreground' },
  infra: { icon: 'gear', color: undefined },
};

class ModuleTree {
  constructor() {
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
  }
  refresh() { this.emitter.fire(); }
  /**
   * The platform whose modules are listed: the active editor's, else the last
   * one seen, else one in sight or open. Focus in a view (the tree itself, the
   * platform view) leaves no active text editor, in Theia at once.
   */
  current() {
    const ed = vscode.window.activeTextEditor;
    if (ed && common.isPlatform(ed.document)) this.last = ed.document;
    if (!this.last || this.last.isClosed) {
      const seen = vscode.window.visibleTextEditors.find((e) => common.isPlatform(e.document));
      const open = seen ? seen.document : vscode.workspace.textDocuments.find((d) => common.isPlatform(d));
      if (open) this.last = open;
    }
    return this.last && !this.last.isClosed ? this.last : undefined;
  }
  getTreeItem(el) { return el; }
  getChildren(el) {
    if (el) return el.children || [];
    const textDoc = this.current();
    if (!textDoc) return [];
    let analysis;
    try { analysis = core.analyze(JSON.parse(textDoc.getText())); } catch (e) { return []; }
    // Grouped by role like the platform view's module list, each role with its icon and color.
    const byBase = new Map();
    for (const inst of analysis.instances) {
      if (!byBase.has(inst.base)) byBase.set(inst.base, []);
      byBase.get(inst.base).push(inst);
    }
    const roles = new Map(view.groups(analysis).map((g) => [g.base, g.role]));
    const byRole = new Map();
    for (const [base, list] of byBase) {
      const role = roles.get(base) || 'infra';
      if (!byRole.has(role)) byRole.set(role, []);
      const first = list[0];
      const item = new vscode.TreeItem(list.length > 1 ? `${base} ×${list.length}` : base,
        first.ports.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
      const region = analysis.memoryMap.find((m) => m.base === base);
      item.description = (region ? `${view.fmtAddr(region.start)} · ` : '') + (first.isContainer ? 'subsystem' : first.type);
      item.tooltip = `${base} (${first.isContainer ? 'subsystem' : first.type})${region ? `\n${core.hex(region.start)} – ${core.hex(region.end)}` : ''}`;
      const look = MODULE_ROLE_LOOK[role] || MODULE_ROLE_LOOK.infra;
      item.iconPath = new vscode.ThemeIcon(look.icon, look.color ? new vscode.ThemeColor(look.color) : undefined);
      item.command = { command: 'vpStudio.reveal', title: 'Reveal', arguments: [textDoc.uri, base] };
      item.children = first.ports.map((p) => {
        const c = new vscode.TreeItem(p.name);
        c.description = (p.address !== undefined && p.address !== null ? `${core.hex(p.address)}  ` : '') + `→ ${p.bind}`;
        c.iconPath = new vscode.ThemeIcon(p.raw.address !== undefined ? 'symbol-field' : 'plug');
        c.command = { command: 'vpStudio.reveal', title: 'Reveal', arguments: [textDoc.uri, base, p.name] };
        return c;
      });
      byRole.get(role).push({ item, n: first.isContainer ? 1 : list.length });
    }
    const items = [];
    for (const role of view.ROLE_ORDER) {
      if (!byRole.has(role)) continue;
      const list = byRole.get(role);
      const head = new vscode.TreeItem(view.ROLE_LABEL[role], role === 'infra' ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded);
      head.id = `role:${role}`;
      head.description = String(list.reduce((s, x) => s + x.n, 0));
      const look = MODULE_ROLE_LOOK[role] || MODULE_ROLE_LOOK.infra;
      head.iconPath = new vscode.ThemeIcon('circle-filled', look.color ? new vscode.ThemeColor(look.color) : undefined);
      head.children = list.map((x) => x.item);
      items.push(head);
    }
    return items;
  }
}

async function cmdReveal(uri, moduleName, portName) {
  const textDoc = await vscode.workspace.openTextDocument(uri);
  const range = platformFiles.locate(textDoc, moduleName, portName);
  const ed = await vscode.window.showTextDocument(textDoc, { preserveFocus: true });
  ed.selection = new vscode.Selection(range.start, range.start);
  ed.revealRange(range, vscode.TextEditorRevealType.InCenter);
}

exports.MODULE_ROLE_LOOK = MODULE_ROLE_LOOK;
exports.ModuleTree = ModuleTree;
exports.cmdReveal = cmdReveal;
