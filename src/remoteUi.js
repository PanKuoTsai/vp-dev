'use strict';
// Remote simulation (F-03): the simulation host, starting there, building and checking it.
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const simagent = require('../lib/sim/simagent');
const hostports = require('../lib/sim/hostports');
const consoles = require('../lib/sim/consoles');
const pin = require('../lib/setup/pin');
const models = require('../lib/generate/models');
const checkpoint = require('../lib/sim/checkpoint');
const remote = require('../lib/sim/remote');
const shared = require('./shared');
const common = require('./common');
const catalogUi = require('./catalogUi');
const platformFiles = require('./platformFiles');
const devicetreeUi = require('./devicetreeUi');
const modelUi = require('./modelUi');
const simUi = require('./simUi');
const askpassUi = require('./askpassUi');
const agentUi = require('./agentUi');

/** On Windows: say that this needs a Linux simulation host, and offer to choose one. */
function needHost(what) {
  vscode.window.showWarningMessage(`${what}: QBox runs only on Linux, so on Windows VP Studio runs simulations on a Linux simulation host over SSH. Choose one first.`,
    'Select Simulation Host…').then((p) => p && vscode.commands.executeCommand('vpStudio.remote.selectHost'));
}

/** A command that needs QBox on this machine: on Windows it says so and points to the remote one. */
const localOnly = (what, fn, instead) => (...args) => {
  if (!common.IS_WINDOWS) return fn(...args);
  vscode.window.showWarningMessage(`${what} needs QBox on this machine, which runs only on Linux.${instead ? ` On Windows, use "${instead}".` : ' It is not available in VP Studio on Windows.'}`);
  return undefined;
};

/** The remote host settings, or undefined when simulations run on this machine. Throws on bad settings. */
function remoteSettings() {
  const c = common.cfg();
  const rc = remote.config({ host: c.get('remote.host'), root: c.get('remote.root'), executable: c.get('remote.executable'), sshArgs: c.get('remote.sshArgs') });
  if (rc && c.get('remote.auth') === 'password') rc.askpass = askpassUi.askpassFor(rc.host);
  return rc;
}

const remoteHomes = new Map();
async function remoteHomeOf(rc) {
  const key = `${rc.host}|${rc.sshArgs.join(' ')}`;
  if (!remoteHomes.has(key)) remoteHomes.set(key, await remote.home(rc));
  return remoteHomes.get(key);
}

/** The local workspace folder a platform is in, which remote.root mirrors. */
function localRootFor(uri) {
  const folder = vscode.workspace.getWorkspaceFolder(uri) || (vscode.workspace.workspaceFolders || [])[0];
  return folder ? folder.uri.fsPath : path.dirname(uri.fsPath);
}

/** Where a library VP Studio builds lives on the remote host (without .so). */
const remoteLib = (homeDir, dir, name) => `${remote.remoteBuildDir(homeDir, dir)}/${name}`;

/**
 * Start Simulation on the remote host: generate here, check and upload the
 * files there, run the simulator in ssh -tt, forward the agent, gdb and host
 * ports to this machine.
 */
