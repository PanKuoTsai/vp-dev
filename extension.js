'use strict';
// VS Code entry point: registers the commands, views and providers. What they do is in src/.
const vscode = require('vscode');
const shared = require('./src/shared');
const common = require('./src/common');
const catalogUi = require('./src/catalogUi');
const platformFiles = require('./src/platformFiles');
const devicetreeUi = require('./src/devicetreeUi');
const modelUi = require('./src/modelUi');
const qboxUi = require('./src/qboxUi');
const checkpointUi = require('./src/checkpointUi');
const kitUi = require('./src/kitUi');
const debugUi = require('./src/debugUi');
const memoryUi = require('./src/memoryUi');
const excUi = require('./src/excUi');
const gicUi = require('./src/gicUi');
const mmuUi = require('./src/mmuUi');
const kmodUi = require('./src/kmodUi');
const gdbUi = require('./src/gdbUi');
const crossUi = require('./src/crossUi');
const simUi = require('./src/simUi');
const remoteUi = require('./src/remoteUi');
const askpassUi = require('./src/askpassUi');
const versionUi = require('./src/versionUi');
const agentUi = require('./src/agentUi');
const traceUi = require('./src/traceUi');
const ftraceUi = require('./src/ftraceUi');
const profileUi = require('./src/profileUi');
const registersUi = require('./src/registersUi');
const linuxUi = require('./src/linuxUi');
const paramsUi = require('./src/paramsUi');
const platformView = require('./src/platformView');
const perfUi = require('./src/perfUi');
const platformEdit = require('./src/platformEdit');
const examplesUi = require('./src/examplesUi');
const modulesTree = require('./src/modulesTree');
const menuUi = require('./src/menuUi');

