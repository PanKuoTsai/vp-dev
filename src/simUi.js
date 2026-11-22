'use strict';
// Starting and stopping a simulation: Lua generation, the agent module, checks before the start, the terminal.
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const core = require('../lib/platform/core');
const images = require('../lib/platform/images');
const simagent = require('../lib/sim/simagent');
const debugdap = require('../lib/debug/debugdap');
const hostports = require('../lib/sim/hostports');
const disklock = require('../lib/sim/disklock');
const trace = require('../lib/analysis/trace');
const pin = require('../lib/setup/pin');
const diskspace = require('../lib/sim/diskspace');
const launch = require('../lib/sim/launch');
const ftrace = require('../lib/analysis/ftrace');
const checkpoint = require('../lib/sim/checkpoint');
const shared = require('./shared');
const common = require('./common');
const catalogUi = require('./catalogUi');
const platformFiles = require('./platformFiles');
const devicetreeUi = require('./devicetreeUi');
const debugUi = require('./debugUi');
const remoteUi = require('./remoteUi');
const askpassUi = require('./askpassUi');
const versionUi = require('./versionUi');
const agentUi = require('./agentUi');
const traceUi = require('./traceUi');
const profileUi = require('./profileUi');
const menuUi = require('./menuUi');

async function cmdGenerate(arg) {
  const uri = await platformFiles.pickPlatform(arg);
  if (!uri) return;
  const out = await platformFiles.generateFor(uri);
  if (!out) return;
  const open = await vscode.window.showInformationMessage(`Generated ${vscode.workspace.asRelativePath(out)}`, 'Open');
  if (open) vscode.window.showTextDocument(vscode.Uri.file(out), { preview: true });
}

/** traceIds: trace points ("module.port") to put a vp_tracer in front of. opts.profile: sample the guest's program counter. */
/**
 * Add the sim agent, its probes and profiling to the generate options.
 * agentLib: the library path (without .so) as the simulator sees it;
 * agentVersion: its version. Returns { probeIds, recording } or undefined
 * after saying why the start cannot go on.
 */
function addAgentOptions(options, platform, { agentLib, agentVersion, agentPort, traceIds, opts, restore, qboxBuild }) {
  const c = common.cfg();
  // G-12: with agent 0.9.0, a probe goes at every place one fits; only the
  // chosen ones (traceIds) record from the start, the others wait for
  // "Choose Probes…". Older agents record at every tracer, so only the chosen.
  let probeIds = traceIds;
  let recording;
  if (agentLib && c.get('probes.insertAll') !== false && pin.versionAtLeast(agentVersion, '0.9.0')) {
    probeIds = trace.probeList(platform.data, catalogUi.catalog()).map((p) => p.id);
    for (const id of traceIds) if (!probeIds.includes(id)) probeIds.push(id);
    recording = traceIds;
  }
  if (!agentLib) return { probeIds, recording };
  // One bus socket per router, for the register view (mem.read / mem.write).
  shared.runningBuses = core.analyze(platform.data).routers;
  options.extraModules = [launch.agentModule(agentLib, agentPort, shared.runningBuses, restore ? restore.agentParams : {})];
  if (opts.ftrace && !pin.versionAtLeast(agentVersion, ftrace.MIN_AGENT)) {
    vscode.window.showErrorMessage(`The function trace needs sim agent ${ftrace.MIN_AGENT} or later (this one is ${agentVersion || 'older'}). Rebuild it with "VP Studio: Build Sim Agent".`, 'Build Sim Agent')
      .then((x) => x && vscode.commands.executeCommand('vpStudio.buildSimAgent'));
    return undefined;
  }
  if (opts.profile || opts.ftrace) {
    // QBox's libidlinker plugin gives the agent a QEMU plugin id (G-05).
    const q = core.analyze(platform.data).instances.find((i) => i.type === 'QemuInstance');
    if (!q) { vscode.window.showErrorMessage(`${opts.profile ? 'Profiling' : 'The function trace'} needs a QemuInstance in the platform.`); return undefined; }
    if (opts.profile) options.extraModules[0].params.profile = true;
    if (opts.ftrace) {
      options.extraModules[0].params.ftrace = true;
      const n = Number(c.get('ftrace.bufferPerCpu'));
      if (Number.isInteger(n) && n > 0) options.extraModules[0].params.ftrace_buffer = n;
    }
    options.overrides = (options.overrides || []).concat([
      { instance: q.name, param: 'qemu_args.-plugin', value: `libidlinker.so,key=platform.${agentUi.AGENT_INSTANCE}.profile_id` },
    ]);
  }
  // The probes and the debug port: QBox components for agent 0.14.0, the agent's library before.
  const libs = trace.probeLibraries(agentVersion, agentLib, pin.versionAtLeast);
  const qboxHas = (file) => !libs.inQbox || !qboxBuild || fs.existsSync(path.join(qboxBuild, file));
  if (opts.openocd) {
    // G-13: the JTAG debug port OpenOCD connects to (agent 0.13.0, QBox's debug_dap from 0.14.0).
    if (!pin.versionAtLeast(agentVersion, debugdap.MIN_AGENT)) {
      vscode.window.showErrorMessage(`The OpenOCD debug port needs sim agent ${debugdap.MIN_AGENT} or later (this one is ${agentVersion || 'older'}). Rebuild it with "VP Studio: Build Sim Agent".`, 'Build Sim Agent')
        .then((x) => x && vscode.commands.executeCommand('vpStudio.buildSimAgent'));
      return undefined;
    }
    try {
      if (!qboxHas('debug_dap.so')) throw new Error(`QBox's build (${qboxBuild}) has no debug_dap.so. Build it there: cmake --build ${qboxBuild} --target debug_dap`);
      options.extraModules.push(debugdap.dapModule(platform.data, opts.openocd.port, libs.dap, libs.types.dap));
    } catch (e) {
      vscode.window.showErrorMessage(`Cannot add the OpenOCD debug port: ${e.message}`);
      return undefined;
    }
  }
  if (probeIds.length) {
    try {
      if (!qboxHas('probes.so')) throw new Error(`QBox's build (${qboxBuild}) has no probes.so. Build it there: cmake --build ${qboxBuild} --target probes`);
      const t = trace.traceOptions(platform.data, probeIds, libs.probes, catalogUi.catalog(), { recording, router: pin.versionAtLeast(agentVersion, '0.12.0'), types: libs.types });
      options.extraModules.push(...t.extraModules);
      options.portOverrides = t.portOverrides;
    } catch (e) {
      vscode.window.showErrorMessage(`Cannot trace: ${e.message}`);
      return undefined;
    }
  }
  return { probeIds, recording };
}

