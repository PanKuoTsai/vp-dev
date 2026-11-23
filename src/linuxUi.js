'use strict';
// Linux awareness (G-06): the gdb script, the Guest Processes view, the kernel log, source mapping.
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const guestlinux = require('../lib/debug/guestlinux');
const shared = require('./shared');
const common = require('./common');
const menuUi = require('./menuUi');

const DEBUG_TYPE = 'gdbtarget';
const linuxScript = () => path.join(shared.extContext.extensionPath, 'tools', 'gdb', 'vp-linux.py');

/**
 * Guest Processes: the Linux processes of the target, read through the CDT
 * debug session with tools/gdb/vp-linux.py while the target is stopped.
 * Reads only while the view is visible: a read takes about a second of gdb
 * time, which would slow every step otherwise.
 */
class GuestTree {
  constructor() {
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
    this.session = undefined;   // the debug session it reads from
    this.stopped = false;
    this.data = undefined;      // processTree result
    this.stale = true;          // the target ran since the last read
    this.loaded = new Set();    // session ids where the script is loaded
    this.busy = undefined;
    this.view = undefined;
  }
  attach(view) {
    this.view = view;
    view.onDidChangeVisibility(() => { if (view.visible && this.stale) this.refresh(); });
    this.show();
  }
  sessionStarted(s) { if (s.type === DEBUG_TYPE) { this.session = s; this.stopped = false; this.data = undefined; this.show(); this.context(); } }
  sessionEnded(s) {
    this.loaded.delete(s.id);
    if (this.session && this.session.id === s.id) {
      this.session = vscode.debug.activeDebugSession && vscode.debug.activeDebugSession.type === DEBUG_TYPE ? vscode.debug.activeDebugSession : undefined;
      this.stopped = false; this.data = undefined; this.show(); this.context();
    }
  }
  context() { menuUi.setCtx('vpStudio.guestDebug', !!this.session); }
  onStopped(s) {
    this.session = s; this.stopped = true; this.stale = true;
    clearTimeout(this.timer);
    // After CDT has answered VS Code's own requests for the new stop.
    this.timer = setTimeout(() => { if (this.view && this.view.visible) this.refresh(); else this.show(); }, 400);
  }
  onRunning(s) { if (this.session && s.id === this.session.id) { this.stopped = false; this.stale = true; clearTimeout(this.timer); this.show(); } }

  /** A gdb (MI) command through CDT; loads the script first when this gdb lacks it. */
  async mi(command) {
    const s = this.session;
    try {
      return guestlinux.parseResult(await s.customRequest('evaluate', guestlinux.evaluateArgs(command)));
    } catch (e) {
      if (!guestlinux.notLoaded(e.message) || this.loaded.has(s.id)) throw e;
      await s.customRequest('evaluate', guestlinux.evaluateArgs(guestlinux.sourceCommand(linuxScript())));
      this.loaded.add(s.id);
      return guestlinux.parseResult(await s.customRequest('evaluate', guestlinux.evaluateArgs(command)));
    }
  }

  async refresh() {
    if (!this.session || !this.stopped) { this.show(); return; }
    if (this.busy) return this.busy;
    this.busy = (async () => {
      this.error = undefined;
      try {
        this.data = guestlinux.processTree(guestlinux.normalizePs(await this.mi('-vp-ps -t')));
        this.stale = false;
      } catch (e) {
        this.data = undefined;
        this.error = e.message;
      }
      this.busy = undefined;
      this.show();
    })();
    return this.busy;
  }

  show() {
    if (this.view) {
      let msg;
      if (!this.session) msg = 'Attach the debugger to the target ("VP: attach to target software") to see the guest\'s Linux processes.';
      else if (!this.stopped) msg = this.data ? 'The target is running; this list is from the last stop. Pause it to read again.' : 'Pause the target in the debugger to read the guest\'s Linux processes.';
      else if (this.error) msg = this.error;
      else if (this.stale && !this.data) msg = 'Reading…';
      this.view.message = msg;
      const c = this.data && this.data.count;
      this.view.description = c ? `${c.processes} processes, ${c.threads} threads` : undefined;
    }
    this.emitter.fire();
  }

  getChildren(node) {
    if (!this.data) return [];
    if (!node) return [{ kind: 'cpus' }, ...this.data.roots.map((n) => ({ kind: 'proc', n }))];
    if (node.kind === 'cpus') return this.data.cpus.map((c) => ({ kind: 'cpu', c }));
    if (node.kind === 'proc') return [...node.n.threads.map((t) => ({ kind: 'thread', t })), ...node.n.children.map((n) => ({ kind: 'proc', n }))];
    return [];
  }