function activate(context) {
  shared.extContext = context;
  menuUi.setCtx('vpStudio.localSim', !common.IS_WINDOWS);
  if (common.cfg().get('remote.auth') === 'password') askpassUi.ensureAskpass().catch(() => {});
  menuUi.setCtx('vpStudio.passwordLogin', common.cfg().get('remote.auth') === 'password');
  context.subscriptions.push({ dispose: () => shared.askpassServer && shared.askpassServer.close() });
  shared.diagnostics = vscode.languages.createDiagnosticCollection('vpStudio');
  shared.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  shared.agentItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
  shared.menuItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 51);
  shared.menuItem.text = '$(circuit-board) VP Studio';
  shared.menuItem.tooltip = 'VP Studio menu';
  shared.menuItem.command = 'vpStudio.menu';
  shared.menuItem.show();
  shared.actionsTree = new menuUi.ActionsTree();
  const tree = new modulesTree.ModuleTree();
  shared.paramTree = new paramsUi.ParamTree();
  shared.registerTree = new registersUi.RegisterTree();
  shared.guestTree = new linuxUi.GuestTree();
  simUi.setRunning(false);
  agentUi.setAgentContext();

  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  reg('vpStudio.menu', menuUi.cmdMenu);
  reg('vpStudio.generate', simUi.cmdGenerate);
  reg('vpStudio.start', (arg) => simUi.start(arg, false));
  reg('vpStudio.startDebug', (arg) => simUi.start(arg, true));
  reg('vpStudio.startTrace', (arg) => traceUi.cmdStartTrace(context, arg));
  reg('vpStudio.showTrace', () => { traceUi.showTracePanel(false); traceUi.traceConnected(); });
  reg('vpStudio.chooseProbes', () => traceUi.cmdChooseProbes());
  reg('vpStudio.stop', simUi.cmdStop);
  reg('vpStudio.showPlatform', platformView.cmdShowPlatform);
  reg('vpStudio.addDebugConfigurations', debugUi.cmdAddDebugConfigs);
  reg('vpStudio.createExample', () => examplesUi.cmdCreateExample(context));
  reg('vpStudio.perf.createExample', () => examplesUi.cmdPerfCreateExample(context).catch((e) => vscode.window.showErrorMessage(`Could not create the example: ${e.message}`)));
  reg('vpStudio.reveal', modulesTree.cmdReveal);
  reg('vpStudio.pause', agentUi.cmdPause);
  reg('vpStudio.continue', agentUi.cmdContinue);
  reg('vpStudio.runFor', () => agentUi.runTimed(false));
  reg('vpStudio.refreshRegisters', () => shared.registerTree.refresh());
  reg('vpStudio.startProfile', profileUi.cmdStartProfile);
  reg('vpStudio.startOpenOcd', remoteUi.localOnly('The OpenOCD debug port', debugUi.cmdStartOpenOcd));
  reg('vpStudio.startFtrace', ftraceUi.cmdStartFtrace);
  reg('vpStudio.ftrace.record', ftraceUi.cmdFtraceRecord);
  reg('vpStudio.ftrace.save', ftraceUi.cmdFtraceSave);
  reg('vpStudio.ftrace.convert', ftraceUi.cmdFtraceConvert);
  reg('vpStudio.showProfile', () => { profileUi.showProfilePanel(shared.profileState.uri || shared.runningPlatform, false); profileUi.profileConnected(); });
  reg('vpStudio.setRegister', registersUi.cmdSetRegister);
  reg('vpStudio.readRegister', registersUi.cmdReadRegister);
  reg('vpStudio.runUntil', () => agentUi.runTimed(true));
  reg('vpStudio.connectAgent', agentUi.cmdConnectAgent);
  reg('vpStudio.refreshParams', () => shared.paramTree.load());
  reg('vpStudio.refreshGuest', () => shared.guestTree.refresh());
  reg('vpStudio.showKernelLog', () => linuxUi.cmdShowKernelLog().catch((e) => vscode.window.showErrorMessage(`Could not read the kernel log: ${e.message}`)));
  reg('vpStudio.debugLayout', debugUi.cmdDebugLayout);
  reg('vpStudio.showExceptions', excUi.cmdShowExceptions);
  reg('vpStudio.showGic', gicUi.cmdShowGic);
  reg('vpStudio.memoryLayout', () => memoryUi.cmdMemoryLayout().catch((e) => vscode.window.showErrorMessage(`Memory Layout: ${e.message}`)));
  reg('vpStudio.translateAddress', mmuUi.cmdTranslate);
  reg('vpStudio.findMemory', () => gdbUi.cmdFindMemory().catch((e) => vscode.window.showErrorMessage(`Find in Memory: ${e.message}`)));
  reg('vpStudio.viewAsType', () => gdbUi.cmdViewAsType().catch((e) => vscode.window.showErrorMessage(`View Address as Type: ${e.message}`)));
  reg('vpStudio.loadSymbols', () => gdbUi.cmdLoadSymbols().catch((e) => vscode.window.showErrorMessage(`Load Symbol File: ${e.message}`)));
  reg('vpStudio.cpuStepping', () => gdbUi.cmdStepping().catch((e) => vscode.window.showErrorMessage(`CPU Stepping: ${e.message}`)));
  reg('vpStudio.loadModuleSymbols', () => kmodUi.cmdLoadModules().catch((e) => vscode.window.showErrorMessage(`Kernel module symbols: ${e.message}`)));
  reg('vpStudio.jumpToCursor', (uri) => gdbUi.cmdJumpToCursor(uri).catch((e) => vscode.window.showErrorMessage(`Jump to Cursor: ${e.message}`)));
  reg('vpStudio.qemuMonitor', () => gdbUi.cmdMonitor().catch((e) => vscode.window.showErrorMessage(`QEMU Monitor: ${e.message}`)));
  context.subscriptions.push(vscode.debug.registerDebugAdapterTrackerFactory(linuxUi.DEBUG_TYPE, gdbUi.trackerFactory()));
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(gdbUi.SCHEME, gdbUi.provider));
  reg('vpStudio.addConditionalBreakpoint', debugUi.cmdAddConditionalBreakpoint);
  reg('vpStudio.showDisassembly', debugUi.openDisassembly);
  reg('vpStudio.showMemory', (arg) => memoryUi.showMemory(typeof arg === 'string' ? arg : undefined));
  reg('vpStudio.showCpuRegisters', () => vscode.commands.executeCommand('vpStudio.cpuRegisters.focus'));
  reg('vpStudio.mapSources', () => linuxUi.cmdMapSources().catch((e) => vscode.window.showErrorMessage(`Could not map the kernel sources: ${e.message}`)));
  reg('vpStudio.copyParam', paramsUi.cmdCopyParam);
  reg('vpStudio.setParam', (node) => paramsUi.cmdSetParam(node).catch((e) => vscode.window.showErrorMessage(`Could not set the parameter: ${e.message}`)));
  reg('vpStudio.checkQBox', remoteUi.localOnly('Check QBox Version', versionUi.cmdCheckQBox, 'Check Remote Host'));
  reg('vpStudio.generateDeviceTree', devicetreeUi.cmdGenerateDeviceTree);
  reg('vpStudio.exportKit', kitUi.cmdExportKit);
  reg('vpStudio.saveCheckpoint', () => checkpointUi.cmdSaveCheckpoint().catch((e) => vscode.window.showErrorMessage(`Save Checkpoint failed: ${e.message}`)));
  reg('vpStudio.startFromCheckpoint', remoteUi.localOnly('Start from Checkpoint', (arg) => checkpointUi.cmdStartFromCheckpoint(arg).catch((e) => vscode.window.showErrorMessage(`Start from Checkpoint failed: ${e.message}`))));
  reg('vpStudio.openKit', kitUi.cmdOpenKit);
  reg('vpStudio.buildSimAgent', remoteUi.localOnly('Build Sim Agent', () => qboxUi.cmdBuildSimAgent().catch((e) => vscode.window.showErrorMessage(`Could not build the sim agent: ${e.message}`)), 'Build Sim Agent on Remote Host'));
  reg('vpStudio.perf.run', remoteUi.localOnly('Performance experiments', (arg) => perfUi.cmdPerfRun(arg).catch((e) => vscode.window.showErrorMessage(`Performance run failed: ${e.message}`))));
  reg('vpStudio.perf.sweep', remoteUi.localOnly('Performance sweeps', (arg) => perfUi.cmdPerfSweep(arg).catch((e) => vscode.window.showErrorMessage(`Performance sweep failed: ${e.message}`))));
  reg('vpStudio.perf.newSweep', (arg) => perfUi.cmdPerfNewSweep(arg).catch((e) => vscode.window.showErrorMessage(`Could not create the sweep: ${e.message}`)));
  reg('vpStudio.perf.open', (arg) => perfUi.cmdPerfOpen(arg).catch((e) => vscode.window.showErrorMessage(`Could not open the results: ${e.message}`)));
  reg('vpStudio.buildQbox', remoteUi.localOnly('Build QBox', () => qboxUi.cmdBuildQbox().catch((e) => vscode.window.showErrorMessage(`Could not build QBox: ${e.message}`))));
  for (const b of catalogUi.BUNDLED) reg(b.command, () => qboxUi.cmdBuildBundled(b).catch((e) => vscode.window.showErrorMessage(`Could not build the ${b.title}: ${e.message}`)));
  reg('vpStudio.newModel', () => modelUi.cmdNewModel().catch((e) => vscode.window.showErrorMessage(`Could not create the model: ${e.message}`)));
  reg('vpStudio.generateModel', async (arg) => { const u = await modelUi.pickModel(arg); if (u) await modelUi.generateModel(u, false); });
  reg('vpStudio.remote.selectHost', () => remoteUi.cmdSelectHost().catch((e) => vscode.window.showErrorMessage(`VP Studio: ${e.message}`)));
  reg('vpStudio.remote.forgetPassword', () => askpassUi.cmdForgetPassword().catch((e) => vscode.window.showErrorMessage(`VP Studio: ${e.message}`)));
  reg('vpStudio.remote.check', () => remoteUi.cmdCheckRemote().catch((e) => vscode.window.showErrorMessage(`VP Studio: ${e.message}`)));
  reg('vpStudio.remote.buildSimAgent', () => remoteUi.cmdRemoteBuild('sim-agent').catch((e) => vscode.window.showErrorMessage(`Could not build the sim agent on the remote host: ${e.message}`)));
  for (const b of catalogUi.BUNDLED) reg(`vpStudio.remote.build.${b.dir}`, () => remoteUi.cmdRemoteBuild(b.dir).catch((e) => vscode.window.showErrorMessage(`Could not build the ${b.title} on the remote host: ${e.message}`)));
  reg('vpStudio.thirdPartyDebuggers', (arg) => debugUi.cmdThirdPartyDebuggers(arg).catch((e) => vscode.window.showErrorMessage(`Could not write the debugger set-up: ${e.message}`)));
  reg('vpStudio.importIpxact', (arg) => modelUi.cmdImportIpxact(arg).catch((e) => vscode.window.showErrorMessage(`Could not import the IP-XACT file: ${e.message}`)));
  reg('vpStudio.buildModel', (arg) => (common.IS_WINDOWS ? remoteUi.cmdRemoteBuildModel(arg) : qboxUi.cmdBuildModel(arg)).catch((e) => vscode.window.showErrorMessage(`Could not build the model: ${e.message}`)));
  reg('vpStudio.remote.buildModel', (arg) => remoteUi.cmdRemoteBuildModel(arg).catch((e) => vscode.window.showErrorMessage(`Could not build the model on the remote host: ${e.message}`)));
  shared.modelDiagnostics = vscode.languages.createDiagnosticCollection('vpStudio.models');
  const refreshModels = () => catalogUi.refreshModelCatalogs().catch(() => {});
  for (const glob of ['**/*.model.json', '**/build/*.catalog.json', '**/*.registers.json']) {
    const w = vscode.workspace.createFileSystemWatcher(glob);
    context.subscriptions.push(w, w.onDidCreate(refreshModels), w.onDidChange(refreshModels), w.onDidDelete(refreshModels));
  }
  context.subscriptions.push(shared.modelDiagnostics,
    vscode.workspace.onDidOpenTextDocument(modelUi.refreshModelDiagnostics),
    vscode.workspace.onDidChangeTextDocument((e) => modelUi.refreshModelDiagnostics(e.document)),
    vscode.workspace.onDidSaveTextDocument((d) => { if (modelUi.isModel(d)) modelUi.generateModel(d.uri, true); }));
  vscode.workspace.textDocuments.forEach(modelUi.refreshModelDiagnostics);
  refreshModels();
  reg('vpStudio.addModule', (arg) => platformEdit.cmdAddModule(arg).catch((e) => vscode.window.showErrorMessage(`Could not add the module: ${e.message}`)));

  let timer;
  const changed = (textDoc) => {
    if (!common.isPlatform(textDoc)) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      platformFiles.refreshDiagnostics(textDoc);
      tree.refresh();
      const panel = common.panels.get(textDoc.uri.toString());
      if (panel) platformView.renderPanel(textDoc.uri, panel);
    }, 300);
  };

  const anyWindow = /** @type {any} */ (vscode.window); // onDidEndTerminalShellExecution: VS Code 1.93+, newer than the type definitions
  context.subscriptions.push(
    shared.diagnostics, shared.statusItem, shared.agentItem, shared.menuItem,
    { dispose: agentUi.disconnectAgent },
    vscode.window.registerTreeDataProvider('vpStudio.actions', shared.actionsTree),
    vscode.window.registerTreeDataProvider('vpStudio.modules', tree),
    vscode.window.registerTreeDataProvider('vpStudio.params', shared.paramTree),
    ...(shared.registerViews = [vscode.window.createTreeView('vpStudio.registers', { treeDataProvider: shared.registerTree }), vscode.window.createTreeView('vpStudio.debugRegisters', { treeDataProvider: shared.registerTree })]),
    ...guestViews(),
    vscode.workspace.onDidOpenTextDocument(changed),
    vscode.workspace.onDidChangeTextDocument((e) => changed(e.document)),
    vscode.workspace.onDidCloseTextDocument((d) => shared.diagnostics.delete(d.uri)),
    vscode.window.onDidChangeActiveTextEditor(() => tree.refresh()),
    // The simulator ending by itself (guest poweroff): VS Code's shell integration says so (1.93+).
    ...(typeof anyWindow.onDidEndTerminalShellExecution === 'function' ? [anyWindow.onDidEndTerminalShellExecution((e) => simUi.onShellExecutionEnd(e))] : []),
    vscode.window.onDidCloseTerminal((t) => { if (t === shared.terminal) { shared.terminal = undefined; agentUi.disconnectAgent(); simUi.setRunning(false); } }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('vpStudio.catalog')) vscode.workspace.textDocuments.forEach(platformFiles.refreshDiagnostics);
      if (e.affectsConfiguration('vpStudio.remote.auth')) {
        menuUi.setCtx('vpStudio.passwordLogin', common.cfg().get('remote.auth') === 'password');
        if (common.cfg().get('remote.auth') === 'password') askpassUi.ensureAskpass().catch(() => {});
      }
    }),
  );
  vscode.workspace.textDocuments.forEach(platformFiles.refreshDiagnostics);
}