async function startRemote(uri, rc, debug, traceIds, opts) {
  const c = common.cfg();
  if (opts.restore) { vscode.window.showErrorMessage('Starting from a checkpoint is not supported for remote simulations yet.'); return; }
  const localRoot = localRootFor(uri);
  const platformDir = path.dirname(uri.fsPath);
  const remotePlatformDir = remote.mapPath(localRoot, rc.root, platformDir);
  if (!remotePlatformDir) throw new Error(`${uri.fsPath} is not inside the workspace folder ${localRoot}, which "vpStudio.remote.root" mirrors`);
  const platform = await platformFiles.load(uri);
  if (!platform) return;
  const status = vscode.window.setStatusBarMessage(`$(sync~spin) VP Studio: preparing the simulation on ${rc.host}…`);
  try {
    const homeDir = await remoteHomeOf(rc);
    // The device tree is generated here and sent along.
    const generated = [];
    if (platform.data.devicetree && platform.data.devicetree.output) {
      try {
        const r = await devicetreeUi.deviceTreeFor(uri, platform.data);
        if (r && r.dtb) generated.push(r.dtb);
      } catch (e) {
        const pick = await vscode.window.showErrorMessage(`The device tree could not be generated: ${e.message}`, { modal: true, detail: 'Starting anyway uses the device tree file on the remote host as it is.' }, 'Start Anyway');
        if (pick !== 'Start Anyway') return;
      }
    }
    // What the remote host must have: the simulator, the platform's files, the agent.
    const agentRemote = remoteLib(homeDir, 'sim-agent', 'sim_agent');
    const wantAgent = (c.get('simAgent.library') || '').trim() !== 'none';
    const files = remote.platformFiles(platform.data, platformDir).filter((f) => f.role !== 'symbols')
      .map((f) => (f.remoteOnly ? { local: '', remote: f.file, role: f.role } : { local: f.file, remote: remote.mapPath(localRoot, rc.root, f.file), role: f.role }));
    const outside = files.filter((f) => !f.remote);
    if (outside.length) {
      const pick = await vscode.window.showWarningMessage(`${outside.length} file${outside.length === 1 ? '' : 's'} of the platform ${outside.length === 1 ? 'is' : 'are'} outside the workspace folder, so VP Studio does not know where ${outside.length === 1 ? 'it is' : 'they are'} on ${rc.host}.`,
        { modal: true, detail: outside.map((f) => f.local).join('\n') + '\n\nThe Lua names them with the same absolute paths.' }, 'Start Anyway');
      if (pick !== 'Start Anyway') return;
    }
    const checks = [{ local: '', remote: rc.executable, role: 'simulator' }, { local: '', remote: `${rc.buildDir}/compile_commands.json`, role: 'qboxbuild' }, ...files.filter((f) => f.remote)];
    if (wantAgent) checks.push({ local: '', remote: agentRemote + '.so', role: 'agent' }, { local: '', remote: agentRemote + '.json', role: 'agent-info' });
    for (const b of catalogUi.BUNDLED) checks.push({ local: '', remote: remoteLib(homeDir, b.dir, b.type) + '.so', role: 'bundled', type: b.type });
    const state = await remote.checkFiles(rc, checks);
    const get = (role) => state.find((x) => x.role === role);
    // A QBox or build folder given for the simulator (no build next to it): find the program, offer to fix the setting.
    if (get('simulator').state === 'missing' || get('qboxbuild').state === 'missing') {
      const fixed = await fixRemoteExecutable(rc, 'Start Simulation');
      if (fixed) { status.dispose(); return startRemote(uri, fixed, debug, traceIds, opts); }
    }
    if (get('simulator').state === 'missing') {
      vscode.window.showErrorMessage(`No simulator at ${rc.executable} on ${rc.host}. Build QBox there, or set "vpStudio.remote.root" / "vpStudio.remote.executable".`, 'Open Settings')
        .then((p) => p && vscode.commands.executeCommand('workbench.action.openSettings', 'vpStudio.remote'));
      return;
    }
    const fileStates = state.filter((x) => x.local && x.role !== 'agent');
    const toSend = fileStates.filter((x) => x.state === 'missing' || generated.includes(x.local));
    const differ = fileStates.filter((x) => x.state === 'size' && !generated.includes(x.local));
    const notHere = toSend.filter((x) => x.localSize === null);
    if (notHere.length) {
      const pick = await vscode.window.showWarningMessage(`${notHere.length} file${notHere.length === 1 ? '' : 's'} the platform needs ${notHere.length === 1 ? 'is' : 'are'} on neither machine.`,
        { modal: true, detail: notHere.map((x) => x.local).join('\n') }, 'Start Anyway');
      if (pick !== 'Start Anyway') return;
    }
    const sendable = toSend.filter((x) => x.localSize !== null);
    const askSend = sendable.filter((x) => !generated.includes(x.local));
    let send = sendable.filter((x) => generated.includes(x.local));
    if (askSend.length || differ.length) {
      const fmt = (x) => `${x.remote} (${checkpoint.fmtSize(x.localSize || 0)}${x.state === 'size' ? `, ${checkpoint.fmtSize(x.remoteSize)} there` : ''})`;
      const detail = [
        askSend.length ? `Missing on ${rc.host}:\n${askSend.map(fmt).join('\n')}` : '',
        differ.length ? `A different size on ${rc.host}:\n${differ.map(fmt).join('\n')}` : '',
      ].filter(Boolean).join('\n\n');
      const buttons = askSend.length ? ['Upload', 'Start Anyway'] : ['Upload', 'Keep Theirs'];
      const pick = await vscode.window.showWarningMessage(`The remote host does not have the same files as this machine.`, { modal: true, detail }, ...buttons);
      if (!pick) return;
      if (pick === 'Upload') send = send.concat(askSend, differ);
    }
    if (send.length) {
      const total = send.reduce((n, x) => n + x.localSize, 0);
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Uploading to ${rc.host}` }, async (progress) => {
        let done = 0;
        for (const x of send) {
          let last = 0;
          await remote.upload(rc, x.local, x.remote, {
            onProgress: (sent) => {
              progress.report({ message: `${path.basename(x.local)} (${checkpoint.fmtSize(done + sent)} of ${checkpoint.fmtSize(total)})`, increment: total ? ((sent - last) / total) * 100 : 0 });
              last = sent;
            },
          });
          done += x.localSize;
        }
      });
    }

    // Ports: free ones on the remote host for the simulator, the same or free ones here for the forwards.
    const busy = remote.listeningPorts(await remote.runOk(rc, 'cat /proc/net/tcp /proc/net/tcp6 2>/dev/null; true'));
    const hostVars = hostports.hostPortVariables(platform.data);
    const gdbPort = c.get('debug.gdbPort');
    const agentState = get('agent');
    const agentLib = wantAgent && agentState && agentState.state !== 'missing' ? agentRemote : undefined;
    const wanted = [...hostVars.map((v) => ({ name: v.name, preferred: v.port }))];
    if (agentLib) wanted.push({ name: '@agent' });
    if (debug) wanted.push({ name: '@gdb', preferred: gdbPort });
    // UART consoles on char_backend_socket: a port on the remote host, forwarded here.
    const uartSockets = consoles.consoles(platform.data).sockets.filter((k) => k.server && !k.problem);
    for (const k of uartSockets) wanted.push({ name: `@uart:${k.name}`, preferred: k.port });
    const remotePorts = remote.pickPorts(busy, wanted);
    const forwards = [];
    const localOf = {};
    const used = new Set();
    for (const w of wanted) {
      let lp = w.name === '@agent' ? undefined : w.name === '@gdb' ? gdbPort : w.name.startsWith('@uart:') ? w.preferred : remotePorts[w.name];
      if (!lp || used.has(lp) || !(await hostports.isPortFree(lp, '127.0.0.1'))) lp = await simagent.freePort();
      used.add(lp);
      localOf[w.name] = lp;
      forwards.push({ local: lp, remote: remotePorts[w.name] });
    }
    const options = {};
    if (debug) options.overrides = [{ instance: c.get('debug.cpuInstance'), param: c.get('debug.gdbPortParam'), value: remotePorts['@gdb'] }];
    // The console listens on the remote host's loopback, where the SSH forward ends.
    if (uartSockets.length) options.overrides = (options.overrides || []).concat(uartSockets.map((k) => ({ instance: k.name, param: 'address', value: `127.0.0.1:${remotePorts[`@uart:${k.name}`]}` })));
    const uartConsoles = uartSockets.map((k) => Object.assign({}, k, { host: '127.0.0.1', port: remotePorts[`@uart:${k.name}`] }));
    const localOfRemote = new Map(uartSockets.map((k) => [remotePorts[`@uart:${k.name}`], localOf[`@uart:${k.name}`]]));
    const hostPortValues = {};
    const movedPorts = [];
    for (const v of hostVars) {
      hostPortValues[v.name] = localOf[v.name];
      if (localOf[v.name] !== v.port) movedPorts.push({ name: v.name, from: v.port, to: localOf[v.name] });
    }
    if (hostVars.length) options.variableValues = Object.fromEntries(hostVars.map((v) => [v.name, remotePorts[v.name]]));

    if (!agentLib && wantAgent) {
      vscode.window.showWarningMessage(`The sim agent is not built on ${rc.host}, so pause, continue, parameters, tracing and the register view are off. Run "VP Studio: Build Sim Agent on Remote Host".`, 'Build Sim Agent on Remote Host')
        .then((p) => p && vscode.commands.executeCommand('vpStudio.remote.buildSimAgent'));
    }
    if (opts.openocd) { vscode.window.showErrorMessage('The OpenOCD debug port is not available for remote simulation yet: start it on this machine.'); return; }
    if ((traceIds.length || opts.profile || opts.ftrace) && !agentLib) { vscode.window.showErrorMessage(`Tracing and profiling need the sim agent on ${rc.host}.`); return; }
    let agentVersion = null;
    if (agentLib) {
      try { agentVersion = JSON.parse(await remote.runOk(rc, `cat ${remote.shq(agentRemote + '.json')}`)).version || null; } catch (e) { agentVersion = null; }
    }
    const added = simUi.addAgentOptions(options, platform, { agentLib, agentVersion, agentPort: remotePorts['@agent'], traceIds, opts });
    if (!added) return;
    const { probeIds, recording } = added;
    // Libraries VP Studio builds: the remote builds (a platform's own dylib wins in the generator).
    const libraries = {};
    for (const b of catalogUi.BUNDLED) {
      const st = state.find((x) => x.role === 'bundled' && x.type === b.type);
      if (st && st.state !== 'missing') libraries[b.type] = remoteLib(homeDir, b.dir, b.type);
    }
    // Models built in the workspace: their library on the remote host is the
    // same place under remote.root (Build Model on Remote Host builds it there).
    const modelLibs = {};
    for (const [type, lib] of Object.entries(models.libraries(catalogUi.catalog()))) modelLibs[type] = remote.mapPath(localRoot, rc.root, lib) || lib;
    const r = await platformFiles.generateText(uri, Object.assign(options, { libraries: Object.assign(modelLibs, libraries) }));
    if (!r) return;
    // Local absolute paths (models next to the platform, this machine's builds) become the remote ones.
    const lua = remote.mapText(remote.mapText(r.lua, localRoot, rc.root), catalogUi.buildDir(), `${homeDir}/.vp-studio/build`);
    const remoteLua = remote.mapPath(localRoot, rc.root, platformFiles.luaPathFor(uri, r.data));
    await remote.writeText(rc, remoteLua, lua);
    agentUi.disconnectAgent();
    if (shared.terminal) shared.terminal.dispose();
    const args = remote.terminalArgs(rc, { forwards, cwd: rc.root, command: `${remote.shq(rc.executable)} ${c.get('luaFlag')} ${remote.shq(remoteLua)}` });
    shared.terminal = vscode.window.createTerminal({ name: `VP: ${path.basename(uri.fsPath, common.SUFFIX)} @ ${rc.host}`, shellPath: 'ssh', shellArgs: args, env: rc.askpass ? rc.askpass.env : undefined });
    shared.terminal.show(false);
    common.outputChannel().appendLine(`Remote simulation: ${remote.commandLine(args)}`);
    simUi.afterStart({
      uri, platform, options, debug, port: localOf['@gdb'], traceIds, probeIds, recording, opts, agentPort: localOf['@agent'],
      hostPortValues, movedPorts, where: `on ${rc.host}`, remoteInfo: { host: rc.host, forwards, remoteLua },
      uartConsoles, mapConsolePort: (p) => localOfRemote.get(p),
    });
    if (debug && localOf['@gdb'] !== gdbPort) {
      vscode.window.showWarningMessage(`Port ${gdbPort} is taken on this machine, so the gdb server is forwarded to ${localOf['@gdb']}. Change the port in the "VP: attach to target software" configuration for this session.`);
    }
  } finally {
    status.dispose();
  }
}

/** Send VP Studio's build sources (tools/<dirs>) to the remote host: <home>/.vp-studio/src. */
async function uploadBuildSources(rc, homeDir, dirs) {
  const entries = [];
  const skip = (rel) => /(^|\/)build(\/|$)/.test(rel) || /\.(so|o)$/.test(rel) || rel === 'tools/qbox-catalog/qbox-catalog' || rel === 'tools/sim-agent/sim_agent.json' || rel === 'tools/sim-agent/vp_sim_agent.json';
  for (const d of dirs) {
    const walk = (rel) => {
      for (const e of fs.readdirSync(path.join(common.ROOT, rel), { withFileTypes: true })) {
        const r = `${rel}/${e.name}`;
        if (skip(r)) continue;
        if (e.isDirectory()) walk(r);
        else entries.push({ path: r, file: path.join(common.ROOT, r) });
      }
    };
    walk(`tools/${d}`);
  }
  const tmp = path.join(os.tmpdir(), `vp-studio-src-${process.pid}-${Date.now()}.tar.gz`);
  await remote.uploadTree(rc, entries, `${homeDir}/.vp-studio/src`, require('../lib/setup/tar').write, tmp);
}

/** Build a library of VP Studio on the remote host against its QBox, in a terminal task. */
async function cmdRemoteBuild(what) {
  let rc = remoteSettings();
  if (!rc) { vscode.window.showWarningMessage('Set "vpStudio.remote.host" first (or run "VP Studio: Select Simulation Host…").'); return; }
  const homeDir = await remoteHomeOf(rc);
  rc = await remoteBuildReady(rc, what === 'sim-agent' ? 'Building the sim agent' : `Building ${what}`);
  if (!rc) return;
  const dirs = what === 'sim-agent' ? ['sim-agent'] : [what, 'qbox-catalog'];
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Sending the build sources to ${rc.host}` }, () => uploadBuildSources(rc, homeDir, dirs));
  const src = `${homeDir}/.vp-studio/src/tools/${what}/build.sh`;
  const out = remote.remoteBuildDir(homeDir, what);
  const env = `VP_QBOX_CATALOG=${remote.shq(remote.remoteBuildDir(homeDir, 'qbox-catalog') + '/qbox-catalog')}`;
  const cmd = what === 'sim-agent'
    ? `mkdir -p ${remote.shq(out)} && bash ${remote.shq(src)} ${remote.shq(rc.buildDir)} ${remote.shq(out + '/sim_agent.so')}`
    : `${env} bash ${remote.shq(src)} ${remote.shq(rc.buildDir)} --out ${remote.shq(out)}`;
  const title = what === 'sim-agent' ? 'Sim Agent' : (catalogUi.BUNDLED.find((b) => b.dir === what) || { title: what }).title;
  const code = await runRemoteTask(rc, `remote-${what}`, `Build ${title} on ${rc.host}`, cmd);
  if (code === 0) vscode.window.showInformationMessage(`Built the ${title} on ${rc.host} (${out}). Remote simulations use it.`);
  else vscode.window.showErrorMessage(`Building the ${title} on ${rc.host} failed (exit code ${code}); see the terminal.`);
}