  getTreeItem(node) {
    const None = vscode.TreeItemCollapsibleState.None;
    if (node.kind === 'cpus') {
      const busy = this.data.cpus.filter((c) => !c.idle).length;
      const item = new vscode.TreeItem('CPUs', vscode.TreeItemCollapsibleState.Expanded);
      item.id = 'g:cpus';
      item.description = `${busy} of ${this.data.cpus.length} running a task`;
      item.iconPath = new vscode.ThemeIcon('circuit-board');
      return item;
    }
    if (node.kind === 'cpu') {
      const l = guestlinux.cpuLabel(node.c);
      const item = new vscode.TreeItem(l.label, None);
      item.id = 'g:cpu' + node.c.cpu;
      item.description = l.description;
      item.iconPath = new vscode.ThemeIcon(node.c.idle ? 'debug-pause' : 'play', node.c.idle ? undefined : new vscode.ThemeColor('debugIcon.startForeground'));
      return item;
    }
    const isThread = node.kind === 'thread';
    const p = isThread ? node.t : node.n.proc;
    const l = guestlinux.procLabel(p, isThread);
    const kids = isThread ? 0 : node.n.threads.length + node.n.children.length;
    // systemd open, the kernel threads closed: there are a hundred of them.
    const state = !kids ? None : p.pid === 1 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;
    const item = new vscode.TreeItem(l.label, state);
    item.id = 'g:' + p.pid;
    item.description = l.description;
    item.tooltip = guestlinux.procTooltip(p, isThread);
    item.iconPath = new vscode.ThemeIcon(p.running >= 0 ? 'play' : isThread ? 'debug-stackframe-dot' : p.kernel ? 'gear' : 'terminal',
      p.running >= 0 ? new vscode.ThemeColor('debugIcon.startForeground') : undefined);
    item.contextValue = 'vpGuestTask';
    return item;
  }
}

/**
 * Map the kernel sources: the stopped frame names a file on the machine the
 * kernel was built on (/build/linux-…/arch/arm64/kernel/idle.c); the user picks
 * the local tree; gdb gets set substitute-path at once and at every attach.
 */
async function cmdMapSources() {
  const s = shared.guestTree.session;
  if (!s) { vscode.window.showWarningMessage('Attach the debugger to the target first ("VP: attach to target software").'); return; }
  if (!shared.guestTree.stopped) { vscode.window.showWarningMessage('Pause the target in the debugger first, so that VP Studio can see which source file it needs.'); return; }
  const item = vscode.debug.activeStackItem;
  const threadId = item && item.session === s && item.threadId !== undefined ? item.threadId : (shared.cpuRegsView && shared.cpuRegsView.thread) || 1;
  const st = await s.customRequest('stackTrace', { threadId, startFrame: 0, levels: 40 });
  const frames = (st && st.stackFrames) || [];
  const missing = frames.find((f) => f.source && f.source.path && !fs.existsSync(f.source.path));
  if (!missing) {
    vscode.window.showInformationMessage(frames.some((f) => f.source && f.source.path) ? 'The sources of the current stack are already found.' : 'The current stack has no source files (no symbols?). Stop in kernel code that vmlinux describes and try again.');
    return;
  }
  const picked = await vscode.window.showOpenDialog({
    canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Use this source tree',
    title: `Folder with the kernel source (built at ${path.posix.dirname(missing.source.path)})`,
  });
  if (!picked || !picked[0]) return;
  const root = picked[0].fsPath;
  const m = guestlinux.sourceMapping(missing.source.path, root, (p) => fs.existsSync(p));
  if (!m) {
    vscode.window.showErrorMessage(`${root} has no file matching ${missing.source.path} (looked for every tail of the path, such as ${missing.source.path.split('/').slice(-3).join('/')}). Pick the top folder of the same kernel version's source.`);
    return;
  }
  const map = Object.assign({}, common.cfg().get('debug.sourceMap') || {}, { [m.from]: m.to });
  await common.cfg().update('debug.sourceMap', map, vscode.ConfigurationTarget.Workspace);
  for (const cmd of guestlinux.substituteCommands({ [m.from]: m.to })) await s.customRequest('evaluate', guestlinux.evaluateArgs(cmd));
  const ed = await vscode.window.showTextDocument(vscode.Uri.file(m.file), { preview: true, preserveFocus: false });
  const line = Math.max(0, (missing.line || 1) - 1);
  ed.selection = new vscode.Selection(line, 0, line, 0);
  ed.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenter);
  vscode.window.showInformationMessage(`Kernel sources: ${m.from} is now read from ${m.to}. The next stop shows the source in the editor; the mapping is saved in the workspace settings (vpStudio.debug.sourceMap) and applied at every attach.`);
}

/** The guest kernel's log (printk ring buffer), read through the debugger, in an editor. */
async function cmdShowKernelLog() {
  if (!shared.guestTree.session) { vscode.window.showWarningMessage('Attach the debugger to the target first ("VP: attach to target software").'); return; }
  if (!shared.guestTree.stopped) { vscode.window.showWarningMessage('Pause the target in the debugger first: the kernel log is read from guest memory while it is stopped.'); return; }
  const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Reading the guest kernel log' }, () => shared.guestTree.mi('-vp-dmesg'));
  const text = guestlinux.formatDmesg(r);
  const textDoc = await vscode.workspace.openTextDocument({ content: text || '(the kernel log is empty)\n', language: 'log' });
  await vscode.window.showTextDocument(textDoc, { preview: false });
}

/** Debug configurations of the CDT adapter get the Linux script (vpStudio.debug.linuxAwareness). */
const linuxConfigProvider = {
  resolveDebugConfigurationWithSubstitutedVariables(folder, config) {
    if (config.type !== DEBUG_TYPE) return config;
    // Kernel sources built elsewhere (Map Kernel Sources…), then the Linux script.
    const mapped = guestlinux.withSourceMap(config, common.cfg().get('debug.sourceMap'));
    if (common.cfg().get('debug.linuxAwareness') === false) return mapped;
    return guestlinux.withLinuxAwareness(mapped, linuxScript(), { printers: common.cfg().get('debug.prettyPrinters') !== false });
  },
};

exports.DEBUG_TYPE = DEBUG_TYPE;
exports.GuestTree = GuestTree;
exports.cmdMapSources = cmdMapSources;
exports.cmdShowKernelLog = cmdShowKernelLog;
exports.linuxConfigProvider = linuxConfigProvider;