/** The Guest Processes view and the debug hooks it needs (G-06). */
function guestViews() {
  const view = vscode.window.createTreeView('vpStudio.guest', { treeDataProvider: shared.guestTree });
  shared.guestTree.attach(view);
  shared.cpuRegsView = new debugUi.CpuRegsView();
  if (vscode.debug.activeDebugSession) { shared.guestTree.sessionStarted(vscode.debug.activeDebugSession); shared.cpuRegsView.sessionStarted(vscode.debug.activeDebugSession); }
  const extra = [];
  // Selecting another CPU in Call Stack (VS Code 1.90+; not in every host).
  if (typeof vscode.debug.onDidChangeActiveStackItem === 'function') extra.push(vscode.debug.onDidChangeActiveStackItem((item) => { shared.cpuRegsView.onActiveStackItem(item); mmuUi.onDebugChange(); }));
  return [
    view,
    vscode.window.registerWebviewViewProvider('vpStudio.cpuRegisters', shared.cpuRegsView),
    ...extra,
    vscode.debug.registerDebugConfigurationProvider(linuxUi.DEBUG_TYPE, linuxUi.linuxConfigProvider),
    vscode.debug.registerDebugAdapterTrackerFactory(linuxUi.DEBUG_TYPE, {
      createDebugAdapterTracker(s) {
        return {
          onDidSendMessage(m) {
            if (m.type !== 'event') return;
            if (m.event === 'stopped') { shared.guestTree.onStopped(s); shared.cpuRegsView.onStopped(s, m.body && m.body.threadId); crossUi.debugStoppedEvent(); mmuUi.onDebugChange(); kmodUi.onStopped(s); }
            else if (m.event === 'continued') { shared.guestTree.onRunning(s); shared.cpuRegsView.onRunning(s); crossUi.debugRunningEvent(); }
          },
          onWillReceiveMessage(m) {
            // VS Code's own resume requests: CDT does not always send "continued".
            if (m.type === 'request' && /^(continue|next|stepIn|stepOut|stepBack|reverseContinue)$/.test(m.command)) { shared.guestTree.onRunning(s); shared.cpuRegsView.onRunning(s); crossUi.debugRunningEvent(); }
          },
        };
      },
    }),
    vscode.debug.onDidStartDebugSession((s) => { shared.guestTree.sessionStarted(s); shared.cpuRegsView.sessionStarted(s); memoryUi.sessionStarted(s); }),
    vscode.debug.onDidTerminateDebugSession((s) => { shared.guestTree.sessionEnded(s); shared.cpuRegsView.sessionEnded(s); memoryUi.sessionEnded(s); mmuUi.sessionEnded(s); kmodUi.sessionEnded(s); }),
  ];
}

function deactivate() {
  agentUi.disconnectAgent();
  if (shared.terminal) shared.terminal.dispose();
}

module.exports = { activate, deactivate };
