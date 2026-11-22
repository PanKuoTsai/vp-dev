'use strict';
// The VP Studio menu: context keys, the Actions view and the status bar menu.
const vscode = require('vscode');
const menu = require('../lib/menu');
const shared = require('./shared');

const ctxState = {};       // the context keys VP Studio sets, for the Actions view and the menu

/** Set a context key (menus, views) and keep the Actions view in step. */
function setCtx(key, value) {
  vscode.commands.executeCommand('setContext', key, value);
  if (ctxState[key] === value) return;
  ctxState[key] = value;
  if (shared.actionsTree) shared.actionsTree.refresh();
}

function titles() {
  if (!shared.commandTitles) shared.commandTitles = menu.titlesFrom(require('../package.json'));
  return shared.commandTitles;
}

/** The Actions view: the VP Studio menu as a tree, only what can run now. */
class ActionsTree {
  constructor() { this.emitter = new vscode.EventEmitter(); this.onDidChangeTreeData = this.emitter.event; }
  refresh() { this.emitter.fire(); }
  getTreeItem(n) { return n.item; }
  getChildren(n) {
    if (n) return n.children;
    return menu.visible(ctxState, titles()).map((g) => {
      const item = new vscode.TreeItem(g.label, vscode.TreeItemCollapsibleState.Expanded);
      item.id = `group.${g.id}`;
      item.iconPath = new vscode.ThemeIcon(g.icon);
      return {
        item,
        children: g.items.map((i) => {
          const it = new vscode.TreeItem(i.label, vscode.TreeItemCollapsibleState.None);
          it.id = `cmd.${i.command}`;
          it.command = { command: i.command, title: i.label };
          if (i.icon) it.iconPath = new vscode.ThemeIcon(i.icon);
          it.tooltip = `VP Studio: ${i.label}`;
          return { item: it };
        }),
      };
    });
  }
}

/** The menu as two quick picks: a group, then a command (status bar, "VP Studio: Menu…"). */
async function cmdMenu() {
  const groups = menu.visible(ctxState, titles());
  const g = await vscode.window.showQuickPick(groups.map((x) => ({
    label: `$(${x.icon}) ${x.label}`, description: x.items.map((i) => i.label).slice(0, 3).join(', ') + (x.items.length > 3 ? ', …' : ''), group: x,
  })), { title: 'VP Studio', placeHolder: 'Choose a group' });
  if (!g) return;
  const items = [];
  for (const i of g.group.items) {
    if (i.separatorBefore) items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    items.push({ label: `${i.icon ? `$(${i.icon}) ` : ''}${i.label}`, command: i.command });
  }
  const c = await vscode.window.showQuickPick(items, { title: `VP Studio: ${g.group.label}`, placeHolder: 'Choose a command' });
  if (c && c.command) vscode.commands.executeCommand(c.command);
}

exports.ctxState = ctxState;
exports.setCtx = setCtx;
exports.ActionsTree = ActionsTree;
exports.cmdMenu = cmdMenu;