/**
 * When vpStudio.remote.executable is not the simulator program (a QBox or
 * build folder was typed for it), find the program there and offer to set
 * it. Resolves the settings to use from now on, or null when nothing was fixed.
 */
async function fixRemoteExecutable(rc, what) {
  let found;
  try { found = await remote.findExecutable(rc); } catch (e) { return null; }
  if (!found || found === rc.executable) return null;
  const pick = await vscode.window.showWarningMessage(`"vpStudio.remote.executable" is ${rc.executable}, which is not the simulator program on ${rc.host}.`, {
    modal: true,
    detail: `${what} needs platforms-vp in the QBox build folder (it reads CMakeCache.txt and compile_commands.json next to it). Found: ${found}`,
  }, `Use ${found}`);
  if (!pick) return null;
  const c = common.cfg();
  const i = c.inspect('remote.executable') || {};
  const target = i.workspaceFolderValue !== undefined ? vscode.ConfigurationTarget.WorkspaceFolder
    : i.workspaceValue !== undefined || (i.globalValue === undefined && vscode.workspace.workspaceFolders) ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
  await c.update('remote.executable', found, target);
  return remoteSettings();
}

/**
 * Before building on the remote host: its QBox build must be there
 * (compile_commands.json next to the simulator). Resolves the settings to use,
 * or null after saying what is wrong.
 */