/** What every start does once the simulator's terminal is open. */
function afterStart({ uri, platform, options, debug, port, traceIds, probeIds, recording, opts, restore, agentPort, hostPortValues, movedPorts, where, remoteInfo }) {
  shared.runningPlatform = uri;
  shared.runningDoc = platform.data;
  shared.runningOverrides = (options.overrides || []).slice();
  shared.runningRemote = remoteInfo;
  shared.restoreReported = false;
  shared.registerTree.reset();
  setRunning(true, [where || '', debug ? `gdb port ${port}` : '', traceIds.length ? `tracing ${traceIds.length}` : '',
    recording && probeIds.length ? `${probeIds.length} probes` : '', opts.profile ? 'profiling' : '', opts.ftrace ? 'function trace' : '',
    opts.openocd ? `OpenOCD port ${opts.openocd.port}` : '',
    restore ? `from checkpoint ${opts.restore.manifest.name}` : ''].filter(Boolean).join(', '));
  shared.traceProbes = [];
  shared.traceTitle = `Transaction Trace: ${path.basename(uri.fsPath, common.SUFFIX)}`;
  shared.profileState = { uri, offset: undefined, offsetAt: 0 };
  if (opts.profile) profileUi.showProfilePanel(uri, true);
  if (agentPort) agentUi.connectAgent({ port: agentPort, auto: true, handshake: !!remoteInfo });
  if (traceIds.length) traceUi.showTracePanel(true);
  const portList = Object.entries(hostPortValues).map(([k, v]) => `${k}=${v}`).join(', ');
  if (portList) shared.statusItem.tooltip = `Stop the simulation\nHost ports${remoteInfo ? ' (on this machine)' : ''}: ${portList}`;
  if (movedPorts.length) {
    vscode.window.showInformationMessage(
      'Some host ports were taken, so this simulation uses others: ' +
      movedPorts.map((m) => `${m.name} ${m.from === null ? '?' : m.from} → ${m.to}`).join(', ') + '.');
  }
  if (opts.openocd) debugUi.writeOpenOcdConfig(uri, platform.data, opts.openocd.port).catch((e) => vscode.window.showErrorMessage(`Could not write the OpenOCD configuration: ${e.message}`));
  if (debug) {
    vscode.window.showInformationMessage(
      `Simulation started with a gdb server requested on port ${port}${remoteInfo ? ` (forwarded from ${remoteInfo.host})` : ''}. Attach with the "VP: attach to target software" debug configuration.`,
      'Add Debug Configurations').then((p) => p && debugUi.cmdAddDebugConfigs(uri));
  }
}

async function start(arg, debug, traceIds = [], opts = {}) {
  const uri = await platformFiles.pickPlatform(arg);
  if (!uri) return;
  const c = common.cfg();
  let rc;
  try { rc = remoteUi.remoteSettings(); } catch (e) {
    vscode.window.showErrorMessage(`VP Studio: ${e.message}`, 'Open Settings').then((p) => p && vscode.commands.executeCommand('workbench.action.openSettings', 'vpStudio.remote'));
    return;
  }
  if (rc) {
    try { await remoteUi.startRemote(uri, rc, debug, traceIds, opts); } catch (e) {
      if (await askpassUi.offerPasswordLogin(rc, e)) { start(arg, debug, traceIds, opts); return; }
      vscode.window.showErrorMessage(`Remote simulation on ${rc.host}: ${e.message}`);
    }
    return;
  }
  if (common.IS_WINDOWS) { remoteUi.needHost('Start Simulation'); return; }
  const { cwd, exePath } = simulatorPath(uri);
  if (!fs.existsSync(exePath)) {
    const pick = await vscode.window.showErrorMessage(
      `Simulator executable not found: ${exePath}. Build QBox first, or set "vpStudio.executable".`, 'Open Settings');
    if (pick) vscode.commands.executeCommand('workbench.action.openSettings', 'vpStudio.executable');
    return;
  }
  versionUi.warnVersions(exePath);
  const port = c.get('debug.gdbPort');
  const options = debug
    ? { overrides: [{ instance: c.get('debug.cpuInstance'), param: c.get('debug.gdbPortParam'), value: port }] }
    : {};
  // Host ports the platform forwards (QEMU hostfwd): keep each configured
  // port when free, move it to a free one otherwise, so a second simulation
  // does not fail with "Could not set up host forwarding rule".
  let movedPorts = [];
  let hostPortValues = {};
  const platform = await platformFiles.load(uri);
  if (!platform) return;
  // G-08: start from a checkpoint. The disks are copies (or snapshot=on), so
  // the lock and free-space checks of the platform's own images do not apply.
  let restore;
  if (opts.restore) {
    try {
      restore = checkpoint.restorePlan(opts.restore.manifest, opts.restore.dir, platform.data, { platformText: platform.textDoc.getText() });
    } catch (e) {
      vscode.window.showErrorMessage(`Cannot start from the checkpoint: ${e.message}`);
      return;
    }
    const errs = restore.problems.filter((p) => p.level === 'error');
    if (errs.length) { vscode.window.showErrorMessage(`Cannot start from the checkpoint: ${errs[0].text}`); return; }
    for (const w of restore.problems.filter((p) => p.level === 'warning')) {
      const go = await vscode.window.showWarningMessage(w.text, { modal: true }, 'Start Anyway');
      if (go !== 'Start Anyway') return;
    }
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Checkpoint ${opts.restore.manifest.name}` },
        (progress) => checkpoint.prepare(restore, (what) => progress.report({ message: what })));
    } catch (e) {
      vscode.window.showErrorMessage(`Cannot copy the checkpoint's disk images: ${e.message}`);
      return;
    }
    options.overrides = (options.overrides || []).concat(restore.overrides);
  }
  // A platform that names a devicetree.output gets it regenerated, so the
  // device tree always matches the modules being started.
  if (platform.data.devicetree && platform.data.devicetree.output) {
    try {
      await devicetreeUi.deviceTreeFor(uri, platform.data);
    } catch (e) {
      const pick = await vscode.window.showErrorMessage(`The device tree could not be generated: ${e.message}`, { modal: true, detail: 'Starting anyway uses the device tree file as it is now.' }, 'Start Anyway');
      if (pick !== 'Start Anyway') return;
    }
  }
  // A loader file that does not exist stops the simulator at start ("cannot get
  // file size"); say which one first. After the device tree step, so a
  // generated DTB is already there.
  try {
    const missing = images.missingFiles(images.collect(platform.data, core.analyze(platform.data), path.dirname(uri.fsPath)));
    if (missing.length) {
      const dt = platform.data.devicetree;
      const list = missing.map((m) => `${m.module}[${m.index}]: ${m.file}`).join('\n');
      const hint = missing.some((m) => /\.dtb$/i.test(m.resolved)) && !(dt && dt.output)
        ? '\n\nA device tree file is missing. To have VP Studio generate it at every start, set "devicetree": {"output": …} in the platform to the same path.'
        : '';
      const pick = await vscode.window.showWarningMessage(`${missing.length === 1 ? 'A file' : `${missing.length} files`} the loader needs ${missing.length === 1 ? 'does' : 'do'} not exist.`, {
        modal: true,
        detail: `${list}\n\nThe simulator would stop at start ("cannot get file size").${hint}`,
      }, 'Start Anyway');
      if (pick !== 'Start Anyway') return;
    }
  } catch (e) { /* the image check is advisory */ }
  // QEMU locks a disk image while a simulation writes to it, so a second
  // simulation of the same platform would stop at start. Say so first.
  const locked = restore ? [] : disklock.lockedImages(platform.data, path.dirname(uri.fsPath));
  if (locked.length) {
    const l = locked[0];
    const who = l.holders.length
      ? ` by ${l.holders.map((h) => `${path.basename((h.cmd || '?').split(' ')[0])} (pid ${h.pid})`).join(', ')}` : ' by another process';
    const pick = await vscode.window.showWarningMessage(`The disk image of ${l.module} is in use${who}.`, {
      modal: true,
      detail: `${l.file}\n\nQEMU locks a disk image while a simulation writes to it, so this simulation would stop at start with "Failed to get write lock". Stop the other simulation first, or give this platform its own copy of the image.`,
    }, 'Start Anyway');
    if (pick !== 'Start Anyway') return;
  }
  // A guest whose disk is full still boots, but services that write state fail
  // (2026-11-15: name resolution, time sync, hostname on the Ubuntu platform).
  // Warn without blocking the start.
  try {
    const low = restore ? [] : diskspace.lowImages(disklock.diskImages(platform.data, path.dirname(uri.fsPath)));
    if (low.length) warnLowDisk(low);
  } catch (e) { /* advisory */ }
  try {
    const chosen = await hostports.choosePorts(hostports.hostPortVariables(platform.data));
    hostPortValues = chosen.values;
    movedPorts = chosen.moved;
    if (Object.keys(hostPortValues).length) options.variableValues = hostPortValues;
  } catch (e) {
    vscode.window.showWarningMessage(`VP Studio: could not check host ports (${e.message}); starting with the configured ones.`);
  }
  const agentLib = agentUi.simAgentLibrary();
  let agentPort;
  if ((opts.profile || opts.ftrace || opts.openocd) && !agentLib) {
    vscode.window.showErrorMessage(`${opts.profile ? 'Profiling' : opts.ftrace ? 'The function trace' : 'The OpenOCD debug port'} needs the sim agent library. Build it with "VP Studio: Build Sim Agent".`, 'Build Sim Agent')
      .then((x) => x && vscode.commands.executeCommand('vpStudio.buildSimAgent'));
    return;
  }
  if (restore && !(agentLib && pin.versionAtLeast(pin.agentVersion(agentLib + '.so'), checkpoint.MIN_AGENT))) {
    vscode.window.showErrorMessage(`Starting from a checkpoint needs sim agent ${checkpoint.MIN_AGENT} or later. Rebuild it with "VP Studio: Build Sim Agent".`, 'Build Sim Agent')
      .then((x) => x && vscode.commands.executeCommand('vpStudio.buildSimAgent'));
    return;
  }
  if (traceIds.length && !agentLib) {
    vscode.window.showErrorMessage('Tracing needs the sim agent library (sim_agent.so). Build it with tools/sim-agent/build.sh, or set "vpStudio.simAgent.library".');
    return;
  }
  if (agentLib) agentPort = await simagent.freePort();
  const added = addAgentOptions(options, platform, { agentLib, agentVersion: pin.agentVersion(agentLib && agentLib + '.so'), agentPort, traceIds, opts, restore, qboxBuild: path.dirname(exePath) });
  if (!added) return;
  const { probeIds, recording } = added;
  const lua = await platformFiles.generateFor(uri, options);
  if (!lua) return;
  agentUi.disconnectAgent();
  if (shared.terminal) shared.terminal.dispose();
  shared.terminal = vscode.window.createTerminal({ name: `VP: ${path.basename(uri.fsPath, common.SUFFIX)}`, cwd });
  shared.terminal.show(false);
  // Send the command once the terminal's shell exists: the standalone
  // application (Theia) drops text sent to a new terminal before that, so a
  // second Start after Stop showed only a prompt (2026-11-18). VS Code queues
  // it either way.
  const term = shared.terminal;
  const line = `${common.shq(exePath)} ${c.get('luaFlag')} ${common.shq(lua)}`;
  Promise.resolve(term.processId).then(() => term.sendText(line), () => term.sendText(line));
  afterStart({ uri, platform, options, debug, port, traceIds, probeIds, recording, opts, restore, agentPort, hostPortValues, movedPorts });
}