async function remoteBuildReady(rc, what) {
  const st = await remote.checkFiles(rc, [{ local: '', remote: `${rc.buildDir}/compile_commands.json` }]);
  if (st[0].state !== 'missing') return rc;
  const fixed = await fixRemoteExecutable(rc, what);
  if (fixed) return fixed;
  vscode.window.showErrorMessage(`${what}: no QBox build at ${rc.buildDir} on ${rc.host} (no compile_commands.json). Set "vpStudio.remote.executable" to the platforms-vp of a QBox build there, e.g. /home/me/qbox/build/platforms-vp.`, 'Open Settings')
    .then((p) => p && vscode.commands.executeCommand('workbench.action.openSettings', 'vpStudio.remote.executable'));
  return null;
}

/** Run a command on the remote host in a terminal task (ssh -tt); resolves its exit code. */
async function runRemoteTask(rc, id, name, cmd) {
  const task = new vscode.Task({ type: 'shell', tool: id }, vscode.TaskScope.Workspace, name, 'VP Studio',
    new vscode.ProcessExecution('ssh', [...rc.sshArgs, ...(rc.askpass ? remote.authOptions(rc) : []), '-tt', rc.host, cmd], Object.assign({ cwd: common.taskCwd() }, rc.askpass ? { env: rc.askpass.env } : {})), []);
  task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, clear: true };
  const exec = await vscode.tasks.executeTask(task);
  return new Promise((resolve) => {
    const sub = vscode.tasks.onDidEndTaskProcess((e) => { if (e.execution === exec) { sub.dispose(); resolve(e.exitCode); } });
  });
}