/** Say which disk images are almost full, and how to free space in a Linux guest. */
function warnLowDisk(low) {
  const l = low[0];
  const more = low.length > 1 ? ` (and ${low.length - 1} more)` : '';
  vscode.window.showWarningMessage(
    `The disk image of ${l.module} is almost full: ${diskspace.fmtBytes(l.available)} free of ${diskspace.fmtBytes(l.size)}${more}. Services in the guest that write to it may fail to start.`,
    'How to Free Space').then((pick) => {
    if (pick !== 'How to Free Space') return;
    const ch = common.outputChannel();
    ch.appendLine('');
    for (const x of low) ch.appendLine(`${x.module}: ${diskspace.fmtBytes(x.available)} free of ${diskspace.fmtBytes(x.size)} (${x.file})`);
    ch.appendLine([
      '',
      'A full root file system still boots, but services that write state fail, for example',
      '"Failed to start Network Name Resolution" and "systemd-journald: No space left on device".',
      '',
      'Each time the simulation ends without the guest shutting down (Stop Simulation, Ctrl-\\),',
      'systemd keeps the journal it was writing as a *.journal~ file. To free that space, log in',
      'to the guest as root and run:',
      '',
      '    journalctl --vacuum-size=32M',
      '    rm -f /var/log/journal/*/*.journal~',
      '    df -h /',
      '',
      'Then end the simulation with "poweroff" in the guest, so no new *.journal~ is left.',
      'To keep it from filling up again, limit the journal in the image (SystemMaxUse= in',
      '/etc/systemd/journald.conf) or make the image larger.',
    ].join('\n'));
    ch.show(true);
  });
}

/** Working directory and simulator executable for a platform (or the first workspace folder). */
function simulatorPath(uri) {
  const c = common.cfg();
  const exe = c.get('executable');
  const at = (cwd) => ({ cwd, exePath: path.isAbsolute(exe) ? exe : path.join(cwd, exe) });
  if (c.get('workingDirectory')) return at(c.get('workingDirectory'));
  const folder = (uri && vscode.workspace.getWorkspaceFolder(uri)) || (vscode.workspace.workspaceFolders || [])[0];
  const first = at(folder ? folder.uri.fsPath : uri ? path.dirname(uri.fsPath) : process.cwd());
  if (fs.existsSync(first.exePath)) return first;
  // A platform in a folder of its own (an unpacked kit added to the
  // workspace): the QBox folder is another workspace folder.
  for (const f of vscode.workspace.workspaceFolders || []) {
    const other = at(f.uri.fsPath);
    if (fs.existsSync(other.exePath)) return other;
  }
  return first;
}

function cmdStop() {
  if (!shared.terminal) {
    vscode.window.showInformationMessage('No simulation was started from VP Studio.');
    return;
  }
  shared.terminal.dispose();
  shared.terminal = undefined;
  agentUi.disconnectAgent();
  setRunning(false);
}

function setRunning(running, detail) {
  menuUi.setCtx('vpStudio.running', running);
  shared.statusItem.text = running ? `$(debug-stop) VP running${detail ? ' (' + detail + ')' : ''}` : '$(play) VP';
  shared.statusItem.tooltip = running ? 'Stop the simulation' : 'Start the simulation';
  shared.statusItem.command = running ? 'vpStudio.stop' : 'vpStudio.start';
  shared.statusItem.show();
}

exports.cmdGenerate = cmdGenerate;
exports.addAgentOptions = addAgentOptions;
exports.afterStart = afterStart;
exports.start = start;
exports.simulatorPath = simulatorPath;
exports.cmdStop = cmdStop;
exports.setRunning = setRunning;