/**
 * Build Model on Remote Host: generate the model's code here, send the model
 * folder to its place under remote.root (without build/), build it there
 * against the remote QBox with tools/model-build, and bring its catalog entry
 * back, so platforms here can use the model and remote simulations load it.
 * The only way to build a model in VS Code on Windows.
 */
async function cmdRemoteBuildModel(arg) {
  let rc;
  try { rc = remoteSettings(); } catch (e) { vscode.window.showErrorMessage(`VP Studio: ${e.message}`); return; }
  if (!rc) { needHost('Build Model on Remote Host'); return; }
  const uri = await modelUi.pickModel(arg);
  if (!uri) return;
  const textDoc = await vscode.workspace.openTextDocument(uri);
  if (textDoc.isDirty) await textDoc.save();
  if (!(await modelUi.generateModel(uri, false))) return;
  const dir = path.dirname(uri.fsPath);
  const remoteDir = remote.mapPath(localRootFor(uri), rc.root, dir);
  if (!remoteDir) { vscode.window.showErrorMessage(`${dir} is not inside the workspace folder, which "vpStudio.remote.root" mirrors on ${rc.host}.`); return; }
  const name = (() => { try { return JSON.parse(textDoc.getText()).name; } catch (e) { return path.basename(dir); } })();
  const homeDir = await remoteHomeOf(rc);
  rc = await remoteBuildReady(rc, `Building ${name}`);
  if (!rc) return;
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Sending ${name} to ${rc.host}` }, async () => {
    await uploadBuildSources(rc, homeDir, ['model-build', 'qbox-catalog']);
    await remote.uploadFiles(rc, remote.folderEntries(dir, (rel) => !/^build(\/|$)/.test(rel)), remoteDir, require('../lib/setup/tar').write,
      path.join(os.tmpdir(), `vp-studio-model-${process.pid}-${Date.now()}.tar.gz`));
  });
  const script = `${homeDir}/.vp-studio/src/tools/model-build/build.sh`;
  const cmd = `VP_QBOX_CATALOG=${remote.shq(remote.remoteBuildDir(homeDir, 'qbox-catalog') + '/qbox-catalog')} bash ${remote.shq(script)} ${remote.shq(rc.buildDir)} ${remote.shq(remoteDir)}`;
  const code = await runRemoteTask(rc, `remote-model-${name}`, `Build model ${name} on ${rc.host}`, cmd);
  // The catalog entry (and which QBox) back here, next to the model, where the catalog looks for it.
  if (code === 0 || code === 3) {
    fs.mkdirSync(path.join(dir, 'build'), { recursive: true });
    for (const f of [`${name}.catalog.json`, `${name}.json`]) {
      try { fs.writeFileSync(path.join(dir, 'build', f), await remote.runOk(rc, `cat ${remote.shq(`${remoteDir}/build/${f}`)}`)); } catch (e) { /* not made */ }
    }
  }
  await catalogUi.refreshModelCatalogs();
  if (code === 0) vscode.window.showInformationMessage(`Built ${name} on ${rc.host}; its self-test passed, and it is in the component catalog: "Add Module…" in a platform lists it.`);
  else vscode.window.showErrorMessage(code === 3 ? `${name} was built on ${rc.host}, but its self-test failed; see the terminal.` : `Building ${name} on ${rc.host} failed (exit code ${code}); see the terminal.`);
}

/** Check Remote Host: what a remote simulation needs, in the output. */
async function cmdCheckRemote() {
  let rc;
  try { rc = remoteSettings(); } catch (e) { vscode.window.showErrorMessage(e.message); return; }
  if (!rc) { vscode.window.showInformationMessage('Simulations run on this machine ("vpStudio.remote.host" is empty). Run "VP Studio: Select Simulation Host…" to use another machine.'); return; }
  const out = common.outputChannel();
  out.show(true);
  out.appendLine(`Remote host ${rc.host} (root ${rc.root}):`);
  const line = (ok, text) => out.appendLine(`  ${ok ? '✓' : '✗'} ${text}`);
  let homeDir;
  try {
    homeDir = await remote.home(rc);
    line(true, `${rc.askpass ? 'ssh logs in with the password' : 'ssh logs in with a key'}; home ${homeDir}`);
  } catch (e) {
    line(false, e.message);
    if (await askpassUi.offerPasswordLogin(rc, e)) cmdCheckRemote();
    return;
  }
  const agent = remoteLib(homeDir, 'sim-agent', 'sim_agent');
  const checks = [
    { remote: rc.executable, what: 'simulator' },
    { remote: `${rc.buildDir}/compile_commands.json`, what: 'QBox build (for building the sim agent there)' },
    { remote: agent + '.so', what: 'sim agent (Build Sim Agent on Remote Host)' },
    ...catalogUi.BUNDLED.map((b) => ({ remote: remoteLib(homeDir, b.dir, b.type) + '.so', what: `${b.title} (optional)` })),
  ];
  const st = await remote.checkFiles(rc, checks.map((x) => ({ local: '', remote: x.remote })));
  st.forEach((x, i) => line(x.state !== 'missing', `${checks[i].what}: ${x.remote}${x.state === 'missing' ? ' not found' : ''}`));
  // A QBox or build folder given for the simulator: find the program and offer to fix the setting.
  if (st[0].state === 'missing' || st[1].state === 'missing') {
    if (await fixRemoteExecutable(rc, 'Simulating and building on the remote host')) { cmdCheckRemote(); return; }
  }
  try {
    const v = JSON.parse(await remote.runOk(rc, `cat ${remote.shq(agent + '.json')}`));
    line(true, `sim agent ${v.version}, built against QBox ${String(v.qbox && v.qbox.commit || v.qboxCommit || '?').slice(0, 12)}`);
  } catch (e) { /* not built */ }
  try {
    const head = (await remote.runOk(rc, `git -C ${remote.shq(rc.root)} rev-parse HEAD 2>/dev/null || true`)).trim();
    const p = pin.readPin(path.join(common.ROOT, 'qbox.pin.json'));
    if (head) line(head === p.qbox.commit, `QBox commit ${head.slice(0, 12)}${head === p.qbox.commit ? ' (the pinned one)' : `, VP Studio pins ${p.qbox.commit.slice(0, 12)}`}`);
  } catch (e) { /* no git */ }
  try {
    const fwd = await remote.runOk(rc, 'cat /proc/net/tcp >/dev/null && echo ok');
    line(fwd.trim() === 'ok', 'free ports can be found (/proc/net/tcp)');
  } catch (e) { line(false, `cannot read /proc/net/tcp: ${e.message}`); }
}

/** Select Simulation Host…: this machine, a Host of ~/.ssh/config, or another. */
async function cmdSelectHost() {
  const c = common.cfg();
  const hosts = [];
  try {
    const text = fs.readFileSync(path.join(os.homedir(), '.ssh', 'config'), 'utf8');
    for (const m of text.matchAll(/^\s*Host\s+(.+)$/gim)) for (const h of m[1].split(/\s+/)) if (h && !/[*?!]/.test(h)) hosts.push(h);
  } catch (e) { /* no ssh config */ }
  const current = c.get('remote.host') || '';
  const items = [
    { label: 'This machine', description: current ? '' : 'current', host: '' },
    ...hosts.map((h) => ({ label: h, description: h === current ? 'current (~/.ssh/config)' : '~/.ssh/config', host: h })),
    { label: 'Other host…', description: 'user@host', host: undefined },
  ];
  if (current && !hosts.includes(current)) items.splice(1, 0, { label: current, description: 'current', host: current });
  const sel = await vscode.window.showQuickPick(items, { title: 'Select Simulation Host', placeHolder: 'Where Start Simulation runs the simulator' });
  if (!sel) return;
  let host = sel.host;
  if (host === undefined) {
    host = await vscode.window.showInputBox({ title: 'Simulation host', prompt: 'ssh destination: user@host, or a Host of ~/.ssh/config', value: current,
      validateInput: (v) => (/^[^\s-][^\s]*$/.test(v.trim()) ? undefined : 'An ssh destination, without spaces') });
    if (host === undefined) return;
    host = host.trim();
  }
  const target = vscode.workspace.workspaceFolders ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  await c.update('remote.host', host, target);
  if (!host) { vscode.window.showInformationMessage('Simulations run on this machine.'); return; }
  // `c` is a snapshot taken before the updates below; keep what was entered.
  let remoteRoot = String(c.get('remote.root') || '');
  if (!remoteRoot) {
    const root = await vscode.window.showInputBox({ title: `Folder on ${host}`, prompt: `Absolute path on ${host} of the folder that matches this workspace folder (the QBox folder, or the folder that holds your platforms)`,
      placeHolder: '/home/me/qbox', validateInput: (v) => (v.trim().startsWith('/') ? undefined : 'An absolute path') });
    if (!root) return;
    remoteRoot = root.trim();
    await c.update('remote.root', remoteRoot, target);
  }
  // The simulator: by default <root>/build/platforms-vp, which fits only when
  // the folder is the QBox folder; ask while it is still the default.
  const exe = c.inspect('remote.executable') || {};
  if (exe.workspaceValue === undefined && exe.globalValue === undefined && exe.workspaceFolderValue === undefined) {
    const root = remoteRoot.replace(/\/+$/, '') || '/';
    const v = await vscode.window.showInputBox({ title: `Simulator on ${host}`,
      prompt: `The simulator program on ${host}: the platforms-vp file in the QBox build folder, e.g. /home/me/qbox/build/platforms-vp (absolute, or relative to ${root}). Leave it as it is when ${root} is the QBox folder.`,
      value: 'build/platforms-vp', validateInput: (x) => (x.trim() ? undefined : 'A path') });
    if (v === undefined) return;
    if (v.trim() !== 'build/platforms-vp') await c.update('remote.executable', v.trim(), target);
  }
  await cmdCheckRemote();
}

exports.needHost = needHost;
exports.localOnly = localOnly;
exports.remoteSettings = remoteSettings;
exports.startRemote = startRemote;
exports.cmdRemoteBuild = cmdRemoteBuild;
exports.cmdRemoteBuildModel = cmdRemoteBuildModel;
exports.cmdCheckRemote = cmdCheckRemote;
exports.cmdSelectHost = cmdSelectHost;
